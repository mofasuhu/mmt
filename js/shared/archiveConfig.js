/**
 * Team archive paths — loaded from archive-config.json (committed).
 * Auto-mount uses the dev server /fs API on http://127.0.0.1:8788, or fs_api_base on GitHub Pages.
 */

export const ARCHIVE_CONFIG_FILE = 'archive-config.json';

export const DEFAULT_ARCHIVE_CONFIG = {
  remote_base_path: '/Users/user/GenMark/2024-2025-Slides/All',
  auto_mount: true,
  fs_api_base: '',
};

/** @type {typeof DEFAULT_ARCHIVE_CONFIG | null} */
let loadedConfig = null;

/**
 * @param {(msg: string) => void} [log]
 */
export async function loadArchiveConfig(log = console.log) {
  if (loadedConfig) return loadedConfig;
  try {
    const res = await fetch(ARCHIVE_CONFIG_FILE);
    if (res.ok) {
      loadedConfig = { ...DEFAULT_ARCHIVE_CONFIG, ...(await res.json()) };
      // log(`Loaded archive paths from ${ARCHIVE_CONFIG_FILE}`);
      return loadedConfig;
    }
  } catch {
    /* optional */
  }
  loadedConfig = { ...DEFAULT_ARCHIVE_CONFIG };
  return loadedConfig;
}

export function getArchiveConfig() {
  return loadedConfig ? { ...loadedConfig } : { ...DEFAULT_ARCHIVE_CONFIG };
}

export function isDevServerHost() {
  if (typeof window === 'undefined') return false;
  const { hostname, port } = window.location;
  return (hostname === '127.0.0.1' || hostname === 'localhost') && port === '8788';
}

/**
 * Base URL for /fs/* archive API (no trailing slash). Empty = same-origin dev server.
 * @param {typeof DEFAULT_ARCHIVE_CONFIG} [config]
 */
export function resolveFsApiBase(config = getArchiveConfig()) {
  const configured = String(config.fs_api_base || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  if (isDevServerHost()) return '';
  return '';
}
