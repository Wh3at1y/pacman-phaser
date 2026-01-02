// server/helpers/movement.js
// Keeps multiplayer player movement consistent by relaying input + state.
// Player movement is still simulated client-side (prediction) for 60fps;
// the server stores the latest state and rebroadcasts it for everyone else.

export default function initializeMovement(socket, io, authedPlayerId, players, playerState) {
    // playerState: Map<playerId, latestState>
    const stateMap = playerState ?? new Map();

    // Client sends periodic authoritative state snapshots (50-100ms).
    socket.on("PlayerState", (payload) => {
        if (!payload || typeof payload !== "object") return;

        const playerId = String(payload.playerId || authedPlayerId || "");
        if (!playerId) return;

        // Don't let a client spoof another player
        if (authedPlayerId && playerId !== String(authedPlayerId)) return;

        const seq = Number.isFinite(payload.seq) ? payload.seq : 0;

        const prev = stateMap.get(playerId);
        const prevSeq = prev?.seq ?? -1;
        if (seq <= prevSeq) return;

        const pkt = {
            playerId,
            socketId: socket.id,
            x: payload.x,
            y: payload.y,
            tileX: payload.tileX,
            tileY: payload.tileY,
            dir: payload.dir,
            nextDir: payload.nextDir,
            seq,
            t: Date.now(),
        };

        stateMap.set(playerId, pkt);

        // Broadcast to others (sender already has it locally)
        socket.broadcast.emit("PlayerState", pkt);
    });

    // Optional: relay input events too (useful for debugging/animation sync)
    socket.on("KeyPressed", (payload) => {
        if (!payload || typeof payload !== "object") return;

        const playerId = String(payload.playerId || authedPlayerId || "");
        if (!playerId) return;
        if (authedPlayerId && playerId !== String(authedPlayerId)) return;

        const dir = payload.dir;
        if (
            dir !== "ArrowUp" &&
            dir !== "ArrowDown" &&
            dir !== "ArrowLeft" &&
            dir !== "ArrowRight"
        ) {
            return;
        }

        io.emit("KeyPressed", {
            playerId,
            socketId: socket.id,
            dir,
            seq: Number.isFinite(payload.seq) ? payload.seq : 0,
            t: Date.now(),
        });
    });
}
