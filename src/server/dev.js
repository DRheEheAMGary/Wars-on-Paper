/**
 * Zero-dependency development server:
 *   - serves the repository as static files
 *   - injects a tiny live-reload client into HTML responses
 *   - watches the workspace and pushes reload events over SSE
 *
 * Run with: npm run dev
 */

import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT } from '../shared/constants.js';
import { resolveSafePath, sendText, serveStatic } from './static-server.js';
import { MultiplayerServer } from './multiplayer.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = Number(process.env.PORT ?? DEFAULT_PORT);
const HOST = process.env.HOST ?? '127.0.0.1';
const SSE_PATH = '/__dev/sse';

const DEV_CLIENT = [
  '<script>',
  '  (() => {',
  "    const source = new EventSource('/__dev/sse');",
  "    source.onmessage = (event) => {",
  "      if (event.data === 'reload') window.location.reload();",
  '    };',
  '  })();',
  '</script>',
].join('\n');

/** @type {Set<import('node:http').ServerResponse>} */
const sseClients = new Set();

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
function handleSse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 1000\n\n');
  sseClients.add(res);
  req.on('close', () => {
    sseClients.delete(res);
  });
}

function broadcastReload() {
  for (const client of sseClients) {
    client.write('data: reload\n\n');
  }
}

const multiplayer = new MultiplayerServer({
  log: (message) => console.log(`  ${message}`),
});

const server = createServer(async (req, res) => {
  const pathname = (req.url ?? '/').split('?')[0];

  if (pathname === SSE_PATH) {
    handleSse(req, res);
    return;
  }

  const filePath = resolveSafePath(ROOT, req.url ?? '/');
  const isHtml = filePath?.toLowerCase().endsWith('.html');

  if (!isHtml) {
    await serveStatic(ROOT, req, res, { dev: true });
    return;
  }

  try {
    let html = await readFile(filePath, 'utf8');
    if (!html.includes(SSE_PATH)) {
      const withClient = html.replace(/<\/body>/i, `${DEV_CLIENT}\n</body>`);
      html = withClient === html ? `${html}\n${DEV_CLIENT}\n` : withClient;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : html);
  } catch {
    sendText(res, 404, 'Not found', req.method === 'HEAD');
  }
});

let reloadTimer = /** @type {NodeJS.Timeout | null} */ (null);

/** @param {string} filename */
function shouldIgnore(filename) {
  return (
    filename.includes('.git/') ||
    filename.startsWith('.git') ||
    filename.includes('node_modules/') ||
    filename.startsWith('node_modules') ||
    filename.endsWith('.log') ||
    filename.endsWith('.DS_Store')
  );
}

try {
  watch(ROOT, { recursive: true }, (_event, rawFilename) => {
    const filename = String(rawFilename ?? '');
    if (!filename || shouldIgnore(filename)) return;
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      broadcastReload();
    }, 120);
  });
} catch (error) {
  console.warn('Live reload watcher unavailable:', error);
}

server.on('error', (error) => {
  if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try: PORT=8788 npm run dev`);
    process.exitCode = 1;
    return;
  }
  throw error;
});

multiplayer.attach(server);

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Wars on Paper — dev server');
  console.log(`  local:  http://localhost:${PORT}`);
  console.log(`  multiplayer: ws://localhost:${PORT}/ws`);
  console.log('  live reload: on (save a file to refresh the browser)');
  console.log('');
});

process.on('SIGINT', () => {
  multiplayer.close();
  server.close(() => process.exit(0));
});
