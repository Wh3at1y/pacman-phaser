import { Server } from "socket.io";
import initializeMovement from "./helpers/movement.js";
import {waitASec} from "./helpers/timeout.js";
import {level1} from "./levels/level1.js";
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || true;
import GhostSim from "./helpers/GhostSim.js";


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
    const TS = 24;

    const rows = level1.length;
    const cols = level1[0].length;

    // Build a "world" adapter GhostSim expects
    const world = {
        TILE_SIZE: TS,
        levelRows: rows,
        levelCols: cols,
        isGhostPassable, // use your REAL function (already defined in this file)
        // optional if you want house logic; otherwise you can omit
        isGhostHouseTile: (x, y) => {
            const t = level1[y]?.[x];
            return t === "X";
        },
        getGhost: (name) => currentGame.ghosts.get(name),
    };

    // Spawn tiles (match your map)
    const spawns = {
        blinky: { x: 13, y: 14, dir: { x: 1, y: 0 } },
        pinky:  { x: 13, y: 16, dir: { x: -1, y: 0 } },
        inky:   { x: 12, y: 16, dir: { x: 1, y: 0 } },
        clyde:  { x: 14, y: 16, dir: { x: -1, y: 0 } },
    };

    // Scatter corners (classic-ish)
    const scatter = {
        blinky: { x: cols - 2, y: 1 },
        pinky:  { x: 1, y: 1 },
        inky:   { x: cols - 2, y: rows - 2 },
        clyde:  { x: 1, y: rows - 2 },
    };

    currentGame.ghosts = new Map();

    for (const name of ["blinky", "pinky", "inky", "clyde"]) {
        const s = spawns[name];
        const g = new GhostSim(world, {
            name,
            speed: 80,
            startTile: { x: s.x, y: s.y },
            startDir: s.dir,
            scatterTarget: scatter[name],
        });

        // If you want house state: configure it here by scanning door tiles "~"
        // (You can leave this disabled initially to keep behavior predictable.)
        // g.configureHouse(cfg); g.reset(Date.now());

        currentGame.ghosts.set(name, g);
    }

    // Reset deterministic rng per round (you already do this)
    currentGame.rngSeed = 10000 + currentGame.round * 1337;
    currentGame.rng = mulberry32(currentGame.rngSeed);

    // Ghost mode timing
    currentGame.modeStartAt = Date.now();
    currentGame.modeIndex = 0;
    currentGame.mode = "scatter";
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


const MODE_SCHEDULE = [
    { mode: "scatter", ms: 7000 },
    { mode: "chase",   ms: 20000 },
    { mode: "scatter", ms: 7000 },
    { mode: "chase",   ms: 20000 },
    { mode: "scatter", ms: 5000 },
    { mode: "chase",   ms: 20000 },
    { mode: "scatter", ms: 5000 },
    // then chase forever
];

function dirVecFromPlayerState(st) {
    // If your movement helper stores dir as {x,y}, this is trivial:
    if (st?.dir && typeof st.dir.x === "number") return st.dir;

    // If it stores numeric directions, map them here:
    // (Adjust if your project uses different values)
    const d = st?.dir;
    if (d === 1) return { x: -1, y: 0 };
    if (d === 2) return { x: 1, y: 0 };
    if (d === 3) return { x: 0, y: -1 };
    if (d === 4) return { x: 0, y: 1 };
    return { x: 1, y: 0 };
}

function getTargetPlayerForGhost(ghost) {
    // simplest: nearest alive player to THIS ghost
    let best = null;
    let bestD2 = Infinity;

    for (const [pid, st] of currentGame.playerState.entries()) {
        if (!st || st.alive === false) continue;
        const d2 = (st.tileX - ghost.tileX) ** 2 + (st.tileY - ghost.tileY) ** 2;
        if (d2 < bestD2) {
            bestD2 = d2;
            best = st;
        }
    }

    return best || { tileX: 13, tileY: 23, dir: { x: 1, y: 0 } };
}

function advanceMode(now) {
    if (!MODE_SCHEDULE[currentGame.modeIndex]) {
        currentGame.mode = "chase";
        return;
    }

    const cur = MODE_SCHEDULE[currentGame.modeIndex];
    const elapsed = now - currentGame.modeStartAt;

    if (elapsed >= cur.ms) {
        currentGame.modeIndex += 1;
        currentGame.modeStartAt = now;
        const next = MODE_SCHEDULE[currentGame.modeIndex];
        currentGame.mode = next ? next.mode : "chase";

        // If you want arcade reversal on mode change, flag it here.
        // currentGame.pendingModeReverse = true;
    } else {
        currentGame.mode = cur.mode;
    }
}

function tickGhosts(dtSec) {
    const now = Date.now();
    const dtMs = Math.floor(dtSec * 1000);

    advanceMode(now);

    for (const g of currentGame.ghosts.values()) {
        // Apply current mode (server authoritative)
        g.setMode(currentGame.mode);

        // Frightened reversal: you already set pendingReverse when DotEaten :contentReference[oaicite:14]{index=14}
        // If you still want it, keep it, but do it at center to avoid jitter.
        if (g.pendingReverse && g.atTileCenter?.()) {
            g.dir = { x: -g.dir.x, y: -g.dir.y };
            g.pendingReverse = false;
        } else if (g.pendingReverse && !g.atTileCenter?.()) {
            // wait until center
        }

        const target = getTargetPlayerForGhost(g);
        const pacTile = { x: target.tileX, y: target.tileY };
        const pacDir = dirVecFromPlayerState(target);

        g.update(dtMs, pacTile, pacDir, now);
    }
}

function emitGhostState() {
    io.emit("GhostState", {
        t: Date.now(),
        ghosts: Array.from(currentGame.ghosts.values()).map((g) => g.snapshot()),
    });
}



