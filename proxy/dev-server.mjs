#!/usr/bin/env node
/**
 * Local dev server: static files + same-origin CORS proxy at /proxy
 *
 *   node proxy/dev-server.mjs
 *   open http://127.0.0.1:8788
 *
 * Prefer this over `npx serve` — Nagwa API calls use /proxy automatically
 * when direct browser fetch is blocked.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.MMT_DEV_PORT || 8788);
const HOST = process.env.MMT_DEV_HOST || '127.0.0.1';

const ALLOWED_HOSTS = new Set(
  (process.env.ALLOWED_HOSTS || 'admin.classes.nagwa.com,qms-api.nagwa.com,12digit.nagwa.com')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean),
);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-KEY, Authorization, Accept',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleProxy(req, res, incoming) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const targetRaw = incoming.searchParams.get('url');
  if (!targetRaw) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Missing url query parameter');
    return;
  }

  let targetUrl;
  try {
    targetUrl = new URL(targetRaw);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid url');
    return;
  }

  const host = targetUrl.hostname;
  const hostAllowed = ALLOWED_HOSTS.has(host)
    || host.endsWith('.amazonaws.com')
    || host.endsWith('.cloudfront.net');
  if (!hostAllowed) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end(`Host not allowed: ${host}`);
    return;
  }

  const forwardHeaders = {};
  for (const key of ['content-type', 'x-api-key', 'authorization', 'accept', 'user-agent']) {
    const val = req.headers[key];
    if (val) forwardHeaders[key] = val;
  }

  try {
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
    const upstream = await fetch(targetUrl.toString(), {
      method: req.method,
      headers: forwardHeaders,
      body,
    });

    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
      ...CORS,
    });
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`Proxy error: ${e.message}`);
  }
}

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(ROOT, normalized);
  if (!full.startsWith(ROOT)) return null;
  return full;
}

function serveStatic(req, res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const incoming = new URL(req.url || '/', `http://${HOST}:${PORT}`);

  if (incoming.pathname === '/proxy') {
    await handleProxy(req, res, incoming);
    return;
  }

  let filePath = safePath(incoming.pathname === '/' ? '/index.html' : incoming.pathname);
  if (!filePath) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  serveStatic(req, res, filePath);
});

server.listen(PORT, HOST, () => {
  console.log(`MMT dev server: http://${HOST}:${PORT}`);
  console.log('Same-origin API proxy: /proxy?url=https://...');
  console.log('Open the URL above — no CORS proxy field needed.');
});
