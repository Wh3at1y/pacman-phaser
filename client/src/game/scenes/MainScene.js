import Phaser from "phaser";
import { level1 } from "../levels/level1";
import Ghost from "../Ghost";
import Player from "../Player";
import socket from "../../socket.js";

const TILE_SIZE = 24;

// Up to 4 Pac-Men (same properties, different spawn tiles)
const MAX_PLAYERS = 4;
const PACMAN_START_TILES = [
  { x: 13, y: 23 }, // P1 (requested)
  { x: 10, y: 23 }, // P2
  { x: 16, y: 23 }, // P3
  { x: 13, y: 26 }, // P4
];

const COLORS = [0xffff00, 0x800080, 0xffffff, 0x008000];

// Wall symbols (your ASCII maze)
const WALL_TILES = ["═", "║", "╔", "╗", "╚", "╝", "┌", "┐", "└", "┘", "|", "-", "~"];

// --- Networking tuning (client-side smoothing) ---
const NET = {
  STATE_SEND_MS: 100,     // how often we send our authoritative state
  MIN_SNAP_PX: 18,        // if remote is off by more than this, snap (prevents long drift)
  MAX_EXTRAP_MS: 150,     // (future-proof) if you extrapolate, don't do it longer than this
};

export default class MainScene extends Phaser.Scene {
  constructor(onHudUpdate, players, currentPlayer) {
    super("MainScene");
    this.onHudUpdate = onHudUpdate; // optional callback for React HUD
    this.currentPlayers = players;
    this.currentPlayer = currentPlayer;
    this.socket = socket;
  }

  preload() {
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

    // Multiplayer count comes from the server-provided player list
    this.numPlayers = Math.max(
      1,
      Math.min(MAX_PLAYERS, (this.currentPlayers?.length ?? 1))
    );
    this.registry.set("numPlayers", this.numPlayers);

    this.registry.set("round", this.round);
    this.registry.set("score", this.score);

    this.dotsRemaining = 0;
    this.dotsCollected = 0;

    // ---- GHOST MODE STATE ----
    this.ghostMode = "scatter";
    this.ghostModeElapsed = 0;

    // frightened state
    this.frightenedUntil = 0; // timestamp in ms (this.time.now)
    this.frightenedMs = 7000;

    // ---- AUDIO ----
    this.roundStartSound = this.sound.add("roundStart", { volume: 0 });
    this.eatSound = this.sound.add("eatLoop", { loop: true, volume: 0.45 });
    this.deadSound = this.sound.add("dead", { volume: 0.7 });
    this.lastEatTime = -999999;

    // ---- DOTS GROUP ----
    this.dots = this.add.group();

    // ---- PLAYERS ----
    this.players = [];
    this.playersBySocketId = new Map();

    for (let i = 0; i < this.numPlayers; i++) {
      const startTile = PACMAN_START_TILES[i] ?? PACMAN_START_TILES[0];
      const socketId = this.currentPlayers?.[i]?.socketId ?? `p${i}`;

      const isLocal = socketId === this.currentPlayer.socketId;

      // Local player uses keyboard controls; remote players ignore keyboard.
      const controls = isLocal ? this.input.keyboard.createCursorKeys() : null;

      const p = new Player(this, {
        startTile,
        speed: 160,
        radius: TILE_SIZE * 0.7,
        controls,
        socketId,
        color: COLORS[i] ?? COLORS[0],
        isRemote: !isLocal,
      });

      // Layer the mouth graphics above maze
      p.graphics.setDepth(1001);

      this.players.push(p);
      this.playersBySocketId.set(socketId, p);
    }

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
    // (Leaving your ghosts disabled here, as in your current file.)
    this.ghosts = [];

    // ---- HUD ----
    this.onHudUpdate?.({
      score: this.score,
      dotsCollected: this.dotsCollected,
      dotsRemaining: this.dotsRemaining,
      round: this.round,
      numPlayers: this.numPlayers,
    });

    // ---- MULTIPLAYER NETWORKING ----
    // Best-practice approach for tile games:
    // - Send INPUT events on key presses (cheap + responsive)
    // - Send STATE snapshots every ~100ms (drift correction + smooth remote interpolation)
    this.inputSeq = 0;
    this.stateSeq = 0;

    this._setupNetworking();

    this.startRound();
  }

  /* ===============================
     NETWORKING
  =============================== */

  _setupNetworking() {
    // Avoid stacked listeners if scene restarts
    this._teardownNetworking?.();

    const local = this.getLocalPlayer();

    // --- KeyPressed (input replication) ---
    this._onKeyDown = (event) => {
      if (!local) return;

      const code = event.code;
      const isArrow =
        code === "ArrowUp" ||
        code === "ArrowDown" ||
        code === "ArrowLeft" ||
        code === "ArrowRight";
      if (!isArrow) return;

      // Apply locally immediately (zero-latency feel)
      local.setNextDirection(code);

      // Send to server with seq for ordering
      this.socket.emit("KeyPressed", {
        socketId: local.socketId,
        dir: code,
        seq: ++this.inputSeq,
        t: this.time.now,
      });
    };

    this.input.keyboard.on("keydown", this._onKeyDown);

    this._onKeyPressed = ({ socketId, dir, seq }) => {
      const p = this.playersBySocketId.get(socketId);
      if (!p) return;

      // Ignore our own echo (some servers broadcast to sender too)
      if (socketId === local?.socketId) return;

      // Drop stale input (packet reorder)
      p.lastInputSeq = p.lastInputSeq ?? 0;
      if (seq != null && seq <= p.lastInputSeq) return;
      if (seq != null) p.lastInputSeq = seq;

      // Use input to orient + (optionally) help predict.
      // Remote movement is smoothed by state snapshots, but we still set their direction so the mouth faces correctly.
      p.setNextDirection(dir);
    };

    this.socket.on("KeyPressed", this._onKeyPressed);

    // --- PlayerState (authoritative snapshots for smoothing/correction) ---
    this._stateEvent = this.time.addEvent({
      delay: NET.STATE_SEND_MS,
      loop: true,
      callback: () => {
        const p = this.getLocalPlayer();
        if (!p) return;

        this.socket.emit("PlayerState", {
          socketId: p.socketId,
          // Tile is the authoritative grid coord
          tileX: p.tileX,
          tileY: p.tileY,
          // Pixel helps smooth when clients render at slightly different step boundaries
          x: p.sprite.x,
          y: p.sprite.y,
          dir: p.direction,
          nextDir: p.nextDirection,
          seq: ++this.stateSeq,
          t: this.time.now,
        });
      },
    });

    this._onPlayerState = ({ socketId, tileX, tileY, x, y, dir, nextDir, seq }) => {
      const p = this.playersBySocketId.get(socketId);
      if (!p) return;

      if (socketId === local?.socketId) return;

      // Drop stale states
      p.lastStateSeq = p.lastStateSeq ?? 0;
      if (seq != null && seq <= p.lastStateSeq) return;
      if (seq != null) p.lastStateSeq = seq;

      // Prefer pixel targets if provided, fallback to tile center.
      const tx = typeof x === "number" ? x : tileX * this.TILE_SIZE + this.TILE_SIZE / 2;
      const ty = typeof y === "number" ? y : tileY * this.TILE_SIZE + this.TILE_SIZE / 2;

      p.setNetTarget(tx, ty, tileX, tileY);

      // Keep remote facing correct (prevents "backwards mouth" during interpolation)
      if (dir && typeof dir === "object") p.direction = dir;
      if (nextDir && typeof nextDir === "object") p.nextDirection = nextDir;

      // If they somehow drift far (tab switch / hitch), snap to avoid visible rubber-banding for too long.
      const dx = p.sprite.x - tx;
      const dy = p.sprite.y - ty;
      const d2 = dx * dx + dy * dy;
      if (d2 > NET.MIN_SNAP_PX * NET.MIN_SNAP_PX) {
        p.snapToNetTarget();
      }
    };

    this.socket.on("PlayerState", this._onPlayerState);

    // Cleanup hook
    this._teardownNetworking = () => {
      if (this._onKeyDown) this.input.keyboard.off("keydown", this._onKeyDown);
      if (this._onKeyPressed) this.socket.off("KeyPressed", this._onKeyPressed);
      if (this._onPlayerState) this.socket.off("PlayerState", this._onPlayerState);
      if (this._stateEvent) this._stateEvent.remove(false);

      this._onKeyDown = null;
      this._onKeyPressed = null;
      this._onPlayerState = null;
      this._stateEvent = null;
    };

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this._teardownNetworking);
    this.events.once(Phaser.Scenes.Events.DESTROY, this._teardownNetworking);
  }

  getLocalPlayer() {
    return this.playersBySocketId.get(this.currentPlayer.socketId) ?? this.players[0];
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

    // Pac-Men cannot go through walls OR ghost door tiles
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

  collectDot(player) {
    if (!this.isRoundActive) return false;
    if (!player?.sprite) return false;

    const px = player.sprite.x;
    const py = player.sprite.y;

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
          numPlayers: this.numPlayers,
        });

        if (type === "power") {
          this.triggerFrightened();
        }

        if (this.dotsRemaining <= 0) {
          this.endRound();
        }
      }
    });

    return ateSomething;
  }

  /* ===============================
     ROUND FLOW
  =============================== */

  startRound() {
    this.isRoundActive = false;

    this.readyOverlay.setVisible(true);
    this.readyText.setVisible(true);

    this.roundStartSound?.play();

    // Reset all players to start tiles
    for (let i = 0; i < this.players.length; i++) {
      this.players[i].reset(PACMAN_START_TILES[i] ?? PACMAN_START_TILES[0]);
    }

    // reset frightened / modes
    this.frightenedUntil = 0;
    this.ghostMode = "scatter";
    this.ghostModeElapsed = 0;

    // reset ghosts
    for (const g of this.ghosts) g.reset?.();

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
    this.onHudUpdate?.({ round: this.round });

    // Your current behavior: rebuild dots.
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
     COLLISION (ANY PACMAN vs GHOST)
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

      // On ANY Pac-Man death: reset ALL player + ghost positions, keep dots as-is.
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
      movedFlags[i] = !!moved;
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
      if (hit.ghost.isFrightened?.()) {
        this.eatGhost(hit.ghost);
      } else {
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
            graphics.strokeLineShape(
              new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE, baseX + TILE / 2, baseY + TILE / 2)
            );
            graphics.strokeLineShape(
              new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE / 2, baseX + TILE, baseY + TILE / 2)
            );
            break;
          case "┐":
            graphics.lineStyle(thin, 0x0000ff, 1);
            graphics.strokeLineShape(
              new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE, baseX + TILE / 2, baseY + TILE / 2)
            );
            graphics.strokeLineShape(
              new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE / 2, baseX, baseY + TILE / 2)
            );
            break;
          case "└":
            graphics.lineStyle(thin, 0x0000ff, 1);
            graphics.strokeLineShape(
              new Phaser.Geom.Line(baseX + TILE / 2, baseY, baseX + TILE / 2, baseY + TILE / 2)
            );
            graphics.strokeLineShape(
              new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE / 2, baseX + TILE, baseY + TILE / 2)
            );
            break;
          case "┘":
            graphics.lineStyle(thin, 0x0000ff, 1);
            graphics.strokeLineShape(
              new Phaser.Geom.Line(baseX + TILE / 2, baseY, baseX + TILE / 2, baseY + TILE / 2)
            );
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
          case "╔":
            graphics.lineStyle(thick, 0x0000ff, 1);
            graphics.strokeLineShape(
              new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE, baseX + TILE / 2, baseY + TILE / 2)
            );
            graphics.strokeLineShape(
              new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE / 2, baseX + TILE, baseY + TILE / 2)
            );
            break;

          case "╗":
            graphics.lineStyle(thick, 0x0000ff, 1);
            graphics.strokeLineShape(
              new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE, baseX + TILE / 2, baseY + TILE / 2)
            );
            graphics.strokeLineShape(
              new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE / 2, baseX, baseY + TILE / 2)
            );
            break;

          case "╚":
            graphics.lineStyle(thick, 0x0000ff, 1);
            graphics.strokeLineShape(
              new Phaser.Geom.Line(baseX + TILE / 2, baseY, baseX + TILE / 2, baseY + TILE / 2)
            );
            graphics.strokeLineShape(
              new Phaser.Geom.Line(baseX + TILE / 2, baseY + TILE / 2, baseX + TILE, baseY + TILE / 2)
            );
            break;

          case "╝":
            graphics.lineStyle(thick, 0x0000ff, 1);
            graphics.strokeLineShape(
              new Phaser.Geom.Line(baseX + TILE / 2, baseY, baseX + TILE / 2, baseY + TILE / 2)
            );
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
