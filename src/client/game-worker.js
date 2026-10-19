// @ts-check
/**
 * Single-player simulation worker: owns the match state, ticks it and sends
 * snapshots to the renderer. Keeps the main thread free for rendering.
 */

import { generateMap } from '../shared/mapgen.js';
import { createMatch, snapshot } from '../shared/match.js';
import { step } from '../shared/sim.js';

/** @type {any} */
let state = null;
/** @type {any} */
let balance = null;
/** @type {ReturnType<typeof setInterval> | null} */
let timer = null;
/** @type {any[]} */
let queued = [];
let speed = 1;

function stopTimer() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

function startTimer() {
  stopTimer();
  if (!balance || !state || state.phase !== 'playing') return;
  timer = setInterval(tick, Math.max(16, balance.tickMs / speed));
}

function tick() {
  if (!state || !balance || state.phase !== 'playing') {
    stopTimer();
    return;
  }
  const commands = queued;
  queued = [];
  step(state, balance, commands);
  self.postMessage({ type: 'snapshot', snapshot: snapshot(state) });
  if (state.phase !== 'playing') stopTimer();
}

self.onmessage = (event) => {
  const message = event.data;

  if (message.type === 'init') {
    balance = message.balance;
    speed = 1;
    const seed = message.config.seed;
    const cityCount = message.config.cityCount;
    const map = generateMap({ seed, cityCount });
    state = createMatch(map, balance, {
      seed,
      playerName: '指挥官',
      aiCount: message.config.aiCount,
      matchSeconds: message.config.matchSeconds,
      aiProfile: message.config.aiProfile,
      mode: message.config.mode,
    });
    self.postMessage({ type: 'init', map, snapshot: snapshot(state) });
    startTimer();
    return;
  }

  if (message.type === 'command') {
    if (state && state.phase === 'playing') queued.push(message.command);
    return;
  }

  if (message.type === 'pause') {
    stopTimer();
    return;
  }

  if (message.type === 'resume') {
    if (state && state.phase === 'playing') startTimer();
    return;
  }

  if (message.type === 'speed') {
    speed = message.speed === 2 ? 2 : 1;
    if (timer !== null) startTimer();
  }
};
