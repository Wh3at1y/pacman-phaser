import Phaser from 'phaser';
import { level1 } from '../levels/level1';

const TILE_SIZE = 24;

const DIRECTIONS = {
    LEFT:  { x: -1, y: 0 },
    RIGHT: { x: 1,  y: 0 },
    UP:    { x: 0,  y: -1 },
    DOWN:  { x: 0,  y: 1 }
};

const WALLS = ["═","║","╔","╗","╚","╝","┌","┐","└","┘","|","-"];

export default class MainScene extends Phaser.Scene {
    constructor() {
        super('MainScene');
    }

    preload() {
        this.load.audio('roundStart', 'start.mp3', {volume: 0});
        this.load.audio('eat', 'eating.mp3');
    }

    create() {
        this.cameras.main.setZoom(1);

        /* ---------------- ROUND STATE ---------------- */
        this.round = 1;
        this.roundDelay = 2500;
        this.isRoundActive = false;

        this.originalLevel = level1.map(r => [...r]);

        /* ---------------- DOTS ---------------- */
        this.dots = this.add.group();
        this.dotPositions = [];
        this.dotsRemaining = 0;
        this.dotsCollected = 0;

        this.buildDotList();
        this.drawDots();

        /* ---------------- LEVEL ---------------- */
        this.drawLevel();

        /* ---------------- PLAYER ---------------- */
        this.player = {
            tileX: 14,
            tileY: 23,
            direction: DIRECTIONS.RIGHT,
            nextDirection: DIRECTIONS.RIGHT,
            speed: 200
        };

        this.playerSprite = this.physics.add.existing(
            this.add.circle(
                this.player.tileX * TILE_SIZE + TILE_SIZE / 2,
                this.player.tileY * TILE_SIZE + TILE_SIZE / 2,
                TILE_SIZE * 0.7,
                0xffff00
            )
        );
        this.playerSprite.body.setCollideWorldBounds(false);

        /* ---------------- INPUT ---------------- */
        this.cursors = this.input.keyboard.createCursorKeys();

        /* ---------------- UI ---------------- */
        const mapWidthPx = level1[0].length * TILE_SIZE;

        this.dotText = this.add.text(
            mapWidthPx + 10, 10,
            'Dots: 0',
            { fontSize: '18px', color: '#fff' }
        );

        this.roundText = this.add.text(
            mapWidthPx + 10, 36,
            `Round: ${this.round}`,
            { fontSize: '18px', color: '#fff' }
        );

        const { width, height } = this.scale;

        this.readyBg = this.add.rectangle(
            width / 2, height / 2, 220, 90, 0x000000
        ).setDepth(10).setVisible(false);

        this.readyText = this.add.text(
            width / 2, height / 2,
            'READY',
            { fontSize: '36px', color: '#00aaff', fontStyle: 'bold' }
        ).setOrigin(0.5).setDepth(11).setVisible(false);

        this.roundStartSound = this.sound.add('roundStart', { volume: 0.6 });

        this.eatSound = this.sound.add('eat', {
            loop: true,
            volume: 0.4
        });

        this.isEating = false;
        this.lastEatTime = 0;

        this.startRound();
    }

    /* ================= ROUND FLOW ================= */

    startRound() {
        this.isRoundActive = false;

        this.readyBg.setVisible(true);
        this.readyText.setVisible(true);
        this.roundStartSound.play();

        this.time.delayedCall(this.roundDelay, () => {
            this.readyBg.setVisible(false);
            this.readyText.setVisible(false);
            this.isRoundActive = true;
        });
    }

    endRound() {
        this.isRoundActive = false;

        this.time.delayedCall(500, () => {
            this.round++;
            this.roundText.setText(`Round: ${this.round}`);
            this.resetLevel();
            this.startRound();
        });
    }

    resetLevel() {
        for (let y = 0; y < this.originalLevel.length; y++) {
            for (let x = 0; x < this.originalLevel[y].length; x++) {
                level1[y][x] = this.originalLevel[y][x];
            }
        }

        if (this.eatSound.isPlaying) {
            this.eatSound.stop();
        }
        this.buildDotList();
        this.drawDots();

        this.player.tileX = 14;
        this.player.tileY = 23;
        this.player.direction = DIRECTIONS.RIGHT;
        this.player.nextDirection = DIRECTIONS.RIGHT;

        this.playerSprite.x = this.player.tileX * TILE_SIZE + TILE_SIZE / 2;
        this.playerSprite.y = this.player.tileY * TILE_SIZE + TILE_SIZE / 2;
    }

    /* ================= DOTS ================= */

    buildDotList() {
        this.dotPositions = [];
        this.dotsRemaining = 0;

        level1.forEach((row, y) => {
            row.forEach((tile, x) => {
                if (tile === '·' || tile === 'o') {
                    this.dotPositions.push({ x, y, type: tile });
                    this.dotsRemaining++;
                }
            });
        });
    }

    drawDots() {
        this.dots.clear(true, true);

        this.dotPositions.forEach(d => {
            const r = d.type === '·' ? TILE_SIZE * 0.1 : TILE_SIZE * 0.22;
            const c = this.add.circle(
                d.x * TILE_SIZE + TILE_SIZE / 2,
                d.y * TILE_SIZE + TILE_SIZE / 2,
                r, 0xffffff
            );
            c.setData('tileX', d.x);
            c.setData('tileY', d.y);
            this.dots.add(c);
        });
    }

    collectDot() {
        const tx = Math.floor(this.playerSprite.x / TILE_SIZE);
        const ty = Math.floor(this.playerSprite.y / TILE_SIZE);
        const tile = level1[ty]?.[tx];

        if (tile === '·' || tile === 'o') {
            level1[ty][tx] = ' ';
            const dot = this.dots.getChildren().find(
                d => d.getData('tileX') === tx && d.getData('tileY') === ty
            );
            if (dot) dot.destroy();

            this.dotsRemaining--;
            this.dotsCollected++;
            this.dotText.setText(`Dots: ${this.dotsCollected}`);

            this.lastEatTime = this.time.now;

            if (!this.eatSound.isPlaying) {
                this.eatSound.play({loop: true});
            }

            if (this.dotsRemaining === 0) {
                this.endRound();
            }
        }
    }

    /* ================= MOVEMENT ================= */

    canMove(tileX, tileY, dir) {
        const nx = tileX + dir.x;
        const ny = tileY + dir.y;

        if (nx < 0 || nx >= level1[0].length) return true;
        const tile = level1[ny]?.[nx];
        return tile && !WALLS.includes(tile);
    }

    handleTunnelWrap() {
        const w = level1[0].length * TILE_SIZE;

        if (this.playerSprite.x < 0) this.playerSprite.x += w;
        if (this.playerSprite.x >= w) this.playerSprite.x -= w;

        this.player.tileX = Math.floor(this.playerSprite.x / TILE_SIZE);
        this.player.tileY = Math.floor(this.playerSprite.y / TILE_SIZE);
    }

    handleInput() {
        if (this.cursors.left.isDown)  this.player.nextDirection = DIRECTIONS.LEFT;
        else if (this.cursors.right.isDown) this.player.nextDirection = DIRECTIONS.RIGHT;
        else if (this.cursors.up.isDown)    this.player.nextDirection = DIRECTIONS.UP;
        else if (this.cursors.down.isDown)  this.player.nextDirection = DIRECTIONS.DOWN;
    }

    update(time, delta) {
        if (!this.isRoundActive) return;

        this.handleInput();

        const move = (this.player.speed * delta) / 1000;
        const cx = this.player.tileX * TILE_SIZE + TILE_SIZE / 2;
        const cy = this.player.tileY * TILE_SIZE + TILE_SIZE / 2;

        let blockedThisFrame = false;

        // Grid alignment check
        if (
            Math.abs(this.playerSprite.x - cx) < 1 &&
            Math.abs(this.playerSprite.y - cy) < 1
        ) {
            this.playerSprite.x = cx;
            this.playerSprite.y = cy;

            // Attempt direction change
            if (this.canMove(this.player.tileX, this.player.tileY, this.player.nextDirection)) {
                this.player.direction = this.player.nextDirection;
            }

            // Hard wall stop
            if (!this.canMove(this.player.tileX, this.player.tileY, this.player.direction)) {
                blockedThisFrame = true;
            } else {
                // Advance logical tile
                this.player.tileX += this.player.direction.x;
                this.player.tileY += this.player.direction.y;
            }
        }

        // Apply movement only if not blocked
        if (!blockedThisFrame) {
            this.playerSprite.x += this.player.direction.x * move;
            this.playerSprite.y += this.player.direction.y * move;
        }

        // 🚨 IMMEDIATE sound stop if blocked
        if (blockedThisFrame && this.eatSound.isPlaying) {
            this.eatSound.stop();
        }

        // Collect dots AFTER movement
        this.collectDot();

        // Failsafe: stop sound if no recent eating
        if (this.eatSound.isPlaying) {
            if (this.time.now - this.lastEatTime > 120) {
                this.eatSound.stop();
            }
        }

        this.handleTunnelWrap();
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
