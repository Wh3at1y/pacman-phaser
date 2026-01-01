import { Server } from "socket.io";
import initializeMovement from "./helpers/movement.js";
import {waitASec} from "./helpers/timeout.js";
import {level1} from "./levels/level1.js";
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || true;

let io;

// ----- Lobby state -----
const playerNames = ["ButterBall", "Chowder", "BubbleWrap", "OrbitGum"];

const TICK_MS = 50; // 20Hz; clients interpolate to 60fps
let ghostTimer = null;

// Minimal ghost state
const ghostNames = ["Blinky", "Pinky", "Inky", "Clyde"];

// Deterministic PRNG per round so frightened randomness stays identical for everyone
function mulberry32(seed) {
    return function () {
        let t = (seed += 0x6D2B79F5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}


const staticGame = {
    players: new Map(),
    round: 1,
    scores: new Map(),
    lives: new Map(),
    deaths: new Map(),
    dotsRemaining: 244,
    playerState: new Map(), // playerId -> { x,y,tileX,tileY, dir:{x,y}, alive }
    ghosts: new Map(),      // name -> ghost object
    rngSeed: 12345,
    rng: mulberry32(12345),
}

let currentGame = {...staticGame}

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
            io.emit("startGame");

            for (const [pid] of currentGame.players) {
                currentGame.scores.set(pid, 0);
                currentGame.lives.set(pid, 3);
                currentGame.deaths.set(pid, 0);
            }

            currentGame = { ...staticGame }

            // Reset round/dots (do NOT do currentGame = staticGame, that nukes your Maps incorrectly)
            currentGame.round = 1;
            currentGame.dotsRemaining = 244;

            // Initialize ghost sim
            initGhostsForRound();
            startGhostLoop();

            await waitASec(2000);
            io.emit("beginRound1");
        });


        socket.on("KickPlayer", (socketId) => {
            io.to(socketId).emit('kicked');
            emitLobbyState()
        });

        // Initialize Movement
        initializeMovement(socket, io, playerId, currentGame.players, currentGame.playerState);

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
                const until = Date.now() + 7000;
                for (const g of currentGame.ghosts.values()) {
                    g.frightenedUntil = until;
                    g.pendingReverse = true; // arcade reversal
                }
                io.emit("FrightenedStart", { durationMs: 7000 }); // optional UI
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
            emitLobbyState()
        });
    });

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

// Added helpers

function initGhostsForRound() {
    // NOTE: Use your actual ghost house tiles here.
    // These are placeholder spawn tiles you must match to your map.
    const spawns = [
        { tileX: 13, tileY: 14, dir: { x: 1, y: 0 } }, // Blinky
        { tileX: 13, tileY: 16, dir: { x: -1, y: 0 } }, // Pinky
        { tileX: 12, tileY: 16, dir: { x: 1, y: 0 } }, // Inky
        { tileX: 14, tileY: 16, dir: { x: -1, y: 0 } }, // Clyde
    ];

    currentGame.ghosts = new Map();
    ghostNames.forEach((name, i) => {
        const s = spawns[i];
        currentGame.ghosts.set(name, {
            name,
            tileX: s.tileX,
            tileY: s.tileY,
            x: s.tileX * 24 + 12,
            y: s.tileY * 24 + 12,
            dir: { ...s.dir },
            mode: "scatter",
            state: "active",
            frightenedUntil: 0,
            pendingReverse: false,
            speed: 80, // base px/s (tune)
        });
    });

    // Reset deterministic rng per round
    currentGame.rngSeed = 10000 + currentGame.round * 1337;
    currentGame.rng = mulberry32(currentGame.rngSeed);
}

// VERY IMPORTANT: you must implement passability based on your level grid.
// For now we rely on client-style tiles: walls are not passable.
// You can import your level array/grid here if you want.
function isGhostPassableTile(tx, ty) {
    // TODO: wire to your level data (level1.js on server) like you do in MainScene.
    // For now, just prevent going off-grid:
    if (ty < 0 || ty >= 31) return false;
    // allow horizontal wrap
    return true;
}

function chooseDirFrightened(ghost, targetTile) {
    // Simple: choose a direction that increases distance (avoid reversing if possible)
    const dirs = [
        { x: 1, y: 0 },
        { x: -1, y: 0 },
        { x: 0, y: 1 },
        { x: 0, y: -1 },
    ];

    const rev = { x: -ghost.dir.x, y: -ghost.dir.y };
    const options = dirs.filter(d => !(d.x === rev.x && d.y === rev.y));

    let best = null;
    let bestScore = -Infinity;

    for (const d of options) {
        const nx = ghost.tileX + d.x;
        const ny = ghost.tileY + d.y;
        if (!isGhostPassableTile(nx, ny)) continue;

        const dx = (nx - targetTile.x);
        const dy = (ny - targetTile.y);
        const score = dx * dx + dy * dy;

        // tiny deterministic jitter to break ties
        const jitter = currentGame.rng() * 0.01;

        if (score + jitter > bestScore) {
            bestScore = score + jitter;
            best = d;
        }
    }

    return best || ghost.dir;
}

function nearestAlivePlayerTile() {
    let best = null;
    let bestD2 = Infinity;

    for (const [pid, st] of currentGame.playerState.entries()) {
        if (!st || st.alive === false) continue;
        const dx = st.tileX - 13;
        const dy = st.tileY - 15;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
            bestD2 = d2;
            best = { x: st.tileX, y: st.tileY };
        }
    }
    return best || { x: 13, y: 23 }; // fallback
}

function tickGhosts(dtSec) {
    const now = Date.now();
    const pacTile = nearestAlivePlayerTile();

    for (const g of currentGame.ghosts.values()) {
        // frightened flag
        const frightened = now < g.frightenedUntil;

        // reverse once on frightened start (arcade behavior)
        if (g.pendingReverse) {
            g.dir = { x: -g.dir.x, y: -g.dir.y };
            g.pendingReverse = false;
        }

        // Pick direction at tile center (simplified center check)
        const cx = g.tileX * 24 + 12;
        const cy = g.tileY * 24 + 12;
        const atCenter = Math.abs(g.x - cx) < 0.5 && Math.abs(g.y - cy) < 0.5;

        // ---- STEP 3: validate next step and reroute if blocked ----
        let nextTX = wrapXTile(g.tileX + g.dir.x);
        let nextTY = g.tileY + g.dir.y;

        if (!isGhostPassableTile(g.tileX, g.tileY, nextTX, nextTY)) {
            const dirs = [
                { x: 1, y: 0 },
                { x: -1, y: 0 },
                { x: 0, y: 1 },
                { x: 0, y: -1 },
            ];

            const rev = { x: -g.dir.x, y: -g.dir.y };

            // prefer not reversing unless needed
            const options = dirs
                .filter(d => !(d.x === rev.x && d.y === rev.y))
                .filter(d => isGhostPassableTile(g.tileX, g.tileY, wrapXTile(g.tileX + d.x), g.tileY + d.y));

            if (options.length > 0) {
                const idx = Math.floor(currentGame.rng() * options.length);
                g.dir = options[idx];
            } else {
                // last resort: allow reverse
                const revTX = wrapXTile(g.tileX + rev.x);
                const revTY = g.tileY + rev.y;
                if (isGhostPassableTile(g.tileX, g.tileY, revTX, revTY)) {
                    g.dir = rev;
                }
            }

            // recompute next after possible dir change
            nextTX = wrapXTile(g.tileX + g.dir.x);
            nextTY = g.tileY + g.dir.y;

            // still blocked? don't advance this tick
            if (!isGhostPassableTile(g.tileX, g.tileY, nextTX, nextTY)) {
                return; // or just skip advancing tile for this ghost
            }
        }

// now advance tile coords (safe)
        g.tileX = nextTX;
        g.tileY = nextTY;


        // move pixels
        const speed = frightened ? g.speed * 0.6 : g.speed;
        g.x += g.dir.x * speed * dtSec;
        g.y += g.dir.y * speed * dtSec;

        // wrap X pixels
        const mapW = 28 * 24;
        if (g.x < -12) g.x += mapW + 24;
        if (g.x > mapW + 12) g.x -= mapW + 24;
    }
}

function emitGhostState() {
    io.emit("GhostState", {
        t: Date.now(),
        ghosts: Array.from(currentGame.ghosts.values()).map(g => ({
            name: g.name,
            x: g.x,
            y: g.y,
            tileX: g.tileX,
            tileY: g.tileY,
            dir: g.dir,
            frightenedUntil: g.frightenedUntil,
        })),
    });
}

function startGhostLoop() {
    if (ghostTimer) return;
    let last = Date.now();

    ghostTimer = setInterval(() => {
        const now = Date.now();
        const dtSec = Math.min(0.1, (now - last) / 1000);
        last = now;

        tickGhosts(dtSec);
        emitGhostState();
    }, TICK_MS);
}

function stopGhostLoop() {
    if (!ghostTimer) return;
    clearInterval(ghostTimer);
    ghostTimer = null;
}

const WALLS = ["═", "║", "╔", "╗", "╚", "╝", "┌", "┐", "└", "┘", "|", "-"];

function isGhostPassable(fromX, fromY, toX, toY) {
    const rows = level1.length;
    const cols = level1[0].length;

    // vertical bounds are hard walls
    if (toY < 0 || toY >= rows) return false;

    // horizontal wrap (tunnel)
    if (toX < 0) toX = cols - 1;
    if (toX >= cols) toX = 0;

    const tile = level1[toY]?.[toX];
    if (!tile) return false;

    // solid walls
    if (WALLS.includes(tile)) return false;

    // ghost-house gate rules (same as your client)
    if (tile === "~~" || tile === "~") {
        // occupancy check: standing on the gate is OK
        if (fromX === toX && fromY === toY) return true;
        // crossing: only allow moving UP out of the house
        return fromY > toY;
    }

    return true;
}

function wrapXTile(x) {
    const cols = level1[0].length;
    if (x < 0) return cols - 1;
    if (x >= cols) return 0;
    return x;
}


