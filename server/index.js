import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from 'cors'
import { initSocketServer } from "./socket.js";

const PORT = process.env.PORT || 5177;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const app = express();
app.use(express.json());
app.use(cors({origin: ['*']}))

const clientBuildPath = path.join(__dirname, "..", "client", "dist");
app.use(express.static(clientBuildPath));

app.get(/^\/(?!api\/).*/, (req, res) => {
    res.sendFile(path.join(clientBuildPath, "index.html"));
});


const server = http.createServer(app);
initSocketServer(server);

server.listen(PORT, () => {
    console.log(`🟢 Web+Socket server running on port ${PORT}`);
});
