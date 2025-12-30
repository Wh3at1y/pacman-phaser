import { useEffect, useRef, useState } from "react";
import Phaser from "phaser";
import MainScene from "./game/scenes/MainScene";

export default function PacmanGame({players, currentPlayer}) {
    const containerRef = useRef(null);
    const gameRef = useRef(null);

    const [hud, setHud] = useState({
        score: 0,
        dotsCollected: 0,
        dotsRemaining: 0,
        round: 1,
    });

    useEffect(() => {
        if (!containerRef.current) return;
        if (gameRef.current) return;

        // Callback Phaser can call whenever HUD changes
        const onHudUpdate = (partial) => {
            setHud((prev) => ({ ...prev, ...partial }));
        };

        const config = {
            type: Phaser.AUTO,
            parent: containerRef.current,
            width: 28 * 24,  // adjust
            height: 31 * 24, // adjust
            backgroundColor: "#000",
            physics: { default: "arcade", arcade: { debug: false } },

            // ✅ Pass the callback into the scene instance
            scene: [new MainScene(onHudUpdate, players, currentPlayer)],
        };

        gameRef.current = new Phaser.Game(config);

        return () => {
            gameRef.current?.destroy(true);
            gameRef.current = null;
        };
    }, []);

    return (
        <div style={{ display: "flex", flexDirection: 'column',justifyContent: "center", alignItems:'center', width: '100vw', height: '100vh'}}>
            {/* Phaser canvas */}
            <div ref={containerRef}>
                <div style={{ color: "white", minWidth: 180, display: "flex", justifyContent: "space-between", marginBottom: 20 , fontSize: '2rem'}}>
                    <h1>Round: {hud.round}</h1>
                    <h1 style={{display:'flex', textAlign: 'right'}}>Score: <span style={{width: 140}}>{hud.score}</span></h1>
                </div>
            </div>

        </div>
    );
}
