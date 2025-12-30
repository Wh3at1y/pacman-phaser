// server/index.js (ESM)
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import http from "http";
import { Server } from "socket.io";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Render provides PORT. Default locally if needed.
const PORT = process.env.PORT || 10000;

// If you split frontend/backend later, set CLIENT_ORIGIN to your frontend URL.
// If serving React from this same server, you can keep origin:true.
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || true;

// ----- Lobby/game state -----
const playerNames = ["ButterBall", "Chowder", "BubbleWrap", "OrbitGum"];

// playerId -> { playerId, name, ready, socketId, lastSeen }
const players = new Map();

// ----- Express + HTTP server -----
const app = express();
app.use(express.json());

app.get("/api/health", (_req, res) => {
    res.json({ ok: true, uptime: process.uptime() });
});

const server = http.createServer(app);

// ----- Socket.IO on the same server/port -----
const io = new Server(server, {
    cors: {
        origin: CLIENT_ORIGIN,
        methods: ["GET", "POST"],
        credentials: true,
    },
    transports: ["websocket", "polling"],
});

function emitLobbyState() {
    // Map -> plain object
    io.emit("joined", Object.fromEntries(players.entries()));
}

function pickName() {
    const existingNames = Array.from(players.values()).map((p) => p.name);
    const available = playerNames.filter((n) => !existingNames.includes(n));
    const pool = available.length ? available : playerNames;
    return pool[Math.floor(Math.random() * pool.length)];
}

io.on("connection", (socket) => {
    const playerId = socket.handshake.auth?.playerId;

    if (!playerId) {
        socket.disconnect(true);
        return;
    }

    // Re-associate or create player
    const existing = players.get(playerId);
    if (existing) {
        existing.socketId = socket.id;
        existing.lastSeen = Date.now();
    } else {
        players.set(playerId, {
            playerId,
            name: pickName(),
            ready: false,
            socketId: socket.id,
            lastSeen: Date.now(),
        });
    }

    // Broadcast lobby state to everyone
    emitLobbyState();

    // Toggle ready
    socket.on("player_ready", () => {
        const p = players.get(playerId);
        if (!p) return;
        p.ready = !p.ready;
        emitLobbyState();
    });

    // Start game (keep your existing event names)
    socket.on("start_game", () => {
        io.emit("start_game_all");
    });

    // --- Multiplayer movement input ---
    // Supports:
    // 1) New payload: { socketId, dir, seq, t }
    // 2) Old payload: (eventCode, socketId)
    socket.on("KeyPressed", (arg1, arg2) => {
        let socketId;
        let dir;
        let seq = 0;
        let t = Date.now();

        if (typeof arg1 === "object" && arg1 !== null) {
            // New style
            socketId = arg1.socketId || socket.id;
            dir = arg1.dir;
            seq = arg1.seq ?? 0;
            t = arg1.t ?? Date.now();
        } else {
            // Old style
            dir = arg1;
            socketId = arg2 || socket.id;
        }

        // Only allow the arrows (basic sanity + avoids junk keys)
        if (
            dir !== "ArrowUp" &&
            dir !== "ArrowDown" &&
            dir !== "ArrowLeft" &&
            dir !== "ArrowRight"
        ) {
            return;
        }

        // Optional: if you want to enforce that a player can only send moves for themselves:
        // const p = players.get(playerId);
        // if (!p || p.socketId !== socket.id) return;

        io.emit("KeyPressed", {
            socketId,
            dir,
            seq,
            t,
            playerId: players.get(playerId)?.playerId, // keep this if your client uses it
        });
    });

    // --- Player state snapshots ---
    // Expect an object payload (tileX/tileY + optional x/y, etc). Broadcast as-is.
    socket.on("PlayerState", (payload) => {
        if (!payload || typeof payload !== "object") return;

        // If client doesn’t include socketId, inject it
        const msg = {
            ...payload,
            socketId: payload.socketId || socket.id,
        };

        io.emit("PlayerState", msg);
    });

    socket.on("disconnect", () => {
        const p = players.get(playerId);
        if (!p) return;

        // Don’t delete immediately; refreshes cause disconnect.
        p.lastSeen = Date.now();

        // (Optional) purge after a grace period:
        // setTimeout(() => {
        //   const cur = players.get(playerId);
        //   if (!cur) return;
        //   if (Date.now() - cur.lastSeen > 10_000) {
        //     players.delete(playerId);
        //     emitLobbyState();
        //   }
        // }, 10_000);
    });
});

// ----- Serve React build (single-app deployment) -----
// Assumes repo layout:
// /client (React app) -> client/build after build
// /server (this file)
const clientBuildPath = path.join(__dirname, "..", "client", "dist");
app.use(express.static(clientBuildPath));

// SPA fallback (don’t swallow API routes)
app.get("*", (req, res) => {
    if (req.path.startsWith("/api/")) {
        res.status(404).json({ error: "Not found" });
        return;
    }
    res.sendFile(path.join(clientBuildPath, "index.html"));
});

server.listen(PORT, () => {
    console.log(`🟢 Web+Socket server running on port ${PORT}`);
});
