/** Local archive paths for step 6 — mirrored in copy_slides_content.py */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, 'archive-config.json');

const DEFAULTS = {
  cls_source_path: '/Users/user/GenMark/CLS',
  remote_base_path: '/Users/user/GenMark/2024-2025-Slides/All',
};

function loadNodeArchiveConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

const cfg = loadNodeArchiveConfig();
export const CLS_SOURCE_PATH = cfg.cls_source_path;
export const REMOTE_BASE_PATH = cfg.remote_base_path;
