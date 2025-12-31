// Ghost.js
import Phaser from "phaser";

const DIRS = [
  // Tie-break order (classic): Up, Left, Down, Right
  { x: 0, y: -1, name: "UP" },
  { x: -1, y: 0, name: "LEFT" },
  { x: 0, y: 1, name: "DOWN" },
  { x: 1, y: 0, name: "RIGHT" },
];

const SOLID_WALLS = ["═", "║", "╔", "╗", "╚", "╝", "┌", "┐", "└", "┘", "|", "-"];
const GHOST_SCALE = 0.7;

function oppositeDir(a, b) {
  return a && b && a.x === -b.x && a.y === -b.y;
}

function dist2(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

export default class Ghost {
  constructor(scene, opts) {
    this.scene = scene;

    this.name = opts.name;
    this.baseColor = opts.color;
    this.color = opts.color;

    this.speed = opts.speed ?? 140;
    this.baseSpeed = this.speed;

    this.frightenedSpeedMul = 0.65;
    this.eyeSpeedMul = 1.6;
    this.regenDelayMs = 2000;

    this.scatterTarget = opts.scatterTarget ?? { x: 1, y: 1 };

    // Logical tile position
    this.tileX = opts.startTile?.x ?? 14;
    this.tileY = opts.startTile?.y ?? 11;

    // "startTile" is ghost's personal home spot in the box (marked by X tiles in your map).
    this.startTile = { x: this.tileX, y: this.tileY };

    const TS = this.scene.TILE_SIZE;
    this.x = this.tileX * TS + TS / 2;
    this.y = this.tileY * TS + TS / 2;

    this.dir = { x: 1, y: 0 };
    this.facing = { x: 1, y: 0 };

    this.mode = "scatter";
    this.frightenedUntil = 0;

    this.house = {
      enabled: false,
      doorTiles: [],
      exitTile: null,
      inHouseMinY: null,
      inHouseMaxY: null,
      releaseDelayMs: 0,
    };

    // active | inHouse | leaving | eaten
    this.state = "active";
    this.releaseAt = 0;

    this.noCollideUntil = 0;

    // Cache for eyes home tile (must be an X tile)
    this._eyeHomeTile = null;

    // Visual
    this.sprite = this.scene.add.graphics();
    this.sprite.setDepth(5);
    this.sprite.setScale(GHOST_SCALE);
    this._drawGhost();
    this.sprite.setPosition(this.x, this.y);

    this.snapToNearestPassable();
  }

  destroy() {
    this.sprite?.destroy();
  }

  configureHouse(cfg) {
    this.house.enabled = true;
    this.house.doorTiles = cfg.doorTiles ?? [];
    this.house.exitTile = cfg.exitTile ?? null;
    this.house.inHouseMinY = cfg.inHouseMinY ?? null;
    this.house.inHouseMaxY = cfg.inHouseMaxY ?? null;
    this.house.releaseDelayMs = cfg.releaseDelayMs ?? 0;
  }

  reset() {
    this.tileX = this.startTile.x;
    this.tileY = this.startTile.y;

    const TS = this.scene.TILE_SIZE;
    this.x = this.tileX * TS + TS / 2;
    this.y = this.tileY * TS + TS / 2;

    this.dir = { x: 1, y: 0 };
    this.facing = { x: 1, y: 0 };

    this.frightenedUntil = 0;
    this.state = "active";
    this.releaseAt = 0;
    this.noCollideUntil = 0;

    this._eyeHomeTile = null;

    this.setColor(this.baseColor);
    this.sprite?.setPosition(this.x, this.y);

    this.snapToNearestPassable();

    // Start in the box if we spawned on an X tile
    if (this.house.enabled && this.isHouseTile(this.tileX, this.tileY)) {
      this.state = "inHouse";
      this.releaseAt = this.scene.time.now + (this.house.releaseDelayMs ?? 0);
      this.dir = { x: 0, y: -1 };
    }

    this._drawGhost();
  }

  onEaten() {
    // Eyes removed: teleport straight back into the ghost box and re-queue release.
    const TS = this.scene.TILE_SIZE;

    // Clear frightened immediately.
    this.frightenedUntil = 0;
    this.setColor(this.baseColor);

    // Teleport to this ghost's home tile (inside the box).
    this.tileX = this.startTile.x;
    this.tileY = this.startTile.y;
    this.x = this.tileX * TS + TS / 2;
    this.y = this.tileY * TS + TS / 2;

    // Put it back into the box waiting state.
    this.state = "inHouse";
    this.releaseAt = this.scene.time.now + (this.house.releaseDelayMs ?? 0);
    this.dir = { x: 0, y: -1 };
    this.facing = { x: 0, y: -1 };

    // Prevent immediate re-hit on the same frame.
    this.noCollideUntil = this.scene.time.now + 600;

    // Safety: snap if the configured tile is invalid.
    this.snapToNearestPassable();

    this.sprite?.setPosition(this.x, this.y);
    this._drawGhost();
  }

  setMode(mode) {
    if (mode === "scatter" || mode === "chase") this.mode = mode;
  }

  isFrightened() {
    return this.scene.time.now < this.frightenedUntil;
  }

  setColor(hex) {
    this.color = hex;
    this._drawGhost();
  }

  resetColorIfNeeded() {
    if (this.state === "eaten") return;
    if (!this.isFrightened() && this.color !== this.baseColor) {
      this.setColor(this.baseColor);
    }
  }

  reverseDirection() {
    this.dir = { x: -this.dir.x, y: -this.dir.y };
  }

  canBeFrightened() {
    if (this.state === "eaten") return false;
    if (this.state && this.state !== "active") return false;

    const t = this.getTile(this.tileX, this.tileY);
    if (t === "X" || t === "~" || t === "~~") return false;

    return true;
  }

  onEnergizer(durationMs = 6000) {
    this._syncTileFromPixels();
    if (!this.canBeFrightened()) return;

    this.reverseDirection();
    this.frightenedUntil = this.scene.time.now + durationMs;
    this._drawGhost();
  }

  /* ===============================
     TILES / GEOMETRY
  =============================== */

  getTile(x, y) {
    return this.scene.getTileAt?.(x, y);
  }

  isHouseTile(x, y) {
    return this.getTile(x, y) === "X";
  }

  isGateTile(x, y) {
    const t = this.getTile(x, y);
    return t === "~" || t === "~~";
  }

  wrapXTile(x) {
    const cols = this.scene.levelCols;
    if (x < 0) return cols - 1;
    if (x >= cols) return 0;
    return x;
  }

  wrapXPixel() {
    const TS = this.scene.TILE_SIZE;
    const mapW = this.scene.levelCols * TS;

    if (this.x < -TS / 2) this.x = mapW + TS / 2;
    else if (this.x > mapW + TS / 2) this.x = -TS / 2;
  }

  atTileCenter() {
    const TS = this.scene.TILE_SIZE;
    const cx = this.tileX * TS + TS / 2;
    const cy = this.tileY * TS + TS / 2;
    return Math.abs(this.x - cx) < 0.75 && Math.abs(this.y - cy) < 0.75;
  }

  snapToCenter() {
    const TS = this.scene.TILE_SIZE;
    this.x = this.tileX * TS + TS / 2;
    this.y = this.tileY * TS + TS / 2;
  }

  _syncTileFromPixels() {
    const TS = this.scene.TILE_SIZE;

    let tx = Math.floor(this.x / TS);
    let ty = Math.floor(this.y / TS);

    tx = this.wrapXTile(tx);
    ty = Math.max(0, Math.min(this.scene.levelRows - 1, ty));

    this.tileX = tx;
    this.tileY = ty;
  }

  /* ===============================
     PASSABILITY
  =============================== */

  canStep(fromX, fromY, toX, toY) {
    if (toY < 0 || toY >= this.scene.levelRows) return false;

    const tile = this.getTile(toX, toY);
    if (!tile) return false;

    if (SOLID_WALLS.includes(tile)) return false;

    // Eyes must be able to enter the gate and move inside the house.
    if (this.state === "eaten") {
      if (tile === "X" || tile === "~" || tile === "~~") return true;
    }

    // Everyone else uses scene rules (gate one-way out).
    return this.scene.isGhostPassable(fromX, fromY, toX, toY);
  }

  // Same as canStep, but always with "eyes" semantics
  _canStepEyes(fromX, fromY, toX, toY) {
    if (toY < 0 || toY >= this.scene.levelRows) return false;

    const tile = this.getTile(toX, toY);
    if (!tile) return false;
    if (SOLID_WALLS.includes(tile)) return false;

    if (tile === "X" || tile === "~" || tile === "~~") return true;

    return this.scene.isGhostPassable(fromX, fromY, toX, toY);
  }

  snapToNearestPassable() {
    const cols = this.scene.levelCols;
    const rows = this.scene.levelRows;

    const ok = (x, y) => {
      if (y < 0 || y >= rows) return false;
      if (x < 0) x = cols - 1;
      if (x >= cols) x = 0;
      return this.scene.isGhostPassable(x, y, x, y);
    };

    if (ok(this.tileX, this.tileY)) return;

    const q = [{ x: this.tileX, y: this.tileY }];
    const seen = new Set([`${this.tileX},${this.tileY}`]);

    while (q.length) {
      const p = q.shift();
      for (const d of DIRS) {
        let nx = p.x + d.x;
        const ny = p.y + d.y;

        if (ny < 0 || ny >= rows) continue;
        if (nx < 0) nx = cols - 1;
        if (nx >= cols) nx = 0;

        const key = `${nx},${ny}`;
        if (seen.has(key)) continue;
        seen.add(key);

        if (ok(nx, ny)) {
          this.tileX = nx;
          this.tileY = ny;
          const TS = this.scene.TILE_SIZE;
          this.x = nx * TS + TS / 2;
          this.y = ny * TS + TS / 2;
          this.sprite.setPosition(this.x, this.y);
          return;
        }

        q.push({ x: nx, y: ny });
      }
    }
  }

  /* ===============================
     TARGETING (ACTIVE AI)
  =============================== */

  getChaseTarget(pacTile, pacDir) {
    const cols = this.scene.levelCols;
    const rows = this.scene.levelRows;

    const clampY = (y) => Math.max(0, Math.min(rows - 1, y));
    const wrapX = (x) => {
      if (x < 0) return cols - 1;
      if (x >= cols) return 0;
      return x;
    };

    if (!pacDir) pacDir = { x: 1, y: 0 };

    if (this.name === "pinky") {
      const ahead = 4;
      return { x: wrapX(pacTile.x + pacDir.x * ahead), y: clampY(pacTile.y + pacDir.y * ahead) };
    }

    if (this.name === "inky") {
      const ahead = 2;
      const p2 = { x: wrapX(pacTile.x + pacDir.x * ahead), y: clampY(pacTile.y + pacDir.y * ahead) };
      const blinky = this.scene.ghosts?.find((g) => g.name === "blinky");
      if (!blinky) return p2;

      const vx = p2.x - blinky.tileX;
      const vy = p2.y - blinky.tileY;
      return { x: wrapX(blinky.tileX + vx * 2), y: clampY(blinky.tileY + vy * 2) };
    }

    if (this.name === "clyde") {
      const d = Math.sqrt(dist2(this.tileX, this.tileY, pacTile.x, pacTile.y));
      if (d >= 8) return { x: pacTile.x, y: pacTile.y };
      return { ...this.scatterTarget };
    }

    return { x: pacTile.x, y: pacTile.y };
  }

  chooseDirToward(targetTile, allowReverse = false) {
    const fromX = this.tileX;
    const fromY = this.tileY;

    const candidates = [];
    for (const d of DIRS) {
      const toX = this.wrapXTile(fromX + d.x);
      const toY = fromY + d.y;
      if (toY < 0 || toY >= this.scene.levelRows) continue;
      if (!this.canStep(fromX, fromY, toX, toY)) continue;
      candidates.push(d);
    }

    if (candidates.length === 0) return this.dir;

    let usable = candidates;
    if (!allowReverse && candidates.length > 1) {
      const noRev = candidates.filter((d) => !oppositeDir(d, this.dir));
      if (noRev.length) usable = noRev;
    }

    let best = usable[0];
    let bestScore = Infinity;
    for (const d of usable) {
      const nx = this.wrapXTile(fromX + d.x);
      const ny = fromY + d.y;
      const score = dist2(nx, ny, targetTile.x, targetTile.y);
      if (score < bestScore) {
        bestScore = score;
        best = d;
      }
    }

    return best;
  }

  chooseDirAwayFrom(pacTile) {
    const fromX = this.tileX;
    const fromY = this.tileY;

    const candidates = [];
    for (const d of DIRS) {
      const toX = this.wrapXTile(fromX + d.x);
      const toY = fromY + d.y;
      if (toY < 0 || toY >= this.scene.levelRows) continue;
      if (!this.canStep(fromX, fromY, toX, toY)) continue;
      candidates.push(d);
    }

    if (candidates.length === 0) return this.dir;

    let usable = candidates;
    if (candidates.length > 1) {
      const noRev = candidates.filter((d) => !oppositeDir(d, this.dir));
      if (noRev.length) usable = noRev;
    }

    let best = usable[0];
    let bestScore = -Infinity;
    for (const d of usable) {
      const nx = this.wrapXTile(fromX + d.x);
      const ny = fromY + d.y;
      const score = dist2(nx, ny, pacTile.x, pacTile.y);
      if (score > bestScore) {
        bestScore = score;
        best = d;
      }
    }

    return best;
  }

  /* ===============================
     HOUSE / EYES PATHING
  =============================== */

  _closestDoorTile() {
    const tiles = this.house?.doorTiles;
    if (!tiles || tiles.length === 0) return null;

    let best = tiles[0];
    let bestD = Infinity;
    for (const t of tiles) {
      const d = dist2(this.tileX, this.tileY, t.x, t.y);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    return best;
  }

  _getEyeHomeTile() {
    if (this._eyeHomeTile) return this._eyeHomeTile;

    // If the ghost's personal start tile is inside the house, use that.
    if (this.isHouseTile(this.startTile.x, this.startTile.y)) {
      this._eyeHomeTile = { x: this.startTile.x, y: this.startTile.y };
      return this._eyeHomeTile;
    }

    // Otherwise: pick a sensible X tile under the door first (common layouts).
    const door = this._closestDoorTile();
    if (door) {
      const below = { x: door.x, y: door.y + 1 };
      if (this.isHouseTile(below.x, below.y)) {
        this._eyeHomeTile = below;
        return this._eyeHomeTile;
      }
    }

    // Fallback: find any X tile (first one found scanning).
    for (let y = 0; y < this.scene.levelRows; y++) {
      for (let x = 0; x < this.scene.levelCols; x++) {
        if (this.isHouseTile(x, y)) {
          this._eyeHomeTile = { x, y };
          return this._eyeHomeTile;
        }
      }
    }

    // If the map has no X (shouldn't happen), just use start.
    this._eyeHomeTile = { x: this.startTile.x, y: this.startTile.y };
    return this._eyeHomeTile;
  }

  _computeReverseDistancesEyes(target) {
    if (!target) return null;

    const cols = this.scene.levelCols;
    const rows = this.scene.levelRows;
    const key = (x, y) => `${x},${y}`;

    const dist = new Map();
    const q = [{ x: target.x, y: target.y }];
    dist.set(key(target.x, target.y), 0);

    while (q.length) {
      const cur = q.shift();
      const curK = key(cur.x, cur.y);
      const curD = dist.get(curK);

      for (const d of DIRS) {
        // predecessor tile that could step INTO cur
        let px = cur.x - d.x;
        const py = cur.y - d.y;

        if (py < 0 || py >= rows) continue;
        if (px < 0) px = cols - 1;
        if (px >= cols) px = 0;

        if (!this._canStepEyes(px, py, cur.x, cur.y)) continue;

        const pk = key(px, py);
        if (dist.has(pk)) continue;

        dist.set(pk, curD + 1);
        q.push({ x: px, y: py });
      }
    }

    return dist;
  }

  _pickDirByDistances(distMap, allowReverse = false) {
    const fromX = this.tileX;
    const fromY = this.tileY;

    const candidates = [];
    for (const d of DIRS) {
      const nx = this.wrapXTile(fromX + d.x);
      const ny = fromY + d.y;
      if (ny < 0 || ny >= this.scene.levelRows) continue;
      if (!this._canStepEyes(fromX, fromY, nx, ny)) continue;
      candidates.push(d);
    }
    if (candidates.length === 0) return this.dir;

    let usable = candidates;
    if (!allowReverse && candidates.length > 1) {
      const noRev = candidates.filter((d) => !oppositeDir(d, this.dir));
      if (noRev.length) usable = noRev;
    }

    let best = null;
    let bestDist = Infinity;

    for (const d of usable) {
      const nx = this.wrapXTile(fromX + d.x);
      const ny = fromY + d.y;
      const dd = distMap?.get(`${nx},${ny}`);
      const score = dd === undefined ? Infinity : dd;
      if (score < bestDist) {
        bestDist = score;
        best = d;
      }
    }

    // Stabilize: if continuing forward is equally optimal, keep going.
    if (best && distMap) {
      const fx = this.wrapXTile(fromX + this.dir.x);
      const fy = fromY + this.dir.y;
      if (fy >= 0 && fy < this.scene.levelRows && this._canStepEyes(fromX, fromY, fx, fy)) {
        const fScore = distMap.get(`${fx},${fy}`);
        if (fScore !== undefined && fScore === bestDist) return this.dir;
      }
    }

    return best ?? usable[0];
  }

  _planEyesDir() {
    // Called at tile center.
    const door = this._closestDoorTile();
    const home = this._getEyeHomeTile();
    const insideHouse = this.isHouseTile(this.tileX, this.tileY);

    // If outside and standing on the door tile, force DOWN into the house.
    if (!insideHouse && door && this.tileX === door.x && this.tileY === door.y) {
      this.dir = { x: 0, y: 1 };
      return;
    }

    const target = insideHouse ? home : (door ?? home);
    const distMap = this._computeReverseDistancesEyes(target);
    this.dir = this._pickDirByDistances(distMap, false);
  }

  _updateHouseState() {
    if (!this.house.enabled) return;

    if (this.state === "inHouse") {
      if (this.scene.time.now >= this.releaseAt) {
        this.state = "leaving";
        return;
      }

      if (!this.atTileCenter()) return;
      this.snapToCenter();

      const minY = this.house.inHouseMinY ?? this.tileY;
      const maxY = this.house.inHouseMaxY ?? this.tileY;

      if (this.dir.y === 0) this.dir = { x: 0, y: -1 };
      if (this.tileY <= minY) this.dir = { x: 0, y: 1 };
      else if (this.tileY >= maxY) this.dir = { x: 0, y: -1 };

      const nx = this.wrapXTile(this.tileX + this.dir.x);
      const ny = this.tileY + this.dir.y;
      if (!this.canStep(this.tileX, this.tileY, nx, ny)) {
        this.dir = { x: 0, y: -this.dir.y };
      }
      return;
    }

    if (this.state === "leaving") {
      const door = this._closestDoorTile();
      const exit = this.house.exitTile;

      if (!door || !exit) {
        this.state = "active";
        return;
      }

      if (this.tileY <= exit.y) {
        this.state = "active";
        return;
      }

      if (!this.atTileCenter()) return;
      this.snapToCenter();

      if (this.tileX === door.x && this.tileY === door.y) {
        this.dir = { x: 0, y: -1 };
      } else {
        this.dir = this.chooseDirToward(door, true);
      }
    }
  }

  _updateEatenState() {
    if (!this.atTileCenter()) return;
    this.snapToCenter();
    this._syncTileFromPixels();
    this._planEyesDir();
  }

  /* ===============================
     RENDERING
  =============================== */

  _drawGhost() {
    if (!this.sprite) return;

    const TS = this.scene.TILE_SIZE;
    const w = TS * 2;
    const h = TS * 2;

    const eyeOffsetX = w * 0.18;
    const eyeOffsetY = -h * 0.10;
    const eyeR = w * 0.13;
    const pupilR = eyeR * 0.45;

    const dir = this.facing ?? this.dir ?? { x: 1, y: 0 };
    const lookX = Phaser.Math.Clamp(dir.x, -1, 1) * (eyeR * 0.45);
    const lookY = Phaser.Math.Clamp(dir.y, -1, 1) * (eyeR * 0.45);

    const eyeWhite = 0xffffff;
    const pupilColor =
      this.state === "eaten" ? 0x0000ff : this.isFrightened() ? 0xffffff : 0x0000ff;
    const bodyColor = this.isFrightened() ? 0x0000ff : this.color;

    this.sprite.clear();

    // Eyes only
    if (this.state === "eaten") {
      this.sprite.fillStyle(eyeWhite, 1);
      this.sprite.fillCircle(-eyeOffsetX, eyeOffsetY, eyeR);
      this.sprite.fillCircle(eyeOffsetX, eyeOffsetY, eyeR);

      this.sprite.fillStyle(pupilColor, 1);
      this.sprite.fillCircle(-eyeOffsetX + lookX, eyeOffsetY + lookY, pupilR);
      this.sprite.fillCircle(eyeOffsetX + lookX, eyeOffsetY + lookY, pupilR);
      return;
    }

    const halfW = w / 2;
    const halfH = h / 2;

    const topRadius = halfW;
    const bottomY = halfH;
    const topY = -halfH + topRadius;

    this.sprite.fillStyle(bodyColor, 1);
    this.sprite.beginPath();
    this.sprite.arc(0, topY, topRadius, Math.PI, 0, false);
    this.sprite.lineTo(halfW, bottomY);

    const bumps = 4;
    const bumpW = w / bumps;
    const waveDepth = h * 0.15;

    for (let i = 0; i < bumps; i++) {
      const xRight = halfW - bumpW * i;
      const xMid = xRight - bumpW / 2;
      const xLeft = xRight - bumpW;

      this.sprite.lineTo(xMid, bottomY + waveDepth);
      this.sprite.lineTo(xLeft, bottomY);
    }

    this.sprite.lineTo(-halfW, topY);
    this.sprite.closePath();
    this.sprite.fillPath();

    this.sprite.fillStyle(eyeWhite, 1);
    this.sprite.fillCircle(-eyeOffsetX, eyeOffsetY, eyeR);
    this.sprite.fillCircle(eyeOffsetX, eyeOffsetY, eyeR);

    this.sprite.fillStyle(pupilColor, 1);
    this.sprite.fillCircle(-eyeOffsetX + lookX, eyeOffsetY + lookY, pupilR);
    this.sprite.fillCircle(eyeOffsetX + lookX, eyeOffsetY + lookY, pupilR);
  }

  /* ===============================
     UPDATE
  =============================== */

  update(delta, pacTile, pacDir) {
    const prevX = this.x;
    const prevY = this.y;

    this.resetColorIfNeeded();

    const TS = this.scene.TILE_SIZE;
    this._syncTileFromPixels();

    let effSpeed = this.baseSpeed;
    if (this.isFrightened()) effSpeed *= this.frightenedSpeedMul;
    if (this.state === "eaten") effSpeed *= this.eyeSpeedMul;

    let remaining = (effSpeed * delta) / 1000;
    const maxStep = TS / 6;

    while (remaining > 0) {
      const step = Math.min(maxStep, remaining);

      if (this.atTileCenter()) {
        this.snapToCenter();
        this._syncTileFromPixels();

        if (this.state === "eaten") {
          const home = this._getEyeHomeTile();
          if (this.tileX === home.x && this.tileY === home.y) {
            this.state = "inHouse";
            this.releaseAt = this.scene.time.now + this.regenDelayMs;
            this.frightenedUntil = 0;
            this.setColor(this.baseColor);
            this.dir = { x: 0, y: -1 };
          } else {
            this._updateEatenState();
          }
        } else if (this.state === "inHouse" || this.state === "leaving") {
          this._updateHouseState();
        } else if (this.state === "active") {
          if (this.isFrightened()) {
            this.dir = this.chooseDirAwayFrom(pacTile);
          } else {
            const target = this.mode === "scatter" ? this.scatterTarget : this.getChaseTarget(pacTile, pacDir);
            this.dir = this.chooseDirToward(target, false);
          }
        }

        // Validate direction, replan immediately if blocked (prevents grinding into walls)
        const nextTX = this.wrapXTile(this.tileX + this.dir.x);
        const nextTY = this.tileY + this.dir.y;

        const stepOk =
          nextTY >= 0 &&
          nextTY < this.scene.levelRows &&
          (this.state === "eaten"
            ? this._canStepEyes(this.tileX, this.tileY, nextTX, nextTY)
            : this.canStep(this.tileX, this.tileY, nextTX, nextTY));

        if (!stepOk) {
          if (this.state === "eaten") {
            this._planEyesDir();
          } else if (this.state === "active") {
            // pick first legal move in priority order excluding reverse if possible
            const candidates = DIRS.filter((d) => {
              const tx = this.wrapXTile(this.tileX + d.x);
              const ty = this.tileY + d.y;
              return ty >= 0 && ty < this.scene.levelRows && this.canStep(this.tileX, this.tileY, tx, ty);
            });

            let usable = candidates;
            if (candidates.length > 1) {
              const noRev = candidates.filter((d) => !oppositeDir(d, this.dir));
              if (noRev.length) usable = noRev;
            }

            if (usable.length) this.dir = usable[0];
          } else {
            remaining = 0;
            break;
          }
        }
      }

      const prevTX = this.tileX;
      const prevTY = this.tileY;

      this.x += this.dir.x * step;
      this.y += this.dir.y * step;

      this.wrapXPixel();

      const nextTileX = this.wrapXTile(Math.floor(this.x / TS));
      const nextTileY = Math.floor(this.y / TS);

      if (nextTileY < 0 || nextTileY >= this.scene.levelRows) {
        this.snapToCenter();
        break;
      }

      if (nextTileX !== prevTX || nextTileY !== prevTY) {
        const ok =
          this.state === "eaten"
            ? this._canStepEyes(prevTX, prevTY, nextTileX, nextTileY)
            : this.canStep(prevTX, prevTY, nextTileX, nextTileY);

        if (!ok) {
          this.tileX = prevTX;
          this.tileY = prevTY;
          this.snapToCenter();
          break;
        }

        this.tileX = nextTileX;
        this.tileY = nextTileY;
      }

      remaining -= step;
    }

    // Facing drives pupil direction
    const dx = this.x - prevX;
    const dy = this.y - prevY;
    if (Math.abs(dx) + Math.abs(dy) > 0.001) {
      const len = Math.hypot(dx, dy) || 1;
      this.facing = { x: dx / len, y: dy / len };
    }

    this.sprite.setPosition(this.x, this.y);
    this._drawGhost();
  }
}
