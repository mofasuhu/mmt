/**
 * Google OAuth — browser sign-in (GitHub Pages) or static token files (local / shared team).
 */

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const DEFAULT_SCOPES = [DRIVE_SCOPE, SHEETS_SCOPE];

export const STATIC_AUTH_FILES = {
  credentials: 'credentials.json',
  driveToken: 'token.json',
  driveTokenRead: 'token_read.json',
  sheetsToken: 'token_sheet.json',
};

export const OAUTH_CONFIG_FILE = 'oauth-config.json';

/** @type {Record<string, object | null>} */
const staticTokenBundles = {
  drive: null,
  driveRead: null,
  sheets: null,
};

/** @type {Promise<void> | null} */
let gisScriptPromise = null;

function parseExpiryMs(expiry) {
  if (!expiry) return 0;
  const t = Date.parse(expiry);
  return Number.isNaN(t) ? 0 : t;
}

function accessTokenFromBundle(bundle) {
  if (!bundle) return null;
  return bundle.token || bundle.access_token || null;
}

function isBundleExpired(bundle, skewMs = 60_000) {
  const expiry = parseExpiryMs(bundle?.expiry);
  if (!expiry) return false;
  return Date.now() >= expiry - skewMs;
}

async function fetchJsonOptional(path) {
  try {
    const res = await fetch(path);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

function loadGisScript() {
  if (typeof window !== 'undefined' && window.google?.accounts?.oauth2) {
    return Promise.resolve();
  }
  if (!gisScriptPromise) {
    gisScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Failed to load Google Identity Services'));
      document.head.appendChild(script);
    });
  }
  return gisScriptPromise;
}

async function refreshTokenBundle(bundle, log = console.log, corsProxyUrl = '') {
  if (!bundle?.refresh_token) {
    throw new Error('Token expired and no refresh_token available.');
  }
  const clientId = bundle.client_id;
  const clientSecret = bundle.client_secret;
  if (!clientId || !clientSecret) {
    throw new Error('Token bundle missing client_id/client_secret for refresh.');
  }

  const refreshUrl = resolveTokenRefreshUrl(corsProxyUrl);
  log(`   [OAuth] Refreshing access token${refreshUrl !== GOOGLE_TOKEN_URL ? ' (via proxy)' : ''}...`);
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: bundle.refresh_token,
    grant_type: 'refresh_token',
  });

  const response = await fetch(refreshUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  bundle.token = data.access_token;
  bundle.expiry = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();
  return bundle.token;
}

async function resolveAccessToken(bundle, log, corsProxyUrl = '') {
  if (!bundle) return null;
  let token = accessTokenFromBundle(bundle);
  if (token && !isBundleExpired(bundle)) return token;
  if (!bundle.refresh_token) return token;
  return refreshTokenBundle(bundle, log, corsProxyUrl);
}

function enrichTokenBundle(bundle, clientId, clientSecret) {
  if (!bundle) return;
  if (!bundle.client_id && clientId) bundle.client_id = clientId;
  if (!bundle.client_secret && clientSecret) bundle.client_secret = clientSecret;
}

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

function resolveTokenRefreshUrl(corsProxyUrl = '') {
  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    if (host === '127.0.0.1' || host === 'localhost') {
      return `${window.location.origin}/proxy?url=${encodeURIComponent(GOOGLE_TOKEN_URL)}`;
    }
  }
  const proxy = String(corsProxyUrl || '').trim().replace(/\/$/, '');
  if (proxy) {
    return `${proxy}?url=${encodeURIComponent(GOOGLE_TOKEN_URL)}`;
  }
  return GOOGLE_TOKEN_URL;
}

export class GoogleAuth {
  constructor() {
    this.clientId = '';
    this.clientSecret = '';
    this.credentialsLoaded = false;
    this.staticAuthReady = false;
    this.oauthClientId = '';
    this.oauthScopes = [...DEFAULT_SCOPES];
    this.corsProxyUrl = '';
    /** @type {string | null} */
    this.interactiveToken = null;
    this.interactiveExpiryMs = 0;
  }

  getInteractiveTokenIfValid(skewMs = 60_000) {
    if (!this.interactiveToken) return null;
    if (this.interactiveExpiryMs && Date.now() >= this.interactiveExpiryMs - skewMs) {
      return null;
    }
    return this.interactiveToken;
  }

  /**
   * Load oauth-config.json (web client_id for browser sign-in on GitHub Pages).
   * @param {(msg: string) => void} [log]
   */
  async loadOAuthConfig(log = console.log) {
    const config = await fetchJsonOptional(OAUTH_CONFIG_FILE);
    if (!config) {
      log(`ℹ️  ${OAUTH_CONFIG_FILE} not found — browser sign-in disabled (use local token files or add config for GitHub Pages).`);
      return false;
    }

    const clientId = String(config.client_id || '').trim();
    if (clientId) {
      this.oauthClientId = clientId;
      this.clientId = clientId;
      // log(`Loaded OAuth web client from ${OAUTH_CONFIG_FILE}`);
    }

    if (Array.isArray(config.scopes) && config.scopes.length) {
      this.oauthScopes = config.scopes.map(String);
    }

    const proxy = String(config.cors_proxy_url || '').trim();
    if (proxy) {
      this.corsProxyUrl = proxy;
      // log(`Default CORS proxy from ${OAUTH_CONFIG_FILE}: ${proxy}`);
    }

    return Boolean(this.oauthClientId);
  }

  /**
   * Load credentials.json + token.json, token_read.json, token_sheet.json from project root.
   * @param {(msg: string) => void} [log]
   */
  async loadStaticAuthFiles(log = console.log) {
    const credentials = await fetchJsonOptional(STATIC_AUTH_FILES.credentials);
    if (credentials) {
      const installed = credentials.installed || credentials.web || credentials;
      this.clientId = installed.client_id || this.clientId;
      this.clientSecret = installed.client_secret || '';
      this.credentialsLoaded = Boolean(this.clientId);
      if (installed.client_id) {
        log(`Loaded OAuth client from ${STATIC_AUTH_FILES.credentials}`);
      }
    }

    staticTokenBundles.drive = await fetchJsonOptional(STATIC_AUTH_FILES.driveToken);
    staticTokenBundles.driveRead = await fetchJsonOptional(STATIC_AUTH_FILES.driveTokenRead);
    staticTokenBundles.sheets = await fetchJsonOptional(STATIC_AUTH_FILES.sheetsToken);

    for (const bundle of Object.values(staticTokenBundles)) {
      enrichTokenBundle(bundle, this.clientId, this.clientSecret);
    }

    if (staticTokenBundles.drive) {
      log(`Loaded Drive token from ${STATIC_AUTH_FILES.driveToken}`);
    }
    if (staticTokenBundles.driveRead) {
      log(`Loaded Drive fallback token from ${STATIC_AUTH_FILES.driveTokenRead}`);
    }
    if (staticTokenBundles.sheets) {
      log(`Loaded Sheets token from ${STATIC_AUTH_FILES.sheetsToken}`);
    }

    if (!this.clientId) {
      const src = staticTokenBundles.drive || staticTokenBundles.sheets;
      if (src?.client_id) this.clientId = src.client_id;
    }

    this.staticAuthReady = Boolean(
      staticTokenBundles.drive || staticTokenBundles.driveRead || staticTokenBundles.sheets,
    );
    return this.staticAuthReady;
  }

  get browserSignInAvailable() {
    return Boolean(this.oauthClientId);
  }

  get prefersSharedTokens() {
    return this.staticAuthReady;
  }

  get isAuthenticated() {
    if (this.getInteractiveTokenIfValid()) return true;
    if (this.staticAuthReady) return true;
    return false;
  }

  getAuthStatus() {
    const interactive = Boolean(this.getInteractiveTokenIfValid());
    return {
      interactive,
      browserSignIn: this.browserSignInAvailable,
      credentials: this.credentialsLoaded,
      drive: Boolean(staticTokenBundles.drive),
      driveRead: Boolean(staticTokenBundles.driveRead),
      sheets: Boolean(staticTokenBundles.sheets),
      staticReady: this.staticAuthReady,
      clientId: this.clientId ? `${this.clientId.slice(0, 20)}…` : '',
    };
  }

  /**
   * Browser sign-in via Google Identity Services (for GitHub Pages users).
   * @param {(msg: string) => void} [log]
   * @param {{ prompt?: string }} [opts]
   */
  async signInInteractive(log = console.log, { prompt = '' } = {}) {
    if (!this.oauthClientId) {
      throw new Error(
        `Browser sign-in is not configured. Add client_id to ${OAUTH_CONFIG_FILE} (see ${OAUTH_CONFIG_FILE.replace('.json', '.json.example')}).`,
      );
    }

    await loadGisScript();
    const scope = this.oauthScopes.join(' ');

    return new Promise((resolve, reject) => {
      try {
        const client = window.google.accounts.oauth2.initTokenClient({
          client_id: this.oauthClientId,
          scope,
          callback: (response) => {
            if (response.error) {
              reject(new Error(response.error_description || response.error));
              return;
            }
            this.interactiveToken = response.access_token;
            this.interactiveExpiryMs = Date.now() + (response.expires_in || 3600) * 1000;
            log('Signed in with Google (browser).');
            resolve(this.interactiveToken);
          },
        });
        client.requestAccessToken({ prompt });
      } catch (e) {
        reject(e);
      }
    });
  }

  async getStaticDriveAccessToken(log = console.log) {
    const primary = staticTokenBundles.drive;
    const fallback = staticTokenBundles.driveRead;

    try {
      const token = await resolveAccessToken(primary, log, this.corsProxyUrl);
      if (token) return token;
    } catch (e) {
      log(`Drive token refresh failed (${STATIC_AUTH_FILES.driveToken}): ${e.message}`);
    }

    if (fallback) {
      log(`Trying Drive fallback ${STATIC_AUTH_FILES.driveTokenRead}...`);
      return resolveAccessToken(fallback, log, this.corsProxyUrl);
    }

    return null;
  }

  async getStaticSheetsAccessToken(log = console.log) {
    const bundle = staticTokenBundles.sheets;
    if (!bundle) return null;
    return resolveAccessToken(bundle, log, this.corsProxyUrl);
  }

  async getDriveAccessToken(log = console.log) {
    const interactive = this.getInteractiveTokenIfValid();
    if (interactive) return interactive;

    const staticToken = await this.getStaticDriveAccessToken(log);
    if (staticToken) return staticToken;

    throw new Error(
      'No valid Drive access. Sign in with Google, or add token.json next to index.html for local dev.',
    );
  }

  async getSheetsAccessToken(log = console.log) {
    const interactive = this.getInteractiveTokenIfValid();
    if (interactive) return interactive;

    const staticToken = await this.getStaticSheetsAccessToken(log);
    if (staticToken) return staticToken;

    throw new Error(
      'No valid Sheets access. Sign in with Google, or add token_sheet.json next to index.html for local dev.',
    );
  }

  /**
   * Ensure the user is authenticated — interactive sign-in or static tokens.
   * @param {(msg: string) => void} [log]
   */
  async ensureAuthenticated(log = console.log) {
    if (this.getInteractiveTokenIfValid()) return;

    let staticDrive = null;
    let staticSheets = null;
    let staticError = '';

    try {
      staticDrive = await this.getStaticDriveAccessToken(log);
    } catch (e) {
      staticError = e.message;
      log(`Drive token failed: ${e.message}`);
    }

    try {
      staticSheets = await this.getStaticSheetsAccessToken(log);
    } catch (e) {
      staticError = staticError || e.message;
      log(`Sheets token failed: ${e.message}`);
    }

    if (staticDrive && staticSheets) return;

    if (this.browserSignInAvailable) {
      const prompt = this.interactiveToken ? '' : 'consent';
      await this.signInInteractive(log, { prompt });
      return;
    }

    if (this.staticAuthReady) {
      throw new Error(
        `Shared token refresh failed${staticError ? `: ${staticError}` : ''}. `
        + 'On localhost use node proxy/dev-server.mjs (restart after update). '
        + 'On GitHub Pages redeploy proxy/worker.js so oauth2.googleapis.com is allowed.',
      );
    }

    throw new Error(
      'Google auth not configured. For published site: set client_id in oauth-config.json. For local dev: add token.json and token_sheet.json.',
    );
  }

  async connectDrive(log = console.log) {
    await this.ensureAuthenticated(log);
    const token = await this.getDriveAccessToken(log);
    if (!token) throw new Error('Drive authentication failed.');
    log(this.getInteractiveTokenIfValid() ? 'Google Drive ready (browser sign-in).' : 'Google Drive ready (static token).');
    return token;
  }

  async connectSheets(log = console.log) {
    await this.ensureAuthenticated(log);
    const token = await this.getSheetsAccessToken(log);
    if (!token) throw new Error('Sheets authentication failed.');
    log(this.getInteractiveTokenIfValid() ? 'Google Sheets ready (browser sign-in).' : 'Google Sheets ready (static token).');
    return token;
  }

  async getAuthorizedFetch(scopeKey = 'drive', log = console.log) {
    const token = scopeKey === 'sheets'
      ? await this.getSheetsAccessToken(log)
      : await this.getDriveAccessToken(log);

    return (url, init = {}) => fetch(url, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${token}`,
      },
    });
  }
}

export class GoogleSheets {
  constructor(auth) {
    this.auth = auth;
    this.spreadsheetId = '1Qc9LrE54LyDzAB1sAyK6iBJDJUbT1Y3sh9-7MNSm85M';
    this._log = console.log;
  }

  setLog(fn) {
    this._log = fn;
  }

  async api(path, { method = 'GET', body = null } = {}) {
    const token = await this.auth.getSheetsAccessToken(this._log);
    const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheetId}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const err = new Error(`Sheets API ${response.status}`);
      err.status = response.status;
      throw err;
    }
    if (response.status === 204) return null;
    return response.json();
  }

  async read(range, spreadsheetId = null) {
    const prev = this.spreadsheetId;
    if (spreadsheetId) this.spreadsheetId = spreadsheetId;
    try {
      const data = await this.api(`/values/${encodeURIComponent(range)}`);
      return data.values || [];
    } finally {
      if (spreadsheetId) this.spreadsheetId = prev;
    }
  }

  async append(range, rows, spreadsheetId = null) {
    const prev = this.spreadsheetId;
    if (spreadsheetId) this.spreadsheetId = spreadsheetId;
    try {
      return this.api(`/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
        method: 'POST',
        body: { values: rows },
      });
    } finally {
      if (spreadsheetId) this.spreadsheetId = prev;
    }
  }

  async appendToTempTab(rows) {
    return this.append('temp!A:B', rows);
  }

  async appendRows(spreadsheetId, tabName, rows) {
    const prev = this.spreadsheetId;
    this.spreadsheetId = spreadsheetId;
    try {
      return await this.append(`${tabName}!A:B`, rows);
    } finally {
      this.spreadsheetId = prev;
    }
  }
}

export function createGoogleAuth() {
  return new GoogleAuth();
}
