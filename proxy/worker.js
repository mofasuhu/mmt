/**
 * Optional Cloudflare Worker CORS proxy for Nagwa APIs.
 *
 * Deploy:
 *   npx wrangler deploy proxy/worker.js
 *
 * Set the worker URL in the app "CORS proxy URL" field.
 */

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-KEY, Authorization, Accept',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const target = url.searchParams.get('url');
    if (!target) {
      return new Response('Missing url query parameter', { status: 400, headers: corsHeaders });
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return new Response('Invalid url', { status: 400, headers: corsHeaders });
    }

    const allowedHosts = (env.ALLOWED_HOSTS || 'admin.classes.nagwa.com,qms-api.nagwa.com,12digit.nagwa.com')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    const host = targetUrl.hostname;
    const hostAllowed = allowedHosts.includes(host)
      || host.endsWith('.amazonaws.com')
      || host.endsWith('.cloudfront.net');
    if (!hostAllowed) {
      return new Response(`Host not allowed: ${host}`, { status: 403, headers: corsHeaders });
    }

    const forwardHeaders = new Headers();
    for (const key of ['content-type', 'x-api-key', 'authorization', 'accept', 'user-agent']) {
      const val = request.headers.get(key);
      if (val) forwardHeaders.set(key, val);
    }

    const response = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: forwardHeaders,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    });

    const outHeaders = new Headers(response.headers);
    for (const [k, v] of Object.entries(corsHeaders)) outHeaders.set(k, v);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: outHeaders,
    });
  },
};
