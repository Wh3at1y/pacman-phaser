import Phaser from 'phaser';
import { level1 } from '../levels/level1';

const TILE_SIZE = 24;

const DIRECTIONS = {
    LEFT: { x: -1, y: 0 },
    RIGHT: { x: 1, y: 0 },
    UP: { x: 0, y: -1 },
    DOWN: { x: 0, y: 1 }
};

export default class MainScene extends Phaser.Scene {
    constructor() {
        super('MainScene');
    }

    preload() {
        this.load.audio('roundStart', 'start.mp3');
    }

    startRound() {
        this.roundStartSound.play();

        this.isRoundActive = false;

        this.readyBg.setVisible(true);
        this.readyText.setVisible(true);

        this.player.direction = { x: 0, y: 0 };
        this.player.nextDirection = { x: 0, y: 0 };

        this.time.delayedCall(this.roundDelay, () => {
            this.readyBg.setVisible(false);
            this.readyText.setVisible(false);
            this.isRoundActive = true;
        });
    }

    create() {
        this.round = 1;
        this.isRoundActive = false;
        this.roundDelay = 2500; // 5 seconds

        this.roundInProgress = true;
        this.round = 1;
        this.dotsRemaining = 0;
        this.cameras.main.setZoom(1);
        this.originalLevel = level1.map(row => [...row]);


        // Preprocess level: walls and dots
        this.passable = [];
        this.dotPositions = [];
        const walls = ["═", "║", "╔", "╗", "╚", "╝", "┌", "┐", "└", "┘", "|", "-"];

        level1.forEach((row, y) => {
            this.passable[y] = [];
            row.forEach((tile, x) => {
                this.passable[y][x] = !walls.includes(tile);
                if (tile === "·" || tile === "o") {
                    this.dotPositions.push({ x, y, type: tile });
                }
            });
        });

        // Draw dots
        this.dots = this.add.group();
        this.drawDots();

        // Draw level
        this.drawLevel();

        // Player setup
        this.player = {
            tileX: 14,
            tileY: 23,
            direction: DIRECTIONS.RIGHT,
            nextDirection: DIRECTIONS.RIGHT,
            speed: 250
        };

        this.playerSprite = this.physics.add.existing(
            this.add.circle(
                this.player.tileX * TILE_SIZE + TILE_SIZE / 2,
                this.player.tileY * TILE_SIZE + TILE_SIZE / 2,
                TILE_SIZE * 0.7, // bigger than TILE_SIZE/2
                0xffff00
            )
        );
        this.playerSprite.body.setCollideWorldBounds(false);

        this.cursors = this.input.keyboard.createCursorKeys();

        this.dotsCollected = 0;

        // Display text
        this.dotText = this.add.text(
            level1[0].length * TILE_SIZE + 10, // x position just outside the map
            10,                                // y position
            `Dots: 0`,
            { font: '20px Arial', fill: '#ffffff' }
        );

        this.roundText = this.add.text(
            level1[0].length * TILE_SIZE + 10,
            40,
            `Round: ${this.round}`,
            { fontSize: '16px', fill: '#fff' }
        );

        const { width, height } = this.scale;

        this.readyBg = this.add.rectangle(
            width / 2,
            height / 2,
            200,
            80,
            0x000000
        ).setDepth(10).setVisible(false);

        this.readyText = this.add.text(
            width / 2,
            height / 2,
            "READY",
            {
                fontSize: "36px",
                color: "#00aaff",
                fontStyle: "bold"
            }
        ).setOrigin(0.5).setDepth(11).setVisible(false);
        this.roundStartSound = this.sound.add('roundStart', {
            volume: 0.6
        });
        this.startRound();

    }

    drawDots() {
        this.dots.clear(true, true);
        this.dotsRemaining = 0;

        this.dotPositions.forEach(dot => {
            const radius = dot.type === "·" ? TILE_SIZE * 0.1 : TILE_SIZE * 0.22;

            const sprite = this.add.circle(
                dot.x * TILE_SIZE + TILE_SIZE / 2,
                dot.y * TILE_SIZE + TILE_SIZE / 2,
                radius,
                0xffffff
            );

            sprite.setData('tileX', dot.x);
            sprite.setData('tileY', dot.y);
            this.dots.add(sprite);

            this.dotsRemaining++;
        });
    }

    checkRoundComplete() {
        if (!this.roundInProgress) return;

        if (this.dotsRemaining <= 0) {
            this.roundInProgress = false;
            this.time.delayedCall(500, () => {
                this.nextRound();
            });
        }
    }

    collectDotPixel() {
        const tileX = Math.floor(this.playerSprite.x / TILE_SIZE);
        const tileY = Math.floor(this.playerSprite.y / TILE_SIZE);

        const tile = level1[tileY]?.[tileX];
        if (tile === "·" || tile === "o") {
            level1[tileY][tileX] = " "; // remove dot

            const dot = this.dots.getChildren().find(d =>
                d.getData('tileX') === tileX &&
                d.getData('tileY') === tileY
            );

            if (dot) {
                dot.destroy();

                // Increment counter and update text
                this.dotsRemaining--;

                this.dotsCollected++;
                this.dotText.setText(`Dots: ${this.dotsCollected}`);

                if (this.dotsRemaining === 0) {
                    this.endRound();
                }
            }
        }
    }

    endRound() {
        if (!this.isRoundActive) return;

        this.isRoundActive = false;

        this.time.delayedCall(500, () => {
            this.round++;
            this.roundText.setText(`Round: ${this.round}`);
            this.nextRound();
        });
    }

    handleTunnelWrap() {
        const mapWidthPx = level1[0].length * TILE_SIZE;

        // Wrap horizontally
        if (this.playerSprite.x < 0) {
            this.playerSprite.x += mapWidthPx;
        } else if (this.playerSprite.x >= mapWidthPx) {
            this.playerSprite.x -= mapWidthPx;
        }

        // Update logical tile coordinates
        this.player.tileX = Math.floor(this.playerSprite.x / TILE_SIZE);
        this.player.tileY = Math.floor(this.playerSprite.y / TILE_SIZE);
    }

    canMove(tileX, tileY, direction) {
        const newX = tileX + direction.x;
        const newY = tileY + direction.y;

        // Check horizontal warp allowance
        const mapWidth = level1[0].length;
        if (newX < 0 || newX >= mapWidth) return true; // allow warp at edges

        const tile = level1[newY]?.[newX];
        const walls = ["═", "║", "╔", "╗", "╚", "╝", "┌", "┐", "└", "┘", "|", "-"];
        return tile && !walls.includes(tile);
    }

    update(time, delta) {
        // ALWAYS allow round-complete checks
        this.collectDotPixel();

        // Block movement ONLY
        if (!this.isRoundActive) return;

        this.handleInput();

        const moveAmount = (this.player.speed * delta) / 1000;
        const centerX = this.player.tileX * TILE_SIZE + TILE_SIZE / 2;
        const centerY = this.player.tileY * TILE_SIZE + TILE_SIZE / 2;

        if (
            Math.abs(this.playerSprite.x - centerX) < 1 &&
            Math.abs(this.playerSprite.y - centerY) < 1
        ) {
            this.playerSprite.x = centerX;
            this.playerSprite.y = centerY;

            if (this.canMove(this.player.tileX, this.player.tileY, this.player.nextDirection)) {
                this.player.direction = this.player.nextDirection;
            }

            if (!this.canMove(this.player.tileX, this.player.tileY, this.player.direction)) {
                return;
            }

            this.player.tileX += this.player.direction.x;
            this.player.tileY += this.player.direction.y;
        }

        this.playerSprite.x += this.player.direction.x * moveAmount;
        this.playerSprite.y += this.player.direction.y * moveAmount;

        this.handleTunnelWrap();
    }

    nextRound() {
        // Restore level data
        for (let y = 0; y < this.originalLevel.length; y++) {
            for (let x = 0; x < this.originalLevel[y].length; x++) {
                level1[y][x] = this.originalLevel[y][x];
            }
        }

        // Rebuild dots
        this.dotPositions = [];
        level1.forEach((row, y) => {
            row.forEach((tile, x) => {
                if (tile === "·" || tile === "o") {
                    this.dotPositions.push({ x, y, type: tile });
                }
            });
        });

        this.drawDots();

        // Reset Pac-Man
        this.player.tileX = 14;
        this.player.tileY = 23;
        this.player.direction = DIRECTIONS.RIGHT;
        this.player.nextDirection = DIRECTIONS.RIGHT;

        this.playerSprite.x = this.player.tileX * TILE_SIZE + TILE_SIZE / 2;
        this.playerSprite.y = this.player.tileY * TILE_SIZE + TILE_SIZE / 2;

        // Start READY delay
        this.startRound();
    }


    resetLevelDots() {
        this.dotPositions = [];

        level1.forEach((row, y) => {
            row.forEach((tile, x) => {
                if (tile === "·" || tile === "o") {
                    this.dotPositions.push({ x, y, type: tile });
                }
            });
        });

        this.drawDots();
    }

    handleInput() {
        if (this.cursors.left.isDown) this.player.nextDirection = DIRECTIONS.LEFT;
        else if (this.cursors.right.isDown) this.player.nextDirection = DIRECTIONS.RIGHT;
        else if (this.cursors.up.isDown) this.player.nextDirection = DIRECTIONS.UP;
        else if (this.cursors.down.isDown) this.player.nextDirection = DIRECTIONS.DOWN;
    }

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
                        graphics.strokeLineShape(new Phaser.Geom.Line(
                            baseX + TILE / 2, baseY + TILE,
                            baseX + TILE / 2, baseY + TILE / 2
                        ));
                        // center → middle right
                        graphics.strokeLineShape(new Phaser.Geom.Line(
                            baseX + TILE / 2, baseY + TILE / 2,
                            baseX + TILE, baseY + TILE / 2
                        ));
                        break;
                    case "┐":
                        graphics.lineStyle(thin, 0x0000ff, 1);
                        // middle bottom → center
                        graphics.strokeLineShape(new Phaser.Geom.Line(
                            baseX + TILE / 2, baseY + TILE,
                            baseX + TILE / 2, baseY + TILE / 2
                        ));
                        // center → middle left
                        graphics.strokeLineShape(new Phaser.Geom.Line(
                            baseX + TILE / 2, baseY + TILE / 2,
                            baseX, baseY + TILE / 2
                        ));
                        break;
                    case "└":
                        graphics.lineStyle(thin, 0x0000ff, 1);
                        // middle top → center
                        graphics.strokeLineShape(new Phaser.Geom.Line(
                            baseX + TILE / 2, baseY,
                            baseX + TILE / 2, baseY + TILE / 2
                        ));
                        // center → middle right
                        graphics.strokeLineShape(new Phaser.Geom.Line(
                            baseX + TILE / 2, baseY + TILE / 2,
                            baseX + TILE, baseY + TILE / 2
                        ));
                        break;
                    case "┘":
                        graphics.lineStyle(thin, 0x0000ff, 1);
                        // middle top → center
                        graphics.strokeLineShape(new Phaser.Geom.Line(
                            baseX + TILE / 2, baseY,
                            baseX + TILE / 2, baseY + TILE / 2
                        ));
                        // center → middle left
                        graphics.strokeLineShape(new Phaser.Geom.Line(
                            baseX + TILE / 2, baseY + TILE / 2,
                            baseX, baseY + TILE / 2
                        ));
                        break;

                    // ---- THIN HORIZONTAL & VERTICAL ----
                    case "-":
                        graphics.lineStyle(thin, 0x0000ff, 1);
                        graphics.strokeLineShape(new Phaser.Geom.Line(
                            baseX, baseY + TILE / 2,
                            baseX + TILE, baseY + TILE / 2
                        ));
                        break;
                    case "|":
                        graphics.lineStyle(thin, 0x0000ff, 1);
                        graphics.strokeLineShape(new Phaser.Geom.Line(
                            baseX + TILE / 2, baseY,
                            baseX + TILE / 2, baseY + TILE
                        ));
                        break;

                    // ---- THICK OUTER WALLS ----
                    case "╔": // top-left thick corner
                        graphics.lineStyle(thick, 0x0000ff, 1);
                        // middle bottom → center
                        graphics.strokeLineShape(new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE, baseX + TILE / 2, baseY + TILE / 2));
                        // center → middle right
                        graphics.strokeLineShape(new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE / 2, baseX + TILE, baseY + TILE / 2));
                        break;

                    case "╗": // top-right thick corner
                        graphics.lineStyle(thick, 0x0000ff, 1);
                        // middle bottom → center
                        graphics.strokeLineShape(new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE, baseX + TILE / 2, baseY + TILE / 2));
                        // center → middle left
                        graphics.strokeLineShape(new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE / 2, baseX, baseY + TILE / 2));
                        break;

                    case "╚": // bottom-left thick corner
                        graphics.lineStyle(thick, 0x0000ff, 1);
                        // middle top → center
                        graphics.strokeLineShape(new Phaser.Geom.Line(baseX + TILE / 2, baseY, baseX + TILE / 2, baseY + TILE / 2));
                        // center → middle right
                        graphics.strokeLineShape(new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE / 2, baseX + TILE, baseY + TILE / 2));
                        break;

                    case "╝": // bottom-right thick corner
                        graphics.lineStyle(thick, 0x0000ff, 1);
                        // middle top → center
                        graphics.strokeLineShape(new Phaser.Geom.Line(baseX + TILE / 2, baseY, baseX + TILE / 2, baseY + TILE / 2));
                        // center → middle left
                        graphics.strokeLineShape(new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE / 2, baseX, baseY + TILE / 2));
                        break;

                    case "═":
                        graphics.lineStyle(thick, 0x0000ff, 1);
                        graphics.strokeLineShape(new Phaser.Geom.Line(
                            baseX, baseY + TILE / 2,
                            baseX + TILE, baseY + TILE / 2
                        ));
                        break;
                    case "║":
                        graphics.lineStyle(thick, 0x0000ff, 1);
                        graphics.strokeLineShape(new Phaser.Geom.Line(
                            baseX + TILE / 2, baseY,
                            baseX + TILE / 2, baseY + TILE
                        ));
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
