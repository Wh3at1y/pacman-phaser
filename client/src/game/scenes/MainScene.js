// MainScene.js (DROP-IN REPLACEMENT)
// Server-authoritative ghosts: positions/modes come from GhostSnapshot.
// Ghosts are rendered via GhostSprite (Graphics), so don't use Shape APIs on them.

import Phaser from "phaser";
import { level1 } from "../levels/level1";
import Player from "../Player";
import GhostSprite from "../GhostSprite.js";

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
    this.cameras.main.setZoom(1);
      this.TILE_SIZE = TILE_SIZE;
    this.levelCols = level1[0].length;
    this.levelRows = level1.length;

    this.isDying = false;
    this.isRoundActive = false;

    // Client-side safety: brief optimistic frightened window after eating a power dot
    // so latency doesn't let a 'chase' snapshot kill you.
    this.localFrightenedUntilMs = 0;
    // Server-synced frightened window (for flashing + for remote power dots)
    this.frightenedUntilMs = 0;

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
    this._pendingDotRequests = new Set();
    this.dotSeq = 0;

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

    // GHOSTS (render-only on client)
    this.serverGhosts = new Map(); // ghostId -> latest authoritative snapshot (for collision/mode checks)
    this.ghostSprites = new Map(); // ghostId -> GhostSprite
    this.ghostNet = new Map();     // ghostId -> { snaps: [] }
    this.ghostInterpDelayMs = 110;

    const ensureGhostSprite = (ghostId) => {
      if (this.ghostSprites.has(ghostId)) return this.ghostSprites.get(ghostId);

      const color = GHOST_COLORS[ghostId] ?? 0xffffff;
      const spr = new GhostSprite(this, ghostId, color, TILE_SIZE);

      spr.x = spr.x ?? 0;
      spr.y = spr.y ?? 0;

      spr.setVisible = (v) => {
        if (spr.gfx?.setVisible) spr.gfx.setVisible(v);
        else if (spr.gfx) spr.gfx.visible = !!v;
        spr.visible = !!v;
      };
      spr.setVisible(true);

      this.ghostSprites.set(ghostId, spr);
      return spr;
    };

    const applyGhostState = (spr, s) => {
      spr.x = s.x;
      spr.y = s.y;
      spr.setState({ x: s.x, y: s.y, dir: s.dir, mode: s.mode });
    };

    // Receive ghost snapshots from server
    this._onGhostSnapshot = ({ ghosts }) => {
      if (!Array.isArray(ghosts)) return;

      const localT = this.time.now;
      // Keep a global frightened-until for GhostSprite flashing (and as a fallback if we miss the event)
      let maxFrightenedUntil = 0;

      for (const g of ghosts) {
        if (!g?.ghostId) continue;

        this.serverGhosts.set(g.ghostId, g);
          const toSceneUntil = (serverUntilMs) => {
              const remaining = Math.max(0, serverUntilMs - Date.now());
              return this.time.now + remaining;
          };

          if (typeof g.frightenedUntilMs === "number") {
              maxFrightenedUntil = Math.max(maxFrightenedUntil, toSceneUntil(g.frightenedUntilMs));
          }

        let buf = this.ghostNet.get(g.ghostId);
        if (!buf) {
          buf = { snaps: [] };
          this.ghostNet.set(g.ghostId, buf);
        }

        buf.snaps.push({
          t: localT,
          x: g.x,
          y: g.y,
          dir: g.dir,
          mode: g.mode,
          state: g.state,
        });

        if (buf.snaps.length > 12) buf.snaps.shift();

        ensureGhostSprite(g.ghostId);
       }

       // If any ghost is frightened, this is the common until time.
       if (maxFrightenedUntil > 0) this.frightenedUntilMs = maxFrightenedUntil;
     };

    this.socket.on("GhostSnapshot", this._onGhostSnapshot);
    this.socket.emit("GhostSnapshotRequest");

    // INPUT: send key presses
    this.inputSeq = 0;
    this._onKeyDown = (event) => {
      const code = event.code;
      if (code !== "ArrowUp" && code !== "ArrowDown" && code !== "ArrowLeft" && code !== "ArrowRight") return;

      this.socket.emit("KeyPressed", {
        socketId: this.currentPlayer.socketId,
        dir: code,
        seq: ++this.inputSeq,
      });
    };
    this.input.keyboard.on("keydown", this._onKeyDown);

    // INPUT: apply remote key presses
    this._onKeyPressed = ({ socketId, dir, seq }) => {
      if (!socketId || socketId === this.currentPlayer.socketId) return;

      const p = this.players.find((pl) => pl.socketId === socketId);
      if (!p) return;

      p.lastInputSeq = p.lastInputSeq ?? 0;
      if (seq != null && seq <= p.lastInputSeq) return;
      if (seq != null) p.lastInputSeq = seq;

      p.setNextDirection(dir);
    };
    this.socket.on("KeyPressed", this._onKeyPressed);

    // STATE: send local player state periodically
    this.stateSeq = 0;
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

    // STATE: apply remote player state
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

    // DOT confirm
    this.socket.on("DotEatenConfirmed", ({ x, y, scores }) => {
      const key = this._dotKey(x, y);

      // Was this confirmation for a dot we (this client) requested? (prevents remote dots from affecting us)
      const wasPendingLocal = this._pendingDotRequests.has(key);
      this._pendingDotRequests.delete(key);

      const dot = this.dotMap.get(key);
      const dotType = dot?.getData?.("type") || "normal";

      // If we just ate a POWER dot locally, open an optimistic frightened window to cover network delay.
      if (wasPendingLocal && dotType === "power") {
        // Match your server frightened duration. If you change it server-side, update this too.
        this.localFrightenedUntilMs = this.time.now + 7000;
      }

      if (dot) {
        dot.destroy();
        this.dotMap.delete(key);
        this.dotsRemaining--;
      }

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



    // POWER DOT / FRIGHTENED: server broadcast so everyone gets the timing (for flashing + latency safety)
    this._onFrightenedStart = ({ untilMs, durationMs } = {}) => {
        // Convert server epoch ms to Phaser scene-time ms
        const toSceneUntil = (serverUntilMs) => {
            // remaining time from now (epoch), applied onto Phaser clock
            const remaining = Math.max(0, serverUntilMs - Date.now());
            return this.time.now + remaining;
        };

        const u = (typeof untilMs === "number")
            ? toSceneUntil(untilMs)
            : (this.time.now + (durationMs ?? 7000));

        this.frightenedUntilMs = Math.max(this.frightenedUntilMs || 0, u);
        this.localFrightenedUntilMs = Math.max(this.localFrightenedUntilMs || 0, u);

    };
    this.socket.on("FrightenedStart", this._onFrightenedStart);

this.socket.on("LivesUpdate", ({ playerId, lives, eliminated }) => {
      const p = this.players.find((pl) => pl.playerId === playerId);
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
      this.onHudUpdate?.({ round });
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

    // stash helper
    this._applyGhostState = applyGhostState;

    // Scene cleanup
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.input.keyboard.off("keydown", this._onKeyDown);

      this.socket.off("KeyPressed", this._onKeyPressed);
      this.socket.off("PlayerState", this._onPlayerState);
      this.socket.off("GhostSnapshot", this._onGhostSnapshot);
      this.socket.off("DotEatenConfirmed");
      this.socket.off("FrightenedStart", this._onFrightenedStart);
      this.socket.off("BackToLobby", this._onBackToLobby);
      this.socket.off("RoundEnded");
      this.socket.off("LivesUpdate");

      this.sound.stopAll();
      this.netTick?.remove?.();

      for (const spr of this.ghostSprites.values()) spr?.destroy?.();
      this.ghostSprites.clear();
      this.ghostNet.clear();
      this.serverGhosts.clear();
    });
  }

  _applyGhostInterpolation() {
    const renderTime = this.time.now - this.ghostInterpDelayMs;

    for (const [, buf] of this.ghostNet.entries()) {
      const snaps = buf.snaps;
      if (!snaps || snaps.length === 0) continue;

      const ghostId = snaps[snaps.length - 1]?.ghostId; // not required
      const spr = ghostId ? this.ghostSprites.get(ghostId) : null;

      // If we don't have ghostId on snaps, derive from map iteration in caller:
      // We'll just use the sprite lookup by scanning keys below.
    }

    for (const [ghostId, buf] of this.ghostNet.entries()) {
      const spr = this.ghostSprites.get(ghostId);
      if (!spr) continue;

      const snaps = buf.snaps;
      if (!snaps || snaps.length === 0) continue;

      while (snaps.length >= 3 && snaps[1].t <= renderTime) snaps.shift();

      if (snaps.length === 1) {
        const s = snaps[0];
        const a = 1 - Math.pow(0.001, 1 / 60);
        const nx = (spr.x ?? 0) + (s.x - (spr.x ?? 0)) * a;
        const ny = (spr.y ?? 0) + (s.y - (spr.y ?? 0)) * a;
        this._applyGhostState(spr, { x: nx, y: ny, dir: s.dir, mode: s.mode });
        continue;
      }

      const s0 = snaps[0];
      const s1 = snaps[1];
      const span = Math.max(1, s1.t - s0.t);
      const alpha = Phaser.Math.Clamp((renderTime - s0.t) / span, 0, 1);

      const ix = Phaser.Math.Linear(s0.x, s1.x, alpha);
      const iy = Phaser.Math.Linear(s0.y, s1.y, alpha);

      const use = alpha < 0.5 ? s0 : s1;
      this._applyGhostState(spr, { x: ix, y: iy, dir: use.dir, mode: use.mode });
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

    if (this._pendingDotRequests.has(key)) return false;
    this._pendingDotRequests.add(key);

    const type = dot.getData("type") || "normal";
    this.dotSeq++;

    this.socket.emit("DotEaten", {
      playerId: this.currentPlayer.playerId,
      x,
      y,
      type,
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

    this.time.delayedCall(2000, () => {
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
    const player = this.getLocalPlayer();
    if (!player || !player.isAlive || player.outUntilRoundEnd || player.eliminated) return null;

    for (const [ghostId, g] of this.serverGhosts.entries()) {
      const spr = this.ghostSprites.get(ghostId);
      if (!spr) continue;

      const sx = spr.x ?? g.x;
      const sy = spr.y ?? g.y;

      const d = Phaser.Math.Distance.Between(player.sprite.x, player.sprite.y, sx, sy);
      if (d < TILE_SIZE * 0.6) return { ghostId, ghost: g, player };
    }

    return null;
  }

  killPlayer(player) {
    if (!player || !player.isAlive) return;

    player.setAlive(false);
    player.outUntilRoundEnd = true;
    player.setSpectatorVisual(true);

    if (!player.isRemote) {
      this.stopEatSound();
      this.deadSound?.play();
      this.socket.emit("PlayerDied", { victimPlayerId: player.playerId });
    }

    if (this.players.every((p) => !p.isAlive || p.outUntilRoundEnd)) {
      this.endRound();
    }
  }

    canMove(tileX, tileY, direction) {
        const newX = tileX + direction.x;
        const newY = tileY + direction.y;
        return this.isPacmanPassable(newX, newY);
    }

    isPacmanPassable(toX, toY) {
        const rows = level1.length;
        const cols = level1[0].length;

        if (toY < 0 || toY >= rows) return false;

        // Wrap tunnels horizontally
        if (toX < 0) toX = cols - 1;
        if (toX >= cols) toX = 0;

        const tile = level1[toY]?.[toX];
        if (!tile) return false;

        // Walls
        const walls = ["═", "║", "╔", "╗", "╚", "╝", "┌", "┐", "└", "┘", "|", "-"];
        if (walls.includes(tile)) return false;

        // Ghost gate not passable by Pac-Man
        if (tile === "~~" || tile === "~") return false;

        return true;
    }

    update(time, delta) {
    if (!this.isRoundActive || this.isDying) {
      this.stopEatSound();
      for (const p of this.players) p.render(false);
      return;
    }

    let anyMoved = false;
    const movedFlags = new Array(this.players.length).fill(false);

    for (let i = 0; i < this.players.length; i++) {
      const moved = this.players[i].update(delta);
      movedFlags[i] = moved;
      if (moved) anyMoved = true;

      if (moved && !this.players[i].isRemote) this.collectDotAt(this.players[i]);
    }

    const eatingRecently = this.time.now - this.lastEatTime < 140;
    if (anyMoved && eatingRecently) {
      if (this.eatSound.isPaused) this.eatSound.resume();
      else if (!this.eatSound.isPlaying) this.eatSound.play();
    } else {
      this.stopEatSound();
    }

    this._applyGhostInterpolation();

        const hit = this.checkGhostCollision();
        if (hit) {
            const { ghost, player } = hit;

            if (!player.isRemote) {
                // ✅ IMPORTANT: ghosts in the house (or leaving) should NOT interact with Pac-Man at all.
                // This prevents "ghost in box makes me invincible for 7s" and also prevents dying to box ghosts.
                console.log("Ghost collision with Pac-Man!", ghost, player);
                if (ghost?.state !== "active") {
                    // ignore collisions with inHouse/leaving ghosts entirely
                    return;
                }

                // ✅ Only apply the optimistic local frightened window to ACTIVE ghosts
                const locallyFrightened =
                    ghost?.state === "frightened" && this.time.now < (this.localFrightenedUntilMs || 0);
                console.log(locallyFrightened)
                const isFrightened = ghost?.mode === "frightened" || locallyFrightened;

                // If not frightened, you die (like nature intended)
                if (!isFrightened) {
                    this.killPlayer(player);
                }
            }
        }


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
