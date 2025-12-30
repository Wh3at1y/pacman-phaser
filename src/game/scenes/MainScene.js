import Phaser from "phaser";
import { level1 } from "../levels/level1";
import Ghost from "../Ghost";

const TILE_SIZE = 24;

const walls = ["═", "║", "╔", "╗", "╚", "╝", "┌", "┐", "└", "┘", "|", "-"];

export default class MainScene extends Phaser.Scene {
    constructor(onHudUpdate) {
        super("MainScene");
        this.onHudUpdate = onHudUpdate; // may be undefined if not provided
    }

    preload() {
        this.load.audio("roundStart", "start.mp3");
        this.load.audio("eat", "eating.mp3");
        this.load.audio("dead", "dead.mp3");
    }

    create() {
        this.TILE_SIZE = TILE_SIZE;
        this.levelCols = level1[0].length;
        this.levelRows = level1.length;

        this.cameras.main.setZoom(1);

        this.isDying = false;
        this.deathDelayMs = 4000; // tweak if you want


        // ---- ROUND STATE ----
        this.round = this.registry.get("round") ?? 1;
        this.registry.set("round", this.round);
        this.isRoundActive = false;

        // ---- DOT TRACKING ----
        this.dotsRemaining = 0;
        this.dots = this.add.group();

        // ---- BUILD MAP LOGIC ----
        this.passable = [];

        level1.forEach((row, y) => {
            this.passable[y] = [];
            row.forEach((tile, x) => {
                this.passable[y][x] = !walls.includes(tile);

                if (tile === "·" || tile === "o") {
                    const dot = this.add.circle(
                        x * TILE_SIZE + TILE_SIZE / 2,
                        y * TILE_SIZE + TILE_SIZE / 2,
                        tile === "o" ? TILE_SIZE * 0.22 : TILE_SIZE * 0.1,
                        0xffffff
                    );
                    dot.setData("type", tile === "o" ? "power" : "normal");
                    this.dots.add(dot);
                    this.dotsRemaining++;
                }
            });
        });

        // ---- BUILD GHOST HOUSE REGION (flood fill) ----
// We treat "~" as a boundary (door), not part of inside.
// Find a "~" tile, then take the tile BELOW it as the inside start.
        this.ghostHouse = Array.from({ length: this.levelRows }, () =>
            Array(this.levelCols).fill(false)
        );

        let start = null;
        for (let y = 0; y < this.levelRows; y++) {
            for (let x = 0; x < this.levelCols; x++) {
                if (level1[y][x] === "~") {
                    const sy = y + 1; // inside is below in your map
                    if (level1[sy]?.[x] && !["═","║","╔","╗","╚","╝","┌","┐","└","┘","|","-","~"].includes(level1[sy][x])) {
                        start = { x, y: sy };
                        break;
                    }
                }
            }
            if (start) break;
        }

        if (start) {
            const stack = [start];
            this.ghostHouse[start.y][start.x] = true;

            while (stack.length) {
                const p = stack.pop();
                const dirs = [{x:1,y:0},{x:-1,y:0},{x:0,y:1},{x:0,y:-1}];

                for (const d of dirs) {
                    const nx = p.x + d.x;
                    const ny = p.y + d.y;
                    if (nx < 0 || ny < 0 || nx >= this.levelCols || ny >= this.levelRows) continue;
                    if (this.ghostHouse[ny][nx]) continue;

                    const t = level1[ny][nx];
                    // Stop flood at walls + door
                    if (["═","║","╔","╗","╚","╝","┌","┐","└","┘","|","-","~"].includes(t)) continue;

                    this.ghostHouse[ny][nx] = true;
                    stack.push({ x: nx, y: ny });
                }
            }
        }


        // ---- DRAW LEVEL ----
        this.drawLevel();

        // ---- PLAYER LOGIC ----
        this.player = {
            tileX: 13,
            tileY: 23,
            direction: { x: 1, y: 0 },
            nextDirection: { x: 1, y: 0 },
            speed: 200,
        };

        this.playerSprite = {
            x: this.player.tileX * TILE_SIZE + TILE_SIZE / 2,
            y: this.player.tileY * TILE_SIZE + TILE_SIZE / 2,
        };

        // ---- PACMAN GRAPHICS ----
        this.playerGraphics = this.add.graphics();
        this.playerGraphics.setPosition(this.playerSprite.x, this.playerSprite.y);

        // ---- MOUTH ANIMATION ----
        this.mouthAngle = 0.5;
        this.mouthOpening = true;
        this.mouthSpeed = 0.1;

        // ---- INPUT ----
        this.cursors = this.input.keyboard.createCursorKeys();

        // ---- AUDIO ----
        this.eatSound = this.sound.add("eat", { loop: true, volume: 0.2 });
        this.lastEatTime = 0;

        // ---- SCORE ----
        this.score = this.registry.get("score") ?? 0;
        this.registry.set("score", this.score);
        this.dotsCollected = 0;

        // ---- GHOST MODE TIMER (simple classic loop) ----
        this.ghostMode = "scatter"; // "scatter" | "chase"
        this.ghostModeElapsed = 0;

        // ---- GHOSTS ----
        // Pick passable starting tiles (IMPORTANT: these must be walkable in your map).
        // If your center house isn’t passable, they’ll snap to nearest passable.
        this.ghosts = [
            new Ghost(this, {
                name: "blinky",
                color: 0xff0000,
                startTile: { x: 14, y: 11 },
                scatterTarget: { x: this.levelCols - 2, y: 1 }, // ✅ top-right
                speed: 155,
            }),
            new Ghost(this, {
                name: "pinky",
                color: 0xffb8ff,
                startTile: { x: 14, y: 11 },
                scatterTarget: { x: 1, y: 1 }, // ✅ top-left
                speed: 140,
            }),
            new Ghost(this, {
                name: "inky",
                color: 0x00ffff,
                startTile: { x: 13, y: 12 },
                scatterTarget: { x: this.levelCols - 2, y: this.levelRows - 2 }, // ✅ bottom-right
                speed: 130,
            }),
            new Ghost(this, {
                name: "clyde",
                color: 0xffb852,
                startTile: { x: 14, y: 12 },
                scatterTarget: { x: 1, y: this.levelRows - 2 }, // ✅ bottom-left
                speed: 120,
            }),
        ];


        this.onHudUpdate?.({
            score: this.score,
            dotsCollected: this.dotsCollected,
            dotsRemaining: this.dotsRemaining,
            round: this.round,
        });

        this.startRound();
    }

    checkGhostCollision() {
        if (this.isDying) return false;

        // Pac-Man tile
        const px = this.player.tileX;
        const py = this.player.tileY;

        // Optional: pixel-based radius to catch mid-tile overlaps
        const pacX = this.playerSprite.x;
        const pacY = this.playerSprite.y;
        const hitDist = TILE_SIZE * 0.55; // tune

        for (const g of this.ghosts) {
            // Tile overlap (fast + stable)
            if (g.tileX === px && g.tileY === py) return true;

            // Pixel proximity (feels better during motion)
            const dx = g.x - pacX;
            const dy = g.y - pacY;
            if ((dx * dx + dy * dy) <= hitDist * hitDist) return true;
        }

        return false;
    }

    killPacman() {
        if (this.isDying) return;
        this.isDying = true;
        this.sound.play("dead", { volume: 0.5})

        // stop gameplay + audio immediately
        this.isRoundActive = false;
        this.stopEatSound?.();

        // reset after a short delay
        this.time.delayedCall(this.deathDelayMs, () => {
            // easiest + most reliable reset: restart the scene
            // (your round reset logic already works there)
            this.scene.restart();
        });
    }


    /* ================= ROUND FLOW ================= */

    startRound() {
        this.stopEatSound(); // ensure silence during READY
        this.isRoundActive = false;

        this.time.delayedCall(2000, () => {
            this.isRoundActive = true;
            // reset mode timer each round start if you want
            this.ghostMode = "scatter";
            this.ghostModeElapsed = 0;
        });

        this.sound.play("roundStart", { volume: 0.2 });
    }

    endRound() {
        this.stopEatSound();
        this.isRoundActive = false;

        this.round = (this.registry.get("round") ?? 1) + 1;
        this.registry.set("round", this.round);

        this.onHudUpdate?.({ round: this.round });
        this.scene.restart();
    }

    stopEatSound() {
        if (!this.eatSound) return;
        if (this.eatSound.isPlaying || this.eatSound.isPaused) {
            this.eatSound.stop();
        }
    }

    /* ================= DOTS ================= */

    collectDot() {
        const px = this.playerSprite.x;
        const py = this.playerSprite.y;

        this.dots.children.iterate((dot) => {
            if (!dot || !dot.active) return;

            const dist = Phaser.Math.Distance.Between(px, py, dot.x, dot.y);

            if (dist < TILE_SIZE * 0.35) {
                const type = dot.getData("type") || "normal";
                dot.destroy();

                const points = type === "power" ? 50 : 10;
                this.score += points;
                this.registry.set("score", this.score);

                this.dotsCollected++;
                this.dotsRemaining--;

                this.lastEatTime = this.time.now;
                if (!this.eatSound.isPlaying) {
                    this.eatSound.play();
                }

                this.onHudUpdate?.({
                    score: this.score,
                    dotsCollected: this.dotsCollected,
                    dotsRemaining: this.dotsRemaining,
                });

                if (this.dotsRemaining <= 0) {
                    this.endRound();
                }
            }
        });
    }

    animateMouth(moving) {
        if (!moving) {
            this.mouthAngle = 0.01;
            return;
        }

        if (this.mouthOpening) {
            this.mouthAngle += this.mouthSpeed;
            if (this.mouthAngle >= 0.65) this.mouthOpening = false;
        } else {
            this.mouthAngle -= this.mouthSpeed;
            if (this.mouthAngle <= 0.05) this.mouthOpening = true;
        }
    }

    drawPacman() {
        const g = this.playerGraphics;
        g.clear();

        let rot = 0;
        if (this.player.direction.x === -1) rot = Math.PI;
        else if (this.player.direction.y === -1) rot = -Math.PI / 2;
        else if (this.player.direction.y === 1) rot = Math.PI / 2;

        g.fillStyle(0xffff00, 1);
        g.slice(0, 0, TILE_SIZE * 0.7, this.mouthAngle, Math.PI * 2 - this.mouthAngle, false);
        g.fillPath();
        g.rotation = rot;
    }

    /* ================= MOVEMENT ================= */

    canMove(tileX, tileY, direction) {
        const cols = level1[0].length;
        const rows = level1.length;

        let newX = tileX + direction.x;
        const newY = tileY + direction.y;

        // If we’re going off the left/right edge, treat it as wrapping
        if (newX < 0) newX = cols - 1;
        else if (newX >= cols) newX = 0;

        // block vertical out-of-bounds (top/bottom should NOT wrap)
        if (newY < 0 || newY >= rows) return false;

        const tile = level1[newY][newX];
        const walls = ["═","║","╔","╗","╚","╝","┌","┐","└","┘","|","-"];

        // Passable if not a wall
        return !walls.includes(tile);
    }

    handleTunnelWrap() {
        const cols = level1[0].length;
        const mapWidthPx = cols * TILE_SIZE;

        if (this.playerSprite.x < -TILE_SIZE / 2) {
            this.playerSprite.x = mapWidthPx + TILE_SIZE / 2;
        } else if (this.playerSprite.x > mapWidthPx + TILE_SIZE / 2) {
            this.playerSprite.x = -TILE_SIZE / 2;
        }

        // keep logical tile in sync every frame
        this.player.tileX = Math.floor(this.playerSprite.x / TILE_SIZE);
        this.player.tileY = Math.floor(this.playerSprite.y / TILE_SIZE);
    }

    handleInput() {
        if (this.cursors.left.isDown) this.player.nextDirection = { x: -1, y: 0 };
        else if (this.cursors.right.isDown) this.player.nextDirection = { x: 1, y: 0 };
        else if (this.cursors.up.isDown) this.player.nextDirection = { x: 0, y: -1 };
        else if (this.cursors.down.isDown) this.player.nextDirection = { x: 0, y: 1 };
    }

    getPacmanTile() {
        return {
            x: Math.floor(this.playerSprite.x / TILE_SIZE),
            y: Math.floor(this.playerSprite.y / TILE_SIZE),
        };
    }

    updateGhostMode(delta) {
        // simple “classic-ish” loop:
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

    isWallTile(tile) {
        // pacman walls + ghost-door
        return ["═","║","╔","╗","╚","╝","┌","┐","└","┘","|","-","~"].includes(tile);
    }

    isPacmanPassable(tx, ty) {
        const tile = level1[ty]?.[tx];
        if (!tile) return false;
        return !this.isWallTile(tile);
    }

// Ghost one-way passability: can EXIT via "~" but cannot ENTER via "~"
    isGhostPassable(fromX, fromY, toX, toY) {
        // allow tunnel wrap in tile-space
        const cols = this.levelCols;
        if (toX < 0) toX = cols - 1;
        else if (toX >= cols) toX = 0;

        const fromTile = level1[fromY]?.[fromX];
        const toTile = level1[toY]?.[toX];
        if (!toTile) return false;

        // normal walls block ghosts too
        if (["═","║","╔","╗","╚","╝","┌","┐","└","┘","|","-"].includes(toTile)) return false;

        // door rule
        if (toTile === "~") {
            // only allowed if coming FROM inside the house (or already on a door tile)
            const fromInside = !!this.ghostHouse?.[fromY]?.[fromX];
            return fromInside || fromTile === "~";
        }

        // stepping into the house interior from outside is blocked (prevents re-entry)
        const toInside = !!this.ghostHouse?.[toY]?.[toX];
        const fromInside = !!this.ghostHouse?.[fromY]?.[fromX];
        if (!fromInside && toInside) return false;

        return true;
    }


    update(time, delta) {
        this.collectDot();

        if (!this.isRoundActive) {
            this.stopEatSound();
            this.drawPacman();
            return;
        }

        if (this.isDying) {
            this.stopEatSound?.();
            this.drawPacman();
            return;
        }

        this.handleInput();

        const move = (this.player.speed * delta) / 1000;
        const cx = this.player.tileX * TILE_SIZE + TILE_SIZE / 2;
        const cy = this.player.tileY * TILE_SIZE + TILE_SIZE / 2;

        let blockedThisFrame = false;

        if (Math.abs(this.playerSprite.x - cx) < 1 && Math.abs(this.playerSprite.y - cy) < 1) {
            this.playerSprite.x = cx;
            this.playerSprite.y = cy;

            if (this.canMove(this.player.tileX, this.player.tileY, this.player.nextDirection)) {
                this.player.direction = this.player.nextDirection;
            }

            if (!this.canMove(this.player.tileX, this.player.tileY, this.player.direction)) {
                blockedThisFrame = true;
            } else {
                this.player.tileX += this.player.direction.x;
                this.player.tileY += this.player.direction.y;
            }
        }

        const beforeX = this.playerSprite.x;
        const beforeY = this.playerSprite.y;

        if (!blockedThisFrame) {
            this.playerSprite.x += this.player.direction.x * move;
            this.playerSprite.y += this.player.direction.y * move;
        }

        this.handleTunnelWrap();

        const movedThisFrame =
            Math.abs(this.playerSprite.x - beforeX) > 0.05 || Math.abs(this.playerSprite.y - beforeY) > 0.05;

        const eatingRecently = this.time.now - this.lastEatTime < 140;

        if (movedThisFrame && eatingRecently) {
            if (this.eatSound.isPaused) this.eatSound.resume();
            else if (!this.eatSound.isPlaying) this.eatSound.play();
        } else {
            this.stopEatSound();
        }

        // ---- GHOSTS ----
        this.updateGhostMode(delta);
        const pacTile = this.getPacmanTile();

        for (const g of this.ghosts) {
            g.setMode(this.ghostMode);
            g.update(delta, pacTile);
        }

        if (this.checkGhostCollision()) {
            this.killPacman();
            this.drawPacman();
            return;
        }

        // Visuals
        this.playerGraphics.setPosition(this.playerSprite.x, this.playerSprite.y);
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
                            new Phaser.Geom.Line(
                                baseX,
                                baseY + TILE / 2,
                                baseX + TILE,
                                baseY + TILE / 2
                            )
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
