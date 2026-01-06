// GhostSprite.js
import Phaser from "phaser";

export default class GhostSprite {
    constructor(scene, ghostId, color, tileSize) {
        this.scene = scene;
        this.ghostId = ghostId;
        this.baseColor = color;
        this.color = color;
        this.TS = tileSize;

        this.dir = { x: 1, y: 0 };
        this.mode = "scatter";

        this.x = 0;
        this.y = 0;

        // 2-frame feet animation phase
        this._feetPhase = 0;

        this.gfx = scene.add.graphics();
        this.gfx.setDepth(1000);

        // Wiggle feet all the time at low FPS (cheap, classic feel)
        this._feetTimer = this.scene.time.addEvent({
            delay: 90, // ~11 fps
            loop: true,
            callback: () => {
                this._feetPhase ^= 1;
                this.draw();
                this.gfx.setPosition(this.x, this.y);
            },
        });

        this.draw();
        this.gfx.setPosition(this.x, this.y);
    }

    destroy() {
        this._feetTimer?.remove?.();
        this._feetTimer = null;
        this.gfx?.destroy();
    }

    setState({ x, y, dir, mode }) {
        if (typeof x === "number") this.x = x;
        if (typeof y === "number") this.y = y;
        if (dir && typeof dir.x === "number" && typeof dir.y === "number") this.dir = dir;
        if (mode) this.mode = mode;

        this.gfx.setPosition(this.x, this.y);
        this.draw();
    }

    draw() {
        const TS = this.TS;

        // Size tuned to your tiles
        const w = TS * 1.4;
        const h = TS * 1.4;

        const halfW = w / 2;
        const halfH = h / 2;

        const topRadius = halfW;
        const bottomY = halfH;
        const topY = -halfH + topRadius;

        // Eyes
        const eyeOffsetX = w * 0.18;
        const eyeOffsetY = -h * 0.10;
        const eyeR = w * 0.13;
        const pupilR = eyeR * 0.45;

        // Pupils look in direction of travel
        const d = this.dir ?? { x: 1, y: 0 };
        const lookX = Phaser.Math.Clamp(d.x, -1, 1) * (eyeR * 0.45);
        const lookY = Phaser.Math.Clamp(d.y, -1, 1) * (eyeR * 0.45);

        const frightened = this.mode === "frightened";

        // --- Colors ---
        let bodyColor = frightened ? 0x2121ff : this.color;
        const eyeWhite = 0xffffff;
        let pupilColor = frightened ? 0xffffff : 0x2121ff;

        // Frightened flashing near end (stable timing)
        if (frightened && this.scene?.time && typeof this.scene.frightenedUntilMs === "number") {
            const remaining = this.scene.frightenedUntilMs - this.scene.time.now;

            const flashWindowMs = 2000;
            bodyColor = 0x2121ff;
            pupilColor = 0xffffff;

            if (remaining <= flashWindowMs) {
                const t = flashWindowMs - Math.max(0, remaining);

// RAMP blink speed: as remaining goes 2000ms -> 0ms, period goes 220ms -> 60ms
                const minP = 60;   // fastest blink near zero
                const maxP = 220;  // slow blink at start of flash window

                const u = Phaser.Math.Clamp(remaining / flashWindowMs, 0, 1); // 1 -> 0
// ease-out so it accelerates harder near the end
                const eased = u * u; // quadratic
                const period = minP + (maxP - minP) * eased;

                const phase = Math.floor(t / period) % 2;


                if (phase === 1) {
                    bodyColor = 0xffffff;
                    pupilColor = 0xff0000;
                } else {
                    bodyColor = 0x2121ff;
                    pupilColor = 0xffffff;
                }
            }
        }

        this.gfx.clear();

        // ---- BODY ----
        this.gfx.fillStyle(bodyColor, 1);
        this.gfx.beginPath();

        // Head
        this.gfx.arc(0, topY, topRadius, Math.PI, 0, false);

        // Right side down
        this.gfx.lineTo(halfW, bottomY);

        // ---- FEET (always wiggle LEFT/RIGHT) ----
        const bumps = 4;
        const bumpW = w / bumps;
        const waveDepth = h * 0.15;

        // Shift the notch points left/right (2-frame walk feel)
        const xWiggle = this._feetPhase ? (bumpW * 0.18) : -(bumpW * 0.18);

        for (let i = 0; i < bumps; i++) {
            const xRight = halfW - bumpW * i;
            const xMid = (xRight - bumpW / 2) + xWiggle;
            const xLeft = xRight - bumpW;

            this.gfx.lineTo(xMid, bottomY + waveDepth);
            this.gfx.lineTo(xLeft, bottomY);
        }

        // Left side up + close
        this.gfx.lineTo(-halfW, topY);
        this.gfx.closePath();
        this.gfx.fillPath();

        // ---- EYES ----
        this.gfx.fillStyle(eyeWhite, 1);
        this.gfx.fillCircle(-eyeOffsetX, eyeOffsetY, eyeR);
        this.gfx.fillCircle(eyeOffsetX, eyeOffsetY, eyeR);

        this.gfx.fillStyle(pupilColor, 1);
        this.gfx.fillCircle(-eyeOffsetX + lookX, eyeOffsetY + lookY, pupilR);
        this.gfx.fillCircle(eyeOffsetX + lookX, eyeOffsetY + lookY, pupilR);

        // ---- FRIGHTENED MOUTH (soft squiggle) ----
        if (frightened) {
            const mouthY = eyeOffsetY + eyeR * 2.55;
            const mouthW = w * 0.58;

            // softer wave than the jagged zigzag
            const amp = h * 0.065;
            const cycles = 2.2;
            const samples = 24;

            const mouthColor = (bodyColor === 0xffffff) ? 0xff0000 : 0xffffff;

            this.gfx.lineStyle(Math.max(2, Math.round(TS * 0.075)), mouthColor, 1);
            this.gfx.beginPath();

            for (let i = 0; i <= samples; i++) {
                const t = i / samples;
                const x = -mouthW / 2 + mouthW * t;
                const y = mouthY + Math.sin(t * Math.PI * 2 * cycles) * amp;

                if (i === 0) this.gfx.moveTo(x, y);
                else this.gfx.lineTo(x, y);
            }

            this.gfx.strokePath();
        }
    }
}
