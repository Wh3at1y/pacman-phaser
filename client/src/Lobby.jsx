import React, {useEffect, useState} from 'react';
import './lobby.css'
import RunGame from "./RunGame.jsx";

import socket from "./socket";
import Chat from "./components/Chat.js";



export default function Lobby() {
    const [isConnecting, setIsConnecting] = useState(true)
    const [players, setPlayers] = useState([])
    const [startGame, setStartGame] = useState(false)


    useEffect(() => {
        const onConnect = () => {
            console.log("Connected", socket.id);
            setIsConnecting(false);
        };

        const onJoined = (playersMap) => {
            console.log("PLAYERS", Object.values(playersMap));
            setPlayers(Object.values(playersMap));
        };

        const startGame = () => {
            setStartGame(true)
        }

        socket.on("connect", onConnect);
        socket.on("joined", onJoined);
        socket.on("start_game_all", startGame);

        return () => {
            socket.off("connect", onConnect);
            socket.off("joined", onJoined);
            // Optional: keep connection alive across route changes.
            // If you DO want to disconnect when Lobby unmounts:
            // socket.disconnect();
        };
    }, []);

    const onReady = () => {
        socket.emit("player_ready");
    };

    const handleStart = () => {
        socket.emit("start_game");
    }

    const currentPlayer = players.find(player => player.socketId === socket.id) || null

    return startGame ? <RunGame players={players} currentPlayer={currentPlayer} /> : <div>
        {isConnecting || !currentPlayer ? <h1>Connecting to Server...</h1> : <div className="lobby">
            <header className="lobby__header">
                <div>
                    <h1 className="lobby__title">Game Lobby</h1>
                    <p className="lobby__subtitle">Waiting for players to ready up…</p>
                </div>

                <div className="lobby__meta">
                    <div className="lobby__code">
                        <span className="lobby__codeLabel">Welcome,</span>
                        <span className="lobby__codeValue">{currentPlayer.name}</span>
                    </div>
                </div>
            </header>

            <main className="lobby__content">
                <section className="panel">
                    <div className="panel__header">
                        <h2 className="panel__title">Players</h2>
                        <span className="panel__pill">{players.filter(p => p.ready).length} / {players.length}</span>
                    </div>

                    <ul className="playerList">
                        {players.map(player => (<li className="playerRow" key={player.id}>
                            <div className="playerRow__left">
                                {player.ready ? <span className="statusDot statusDot--ready" aria-label="Ready"></span> : <span className="statusDot statusDot--notReady" aria-label="Not ready"></span>}
                                <span className="playerName">{player.name} {socket.id === player.id && "(Me)"}</span>
                            </div>
                            <div className="playerRow__right">
                                {player.ready ? <span className="playerTag playerTag--ready">Ready</span> :  <span className="playerTag playerTag--notReady">Not Ready</span>}
                            </div>
                        </li>))}
                    </ul>
                </section>

                <aside className="panel panel--side">
                    <div className="panel__header">
                        <h2 className="panel__title">Actions</h2>
                    </div>

                    <div className="actions">
                        {currentPlayer.ready ?
                            <button className="btn btn--primary" type="button" onClick={onReady}>Un-Ready</button> :
                            <button className="btn btn--primary" type="button" onClick={onReady}>Ready Up</button>}
                        <button className="btn btn--ghost" type="button">PAC-MEN</button>
                        <button className="btn btn--ghost" type="button" onClick={handleStart}>Start Game</button>

                        <div className="hint">
                            <p className="hint__title">Tip</p>
                            <p className="hint__text">You don't need bubble wrap to know when it's chowder time.</p>
                        </div>
                        <Chat players={players || []} />
                    </div>
                </aside>
            </main>

            <footer className="lobby__footer">
                <span className="smallText">Ping: 42ms</span>
                <span className="smallText">Region: US-West</span>
            </footer>
        </div>
        }
    </div>;
}