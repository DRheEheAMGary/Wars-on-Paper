// @ts-check
/**
 * Structural constants shared by the client, the server and the simulation.
 * Balance values (costs, rates, cooldowns) live in `data/balance.json` instead.
 */

export const APP_NAME = 'Wars on Paper';

/** Simulation tick length in milliseconds. */
export const TICK_MS = 100;

/** Simulation ticks per second. */
export const TICK_RATE = 1000 / TICK_MS;

/**
 * Client/server message protocol version.
 * Bumped only on incompatible protocol changes; first networked version is 1 (M4).
 * @see docs/VERSIONING.md
 */
export const PROTOCOL_VERSION = 1;

/**
 * MatchState / snapshot structure version.
 * Bumped on incompatible state changes.
 * @see docs/VERSIONING.md
 */
export const STATE_VERSION = 1;

/** Default match duration in seconds (12 minutes). */
export const DEFAULT_MATCH_SECONDS = 720;

/** Default local development port. 8080 is often taken by other tools. */
export const DEFAULT_PORT = 8787;
