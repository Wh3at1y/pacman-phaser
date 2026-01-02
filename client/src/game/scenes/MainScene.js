// MainScene.js (DROP-IN REPLACEMENT)
// Ghosts are server-authoritative: spawned + moved from GhostSnapshot.

import Phaser from "phaser";
import { level1 } from "../levels/level1";
import Player from "../Player";
import socket from "../../socket.js";

const TILE_SIZE = 24;

const MAX_PLAYERS = 4;
const PACMAN_START_TILES = [
    { x: 13, y: 23 }, // P1
    { x: 10, y: 23 }, // P2
    { x: 16, y: 23 }, // P3
    { x: 13, y: 26 }, // P4
];

const colors = [0xffff00, 0x800080, 0xffffff, 0x008000];

// Ghost colors match your previous setup :contentReference[oaicite:8]{index=8}
const GHOST_COLORS = {
    blinky: 0xff0000,
    pinky: 0xffb8ff,
    inky: 0x00ffff,
    clyde: 0xffb852,
};

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

        this.isDying = false;
        this.isRoundActive = false;

        this.round = this.registry.get("round") ?? 1;
        this.playerScores = {};

        this.registry.set("numPlayers", this.currentPlayers.length);
        this.numPlayers = Math.max(1, Math.min(MAX_PLAYERS, this.registry.get("numPlayers") ?? 1));
        this.registry.set("numPlayers", this.numPlayers);
        this.registry.set("round", this.round);

        this.dotsRemaining = 0;
        this.dotsCollected = 0;

        // DOTS
        this.dots = this.add.group();
        this.dotMap = new Map();

        // AUDIO
        this.roundStartSound = this.sound.add("roundStart", { volume: 0.1 });
        this.eatSound = this.sound.add("eatLoop", { loop: true, volume: 0.1 });
        this.deadSound = this.sound.add("dead", { volume: 0.1 });
        this.lastEatTime = -999999;

        // PLAYERS
        this.players = [];
        for (let i = 0; i < this.numPlayers; i++) {
            const startTile = PACMAN_START_TILES[i] ?? PACMAN_START_TILES[0];

            let controls = null;
            if (this.currentPlayers[i]?.socketId === this.currentPlayer.socketId) {
                controls = this.input.keyboard.createCursorKeys();
            }

            const p = new Player(this, {
                startTile,
                radius: TILE_SIZE * 0.7,
                controls,
                socketId: this.currentPlayers[i]?.socketId,
                playerId: this.currentPlayers[i]?.playerId,
                color: colors[i],
                isRemote: this.currentPlayers[i]?.socketId !== this.currentPlayer.socketId,
            });

            p.graphics.setDepth(1001);
            this.players.push(p);
        }

        // SERVER GHOSTS (render-only on a client)
        this.serverGhosts = new Map();     // ghostId -> latest snapshot
        this.ghostSprites = new Map();     // ghostId -> Phaser GameObject

        // ---- Ghost interpolation buffer (same idea as Player remote interpolation) ----
        this.ghostNet = new Map(); // ghostId -> { snaps: [{t,x,y,tileX,tileY,dir,nextDir,mode,state}], delayMs }
        this.ghostInterpDelayMs = 110;


        const ensureGhostSprite = (ghostId) => {
            if (this.ghostSprites.has(ghostId)) return this.ghostSprites.get(ghostId);

            const color = GHOST_COLORS[ghostId] ?? 0xffffff;
            const sprite = this.add.circle(
                0, 0,
                TILE_SIZE / 2 - 2,
                color
            );
            sprite.setDepth(1000);
            this.ghostSprites.set(ghostId, sprite);
            return sprite;
        };

        // const applyGhostVisual = (ghostId, g) => {
        //     const spr = ensureGhostSprite(ghostId);
        //     if (!g) return;
        //
        //     spr.x = g.x;
        //     spr.y = g.y;
        //
        //     // Frightened visuals come from server "mode"
        //     if (g.mode === "frightened") {
        //         spr.setFillStyle(0x0000ff);
        //     } else {
        //         spr.setFillStyle(GHOST_COLORS[ghostId] ?? 0xffffff);
        //     }
        //
        //     // Optional: hide ghosts that are "inHouse" until leaving, if you want
        //     spr.setVisible(true);
        // };

        this._onGhostSnapshot = ({  ghosts }) => {
            if (!ghosts || !Array.isArray(ghosts)) return;

            // Use local clock for snapshots, like Player does
            const localT = this.time.now;

            for (const g of ghosts) {
                if (!g?.ghostId) continue;

                // Keep latest authoritative snapshot for collisions, etc.
                this.serverGhosts.set(g.ghostId, g);

                // Push into the interpolation buffer
                let buf = this.ghostNet.get(g.ghostId);
                if (!buf) {
                    buf = { snaps: [], delayMs: this.ghostInterpDelayMs };
                    this.ghostNet.set(g.ghostId, buf);
                }

                buf.snaps.push({
                    t: localT,
                    x: g.x,
                    y: g.y,
                    tileX: g.tileX,
                    tileY: g.tileY,
                    dir: g.dir,
                    nextDir: g.nextDir,
                    mode: g.mode,
                    state: g.state,
                });

                // Keep the buffer small
                if (buf.snaps.length > 12) buf.snaps.shift();

                // Ensure sprite exists (but don't hard-set position here anymore)
                ensureGhostSprite(g.ghostId);
            }
        };

        this.socket.on("GhostSnapshot", this._onGhostSnapshot);

        // Ask server for snapshot immediately on scene start (join-in-progress safety)
        this.socket.emit("GhostSnapshotRequest");

        // NETWORKING (players) - unchanged from your current logic
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

            p.setNextDirection(dir);
        };
        this.socket.on("KeyPressed", this._onKeyPressed);

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

        // Cleanup
        this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
            this.input.keyboard.off("keydown", this._onKeyDown);
            this.socket.off("KeyPressed", this._onKeyPressed);
            this.socket.off("PlayerState", this._onPlayerState);
            this.socket.off("GhostSnapshot", this._onGhostSnapshot);

            this.socket.off("DotEatenConfirmed");
            this.socket.off("BackToLobby");
            this.socket.off("RoundEnded");
            this.socket.off("LivesUpdate");

            this.sound.stopAll();
            this.eatSound.destroy();
            this.deadSound.destroy();
            this.roundStartSound.destroy();
            this.netTick?.remove?.();
        });

        // Dot confirmation + frightened event (visuals handled by ghost snapshots now)
        this.socket.on("DotEatenConfirmed", ({ x, y, scores }) => {
            const key = this._dotKey(x, y);
            if (this._pendingDotRequests) this._pendingDotRequests.delete(key);

            const dot = this.dotMap.get(key);
            if (dot) {
                dot.destroy();
                this.dotMap.delete(key);
                this.dotsRemaining--;
            }

            // Still keep your HUD scores
            if (scores) {
                this.playerScores = scores;
                this.onHudUpdate?.({ playerScores: this.playerScores });
            }

            if (this.dotsRemaining <= 0) {
                if (!this._roundEnding) {
                    this._roundEnding = true;
                    this.endRound();
                    this.time.delayedCall(250, () => (this._roundEnding = false));
                }
            }
        });

        this.socket.on("LivesUpdate", ({ playerId, lives, eliminated }) => {
            const p = this.players.find(pl => pl.playerId === playerId);
            if (!p) return;

            if (eliminated) {
                p.setAlive(false);
                p.outUntilRoundEnd = false;
                p.eliminated = true;
                p.setSpectatorVisual(true);
            } else {
                p.setAlive(false);
                p.outUntilRoundEnd = true;
                p.setSpectatorVisual(true);
            }

            this.onHudUpdate?.({ lives });
        });

        this.socket.on("RoundEnded", ({ respawn, round }) => {
            for (const p of this.players) {
                if (p.eliminated) continue;
                if (respawn.includes(p.playerId)) {
                    p.outUntilRoundEnd = false;
                    p.resetToSpawn();
                    p.setAlive(true);
                    p.setSpectatorVisual(false);
                }
            }

            this.startRound();
            if (this.round < round) this.buildDotsFromLevel();
            this.onHudUpdate({ round });
        });

        this._onBackToLobby = () => {
            this.isRoundActive = false;
            this.stopEatSound();
            this.onHudUpdate?.({ backToLobby: true });
        };
        this.socket.on("BackToLobby", this._onBackToLobby);

        // READY overlay
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

        // Build dots + render level
        this.buildDotsFromLevel();
        this.drawLevel();

        // HUD init
        this.onHudUpdate?.({
            dotsCollected: this.dotsCollected,
            dotsRemaining: this.dotsRemaining,
            round: this.round,
            numPlayers: this.numPlayers,
        });

        this.startRound();
    }

    _applyGhostInterpolation() {
        const renderTime = this.time.now - this.ghostInterpDelayMs;

        for (const [ghostId, buf] of this.ghostNet.entries()) {
            const spr = this.ghostSprites.get(ghostId);
            if (!spr) continue;

            const snaps = buf.snaps;
            if (!snaps || snaps.length === 0) continue;

            // Drop old snapshots
            while (snaps.length >= 3 && snaps[1].t <= renderTime) snaps.shift();

            // One snapshot: ease toward it
            if (snaps.length === 1) {
                const s = snaps[0];
                const a = 1 - Math.pow(0.001, 1 / 60); // same smoothing idea as Player
                spr.x += (s.x - spr.x) * a;
                spr.y += (s.y - spr.y) * a;

                // Visual mode (frightened)
                if (s.mode === "frightened") spr.setFillStyle(0x0000ff);
                else spr.setFillStyle(GHOST_COLORS[ghostId] ?? 0xffffff);

                spr.setVisible(true);
                continue;
            }

            const s0 = snaps[0];
            const s1 = snaps[1];
            const span = Math.max(1, s1.t - s0.t);
            const alpha = Phaser.Math.Clamp((renderTime - s0.t) / span, 0, 1);

            spr.x = Phaser.Math.Linear(s0.x, s1.x, alpha);
            spr.y = Phaser.Math.Linear(s0.y, s1.y, alpha);

            const use = alpha < 0.5 ? s0 : s1;
            if (use.mode === "frightened") spr.setFillStyle(0x0000ff);
            else spr.setFillStyle(GHOST_COLORS[ghostId] ?? 0xffffff);

            spr.setVisible(true);
        }
    }


    getLocalPlayer() {
        return this.players.find((p) => p.socketId === this.currentPlayer.socketId) ?? this.players[0];
    }

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
        if (player.isRemote) return false;

        const x = player.tileX;
        const y = player.tileY;

        const key = this._dotKey(x, y);
        const dot = this.dotMap.get(key);
        if (!dot || !dot.active) return false;

        const cx = x * TILE_SIZE + TILE_SIZE / 2;
        const cy = y * TILE_SIZE + TILE_SIZE / 2;
        const dist = Phaser.Math.Distance.Between(player.sprite.x, player.sprite.y, cx, cy);
        if (dist > TILE_SIZE * 0.2) return false;

        const type = dot.getData("type") || "normal";

        this._pendingDotRequests ??= new Set();
        if (this._pendingDotRequests.has(key)) return false;
        this._pendingDotRequests.add(key);

        this.dotSeq = (this.dotSeq ?? 0) + 1;

        this.socket.emit("DotEaten", {
            playerId: this.currentPlayer.playerId,
            x, y, type,
            seq: this.dotSeq,
            t: this.time.now,
        });

        this.lastEatTime = this.time.now;
        return true;
    }

    startRound() {
        this.isRoundActive = false;

        this.readyOverlay.setVisible(true);
        this.readyText.setVisible(true);
        this.roundStartSound?.play();

        for (let i = 0; i < this.players.length; i++) {
            this.players[i].reset(PACMAN_START_TILES[i] ?? PACMAN_START_TILES[0]);
        }

        this.time.delayedCall(700, () => {
            this.readyOverlay.setVisible(false);
            this.readyText.setVisible(false);
            this.isRoundActive = true;
        });
    }

    endRound() {
        this.stopEatSound();
        this.isRoundActive = false;
        this.socket.emit("RoundEnded");
    }

    stopEatSound() {
        if (!this.eatSound) return;
        if (this.eatSound.isPlaying) this.eatSound.stop();
        if (this.eatSound.isPaused) this.eatSound.stop();
    }

    checkGhostCollision() {
        const player = this.getLocalPlayer?.() || this.players.find(p => !p.isRemote);
        if (!player || !player.isAlive || player.outUntilRoundEnd || player.eliminated) return null;

        for (const [ghostId, g] of this.serverGhosts.entries()) {
            const spr = this.ghostSprites.get(ghostId);
            if (!spr || !spr.visible) continue;

            const d = Phaser.Math.Distance.Between(player.sprite.x, player.sprite.y, spr.x, spr.y);
            if (d < this.TILE_SIZE * 0.6) {
                return { ghostId, ghost: g, player };
            }
        }

        return null;
    }

    killPlayer(player) {
        if (!player) return;
        if (!player.isAlive) return;

        player.setAlive(false);
        player.outUntilRoundEnd = true;
        player.setSpectatorVisual(true);

        if (!player.isRemote) {
            this.stopEatSound();
            this.deadSound?.play();
            this.socket.emit("PlayerDied", { victimPlayerId: player.playerId });
        }

        if (this.players.every(p => !p.isAlive || p.outUntilRoundEnd)) {
            this.endRound();
        }
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

        // Pac-Man cannot pass the ghost-house gate tiles
        if (tile === "~~" || tile === "~") return false;

        return true;
    }

    canMove(tileX, tileY, direction) {
        const newX = tileX + direction.x;
        const newY = tileY + direction.y;
        return this.isPacmanPassable(newX, newY);
    }

    update(time, delta) {
        if (!this.isRoundActive || this.isDying) {
            this.stopEatSound();
            for (const p of this.players) p.render(false);
            return;
        }

        // PLAYERS
        let anyMoved = false;
        const movedFlags = new Array(this.players.length).fill(false);

        for (let i = 0; i < this.players.length; i++) {
            const moved = this.players[i].update(delta);
            movedFlags[i] = moved;
            if (moved) anyMoved = true;
        }

        // Eating sound
        const eatingRecently = this.time.now - this.lastEatTime < 140;
        if (anyMoved && eatingRecently) {
            if (this.eatSound.isPaused) this.eatSound.resume();
            else if (!this.eatSound.isPlaying) this.eatSound.play();
        } else {
            this.stopEatSound();
        }

        // COLLISION (based on server ghost positions)
        this._applyGhostInterpolation();
        const hit = this.checkGhostCollision();
        if (hit) {
            const { ghost, player } = hit;

            // For now, we still only handle death locally and emit PlayerDied,
            // until we move collision to server.
            if (player.isRemote) return;

            if (ghost?.mode === "frightened") {
                // Eating ghosts will become server-authoritative later.
                // For now: just ignore (or you can add a "GhostEaten" event later).
            } else {
                this.killPlayer(player);
            }
        }

        // VISUALS
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

                const thick = 4;
                const thin = 2;

                switch (tile) {
                    case "┌":
                        graphics.lineStyle(thin, 0x0000ff, 1);
                        graphics.strokeLineShape(new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE, baseX + TILE / 2, baseY + TILE / 2));
                        graphics.strokeLineShape(new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE / 2, baseX + TILE, baseY + TILE / 2));
                        break;
                    case "┐":
                        graphics.lineStyle(thin, 0x0000ff, 1);
                        graphics.strokeLineShape(new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE, baseX + TILE / 2, baseY + TILE / 2));
                        graphics.strokeLineShape(new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE / 2, baseX, baseY + TILE / 2));
                        break;
                    case "└":
                        graphics.lineStyle(thin, 0x0000ff, 1);
                        graphics.strokeLineShape(new Phaser.Geom.Line(baseX + TILE / 2, baseY, baseX + TILE / 2, baseY + TILE / 2));
                        graphics.strokeLineShape(new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE / 2, baseX + TILE, baseY + TILE / 2));
                        break;
                    case "┘":
                        graphics.lineStyle(thin, 0x0000ff, 1);
                        graphics.strokeLineShape(new Phaser.Geom.Line(baseX + TILE / 2, baseY, baseX + TILE / 2, baseY + TILE / 2));
                        graphics.strokeLineShape(new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE / 2, baseX, baseY + TILE / 2));
                        break;
                    case "-":
                        graphics.lineStyle(thin, 0x0000ff, 1);
                        graphics.strokeLineShape(new Phaser.Geom.Line(baseX, baseY + TILE / 2, baseX + TILE, baseY + TILE / 2));
                        break;
                    case "|":
                        graphics.lineStyle(thin, 0x0000ff, 1);
                        graphics.strokeLineShape(new Phaser.Geom.Line(baseX + TILE / 2, baseY, baseX + TILE / 2, baseY + TILE));
                        break;

                    case "╔":
                        graphics.lineStyle(thick, 0x0000ff, 1);
                        graphics.strokeLineShape(new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE, baseX + TILE / 2, baseY + TILE / 2));
                        graphics.strokeLineShape(new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE / 2, baseX + TILE, baseY + TILE / 2));
                        break;
                    case "╗":
                        graphics.lineStyle(thick, 0x0000ff, 1);
                        graphics.strokeLineShape(new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE, baseX + TILE / 2, baseY + TILE / 2));
                        graphics.strokeLineShape(new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE / 2, baseX, baseY + TILE / 2));
                        break;
                    case "╚":
                        graphics.lineStyle(thick, 0x0000ff, 1);
                        graphics.strokeLineShape(new Phaser.Geom.Line(baseX + TILE / 2, baseY, baseX + TILE / 2, baseY + TILE / 2));
                        graphics.strokeLineShape(new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE / 2, baseX + TILE, baseY + TILE / 2));
                        break;
                    case "╝":
                        graphics.lineStyle(thick, 0x0000ff, 1);
                        graphics.strokeLineShape(new Phaser.Geom.Line(baseX + TILE / 2, baseY, baseX + TILE / 2, baseY + TILE / 2));
                        graphics.strokeLineShape(new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE / 2, baseX, baseY + TILE / 2));
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
                        graphics.strokeLineShape(new Phaser.Geom.Line(baseX, baseY + TILE / 2, baseX + TILE, baseY + TILE / 2));
                        break;

                    default:
                        break;
                }
            }
        }
    }
}
