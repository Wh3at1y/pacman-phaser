import React, {useEffect, useState} from 'react';
import './lobby.css'
import RunGame from "./RunGame.jsx";

import socket from "./socket";
import Chat from "./components/Chat.js";



export default function Lobby() {
    const [isConnecting, setIsConnecting] = useState(true)
    const [players, setPlayers] = useState([])
    const [startGame, setStartGame] = useState(false)
    const [previousGame, setPreviousGame] = useState(null)


    useEffect(() => {
        const onConnect = () => {
            setIsConnecting(false);
        };

        const onJoined = (playersMap) => {
            setPlayers(Object.values(playersMap));
        };

        const startGame = () => {
            setStartGame(true)
        }

        socket.on("connect", onConnect);
        socket.on("joined", onJoined);
        socket.on("startGame", startGame);
        socket.on("kicked", (playerId) => alert("kicked"))

        return () => {
            socket.off("connect", onConnect);
            socket.off("joined", onJoined);
            socket.disconnect();
        };
    }, []);

    const onReady = () => {
        socket.emit("player_ready");
    };

    const handleStart = () => {
        socket.emit("hostStart");
    }

    const kickPlayer = (playerId) => {
        socket.emit("KickPlayer", playerId)
    }

    const currentPlayer = players.find(player => player.socketId === socket.id) || null
    const allPlayersReady = players.every(player => player.ready)


    return startGame ? <RunGame players={players} currentPlayer={currentPlayer} backToLobby={(prevGameStats) => {
        setStartGame(false)
        setPreviousGame(prevGameStats)
    }} /> : <div>
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
                                <span className="playerName">{player.name} {currentPlayer.playerId === player.playerId && "(Me)"} {player.lobbyLeader && " - Host"}</span>
                            </div>
                            <div className="playerRow__right">
                                {player.ready ? <span className="playerTag playerTag--ready">Ready</span> :  <span className="playerTag playerTag--notReady">Not Ready</span>}
                            </div>
                            <div style={{cursor:'pointer'}} onClick={() => kickPlayer(player.playerId)}>{player.lobbyLeader && "X"}</div>
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
                        <button className="btn btn--ghost" type="button" onClick={handleStart} disabled={!currentPlayer.lobbyLeader || !allPlayersReady}>Start Game</button>

                        <div className="hint">
                            <p className="hint__title">Tip</p>
                            <p className="hint__text">You don't need bubble wrap to know when it's chowder time.</p>
                        </div>
                        <Chat players={players || []} />
                    </div>

                    {previousGame && <div className="hint">
                        <p className="hint__title">Previous Game Stats</p>
                        <p className="hint__text">Total Rounds: {previousGame.round}</p>
                        {Object.entries(previousGame.playerScores).map(([playerId, score]) => <p key={playerId} className="hint__text">{players.find(p => p.playerId === playerId).name}: {score}</p>)}
                    </div>}
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