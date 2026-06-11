#!/usr/bin/env node
/**
 * Local CORS proxy for development.
 *
 *   node proxy/local-server.mjs
 *   # Then set CORS proxy URL to: http://127.0.0.1:8787
 *
 * Nagwa APIs usually work with direct browser fetch (CORS *), so this is only
 * needed if your environment blocks cross-origin requests.
 */

import http from 'node:http';
import { URL } from 'node:url';

const PORT = Number(process.env.MMT_PROXY_PORT || 8787);
const ALLOWED_HOSTS = new Set(
  (process.env.ALLOWED_HOSTS || 'admin.classes.nagwa.com,qms-api.nagwa.com,12digit.nagwa.com')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean),
);

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

const server = http.createServer(async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const incoming = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const targetRaw = incoming.searchParams.get('url');
  if (!targetRaw) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Missing url query parameter. Usage: /?url=https://...');
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
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.end(buf);
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`Proxy error: ${e.message}`);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`MMT local CORS proxy: http://127.0.0.1:${PORT}`);
  console.log('Paste that URL into the app "CORS proxy URL" field if direct API calls fail.');
});
