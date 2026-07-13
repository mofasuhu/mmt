/**
 * Port of download_with_rename.py — download Google Slides as PPTX to sessions/.
 */

import { sanitizePptxDownloadBasenameForPlatform } from '../shared/sessionCsv.js';

const URL_COLUMN_NAME = 'url';
const NAME_COLUMN_NAME = 'name';
const PROGRESS_INTERVAL_MS = 200;

/**
 * @param {Headers} headers
 * @param {string} presentationId
 * @returns {string}
 */
function extractFilename(headers, presentationId) {
  const contentDisposition = headers.get('content-disposition') || '';

  const encodedMatch = contentDisposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (encodedMatch) {
    return decodeURIComponent(encodedMatch[1]);
  }

  const plainMatch = contentDisposition.match(/filename\s*=\s*"?([^";]+)"?/i);
  if (plainMatch) {
    return plainMatch[1];
  }

  return `${presentationId}.pptx`;
}

/**
 * @param {string} filename
 * @param {number} [maxLen]
 * @returns {string}
 */
function progressLabel(filename, maxLen = 34) {
  let label = filename.replace(/\s*\|\s*/g, ' / ');
  label = label.replace(/[\r\n\t]/g, ' ').trim();
  if (label.length > maxLen) return `${label.slice(0, maxLen - 1)}…`;
  return label;
}

function formatProgressLine(label, downloaded, totalSize, elapsedSec) {
  const speed = elapsedSec > 0 ? downloaded / elapsedSec : 0;
  const speedStr = speed < 1024 ? `${speed.toFixed(0)} B/s` : `${(speed / 1024).toFixed(1)} KB/s`;
  const progressStr = totalSize
    ? `${(downloaded / 1024).toFixed(1)} / ${(totalSize / 1024).toFixed(1)} KB`
    : `${(downloaded / 1024).toFixed(1)} KB`;
  return `[${label}] ${speedStr} — ${progressStr}`;
}

/**
 * @param {string} url
 * @param {Function} authedFetch
 * @param {object} vfs
 * @param {string} outputDir
 * @param {Function} log
 */
async function transformAndDownload(url, authedFetch, vfs, outputDir, log, customName = '') {
  const match = url.match(/\/presentation\/d\/([a-zA-Z0-9-_]+)/);
  if (!match) {
    log(`[!] Could not extract Presentation ID from URL: ${url}`);
    return { ok: false, error: 'Could not extract Presentation ID from URL' };
  }

  const presentationId = match[1];
  const downloadUrl = `https://docs.google.com/presentation/d/${presentationId}/export/pptx`;

  let outputPath;
  try {
    log('Waiting for Google to prepare the export (this can take 30s–2min)...');
    const response = await authedFetch(downloadUrl);

    if (!response.ok) {
      if (response.status === 404) {
        log('-> The file may not exist or export is disabled.');
      } else if (response.status === 403) {
        log('-> You might not have permission to download this file.');
      } else if (response.status === 401) {
        log('-> The authentication token is invalid or expired. Please re-authenticate.');
      }
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const rawFilename = customName.trim()
      ? customName.trim()
      : extractFilename(response.headers, presentationId);
    const sanitizedName = sanitizePptxDownloadBasenameForPlatform(rawFilename);

    outputPath = `${outputDir}/${sanitizedName}`;
    log(`→ ${sanitizedName}`);

    const totalSize = Number(response.headers.get('content-length') || 0);
    const label = progressLabel(sanitizedName);
    const reader = response.body?.getReader();

    if (!reader) {
      const buf = new Uint8Array(await response.arrayBuffer());
      await vfs.writeBytes(outputPath, buf);
      log(`[${label}] ${(buf.length / 1024).toFixed(1)} KB — done`);
      return { ok: true, filename: sanitizedName };
    }

    /** @type {Uint8Array | null} */
    let buffer = totalSize > 0 ? new Uint8Array(totalSize) : null;
    /** @type {Uint8Array[]} */
    const chunks = buffer ? null : [];
    let downloaded = 0;
    const started = performance.now();
    let lastProgressAt = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (buffer) {
        buffer.set(value, downloaded);
      } else {
        chunks.push(value);
      }
      downloaded += value.length;

      const now = performance.now();
      if (now - lastProgressAt < PROGRESS_INTERVAL_MS) continue;
      lastProgressAt = now;

      const elapsed = (now - started) / 1000;
      log(formatProgressLine(label, downloaded, totalSize, elapsed), { progress: true });
    }

    if (!buffer) {
      buffer = new Uint8Array(downloaded);
      let offset = 0;
      for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.length;
      }
    } else if (downloaded < buffer.length) {
      buffer = buffer.slice(0, downloaded);
    }

    await vfs.writeBytes(outputPath, buffer);

    const elapsed = (performance.now() - started) / 1000;
    log(`${formatProgressLine(label, downloaded, totalSize || downloaded, elapsed)} — done`, { progress: true });
    log(`Downloaded ${sanitizedName} (${(downloaded / 1024).toFixed(1)} KB in ${elapsed.toFixed(1)}s)`);

    if (totalSize > 0 && downloaded !== totalSize) {
      log(`[!] ERROR: Download incomplete for ${sanitizedName}`);
      return { ok: false, error: 'Download incomplete' };
    }

    return { ok: true, filename: sanitizedName };
  } catch (e) {
    if (outputPath && (await vfs.exists(outputPath))) {
      await vfs.remove(outputPath);
    }
    log(`[!] Error downloading file: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/**
 * @param {object} ctx
 * @returns {Promise<{ ok: boolean, downloaded: number }>}
 */
export async function runDownloadWithRename(ctx) {
  const { vfs, log, config, googleAuth } = ctx;
  const inputCsv = config.linksCsvPath || 'links.csv';
  const outputDir = config.sessionsDir || 'sessions';

  log('--- Google Slides Downloader ---');

  if (!googleAuth) {
    log('Authentication failed: googleAuth not configured.');
    return { ok: false, downloaded: 0 };
  }

  const authedFetch = await googleAuth.getAuthorizedFetch();
  if (!authedFetch) {
    log('Authentication failed. Exiting.');
    return { ok: false, downloaded: 0 };
  }

  await vfs.mkdir(outputDir, { recursive: true });
  log(`\nDownloads will be saved in: ${outputDir}`);

  if (!(await vfs.exists(inputCsv))) {
    log(`ERROR: Input file not found at '${inputCsv}'`);
    return { ok: false, downloaded: 0 };
  }

  const csvText = await vfs.readText(inputCsv);
  const { headers, rows } = parseCsvRecords(csvText);

  if (!headers.includes(URL_COLUMN_NAME)) {
    log(`ERROR: CSV must contain '${URL_COLUMN_NAME}' column.`);
    log(`Available columns: ${headers.join(', ')}`);
    return { ok: false, downloaded: 0 };
  }

  const hasNameColumn = headers.includes(NAME_COLUMN_NAME);
  const urlIdx = headers.indexOf(URL_COLUMN_NAME);
  const nameIdx = hasNameColumn ? headers.indexOf(NAME_COLUMN_NAME) : -1;

  const validRows = rows.filter((row) => String(row[urlIdx] || '').trim() !== '');
  log(`Found ${validRows.length} rows with valid URLs to process.`);

  let downloaded = 0;
  for (let i = 0; i < validRows.length; i += 1) {
    const row = validRows[i];
    const url = String(row[urlIdx]).trim();
    if (!url) continue;

    log(`\nProcessing row ${i + 1}/${validRows.length}: ${url}`);
    const customName = hasNameColumn ? String(row[nameIdx] || '').trim() : '';
    if (customName) {
      log(`Name from CSV: '${customName}'`);
    }

    const result = await transformAndDownload(url, authedFetch, vfs, outputDir, log, customName);
    if (result.ok) {
      downloaded += 1;
    }
  }

  log('\n--- Script finished. ---');
  return { ok: true, downloaded };
}

/**
 * Download every URL in links.csv; return per-row result dicts (validate-only orchestration).
 * @param {object} ctx
 * @returns {Promise<{ ok: boolean, results: Array<{ url: string, name: string, filename: string, ok: boolean, error?: string }> }>}
 */
export async function downloadAllFromLinks(ctx) {
  const { vfs, log, config, googleAuth } = ctx;
  const quiet = config.validateOnlyQuiet === true;
  const dlLog = quiet ? () => {} : log;
  const inputCsv = config.linksCsvPath || 'links.csv';
  const outputDir = config.sessionsDir || 'sessions';

  if (!googleAuth) {
    return { ok: false, results: [], error: 'googleAuth not configured' };
  }

  const authedFetch = await googleAuth.getAuthorizedFetch();
  if (!authedFetch) {
    return { ok: false, results: [], error: 'Google authentication failed' };
  }

  if (!(await vfs.exists(inputCsv))) {
    return { ok: false, results: [], error: `links.csv not found at '${inputCsv}'` };
  }

  await vfs.mkdir(outputDir, { recursive: true });

  const csvText = await vfs.readText(inputCsv);
  const { headers, rows } = parseCsvRecords(csvText);

  if (!headers.includes(URL_COLUMN_NAME)) {
    return { ok: false, results: [], error: `CSV must contain '${URL_COLUMN_NAME}' column` };
  }

  const hasNameColumn = headers.includes(NAME_COLUMN_NAME);
  const urlIdx = headers.indexOf(URL_COLUMN_NAME);
  const nameIdx = hasNameColumn ? headers.indexOf(NAME_COLUMN_NAME) : -1;

  const results = [];
  const validRows = rows.filter((row) => String(row[urlIdx] || '').trim() !== '');

  for (let i = 0; i < validRows.length; i += 1) {
    const row = validRows[i];
    const url = String(row[urlIdx]).trim();
    const customName = hasNameColumn ? String(row[nameIdx] || '').trim() : '';
    log(`\nProcessing row ${i + 1}/${validRows.length}: ${url}`);
    if (customName) log(`Name from CSV: '${customName}'`);

    const dl = await transformAndDownload(url, authedFetch, vfs, outputDir, dlLog, customName);
    results.push({
      url,
      name: customName,
      filename: dl.filename || '',
      ok: dl.ok,
      error: dl.error,
    });
    if (typeof config.onDownloadProgress === 'function') {
      config.onDownloadProgress(results.length, validRows.length);
    }
  }

  return { ok: true, results };
}

/**
 * @param {string} text
 * @returns {{ headers: string[], rows: string[][] }}
 */
function parseCsvRecords(text) {
  const allRows = parseCsv(text);
  if (!allRows.length) return { headers: [], rows: [] };
  const headers = allRows[0].map((h) => h.trim());
  return { headers, rows: allRows.slice(1) };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
