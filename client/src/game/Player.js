import Phaser from "phaser";

/**
 * Player (Pac-Man) controller.
 *
 * Performance notes (because your FPS matters more than my feelings):
 * - Dot collection is tile-based (O(1)) instead of iterating every dot every substep (O(n) * substeps).
 * - Remote players interpolate between timed snapshots (smooth at 60fps even if net updates are 20hz).
 */
export default class Player {
    constructor(scene, opts) {
        this.scene = scene;

        const {
            startTile,
            speed = 150,
            radius = scene.TILE_SIZE * 0.7,
            controls = null,
            socketId,
            color = 0xffff00,
            isRemote = false,
        } = opts;

        this.color = color;
        this.controls = controls;
        this.socketId = socketId;
        this.isRemote = isRemote;
        this.playerId = opts.playerId;

        this.startTile = { x: startTile.x, y: startTile.y };

        // Tile position (authoritative for gameplay)
        this.tileX = startTile.x;
        this.tileY = startTile.y;

        // Direction state (tile-space vectors)
        this.direction = { x: 1, y: 0 };
        this.nextDirection = { x: 1, y: 0 };

        this.speed = speed;
        this.radius = radius;

        this.isAlive = true;
        this.outUntilRoundEnd = false;
        this.eliminated = false;
        this.spawnTile = { ...opts.startTile };
        this.playerId = opts.playerId;


        // Authoritative pixel position lives on an invisible physics circle.
        this.sprite = this.scene.physics.add.existing(
            this.scene.add
                .circle(
                    this.tileX * this.scene.TILE_SIZE + this.scene.TILE_SIZE / 2,
                    this.tileY * this.scene.TILE_SIZE + this.scene.TILE_SIZE / 2,
                    this.radius,
                    color
                )
                .setOrigin(0.5)
                .setDepth(1001)
                .setVisible(false)
        );
        this.sprite.body.setCollideWorldBounds(false);

        // Mouth animation (drawn via Graphics)
        this.graphics = this.scene.add.graphics();
        this.graphics.setDepth(1001);
        this.mouthAngle = 0.15;
        this.mouthOpening = true;
        this.mouthSpeed = 0.08;

        // ---- Remote interpolation ----
        this.netSnapshots = []; // [{t,x,y,tileX,tileY,dir,nextDir}]
        this.netInterpDelayMs = 110; // render slightly in the past to interpolate cleanly
        this._lastRenderX = this.sprite.x;
        this._lastRenderY = this.sprite.y;
        // Name tag under Pac-Man
        this.nameText = this.scene.add.text(
            this.sprite.x,
            this.sprite.y + scene.TILE_SIZE * 0.9,
            opts.playerName,
            {
                fontFamily: "monospace",
                fontSize: "12px",
                color: "#ffffff",
                stroke: "#000000",
                strokeThickness: 3,
            }
        );

        this.nameText.setOrigin(0.5, 0); // centered, anchored at top
        this.nameText.setDepth(5000);    // above the maze/actors
    }

    // Arrow* string -> vector
    setNextDirection(code) {
        const map = {
            ArrowLeft: { x: -1, y: 0 },
            ArrowRight: { x: 1, y: 0 },
            ArrowUp: { x: 0, y: -1 },
            ArrowDown: { x: 0, y: 1 },
        };
        const v = map[code];
        if (!v) return;
        this.nextDirection = v;
    }

    // Used by scene when applying remote state updates
    pushNetSnapshot(s) {
        // s.t should be a LOCAL timestamp (scene.time.now), not sender clock.
        this.netSnapshots.push(s);
        // Keep buffer small
        if (this.netSnapshots.length > 12) this.netSnapshots.shift();
    }

    reset(startTile = this.startTile) {
        this.tileX = startTile.x;
        this.tileY = startTile.y;

        this.direction = { x: 1, y: 0 };
        this.nextDirection = { x: 1, y: 0 };

        this.sprite.x = this.tileX * this.scene.TILE_SIZE + this.scene.TILE_SIZE / 2;
        this.sprite.y = this.tileY * this.scene.TILE_SIZE + this.scene.TILE_SIZE / 2;

        this.netSnapshots.length = 0;

        this.mouthAngle = 0.15;
        this.mouthOpening = true;
        this._lastRenderX = this.sprite.x;
        this._lastRenderY = this.sprite.y;
    }

    getTile() {
        return { x: this.tileX, y: this.tileY };
    }

    getDirection() {
        return { x: this.direction.x, y: this.direction.y };
    }

    handleInput() {
        const c = this.controls ?? this.scene.cursors;
        if (!c) return;

        if (c.left?.isDown) this.nextDirection = { x: -1, y: 0 };
        else if (c.right?.isDown) this.nextDirection = { x: 1, y: 0 };
        else if (c.up?.isDown) this.nextDirection = { x: 0, y: -1 };
        else if (c.down?.isDown) this.nextDirection = { x: 0, y: 1 };
    }

    handleTunnelWrap() {
        const cols = this.scene.levelCols;
        const mapWidthPx = cols * this.scene.TILE_SIZE;

        // Wrap when the CENTER passes the edge
        const half = this.scene.TILE_SIZE / 2;

        if (this.sprite.x < -half) {
            this.sprite.x = mapWidthPx + half;
            this.tileX = cols - 1;
        } else if (this.sprite.x > mapWidthPx + half) {
            this.sprite.x = -half;
            this.tileX = 0;
        }
    }

    animateMouth(moving) {
        if (!moving) {
            this.mouthAngle = 0.08;
            return;
        }

        if (this.mouthOpening) {
            this.mouthAngle += this.mouthSpeed;
            if (this.mouthAngle >= 0.85) this.mouthOpening = false;
        } else {
            this.mouthAngle -= this.mouthSpeed;
            if (this.mouthAngle <= 0.08) this.mouthOpening = true;
        }
    }

    draw() {
        const g = this.graphics;
        g.clear();

        const x = this.sprite.x;
        const y = this.sprite.y;
        const r = this.radius;

        // Direction angle
        let ang = 0;
        if (this.direction.x === 1) ang = 0;
        else if (this.direction.x === -1) ang = Math.PI;
        else if (this.direction.y === 1) ang = Math.PI / 2;
        else if (this.direction.y === -1) ang = -Math.PI / 2;

        const open = this.mouthAngle;
        const start = ang + open;
        const end = ang - open;

        g.fillStyle(this.color, 1);
        g.beginPath();
        g.moveTo(x, y);
        g.arc(x, y, r, start, end, false);
        g.closePath();
        g.fillPath();
    }

    _applyRemoteInterpolation() {
        const now = this.scene.time.now;
        const renderTime = now - this.netInterpDelayMs;

        const snaps = this.netSnapshots;
        if (snaps.length === 0) return false;

        // Drop snapshots that are too old
        while (snaps.length >= 3 && snaps[1].t <= renderTime) snaps.shift();

        // If we only have one, snap-ish but still smooth (tiny lerp)
        if (snaps.length === 1) {
            const s = snaps[0];
            const a = 1 - Math.pow(0.001, 1 / 60); // ~0.11 per frame-ish
            this.sprite.x += (s.x - this.sprite.x) * a;
            this.sprite.y += (s.y - this.sprite.y) * a;
            this.tileX = s.tileX;
            this.tileY = s.tileY;
            if (s.dir) this.direction = s.dir;
            if (s.nextDir) this.nextDirection = s.nextDir;
            return true;
        }

        const s0 = snaps[0];
        const s1 = snaps[1];

        const span = Math.max(1, s1.t - s0.t);
        const alpha = Phaser.Math.Clamp((renderTime - s0.t) / span, 0, 1);

        // Interpolate pixel position
        this.sprite.x = Phaser.Math.Linear(s0.x, s1.x, alpha);
        this.sprite.y = Phaser.Math.Linear(s0.y, s1.y, alpha);

        // Keep tile position roughly in sync (choose closer)
        const use = alpha < 0.5 ? s0 : s1;
        this.tileX = use.tileX;
        this.tileY = use.tileY;

        // Keep facing direction stable for mouth orientation
        if (use.dir) this.direction = use.dir;
        if (use.nextDir) this.nextDirection = use.nextDir;

        return true;
    }

    setAlive(alive) {
        this.isAlive = alive;

        // Disable physics while dead so you can't collide/eat dots accidentally
        if (this.sprite?.body) {
            this.sprite.body.enable = alive;
        }

        // Your Pac-Man visuals are the Graphics, not the sprite.
        if (this.graphics) {
            this.graphics.setVisible(alive);
            if (!alive) this.graphics.clear(); // fully remove the body/mouth when dead
        }

        // Reset mouth state on respawn so you don't come back as a weird blob
        if (alive) {
            this.mouthAngle = 0.15;
            this.mouthOpening = true;
            this.setSpectatorVisual(false);

            // Force a redraw immediately (so you don't wait a frame and see "nothing")
            this.draw();
        }
    }

    setSpectatorVisual(isSpectator) {
        if (!this.graphics) return;
        this.graphics.setAlpha(isSpectator ? 0.25 : 1);
    }

    explode() {
        this.nameText?.setVisible(false);
        const scene = this.scene;
        const x0 = this.sprite.x;
        const y0 = this.sprite.y;

        // Hide Pac-Man immediately
        if (this.graphics) this.graphics.setVisible(false);

        const g = scene.add.graphics();
        g.setDepth(2000);

        // ===== TURN THESE UP FOR MORE CHAOS =====
        const basePixelSize = 4;      // was ~3
        const maxPixelSize = 7;       // BIG CHUNKS
        const count = 960;            // MORE PIXELS (was ~120)
        const lifetimeMs = 5250;       // slightly longer
        const gravity = 100;          // heavier fall
        const spread = 1.35;          // wider blast
        const ringRadiusBoost = 30;   // bigger shockwave
        // =======================================

        const shards = [];

        for (let i = 0; i < count; i++) {
            const ang = Math.random() * Math.PI * 2;
            const spd = (180 + Math.random() * 420) * spread;

            const size =
                basePixelSize +
                Math.random() * (maxPixelSize - basePixelSize);

            shards.push({
                x: x0 + (Math.random() - 0.5) * this.radius,
                y: y0 + (Math.random() - 0.5) * this.radius,
                vx: Math.cos(ang) * spd,
                vy: Math.sin(ang) * spd,
                size,
                flash: Math.random() < 0.22,
                a: 1,
            });
        }

        const start = scene.time.now;

        // Stronger impact
        scene.cameras.main.shake(140, 0.012);

        const step = () => {
            const now = scene.time.now;
            const t = (now - start) / lifetimeMs;

            if (t >= 1) {
                scene.events.off("postupdate", step);
                g.destroy();
                return;
            }

            const dt = scene.game.loop.delta / 1000;
            g.clear();

            // BIG expanding shock ring
            g.lineStyle(4, 0xffffff, 1 - t);
            g.strokeCircle(x0, y0, this.radius + t * ringRadiusBoost);

            for (const p of shards) {
                // physics
                p.vy += gravity * dt;
                p.x += p.vx * dt;
                p.y += p.vy * dt;

                p.a = Math.max(0, 1 - t);

                const size = p.size * (1 - t * 0.6);

                if (p.flash && t < 0.35) {
                    g.fillStyle(0xffffff, p.a);
                } else {
                    g.fillStyle(this.color, p.a);
                }

                g.fillRect(
                    p.x - size / 2,
                    p.y - size / 2,
                    size,
                    size
                );
            }
        };

        scene.events.on("postupdate", step);
    }


    resetToSpawn() {
        this.nameText?.setVisible(true);
        const TS = this.scene.TILE_SIZE;
        this.tileX = this.spawnTile.x;
        this.tileY = this.spawnTile.y;

        const px = this.tileX * TS + TS / 2;
        const py = this.tileY * TS + TS / 2;

        this.sprite.x = px;
        this.sprite.y = py;
        this.netTargetX = px;
        this.netTargetY = py;

        // Also reset direction so they don't “launch” on respawn
        this.direction = { x: 1, y: 0 };
        this.nextDirection = { x: 1, y: 0 };
    }


    /**
     * Movement update. Returns whether Pac-Man moved this frame.
     * @param {number} delta ms
     */
    update(delta) {
        if (!this.isAlive) {
            // Still interpolate remote net position if you want “ghost spectators” to drift,
            // but for your rules: dead should just sit there.
            return;
        }
        if (this.nameText) {
            this.nameText.setPosition(this.sprite.x, this.sprite.y + this.scene.TILE_SIZE * 0.9);
        }

        // Remote players: no grid sim, just interpolate.
        if (this.isRemote) {
            const moved = this._applyRemoteInterpolation();

            // Infer facing direction from motion if we don't have it yet.
            const dx = this.sprite.x - this._lastRenderX;
            const dy = this.sprite.y - this._lastRenderY;
            if (Math.abs(dx) > Math.abs(dy)) {
                if (dx > 0.01) this.direction = { x: 1, y: 0 };
                else if (dx < -0.01) this.direction = { x: -1, y: 0 };
            } else {
                if (dy > 0.01) this.direction = { x: 0, y: 1 };
                else if (dy < -0.01) this.direction = { x: 0, y: -1 };
            }

            this._lastRenderX = this.sprite.x;
            this._lastRenderY = this.sprite.y;
            return moved;
        }

        this.handleInput();

        // ---- SPEED-SAFE MOVEMENT ----
        let remaining = (this.speed * delta) / 1000;

        // Bigger step = fewer loops per frame.
        // Still safe because we only commit to a new tile when we are centered.
        const maxStep = this.scene.TILE_SIZE / 2;

        let movedThisFrame = false;
        let touchedCenterThisFrame = false;

        while (remaining > 0) {
            const step = Math.min(maxStep, remaining);
            remaining -= step;

            // Snap-to-center & decide next tile when near center
            const cx = this.tileX * this.scene.TILE_SIZE + this.scene.TILE_SIZE / 2;
            const cy = this.tileY * this.scene.TILE_SIZE + this.scene.TILE_SIZE / 2;

            const tol = Math.max(1, step + 0.25);
            const atCenter = Math.abs(this.sprite.x - cx) <= tol && Math.abs(this.sprite.y - cy) <= tol;

            if (atCenter) {
                this.sprite.x = cx;
                this.sprite.y = cy;

                // Eat only when centered (classic behavior, and fast)
                if (!touchedCenterThisFrame) {
                    this.scene.collectDotAt(this);
                    touchedCenterThisFrame = true;
                }

                if (this.scene.canMove(this.tileX, this.tileY, this.nextDirection)) {
                    this.direction = this.nextDirection;
                }

                // If blocked, stop advancing this frame
                if (!this.scene.canMove(this.tileX, this.tileY, this.direction)) {
                    break;
                }

                // Advance logical tile
                this.tileX += this.direction.x;
                this.tileY += this.direction.y;

                // Apply wrap in tile-space too
                if (this.tileX < 0) this.tileX = this.scene.levelCols - 1;
                else if (this.tileX >= this.scene.levelCols) this.tileX = 0;
            }

            const beforeX = this.sprite.x;
            const beforeY = this.sprite.y;

            // Move pixel position
            this.sprite.x += this.direction.x * step;
            this.sprite.y += this.direction.y * step;

            this.handleTunnelWrap();

            if (Math.abs(this.sprite.x - beforeX) > 0.01 || Math.abs(this.sprite.y - beforeY) > 0.01) {
                movedThisFrame = true;
            }
        }

        this._lastRenderX = this.sprite.x;
        this._lastRenderY = this.sprite.y;

        return movedThisFrame;
    }

    render(moving) {
        this.animateMouth(moving);
        this.draw();
    }
}
