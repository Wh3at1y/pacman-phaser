// Ghost.js
import Phaser from "phaser";

const DIRS = [
    { x: 0, y: -1, name: "UP" },
    { x: -1, y: 0, name: "LEFT" },
    { x: 0, y: 1, name: "DOWN" },
    { x: 1, y: 0, name: "RIGHT" },
];

function sameDir(a, b) {
    return a && b && a.x === b.x && a.y === b.y;
}

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

        // Pixel position (center of tile)
        const TS = this.scene.TILE_SIZE;
        this.x = this.tileX * TS + TS / 2;
        this.y = this.tileY * TS + TS / 2;

        // Direction state
        this.dir = { x: 1, y: 0 }; // default right
        this.nextDir = { x: 1, y: 0 };
        this.lastDir = { x: 1, y: 0 };

        // Modes
        this.mode = "scatter"; // "scatter" | "chase"
        this.frightenedUntil = 0;

        // Visual
        this.sprite = this.scene.add.circle(this.x, this.y, TS * 0.7, this.color);
        this.sprite.setDepth(5);

        // If your start tile is not passable, nudge to nearest passable.
        this.snapToNearestPassable();
    }

    destroy() {
        this.sprite?.destroy();
    }

    setMode(mode) {
        // MainScene calls this every frame.
        if (mode === "scatter" || mode === "chase") this.mode = mode;
    }

    // Call from MainScene when Pac-Man eats a power pellet
    // Example: ghosts.forEach(g => g.setFrightened(7000))
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
        // If we spawned in a wall/blocked spot, walk outward until we find passable.
        // Uses ghost rules (so it won’t “spawn” inside forbidden house entry).
        const cols = this.scene.levelCols;
        const rows = this.scene.levelRows;

        const ok = (x, y) => {
            if (y < 0 || y >= rows) return false;
            if (x < 0) x = cols - 1;
            if (x >= cols) x = 0;
            // "from" doesn't matter much here; just test as if coming from itself
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
        // IMPORTANT: use your one-way door rules from MainScene
        return this.scene.isGhostPassable(fromX, fromY, toX, toY);
    }

    getChaseTarget(pacTile, pacDir) {
        // Simple classic-ish targets:
        // - blinky: pacman
        // - pinky: 4 tiles ahead
        // - inky: 2 ahead then "vector" from blinky (approx)
        // - clyde: chase if far, else scatter
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
            // Approx classic: target = pacman + 2 ahead, then mirror around blinky.
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

        // blinky/default
        return { x: pacTile.x, y: pacTile.y };
    }

    chooseDirToward(targetTile) {
        // Choose legal direction that minimizes distance to target.
        // Avoid reversing unless forced (Pac-Man rules).
        const fromX = this.tileX;
        const fromY = this.tileY;

        let best = null;
        let bestScore = Infinity;

        const candidates = [];

        for (const d of DIRS) {
            const toX = this.wrapXTile(fromX + d.x);
            const toY = fromY + d.y;

            // block vertical out-of-bounds
            if (toY < 0 || toY >= this.scene.levelRows) continue;

            if (!this.canStep(fromX, fromY, toX, toY)) continue;

            candidates.push(d);
        }

        // If we have more than 1 option, don't reverse.
        let usable = candidates;
        if (candidates.length > 1) {
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
        // Frightened: choose legal direction that MAXIMIZES distance from Pac-Man.
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

    update(delta, pacTile, pacDir) {
        // delta is ms
        this.resetColorIfNeeded();

        const TS = this.scene.TILE_SIZE;

        // Substep movement to prevent speed-based wall phasing.
        // Any time humans crank speed values, physics gets spicy.
        let remaining = (this.speed * delta) / 1000;

        const maxStep = TS / 4; // hard clamp
        while (remaining > 0) {
            const step = Math.min(maxStep, remaining);

            // If we’re centered, decide direction for the NEXT tile.
            if (this.atTileCenter()) {
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

                // If somehow blocked (rare), just stop.
                const nextTX = this.wrapXTile(this.tileX + this.dir.x);
                const nextTY = this.tileY + this.dir.y;
                if (nextTY < 0 || nextTY >= this.scene.levelRows) break;
                if (!this.canStep(this.tileX, this.tileY, nextTX, nextTY)) break;

                // Advance logical tile (like your Pac-Man does)
                this.tileX = nextTX;
                this.tileY = nextTY;
            }

            // Move pixel position toward current dir
            this.x += this.dir.x * step;
            this.y += this.dir.y * step;

            // Wrap through tunnel in pixel space
            this.wrapXPixel();

            remaining -= step;
        }

        // Sync sprite
        this.sprite.setPosition(this.x, this.y);
    }
}
