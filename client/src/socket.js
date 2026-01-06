import {io} from "socket.io-client";

const getOrCreatePlayerId = () => {
    const key = "lobby_player_id";
    let id = localStorage.getItem(key);
    if (!id) {
        // Works in modern browsers. If you need older support, use uuid lib.
        // id = crypto.randomUUID();
        id = Date.now()
        localStorage.setItem(key, id);
    }
    return id;
};

const initializeSocket = () => {
    if (!window.socket) {
        const playerId = getOrCreatePlayerId();

        const isDev =
            window.location.hostname === "localhost" ||
            window.location.hostname === "127.0.0.1";

        const socketUrl = isDev
            ? "http://localhost:5177"   // 👈 your local socket server
            : window.location.origin;   // 👈 prod (same origin)

        window.socket = io(socketUrl, {
            transports: ["websocket"],
            auth: { playerId },
            reconnection: true,
        });
    }

    return window.socket;
};


export default initializeSocket();