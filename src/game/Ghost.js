import Phaser from "phaser";

export default class Ghost {
    /**
     * @param {Phaser.Scene} scene
     * @param {{
     *   name: string,
     *   color: number,
     *   startTile: {x:number,y:number},
     *   scatterTarget: {x:number,y:number},
     *   speed?: number
     * }} config
     */
    constructor(scene, config) {
        this.scene = scene;
        this.name = config.name;
        this.color = config.color;

        this.tileX = config.startTile.x;
        this.tileY = config.startTile.y;

        const ts = this.scene.TILE_SIZE;

        // Pixel center
        this.x = this.tileX * ts + ts / 2;
        this.y = this.tileY * ts + ts / 2;

        // Start moving left by default (classic vibe)
        this.dir = { x: -1, y: 0 };

        this.speed = config.speed;
        this.scatterTarget = config.scatterTarget;

        // Visual
        this.gfx = scene.add.graphics();
        this.gfx.setDepth(5);

        this.mode = "scatter"; // "scatter" | "chase"
    }

    setMode(mode) {
        this.mode = mode;
    }

    destroy() {
        this.gfx?.destroy();
    }

    // ---------- wrapping helpers (tile-space) ----------
    wrapTileX(x) {
        const cols = this.scene.levelCols;
        if (x < 0) return cols - 1;
        if (x >= cols) return 0;
        return x;
    }

    isInBoundsY(y) {
        return y >= 0 && y < this.scene.levelRows;
    }

    // ---------- movement helpers ----------
    isCenteredOnTile() {
        const ts = this.scene.TILE_SIZE;
        const cx = this.tileX * ts + ts / 2;
        const cy = this.tileY * ts + ts / 2;
        return Math.abs(this.x - cx) < 1 && Math.abs(this.y - cy) < 1;
    }

    // IMPORTANT: ghost passability should evaluate with wrapped X
    isPassable(toX, toY) {
        const wrappedX = this.wrapTileX(toX);
        if (!this.isInBoundsY(toY)) return false;
        return this.scene.isGhostPassable(this.tileX, this.tileY, wrappedX, toY);
    }

    // Pixel wrap (keeps visual position consistent)
    wrapIfNeeded() {
        const ts = this.scene.TILE_SIZE;
        const cols = this.scene.levelCols;
        const mapWidthPx = cols * ts;

        if (this.x < -ts / 2) {
            this.x = mapWidthPx + ts / 2;
            this.tileX = cols - 1;
        } else if (this.x > mapWidthPx + ts / 2) {
            this.x = -ts / 2;
            this.tileX = 0;
        }
    }

    dist2(ax, ay, bx, by) {
        const dx = ax - bx;
        const dy = ay - by;
        return dx * dx + dy * dy;
    }

    chooseDirection(targetTile) {
        const options = [
            { x: 1, y: 0 },
            { x: -1, y: 0 },
            { x: 0, y: 1 },
            { x: 0, y: -1 },
        ];

        const reverse = { x: -this.dir.x, y: -this.dir.y };

        // Build valid moves (with wrapped X)
        const valid = options.filter((d) => {
            const nx = this.tileX + d.x;
            const ny = this.tileY + d.y;
            return this.isPassable(nx, ny);
        });

        if (valid.length === 0) return reverse;

        // avoid reversing if we have other choices
        const nonReverse =
            valid.length > 1
                ? valid.filter((d) => !(d.x === reverse.x && d.y === reverse.y))
                : valid;

        const pool = nonReverse.length > 0 ? nonReverse : valid;

        let best = pool[0];
        let bestScore = Infinity;

        for (const d of pool) {
            const nx = this.wrapTileX(this.tileX + d.x);
            const ny = this.tileY + d.y;
            const score = this.dist2(nx, ny, targetTile.x, targetTile.y);
            if (score < bestScore) {
                bestScore = score;
                best = d;
            }
        }

        return best;
    }

    getTarget(pacmanTile) {
        if (this.mode === "scatter") return this.scatterTarget;
        return pacmanTile; // simple chase baseline
    }

    update(delta, pacmanTile) {
        const ts = this.scene.TILE_SIZE;

        // If our CURRENT tile is somehow invalid, snap to center (local recovery)
        if (!this.isPassable(this.tileX, this.tileY)) {
            const neighbors = [
                { x: this.tileX, y: this.tileY },
                { x: this.tileX + 1, y: this.tileY },
                { x: this.tileX - 1, y: this.tileY },
                { x: this.tileX, y: this.tileY + 1 },
                { x: this.tileX, y: this.tileY - 1 },
            ];

            const found = neighbors.find((p) => this.isPassable(p.x, p.y));
            if (found) {
                this.tileX = this.wrapTileX(found.x);
                this.tileY = found.y;
            }
            this.x = this.tileX * ts + ts / 2;
            this.y = this.tileY * ts + ts / 2;
        }

        // Decision point: only change direction when centered
        if (this.isCenteredOnTile()) {
            this.x = this.tileX * ts + ts / 2;
            this.y = this.tileY * ts + ts / 2;

            const target = this.getTarget(pacmanTile);

            const moves = [
                { x: 1, y: 0 },
                { x: -1, y: 0 },
                { x: 0, y: 1 },
                { x: 0, y: -1 },
            ].filter((d) => this.isPassable(this.tileX + d.x, this.tileY + d.y));

            const forwardOk = this.isPassable(this.tileX + this.dir.x, this.tileY + this.dir.y);
            const isIntersection = moves.length >= 3;

            if (!forwardOk || isIntersection) {
                this.dir = this.chooseDirection(target);
            }

            // Advance logical tile target (with wrap)
            if (this.isPassable(this.tileX + this.dir.x, this.tileY + this.dir.y)) {
                this.tileX = this.wrapTileX(this.tileX + this.dir.x);
                this.tileY = this.tileY + this.dir.y;
            }
        }

        // Move pixels toward next tile
        const step = (this.speed * delta) / 1000;
        this.x += this.dir.x * step;
        this.y += this.dir.y * step;

        // Wrap horizontally in pixel-space too (tunnel)
        this.wrapIfNeeded();

        this.draw();
    }

    draw() {
        const ts = this.scene.TILE_SIZE;
        this.gfx.clear();
        this.gfx.fillStyle(this.color, 1);
        this.gfx.fillCircle(this.x, this.y, ts * 0.7);
    }
}
