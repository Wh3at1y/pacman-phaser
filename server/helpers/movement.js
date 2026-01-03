export default function initializeMovement(socket, io, playerId, players) {
    // --- Multiplayer Character State ---
    socket.on("PlayerState", (payload) => {
        if (!payload || typeof payload !== "object") return;

        // ✅ Store authoritative-ish player state on server for ghost chase:
        // Accept either tileX/tileY or x/y; accept direction in several shapes.
        const p = players.get(playerId);
        if (p) {
            if (Number.isFinite(payload.tileX)) p.tileX = payload.tileX;
            if (Number.isFinite(payload.tileY)) p.tileY = payload.tileY;

            if (Number.isFinite(payload.x)) p.x = payload.x;
            if (Number.isFinite(payload.y)) p.y = payload.y;

            // direction can be "ArrowUp" etc or {x,y}
            if (payload.dir != null) p.dir = payload.dir;
            else if (payload.direction != null) p.dir = payload.direction;
            else if (payload.currentDir != null) p.dir = payload.currentDir;

            p.lastSeen = Date.now();
        }

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

        if (dir !== "ArrowUp" && dir !== "ArrowDown" && dir !== "ArrowLeft" && dir !== "ArrowRight") {
            return;
        }

        // ✅ Store latest requested direction so “Pinky 4 tiles ahead” works even if you only send key events
        const p = players.get(playerId);
        if (p) {
            p.dir = dir;
            p.lastSeen = Date.now();
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
