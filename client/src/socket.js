import {io} from "socket.io-client";

const getOrCreatePlayerId = () => {
    const key = "lobby_player_id";
    let id = localStorage.getItem(key);
    if (!id) {
        // Works in modern browsers. If you need older support, use uuid lib.
        id = crypto.randomUUID();
        localStorage.setItem(key, id);
    }
    return id;
};


const initializeSocket = () => {
    if (!window.socket) {
        const playerId = getOrCreatePlayerId();

        window.socket = io({
            transports: ["websocket"],          // optional but helps with ngrok weirdness
            auth: { playerId },                 // send stable identity
            reconnection: true,
        });
    }
    return window.socket;
};

export default initializeSocket();