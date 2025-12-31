import {useEffect, useRef, useState} from "react";
import Phaser from "phaser";
import MainScene from "./game/scenes/MainScene";

const colors = ['yellow', "purple", "white", "green"];

export default function PacmanGame({players, currentPlayer, backToLobby}) {
    const containerRef = useRef(null);
    const gameRef = useRef(null);

    const playerInitScores = {}
    players.forEach(p => playerInitScores[p.playerId] = 0)

    const playerInitLives = {}
    players.forEach(p => playerInitLives[p.playerId] = 3)

    const [hud, setHud] = useState({
        playerScores: playerInitScores,
        lives: playerInitLives,
        dotsCollected: 0,
        dotsRemaining: 0,
        round: 1,
    });

    useEffect(() => {
        if (!containerRef.current) return;
        if (gameRef.current) return;

        // Callback Phaser can call whenever HUD changes
        const onHudUpdate = (partial) => {
            setHud((prev) => ({...prev, ...partial}));
        };

        const config = {
            type: Phaser.AUTO,
            parent: containerRef.current,
            width: 28 * 24,  // adjust
            height: 31 * 24, // adjust
            backgroundColor: "#000",
            physics: {default: "arcade", arcade: {debug: false}},

            // ✅ Pass the callback into the scene instance
            scene: [new MainScene(onHudUpdate, players, currentPlayer)],
        };

        gameRef.current = new Phaser.Game(config);

        return () => {
            gameRef.current?.destroy(true);
            gameRef.current = null;
        };
    }, []);

    useEffect(() => {
        if (hud.backToLobby) backToLobby(hud)
    }, [hud])

    return (
        <div style={{display: "flex", justifyContent: "center", alignItems: 'center', width: '100vw', height: '100vh'}}>
            {/* Phaser canvas */}
            <div ref={containerRef} style={{display: "flex"}}>

            </div>
            <div style={{color: "white", display: "flex", flexDirection: 'column', width: 250, marginLeft: 20}}>
                <h1 style={{marginBottom: 10}}>Round: {hud.round}</h1>
                <div>
                    {Object.entries(hud.playerScores).map(([playerId, score],i) => <div key={playerId} style={{marginBottom: 20}}>
                        <h1 style={{fontSize: '1.1rem', color: colors[i]}}>{players.find(p => p.playerId === playerId).name}</h1>
                        <h1>Points: {score}</h1><h1>Lives: {hud.lives[playerId]}</h1>
                    </div>)}
                </div>
            </div>

        </div>
    );
}
