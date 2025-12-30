import Phaser from 'phaser';
import MainScene from './scenes/MainScene';

export class Game {
    constructor() {
        const config = {
            type: Phaser.AUTO,
            parent: 'game',
            // width: 800,
            // height: 496,
            backgroundColor: '#000000',
            pixelArt: true,

            scale: {
                mode: Phaser.Scale.NONE,
                autoCenter: Phaser.Scale.CENTER_BOTH
            },

            physics: {
                default: 'arcade',
                arcade: { debug: false }
            },

            scene: [MainScene]
        };


        new Phaser.Game(config);
    }
}
