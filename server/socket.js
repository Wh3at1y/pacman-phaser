import { Server } from "socket.io";
import initializeMovement from "./helpers/movement.js";
import { waitASec } from "./helpers/timeout.js";
import GhostSim from "./helpers/ghostSim.js";
import { level1 } from "./levels/level1.js";

const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || true;

let io;

// --- Lobby state ---
const playerNames = ["ButterBall", "Chowder", "BubbleWrap", "OrbitGum"];

const TICK_MS = 10; // 20Hz; clients interpolate to 60fps
let ghostTimer = null;

const TILE_SIZE = 24;

function pickName() {
    return playerNames[Math.floor(Math.random() * playerNames.length)];
}

function countDots(level) {
    let total = 0;
    for (let y = 0; y < level.length; y++) {
        for (let x = 0; x < level[y].length; x++) {
            const c = level[y][x];
            if (c === "·" || c === "o") total++;
        }
    }
    return total;
}

function buildGhostHouseInfo(level) {
    const doorTiles = [];
    const houseTiles = [];

    const rows = level.length;
    const cols = level[0].length;

    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            const c = level[y][x];
            if (c === "~") doorTiles.push({ x, y });
            if (c === "X" || c === "x") houseTiles.push({ x, y });
        }
    }

    let inHouseMinY = null, inHouseMaxY = null;
    if (houseTiles.length) {
        inHouseMinY = Math.min(...houseTiles.map(t => t.y));
        inHouseMaxY = Math.max(...houseTiles.map(t => t.y));
    }

    // Exit tile: just above the middle of the door
    let exitTile = null;
    if (doorTiles.length) {
        const avgX = Math.round(doorTiles.reduce((a, t) => a + t.x, 0) / doorTiles.length);
        const gateY = doorTiles[0].y;
        exitTile = { x: avgX, y: Math.max(0, gateY - 1) };
    }

    return { doorTiles, exitTile, inHouseMinY, inHouseMaxY };
}

function makeWorld(level) {
    const rows = level.length;
    const cols = level[0].length;

    const PASSABLE = new Set([" ", "·", "o", "X", "x", "~"]);

    return {
        TILE_SIZE,
        levelRows: rows,
        levelCols: cols,
        isGhostPassable(fromX, fromY, toX, toY) {
            // allow X wrap
            if (toX < 0) toX = cols - 1;
            if (toX >= cols) toX = 0;
            if (toY < 0 || toY >= rows) return false;

            const c = level[toY][toX];
            return PASSABLE.has(c);
        },
        isGhostHouseTile(x, y) {
            if (y < 0 || y >= rows) return false;
            if (x < 0) x = cols - 1;
            if (x >= cols) x = 0;
            const c = level[y][x];
            return c === "X" || c === "x";
        },
    };
}

function newGameState() {
    const totalDots = countDots(level1);
    return {
        players: new Map(),       // playerId -> {playerId,name,ready,socketId,lobbyLeader,lastSeen}
        round: 1,
        scores: new Map(),        // playerId -> int
        lives: new Map(),         // playerId -> int
        deaths: new Map(),        // playerId -> int
        playerState: new Map(),   // playerId -> latest movement snapshot
        ghosts: new Map(),        // name -> GhostSim
        eatenDots: new Set(),     // "x,y" keys
        totalDots,
        dotsRemaining: totalDots,
        outThisRound: new Set(),  // playerIds that died during this round
    };
}

let currentGame = newGameState();

function emitLobbyState() {
    io.emit("lobby_state", {
        players: Array.from(currentGame.players.values()).map((p) => ({
            playerId: p.playerId,
            name: p.name,
            ready: !!p.ready,
            socketId: p.socketId,
            lobbyLeader: !!p.lobbyLeader,
        })),
    });
}

function initGhostsForRound() {
    const world = makeWorld(level1);
    const houseInfo = buildGhostHouseInfo(level1);

    const releaseByName = {
        blinky: 0,      // blinky starts moving immediately (already outside)
        pinky: 1500,
        inky: 4500,
        clyde: 7500,
    };

    const ghosts = [
        new GhostSim(world, {
            name: "blinky",
            startTile: { x: 14, y: 11 }, // outside box
            scatterTarget: { x: world.levelCols - 2, y: 1 },
            speed: 145,
        }),
        new GhostSim(world, {
            name: "pinky",
            startTile: { x: 14, y: 14 },
            scatterTarget: { x: 1, y: 1 },
            speed: 145,
        }),
        new GhostSim(world, {
            name: "inky",
            startTile: { x: 12, y: 14 },
            scatterTarget: { x: world.levelCols - 2, y: world.levelRows - 2 },
            speed: 145,
        }),
        new GhostSim(world, {
            name: "clyde",
            startTile: { x: 16, y: 14 },
            scatterTarget: { x: 1, y: world.levelRows - 2 },
            speed: 145,
        }),
    ];

    for (const g of ghosts) {
        g.configureHouse({
            ...houseInfo,
            releaseDelayMs: releaseByName[g.name] ?? 0,
        });
        currentGame.ghosts.set(g.name, g);
    }
}

function stopGhostLoop() {
    if (ghostTimer) clearInterval(ghostTimer);
    ghostTimer = null;
}

function startGhostLoop() {
    stopGhostLoop();

    let last = Date.now();
    ghostTimer = setInterval(() => {
        const now = Date.now();
        const dt = now - last;
        last = now;

        // Pick a target Pac-Man tile (nearest alive + not outThisRound).
        const alivePlayers = [];
        for (const [pid, st] of currentGame.playerState) {
            const lives = currentGame.lives.get(pid) ?? 0;
            if (lives <= 0) continue;
            if (currentGame.outThisRound.has(pid)) continue;
            if (!st) continue;
            alivePlayers.push({ pid, st });
        }

        // If no one is active this round, ghosts can just idle.
        let pacTile = null;
        let pacDir = { x: 1, y: 0 };
        if (alivePlayers.length) {
            // take first for now (classic is “chase nearest”), good enough
            const st = alivePlayers[0].st;
            pacTile = { x: st.tileX ?? 14, y: st.tileY ?? 23 };
            pacDir = st.dir ?? pacDir;
        }

        for (const g of currentGame.ghosts.values()) {
            g.update(dt, pacTile, pacDir, now);
        }

        io.emit("GhostState", {
            t: now,
            ghosts: Array.from(currentGame.ghosts.values()).map((g) => g.snapshot()),
        });
    }, TICK_MS);
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
        console.log(`Player ${playerId} joined`);
        emitLobbyState();

        socket.on("player_ready", () => {
            const p = joinedPlayers.get(playerId);
            if (!p) return;
            p.ready = !p.ready;
            emitLobbyState();
        });

        socket.on("hostStart", async () => {
            io.emit("startGame");

            // Fresh game state but keep the lobby players
            const fresh = newGameState();
            fresh.players = currentGame.players; // keep map ref
            currentGame = fresh;

            // Initialize scores/lives
            for (const [pid] of currentGame.players) {
                currentGame.scores.set(pid, 0);
                currentGame.lives.set(pid, 3);
                currentGame.deaths.set(pid, 0);
            }

            initGhostsForRound();
            startGhostLoop();

            await waitASec(2000);
            io.emit("beginRound1");
        });

        // Kick helper (host-driven)
        socket.on("KickPlayer", (socketId) => {
            if (!socketId) return;
            io.to(socketId).disconnectSockets(true);
            emitLobbyState();
        });

        // Movement relay + server state store
        initializeMovement(socket, io, playerId, currentGame.players, currentGame.playerState);

        socket.on("DotEaten", ({ playerId: pid, x, y, type }) => {
            const eater = String(pid || playerId || "");
            if (!eater) return;
            if (eater !== String(playerId)) return; // no spoofing

            const key = `${x},${y}`;
            if (currentGame.eatenDots.has(key)) return;

            currentGame.eatenDots.add(key);

            const isPower = type === "power";
            const prev = currentGame.scores.get(eater) ?? 0;
            const delta = isPower ? 50 : 10;
            const newScore = prev + delta;
            currentGame.scores.set(eater, newScore);

            currentGame.dotsRemaining = Math.max(0, (currentGame.dotsRemaining ?? 0) - 1);

            io.emit("DotEatenConfirmed", {
                x, y, type,
                eaterPlayerId: eater,
                newScore,
                scores: Object.fromEntries(currentGame.scores),
            });

            if (isPower) {
                const until = Date.now() + 7000;
                for (const g of currentGame.ghosts.values()) {
                    g.frightenedUntil = until;
                    g.pendingReverse = true;
                }
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

            // Mark as out for THIS round (respawn happens on RoundEnded)
            currentGame.outThisRound.add(victimPlayerId);

            io.emit("LivesUpdate", {
                playerId: victimPlayerId,
                lives: Object.fromEntries(currentGame.lives),
                eliminated: (currentGame.lives.get(victimPlayerId) ?? 0) <= 0,
            });

            // If everyone is permanently eliminated, go back to lobby.
            const allEliminated = Array.from(currentGame.players.keys()).every(
                (pId) => (currentGame.lives.get(pId) ?? 0) <= 0
            );
            if (allEliminated) {
                io.emit("BackToLobby", {});
                stopGhostLoop();
            }
        });

        socket.on("RoundEnded", () => {
            // Authoritative round increment
            currentGame.round += 1;

            // Respawn list = players with lives > 0
            const respawn = [];
            for (const pid of currentGame.players.keys()) {
                const l = currentGame.lives.get(pid) ?? 0;
                if (l > 0) respawn.push(pid);
            }

            currentGame.outThisRound.clear();

            // New level dot-state for the next round
            currentGame.eatenDots.clear();
            currentGame.dotsRemaining = currentGame.totalDots;

            // Reset ghosts for new round
            currentGame.ghosts.clear();
            initGhostsForRound();

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
            currentGame.playerState.delete(playerId);
            currentGame.scores.delete(playerId);
            currentGame.lives.delete(playerId);
            currentGame.deaths.delete(playerId);
            currentGame.outThisRound.delete(playerId);

            emitLobbyState();
        });
    });

    return io;
}
