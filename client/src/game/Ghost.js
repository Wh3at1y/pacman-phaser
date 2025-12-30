// Ghost.js
import Phaser from "phaser";

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

export default class Ghost {
    constructor(scene, opts) {
        this.scene = scene;

        this.name = opts.name;
        this.baseColor = opts.color;
        this.color = opts.color;

        this.speed = opts.speed ?? 140;
        this.scatterTarget = opts.scatterTarget ?? { x: 1, y: 1 };

        // Tile position (logical)
        this.tileX = opts.startTile?.x ?? 14;
        this.tileY = opts.startTile?.y ?? 11;

        // Remember home/start tile for resets
        this.startTile = { x: this.tileX, y: this.tileY };

        // Pixel position (center of tile)
        const TS = this.scene.TILE_SIZE;
        this.x = this.tileX * TS + TS / 2;
        this.y = this.tileY * TS + TS / 2;

        // Direction state
        this.dir = { x: 1, y: 0 }; // default right

        // Modes
        this.mode = "scatter"; // "scatter" | "chase"
        this.frightenedUntil = 0;

        // Ghost-house state machine
        // "inHouse" -> waits/bounces inside box
        // "leaving" -> path to door and exits
        // "active"  -> normal AI
        this.house = {
            enabled: false,
            doorTiles: [], // [{x,y}, ...] tiles that are '~'
            exitTile: null, // tile just outside door (above)
            inHouseMinY: null,
            inHouseMaxY: null,
            releaseDelayMs: 0,
        };
        this.state = "active";
        this.releaseAt = 0;

        // Visual
        this.sprite = this.scene.add.circle(this.x, this.y, TS * 0.7, this.color);
        this.sprite.setDepth(5);

        // If start tile is not passable, nudge to nearest passable.
        this.snapToNearestPassable();
    }

    destroy() {
        this.sprite?.destroy();
    }

    configureHouse(cfg) {
        // called by MainScene after scanning level
        this.house.enabled = true;
        this.house.doorTiles = cfg.doorTiles ?? [];
        this.house.exitTile = cfg.exitTile ?? null;
        this.house.inHouseMinY = cfg.inHouseMinY ?? null;
        this.house.inHouseMaxY = cfg.inHouseMaxY ?? null;
        this.house.releaseDelayMs = cfg.releaseDelayMs ?? 0;
    }

    reset() {
        // Reset back to the ghost's start tile and clear frightened state.
        this.tileX = this.startTile.x;
        this.tileY = this.startTile.y;

        const TS = this.scene.TILE_SIZE;
        this.x = this.tileX * TS + TS / 2;
        this.y = this.tileY * TS + TS / 2;

        this.dir = { x: 1, y: 0 };

        this.frightenedUntil = 0;
        this.setColor(this.baseColor);

        this.sprite?.setPosition(this.x, this.y);

        this.snapToNearestPassable();

        // House reset (per round)
        if (this.house.enabled && this.scene.isGhostHouseTile?.(this.tileX, this.tileY)) {
            this.state = "inHouse";
            this.releaseAt = this.scene.time.now + (this.house.releaseDelayMs ?? 0);
        } else {
            this.state = "active";
            this.releaseAt = 0;
        }
    }

    onEaten() {
        this.reset();
    }

    setMode(mode) {
        if (mode === "scatter" || mode === "chase") this.mode = mode;
    }

    setFrightened(durationMs = 6000) {
        this.frightenedUntil = this.scene.time.now + durationMs;
        this.setColor(0x0000ff);
    }

    isFrightened() {
        return this.scene.time.now < this.frightenedUntil;
    }

    setColor(hex) {
        this.color = hex;
        if (this.sprite) this.sprite.fillColor = hex;
    }

    resetColorIfNeeded() {
        if (!this.isFrightened() && this.color !== this.baseColor) {
            this.setColor(this.baseColor);
        }
    }

    snapToNearestPassable() {
        const cols = this.scene.levelCols;
        const rows = this.scene.levelRows;

        const ok = (x, y) => {
            if (y < 0 || y >= rows) return false;
            if (x < 0) x = cols - 1;
            if (x >= cols) x = 0;
            return this.scene.isGhostPassable(x, y, x, y);
        };

        if (ok(this.tileX, this.tileY)) return;

        const q = [{ x: this.tileX, y: this.tileY }];
        const seen = new Set([`${this.tileX},${this.tileY}`]);

        while (q.length) {
            const p = q.shift();
            for (const d of DIRS) {
                let nx = p.x + d.x;
                const ny = p.y + d.y;

                if (ny < 0 || ny >= rows) continue;
                if (nx < 0) nx = cols - 1;
                if (nx >= cols) nx = 0;

                const key = `${nx},${ny}`;
                if (seen.has(key)) continue;
                seen.add(key);

                if (ok(nx, ny)) {
                    this.tileX = nx;
                    this.tileY = ny;
                    const TS = this.scene.TILE_SIZE;
                    this.x = nx * TS + TS / 2;
                    this.y = ny * TS + TS / 2;
                    this.sprite.setPosition(this.x, this.y);
                    return;
                }

                q.push({ x: nx, y: ny });
            }
        }
    }

    atTileCenter() {
        const TS = this.scene.TILE_SIZE;
        const cx = this.tileX * TS + TS / 2;
        const cy = this.tileY * TS + TS / 2;
        return Math.abs(this.x - cx) < 0.75 && Math.abs(this.y - cy) < 0.75;
    }

    snapToCenter() {
        const TS = this.scene.TILE_SIZE;
        this.x = this.tileX * TS + TS / 2;
        this.y = this.tileY * TS + TS / 2;
    }

    wrapXTile(x) {
        const cols = this.scene.levelCols;
        if (x < 0) return cols - 1;
        if (x >= cols) return 0;
        return x;
    }

    wrapXPixel() {
        const TS = this.scene.TILE_SIZE;
        const mapW = this.scene.levelCols * TS;

        if (this.x < -TS / 2) this.x = mapW + TS / 2;
        else if (this.x > mapW + TS / 2) this.x = -TS / 2;
    }

    canStep(fromX, fromY, toX, toY) {
        return this.scene.isGhostPassable(fromX, fromY, toX, toY);
    }

    getChaseTarget(pacTile, pacDir) {
        const cols = this.scene.levelCols;
        const rows = this.scene.levelRows;

        const clampY = (y) => Math.max(0, Math.min(rows - 1, y));
        const wrapX = (x) => {
            if (x < 0) return cols - 1;
            if (x >= cols) return 0;
            return x;
        };

        if (!pacDir) pacDir = { x: 1, y: 0 };

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
            const blinky = this.scene.ghosts?.find((g) => g.name === "blinky");
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

        return { x: pacTile.x, y: pacTile.y };
    }

    chooseDirToward(targetTile, allowReverse = false) {
        const fromX = this.tileX;
        const fromY = this.tileY;

        let best = null;
        let bestScore = Infinity;

        const candidates = [];

        for (const d of DIRS) {
            const toX = this.wrapXTile(fromX + d.x);
            const toY = fromY + d.y;

            if (toY < 0 || toY >= this.scene.levelRows) continue;
            if (!this.canStep(fromX, fromY, toX, toY)) continue;

            candidates.push(d);
        }

        let usable = candidates;
        if (!allowReverse && candidates.length > 1) {
            usable = candidates.filter((d) => !oppositeDir(d, this.dir));
            if (usable.length === 0) usable = candidates;
        }

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
            if (toY < 0 || toY >= this.scene.levelRows) continue;
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

    // --- Ghost house logic ---
    _closestDoorTile() {
        if (!this.house?.doorTiles?.length) return null;
        let best = this.house.doorTiles[0];
        let bestD = Infinity;
        for (const t of this.house.doorTiles) {
            const d = dist2(this.tileX, this.tileY, t.x, t.y);
            if (d < bestD) {
                bestD = d;
                best = t;
            }
        }
        return best;
    }

    _updateHouseState(delta) {
        // Handle inHouse / leaving behavior and set this.dir accordingly.
        if (!this.house.enabled) return;

        if (this.state === "inHouse") {
            // Wait until scheduled release time
            if (this.scene.time.now >= this.releaseAt) {
                this.state = "leaving";
                return;
            }

            // Simple bounce up/down inside the X region so they look alive.
            if (this.atTileCenter()) {
                this.snapToCenter();
                const minY = this.house.inHouseMinY ?? this.tileY;
                const maxY = this.house.inHouseMaxY ?? this.tileY;

                // If moving up would leave the house region, go down, and vice-versa.
                if (this.dir.y === -1 && this.tileY <= minY) this.dir = { x: 0, y: 1 };
                else if (this.dir.y === 1 && this.tileY >= maxY) this.dir = { x: 0, y: -1 };
                else if (this.dir.y === 0) this.dir = { x: 0, y: -1 }; // start by going up

                const nextTX = this.wrapXTile(this.tileX + this.dir.x);
                const nextTY = this.tileY + this.dir.y;
                if (nextTY < 0 || nextTY >= this.scene.levelRows) return;
                if (!this.canStep(this.tileX, this.tileY, nextTX, nextTY)) {
                    // flip if blocked
                    this.dir = { x: 0, y: -this.dir.y };
                }

                const nTX = this.wrapXTile(this.tileX + this.dir.x);
                const nTY = this.tileY + this.dir.y;
                if (this.canStep(this.tileX, this.tileY, nTX, nTY)) {
                    this.tileX = nTX;
                    this.tileY = nTY;
                }
            }

            // Movement happens in main update loop
            return;
        }

        if (this.state === "leaving") {
            const door = this._closestDoorTile();
            const exit = this.house.exitTile;

            if (!door || !exit) {
                this.state = "active";
                return;
            }

            if (this.atTileCenter()) {
                this.snapToCenter();

                // If we're on the door tile, force UP through the gate.
                if (this.tileX === door.x && this.tileY === door.y) {
                    this.dir = { x: 0, y: -1 };
                } else {
                    // Go to the door tile (allow reverse so it doesn't dumbly ping-pong)
                    this.dir = this.chooseDirToward(door, true);
                }

                const nextTX = this.wrapXTile(this.tileX + this.dir.x);
                const nextTY = this.tileY + this.dir.y;

                if (nextTY < 0 || nextTY >= this.scene.levelRows) return;
                if (!this.canStep(this.tileX, this.tileY, nextTX, nextTY)) return;

                this.tileX = nextTX;
                this.tileY = nextTY;

                // Once we're above the door and in the corridor, go active.
                if (this.tileY <= exit.y) {
                    this.state = "active";
                }
            }

            return;
        }
    }

    update(delta, pacTile, pacDir) {
        this.resetColorIfNeeded();

        const TS = this.scene.TILE_SIZE;

        // Decide special house state first (may set dir + tile steps)
        this._updateHouseState(delta);

        let remaining = (this.speed * delta) / 1000;
        const maxStep = TS / 4;

        while (remaining > 0) {
            const step = Math.min(maxStep, remaining);

            // Only run normal AI when active
            if (this.state === "active" && this.atTileCenter()) {
                this.snapToCenter();

                if (this.isFrightened()) {
                    this.dir = this.chooseDirAwayFrom(pacTile);
                } else {
                    const target =
                        this.mode === "scatter"
                            ? this.scatterTarget
                            : this.getChaseTarget(pacTile, pacDir);
                    this.dir = this.chooseDirToward(target);
                }

                const nextTX = this.wrapXTile(this.tileX + this.dir.x);
                const nextTY = this.tileY + this.dir.y;
                if (nextTY < 0 || nextTY >= this.scene.levelRows) break;
                if (!this.canStep(this.tileX, this.tileY, nextTX, nextTY)) break;

                this.tileX = nextTX;
                this.tileY = nextTY;
            }

            // Move pixel position
            this.x += this.dir.x * step;
            this.y += this.dir.y * step;

            this.wrapXPixel();

            remaining -= step;
        }

        this.sprite.setPosition(this.x, this.y);
    }
}
