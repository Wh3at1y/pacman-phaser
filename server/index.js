import { Server } from "socket.io"

const PORT = 3001

const playerNames = ["ButterBall", "Chowder", "BubbleWrap", "OrbitGum"]

const io = new Server(PORT, {
    cors: {
        origin: "*"
    }
})

console.log(`🟢 Socket server running on port ${PORT}`)

// --- Game State ---
const players = new Map(); // playerId -> { playerId, name, ready, socketId, lastSeen }

io.on("connection", (socket) => {
    const playerId = socket.handshake.auth?.playerId;

    if (!playerId) {
        socket.disconnect(true);
        return;
    }
    const existingPlayers = Object.values(players).map(player => player.name)
    const filteredNames = playerNames.filter(name => !existingPlayers.includes(name))

    // Re-associate or create
    const existing = players.get(playerId);
    if (existing) {
        existing.socketId = socket.id;
        existing.lastSeen = Date.now();
    } else {
        players.set(playerId, {
            playerId,
            name: filteredNames[Math.floor(Math.random() * filteredNames.length)],
            ready: false,
            socketId: socket.id,
            lastSeen: Date.now(),
        });
    }

    // Send lobby state
    io.emit("joined", Object.fromEntries(players.entries()));

    socket.on("player_ready", () => {
        const p = players.get(playerId);
        if (!p) return;
        p.ready = !p.ready;
        io.emit("joined", Object.fromEntries(players.entries()));
    });

    socket.on("KeyPressed", (event, socketId) => {
        if (event === "ArrowUp" || event === "ArrowDown" || event === "ArrowLeft" || event === "ArrowRight") {
            console.log('HIT SOCKET MOVEMENT!!!', event);
            console.log('SocketId', socketId)
            io.emit('KeyPressed', event, socketId, players.get(playerId)?.playerId)
        }
    });

    socket.on("start_game", () => {
        io.emit("start_game_all")
    })

    socket.on("PlayerState", (payload) => {
        io.emit("PlayerState", payload);
    })

    socket.on("disconnect", () => {
        const p = players.get(playerId);
        if (!p) return;

        // Optional: don't delete instantly (refresh causes disconnect)
        p.lastSeen = Date.now();

        // You can keep them for a grace period:
        // setTimeout(() => { if stale -> delete }, 10_000)
    });
});


