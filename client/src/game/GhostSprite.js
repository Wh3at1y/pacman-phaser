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

        this.gfx = scene.add.graphics();
        this.gfx.setDepth(1000);

        // Default position
        this.x = 0;
        this.y = 0;

        this.draw();
        this.gfx.setPosition(this.x, this.y);
    }

    destroy() {
        this.gfx?.destroy();
    }

    setState({ x, y, dir, mode }) {
        if (typeof x === "number") this.x = x;
        if (typeof y === "number") this.y = y;
        if (dir && typeof dir.x === "number" && typeof dir.y === "number") this.dir = dir;
        if (mode) this.mode = mode;

        this.draw();
        this.gfx.setPosition(this.x, this.y);
    }

    draw() {
        const TS = this.TS;

        // Size tuned to fit your tile scale (copied from your old Ghost.js) :contentReference[oaicite:2]{index=2}
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

        // Pupils look in direction of travel (same logic as old Ghost.js) :contentReference[oaicite:3]{index=3}
        const d = this.dir ?? { x: 1, y: 0 };
        const lookX = Phaser.Math.Clamp(d.x, -1, 1) * (eyeR * 0.45);
        const lookY = Phaser.Math.Clamp(d.y, -1, 1) * (eyeR * 0.45);

        // Colors
        const frightened = this.mode === "frightened";

        // Classic: frightened is blue, then flashes blue/white faster and faster near the end.
        // We drive the timing off MainScene.frightenedUntilMs, set from the server "FrightenedStart" event.
        let bodyColor = frightened ? 0x0000ff : this.color;
        const eyeWhite = 0xffffff;
        let pupilColor = frightened ? 0xffffff : 0x0000ff;

        if (frightened && this.scene?.time && typeof this.scene.frightenedUntilMs === "number") {
            const remaining = this.scene.frightenedUntilMs - this.scene.time.now;

            // Start flashing in the last ~2.5s
            if (remaining <= 2500) {
                // Accelerating period as time runs out (clamped).
                const period = Phaser.Math.Clamp(remaining / 6, 60, 220); // ms
                const phase = Math.floor((2500 - Math.max(0, remaining)) / period) % 2;

                // phase 0 = blue, phase 1 = white
                if (phase === 1) {
                    bodyColor = 0xffffff;
                    pupilColor = 0xff0000; // classic red pupils during the flash
                } else {
                    bodyColor = 0x0000ff;
                    pupilColor = 0xffffff;
                }
            } else {
                // solid frightened blue earlier
                bodyColor = 0x0000ff;
                pupilColor = 0xffffff;
            }
        }
        this.gfx.clear();

        // ---- BODY ----
        this.gfx.fillStyle(bodyColor, 1);

        this.gfx.beginPath();
        this.gfx.arc(0, topY, topRadius, Math.PI, 0, false);
        this.gfx.lineTo(halfW, bottomY);

        // Wavy bottom (4 bumps)
        const bumps = 4;
        const bumpW = w / bumps;
        const waveDepth = h * 0.15;

        for (let i = 0; i < bumps; i++) {
            const xRight = halfW - bumpW * i;
            const xMid = xRight - bumpW / 2;
            const xLeft = xRight - bumpW;

            this.gfx.lineTo(xMid, bottomY + waveDepth);
            this.gfx.lineTo(xLeft, bottomY);
        }

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
    }
}
