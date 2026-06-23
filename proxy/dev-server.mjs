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
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLS_SOURCE_PATH, REMOTE_BASE_PATH } from '../archivePaths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.MMT_DEV_PORT || 8788);
const HOST = process.env.MMT_DEV_HOST || '127.0.0.1';

const ALLOWED_HOSTS = new Set(
  (process.env.ALLOWED_HOSTS || 'admin.classes.nagwa.com,qms-api.nagwa.com,12digit.nagwa.com,oauth2.googleapis.com')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean),
);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
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

const FS_MOUNTS = {
  cls: CLS_SOURCE_PATH,
  slides: REMOTE_BASE_PATH,
};

function resolveFsPath(mountName, relPath = '') {
  const root = FS_MOUNTS[mountName];
  if (!root) return null;
  const rootResolved = path.resolve(root);
  const normalized = String(relPath || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.')
    .join(path.sep);
  const full = normalized ? path.join(rootResolved, normalized) : rootResolved;
  const fullResolved = path.resolve(full);
  if (fullResolved !== rootResolved && !fullResolved.startsWith(`${rootResolved}${path.sep}`)) {
    return null;
  }
  return fullResolved;
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function handleFsStatus(res) {
  const mounts = {};
  for (const [name, rootPath] of Object.entries(FS_MOUNTS)) {
    const ok = await pathExists(rootPath);
    mounts[name] = { path: rootPath, ok };
  }
  res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify({ mounts }));
}

async function handleFsStat(mountName, relPath, res) {
  const abs = resolveFsPath(mountName, relPath);
  if (!abs) {
    res.writeHead(400, { 'Content-Type': 'text/plain', ...CORS });
    res.end('Invalid path');
    return;
  }
  try {
    const stat = await fsp.stat(abs);
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({
      exists: true,
      isFile: stat.isFile(),
      isDir: stat.isDirectory(),
    }));
  } catch {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ exists: false, isFile: false, isDir: false }));
  }
}

async function handleFsList(mountName, relPath, res) {
  const abs = resolveFsPath(mountName, relPath);
  if (!abs) {
    res.writeHead(400, { 'Content-Type': 'text/plain', ...CORS });
    res.end('Invalid path');
    return;
  }
  try {
    const stat = await fsp.stat(abs);
    if (!stat.isDirectory()) {
      res.writeHead(400, { 'Content-Type': 'text/plain', ...CORS });
      res.end('Not a directory');
      return;
    }
    const names = (await fsp.readdir(abs)).sort();
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ names }));
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain', ...CORS });
    res.end(e.message);
  }
}

async function handleFsRead(mountName, relPath, res) {
  const abs = resolveFsPath(mountName, relPath);
  if (!abs) {
    res.writeHead(400, { 'Content-Type': 'text/plain', ...CORS });
    res.end('Invalid path');
    return;
  }
  try {
    const stat = await fsp.stat(abs);
    if (!stat.isFile()) {
      res.writeHead(400, { 'Content-Type': 'text/plain', ...CORS });
      res.end('Not a file');
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, ...CORS });
    fs.createReadStream(abs).pipe(res);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain', ...CORS });
    res.end(e.message);
  }
}

async function handleFs(req, res, incoming) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
    return;
  }

  const parts = incoming.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'fs') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  if (parts.length === 2 && parts[1] === 'status') {
    await handleFsStatus(res);
    return;
  }

  const mountName = parts[1];
  const action = parts[2];
  const relPath = incoming.searchParams.get('path') || '';

  if (!FS_MOUNTS[mountName]) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`Unknown mount: ${mountName}`);
    return;
  }

  if (action === 'stat') {
    await handleFsStat(mountName, relPath, res);
    return;
  }
  if (action === 'list') {
    await handleFsList(mountName, relPath, res);
    return;
  }
  if (action === 'read') {
    await handleFsRead(mountName, relPath, res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

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

  if (incoming.pathname === '/fs/status' || incoming.pathname.startsWith('/fs/')) {
    await handleFs(req, res, incoming);
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
  console.log(`Local archives: CLS=${CLS_SOURCE_PATH}`);
  console.log(`Local archives: slides=${REMOTE_BASE_PATH}`);
  console.log('Open the URL above — no CORS proxy field needed.');
});
