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

        // Pixel center
        this.x = this.tileX * scene.TILE_SIZE + scene.TILE_SIZE / 2;
        this.y = this.tileY * scene.TILE_SIZE + scene.TILE_SIZE / 2;

        // Start moving left by default (classic vibe), but we’ll auto-correct if blocked.
        this.dir = { x: -1, y: 0 };
        this.nextDir = { x: -1, y: 0 };

        this.speed = config.speed ?? 140;

        this.scatterTarget = config.scatterTarget;

        // Visual
        this.gfx = scene.add.graphics();
        this.gfx.setDepth(5);

        // Mode control (scene sets this each tick)
        this.mode = "scatter"; // "scatter" | "chase"
    }

    setMode(mode) {
        this.mode = mode;
    }

    destroy() {
        this.gfx?.destroy();
    }

    getCenteredTile() {
        const ts = this.scene.TILE_SIZE;
        return {
            x: Math.floor(this.x / ts),
            y: Math.floor(this.y / ts),
        };
    }

    isCenteredOnTile() {
        const ts = this.scene.TILE_SIZE;
        const cx = this.tileX * ts + ts / 2;
        const cy = this.tileY * ts + ts / 2;
        return Math.abs(this.x - cx) < 1 && Math.abs(this.y - cy) < 1;
    }

    isPassable(tx, ty) {
        return !!this.scene.passable?.[ty]?.[tx];
    }

    // same horizontal wrap behavior as pacman
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

    // Euclidean distance in tile-space (good enough)
    dist2(ax, ay, bx, by) {
        const dx = ax - bx;
        const dy = ay - by;
        return dx * dx + dy * dy;
    }

    // Choose direction at intersections:
    // - can’t go into walls
    // - prefer not reversing unless forced
    // - pick option that minimizes distance to target
    chooseDirection(targetTile) {
        const options = [
            { x: 1, y: 0 },
            { x: -1, y: 0 },
            { x: 0, y: 1 },
            { x: 0, y: -1 },
        ];

        const reverse = { x: -this.dir.x, y: -this.dir.y };

        const valid = options.filter((d) => {
            const nx = this.tileX + d.x;
            const ny = this.tileY + d.y;
            if (!this.isPassable(nx, ny)) return false;
            return true;
        });

        if (valid.length === 0) {
            return reverse; // trapped; shrug
        }

        // avoid reversing if we have other choices
        const nonReverse =
            valid.length > 1
                ? valid.filter((d) => !(d.x === reverse.x && d.y === reverse.y))
                : valid;

        const pool = nonReverse.length > 0 ? nonReverse : valid;

        let best = pool[0];
        let bestScore = Infinity;

        for (const d of pool) {
            const nx = this.tileX + d.x;
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
        // Scatter: go to assigned corner-ish tile
        if (this.mode === "scatter") return this.scatterTarget;

        // Chase: go directly to pacman tile (simple baseline)
        return pacmanTile;
    }

    update(delta, pacmanTile) {
        const ts = this.scene.TILE_SIZE;

        // Make sure we never drift into invalid tiles vertically.
        // If something went wrong, snap back onto current tile center.
        if (!this.isPassable(this.tileX, this.tileY)) {
            // find nearest passable around (small local fix)
            const neighbors = [
                { x: this.tileX, y: this.tileY },
                { x: this.tileX + 1, y: this.tileY },
                { x: this.tileX - 1, y: this.tileY },
                { x: this.tileX, y: this.tileY + 1 },
                { x: this.tileX, y: this.tileY - 1 },
            ];
            const found = neighbors.find((p) => this.isPassable(p.x, p.y));
            if (found) {
                this.tileX = found.x;
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

            // If forward is blocked, or if we're at an intersection, choose.
            // Intersection heuristic: if more than 2 valid moves, it's an intersection.
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

            // Advance logical tile target
            if (this.isPassable(this.tileX + this.dir.x, this.tileY + this.dir.y)) {
                this.tileX += this.dir.x;
                this.tileY += this.dir.y;
            }
        }

        // Move pixels toward next tile
        const step = (this.speed * delta) / 1000;
        this.x += this.dir.x * step;
        this.y += this.dir.y * step;

        // Wrap horizontally
        this.wrapIfNeeded();

        // Draw
        this.draw();
    }

    draw() {
        const ts = this.scene.TILE_SIZE;
        this.gfx.clear();
        this.gfx.fillStyle(this.color, 1);
        this.gfx.fillCircle(this.x, this.y, ts * 0.7);
    }
}
