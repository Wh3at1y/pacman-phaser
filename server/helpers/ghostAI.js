// src/helpers/ghostAI.js
// Classic Pac-Man-ish ghost targeting + mode schedule helpers.
// Server authoritative: ghosts pick a TARGET TILE at decision points, then pick direction by distance.
// Tie-break order: UP, LEFT, DOWN, RIGHT (classic feel).

const DIR_UP = { x: 0, y: -1 };
const DIR_LEFT = { x: -1, y: 0 };
const DIR_DOWN = { x: 0, y: 1 };
const DIR_RIGHT = { x: 1, y: 0 };

export const DIR_TIEBREAK = [DIR_UP, DIR_LEFT, DIR_DOWN, DIR_RIGHT];

export function sameDir(a, b) {
    return !!a && !!b && a.x === b.x && a.y === b.y;
}

export function oppositeDir(a, b) {
    return !!a && !!b && a.x === -b.x && a.y === -b.y;
}

export function manhattan(ax, ay, bx, by) {
    return Math.abs(ax - bx) + Math.abs(ay - by);
}

export function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
}

export function wrapIndex(n, size) {
    if (n < 0) return size - 1;
    if (n >= size) return 0;
    return n;
}

export function dist2(ax, ay, bx, by) {
    const dx = ax - bx;
    const dy = ay - by;
    return dx * dx + dy * dy;
}

export function dirFromVec(vec) {
    // vec is {x,y} unit-ish
    return vec;
}

export function addTile(tx, ty, dir, n = 1) {
    return { x: tx + dir.x * n, y: ty + dir.y * n };
}

export function getClosestLivingPlayerState(game) {
    // game.playerStates: Map(playerId => {tileX,tileY,dir,...})
    // game.lives: Map(playerId => lives)
    let best = null;
    for (const [pid, ps] of game.playerStates.entries()) {
        const lives = game.lives.get(pid) ?? 0;
        if (lives <= 0) continue;
        if (!ps || typeof ps.tileX !== "number" || typeof ps.tileY !== "number") continue;
        if (!best) best = { pid, ps };
        else {
            // not choosing "closest" here; caller may decide. This is just a utility.
        }
    }
    return best;
}

export function pickTargetPlayerForGhost(game, ghostTileX, ghostTileY) {
    // Multiplayer choice: target the nearest living Pac-Man by tile distance.
    let best = null;
    let bestD2 = Infinity;

    for (const [pid, ps] of game.playerStates.entries()) {
        const lives = game.lives.get(pid) ?? 0;
        if (lives <= 0) continue;
        if (!ps) continue;
        const d2 = dist2(ghostTileX, ghostTileY, ps.tileX, ps.tileY);
        if (d2 < bestD2) {
            bestD2 = d2;
            best = { pid, ps };
        }
    }
    return best; // {pid, ps} or null
}

export function computeChaseTarget(ghostId, ghost, game, cols, rows) {
    const pick = pickTargetPlayerForGhost(game, ghost.tileX, ghost.tileY);
    if (!pick) return { x: ghost.tileX, y: ghost.tileY }; // nothing to chase

    const pac = pick.ps;

    // Default scatter corners (you can tune for your map):
    const corners = {
        // Based on your level1.js actual passable corner tiles
        blinky: { x: 26, y: 1 }, // top-right
        pinky:  { x: 1,  y: 1 }, // top-left
        inky:   { x: 26, y: 29 }, // bottom-right
        clyde:  { x: 1,  y: 29 }, // bottom-left
    };

    // Normalize pac.dir (fallback if missing)
    const pacDir = pac.dir && (pac.dir.x || pac.dir.y) ? pac.dir : DIR_LEFT;

    if (ghost.mode === "scatter") return corners[ghostId] ?? corners.blinky;
    if (ghost.mode === "frightened") return corners[ghostId] ?? corners.blinky; // target ignored anyway (random-ish)
    // CHASE:
    if (ghostId === "blinky") {
        // Shadow: direct chase
        return { x: pac.tileX, y: pac.tileY };
    }

    if (ghostId === "pinky") {
        // Speedy: 4 tiles ahead
        const ahead = addTile(pac.tileX, pac.tileY, pacDir, 4);

        // Optional classic bug (UP adds extra left). Comment out if you hate authenticity.
        // if (pacDir.x === 0 && pacDir.y === -1) ahead.x -= 4;

        return { x: ahead.x, y: ahead.y };
    }

    if (ghostId === "inky") {
        // Bashful: vector from Blinky to 2 tiles ahead of Pac-Man, doubled
        const blinky = game.ghosts.get("blinky");
        if (!blinky) return { x: pac.tileX, y: pac.tileY };

        const p2 = addTile(pac.tileX, pac.tileY, pacDir, 2);
        const vx = p2.x - blinky.tileX;
        const vy = p2.y - blinky.tileY;
        return { x: blinky.tileX + 2 * vx, y: blinky.tileY + 2 * vy };
    }

    if (ghostId === "clyde") {
        // Pokey: if far, chase; if near (< 8 tiles), scatter corner
        const d = manhattan(ghost.tileX, ghost.tileY, pac.tileX, pac.tileY);
        if (d >= 8) return { x: pac.tileX, y: pac.tileY };
        return corners.clyde;
    }

    return { x: pac.tileX, y: pac.tileY };
}

export function chooseDirTowardTarget({
                                          ghost,
                                          target,
                                          isPassable,
                                          isIntersection,
                                          cols,
                                          rows,
                                          allowReverse = false,
                                          frightened = false,
                                          rand = Math.random,
                                      }) {
    const tx = ghost.tileX;
    const ty = ghost.tileY;

    // Build valid dirs in classic tie-break order
    const valid = [];
    for (const d of DIR_TIEBREAK) {
        if (!allowReverse && oppositeDir(d, ghost.dir)) continue;
        const nx = tx + d.x;
        const ny = ty + d.y;
        if (isPassable(tx, ty, nx, ny)) valid.push(d);
    }

    if (!allowReverse && valid.length === 0) {
        // Forced reverse
        return chooseDirTowardTarget({
            ghost,
            target,
            isPassable,
            isIntersection,
            cols,
            rows,
            allowReverse: true,
            frightened,
            rand,
        });
    }

    if (valid.length === 0) return ghost.dir;

    if (frightened) {
        // Frightened = pseudo-random choice among valid
        const r = rand();
        return valid[Math.floor(r * valid.length)];
    }

    // Choose direction that minimizes distance from NEXT tile to target
    let best = valid[0];
    let bestD2 = Infinity;

    for (const d of valid) {
        const nx = wrapIndex(tx + d.x, cols);
        const ny = clamp(ty + d.y, 0, rows - 1);
        const d2 = dist2(nx, ny, target.x, target.y);
        if (d2 < bestD2) {
            bestD2 = d2;
            best = d;
        }
    }

    return best;
}

export function createModeController(nowMs) {
    // You can tune these durations to match “classic-ish” feel
    const phases = [
        { mode: "scatter", ms: 7000 },
        { mode: "chase", ms: 20000 },
        { mode: "scatter", ms: 7000 },
        { mode: "chase", ms: 20000 },
        { mode: "scatter", ms: 5000 },
        { mode: "chase", ms: 20000 },
        { mode: "scatter", ms: 5000 },
        { mode: "chase", ms: 9999999 }, // basically forever
    ];

    return {
        phases,
        index: 0,
        globalMode: phases[0].mode,
        nextSwitchMs: nowMs + phases[0].ms,

        step(now) {
            if (now < this.nextSwitchMs) return { switched: false, mode: this.globalMode };
            this.index = Math.min(this.index + 1, this.phases.length - 1);
            this.globalMode = this.phases[this.index].mode;
            this.nextSwitchMs = now + this.phases[this.index].ms;
            return { switched: true, mode: this.globalMode };
        },
    };
}
