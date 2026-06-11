/**
 * Port of video_slide.py — video frame extraction via ffmpeg.wasm and Canvas compositing.
 */

import {
  csvCellStr,
  findCsvForMetasession,
  isTwelveDigitId,
  loadSessionRows,
} from '../shared/sessionCsv.js';
import { fetchDownloadUrl } from '../shared/httpFetch.js';
import { extractFrame } from '../video/ffmpegBridge.js';
import {
  applyVideoOverlays,
  canvasToBlob,
  canvasToPdfBytes,
  DESIGN_SIZE,
  loadPlayIcon,
  resizeCover,
  THUMB_SIZE,
  TITLE_FONT_SIZE,
} from '../video/composite.js';

const PRESIGN_API_URL = 'https://admin.classes.nagwa.com/api/v1/videos/{video_id}/';
const DEFAULT_VIDEO_DOWNLOAD_API_KEY = 'KbykjcvM9ljLd8P3YQLxyenWmNmKOuryjZJFFYmMxIc';
const DOWNLOAD_CHUNK_SIZE = 256 * 1024;
const DOWNLOAD_PROGRESS_INTERVAL_SEC = 0.25;
const DOWNLOAD_WORKERS_PER_SESSION = 5;

function isVideoCsvRow(row) {
  return isTwelveDigitId(row.video_id);
}

function videoSlideFolderId(row) {
  const sid = csvCellStr(row.slide_id);
  const vid = csvCellStr(row.video_id);
  if (sid && sid.toLowerCase() !== 'new') return sid;
  return vid;
}

function videoTitleFromRow(row) {
  return csvCellStr(row.section_title);
}

function metasessionIdFromFolderName(name) {
  const match = name.match(/^(\d{12})/);
  return match ? match[1] : null;
}

function languageFromCsvPath(csvPath) {
  const name = csvPath.split('/').pop().toLowerCase();
  if (name.endsWith('_ar.csv')) return 'ar';
  if (name.endsWith('_en.csv')) return 'en';
  return 'en';
}

/**
 * @param {string} raw
 * @returns {number}
 */
function parseTimestampToSeconds(raw) {
  const s = csvCellStr(raw);
  if (!s) throw new Error('empty timestamp');
  if (s.includes(':')) {
    const parts = s.split(':').map((p) => Number(p.trim()));
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    throw new Error(`invalid time format: ${raw}`);
  }
  return Number(s);
}

function formatBytes(numBytes) {
  if (numBytes < 1024) return `${numBytes.toFixed(0)} B`;
  if (numBytes < 1024 ** 2) return `${(numBytes / 1024).toFixed(1)} KB`;
  if (numBytes < 1024 ** 3) return `${(numBytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(numBytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatSpeed(bytesPerSec) {
  return `${formatBytes(bytesPerSec)}/s`;
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown time left';
  if (seconds < 60) {
    const secs = Math.max(1, Math.round(seconds));
    return `${secs} sec${secs !== 1 ? 's' : ''} left`;
  }
  const mins = Math.max(1, Math.round(seconds / 60));
  return `${mins} min${mins !== 1 ? 's' : ''} left`;
}

function downloadProgressText(downloaded, total, elapsedSec) {
  const speed = elapsedSec > 0 ? downloaded / elapsedSec : 0;
  if (total && total > 0) {
    const remaining = speed > 0 ? (total - downloaded) / speed : Infinity;
    return `${formatSpeed(speed)} - ${formatBytes(downloaded)} of ${formatBytes(total)}, ${formatEta(remaining)}`;
  }
  return `${formatSpeed(speed)} - ${formatBytes(downloaded)}`;
}

/**
 * @param {object} ctx
 * @param {string} videoId
 * @returns {Promise<string | null>}
 */
async function fetchPresignedVideoUrl(ctx, videoId) {
  const fetchFn = ctx.fetchFn || ctx.config?.fetchFn || fetch;
  const apiKey = ctx.config?.videoDownloadApiKey || DEFAULT_VIDEO_DOWNLOAD_API_KEY;
  const apiUrl = PRESIGN_API_URL.replace('{video_id}', videoId);

  try {
    ctx.log(`[presign] GET ${apiUrl}`);
    const resp = await fetchFn(apiUrl, {
      headers: {
        'X-API-KEY': apiKey,
        'User-Agent': 'video_slide/1.0',
        Accept: 'application/json',
      },
    });

    let payload = {};
    try {
      payload = await resp.json();
    } catch {
      payload = {};
    }

    if (!resp.ok) {
      const err = payload?.error?.trim?.() || resp.statusText;
      ctx.log(`[presign] HTTP ${resp.status}: ${err}`);
      return null;
    }

    if (!payload.success) {
      ctx.log(`[presign] ${payload.error || 'request failed'}`);
      return null;
    }

    const videoUrl = payload.data?.video_url;
    if (!videoUrl || !String(videoUrl).trim()) {
      ctx.log('[presign] missing video_url in response');
      return null;
    }

    return String(videoUrl).trim();
  } catch (e) {
    ctx.log(`[presign] failed: ${e.message}`);
    return null;
  }
}

/**
 * @param {object} ctx
 * @param {string} url
 * @param {string} label
 * @param {(label: string, text: string) => void} [onProgress]
 * @returns {Promise<Uint8Array | null>}
 */
async function downloadBytes(ctx, url, label, onProgress) {
  const proxyUrl = ctx.config?.proxyUrl || '';
  try {
    onProgress?.(label, 'connecting…');
    const resp = await fetchDownloadUrl(url, {}, proxyUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const total = Number(resp.headers.get('content-length') || 0) || null;
    const reader = resp.body?.getReader();
    if (!reader) {
      const buf = new Uint8Array(await resp.arrayBuffer());
      onProgress?.(label, `${formatBytes(buf.length)}, done`);
      return buf;
    }

    const chunks = [];
    let downloaded = 0;
    const started = performance.now();
    let lastUpdate = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      downloaded += value.length;

      const now = performance.now();
      if (now - lastUpdate >= DOWNLOAD_PROGRESS_INTERVAL_SEC * 1000) {
        const elapsed = (now - started) / 1000;
        onProgress?.(label, downloadProgressText(downloaded, total, elapsed));
        lastUpdate = now;
      }
    }

    if (!downloaded) {
      onProgress?.(label, 'empty response');
      return null;
    }

    const merged = new Uint8Array(downloaded);
    let offset = 0;
    for (const chunk of chunks) merged.set(chunk, offset), (offset += chunk.length);

    const elapsed = (performance.now() - started) / 1000;
    onProgress?.(
      label,
      `${formatSpeed(downloaded / (elapsed || 1))} - ${formatBytes(downloaded)}${total ? ` of ${formatBytes(total)}` : ''}, done`,
    );
    return merged;
  } catch (e) {
    onProgress?.(label, `failed: ${e.message}`);
    return null;
  }
}

/**
 * @param {object} ctx
 * @param {string} videoId
 * @param {string} dest
 * @param {(label: string, text: string) => void} [onProgress]
 */
async function downloadVideo(ctx, videoId, dest, onProgress) {
  const videoUrl = await fetchPresignedVideoUrl(ctx, videoId);
  if (!videoUrl) return false;
  const bytes = await downloadBytes(ctx, videoUrl, videoId, onProgress);
  if (!bytes?.length) return false;
  await ctx.vfs.writeBytes(dest, bytes);
  return true;
}

/**
 * @param {object} ctx
 * @param {string} videoId
 * @param {string} slideDir
 * @param {(label: string, text: string) => void} [onProgress]
 * @returns {Promise<string>}
 */
async function resolveMp4(ctx, videoId, slideDir, onProgress) {
  const { vfs, log, config } = ctx;
  const dest = `${slideDir}/${videoId}.mp4`;

  if (await vfs.isFile(dest)) {
    const stat = await vfs.stat?.(dest);
    if (!stat || stat.size > 0) return dest;
  }

  if (await downloadVideo(ctx, videoId, dest, onProgress)) {
    return dest;
  }

  const fallback = `${config.videosFallbackDir || 'videos'}/${videoId}.mp4`;
  if (await vfs.isFile(fallback)) {
    await vfs.copyFile(fallback, dest);
    log(`[fallback] copied ${fallback} -> ${dest}`);
    return dest;
  }

  throw new Error(
    `Could not obtain video for ${videoId}: presign API download failed and no local file at ${fallback}`,
  );
}

/**
 * @param {Uint8Array} pngBytes
 * @returns {Promise<HTMLImageElement>}
 */
async function loadImageFromBytes(pngBytes) {
  const blob = new Blob([pngBytes], { type: 'image/png' });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  await img.decode();
  URL.revokeObjectURL(url);
  return img;
}

/**
 * @param {object} ctx
 * @param {string} sessionDir
 * @returns {Promise<string | null>}
 */
async function findCsvForSessionFolder(ctx, sessionDir) {
  const { vfs, config } = ctx;
  const metaId = metasessionIdFromFolderName(sessionDir.split('/').pop());
  const csvsDir = config.csvsDir || 'csvs';

  if (metaId) {
    const match = await findCsvForMetasession(metaId, vfs, csvsDir);
    if (match) return match;
  }

  const localCsv = (await vfs.listDir(sessionDir)).find((f) => f.endsWith('.csv'));
  return localCsv ? `${sessionDir}/${localCsv}` : null;
}

/**
 * @param {object} ctx
 * @param {Record<string, string>} row
 * @param {string} sessionDir
 * @param {string} lang
 * @param {string} font
 * @param {HTMLImageElement} playIcon
 * @param {(label: string, text: string) => void} [onProgress]
 */
async function processVideoRow(ctx, row, sessionDir, lang, font, playIcon, onProgress) {
  const { vfs, log } = ctx;
  const videoId = videoSlideFolderId(row);
  if (!isTwelveDigitId(videoId)) return;

  const tsRaw = csvCellStr(row.video_thumbnail_ts);
  if (!tsRaw) {
    throw new Error(
      `Video row slide_number=${row.slide_number} has video_id ${videoId} but missing video_thumbnail_ts`,
    );
  }

  const tsSec = parseTimestampToSeconds(tsRaw);
  const slideDir = `${sessionDir}/${videoId}`;
  if (!(await vfs.isDir(slideDir))) {
    throw new Error(`Slide folder not found: ${slideDir}`);
  }

  const title = videoTitleFromRow(row, lang);
  log(`\nVideo ${videoId} @ ${tsRaw} (${tsSec}s) -> ${videoId}/`);
  if (title) log(`Title: ${title.slice(0, 80)}${title.length > 80 ? '…' : ''}`);

  const mp4Path = await resolveMp4(ctx, videoId, slideDir, onProgress);
  const mp4Bytes = await vfs.readBytes(mp4Path);

  const framePng = await extractFrame(ctx, mp4Bytes, tsSec, `${videoId}.mp4`);
  const frameImg = await loadImageFromBytes(framePng);

  const baseCanvas = resizeCover(frameImg, DESIGN_SIZE.width, DESIGN_SIZE.height);
  const composed = applyVideoOverlays(baseCanvas, title, lang, font, playIcon);

  const fullPngPath = `${slideDir}/${videoId}.png`;
  const thumbPath = `${slideDir}/${videoId}_thumbnail.png`;
  const pdfPath = `${slideDir}/${videoId}.pdf`;

  const fullBlob = await canvasToBlob(composed, 'image/png');
  await vfs.writeBytes(fullPngPath, new Uint8Array(await fullBlob.arrayBuffer()));
  log(`Wrote ${videoId}.png (${DESIGN_SIZE.width}×${DESIGN_SIZE.height})`);

  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = THUMB_SIZE.width;
  thumbCanvas.height = THUMB_SIZE.height;
  thumbCanvas.getContext('2d').drawImage(composed, 0, 0, THUMB_SIZE.width, THUMB_SIZE.height);
  const thumbBlob = await canvasToBlob(thumbCanvas, 'image/png');
  await vfs.writeBytes(thumbPath, new Uint8Array(await thumbBlob.arrayBuffer()));
  log(`Wrote ${videoId}_thumbnail.png (${THUMB_SIZE.width}×${THUMB_SIZE.height})`);

  const pdfBytes = await canvasToPdfBytes(composed);
  await vfs.writeBytes(pdfPath, pdfBytes);
  log(`Wrote ${videoId}.pdf`);
}

/**
 * @param {object} ctx
 * @param {string} sessionDir
 * @param {string} fontFamily
 * @param {HTMLImageElement} playIcon
 * @returns {Promise<number>}
 */
async function processSession(ctx, sessionDir, fontFamily, playIcon) {
  const { log } = ctx;
  const csvPath = await findCsvForSessionFolder(ctx, sessionDir);
  if (!csvPath) {
    log(`Skip ${sessionDir.split('/').pop()}: no CSV found`);
    return 0;
  }

  const lang = languageFromCsvPath(csvPath);
  const rows = await loadSessionRows(ctx.vfs, csvPath);
  const videoRows = rows.filter(isVideoCsvRow);
  if (!videoRows.length) return 0;

  log(
    `\nSession: ${sessionDir.split('/').pop()} (${lang}, ${videoRows.length} video slide(s), up to ${DOWNLOAD_WORKERS_PER_SESSION} parallel downloads)`,
  );

  const font = `${TITLE_FONT_SIZE}px ${fontFamily}`;
  /** @type {Record<string, string>} */
  const active = {};

  const onProgress = (label, text) => {
    active[label] = text;
    const lines = Object.keys(active)
      .sort()
      .map((k) => `   [${k}] ${active[k]}`);
    if (lines.length) log(lines.join('\n'));
  };

  const queue = [...videoRows];
  let inFlight = 0;
  let index = 0;

  await new Promise((resolve, reject) => {
    const next = () => {
      while (inFlight < DOWNLOAD_WORKERS_PER_SESSION && index < queue.length) {
        const row = queue[index];
        index += 1;
        inFlight += 1;
        processVideoRow(ctx, row, sessionDir, lang, font, playIcon, (label, text) => {
          onProgress(label, text);
          if (text.includes('done') || text.startsWith('failed')) {
            delete active[label];
          }
        })
          .catch(reject)
          .finally(() => {
            inFlight -= 1;
            if (index >= queue.length && inFlight === 0) resolve();
            else next();
          });
      }
    };
    next();
  });

  return videoRows.length;
}

/**
 * @param {object} ctx
 * @returns {Promise<{ ok: boolean, total: number }>}
 */
export async function runVideoSlide(ctx) {
  const { vfs, log, config } = ctx;
  const filesDir = config.filesDir || 'files';

  if (!(await vfs.isDir(filesDir))) {
    throw new Error(`files/ directory not found at ${filesDir}`);
  }

  const playIconPath = config.playIconPath || 'assets/video_play_icon.png';
  let playIcon;
  if (await vfs.exists(playIconPath)) {
    const bytes = await vfs.readBytes(playIconPath);
    playIcon = await loadPlayIcon(new Blob([bytes]));
  } else if (typeof document !== 'undefined') {
    playIcon = await loadPlayIcon(playIconPath);
  } else {
    throw new Error(`Play icon asset not found at ${playIconPath}`);
  }

  const fontPath = config.fontPath || 'assets/fonts/Rubik-Bold.ttf';
  let fontFamily = 'Rubik, sans-serif';
  if (await vfs.exists(fontPath)) {
    const fontBytes = await vfs.readBytes(fontPath);
    const fontUrl = URL.createObjectURL(new Blob([fontBytes]));
    const face = new FontFace('Rubik-Bold', `url(${fontUrl})`);
    await face.load();
    document.fonts.add(face);
    fontFamily = 'Rubik-Bold, Rubik, sans-serif';
  }

  const sessionDirs = [];
  for (const name of await vfs.listDir(filesDir)) {
    if (!name.startsWith('.') && (await vfs.isDir(`${filesDir}/${name}`))) {
      sessionDirs.push(`${filesDir}/${name}`);
    }
  }
  sessionDirs.sort();

  if (!sessionDirs.length) {
    throw new Error(`No session folders in ${filesDir}`);
  }

  let total = 0;
  for (const sessionDir of sessionDirs) {
    total += await processSession(ctx, sessionDir, fontFamily, playIcon);
  }

  if (!total) log('\nNo video slides found in CSVs.');
  else log(`\n✅ Processed ${total} video slide(s).`);

  return { ok: true, total };
}
