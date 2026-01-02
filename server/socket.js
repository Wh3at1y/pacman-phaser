// src/socket.js (FULL DROP-IN REPLACEMENT)
//
// Fixes ghost-house exiting deterministically for ALL ghosts via "~" / "~~" gate.
// - Computes gate tiles ("~" and "~~"), staging tiles below the gate, and house bounds.
// - Uses BFS restricted to the ghost house to route each ghost to a staging tile.
// - While state === "leaving": NO intersection/random turning.
// - Tile-progress movement (grid locked) for consistent multiplayer sync.

import { Server } from "socket.io";
import initializeMovement from "./helpers/movement.js";
import { waitASec } from "./helpers/timeout.js";
import { level1, level1_intersections } from "./levels/level1.js";

const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || true;

const TILE_SIZE = Number(process.env.TILE_SIZE || 24);
const SERVER_TICK_HZ = Number(process.env.SERVER_TICK_HZ || 30);
const GHOST_BROADCAST_HZ = Number(process.env.GHOST_BROADCAST_HZ || 20);

// tiles/sec (easy to tune)
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

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function wrapIndex(n, size) { if (n < 0) return size - 1; if (n >= size) return 0; return n; }
function sameDir(a, b) { return a && b && a.x === b.x && a.y === b.y; }
function oppositeDir(a, b) { return a && b && a.x === -b.x && a.y === -b.y; }

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

// ---- Level helpers ----
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

// Walls + gate
const WALLS = new Set(["═", "║", "╔", "╗", "╚", "╝", "┌", "┐", "└", "┘", "|", "-"]);

function isGateTileChar(t) {
    return t === "~" || t === "~~";
}

function isGhostPassable(fromX, fromY, toX, toY) {
    if (toY < 0 || toY >= ROWS) return false;

    // wrap tunnels
    if (toX < 0) toX = COLS - 1;
    if (toX >= COLS) toX = 0;

    const tile = level1[toY]?.[toX];
    if (!tile) return false;
    if (WALLS.has(tile)) return false;

    // Gate: only passable when moving upward onto it
    if (isGateTileChar(tile)) {
        return fromY > toY;
    }

    return true;
}

// House analysis: find gate row/cols, staging tiles, and a bounding box around the house
function computeHouseInfoFromLevel() {
    const gateTiles = [];
    let gateY = null;

    let minHouseY = Infinity, maxHouseY = -Infinity;
    let minHouseX = Infinity, maxHouseX = -Infinity;

    // Scan once
    for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
            const t = level1[y][x];
            if (isGateTileChar(t)) {
                gateTiles.push({ x, y });
                gateY = gateY ?? y;
            }
            if (t === "X") {
                minHouseY = Math.min(minHouseY, y);
                maxHouseY = Math.max(maxHouseY, y);
                minHouseX = Math.min(minHouseX, x);
                maxHouseX = Math.max(maxHouseX, x);
            }
        }
    }

    // If X tiles weren't used, fallback bounds from gate
    if (minHouseX === Infinity && gateTiles.length) {
        minHouseX = Math.min(...gateTiles.map(t => t.x)) - 4;
        maxHouseX = Math.max(...gateTiles.map(t => t.x)) + 4;
        minHouseY = gateTiles[0].y + 1;
        maxHouseY = gateTiles[0].y + 6;
    }

    if (gateY === null) {
        return {
            gateTiles: [],
            gateY: null,
            stagingY: null,
            outsideY: null,
            stagingTiles: [],
            gateXs: [],
            bounds: null,
        };
    }

    const stagingY = gateY + 1;
    const outsideY = gateY - 1;

    const gateXs = [...new Set(gateTiles.map(t => t.x))].sort((a, b) => a - b);

    // Staging tiles are tiles directly below each gate tile (same x, y=stagingY)
    // but only those which can move UP onto the gate (so we know the gate rule works).
    const stagingTiles = [];
    for (const gx of gateXs) {
        if (stagingY >= 0 && stagingY < ROWS) {
            const ok = isGhostPassable(gx, stagingY, gx, gateY); // from staging up onto gate
            if (ok) stagingTiles.push({ x: gx, y: stagingY });
        }
    }

    // Tight bounds around the ghost house area:
    // expand a bit to include interior wiggle room but prevent BFS from wandering into the maze.
    const padX = 2;
    const padY = 2;

    const bounds = {
        minX: clamp(minHouseX - padX, 0, COLS - 1),
        maxX: clamp(maxHouseX + padX, 0, COLS - 1),
        minY: clamp(Math.min(minHouseY, stagingY) - padY, 0, ROWS - 1),
        maxY: clamp(Math.max(maxHouseY, stagingY) + padY, 0, ROWS - 1),
    };

    return {
        gateTiles,
        gateY,
        stagingY,
        outsideY,
        stagingTiles,
        gateXs,
        bounds,
    };
}

function pickNearestStagingTile(g) {
    const tiles = currentGame.house?.stagingTiles || [];
    if (!tiles.length) return null;
    let best = tiles[0];
    let bestD = Math.abs(g.tileX - best.x) + Math.abs(g.tileY - best.y);
    for (let i = 1; i < tiles.length; i++) {
        const t = tiles[i];
        const d = Math.abs(g.tileX - t.x) + Math.abs(g.tileY - t.y);
        if (d < bestD) { best = t; bestD = d; }
    }
    return best;
}

// BFS restricted to ghost-house bounds.
// Returns the FIRST direction to step from (sx,sy) toward (tx,ty).
function bfsFirstDirHouse(sx, sy, tx, ty) {
    const house = currentGame.house;
    if (!house?.bounds) return null;

    const { minX, maxX, minY, maxY } = house.bounds;

    const inBounds = (x, y) => x >= minX && x <= maxX && y >= minY && y <= maxY;

    const key = (x, y) => `${x},${y}`;
    const q = [{ x: sx, y: sy }];
    const prev = new Map();
    prev.set(key(sx, sy), null);

    while (q.length) {
        const cur = q.shift();
        if (cur.x === tx && cur.y === ty) break;

        for (const d of DIRS) {
            const nx = cur.x + d.x;
            const ny = cur.y + d.y;

            // No wrapping inside house BFS
            if (!inBounds(nx, ny)) continue;

            // Don’t route through the gate row itself; staging is below it.
            if (house.gateY !== null && ny === house.gateY) continue;

            if (!isGhostPassable(cur.x, cur.y, nx, ny)) continue;

            const k = key(nx, ny);
            if (prev.has(k)) continue;

            prev.set(k, cur);
            q.push({ x: nx, y: ny });
        }
    }

    const targetKey = key(tx, ty);
    if (!prev.has(targetKey)) return null;

    // Walk back to find first step
    let cur = { x: tx, y: ty };
    let p = prev.get(targetKey);

    while (p && !(p.x === sx && p.y === sy)) {
        cur = p;
        p = prev.get(key(cur.x, cur.y));
    }

    const dx = cur.x - sx;
    const dy = cur.y - sy;

    if (dx === 1) return { x: 1, y: 0 };
    if (dx === -1) return { x: -1, y: 0 };
    if (dy === 1) return { x: 0, y: 1 };
    if (dy === -1) return { x: 0, y: -1 };
    return null;
}

// ---- Ghosts ----
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

            progress: 0,
            x: tileCenterX(s.tileX),
            y: tileCenterY(s.tileY),

            state, // inHouse | leaving | active
            mode: "scatter",
            releaseAtMs: releaseAt,

            // leaving targets
            leaveTarget: null,

            seq: 0,
        });
    }

    // Assign each ghost a staging tile under the gate (nearest)
    for (const g of currentGame.ghosts.values()) {
        g.leaveTarget = pickNearestStagingTile(g);
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
 * allowTurns=true: intersection/blocked decisions at centers.
 * allowTurns=false: purely executes current direction (scripted).
 */
function stepGhostTileProgress(g, dtSeconds, speedPx, allowTurns = true) {
    let remaining = speedPx * dtSeconds;

    if (!g.dir || (g.dir.x === 0 && g.dir.y === 0)) {
        g.dir = { x: -1, y: 0 };
        g.nextDir = { ...g.dir };
        resetProgressAndSnap(g);
    }

    while (remaining > 0.0001) {
        if (g.progress === 0) {
            const tx = g.tileX;
            const ty = g.tileY;

            const aheadX = tx + g.dir.x;
            const aheadY = ty + g.dir.y;
            const aheadPassable = isGhostPassable(tx, ty, aheadX, aheadY);

            if (allowTurns && (!aheadPassable || isIntersection(tx, ty))) {
                const valid = getValidDirs(tx, ty, g.dir, false);
                const chosen = chooseRandom(valid) || g.dir;

                if (!sameDir(chosen, g.dir)) {
                    g.dir = { ...chosen };
                    g.nextDir = { ...chosen };
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

            // If blocked from center, stop
            const nx = g.tileX + g.dir.x;
            const ny = g.tileY + g.dir.y;
            if (!isGhostPassable(g.tileX, g.tileY, nx, ny)) {
                resetProgressAndSnap(g);
                return;
            }
        }

        const need = TILE_SIZE - g.progress;
        const step = Math.min(remaining, need);

        g.progress += step;
        remaining -= step;

        if (g.progress >= TILE_SIZE - 0.0001) {
            g.progress = 0;

            // wrap tunnels for X only (classic)
            g.tileX = wrapIndex(g.tileX + g.dir.x, COLS);
            g.tileY = clamp(g.tileY + g.dir.y, 0, ROWS - 1);

            resetProgressAndSnap(g);
            continue;
        }

        g.x = tileCenterX(g.tileX) + g.dir.x * g.progress;
        g.y = tileCenterY(g.tileY) + g.dir.y * g.progress;
    }
}

function stepGhost(g, dtSeconds, nowMs) {
    g.tileX = wrapIndex(g.tileX, COLS);
    g.tileY = clamp(g.tileY, 0, ROWS - 1);

    // Release scheduling
    if (g.state === "inHouse" && nowMs >= g.releaseAtMs) {
        g.state = "leaving";
        g.leaveTarget = pickNearestStagingTile(g);
        g.dir = { x: 0, y: -1 };
        g.nextDir = { x: 0, y: -1 };
        resetProgressAndSnap(g);
    }

    // LEAVING: deterministic routing to staging tile, then up through gate and out
    if (g.state === "leaving") {
        const house = currentGame.house;
        if (!house || house.gateY === null || house.stagingY === null || house.outsideY === null) {
            g.state = "active";
            resetProgressAndSnap(g);
            return;
        }

        // If already outside, activate
        if (g.tileY <= house.outsideY) {
            g.state = "active";
            resetProgressAndSnap(g);
            return;
        }

        // Always ensure a target staging tile exists
        if (!g.leaveTarget) g.leaveTarget = pickNearestStagingTile(g);
        if (!g.leaveTarget) {
            // No valid staging tile found: give up safely
            g.state = "active";
            resetProgressAndSnap(g);
            return;
        }

        if (g.progress === 0) {
            const targetX = g.leaveTarget.x;
            const targetY = g.leaveTarget.y; // staging row

            // If on staging tile, go UP onto the gate
            if (g.tileX === targetX && g.tileY === targetY) {
                const up = { x: 0, y: -1 };
                const ok = isGhostPassable(g.tileX, g.tileY, g.tileX, g.tileY - 1);
                if (!ok) {
                    // If the tile above isn't passable, your map encoding is inconsistent.
                    resetProgressAndSnap(g);
                    return;
                }
                g.dir = up;
                g.nextDir = up;
                resetProgressAndSnap(g);
            }
            // If on gate row, go UP again to outside
            else if (g.tileY === house.gateY) {
                const up = { x: 0, y: -1 };
                g.dir = up;
                g.nextDir = up;
                resetProgressAndSnap(g);
            }
            // Otherwise, BFS toward the staging tile (restricted to house bounds)
            else {
                const d = bfsFirstDirHouse(g.tileX, g.tileY, targetX, targetY);
                if (!d) {
                    // fallback: prefer up, else slide horizontally toward target
                    if (isGhostPassable(g.tileX, g.tileY, g.tileX, g.tileY - 1)) {
                        g.dir = { x: 0, y: -1 };
                        g.nextDir = { x: 0, y: -1 };
                    } else if (g.tileX !== targetX) {
                        const dir = { x: targetX > g.tileX ? 1 : -1, y: 0 };
                        if (isGhostPassable(g.tileX, g.tileY, g.tileX + dir.x, g.tileY)) {
                            g.dir = dir;
                            g.nextDir = dir;
                        } else {
                            resetProgressAndSnap(g);
                            return;
                        }
                    } else {
                        resetProgressAndSnap(g);
                        return;
                    }
                    resetProgressAndSnap(g);
                } else {
                    g.dir = { ...d };
                    g.nextDir = { ...d };
                    resetProgressAndSnap(g);
                }
            }
        }

        // IMPORTANT: leaving is scripted, do not allow turns.
        stepGhostTileProgress(g, dtSeconds, ghostSpeedPx(g), false);
        g.seq++;

        // Once outside, become active
        if (g.tileY <= house.outsideY) {
            g.state = "active";
            resetProgressAndSnap(g);
        }

        return;
    }

    // ACTIVE
    if (g.state === "active") {
        stepGhostTileProgress(g, dtSeconds, ghostSpeedPx(g), true);
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

        // Clamp hitch teleports
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

export function getIO() {
    if (!io) throw new Error("Socket.IO not initialized. Call initSocketServer(server) first.");
    return io;
}
