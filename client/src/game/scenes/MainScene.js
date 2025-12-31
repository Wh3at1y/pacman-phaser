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

        // ---- FRIGHTENED ----
        this.frightenedMs = 7000;
        this.frightenedUntil = 0;

        // ---- MODE TIMING ----
        this.ghostMode = "scatter";
        this.ghostModeElapsed = 0;

        // Sounds
        this.roundStartSound = this.sound.add("roundStart", { volume: 0.35 });
        this.eatSound = this.sound.add("eatLoop", { volume: 0.12, loop: true });
        this.deadSound = this.sound.add("dead", { volume: 0.45 });

        // ---- Build dots from level ----
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

        const now = this.time.now;

        for (const g of this.ghosts) {
            const delay = releaseByName[g.name] ?? 0;

            g.configureHouse?.({
                ...houseInfo,
                releaseDelayMs: delay,
            });

            // IMPORTANT: if ghost starts in the house, put it in the house state machine
            if (this.isGhostHouseTile(g.tileX, g.tileY)) {
                g.state = "inHouse";
                g.releaseAt = now + delay;
                g.dir = { x: 0, y: -1 }; // initial bounce direction (up)
            } else {
                g.state = "active";
                g.releaseAt = 0;
            }
        }


        // ---- GHOST AUTHORITY (ONE CLIENT SIMULATES GHOST AI) ----
        // Server will pick a single socket as the "ghost host" and everyone else will render snapshots.
        this.ghostHostSocketId = null;
        this.isGhostHost = false;
        this.ghostStateSeq = 0;
        this.ghostNetTick = null;

        this.setGhostAuthority = (isHost) => {
            if (this.isGhostHost === isHost) return;
            this.isGhostHost = !!isHost;

            // Non-host clients: ghosts become net-controlled (no AI locally).
            for (const g of this.ghosts) {
                g.setNetControlled?.(!this.isGhostHost);
            }

            // Host: stream authoritative ghost snapshots ~20Hz.
            if (this.isGhostHost) {
                this.ghostNetTick?.remove?.();
                this.ghostNetTick = this.time.addEvent({
                    delay: 50,
                    loop: true,
                    callback: () => {
                        if (!this.isRoundActive) return;

                        this.socket.emit("GhostState", {
                            seq: ++this.ghostStateSeq,
                            t: this.time.now,
                            ghosts: this.ghosts.map((g) => ({
                                name: g.name,
                                x: g.x,
                                y: g.y,
                                tileX: g.tileX,
                                tileY: g.tileY,
                                dir: g.dir,
                                mode: g.mode,
                                frightened: g.isFrightened?.() ?? false,
                            })),
                        });
                    },
                });
            } else {
                this.ghostNetTick?.remove?.();
                this.ghostNetTick = null;
            }
        };

        this._onGhostHost = ({ socketId } = {}) => {
            this.ghostHostSocketId = socketId ?? null;
            const amHost = !!this.ghostHostSocketId && this.ghostHostSocketId === this.currentPlayer.socketId;
            this.setGhostAuthority(amHost);
        };
        this.socket.on("ghost_host", this._onGhostHost);

        this._onGhostState = (payload) => {
            // Only non-host clients apply snapshots.
            if (this.isGhostHost) return;

            const seq = payload?.seq ?? 0;
            const t = payload?.t ?? this.time.now;
            const list = payload?.ghosts;
            if (!Array.isArray(list)) return;

            for (const gs of list) {
                const g = this.ghosts.find((gg) => gg.name === gs.name);
                if (!g) continue;
                g.pushNetSnapshot?.({
                    t,
                    seq,
                    ...gs,
                });
            }
        };
        this.socket.on("GhostState", this._onGhostState);

        // Power dot eaten by ANY client should trigger frightened for EVERYONE.
        this._onPowerDotEaten = (msg) => {
            if (!msg) return;
            // Avoid re-triggering from our own broadcast (we already do it locally)
            if (msg.socketId && msg.socketId === this.currentPlayer.socketId) return;
            this.triggerFrightened();
        };
        this.socket.on("PowerDotEaten", this._onPowerDotEaten);

        // Ask the server who the current ghost host is (so we don't miss the initial broadcast).
        this.socket.emit("ghost_host:request");

        // ---- HUD ----
        this.onHudUpdate?.({
            score: this.score,
            dotsCollected: this.dotsCollected,
            dotsRemaining: this.dotsRemaining,
            round: this.round,
            numPlayers: this.numPlayers,
        });

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
                speed: 145,
                color: colors[i] ?? 0xffff00,
                socketId: this.currentPlayers[i]?.socketId,
                controls,
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
                const local = this.getLocalPlayer();
                if (!local) return;

                this.socket.emit("PlayerState", {
                    socketId: this.currentPlayer.socketId,
                    x: local.sprite.x,
                    y: local.sprite.y,
                    tileX: local.tileX,
                    tileY: local.tileY,
                    dir: local.direction,
                    nextDir: local.nextDirection,
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

            p.pushNetSnapshot?.({ x, y, tileX, tileY, dir, nextDir });
        };
        this.socket.on("PlayerState", this._onPlayerState);

        this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
            this.input.keyboard.off("keydown", this._onKeyDown);
            this.socket.off("KeyPressed", this._onKeyPressed);
            this.socket.off("PlayerState", this._onPlayerState);
            this.netTick?.remove?.();
            this.ghostNetTick?.remove?.();
            this.socket.off("ghost_host", this._onGhostHost);
            this.socket.off("GhostState", this._onGhostState);
            this.socket.off("PowerDotEaten", this._onPowerDotEaten);
        });

        // ---- READY OVERLAY ----
        this.readyOverlay = this.add
            .rectangle(
                (this.levelCols * TILE_SIZE) / 2,
                (this.levelRows * TILE_SIZE) / 2,
                this.levelCols * TILE_SIZE,
                60,
                0x000000,
                0.8
            )
            .setDepth(2000)
            .setVisible(false);

        this.readyText = this.add
            .text((this.levelCols * TILE_SIZE) / 2, (this.levelRows * TILE_SIZE) / 2, "READY!", {
                fontSize: "32px",
                fontFamily: "Arial",
                color: "#ffff00",
            })
            .setOrigin(0.5)
            .setDepth(2001)
            .setVisible(false);

        this.lastEatTime = 0;
        this.startRound();
    }

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

        // Eating audio: play while anyone is moving AND has recently eaten
        if (anyMoved && this.time.now - this.lastEatTime < 600) {
            this.playEatSound();
        } else {
            this.stopEatSound();
        }

        // ---- GHOSTS ----
        if (this.isGhostHost) {
            this.updateGhostMode(delta);

            for (const g of this.ghosts) {
                g.setMode?.(this.ghostMode);

                const targetPlayer = this.getNearestPlayerForGhost(g);
                const pacTile = targetPlayer.getTile();
                const pacDir = targetPlayer.getDirection?.();

                g.update?.(delta, pacTile, pacDir);
            }
        } else {
            // Non-host: ghosts are net-controlled (Ghost.js interpolates snapshots in update()).
            for (const g of this.ghosts) {
                g.update?.(delta);
            }
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

    /* ===============================
       DOTS
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
                    this.dotMap.set(this._dotKey(x, y), dot);
                    this.dotsRemaining++;

                    this.dots.add(dot);
                }
            }
        }
    }

    // Backwards-compatible name (you asked for drawDots; your project calls it buildDotsFromLevel)
    drawDots() {
        this.buildDotsFromLevel();
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

        if (type === "power") {
            // Only the local player announces power dots so we don't spam the server.
            if (player.socketId === this.currentPlayer.socketId) {
                this.socket.emit("PowerDotEaten", { tileX: x, tileY: y });
            }
            this.triggerFrightened();
        }
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

        // Reset all players to start tiles (keep dots as-is on death; round start keeps current map)
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
       HELPERS
    =============================== */

    getLocalPlayer() {
        return this.players.find((p) => p.socketId === this.currentPlayer.socketId) ?? this.players[0];
    }

    isWallTile(tile) {
        return WALL_TILES.includes(tile);
    }

    isGhostHouseTile(x, y) {
        // Your level uses X for the ghost house interior (based on your earlier note)
        const tile = level1?.[y]?.[x];
        return tile === "X";
    }

    // Allow ghosts through the "~" gate, but (generally) not Pac-Man.
    isGhostPassable(fromX, fromY, toX, toY) {
        const tile = level1?.[toY]?.[toX];
        if (tile == null) return false;

        // Wrap horizontally
        if (toX < 0 || toX >= this.levelCols) return true;

        // Walls are blocked
        if (this.isWallTile(tile)) return false;

        // "~" is the gate. Ghosts can pass.
        if (tile === "~~" || tile === "~") {
            // Allow ghosts to step ONTO the gate from inside the house (from X tiles),
            // so they can approach it from the side and still exit.
            const fromInsideHouse = this.isGhostHouseTile(fromX, fromY);

            // Also allow the classic "exit upward" behavior.
            const exitingUpward = fromY > toY;

            // But still block entry from outside (sideways or downward into the gate).
            return fromInsideHouse || exitingUpward;
        }


        // Everything else passable
        return true;
    }

    canMove(x, y, dir) {
        const nx = (x + dir.x + this.levelCols) % this.levelCols;
        const ny = y + dir.y;
        if (ny < 0 || ny >= this.levelRows) return false;

        const tile = level1[ny][nx];
        if (tile == null) return false;

        if (this.isWallTile(tile)) return false;

        // block gate for pac-men
        if (tile === "~") return false;

        return true;
    }

    // Find nearest player (tile distance) as the ghost target "pacman"
    getNearestPlayerForGhost(ghost) {
        let best = this.players[0];
        let bestD = Infinity;

        for (const p of this.players) {
            const dx = p.tileX - ghost.tileX;
            const dy = p.tileY - ghost.tileY;
            const d = dx * dx + dy * dy;
            if (d < bestD) {
                bestD = d;
                best = p;
            }
        }

        return best;
    }

    _buildGhostHouseInfo() {
        // Door tiles are "~". Exit tile is the tile directly above the first door tile.
        const doorTiles = [];
        let minY = Infinity;
        let maxY = -Infinity;

        for (let y = 0; y < this.levelRows; y++) {
            for (let x = 0; x < this.levelCols; x++) {
                if (this.isGhostHouseTile(x, y)) {
                    minY = Math.min(minY, y);
                    maxY = Math.max(maxY, y);
                }
                if (level1[y][x] === "~" || level1[y][x] === "~~") {
                    doorTiles.push({ x, y });
                }
            }
        }

        let exitTile = null;

        if (doorTiles.length > 0) {
            // Pick a door tile that actually has a passable tile above it for ghosts.
            for (const d of doorTiles) {
                const aboveY = d.y - 1;
                if (aboveY < 0) continue;

                if (this.isGhostPassable(d.x, d.y, d.x, aboveY)) {
                    exitTile = { x: d.x, y: aboveY };
                    break;
                }
            }

            // Fallback: old behavior if none detected
            if (!exitTile) {
                const d = doorTiles[0];
                exitTile = { x: d.x, y: d.y - 1 };
            }
        }

        return {
            doorTiles,
            exitTile,
            inHouseMinY: Number.isFinite(minY) ? minY : null,
            inHouseMaxY: Number.isFinite(maxY) ? maxY : null,
        };
    }

    /* ===============================
       SOUND
    =============================== */

    playEatSound() {
        if (!this.eatSound?.isPlaying) this.eatSound?.play();
    }

    stopEatSound() {
        if (this.eatSound?.isPlaying) this.eatSound?.stop();
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
                const dx = px - g.x;
                const dy = py - g.y;
                const d2 = dx * dx + dy * dy;

                if (d2 <= hit) {
                    return { player: p, ghost: g };
                }
            }
        }

        return null;
    }

    killPacmen() {
        if (this.isDying) return;

        this.isDying = true;
        this.isRoundActive = false;

        this.stopEatSound();
        this.deadSound?.play();

        this.time.delayedCall(1300, () => {
            this.isDying = false;
            this.startRound();
        });
    }

    eatGhost(ghost) {
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