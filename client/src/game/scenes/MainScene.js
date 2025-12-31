import Phaser from "phaser";
import { level1 } from "../levels/level1";
import Ghost from "../Ghost";
import Player from "../Player";
import socket from "../../socket.js";

const TILE_SIZE = 24;

// Up to 4 Pac-Men (same properties, different controls + spawn tiles)
const MAX_PLAYERS = 4;
const PACMAN_START_TILES = [
    { x: 13, y: 23 }, // P1
    { x: 10, y: 23 }, // P2
    { x: 16, y: 23 }, // P3
    { x: 13, y: 26 }, // P4
];

const colors = [0xffff00, 0x800080, 0xffffff, 0x008000];

// Wall symbols (your ASCII maze)
const WALL_TILES = ["═", "║", "╔", "╗", "╚", "╝", "┌", "┐", "└", "┘", "|", "-", "~"];

export default class MainScene extends Phaser.Scene {
    constructor(onHudUpdate, players, currentPlayer) {
        super("MainScene");
        this.onHudUpdate = onHudUpdate;
        this.currentPlayers = players;
        this.currentPlayer = currentPlayer;
        this.socket = socket;
    }

    preload() {
        this.load.audio("roundStart", "start.wav");
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

        this.registry.set("numPlayers", this.currentPlayers.length);
        this.numPlayers = Math.max(1, Math.min(MAX_PLAYERS, this.registry.get("numPlayers") ?? 1));
        this.registry.set("numPlayers", this.numPlayers);

        this.registry.set("round", this.round);
        this.registry.set("score", this.score);

        this.dotsRemaining = 0;
        this.dotsCollected = 0;

        // ---- DOTS ----
        this.dots = this.add.group();
        this.dotMap = new Map(); // key: "x,y" -> dot

        // ---- GHOST MODE STATE ----
        this.ghostMode = "scatter";
        this.ghostModeElapsed = 0;

        // frightened state
        this.frightenedUntil = 0;
        this.frightenedMs = 7000;

        // ---- AUDIO ----
        this.roundStartSound = this.sound.add("roundStart", { volume: 0.1 });
        this.eatSound = this.sound.add("eatLoop", { loop: true, volume: 0.1 });
        this.deadSound = this.sound.add("dead", { volume: 0.1 });
        this.lastEatTime = -999999;

        // ---- PLAYERS ----
        this.players = [];
        for (let i = 0; i < this.numPlayers; i++) {
            const startTile = PACMAN_START_TILES[i] ?? PACMAN_START_TILES[0];

            // Only the local player gets keyboard controls
            let controls = null;
            if (this.currentPlayers[i]?.socketId === this.currentPlayer.socketId) {
                controls = this.input.keyboard.createCursorKeys();
            }

            const p = new Player(this, {
                startTile,
                speed: 160,
                radius: TILE_SIZE * 0.7,
                controls,
                socketId: this.currentPlayers[i]?.socketId,
                color: colors[i],
                isRemote: this.currentPlayers[i]?.socketId !== this.currentPlayer.socketId,
            });

            p.graphics.setDepth(1001);
            this.players.push(p);
        }

        // ---- NETWORKING ----
        // Key idea:
        // - Send INPUT immediately (keydown) so intent is shared quickly.
        // - Send STATE at ~20hz (50ms) so remote clients can interpolate smoothly.
        this.inputSeq = 0;
        this.stateSeq = 0;

        this._onKeyDown = (event) => {
            const code = event.code;
            const isArrow =
                code === "ArrowUp" || code === "ArrowDown" || code === "ArrowLeft" || code === "ArrowRight";
            if (!isArrow) return;

            this.socket.emit("KeyPressed", {
                socketId: this.currentPlayer.socketId,
                dir: code,
                seq: ++this.inputSeq,
            });
        };

        this.input.keyboard.on("keydown", this._onKeyDown);

        this._onKeyPressed = ({ socketId, dir, seq }) => {
            if (socketId === this.currentPlayer.socketId) return;

            const p = this.players.find((pl) => pl.socketId === socketId);
            if (!p) return;

            p.lastInputSeq = p.lastInputSeq ?? 0;
            if (seq != null && seq <= p.lastInputSeq) return;
            if (seq != null) p.lastInputSeq = seq;

            p.setNextDirection(dir); // ArrowUp etc
        };
        this.socket.on("KeyPressed", this._onKeyPressed);

        // State tick: send our *pixel* position too, so remote doesn't "teleport tile centers".
        this.netTick = this.time.addEvent({
            delay: 50,
            loop: true,
            callback: () => {
                const p = this.getLocalPlayer();
                if (!p) return;

                this.socket.emit("PlayerState", {
                    socketId: p.socketId,
                    x: p.sprite.x,
                    y: p.sprite.y,
                    tileX: p.tileX,
                    tileY: p.tileY,
                    dir: p.direction,
                    nextDir: p.nextDirection,
                    seq: ++this.stateSeq,
                });
            },
        });

        this._onPlayerState = (state) => {
            const { socketId, x, y, tileX, tileY, dir, nextDir, seq } = state ?? {};
            if (!socketId || socketId === this.currentPlayer.socketId) return;

            const p = this.players.find((pl) => pl.socketId === socketId);
            if (!p) return;

            p.lastStateSeq = p.lastStateSeq ?? 0;
            if (seq != null && seq <= p.lastStateSeq) return;
            if (seq != null) p.lastStateSeq = seq;

            // Snapshot time is *local receive time* for consistent interpolation.
            p.pushNetSnapshot({
                t: this.time.now,
                x: typeof x === "number" ? x : tileX * TILE_SIZE + TILE_SIZE / 2,
                y: typeof y === "number" ? y : tileY * TILE_SIZE + TILE_SIZE / 2,
                tileX,
                tileY,
                dir,
                nextDir,
            });
        };
        this.socket.on("PlayerState", this._onPlayerState);

        this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
            this.input.keyboard.off("keydown", this._onKeyDown);
            this.socket.off("KeyPressed", this._onKeyPressed);
            this.socket.off("PlayerState", this._onPlayerState);
            this.netTick?.remove?.();
        });

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
            .text((this.levelCols * TILE_SIZE) / 2, (this.levelRows * TILE_SIZE) / 2, "READY!", {
                fontFamily: "Arial",
                fontSize: "28px",
                color: "#00aaff",
                fontStyle: "bold",
            })
            .setOrigin(0.5)
            .setDepth(1001)
            .setVisible(false);

        // ---- Build dot sprites from level ----
        this.buildDotsFromLevel();

        // ---- LEVEL RENDER ----
        this.drawLevel();

        // ---- GHOST HOUSE REGION (optional hook) ----
        this.buildGhostHouseRegion?.();

        // ---- GHOSTS ----
        this.ghosts = [
            new Ghost(this, {
                name: "blinky",
                color: 0xff0000,
                startTile: { x: 13, y: 13 },
                scatterTarget: { x: this.levelCols - 2, y: 1 },
                speed: 145,
            }),
            new Ghost(this, {
                name: "pinky",
                color: 0xffb8ff,
                startTile: { x: 14, y: 14 },
                scatterTarget: { x: 1, y: 1 },
                speed: 145,
            }),
            new Ghost(this, {
                name: "inky",
                color: 0x00ffff,
                startTile: { x: 12, y: 14 },
                scatterTarget: { x: this.levelCols - 2, y: this.levelRows - 2 },
                speed: 145,
            }),
            new Ghost(this, {
                name: "clyde",
                color: 0xffb852,
                startTile: { x: 16, y: 14 },
                scatterTarget: { x: 1, y: this.levelRows - 2 },
                speed: 145,
            }),
        ];

        // ---- GHOST HOUSE SETUP (release schedule) ----
        const houseInfo = this._buildGhostHouseInfo();

        const releaseByName = {
            blinky: 1000,
            pinky: 1500,
            inky: 4500,
            clyde: 7500,
        };

        for (const g of this.ghosts) {
            g.configureHouse?.({
                ...houseInfo,
                releaseDelayMs: releaseByName[g.name] ?? 0,
            });
        }



        // ---- HUD ----
        this.onHudUpdate?.({
            score: this.score,
            dotsCollected: this.dotsCollected,
            dotsRemaining: this.dotsRemaining,
            round: this.round,
            numPlayers: this.numPlayers,
        });

        this.startRound();
    }

    /* ===============================
       HELPERS
    =============================== */

    getLocalPlayer() {
        return this.players.find((p) => p.socketId === this.currentPlayer.socketId) ?? this.players[0];
    }

    isWallTile(tile) {
        return WALL_TILES.includes(tile);
    }

    isGhostHouseTile(x, y) {
        return level1?.[y]?.[x] === "X";
    }

    _buildGhostHouseInfo() {
        // Door tiles are the '~' tiles
        const doorTiles = [];
        let minHouseY = Infinity;
        let maxHouseY = -Infinity;

        for (let y = 0; y < this.levelRows; y++) {
            for (let x = 0; x < this.levelCols; x++) {
                const t = level1[y][x];
                if (t === "~") doorTiles.push({ x, y });
                if (t === "X") {
                    minHouseY = Math.min(minHouseY, y);
                    maxHouseY = Math.max(maxHouseY, y);
                }
            }
        }

        // Exit tile: just above the left door tile (works with your map)
        // Doors are at (13,12) and (14,12) in your level. :contentReference[oaicite:2]{index=2}
        const leftDoor = doorTiles.slice().sort((a, b) => a.x - b.x)[0];
        const exitTile = leftDoor ? { x: leftDoor.x, y: leftDoor.y - 1 } : null;

        return {
            doorTiles,
            exitTile,
            inHouseMinY: minHouseY === Infinity ? null : minHouseY,
            inHouseMaxY: maxHouseY === -Infinity ? null : maxHouseY,
        };
    }


    // Ghost-specific passability rules.
    // Ghost.js calls this as: isGhostPassable(fromX, fromY, toX, toY)
    // - Wraps horizontally (tunnel)
    // - Blocks solid walls
    // - Gate tile(s) (~ or ~~): ghosts may EXIT but not ENTER
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

        // solid wall tiles
        const walls = ["═", "║", "╔", "╗", "╚", "╝", "┌", "┐", "└", "┘", "|", "-"];
        if (walls.includes(tile)) return false;

        // ghost-house gate: allow exit (moving UP out of the house), block entry
        if (tile === "~~" || tile === "~") {
            return fromY > toY;
        }

        return true;
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

        if (walls.includes(tile)) return false;
        // Pac-Men cannot pass the ghost-house gate tiles
        if (tile === "~~" || tile === "~") return false;

        return true;
    }

    canMove(tileX, tileY, direction) {
        const newX = tileX + direction.x;
        const newY = tileY + direction.y;
        return this.isPacmanPassable(newX, newY);
    }

    /* ===============================
       DOTS / SCORE (FAST)
    =============================== */

    _dotKey(x, y) {
        return `${x},${y}`;
    }

    buildDotsFromLevel() {
        this.dots.clear(true, true);
        this.dotMap.clear();
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
                    this.dotMap.set(this._dotKey(x, y), dot);
                    this.dotsRemaining++;
                }
            }
        }
    }

    collectDotAt(player) {
        if (!this.isRoundActive) return false;
        if (!player?.sprite) return false;

        const x = player.tileX;
        const y = player.tileY;

        const dot = this.dotMap.get(this._dotKey(x, y));
        if (!dot || !dot.active) return false;

        // Only eat when at/near the center of the tile.
        const cx = x * TILE_SIZE + TILE_SIZE / 2;
        const cy = y * TILE_SIZE + TILE_SIZE / 2;
        const dist = Phaser.Math.Distance.Between(player.sprite.x, player.sprite.y, cx, cy);
        if (dist > TILE_SIZE * 0.2) return false;

        const type = dot.getData("type") || "normal";

        dot.destroy();
        this.dotMap.delete(this._dotKey(x, y));

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
            numPlayers: this.numPlayers,
        });

        if (type === "power") this.triggerFrightened();
        if (this.dotsRemaining <= 0) this.endRound();

        return true;
    }

    /* ===============================
       ROUND FLOW
    =============================== */

    startRound() {
        this.isRoundActive = false;

        this.readyOverlay.setVisible(true);
        this.readyText.setVisible(true);

        this.roundStartSound?.play();

        // Reset all players to start tiles (keep dots as-is on death; round start keeps current map dots too)
        for (let i = 0; i < this.players.length; i++) {
            this.players[i].reset(PACMAN_START_TILES[i] ?? PACMAN_START_TILES[0]);
        }

        // reset frightened / modes
        this.frightenedUntil = 0;
        this.ghostMode = "scatter";
        this.ghostModeElapsed = 0;

        // reset ghosts
        for (const g of this.ghosts) g.reset?.();

        this.time.delayedCall(700, () => {
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
        this.onHudUpdate?.({ round: this.round });

        // New round: rebuild dots (your existing behavior)
        this.buildDotsFromLevel();

        this.time.delayedCall(150, () => this.startRound());
    }

    /* ===============================
       FRIGHTENED MODE
    =============================== */

    triggerFrightened() {
        this.frightenedUntil = this.time.now + this.frightenedMs;
        for (const g of this.ghosts) g.setFrightened?.(this.frightenedMs);
    }

    updateGhostMode(delta) {
        if (this.time.now < this.frightenedUntil) return;

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
       AUDIO
    =============================== */

    stopEatSound() {
        if (!this.eatSound) return;
        if (this.eatSound.isPlaying) this.eatSound.stop();
        if (this.eatSound.isPaused) this.eatSound.stop();
    }

    /* ===============================
       COLLISION (PACMAN vs GHOST)
    =============================== */

    checkGhostCollision() {
        if (this.isDying) return null;

        const hit = (TILE_SIZE * 0.55) * (TILE_SIZE * 0.55);

        for (const p of this.players) {
            if (!p?.sprite) continue;

            const px = p.sprite.x;
            const py = p.sprite.y;

            for (const g of this.ghosts) {
                if (!g?.sprite) continue;
                const dx = g.sprite.x - px;
                const dy = g.sprite.y - py;
                const d2 = dx * dx + dy * dy;
                if (d2 < hit) return { ghost: g, player: p };
            }
        }

        return null;
    }

    eatGhost(ghost) {
        if (!ghost) return;

        this.score += 200;
        this.registry.set("score", this.score);
        this.onHudUpdate?.({
            score: this.score,
            dotsCollected: this.dotsCollected,
            dotsRemaining: this.dotsRemaining,
            round: this.round,
            numPlayers: this.numPlayers,
        });

        ghost.onEaten?.();
    }

    killPacmen() {
        if (this.isDying) return;
        this.isDying = true;

        this.stopEatSound();
        this.deadSound?.play();

        this.time.delayedCall(900, () => {
            this.isDying = false;
            // Reset players + ghosts only. Dots persist.
            this.startRound();
        });
    }

    getNearestPlayerForGhost(ghost) {
        let best = null;
        let bestD2 = Infinity;

        for (const p of this.players) {
            if (!p?.sprite) continue;
            const dx = p.sprite.x - ghost.sprite.x;
            const dy = p.sprite.y - ghost.sprite.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD2) {
                bestD2 = d2;
                best = p;
            }
        }

        return best ?? this.players[0];
    }

    /* ===============================
       UPDATE
    =============================== */

    update(time, delta) {
        if (!this.isRoundActive || this.isDying) {
            this.stopEatSound();
            for (const p of this.players) p.render(false);
            return;
        }

        // ---- PLAYERS ----
        let anyMoved = false;
        const movedFlags = new Array(this.players.length).fill(false);

        for (let i = 0; i < this.players.length; i++) {
            const moved = this.players[i].update(delta);
            movedFlags[i] = moved;
            if (moved) anyMoved = true;
        }

        // ---- EAT SOUND RULE: only when ANY player is moving + recently ate ----
        const eatingRecently = this.time.now - this.lastEatTime < 140;
        if (anyMoved && eatingRecently) {
            if (this.eatSound.isPaused) this.eatSound.resume();
            else if (!this.eatSound.isPlaying) this.eatSound.play();
        } else {
            this.stopEatSound();
        }

        // ---- GHOSTS ----
        this.updateGhostMode(delta);

        for (const g of this.ghosts) {
            g.setMode?.(this.ghostMode);

            const targetPlayer = this.getNearestPlayerForGhost(g);
            const pacTile = targetPlayer.getTile();
            const pacDir = targetPlayer.getDirection?.();

            g.update?.(delta, pacTile, pacDir);
        }

        // ---- COLLISION ----
        const hit = this.checkGhostCollision();
        if (hit) {
            if (hit.ghost.isFrightened?.()) this.eatGhost(hit.ghost);
            else {
                this.killPacmen();
                for (const p of this.players) p.render(false);
                return;
            }
        }

        // ---- VISUALS ----
        for (let i = 0; i < this.players.length; i++) {
            this.players[i].render(movedFlags[i]);
        }
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
