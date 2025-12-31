// server/index.js (ESM)
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import http from "http";
import { Server } from "socket.io";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Render provides PORT. Default locally if needed.
const PORT = process.env.PORT || 5177;

// If you split frontend/backend later, set CLIENT_ORIGIN to your frontend URL.
// If serving React from this same server, you can keep origin:true.
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || true;

// ----- Lobby/game state -----
const playerNames = ["ButterBall", "Chowder", "BubbleWrap", "OrbitGum"];

// playerId -> { playerId, name, ready, socketId, lastSeen }
const players = new Map();

// ---- Ghost authority (one client simulates ghosts; everyone else renders snapshots)
let ghostHostPlayerId = null;

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

function isOnlineSocketId(socketId) {
    return !!socketId && io.sockets.sockets.has(socketId);
}

function pickFirstOnlinePlayerId() {
    for (const [pid, p] of players.entries()) {
        if (isOnlineSocketId(p.socketId)) return pid;
    }
    return null;
}

function getGhostHostSocketId() {
    const host = ghostHostPlayerId ? players.get(ghostHostPlayerId) : null;
    if (!host) return null;
    if (!isOnlineSocketId(host.socketId)) return null;
    return host.socketId;
}

function broadcastGhostHost() {
    io.emit("ghost_host", {
        playerId: ghostHostPlayerId,
        socketId: getGhostHostSocketId(),
    });
}

function ensureGhostHost() {
    // If current host is offline/missing, pick a new one
    if (getGhostHostSocketId()) return;
    ghostHostPlayerId = pickFirstOnlinePlayerId();
    broadcastGhostHost();
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

    // If we don't have a ghost host yet, pick one (first online connection wins)
    ensureGhostHost();

    // Let any client ask who the current ghost host is (so scenes don’t miss the broadcast).
    socket.on("ghost_host:request", () => {
        ensureGhostHost();
        socket.emit("ghost_host", {
            playerId: ghostHostPlayerId,
            socketId: getGhostHostSocketId(),
        });
    });

    // If the host reconnected (same playerId, new socket.id), tell everyone.
    if (playerId === ghostHostPlayerId) broadcastGhostHost();

    // Toggle ready
    socket.on("player_ready", () => {
        const p = players.get(playerId);
        if (!p) return;
        p.ready = !p.ready;
        emitLobbyState();
    });

    // Start game (keep your existing event names)
    socket.on("start_game", () => {
        // Whoever starts the game becomes the ghost host.
        ghostHostPlayerId = playerId;
        broadcastGhostHost();

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

    // --- Ghost state snapshots (ONLY accepted from the current ghost host) ---
    socket.on("GhostState", (payload) => {
        const hostSocketId = getGhostHostSocketId();
        if (!hostSocketId) return;
        if (socket.id !== hostSocketId) return;

        if (!payload || typeof payload !== "object") return;
        io.emit("GhostState", payload);
    });

    // --- Power-dot events (used to sync frightened mode across clients) ---
    socket.on("PowerDotEaten", (payload) => {
        // Broadcast to everyone, including host, so ghosts go frightened in sync.
        io.emit("PowerDotEaten", {
            ...(payload && typeof payload === "object" ? payload : {}),
            socketId: socket.id,
            playerId,
            t: Date.now(),
        });
    });

    // (Optional hook) If you later want to sync round resets, you can broadcast it.
    socket.on("RoundReset", (payload) => {
        io.emit("RoundReset", {
            ...(payload && typeof payload === "object" ? payload : {}),
            socketId: socket.id,
            playerId,
            t: Date.now(),
        });
    });

    socket.on("chat:message", message => {
        const chatMessage = {
            senderId: socket.id,
            text: message,
            timestamp: Date.now()
        }

        // Send to everyone (including sender)
        io.emit("chat:message", chatMessage)
    })



    socket.on("disconnect", () => {
        const p = players.get(playerId);
        if (!p) return;

        // Don’t delete immediately; refreshes cause disconnect.
        p.lastSeen = Date.now();

        // when a user disconnects or refreshes set ready to false
        p.ready = false;

        // If the ghost host dropped, pick a new online host right away.
        if (playerId === ghostHostPlayerId) {
            ensureGhostHost();
        }

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
// /client (React app) -> client/dist after build
// /server (this file)
const clientBuildPath = path.join(__dirname, "..", "client", "dist");
app.use(express.static(clientBuildPath));

// SPA fallback (don’t swallow API routes)
app.get(/^\/(?!api\/).*/, (req, res) => {
    res.sendFile(path.join(clientBuildPath, "index.html"));
});

server.listen(PORT, () => {
    console.log(`🟢 Web+Socket server running on port ${PORT}`);
});
