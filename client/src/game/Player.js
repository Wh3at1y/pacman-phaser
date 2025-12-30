import Phaser from "phaser";

/**
 * Player (Pac-Man) controller.
 * Multiplayer best-practice:
 * - Local player: deterministic grid simulation + immediate input response
 * - Remote players: render via interpolation to last received net target (smooth, non-jittery)
 */
export default class Player {
  /**
   * @param {Phaser.Scene} scene
   * @param {{
   *   startTile: {x:number,y:number},
   *   speed?: number,
   *   radius?: number,
   *   controls?: any,
   *   socketId?: string,
   *   color?: number,
   *   isRemote?: boolean
   * }} opts
   */
  constructor(scene, opts) {
    this.scene = scene;

    const {
      startTile,
      speed = 160,
      radius = scene.TILE_SIZE * 0.7,
      controls = null,
      socketId = "",
      color = 0xffff00,
      isRemote = false,
    } = opts;

    this.color = color;
    this.controls = controls;
    this.socketId = socketId;
    this.isRemote = isRemote;

    this.startTile = { x: startTile.x, y: startTile.y };

    this.tileX = startTile.x;
    this.tileY = startTile.y;

    this.direction = { x: 1, y: 0 };
    this.nextDirection = { x: 1, y: 0 };

    this.speed = speed;
    this.radius = radius;

    // Authoritative position (pixel-space).
    // We keep the actual body hidden; visuals are drawn via graphics so we can animate the mouth.
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

    // Mouth animation (drawn via graphics)
    this.graphics = this.scene.add.graphics();
    this.mouthAngle = 0.15;
    this.mouthOpening = true;
    this.mouthSpeed = 0.04;

    // --- Networking (remote smoothing) ---
    this.netTargetX = null;
    this.netTargetY = null;
    this.netTargetTileX = null;
    this.netTargetTileY = null;
  }

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

  setNetTarget(x, y, tileX = null, tileY = null) {
    this.netTargetX = x;
    this.netTargetY = y;
    this.netTargetTileX = tileX;
    this.netTargetTileY = tileY;
  }

  snapToNetTarget() {
    if (this.netTargetX == null || this.netTargetY == null) return;
    this.sprite.x = this.netTargetX;
    this.sprite.y = this.netTargetY;

    // keep logical tile in sync if provided
    if (typeof this.netTargetTileX === "number") this.tileX = this.netTargetTileX;
    if (typeof this.netTargetTileY === "number") this.tileY = this.netTargetTileY;
  }

  setPositionTile(tileX, tileY) {
    this.tileX = tileX;
    this.tileY = tileY;
    this.sprite.x = tileX * this.scene.TILE_SIZE + this.scene.TILE_SIZE / 2;
    this.sprite.y = tileY * this.scene.TILE_SIZE + this.scene.TILE_SIZE / 2;
  }

  reset(startTile = this.startTile) {
    this.tileX = startTile.x;
    this.tileY = startTile.y;

    this.direction = { x: 1, y: 0 };
    this.nextDirection = { x: 1, y: 0 };

    this.sprite.x = this.tileX * this.scene.TILE_SIZE + this.scene.TILE_SIZE / 2;
    this.sprite.y = this.tileY * this.scene.TILE_SIZE + this.scene.TILE_SIZE / 2;

    // Clear remote targets so we don't lerp to stale data
    this.netTargetX = null;
    this.netTargetY = null;
    this.netTargetTileX = null;
    this.netTargetTileY = null;

    this.mouthAngle = 0.15;
    this.mouthOpening = true;
  }

  getTile() {
    return { x: this.tileX, y: this.tileY };
  }

  getDirection() {
    return { x: this.direction.x, y: this.direction.y };
  }

  handleInput() {
    // Remote players never poll keyboard.
    if (this.isRemote) return;

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

    // Wrap when the CENTER passes the edge (stable)
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

    // direction angle
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

  _updateRemote(delta) {
    if (this.netTargetX == null || this.netTargetY == null) return false;

    const beforeX = this.sprite.x;
    const beforeY = this.sprite.y;

    // Smooth interpolation: exponential decay feels consistent across frame rates
    // tau ~= how quickly we converge (ms). 70–120ms is a good range for 100ms net updates.
    const tau = 90;
    const alpha = 1 - Math.exp(-delta / tau);

    this.sprite.x += (this.netTargetX - this.sprite.x) * alpha;
    this.sprite.y += (this.netTargetY - this.sprite.y) * alpha;

    // Keep logical tile roughly in sync so ghost targeting doesn't go insane.
    if (typeof this.netTargetTileX === "number") this.tileX = this.netTargetTileX;
    if (typeof this.netTargetTileY === "number") this.tileY = this.netTargetTileY;

    const moved = Math.abs(this.sprite.x - beforeX) > 0.05 || Math.abs(this.sprite.y - beforeY) > 0.05;
    return moved;
  }

  /**
   * Movement update. Returns whether Pac-Man moved this frame.
   * @param {number} delta - ms
   * @returns {boolean}
   */
  update(delta) {
    // Remote: render smoothing only (no grid simulation)
    if (this.isRemote) return this._updateRemote(delta);

    this.handleInput();

    // ---- SPEED-SAFE MOVEMENT ----
    // Move in substeps so you never tunnel through walls, regardless of speed.
    let remaining = (this.speed * delta) / 1000;
    const maxStep = this.scene.TILE_SIZE / 4;

    let movedThisFrame = false;

    while (remaining > 0) {
      const step = Math.min(maxStep, remaining);
      remaining -= step;

      // snap-to-center & decide next tile when near center
      const cx = this.tileX * this.scene.TILE_SIZE + this.scene.TILE_SIZE / 2;
      const cy = this.tileY * this.scene.TILE_SIZE + this.scene.TILE_SIZE / 2;

      const tol = Math.max(1, step + 0.25);
      if (Math.abs(this.sprite.x - cx) <= tol && Math.abs(this.sprite.y - cy) <= tol) {
        this.sprite.x = cx;
        this.sprite.y = cy;

        if (this.scene.canMove(this.tileX, this.tileY, this.nextDirection)) {
          this.direction = this.nextDirection;
        }

        // if blocked, stop advancing this substep loop
        if (!this.scene.canMove(this.tileX, this.tileY, this.direction)) {
          break;
        }

        // advance logical tile now that we committed to movement
        this.tileX += this.direction.x;
        this.tileY += this.direction.y;

        // apply wrap in tile-space too
        if (this.tileX < 0) this.tileX = this.scene.levelCols - 1;
        else if (this.tileX >= this.scene.levelCols) this.tileX = 0;
      }

      const beforeX = this.sprite.x;
      const beforeY = this.sprite.y;

      // Move pixel position
      this.sprite.x += this.direction.x * step;
      this.sprite.y += this.direction.y * step;

      this.handleTunnelWrap();

      // Collect during movement so fast speeds don’t skip dots
      this.scene.collectDot(this);

      if (Math.abs(this.sprite.x - beforeX) > 0.01 || Math.abs(this.sprite.y - beforeY) > 0.01) {
        movedThisFrame = true;
      }
    }

    return movedThisFrame;
  }

  /**
   * Update visuals.
   * @param {boolean} moving
   */
  render(moving) {
    this.animateMouth(moving);
    this.draw();
  }
}
