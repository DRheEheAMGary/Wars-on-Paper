/**
 * Production-style game server: static files + (from M4) WebSocket rooms.
 * No dev-only live-reload injection.
 *
 * Run with: npm run server
 */

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT } from '../shared/constants.js';
import { serveStatic } from './static-server.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = Number(process.env.PORT ?? DEFAULT_PORT);
const HOST = process.env.HOST ?? '127.0.0.1';

const server = createServer((req, res) => {
  void serveStatic(ROOT, req, res);
});

// TODO(M4): attach the WebSocket server here for multiplayer rooms.

server.on('error', (error) => {
  if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try: PORT=8788 npm run server`);
    process.exitCode = 1;
    return;
  }
  throw error;
});

server.listen(PORT, HOST, () => {
  console.log(`Wars on Paper server: http://localhost:${PORT}`);
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
