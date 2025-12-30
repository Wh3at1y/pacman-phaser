import Phaser from "phaser";
import {level1} from "../levels/level1";
import Ghost from "../Ghost";

const TILE_SIZE = 24;

const PACMAN_START_TILE = {x: 13, y: 23}; // requested spawn
const PACMAN_RADIUS = TILE_SIZE * 0.7;     // bigger, but not insane for 24px tiles


// Wall symbols (your ASCII maze)
const WALL_TILES = ["═", "║", "╔", "╗", "╚", "╝", "┌", "┐", "└", "┘", "|", "-", "~"];

export default class MainScene extends Phaser.Scene {
    constructor(onHudUpdate) {
        super("MainScene");
        this.onHudUpdate = onHudUpdate; // optional callback for React HUD
    }

    preload() {
        // If you’re in React/Vite, you may need to import and pass URL.
        // Keeping your current behavior as-is:
        this.load.audio("roundStart", "start.mp3");
        this.load.audio("eatLoop", "eating.mp3");
        this.load.audio("dead", "dead.mp3");
    }

    create() {
        this.TILE_SIZE = TILE_SIZE;
        this.levelCols = level1[0].length;
        this.levelRows = level1.length;

        this.cameras.main.setZoom(1);

        // ---- GAME STATE ----
        this.isDying = false;
        this.isRoundActive = false;

        this.round = this.registry.get("round") ?? 1;
        this.score = this.registry.get("score") ?? 0;

        this.registry.set("round", this.round);
        this.registry.set("score", this.score);

        this.dotsRemaining = 0;
        this.dotsCollected = 0;

        // ---- GHOST MODE STATE ----
        this.ghostMode = "scatter";
        this.ghostModeElapsed = 0;

        // frightened state
        this.frightenedUntil = 0; // timestamp in ms (this.time.now)
        this.frightenedMs = 7000; // power pellet duration (simple)

        // ---- INPUT ----
        this.cursors = this.input.keyboard.createCursorKeys();

        // ---- AUDIO ----
        this.roundStartSound = this.sound.add("roundStart", {volume: 0});
        this.eatSound = this.sound.add("eatLoop", {loop: true, volume: 0.45});
        this.deadSound = this.sound.add("dead", {volume: 0.7});

        this.lastEatTime = -999999;

        // ---- DOTS GROUP ----
        this.dots = this.add.group();

        // ---- PLAYER ----
        this.player = {
            tileX: PACMAN_START_TILE.x,
            tileY: PACMAN_START_TILE.y,
            direction: {x: 1, y: 0},
            nextDirection: {x: 1, y: 0},
            speed: 160,
        };

// Authoritative position (pixel-space)
        this.playerSprite = this.physics.add.existing(
            this.add.circle(
                this.player.tileX * TILE_SIZE + TILE_SIZE / 2,
                this.player.tileY * TILE_SIZE + TILE_SIZE / 2,
                PACMAN_RADIUS,
                0xffff00
            )
                .setOrigin(0.5)
                .setDepth(1001)
                .setVisible(false) // keep hidden; you draw pacman with graphics
        );

        this.playerSprite.body.setCollideWorldBounds(false);

        // Pacman mouth animation (drawn via graphics)
        this.playerGraphics = this.add.graphics();
        this.mouthAngle = 0.15;
        this.mouthOpening = true;
        this.mouthSpeed = 0.04;

        // ---- READY OVERLAY ----
        this.readyOverlay = this.add
            .rectangle(
                (this.levelCols * TILE_SIZE) / 2,
                (this.levelRows * TILE_SIZE) / 2,
                this.levelCols * TILE_SIZE,
                60,
                0x000000,
                0.75
            )
            .setDepth(1000)
            .setVisible(false);

        this.readyText = this.add
            .text(
                (this.levelCols * TILE_SIZE) / 2,
                (this.levelRows * TILE_SIZE) / 2,
                "READY!",
                {
                    fontFamily: "Arial",
                    fontSize: "28px",
                    color: "#00aaff",
                    fontStyle: "bold",
                }
            )
            .setOrigin(0.5)
            .setDepth(1001)
            .setVisible(false);

        // ---- Build dot sprites from level ----
        this.buildDotsFromLevel();

        // ---- IMPORTANT ----
        // Put YOUR drawLevel() function here unchanged.
        this.drawLevel();
        //
        // (You said don’t touch it, so I’m not including it.)

        // ---- GHOST HOUSE REGION (optional: if you use it for "~" rules in Ghost.js) ----
        // If your Ghost.js expects this.ghostHouse or passability hooks, keep it:
        this.buildGhostHouseRegion?.();

        // ---- GHOSTS ----
        this.ghosts = [
            new Ghost(this, {
                name: "blinky",
                color: 0xff0000,
                startTile: {x: 14, y: 11},
                scatterTarget: {x: this.levelCols - 2, y: 1}, // top-right
                speed: 145,
            }),
            new Ghost(this, {
                name: "pinky",
                color: 0xffb8ff,
                startTile: {x: 14, y: 11},
                scatterTarget: {x: 1, y: 1},
                speed: 145,
            }),
            new Ghost(this, {
                name: "inky",
                color: 0x00ffff,
                startTile: {x: 13, y: 12},
                scatterTarget: {x: this.levelCols - 2, y: this.levelRows - 2},
                speed: 130,
            }),
            new Ghost(this, {
                name: "clyde",
                color: 0xffb852,
                startTile: {x: 14, y: 12},
                scatterTarget: {x: 1, y: this.levelRows - 2},
                speed: 120,
            }),
        ];

        // ---- HUD ----
        this.onHudUpdate?.({
            score: this.score,
            dotsCollected: this.dotsCollected,
            dotsRemaining: this.dotsRemaining,
            round: this.round,
        });

        // Start round with delay + READY
        this.startRound();
    }

    /* ===============================
       LEVEL HELPERS
    =============================== */

    isGhostPassable(fromX, fromY, toX, toY) {
        const cols = this.levelCols;
        const rows = this.levelRows;

        // vertical bounds are hard walls
        if (toY < 0 || toY >= rows) return false;

        // horizontal wrap (tunnel)
        if (toX < 0) toX = cols - 1;
        if (toX >= cols) toX = 0;

        const tile = level1[toY]?.[toX];
        if (!tile) return false;

        // solid walls
        const walls = ["═", "║", "╔", "╗", "╚", "╝", "┌", "┐", "└", "┘", "|", "-"];
        if (walls.includes(tile)) return false;

        // ghost-house gate logic (your ~~ tiles)
        // ghosts may EXIT but not ENTER
        if (tile === "~~") {
            // only allow movement if coming from inside the box (moving UP)
            return fromY > toY;
        }

        return true;
    }


    isWallTile(tile) {
        return WALL_TILES.includes(tile);
    }

    isPacmanPassable(toX, toY) {
        const rows = level1.length;
        const cols = level1[0].length;

        if (toY < 0 || toY >= rows) return false;
        if (toX < 0) toX = cols - 1;
        if (toX >= cols) toX = 0;

        const tile = level1[toY]?.[toX];
        if (!tile) return false;

        const walls = ["═", "║", "╔", "╗", "╚", "╝", "┌", "┐", "└", "┘", "|", "-"];

        // Pac-Man cannot go through walls OR ghost door tiles
        if (walls.includes(tile)) return false;
        if (tile === "~~") return false;

        return true;
    }

    // Tile-based movement check, with horizontal wrapping
    canMove(tileX, tileY, direction) {
        const newX = tileX + direction.x;
        const newY = tileY + direction.y;
        return this.isPacmanPassable(newX, newY);
    }

    handleTunnelWrap() {
        const cols = level1[0].length;
        const mapWidthPx = cols * TILE_SIZE;

        // Wrap when the CENTER of Pac-Man passes the edge (more stable)
        const half = TILE_SIZE / 2;

        if (this.playerSprite.x < -half) {
            this.playerSprite.x = mapWidthPx + half;
            this.player.tileX = cols - 1; // logical wrap
        } else if (this.playerSprite.x > mapWidthPx + half) {
            this.playerSprite.x = -half;
            this.player.tileX = 0;        // logical wrap
        }

        // NOTE: Do NOT floor() tileX/tileY here. That breaks tile-based stepping.
    }

    /* ===============================
       DOTS / SCORE
    =============================== */

    buildDotsFromLevel() {
        this.dots.clear(true, true);
        this.dotsRemaining = 0;

        for (let y = 0; y < level1.length; y++) {
            for (let x = 0; x < level1[y].length; x++) {
                const tile = level1[y][x];
                if (tile === "·" || tile === "o") {
                    const dot = this.add.circle(
                        x * TILE_SIZE + TILE_SIZE / 2,
                        y * TILE_SIZE + TILE_SIZE / 2,
                        tile === "o" ? TILE_SIZE * 0.22 : TILE_SIZE * 0.1,
                        0xffffff
                    );
                    dot.setData("type", tile === "o" ? "power" : "normal");
                    dot.setData("tileX", x);
                    dot.setData("tileY", y);

                    this.dots.add(dot);
                    this.dotsRemaining++;
                }
            }
        }
    }

    collectDot() {
        if (!this.isRoundActive) return;

        const px = this.playerSprite.x;
        const py = this.playerSprite.y;

        let ateSomething = false;

        this.dots.children.iterate((dot) => {
            if (!dot || !dot.active) return;

            const dist = Phaser.Math.Distance.Between(px, py, dot.x, dot.y);
            if (dist < TILE_SIZE * 0.35) {
                const type = dot.getData("type") || "normal";
                dot.destroy();

                ateSomething = true;
                this.lastEatTime = this.time.now;

                const points = type === "power" ? 50 : 10;
                this.score += points;
                this.registry.set("score", this.score);

                this.dotsRemaining--;
                this.dotsCollected++;

                this.onHudUpdate?.({
                    score: this.score,
                    dotsCollected: this.dotsCollected,
                    dotsRemaining: this.dotsRemaining,
                    round: this.round,
                });

                // Power pellet triggers frightened
                if (type === "power") {
                    this.triggerFrightened();
                }

                // Round ends when no dots remain
                if (this.dotsRemaining <= 0) {
                    this.endRound();
                }
            }
        });

        // eat audio is handled in update; this just tags lastEatTime
        return ateSomething;
    }

    /* ===============================
       ROUND FLOW
    =============================== */

    startRound() {
        this.isRoundActive = false;

        // show READY overlay
        this.readyOverlay.setVisible(true);
        this.readyText.setVisible(true);

        this.roundStartSound?.play();

        // reset pacman position (tile coords)
        this.player.tileX = PACMAN_START_TILE.x;
        this.player.tileY = PACMAN_START_TILE.y;
        this.player.direction = { x: 1, y: 0 };
        this.player.nextDirection = { x: 1, y: 0 };

        this.playerSprite.x = this.player.tileX * TILE_SIZE + TILE_SIZE / 2;
        this.playerSprite.y = this.player.tileY * TILE_SIZE + TILE_SIZE / 2;


        // reset frightened
        this.frightenedUntil = 0;
        this.ghostMode = "scatter";
        this.ghostModeElapsed = 0;

        // reset ghosts
        for (const g of this.ghosts) g.reset?.();

        // 5 second delay before gameplay
        this.time.delayedCall(1000, () => {
            this.readyOverlay.setVisible(false);
            this.readyText.setVisible(false);
            this.isRoundActive = true;
        });
    }


    endRound() {
        this.stopEatSound();
        this.isRoundActive = false;

        this.round++;
        this.registry.set("round", this.round);

        this.onHudUpdate?.({round: this.round});

        // Rebuild dots by restoring level’s pellets (if your level array is mutated)
        // If you mutate level1 tiles to " " when eaten, you MUST restore here.
        // Safer: just rebuild dot sprites from the *original* layout.
        // If you currently mutate level1, keep an original copy and restore it here.
        //
        // For now, we rebuild from whatever your current level1 contains:
        this.buildDotsFromLevel();

        this.time.delayedCall(150, () => {
            this.startRound();
        });
    }

    /* ===============================
       FRIGHTENED MODE
    =============================== */

    triggerFrightened() {
        this.frightenedUntil = this.time.now + this.frightenedMs;
        this.ghostMode = "frightened";

        for (const g of this.ghosts) {
            g.setMode?.("frightened");
        }
    }

    updateGhostMode(delta) {
        // If frightened is active, enforce it and don’t advance scatter/chase timer
        if (this.time.now < this.frightenedUntil) {
            this.ghostMode = "frightened";
            return;
        }

        // If frightened just ended, return to normal modes
        if (this.ghostMode === "frightened") {
            this.ghostMode = "scatter";
            this.ghostModeElapsed = 0;
        }

        // scatter ~7s, chase ~20s, repeat
        this.ghostModeElapsed += delta;

        if (this.ghostMode === "scatter" && this.ghostModeElapsed > 7000) {
            this.ghostMode = "chase";
            this.ghostModeElapsed = 0;
        } else if (this.ghostMode === "chase" && this.ghostModeElapsed > 20000) {
            this.ghostMode = "scatter";
            this.ghostModeElapsed = 0;
        }
    }

    /* ===============================
       INPUT
    =============================== */

    handleInput() {
        if (this.cursors.left.isDown) this.player.nextDirection = {x: -1, y: 0};
        else if (this.cursors.right.isDown) this.player.nextDirection = {x: 1, y: 0};
        else if (this.cursors.up.isDown) this.player.nextDirection = {x: 0, y: -1};
        else if (this.cursors.down.isDown) this.player.nextDirection = {x: 0, y: 1};
    }

    /* ===============================
       PACMAN VISUALS
    =============================== */

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

    drawPacman() {
        const g = this.playerGraphics;
        g.clear();

        const x = this.playerSprite.x;
        const y = this.playerSprite.y;
        const r = PACMAN_RADIUS;


        // direction angle
        let ang = 0;
        if (this.player.direction.x === 1) ang = 0;
        else if (this.player.direction.x === -1) ang = Math.PI;
        else if (this.player.direction.y === 1) ang = Math.PI / 2;
        else if (this.player.direction.y === -1) ang = -Math.PI / 2;

        const open = this.mouthAngle;
        const start = ang + open;
        const end = ang - open;

        g.fillStyle(0xffff00, 1);
        g.beginPath();
        g.moveTo(x, y);
        g.arc(x, y, r, start, end, false);
        g.closePath();
        g.fillPath();
    }

    stopEatSound() {
        if (!this.eatSound) return;
        if (this.eatSound.isPlaying) this.eatSound.stop();
        if (this.eatSound.isPaused) this.eatSound.stop();
    }

    /* ===============================
       COLLISION (PACMAN vs GHOST)
    =============================== */

    checkGhostCollision() {
        if (this.isDying) return false;

        const px = this.playerSprite.x;
        const py = this.playerSprite.y;

        for (const g of this.ghosts) {
            if (!g || !g.sprite) continue;

            const dx = g.sprite.x - px;
            const dy = g.sprite.y - py;
            const d2 = dx * dx + dy * dy;

            // collision radius tuned for your tile size
            const hit = (TILE_SIZE * 0.55) * (TILE_SIZE * 0.55);
            if (d2 < hit) return true;
        }
        return false;
    }

    killPacman() {
        if (this.isDying) return;
        this.isDying = true;

        this.stopEatSound();
        this.deadSound?.play();

        this.time.delayedCall(900, () => {
            this.isDying = false;
            this.startRound(); // resets positions and delays with READY again
        });
    }

    /* ===============================
       UPDATE (FIXED SPEED-SAFE MOVEMENT)
    =============================== */

    update(time, delta) {
        // always try to collect (but collectDot checks isRoundActive)
        this.collectDot();

        if (!this.isRoundActive || this.isDying) {
            this.stopEatSound();
            this.drawPacman();
            return;
        }

        this.handleInput();

        // ---- SPEED-SAFE MOVEMENT ----
        // Move in substeps so you never tunnel through walls, regardless of speed.
        let remaining = (this.player.speed * delta) / 1000;
        const maxStep = TILE_SIZE / 4;

        let movedThisFrame = false;

        while (remaining > 0) {
            const step = Math.min(maxStep, remaining);
            remaining -= step;

            // snap-to-center & decide next tile when near center
            const cx = this.player.tileX * TILE_SIZE + TILE_SIZE / 2;
            const cy = this.player.tileY * TILE_SIZE + TILE_SIZE / 2;

            const tol = Math.max(1, step + 0.25);
            if (Math.abs(this.playerSprite.x - cx) <= tol && Math.abs(this.playerSprite.y - cy) <= tol) {
                this.playerSprite.x = cx;
                this.playerSprite.y = cy;

                if (this.canMove(this.player.tileX, this.player.tileY, this.player.nextDirection)) {
                    this.player.direction = this.player.nextDirection;
                }

                // if blocked, stop advancing this substep loop
                if (!this.canMove(this.player.tileX, this.player.tileY, this.player.direction)) {
                    break;
                }

                // advance logical tile now that we committed to movement
                this.player.tileX += this.player.direction.x;
                this.player.tileY += this.player.direction.y;

                // apply wrap in tile-space too
                if (this.player.tileX < 0) this.player.tileX = this.levelCols - 1;
                else if (this.player.tileX >= this.levelCols) this.player.tileX = 0;
            }

            // Move pixel position
            const beforeX = this.playerSprite.x;
            const beforeY = this.playerSprite.y;

            this.playerSprite.x += this.player.direction.x * step;
            this.playerSprite.y += this.player.direction.y * step;

            this.handleTunnelWrap();
            this.collectDot(); // collect during movement so fast speeds don’t skip dots

            if (
                Math.abs(this.playerSprite.x - beforeX) > 0.01 ||
                Math.abs(this.playerSprite.y - beforeY) > 0.01
            ) {
                movedThisFrame = true;
            }
        }

        // ---- EAT SOUND RULE: only when MOVING + RECENTLY EATING ----
        const eatingRecently = this.time.now - this.lastEatTime < 140;

        if (movedThisFrame && eatingRecently) {
            if (this.eatSound.isPaused) this.eatSound.resume();
            else if (!this.eatSound.isPlaying) this.eatSound.play();
        } else {
            this.stopEatSound();
        }

        // ---- GHOSTS ----
        this.updateGhostMode(delta);

        const pacTile = {x: this.player.tileX, y: this.player.tileY};

        for (const g of this.ghosts) {
            g.setMode?.(this.ghostMode);
            g.update?.(delta, pacTile);
        }

        // ---- COLLISION ----
        if (this.checkGhostCollision()) {
            this.killPacman();
            this.drawPacman();
            return;
        }

        // ---- VISUALS ----
        this.animateMouth(movedThisFrame);
        this.drawPacman();
    }


// ================= DO NOT TOUCH (your drawLevel switch cases) =================
    drawLevel() {
        const graphics = this.add.graphics();
        const TILE = TILE_SIZE;

        for (let row = 0; row < level1.length; row++) {
            for (let col = 0; col < level1[row].length; col++) {
                const tile = level1[row][col];
                const baseX = col * TILE;
                const baseY = row * TILE;

                // Thick outer walls
                const thick = 4;
                // Thin inner maze walls
                const thin = 2;

                switch (tile) {
                    // ---- THIN CORNERS ----
                    case "┌":
                        graphics.lineStyle(thin, 0x0000ff, 1);
                        // middle bottom → center
                        graphics.strokeLineShape(
                            new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE, baseX + TILE / 2, baseY + TILE / 2)
                        );
                        // center → middle right
                        graphics.strokeLineShape(
                            new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE / 2, baseX + TILE, baseY + TILE / 2)
                        );
                        break;
                    case "┐":
                        graphics.lineStyle(thin, 0x0000ff, 1);
                        // middle bottom → center
                        graphics.strokeLineShape(
                            new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE, baseX + TILE / 2, baseY + TILE / 2)
                        );
                        // center → middle left
                        graphics.strokeLineShape(
                            new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE / 2, baseX, baseY + TILE / 2)
                        );
                        break;
                    case "└":
                        graphics.lineStyle(thin, 0x0000ff, 1);
                        // middle top → center
                        graphics.strokeLineShape(
                            new Phaser.Geom.Line(baseX + TILE / 2, baseY, baseX + TILE / 2, baseY + TILE / 2)
                        );
                        // center → middle right
                        graphics.strokeLineShape(
                            new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE / 2, baseX + TILE, baseY + TILE / 2)
                        );
                        break;
                    case "┘":
                        graphics.lineStyle(thin, 0x0000ff, 1);
                        // middle top → center
                        graphics.strokeLineShape(
                            new Phaser.Geom.Line(baseX + TILE / 2, baseY, baseX + TILE / 2, baseY + TILE / 2)
                        );
                        // center → middle left
                        graphics.strokeLineShape(
                            new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE / 2, baseX, baseY + TILE / 2)
                        );
                        break;

                    // ---- THIN HORIZONTAL & VERTICAL ----
                    case "-":
                        graphics.lineStyle(thin, 0x0000ff, 1);
                        graphics.strokeLineShape(new Phaser.Geom.Line(baseX, baseY + TILE / 2, baseX + TILE, baseY + TILE / 2));
                        break;
                    case "|":
                        graphics.lineStyle(thin, 0x0000ff, 1);
                        graphics.strokeLineShape(new Phaser.Geom.Line(baseX + TILE / 2, baseY, baseX + TILE / 2, baseY + TILE));
                        break;

                    // ---- THICK OUTER WALLS ----
                    case "╔": // top-left thick corner
                        graphics.lineStyle(thick, 0x0000ff, 1);
                        // middle bottom → center
                        graphics.strokeLineShape(
                            new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE, baseX + TILE / 2, baseY + TILE / 2)
                        );
                        // center → middle right
                        graphics.strokeLineShape(
                            new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE / 2, baseX + TILE, baseY + TILE / 2)
                        );
                        break;

                    case "╗": // top-right thick corner
                        graphics.lineStyle(thick, 0x0000ff, 1);
                        // middle bottom → center
                        graphics.strokeLineShape(
                            new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE, baseX + TILE / 2, baseY + TILE / 2)
                        );
                        // center → middle left
                        graphics.strokeLineShape(
                            new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE / 2, baseX, baseY + TILE / 2)
                        );
                        break;

                    case "╚": // bottom-left thick corner
                        graphics.lineStyle(thick, 0x0000ff, 1);
                        // middle top → center
                        graphics.strokeLineShape(
                            new Phaser.Geom.Line(baseX + TILE / 2, baseY, baseX + TILE / 2, baseY + TILE / 2)
                        );
                        // center → middle right
                        graphics.strokeLineShape(
                            new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE / 2, baseX + TILE, baseY + TILE / 2)
                        );
                        break;

                    case "╝": // bottom-right thick corner
                        graphics.lineStyle(thick, 0x0000ff, 1);
                        // middle top → center
                        graphics.strokeLineShape(
                            new Phaser.Geom.Line(baseX + TILE / 2, baseY, baseX + TILE / 2, baseY + TILE / 2)
                        );
                        // center → middle left
                        graphics.strokeLineShape(
                            new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE / 2, baseX, baseY + TILE / 2)
                        );
                        break;

                    case "═":
                        graphics.lineStyle(thick, 0x0000ff, 1);
                        graphics.strokeLineShape(new Phaser.Geom.Line(baseX, baseY + TILE / 2, baseX + TILE, baseY + TILE / 2));
                        break;
                    case "║":
                        graphics.lineStyle(thick, 0x0000ff, 1);
                        graphics.strokeLineShape(new Phaser.Geom.Line(baseX + TILE / 2, baseY, baseX + TILE / 2, baseY + TILE));
                        break;

                    case "~":
                        graphics.lineStyle(2, 0xffffff, 1);
                        graphics.strokeLineShape(
                            new Phaser.Geom.Line(baseX, baseY + TILE / 2, baseX + TILE, baseY + TILE / 2)
                        );
                        break;

                    // ---- EMPTY ----
                    case " ":
                    default:
                        break;
                }
            }
        }
    }
}
