// server/helpers/GhostSim.js

const DIRS = [
    { x: 0, y: -1, name: "UP" },
    { x: -1, y: 0, name: "LEFT" },
    { x: 0, y: 1, name: "DOWN" },
    { x: 1, y: 0, name: "RIGHT" },
];

function oppositeDir(a, b) {
    return a && b && a.x === -b.x && a.y === -b.y;
}

function dist2(ax, ay, bx, by) {
    const dx = ax - bx;
    const dy = ay - by;
    return dx * dx + dy * dy;
}

export default class GhostSim {
    constructor(world, opts) {
        this.world = world;

        // IMPORTANT: names must match old logic ("blinky","pinky","inky","clyde")
        this.name = opts.name;

        this.baseSpeed = opts.speed ?? 80;
        this.speed = this.baseSpeed;

        this.scatterTarget = opts.scatterTarget ?? { x: 1, y: 1 };

        this.tileX = opts.startTile?.x ?? 14;
        this.tileY = opts.startTile?.y ?? 11;
        this.startTile = { x: this.tileX, y: this.tileY };

        const TS = this.world.TILE_SIZE;
        this.x = this.tileX * TS + TS / 2;
        this.y = this.tileY * TS + TS / 2;

        this.dir = opts.startDir ?? { x: 1, y: 0 };

        this.mode = "scatter";        // "scatter" | "chase"
        this.frightenedUntil = 0;

        // Keep your state machine fields even if you disable house behavior initially
        this.state = "active";        // "inHouse" | "leaving" | "active"
        this.releaseAt = 0;
        this.house = {
            enabled: false,
            doorTiles: [],
            exitTile: null,
            inHouseMinY: null,
            inHouseMaxY: null,
            releaseDelayMs: 0,
        };
    }

    configureHouse(cfg) {
        this.house.enabled = true;
        this.house.doorTiles = cfg.doorTiles ?? [];
        this.house.exitTile = cfg.exitTile ?? null;
        this.house.inHouseMinY = cfg.inHouseMinY ?? null;
        this.house.inHouseMaxY = cfg.inHouseMaxY ?? null;
        this.house.releaseDelayMs = cfg.releaseDelayMs ?? 0;
    }

    reset(nowMs) {
        this.tileX = this.startTile.x;
        this.tileY = this.startTile.y;

        const TS = this.world.TILE_SIZE;
        this.x = this.tileX * TS + TS / 2;
        this.y = this.tileY * TS + TS / 2;

        this.dir = { x: 1, y: 0 };

        this.frightenedUntil = 0;

        if (this.house.enabled && this.world.isGhostHouseTile?.(this.tileX, this.tileY)) {
            this.state = "inHouse";
            this.releaseAt = nowMs + (this.house.releaseDelayMs ?? 0);
        } else {
            this.state = "active";
            this.releaseAt = 0;
        }
    }

    setMode(mode) {
        if (mode === "scatter" || mode === "chase") this.mode = mode;
    }

    setFrightened(nowMs, durationMs = 7000) {
        this.frightenedUntil = nowMs + durationMs;
    }

    isFrightened(nowMs) {
        return nowMs < this.frightenedUntil;
    }

    wrapXTile(x) {
        const cols = this.world.levelCols;
        if (x < 0) return cols - 1;
        if (x >= cols) return 0;
        return x;
    }

    wrapXPixel() {
        const TS = this.world.TILE_SIZE;
        const mapW = this.world.levelCols * TS;
        if (this.x < -TS / 2) this.x = mapW + TS / 2;
        else if (this.x > mapW + TS / 2) this.x = -TS / 2;
    }

    canStep(fromX, fromY, toX, toY) {
        return this.world.isGhostPassable(fromX, fromY, toX, toY);
    }

    atTileCenter() {
        const TS = this.world.TILE_SIZE;
        const cx = this.tileX * TS + TS / 2;
        const cy = this.tileY * TS + TS / 2;
        return Math.abs(this.x - cx) < 0.75 && Math.abs(this.y - cy) < 0.75;
    }

    snapToCenter() {
        const TS = this.world.TILE_SIZE;
        this.x = this.tileX * TS + TS / 2;
        this.y = this.tileY * TS + TS / 2;
    }

    getChaseTarget(pacTile, pacDir) {
        const cols = this.world.levelCols;
        const rows = this.world.levelRows;

        const clampY = (y) => Math.max(0, Math.min(rows - 1, y));
        const wrapX = (x) => {
            if (x < 0) return cols - 1;
            if (x >= cols) return 0;
            return x;
        };

        if (!pacDir) pacDir = { x: 1, y: 0 };

        // matches your old Ghost.js logic :contentReference[oaicite:7]{index=7}
        if (this.name === "pinky") {
            const ahead = 4;
            return {
                x: wrapX(pacTile.x + pacDir.x * ahead),
                y: clampY(pacTile.y + pacDir.y * ahead),
            };
        }

        if (this.name === "inky") {
            const ahead = 2;
            const p2 = {
                x: wrapX(pacTile.x + pacDir.x * ahead),
                y: clampY(pacTile.y + pacDir.y * ahead),
            };

            const blinky = this.world.getGhost?.("blinky");
            if (!blinky) return p2;

            const vx = p2.x - blinky.tileX;
            const vy = p2.y - blinky.tileY;
            return {
                x: wrapX(blinky.tileX + vx * 2),
                y: clampY(blinky.tileY + vy * 2),
            };
        }

        if (this.name === "clyde") {
            const d = Math.sqrt(dist2(this.tileX, this.tileY, pacTile.x, pacTile.y));
            if (d >= 8) return { x: pacTile.x, y: pacTile.y };
            return { ...this.scatterTarget };
        }

        return { x: pacTile.x, y: pacTile.y }; // blinky
    }

    chooseDirToward(targetTile, allowReverse = false) {
        const fromX = this.tileX;
        const fromY = this.tileY;

        const candidates = [];
        for (const d of DIRS) {
            const toX = this.wrapXTile(fromX + d.x);
            const toY = fromY + d.y;
            if (toY < 0 || toY >= this.world.levelRows) continue;
            if (!this.canStep(fromX, fromY, toX, toY)) continue;
            candidates.push(d);
        }

        let usable = candidates;
        if (!allowReverse && candidates.length > 1) {
            usable = candidates.filter((d) => !oppositeDir(d, this.dir));
            if (usable.length === 0) usable = candidates;
        }

        let best = null;
        let bestScore = Infinity;

        for (const d of usable) {
            const nx = this.wrapXTile(fromX + d.x);
            const ny = fromY + d.y;
            const score = dist2(nx, ny, targetTile.x, targetTile.y);
            if (score < bestScore) {
                bestScore = score;
                best = d;
            }
        }
        return best ?? this.dir;
    }

    chooseDirAwayFrom(pacTile) {
        const fromX = this.tileX;
        const fromY = this.tileY;

        const candidates = [];
        for (const d of DIRS) {
            const toX = this.wrapXTile(fromX + d.x);
            const toY = fromY + d.y;
            if (toY < 0 || toY >= this.world.levelRows) continue;
            if (!this.canStep(fromX, fromY, toX, toY)) continue;
            candidates.push(d);
        }

        let usable = candidates;
        if (candidates.length > 1) {
            usable = candidates.filter((d) => !oppositeDir(d, this.dir));
            if (usable.length === 0) usable = candidates;
        }

        let best = null;
        let bestScore = -Infinity;

        for (const d of usable) {
            const nx = this.wrapXTile(fromX + d.x);
            const ny = fromY + d.y;
            const score = dist2(nx, ny, pacTile.x, pacTile.y);
            if (score > bestScore) {
                bestScore = score;
                best = d;
            }
        }
        return best ?? this.dir;
    }

    updateHouseState(nowMs) {
        if (!this.house.enabled) return;

        if (this.state === "inHouse") {
            if (nowMs >= this.releaseAt) {
                this.state = "leaving";
                return;
            }

            if (this.atTileCenter()) {
                this.snapToCenter();

                const minY = this.house.inHouseMinY ?? this.tileY;
                const maxY = this.house.inHouseMaxY ?? this.tileY;

                if (this.dir.y === -1 && this.tileY <= minY) this.dir = { x: 0, y: 1 };
                else if (this.dir.y === 1 && this.tileY >= maxY) this.dir = { x: 0, y: -1 };
                else if (this.dir.y === 0) this.dir = { x: 0, y: -1 };

                const nextTX = this.wrapXTile(this.tileX + this.dir.x);
                const nextTY = this.tileY + this.dir.y;
                if (nextTY < 0 || nextTY >= this.world.levelRows) return;

                if (!this.canStep(this.tileX, this.tileY, nextTX, nextTY)) {
                    this.dir = { x: 0, y: -this.dir.y };
                }

                const nTX = this.wrapXTile(this.tileX + this.dir.x);
                const nTY = this.tileY + this.dir.y;
                if (this.canStep(this.tileX, this.tileY, nTX, nTY)) {
                    this.tileX = nTX;
                    this.tileY = nTY;
                }
            }
            return;
        }

        if (this.state === "leaving") {
            const door = this.house.doorTiles?.[0] ?? null;
            const exit = this.house.exitTile;

            if (!door || !exit) {
                this.state = "active";
                return;
            }

            if (this.atTileCenter()) {
                this.snapToCenter();

                if (this.tileX === door.x && this.tileY === door.y) {
                    this.dir = { x: 0, y: -1 }; // force up through gate
                } else {
                    this.dir = this.chooseDirToward(door, true); // allow reverse while leaving
                }

                const nextTX = this.wrapXTile(this.tileX + this.dir.x);
                const nextTY = this.tileY + this.dir.y;
                if (nextTY < 0 || nextTY >= this.world.levelRows) return;
                if (!this.canStep(this.tileX, this.tileY, nextTX, nextTY)) return;

                this.tileX = nextTX;
                this.tileY = nextTY;

                if (this.tileY <= exit.y) this.state = "active";
            }
            return;
        }
    }

    update(deltaMs, pacTile, pacDir, nowMs) {
        // same structure as old update() :contentReference[oaicite:8]{index=8}
        this.updateHouseState(nowMs);

        const TS = this.world.TILE_SIZE;
        const curSpeed = this.isFrightened(nowMs) ? (this.baseSpeed * 0.6) : this.baseSpeed;
        let remaining = (curSpeed * deltaMs) / 1000;
        const maxStep = TS / 4;

        while (remaining > 0) {
            const step = Math.min(maxStep, remaining);

            if (this.state === "active" && this.atTileCenter()) {
                this.snapToCenter();

                if (this.isFrightened(nowMs)) {
                    this.dir = this.chooseDirAwayFrom(pacTile);
                } else {
                    const target = (this.mode === "scatter")
                        ? this.scatterTarget
                        : this.getChaseTarget(pacTile, pacDir);
                    this.dir = this.chooseDirToward(target);
                }

                const nextTX = this.wrapXTile(this.tileX + this.dir.x);
                const nextTY = this.tileY + this.dir.y;
                if (nextTY < 0 || nextTY >= this.world.levelRows) break;
                if (!this.canStep(this.tileX, this.tileY, nextTX, nextTY)) break;

                this.tileX = nextTX;
                this.tileY = nextTY;
            }

            this.x += this.dir.x * step;
            this.y += this.dir.y * step;
            this.wrapXPixel();

            remaining -= step;
        }
    }

    snapshot() {
        return {
            name: this.name,
            x: this.x,
            y: this.y,
            tileX: this.tileX,
            tileY: this.tileY,
            dir: { x: this.dir.x, y: this.dir.y },
            mode: this.mode,
            state: this.state,
            frightenedUntil: this.frightenedUntil,
        };
    }
}
