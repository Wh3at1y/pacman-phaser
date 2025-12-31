import { Server } from "socket.io";
import initializeMovement from "./helpers/movement.js";
import {waitASec} from "./helpers/timeout.js";

const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || true;

let io;

// ----- Lobby state -----
const playerNames = ["ButterBall", "Chowder", "BubbleWrap", "OrbitGum"];


const currentGame = {
    players: new Map(),
    round: 1,
    scores: new Map(),
    lives: new Map(),
    deaths: new Map(),
    dotsRemaining: 244
}

export function initSocketServer(server) {
    io = new Server(server, {
        cors: {
            origin: CLIENT_ORIGIN,
            methods: ["GET", "POST"],
            credentials: true,
        },
        transports: ["websocket", "polling"],
    });

    // IMPORTANT: handlers must be registered AFTER io is created
    io.on("connection", (socket) => {
        const joinedPlayers = currentGame.players;
        const playerId = socket.handshake.auth?.playerId;

        if (!playerId) {
            socket.disconnect(true);
            return;
        }

        // Re-associate or create player
        const existing = joinedPlayers.get(playerId);
        if (existing) {
            existing.socketId = socket.id;
            existing.lastSeen = Date.now();
        } else {
            joinedPlayers.set(playerId, {
                playerId,
                name: pickName(),
                ready: false,
                socketId: socket.id,
                lastSeen: Date.now(),
                lobbyLeader: joinedPlayers.size === 0,
            });
        }

        emitLobbyState();

        socket.on("player_ready", () => {
            const p = joinedPlayers.get(playerId);
            if (!p) return;
            p.ready = !p.ready;
            emitLobbyState();
        });

        socket.on("hostStart", async () => {
            // Begin Game
            io.emit("startGame")

            // Setup Game
            for (const [playerId] of currentGame.players) {
                currentGame.scores.set(playerId, 0);
                currentGame.lives.set(playerId, 3);
                currentGame.deaths.set(playerId, 0);
            }

            // Wait for everyone to join, 2 seconds
            await waitASec(2000)

            io.emit("beginRound1")
        })



        // Initialize Movement
        initializeMovement(socket, io, playerId, joinedPlayers);

        socket.on("DotEaten", ({ playerId, x, y, type, seq }) => {
            // const key = `${x},${y}`;

            const isPower = type === "power";
            // const set = isPower ? currentGame.powerDots : currentGame.dots;
            // Dot already gone? Ignore.
            // if (!set.has(key)) return;

            // Remove it and update score
            // set.delete(key);

            const prev = currentGame.scores.get(playerId) ?? 0;
            const delta = isPower ? 50 : 10; // classic-ish numbers
            const newScore = prev + delta;
            currentGame.scores.set(playerId, newScore);
            currentGame.dotsRemaining -= 1

            io.emit("DotEatenConfirmed", {
                x, y, type,
                eaterPlayerId: playerId,
                newScore,
                scores: Object.fromEntries(currentGame.scores) // easy snapshot
            });

            // If power dot, also broadcast frightened start
            if (isPower) {
                io.emit("FrightenedStart", { durationMs: 7000 });
            }
        });

        socket.on("PlayerDied", ({ victimPlayerId }) => {
            if (!victimPlayerId) return;
            if (!currentGame.players.has(victimPlayerId)) return;

            const curLives = currentGame.lives.get(victimPlayerId) ?? 3;
            if (curLives <= 0) return; // already eliminated

            currentGame.lives.set(victimPlayerId, curLives - 1);
            currentGame.deaths.set(victimPlayerId, (currentGame.deaths.get(victimPlayerId) ?? 0) + 1);
            console.log(currentGame.lives)
            io.emit("LivesUpdate", {
                playerId: victimPlayerId,
                lives: Object.fromEntries(currentGame.lives),
                eliminated: currentGame.lives.get(victimPlayerId) <= 0,
            });

            // ✅ If EVERY connected player has 0 lives -> go back to lobby
            const allEliminated = Array.from(currentGame.players.keys()).every((pId) => (currentGame.lives.get(pId) ?? 0) <= 0);

            if (allEliminated) {
                io.emit("BackToLobby", currentGame);
            }
        });

        socket.on("RoundEnded", () => {
            const respawn = [];
            for (const [pid] of currentGame.players) {
                const l = currentGame.lives.get(pid) ?? 0;
                if (l > 0) respawn.push(pid);
            }
            if(currentGame.dotsRemaining <= 0) {
                currentGame.round += 1
                currentGame.dotsRemaining = 244
            }
            io.emit("RoundEnded", { respawn, round: currentGame.round });
        });

        socket.on("chat:message", (message) => {
            io.emit("chat:message", {
                senderId: socket.id,
                text: message,
                timestamp: Date.now(),
            });
        });

        socket.on("disconnect", () => {
            const p = joinedPlayers.get(playerId);
            if (!p) return;
            joinedPlayers.delete(playerId);
            emitLobbyState()
        });
    });

    return io;
}

// Use this anywhere else to emit events.
export function getIO() {
    if (!io) {
        throw new Error("Socket.IO not initialized. Call initSocketServer(server) first.");
    }
    return io;
}

function emitLobbyState() {
    io.emit("joined", Object.fromEntries(currentGame.players.entries()));
}

function pickName() {
    const existingNames = Array.from(currentGame.players.values()).map((p) => p.name);
    const available = playerNames.filter((n) => !existingNames.includes(n));
    const pool = available.length ? available : playerNames;
    return pool[Math.floor(Math.random() * pool.length)];
}
