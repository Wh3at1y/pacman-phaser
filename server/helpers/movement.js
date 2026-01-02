// src/helpers/movement.js (DROP-IN REPLACEMENT)
// Stores latest PlayerState on server so ghosts can chase authoritatively.

export default function initializeMovement(socket, io, playerId, players, currentGame) {
    if (!currentGame.playerStates) currentGame.playerStates = new Map();

    // --- Multiplayer Character State ---
    socket.on("PlayerState", (payload) => {
        if (!payload || typeof payload !== "object") return;

        const pid = players.get(playerId)?.playerId;
        if (!pid) return;

        // Store the authoritative-ish last state we received for this player.
        // (If you later move Pac-Man movement fully server-side, this becomes server truth.)
        currentGame.playerStates.set(pid, {
            playerId: pid,
            socketId: payload.socketId || socket.id,
            x: payload.x,
            y: payload.y,
            tileX: payload.tileX,
            tileY: payload.tileY,
            dir: payload.dir,
            nextDir: payload.nextDir,
            seq: payload.seq ?? 0,
            t: Date.now(),
        });

        io.emit("PlayerState", {
            ...payload,
            socketId: payload.socketId || socket.id,
            playerId: pid,
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
