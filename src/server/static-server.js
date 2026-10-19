/**
 * Minimal, dependency-free static file server.
 * Shared by the development server and the production game server.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

/** @type {Record<string, string>} */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const DEFAULT_CACHE = 'public, max-age=300';
const HTML_CACHE = 'no-cache';

/**
 * Resolve a request URL to an absolute path inside `root`.
 * Returns `null` for invalid URLs and for any path that escapes `root`.
 *
 * @param {string} root Absolute root directory.
 * @param {string} requestUrl Raw request URL (may contain query/hash).
 * @returns {string | null}
 */
export function resolveSafePath(root, requestUrl) {
  const pathname = (requestUrl.split('?')[0] ?? '/').split('#')[0];
  /** @type {string} */
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const relative = decoded === '/' ? '/index.html' : decoded;
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, '.' + relative);
  if (absolute !== absoluteRoot && !absolute.startsWith(absoluteRoot + sep)) {
    return null;
  }
  return absolute;
}

/**
 * Send a plain-text response.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} text
 * @param {boolean} [headOnly]
 */
export function sendText(res, status, text, headOnly = false) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.byteLength,
    'Cache-Control': 'no-store',
  });
  res.end(headOnly ? undefined : body);
}

/**
 * Serve a file from `root`.
 *
 * @param {string} root Absolute root directory.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ dev?: boolean }} [options]
 */
export async function serveStatic(root, req, res, options = {}) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method not allowed');
    return;
  }

  const filePath = resolveSafePath(root, req.url ?? '/');
  if (!filePath) {
    sendText(res, 400, 'Bad request');
    return;
  }

  /** @type {import('node:fs').Stats} */
  let info;
  try {
    info = await stat(filePath);
  } catch {
    sendText(res, 404, 'Not found');
    return;
  }

  if (!info.isFile()) {
    sendText(res, 404, 'Not found');
    return;
  }

  const extension = extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[extension] ?? 'application/octet-stream';
  const cacheControl = options.dev
    ? 'no-store'
    : extension === '.html'
      ? HTML_CACHE
      : DEFAULT_CACHE;

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': info.size,
    'Cache-Control': cacheControl,
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = createReadStream(filePath);
  stream.on('error', () => {
    // The client is gone or the file disappeared; closing the socket is enough.
    res.destroy();
  });
  stream.pipe(res);
}
