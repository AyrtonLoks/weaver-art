/**
 * Player view: step-by-step physical weaving assistant with TTS voice, CW/CCW direction,
 * synthetic Web Audio chimes, high-contrast canvas, and dual-compatible WA1 progress tokens.
 */

export * from './player-view.js';
export * from './player-canvas.js';
export * from './player-audio.js';
export * from './player-codec.js';
export * from './player-storage.js';
export * from './qr-code.js';

// Backward-compatible aliases for legacy imports
export { PlayerView as KnitPlayer } from './player-view.js';
export type { PlayerViewElements as PlayerElements } from './player-view.js';
