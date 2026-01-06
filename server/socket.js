// src/socket.js (DROP-IN REPLACEMENT)
// Server-authoritative ghosts: TILE-PROGRESS grid movement + Pac-Man targeting,
// PLUS a deterministic ghost-house exit rail.
//
// Debug: set env DEBUG_GHOSTS=1 to print diagnostics.

import {Server} from "socket.io";
import initializeMovement from "./helpers/movement.js";
import {waitASec} from "./helpers/timeout.js";
import {level1, level1_intersections} from "./levels/level1.js";

const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || true;

const STARTUP_MS = 4500; // match your startup sound
const DEATH_AUDIO_MS = 3000;

const TILE_SIZE = Number(process.env.TILE_SIZE || 24);
const SERVER_TICK_HZ = Number(process.env.SERVER_TICK_HZ || 20);
const GHOST_BROADCAST_HZ = Number(process.env.GHOST_BROADCAST_HZ || 20);

// If you actually want this env toggle to work, don't set it to false forever.
const DEBUG_GHOSTS = Boolean(process.env.DEBUG_GHOSTS) || false;

function gdbg(id, msg, obj) {
    if (!DEBUG_GHOSTS) return;
    if (obj !== undefined) console.log(`[GHOST ${id}] ${msg}`, obj);
    else console.log(`[GHOST ${id}] ${msg}`);
}
function dbgOnceFactory() {
    const seen = new Set();
    return (key, msg, obj) => {
        if (!DEBUG_GHOSTS) return;
        if (seen.has(key)) return;
        seen.add(key);
        if (obj !== undefined) console.log(msg, obj);
        else console.log(msg);
    };
}
const dbgOnce = dbgOnceFactory();

const MODE_SCHEDULE = [
    { mode: "scatter", ms: 7000 },
    { mode: "chase", ms: 20000 },
    { mode: "scatter", ms: 7000 },
    { mode: "chase", ms: 20000 },
];

const GHOST_TILES_PER_SEC = {
    blinky: 6.2,
    pinky: 6,
    inky: 5.5,
    clyde: 5,
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
    pinky: { tileX: 14, tileY: 14, dir: { x: 0, y: -1 } },
    inky: { tileX: 12, tileY: 14, dir: { x: 0, y: -1 } },
    clyde: { tileX: 16, tileY: 14, dir: { x: 0, y: -1 } },
};

const EATEN_RESPAWNS = {
    // When a frightened ghost is eaten, it returns to the house (box), not its round-1 spawn.
    blinky: { tileX: 14, tileY: 14, dir: { x: 0, y: -1 } },
    pinky: { tileX: 14, tileY: 14, dir: { x: 0, y: -1 } },
    inky: { tileX: 12, tileY: 14, dir: { x: 0, y: -1 } },
    clyde: { tileX: 16, tileY: 14, dir: { x: 0, y: -1 } },
};

const GHOST_EAT_WAIT_MS = 2000;
const GHOST_COLLIDE_RADIUS_PX = TILE_SIZE * 1.5; // generous “barely touched”


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

function oppositeDir(a, b) {
    return a && b && a.x === -b.x && a.y === -b.y;
}
function sameDir(a, b) {
    return a && b && a.x === b.x && a.y === b.y;
}
function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
}
function wrapIndex(n, size) {
    if (n < 0) return size - 1;
    if (n >= size) return 0;
    return n;
}

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

        ghostMode: "scatter",
        ghostModeIndex: 0,
        ghostModeEndsAtMs: 0,
        ghostsFrozenUntilMs: 0,
    };
}

let currentGame = makeEmptyGameState();
let io;

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

function tileCenterX(tileX) {
    return tileX * TILE_SIZE + TILE_SIZE / 2;
}
function tileCenterY(tileY) {
    return tileY * TILE_SIZE + TILE_SIZE / 2;
}

function resetProgressAndSnap(g) {
    g.progress = 0;
    g.x = tileCenterX(g.tileX);
    g.y = tileCenterY(g.tileY);
}

// ---- House scanning ----
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

// ---------------------------
// Ghost AI targeting
// ---------------------------
function dist2(ax, ay, bx, by) {
    const dx = ax - bx;
    const dy = ay - by;
    return dx * dx + dy * dy;
}
function wrapX(x) {
    return wrapIndex(x, COLS);
}
function clampY(y) {
    return clamp(y, 0, ROWS - 1);
}
function scatterTargetFor(ghostId) {
    switch (ghostId) {
        case "blinky": return { x: 26, y: 1 };
        case "pinky": return { x: 1, y: 1 };
        case "inky": return { x: 26, y: 30 };
        case "clyde": return { x: 1, y: 30 };
        default: return { x: 1, y: 1 };
    }
}

function normalizeDir(d) {
    if (!d) return { x: 1, y: 0 };
    if (typeof d === "string") {
        if (d.includes("Left")) return { x: -1, y: 0 };
        if (d.includes("Right")) return { x: 1, y: 0 };
        if (d.includes("Up")) return { x: 0, y: -1 };
        if (d.includes("Down")) return { x: 0, y: 1 };
    }
    if (typeof d.x === "number" && typeof d.y === "number") return { x: d.x, y: d.y };
    return { x: 1, y: 0 };
}

function getPlayerTile(p) {
    if (!p) return null;
    if (Number.isFinite(p.tileX) && Number.isFinite(p.tileY)) return { x: p.tileX, y: p.tileY };
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
        return { x: wrapX(Math.floor(p.x / TILE_SIZE)), y: clampY(Math.floor(p.y / TILE_SIZE)) };
    }
    return null;
}
function getPlayerDir(p) {
    return normalizeDir(p?.dir ?? p?.direction ?? p?.currentDir);
}

function isPlayerAlive(playerId) {
    const l = currentGame.lives.get(playerId);
    return l == null ? true : l > 0;
}

function freezeGhostsForIntro(msOrUntilMs = STARTUP_MS) {
    // If caller passes a big number (timestamp), treat it as "until"
    const now = Date.now();
    currentGame.ghostsFrozenUntilMs = msOrUntilMs > 60_000_000_000 ? msOrUntilMs : (now + msOrUntilMs);
}


function getNearestAlivePlayerTile(fromTile) {
    let best = null;
    let bestD = Infinity;

    for (const [pid, p] of currentGame.players.entries()) {
        if (!isPlayerAlive(pid)) continue;
        const t = getPlayerTile(p);
        if (!t) continue;
        const d = dist2(fromTile.x, fromTile.y, t.x, t.y);
        if (d < bestD) {
            bestD = d;
            best = { playerId: pid, tile: t, dir: getPlayerDir(p) };
        }
    }
    return best;
}

function getChaseTarget(ghostId, pacTile, pacDir) {
    if (!pacTile) return scatterTargetFor(ghostId);

    if (ghostId === "blinky") return { x: pacTile.x, y: pacTile.y };

    if (ghostId === "pinky") {
        const ahead = 4;
        return { x: wrapX(pacTile.x + pacDir.x * ahead), y: clampY(pacTile.y + pacDir.y * ahead) };
    }

    if (ghostId === "inky") {
        const blinky = currentGame.ghosts.get("blinky");
        const blTile = blinky ? { x: blinky.tileX, y: blinky.tileY } : null;

        const ahead = 2;
        const px = wrapX(pacTile.x + pacDir.x * ahead);
        const py = clampY(pacTile.y + pacDir.y * ahead);

        if (!blTile) return { x: px, y: py };

        const vx = px - blTile.x;
        const vy = py - blTile.y;
        return { x: wrapX(blTile.x + vx * 2), y: clampY(blTile.y + vy * 2) };
    }

    if (ghostId === "clyde") {
        const self = currentGame.ghosts.get("clyde");
        const sx = self?.tileX ?? 0;
        const sy = self?.tileY ?? 0;
        const d = Math.sqrt(dist2(sx, sy, pacTile.x, pacTile.y));
        if (d < 8) return scatterTargetFor("clyde");
        return { x: pacTile.x, y: pacTile.y };
    }

    return { x: pacTile.x, y: pacTile.y };
}

function chooseDirToward(tileX, tileY, currentDir, validDirs, targetTile) {
    if (!targetTile || !validDirs.length) return validDirs[0] ?? currentDir;

    let best = null;
    let bestD = Infinity;

    for (const d of validDirs) {
        const nx = wrapX(tileX + d.x);
        const ny = clampY(tileY + d.y);
        const dd = dist2(nx, ny, targetTile.x, targetTile.y);
        if (dd < bestD) {
            bestD = dd;
            best = d;
        }
    }
    return best ?? validDirs[0] ?? currentDir;
}

function chooseRandom(validDirs) {
    if (!validDirs.length) return null;
    const r = currentGame.rand ? currentGame.rand() : Math.random();
    return validDirs[Math.floor(r * validDirs.length)];
}

// -----------------------------------------
// Ghost-vs-player collision (server-authoritative for frightened eats)
// -----------------------------------------
function getPlayerPosPx(p) {
    if (!p) return null;
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) return { x: p.x, y: p.y };
    if (Number.isFinite(p.tileX) && Number.isFinite(p.tileY)) {
        return { x: tileCenterX(p.tileX), y: tileCenterY(p.tileY) };
    }
    return null;
}

function sendGhostHomeAndWait(g, nowMs) {
    const r = EATEN_RESPAWNS[g.ghostId] ?? EATEN_RESPAWNS.pinky;

    g.tileX = r.tileX;
    g.tileY = r.tileY;
    g.dir = { ...r.dir };
    g.nextDir = { ...r.dir };

    // Back into the house, then re-release after a short wait.
    g.state = "inHouse";
    g.releaseAtMs = nowMs + GHOST_EAT_WAIT_MS;

    // Clear frightened immediately.
    g.frightenedUntilMs = 0;
    g.baseMode = currentGame.ghostMode;
    g.mode = currentGame.ghostMode;

    resetProgressAndSnap(g);

    gdbg(g.ghostId, "EATEN -> back to house", {
        respawn: { x: g.tileX, y: g.tileY },
        releaseAtMs: g.releaseAtMs,
        nowMs,
    });
}

function handleFrightenedGhostEats(nowMs) {
    // Fast path: no frightened active ghosts
    let anyFrightened = false;

    for (const g of currentGame.ghosts.values()) {
        if (g.state === "active" && g.mode === "frightened") {
            anyFrightened = true;
            break;
        }
    }
    if (!anyFrightened) return false;

    for (const [pid, p] of currentGame.players.entries()) {
        if (!isPlayerAlive(pid)) continue;

        const pp = getPlayerPosPx(p);
        if (!pp) continue;

        for (const g of currentGame.ghosts.values()) {
            if (g.state !== "active") continue;
            if (g.mode !== "frightened") continue;

            const d = Math.hypot(pp.x - g.x, pp.y - g.y);
            if (d <= GHOST_COLLIDE_RADIUS_PX) {
                sendGhostHomeAndWait(g, nowMs);

                // Optional event for SFX/score; safe if clients ignore
                io?.emit?.("GhostEaten", { ghostId: g.ghostId, byPlayerId: pid });

                return true; // do at most one per tick to avoid double-eats
            }
        }
    }

    return false;
}

// Walls + gate rules
const WALLS = new Set(["═", "║", "╔", "╗", "╚", "╝", "┌", "┐", "└", "┘", "|", "-"]);

function isGhostPassable(fromX, fromY, toX, toY) {
    if (toY < 0 || toY >= ROWS) return false;
    if (toX < 0) toX = COLS - 1;
    if (toX >= COLS) toX = 0;

    const tile = level1[toY]?.[toX];
    if (!tile) return false;
    if (WALLS.has(tile)) return false;

    if (tile === "~") {
        if (fromX === toX && fromY === toY) return true;
        return fromY > toY; // only UP across gate
    }

    return true;
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
 * Pac-Man-accurate immediate reversal:
 * - If ghost is mid-tile, we "transfer" it to the tile it's moving toward, flip dir,
 *   and set progress = TILE_SIZE - progress so its world position stays the same.
 * - Only makes sense for ACTIVE ghosts.
 */
function reverseGhostNow(g) {
    if (!g?.dir) return;

    const oldDir = g.dir;
    const newDir = { x: -oldDir.x, y: -oldDir.y };

    // If centered, easy.
    if (!g.progress || g.progress === 0) {
        g.dir = newDir;
        g.nextDir = { ...newDir };
        resetProgressAndSnap(g); // keeps it clean at center
        return;
    }

    // Mid-tile: keep world position, flip dir, but shift tile coords to the tile we were moving toward.
    const aheadX = wrapIndex(g.tileX + oldDir.x, COLS);
    const aheadY = clamp(g.tileY + oldDir.y, 0, ROWS - 1);

    // This should always be passable because we are literally already traveling into it,
    // but guard anyway to avoid teleporting into walls if something got desynced.
    if (!isGhostPassable(g.tileX, g.tileY, aheadX, aheadY)) {
        gdbg(g.ghostId, "reverseGhostNow blocked (ahead not passable), snapping", {
            tile: { x: g.tileX, y: g.tileY },
            dir: oldDir,
            ahead: { x: aheadX, y: aheadY },
        });
        g.dir = newDir;
        g.nextDir = { ...newDir };
        resetProgressAndSnap(g);
        return;
    }

    // Keep x/y exactly where they are (that’s the whole point), but rebase tile/progress.
    const oldProgress = g.progress;
    g.tileX = aheadX;
    g.tileY = aheadY;
    g.dir = newDir;
    g.nextDir = { ...newDir };
    g.progress = TILE_SIZE - oldProgress;

    // And recompute x/y from the new base to eliminate floating drift:
    g.x = tileCenterX(g.tileX) + g.dir.x * g.progress;
    g.y = tileCenterY(g.tileY) + g.dir.y * g.progress;
}

function resetGhostModeSchedule(nowMs) {
    currentGame.ghostModeIndex = 0;
    currentGame.ghostMode = MODE_SCHEDULE[0]?.mode ?? "scatter";
    currentGame.ghostModeEndsAtMs = nowMs + (MODE_SCHEDULE[0]?.ms ?? 7000);
}

function advanceGhostModeIfNeeded(nowMs) {
    if (!currentGame.ghostModeEndsAtMs) return;
    if (nowMs < currentGame.ghostModeEndsAtMs) return;

    currentGame.ghostModeIndex = (currentGame.ghostModeIndex + 1) % MODE_SCHEDULE.length;
    const phase = MODE_SCHEDULE[currentGame.ghostModeIndex];
    currentGame.ghostMode = phase?.mode ?? "scatter";
    currentGame.ghostModeEndsAtMs = nowMs + (phase?.ms ?? 7000);
}

// ---- Deterministic ghost-house exit ----
function getLeftMostDoorTile() {
    const doors = currentGame.house?.doorTiles ?? [];
    if (!doors.length) return null;
    return doors.slice().sort((a, b) => a.x - b.x)[0];
}

function forceGhostToDoorAndUp(g) {
    const door = getLeftMostDoorTile();
    const exit = currentGame.house?.exitTile;

    if (!door || !exit) {
        gdbg(g.ghostId, "FORCE EXIT FAILED (missing door/exit)", { door, exit });
        return false;
    }

    // Put ghost ON the gate tile, then we'll move one tile up to exitTile
    g.tileX = door.x;
    g.tileY = door.y;
    g.dir = { x: 0, y: -1 };
    g.nextDir = { x: 0, y: -1 };
    resetProgressAndSnap(g);

    gdbg(g.ghostId, "FORCED TO DOOR", {
        door,
        exit,
        hereChar: level1[g.tileY]?.[g.tileX],
        upChar: level1[g.tileY - 1]?.[g.tileX],
        canUp: isGhostPassable(g.tileX, g.tileY, g.tileX, g.tileY - 1),
    });

    return true;
}

// ---- Ghost init ----
function initGhosts(nowMs) {
    currentGame.house = computeHouseInfoFromLevel();
    dbgOnce("houseInfo", "[HOUSE] computed", {
        doorTiles: currentGame.house?.doorTiles,
        exitTile: currentGame.house?.exitTile,
        inHouseMinY: currentGame.house?.inHouseMinY,
        inHouseMaxY: currentGame.house?.inHouseMaxY,
        doorTileChars: currentGame.house?.doorTiles?.map((t) => level1[t.y]?.[t.x]),
        exitTileChar: currentGame.house?.exitTile
            ? level1[currentGame.house.exitTile.y]?.[currentGame.house.exitTile.x]
            : null,
    });

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
            mode: currentGame.ghostMode,
            baseMode: currentGame.ghostMode,

            releaseAtMs: releaseAt,

            frightenedUntilMs: 0,
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
        frightenedUntilMs: g.frightenedUntilMs,
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

// -----------------------------------------
// Tile-progress mover (with allowTurns flag)
// -----------------------------------------
function stepGhostTileProgress(g, dtSeconds, speedPx, opts = { allowTurns: true }) {
    let remaining = speedPx * dtSeconds;

    if (!g.dir || (g.dir.x === 0 && g.dir.y === 0)) {
        g.dir = { x: -1, y: 0 };
        g.nextDir = { ...g.dir };
        resetProgressAndSnap(g);
    }

    while (remaining > 0.0001) {
        // Decide turns at centers only (if allowed)
        if (g.progress === 0 && opts.allowTurns) {
            const tx = g.tileX;
            const ty = g.tileY;

            const aheadX = tx + g.dir.x;
            const aheadY = ty + g.dir.y;
            const aheadPassable = isGhostPassable(tx, ty, aheadX, aheadY);

            if (!aheadPassable || isIntersection(tx, ty)) {
                const allowReverse = false;
                const valid = getValidDirs(tx, ty, g.dir, allowReverse);

                let chosen = null;

                if (g.state === "active") {
                    const pac = getNearestAlivePlayerTile({ x: tx, y: ty });

                    if (g.mode === "frightened" || !pac) {
                        chosen = chooseRandom(valid);
                    } else {
                        const baseMode = currentGame.ghostMode;
                        const target =
                            baseMode === "scatter"
                                ? scatterTargetFor(g.ghostId)
                                : getChaseTarget(g.ghostId, pac.tile, pac.dir);

                        chosen = chooseDirToward(tx, ty, g.dir, valid, target);
                    }
                }

                chosen = chosen || chooseRandom(valid) || g.dir;

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
        }

        // Center-block check
        if (g.progress === 0) {
            const nx = g.tileX + g.dir.x;
            const ny = g.tileY + g.dir.y;
            if (!isGhostPassable(g.tileX, g.tileY, nx, ny)) {
                if (DEBUG_GHOSTS) {
                    console.log(`[BLOCKED ${g.ghostId}] cannot advance`, {
                        state: g.state,
                        tile: { x: g.tileX, y: g.tileY },
                        dir: g.dir,
                        next: { x: nx, y: ny },
                        hereChar: level1[g.tileY]?.[g.tileX],
                        nextChar: level1[ny]?.[wrapIndex(nx, COLS)],
                    });
                }
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
            g.tileX = wrapIndex(g.tileX + g.dir.x, COLS);
            g.tileY = clamp(g.tileY + g.dir.y, 0, ROWS - 1);
            resetProgressAndSnap(g);
            continue;
        }

        g.x = tileCenterX(g.tileX) + g.dir.x * g.progress;
        g.y = tileCenterY(g.tileY) + g.dir.y * g.progress;
    }
}

// ---- Ghost step ----
function stepGhost(g, dtSeconds, nowMs) {
    // Global ghost freeze (round start / death wipe intro)
    if (nowMs < currentGame.ghostsFrozenUntilMs) {
        // Keep ghosts snapped to tile centers, but DO NOT MOVE
        if (g.progress !== 0) {
            resetProgressAndSnap(g);
        }
        return;
    }

    advanceGhostModeIfNeeded(nowMs);

    // frightened expiry
    if (g.mode === "frightened" && g.frightenedUntilMs && nowMs >= g.frightenedUntilMs) {
        g.mode = currentGame.ghostMode;
        g.baseMode = currentGame.ghostMode;
        g.frightenedUntilMs = 0;
    }

    // schedule sync if not frightened
    if (g.mode !== "frightened") {
        // IMPORTANT: real Pac-Man reverses immediately on mode switch (active ghosts only)
        if (g.state === "active" && g.baseMode && g.baseMode !== currentGame.ghostMode) {
            reverseGhostNow(g);
        }
        g.baseMode = currentGame.ghostMode;
        g.mode = currentGame.ghostMode;
    }

    g.tileX = wrapIndex(g.tileX, COLS);
    g.tileY = clamp(g.tileY, 0, ROWS - 1);

    // Release scheduling
    if (g.state === "inHouse" && nowMs >= g.releaseAtMs) {
        gdbg(g.ghostId, "RELEASE -> leaving", {
            nowMs,
            releaseAtMs: g.releaseAtMs,
            tile: { x: g.tileX, y: g.tileY },
            dir: g.dir,
        });

        g.state = "leaving";
        const ok = forceGhostToDoorAndUp(g);
        if (!ok) {
            g.dir = { x: 0, y: -1 };
            g.nextDir = { x: 0, y: -1 };
            resetProgressAndSnap(g);
        }
    }

    // LEAVING: move ONE TILE up to exitTile, then immediately become active
    if (g.state === "leaving") {
        const exit = currentGame.house?.exitTile;

        // If we're already in the corridor tile (exitTile), stop leaving BEFORE trying to go further up.
        if (exit && g.tileX === exit.x && g.tileY === exit.y) {
            gdbg(g.ghostId, "LEAVING -> ACTIVE (at exitTile)", { tile: { x: g.tileX, y: g.tileY }, exit });

            g.state = "active";
            resetProgressAndSnap(g);

            // IMPORTANT: do NOT continue forcing UP this tick.
            return;
        }

        // Force UP while below exitTile (door -> corridor).
        if (g.progress === 0) {
            g.dir = { x: 0, y: -1 };
            g.nextDir = { x: 0, y: -1 };

            if (DEBUG_GHOSTS) {
                gdbg(g.ghostId, "LEAVING center", {
                    tile: { x: g.tileX, y: g.tileY },
                    exitTile: exit,
                    hereChar: level1[g.tileY]?.[g.tileX],
                    upChar: level1[g.tileY - 1]?.[g.tileX],
                    canUp: isGhostPassable(g.tileX, g.tileY, g.tileX, g.tileY - 1),
                });
            }
        }

        // While leaving we DO NOT allow turns; we just go up one tile into the corridor.
        stepGhostTileProgress(g, dtSeconds, ghostSpeedPx(g), { allowTurns: false });
        g.seq++;

        return;
    }

    // ACTIVE: full AI turning
    if (g.state === "active") {
        stepGhostTileProgress(g, dtSeconds, ghostSpeedPx(g), { allowTurns: true });
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

        dtSeconds = Math.min(dtSeconds, 0.05);

        for (const g of currentGame.ghosts.values()) {
            stepGhost(g, dtSeconds, now);
        }

        // If a frightened ghost was eaten, force a snapshot so clients see the teleport immediately.
        const ate = handleFrightenedGhostEats(now);
        broadcastGhostSnapshot(ate);
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

function resetRoundStateKeepPlayers(baseNowMs = Date.now()) {
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

    resetGhostModeSchedule(baseNowMs);
    initGhosts(baseNowMs);
    broadcastGhostSnapshot(true);
}


function endRoundFromServer(extraDelayMs = 0) {
    const respawn = [];
    for (const [pid] of currentGame.players) {
        const l = currentGame.lives.get(pid) ?? 0;
        if (l > 0) {
            respawn.push(pid);
            currentGame.players.get(pid).alive = true;
        }
    }

    const clearedBoard = (currentGame.dotsRemaining ?? 0) <= 0;
    if (clearedBoard) {
        currentGame.round += 1;
        currentGame.dotsRemaining = 244;
    }

    // IMPORTANT: startAtMs includes death audio delay + normal startup delay
    const startAtMs = Date.now() + extraDelayMs + STARTUP_MS;

    resetGhostModeSchedule(startAtMs);
    initGhosts(startAtMs);
    freezeGhostsForIntro(startAtMs);
    broadcastGhostSnapshot(true);

    io.emit("RoundEnded", {
        respawn,
        round: currentGame.round,
        startAtMs,
        startupMs: STARTUP_MS,
    });
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
                alive: true
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

            const startAtMs = Date.now() + STARTUP_MS;

            io.emit("startGame", { startAtMs, startupMs: STARTUP_MS });

            resetRoundStateKeepPlayers(startAtMs);
            freezeGhostsForIntro(startAtMs);

            await waitASec(STARTUP_MS);

            currentGame.gameRunning = true;
            startServerTickLoop();
            broadcastGhostSnapshot(true);
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
                x,
                y,
                type,
                eaterPlayerId: eaterId,
                newScore,
                scores: Object.fromEntries(currentGame.scores.entries()),
                seq: seq ?? 0,
            });

            if (isPower) {
                const now = Date.now();
                io.emit("FrightenedStart", { untilMs: now + 7000, durationMs: 7000 });

                for (const g of currentGame.ghosts.values()) {
                    // Only ghosts that are out on the map get frightened
                    if (g.state !== "active") continue; // skips inHouse + leaving

                    g.mode = "frightened";
                    g.frightenedUntilMs = now + 7000;

                    // Real Pac-Man: reverse immediately on frightened start (even mid-tile)
                    reverseGhostNow(g);
                }

                broadcastGhostSnapshot(true);
            }
            if(currentGame.dotsRemaining <= 0) endRoundFromServer();
        });

        socket.on("PlayerDied", ({ victimPlayerId }) => {
            if (!victimPlayerId) return;
            if (!currentGame.players.has(victimPlayerId)) return;

            const curLives = currentGame.lives.get(victimPlayerId) ?? 3;
            if (curLives <= 0) return;

            const nextLives = curLives - 1;
            currentGame.lives.set(victimPlayerId, nextLives);
            currentGame.deaths.set(victimPlayerId, (currentGame.deaths.get(victimPlayerId) ?? 0) + 1);
            currentGame.players.get(victimPlayerId).alive = false;
            console.log('DIED', currentGame)

            let allDead = true;

            for (const { alive } of currentGame.players.values()) {
                if (alive) {
                    allDead = false;
                    break;
                }
            }

            io.emit("LivesUpdate", {
                playerId: victimPlayerId,
                lives: Object.fromEntries(currentGame.lives.entries()),
                eliminated: nextLives <= 0,
            });

            const allEliminated = Array.from(currentGame.players.keys()).every(
                (pId) => (currentGame.lives.get(pId) ?? 0) <= 0
            );
            if (allEliminated) backToLobby("all_eliminated");
            else if(allDead) endRoundFromServer()
        });

        socket.on("RoundEnded", () => {
            endRoundFromServer()
        });

        socket.on("GhostSnapshotRequest", () => {
            broadcastGhostSnapshot(true);
        });

        socket.on("dumpGhostDebug", () => {
            if (!DEBUG_GHOSTS) return;
            console.log("[DUMP] house:", currentGame.house);
            for (const g of currentGame.ghosts.values()) {
                console.log("[DUMP] ghost:", {
                    id: g.ghostId,
                    state: g.state,
                    tileX: g.tileX,
                    tileY: g.tileY,
                    dir: g.dir,
                    progress: g.progress,
                    releaseAtMs: g.releaseAtMs,
                    now: Date.now(),
                    hereChar: level1[g.tileY]?.[g.tileX],
                });
            }
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
