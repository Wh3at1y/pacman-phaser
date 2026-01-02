// src/socket.js (DROP-IN REPLACEMENT)
// Server-authoritative ghosts: TILE-PROGRESS grid movement + intersection decisions at centers only.
// Fixes: ghost jitter/freeze at intersections by preventing turns while mid-tile.

import { Server } from "socket.io";
import initializeMovement from "./helpers/movement.js";
import { waitASec } from "./helpers/timeout.js";
import { level1, level1_intersections } from "./levels/level1.js";

const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || true;

const TILE_SIZE = Number(process.env.TILE_SIZE || 24);
const SERVER_TICK_HZ = Number(process.env.SERVER_TICK_HZ || 30);
const GHOST_BROADCAST_HZ = Number(process.env.GHOST_BROADCAST_HZ || 20);

// Per-ghost base speed in tiles/sec (easy to tune with tile-progress movement)
const GHOST_TILES_PER_SEC = {
    blinky: 4.0,
    pinky: 3.8,
    inky: 3.6,
    clyde: 3.5,
};

function ghostSpeedPx(g) {
    const base = (GHOST_TILES_PER_SEC[g.ghostId] ?? 3.6) * TILE_SIZE;
    if (g.mode === "frightened") return base * 0.75;
    if (g.mode === "chase") return base * 1.0;
    if (g.mode === "scatter") return base * 0.95;
    return base;
}

const GHOST_SPAWNS = {
    blinky: { tileX: 14, tileY: 11, dir: { x: 1, y: 0 } },
    pinky:  { tileX: 14, tileY: 14, dir: { x: 0, y: -1 } },
    inky:   { tileX: 12, tileY: 14, dir: { x: 0, y: -1 } },
    clyde:  { tileX: 16, tileY: 14, dir: { x: 0, y: -1 } },
};

const RELEASE_BY_NAME_MS = {
    blinky: 1000,
    pinky: 1500,
    inky: 4500,
    clyde: 7500,
};

const DIRS = [
    { x: 1, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: -1 },
];

function oppositeDir(a, b) { return a && b && a.x === -b.x && a.y === -b.y; }
function sameDir(a, b) { return a && b && a.x === b.x && a.y === b.y; }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function wrapIndex(n, size) { if (n < 0) return size - 1; if (n >= size) return 0; return n; }

function mulberry32(seed) {
    let t = seed >>> 0;
    return function rand() {
        t += 0x6D2B79F5;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}

const playerNames = ["ButterBall", "Chowder", "BubbleWrap", "OrbitGum"];

function makeEmptyGameState() {
    return {
        players: new Map(),
        round: 1,
        scores: new Map(),
        lives: new Map(),
        deaths: new Map(),
        dotsRemaining: 244,

        ghosts: new Map(),
        gameRunning: false,

        rngSeed: 0,
        rand: null,

        house: null,
    };
}

let currentGame = makeEmptyGameState();
let io;

// ---- Level dims ----
const ROWS = level1.length;
const COLS = level1[0]?.length || 0;

function getTile(grid, tileX, tileY) {
    const y = clamp(tileY, 0, ROWS - 1);
    const x = wrapIndex(tileX, COLS);
    return grid[y]?.[x];
}

function isIntersection(tileX, tileY) {
    return getTile(level1_intersections, tileX, tileY) === "+";
}

function tileCenterX(tileX) { return tileX * TILE_SIZE + TILE_SIZE / 2; }
function tileCenterY(tileY) { return tileY * TILE_SIZE + TILE_SIZE / 2; }

function resetProgressAndSnap(g) {
    g.progress = 0;
    g.x = tileCenterX(g.tileX);
    g.y = tileCenterY(g.tileY);
}

function computeHouseInfoFromLevel() {
    const doorTiles = [];
    let minHouseY = Infinity;
    let maxHouseY = -Infinity;

    for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
            const t = level1[y][x];
            if (t === "~") doorTiles.push({ x, y });
            if (t === "X") {
                minHouseY = Math.min(minHouseY, y);
                maxHouseY = Math.max(maxHouseY, y);
            }
        }
    }

    const leftDoor = doorTiles.slice().sort((a, b) => a.x - b.x)[0];
    const exitTile = leftDoor ? { x: leftDoor.x, y: leftDoor.y - 1 } : null;

    return {
        doorTiles,
        exitTile,
        inHouseMinY: minHouseY === Infinity ? null : minHouseY,
        inHouseMaxY: maxHouseY === -Infinity ? null : maxHouseY,
    };
}

// Walls + ghost gate rules (match your client intent)
const WALLS = new Set(["═", "║", "╔", "╗", "╚", "╝", "┌", "┐", "└", "┘", "|", "-"]);
function isGhostPassable(fromX, fromY, toX, toY) {
    if (toY < 0 || toY >= ROWS) return false;
    if (toX < 0) toX = COLS - 1;
    if (toX >= COLS) toX = 0;

    const tile = level1[toY]?.[toX];
    if (!tile) return false;
    if (WALLS.has(tile)) return false;

    // Gate (~): allow exiting upward, block entry.
    if (tile === "~~" || tile === "~") {
        if (fromX === toX && fromY === toY) return true;
        return fromY > toY; // only allow moving up across gate
    }

    return true;
}

// ---- Ghost state ----
function initGhosts(nowMs) {
    currentGame.house = computeHouseInfoFromLevel();
    currentGame.ghosts.clear();

    for (const [ghostId, s] of Object.entries(GHOST_SPAWNS)) {
        const releaseDelay = RELEASE_BY_NAME_MS[ghostId] ?? 0;
        const releaseAt = nowMs + releaseDelay;

        const state = ghostId === "blinky" ? "active" : "inHouse";

        currentGame.ghosts.set(ghostId, {
            ghostId,
            tileX: s.tileX,
            tileY: s.tileY,
            dir: { ...s.dir },
            nextDir: { ...s.dir },

            // Tile-progress movement state
            progress: 0,
            x: tileCenterX(s.tileX),
            y: tileCenterY(s.tileY),

            state,          // inHouse | leaving | active
            mode: "scatter",
            releaseAtMs: releaseAt,

            seq: 0,
        });
    }
}

function ghostSnapshotPayload() {
    return Array.from(currentGame.ghosts.values()).map((g) => ({
        ghostId: g.ghostId,
        x: g.x,
        y: g.y,
        tileX: g.tileX,
        tileY: g.tileY,
        dir: g.dir,
        nextDir: g.nextDir,
        state: g.state,
        mode: g.mode,
        releaseAtMs: g.releaseAtMs,
        seq: g.seq,
    }));
}

let tickInterval = null;
let lastBroadcastMs = 0;

function broadcastGhostSnapshot(force = false) {
    if (!io) return;

    const now = Date.now();
    const minInterval = 1000 / GHOST_BROADCAST_HZ;
    if (!force && now - lastBroadcastMs < minInterval) return;

    lastBroadcastMs = now;
    io.emit("GhostSnapshot", { t: now, ghosts: ghostSnapshotPayload() });
}

function chooseRandom(validDirs) {
    if (!validDirs.length) return null;
    const r = currentGame.rand ? currentGame.rand() : Math.random();
    return validDirs[Math.floor(r * validDirs.length)];
}

function getValidDirs(tileX, tileY, currentDir, allowReverse) {
    const out = [];
    for (const d of DIRS) {
        if (!allowReverse && oppositeDir(d, currentDir)) continue;
        const nx = tileX + d.x;
        const ny = tileY + d.y;
        if (isGhostPassable(tileX, tileY, nx, ny)) out.push(d);
    }
    if (!allowReverse && out.length === 0) {
        return getValidDirs(tileX, tileY, currentDir, true);
    }
    return out;
}

/**
 * Tile-progress mover.
 * IMPORTANT FIX: Only decide turns when progress === 0 (at tile center).
 * Mid-tile, we do NOT re-run intersection logic or resetProgressAndSnap.
 */
function stepGhostTileProgress(g, dtSeconds, speedPx) {
    let remaining = speedPx * dtSeconds;

    // Safety: ensure dir is valid
    if (!g.dir || (g.dir.x === 0 && g.dir.y === 0)) {
        g.dir = { x: -1, y: 0 };
        g.nextDir = { ...g.dir };
        resetProgressAndSnap(g);
    }

    while (remaining > 0.0001) {
        // If at center, we may decide direction here.
        if (g.progress === 0) {
            const tx = g.tileX;
            const ty = g.tileY;

            const aheadX = tx + g.dir.x;
            const aheadY = ty + g.dir.y;
            const aheadPassable = isGhostPassable(tx, ty, aheadX, aheadY);

            if (!aheadPassable || isIntersection(tx, ty)) {
                const valid = getValidDirs(tx, ty, g.dir, false);
                const chosen = chooseRandom(valid) || g.dir;

                if (!sameDir(chosen, g.dir)) {
                    g.dir = { ...chosen };
                    g.nextDir = { ...chosen };
                    // stay at center (progress already 0), but keep it explicit:
                    resetProgressAndSnap(g);

                    io.emit("GhostTurn", {
                        ghostId: g.ghostId,
                        tileX: tx,
                        tileY: ty,
                        dir: g.dir,
                        nextDir: g.nextDir,
                        seq: g.seq,
                    });
                }
            }

            // If we can't advance from center, stop here.
            const nx = g.tileX + g.dir.x;
            const ny = g.tileY + g.dir.y;
            if (!isGhostPassable(g.tileX, g.tileY, nx, ny)) {
                resetProgressAndSnap(g);
                return;
            }
        }

        // Move toward next tile center
        const need = TILE_SIZE - g.progress;
        const step = Math.min(remaining, need);

        g.progress += step;
        remaining -= step;

        // Completed the tile step: commit to next tile
        if (g.progress >= TILE_SIZE - 0.0001) {
            g.progress = 0;
            g.tileX = wrapIndex(g.tileX + g.dir.x, COLS);
            g.tileY = clamp(g.tileY + g.dir.y, 0, ROWS - 1);
            resetProgressAndSnap(g);
            continue;
        }

        // Partial step: update x/y along travel axis only
        g.x = tileCenterX(g.tileX) + g.dir.x * g.progress;
        g.y = tileCenterY(g.tileY) + g.dir.y * g.progress;
    }
}

function stepGhost(g, dtSeconds, nowMs) {
    // Clamp tiles (tileX/tileY are authoritative under tile-progress movement)
    g.tileX = wrapIndex(g.tileX, COLS);
    g.tileY = clamp(g.tileY, 0, ROWS - 1);

    // Release scheduling
    if (g.state === "inHouse" && nowMs >= g.releaseAtMs) {
        g.state = "leaving";
        g.dir = { x: 0, y: -1 };
        g.nextDir = { x: 0, y: -1 };
        resetProgressAndSnap(g);
    }

    // Leaving: head toward exit tile
    if (g.state === "leaving") {
        const exit = currentGame.house?.exitTile;
        if (!exit) {
            g.state = "active";
            resetProgressAndSnap(g);
        } else {
            // Only adjust leaving direction at centers (progress === 0)
            if (g.progress === 0) {
                if (g.tileY > exit.y) {
                    g.dir = { x: 0, y: -1 };
                } else if (g.tileX !== exit.x) {
                    g.dir = { x: exit.x > g.tileX ? 1 : -1, y: 0 };
                } else {
                    g.state = "active";
                    resetProgressAndSnap(g);
                }
                g.nextDir = { ...g.dir };
            }

            stepGhostTileProgress(g, dtSeconds, ghostSpeedPx(g));
            g.seq++;
            return;
        }
    }

    if (g.state === "active") {
        stepGhostTileProgress(g, dtSeconds, ghostSpeedPx(g));
        g.seq++;
    }
}

let lastTickMs = 0;

function startServerTickLoop() {
    if (tickInterval) return;

    lastTickMs = Date.now();
    const tickMs = Math.max(5, Math.floor(1000 / SERVER_TICK_HZ));

    tickInterval = setInterval(() => {
        if (!currentGame.gameRunning) {
            lastTickMs = Date.now();
            return;
        }

        const now = Date.now();
        let dtSeconds = (now - lastTickMs) / 1000;
        lastTickMs = now;

        // Prevent hitch-teleports
        dtSeconds = Math.min(dtSeconds, 0.05);

        for (const g of currentGame.ghosts.values()) {
            stepGhost(g, dtSeconds, now);
        }

        broadcastGhostSnapshot(false);
    }, tickMs);
}

function stopServerTickLoop() {
    if (tickInterval) clearInterval(tickInterval);
    tickInterval = null;
    lastBroadcastMs = 0;
}

// ---- Lobby helpers ----
function emitLobbyState() {
    io.emit("joined", Object.fromEntries(currentGame.players.entries()));
}

function pickName() {
    const existing = Array.from(currentGame.players.values()).map((p) => p.name);
    const available = playerNames.filter((n) => !existing.includes(n));
    const pool = available.length ? available : playerNames;
    return pool[Math.floor(Math.random() * pool.length)];
}

function ensureLobbyLeader() {
    const players = Array.from(currentGame.players.values());
    if (players.length === 0) return;
    if (players.some((p) => p.lobbyLeader)) return;

    const [firstId] = currentGame.players.keys();
    const first = currentGame.players.get(firstId);
    if (first) first.lobbyLeader = true;
}

function resetRoundStateKeepPlayers() {
    currentGame.round = 1;
    currentGame.scores = new Map();
    currentGame.lives = new Map();
    currentGame.deaths = new Map();
    currentGame.dotsRemaining = 244;

    for (const [pid] of currentGame.players) {
        currentGame.scores.set(pid, 0);
        currentGame.lives.set(pid, 3);
        currentGame.deaths.set(pid, 0);
    }

    initGhosts(Date.now());
    broadcastGhostSnapshot(true);
}

function backToLobby(reason = "all_eliminated") {
    currentGame.gameRunning = false;
    stopServerTickLoop();

    for (const p of currentGame.players.values()) p.ready = false;
    ensureLobbyLeader();

    io.emit("BackToLobby", {
        reason,
        round: currentGame.round,
        players: Object.fromEntries(currentGame.players.entries()),
        scores: Object.fromEntries(currentGame.scores.entries()),
        lives: Object.fromEntries(currentGame.lives.entries()),
        deaths: Object.fromEntries(currentGame.deaths.entries()),
    });

    emitLobbyState();
}

// ---- Socket server ----
export function initSocketServer(server) {
    io = new Server(server, {
        cors: { origin: CLIENT_ORIGIN, methods: ["GET", "POST"], credentials: true },
        transports: ["websocket", "polling"],
    });

    io.on("connection", (socket) => {
        const playerId = socket.handshake.auth?.playerId;
        if (!playerId) {
            socket.disconnect(true);
            return;
        }

        const existing = currentGame.players.get(playerId);
        if (existing) {
            existing.socketId = socket.id;
            existing.lastSeen = Date.now();
        } else {
            currentGame.players.set(playerId, {
                playerId,
                name: pickName(),
                ready: false,
                socketId: socket.id,
                lastSeen: Date.now(),
                lobbyLeader: currentGame.players.size === 0,
            });
        }

        ensureLobbyLeader();
        emitLobbyState();

        socket.on("player_ready", () => {
            const p = currentGame.players.get(playerId);
            if (!p) return;
            p.ready = !p.ready;
            emitLobbyState();
        });

        socket.on("hostStart", async () => {
            const p = currentGame.players.get(playerId);
            if (!p?.lobbyLeader) return;

            const allReady = Array.from(currentGame.players.values()).every((pl) => pl.ready);
            if (!allReady) return;

            currentGame.rngSeed = (Date.now() & 0xffffffff) >>> 0;
            currentGame.rand = mulberry32(currentGame.rngSeed);

            io.emit("startGame");
            resetRoundStateKeepPlayers();

            await waitASec(2000);

            currentGame.gameRunning = true;
            startServerTickLoop();
            broadcastGhostSnapshot(true);

            io.emit("beginRound1", {
                round: currentGame.round,
                scores: Object.fromEntries(currentGame.scores.entries()),
                lives: Object.fromEntries(currentGame.lives.entries()),
                rngSeed: currentGame.rngSeed,
            });
        });

        socket.on("KickPlayer", (socketId) => {
            const p = currentGame.players.get(playerId);
            if (!p?.lobbyLeader) return;
            if (!socketId) return;
            io.to(socketId).emit("kicked");
            emitLobbyState();
        });

        // Player movement relay
        initializeMovement(socket, io, playerId, currentGame.players);

        socket.on("DotEaten", ({ playerId: eaterId, x, y, type, seq }) => {
            if (!eaterId || !currentGame.players.has(eaterId)) return;

            const isPower = type === "power";
            const prev = currentGame.scores.get(eaterId) ?? 0;
            const delta = isPower ? 50 : 10;
            const newScore = prev + delta;
            currentGame.scores.set(eaterId, newScore);
            currentGame.dotsRemaining = Math.max(0, (currentGame.dotsRemaining ?? 0) - 1);

            io.emit("DotEatenConfirmed", {
                x, y, type,
                eaterPlayerId: eaterId,
                newScore,
                scores: Object.fromEntries(currentGame.scores.entries()),
                seq: seq ?? 0,
            });

            if (isPower) {
                io.emit("FrightenedStart", { durationMs: 7000 });
                for (const g of currentGame.ghosts.values()) g.mode = "frightened";
                broadcastGhostSnapshot(true);
            }
        });

        socket.on("PlayerDied", ({ victimPlayerId }) => {
            if (!victimPlayerId) return;
            if (!currentGame.players.has(victimPlayerId)) return;

            const curLives = currentGame.lives.get(victimPlayerId) ?? 3;
            if (curLives <= 0) return;

            const nextLives = curLives - 1;
            currentGame.lives.set(victimPlayerId, nextLives);
            currentGame.deaths.set(victimPlayerId, (currentGame.deaths.get(victimPlayerId) ?? 0) + 1);

            io.emit("LivesUpdate", {
                playerId: victimPlayerId,
                lives: Object.fromEntries(currentGame.lives.entries()),
                eliminated: nextLives <= 0,
            });

            const allEliminated = Array.from(currentGame.players.keys()).every(
                (pId) => (currentGame.lives.get(pId) ?? 0) <= 0
            );
            if (allEliminated) backToLobby("all_eliminated");
        });

        socket.on("RoundEnded", () => {
            const respawn = [];
            for (const [pid] of currentGame.players) {
                const l = currentGame.lives.get(pid) ?? 0;
                if (l > 0) respawn.push(pid);
            }

            if ((currentGame.dotsRemaining ?? 0) <= 0) {
                currentGame.round += 1;
                currentGame.dotsRemaining = 244;
                initGhosts(Date.now());
                broadcastGhostSnapshot(true);
            }

            io.emit("RoundEnded", { respawn, round: currentGame.round });
        });

        socket.on("GhostSnapshotRequest", () => {
            broadcastGhostSnapshot(true);
        });

        socket.on("disconnect", () => {
            const p = currentGame.players.get(playerId);
            if (!p) return;

            currentGame.players.delete(playerId);

            if (p.lobbyLeader) {
                for (const pl of currentGame.players.values()) pl.lobbyLeader = false;
                ensureLobbyLeader();
            }

            if (currentGame.players.size === 0) {
                currentGame.gameRunning = false;
                stopServerTickLoop();
                currentGame = makeEmptyGameState();
            }

            emitLobbyState();
        });
    });

    return io;
}
