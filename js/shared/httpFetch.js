/**
 * Browser fetch helper for Nagwa APIs.
 * GitHub Pages cannot call Nagwa APIs directly (CORS preflight on X-API-KEY fails);
 * use a deployed proxy/worker.js URL via oauth-config.json or the UI field.
 */

export const NAGWA_DIRECT_HOSTS = new Set([
  'admin.classes.nagwa.com',
  'qms-api.nagwa.com',
  '12digit.nagwa.com',
]);

export function hostFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function shouldBypassProxy(url) {
  return NAGWA_DIRECT_HOSTS.has(hostFromUrl(url));
}

/** Hosts allowed through the CORS proxy (Nagwa APIs + presigned video CDNs). */
export function isProxyAllowedHost(hostname) {
  if (!hostname) return false;
  if (NAGWA_DIRECT_HOSTS.has(hostname)) return true;
  if (hostname.endsWith('.amazonaws.com')) return true;
  if (hostname.endsWith('.cloudfront.net')) return true;
  return false;
}

export function isDevProxyServer() {
  if (typeof window === 'undefined' || !window.location) return false;
  const { hostname, port } = window.location;
  return (hostname === '127.0.0.1' || hostname === 'localhost') && port === '8788';
}

export function isGitHubPagesHost() {
  return typeof window !== 'undefined'
    && window.location?.hostname?.endsWith('github.io');
}

/** Same-origin /proxy exists only on `node proxy/dev-server.mjs`, not on GitHub Pages. */
function devServerProxyBase() {
  if (!isDevProxyServer() || typeof window === 'undefined') return '';
  return `${window.location.origin}/proxy`;
}

function proxyGetUrl(proxyBase, targetUrl) {
  return `${proxyBase.replace(/\/$/, '')}?url=${encodeURIComponent(targetUrl)}`;
}

async function fetchViaProxy(proxyBase, url, init = {}) {
  const method = init.method || 'GET';
  const headers = init.headers || {};
  const proxyUrl = proxyGetUrl(proxyBase, url);

  if (method === 'GET' || method === 'HEAD') {
    return fetch(proxyUrl, { method, headers, signal: init.signal });
  }
  return fetch(proxyUrl, { method, headers, body: init.body, signal: init.signal });
}

/**
 * @param {() => string} getProxyUrl
 * @returns {typeof fetch}
 */
export function createAppFetch(getProxyUrl) {
  return async function appFetch(url, init = {}) {
    const nagwaDirect = shouldBypassProxy(url);
    const configured = (getProxyUrl() || '').trim().replace(/\/$/, '');
    const devProxy = devServerProxyBase();

    if (nagwaDirect) {
      // Published GitHub Pages: use CORS proxy when configured (direct browser calls fail preflight).
      if (isGitHubPagesHost() && configured) {
        return fetchViaProxy(configured, url, init);
      }

      const proxyFallbacks = [devProxy, configured].filter((p, i, arr) => p && arr.indexOf(p) === i);

      try {
        const response = await fetch(url, { ...init, credentials: 'omit', mode: 'cors' });
        if (response.ok) return response;
        for (const proxyBase of proxyFallbacks) {
          try {
            const proxied = await fetchViaProxy(proxyBase, url, init);
            if (proxied.ok) return proxied;
          } catch {
            /* try next */
          }
        }
        return response;
      } catch (directErr) {
        for (const proxyBase of proxyFallbacks) {
          try {
            return await fetchViaProxy(proxyBase, url, init);
          } catch {
            /* try next */
          }
        }
        throw directErr;
      }
    }

    if (!configured) {
      return fetch(url, init);
    }

    return fetchViaProxy(configured, url, init);
  };
}

/**
 * Fetch a presigned video/CDN URL server-side via proxy (browser direct GET often 403).
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {string} [proxyUrl]
 */
export async function fetchDownloadUrl(url, init = {}, proxyUrl = '') {
  const configured = (proxyUrl || '').trim().replace(/\/$/, '');
  const devProxy = devServerProxyBase();
  const proxies = [devProxy, configured].filter((p, i, arr) => p && arr.indexOf(p) === i);
  const headers = {
    'User-Agent': 'video_slide/1.0',
    Accept: '*/*',
    ...(init.headers || {}),
  };
  const opts = { ...init, headers, credentials: 'omit' };

  for (const proxyBase of proxies) {
    try {
      const resp = await fetchViaProxy(proxyBase, url, opts);
      if (resp.ok) return resp;
    } catch {
      /* try next */
    }
  }

  return fetch(url, opts);
}

/**
 * @param {typeof fetch} fetchFn
 * @param {string} apiKey
 * @returns {Promise<{ ok: boolean, status: number, via: string }>}
 */
export async function probeMetasessionApi(fetchFn, apiKey) {
  const url = 'https://admin.classes.nagwa.com/api/v1/metasessions/207162345231/';
  const response = await fetchFn(url, {
    method: 'GET',
    headers: {
      'X-API-KEY': apiKey,
      Accept: 'application/json',
    },
  });
  const via = response.url.includes('?url=') ? 'proxy' : 'direct';
  return { ok: response.ok, status: response.status, via };
}
