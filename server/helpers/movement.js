export default function initializeMovement(socket, io, playerId, players) {
    // --- Multiplayer Character State ---
    socket.on("PlayerState", (payload) => {
        if (!payload || typeof payload !== "object") return;

        io.emit("PlayerState", {
            ...payload,
            socketId: payload.socketId || socket.id,
        });
    });

    // --- Multiplayer movement input ---
    socket.on("KeyPressed", (arg1, arg2) => {
        let socketId;
        let dir;
        let seq = 0;
        let t = Date.now();

        if (typeof arg1 === "object" && arg1 !== null) {
            socketId = arg1.socketId || socket.id;
            dir = arg1.dir;
            seq = arg1.seq ?? 0;
            t = arg1.t ?? Date.now();
        } else {
            dir = arg1;
            socketId = arg2 || socket.id;
        }

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
            playerId: players.get(playerId)?.playerId,
        });
    });
}