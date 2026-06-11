/**
 * Lazy ffmpeg.wasm loader and video frame extraction.
 * @ffmpeg/ffmpeg is vendored under assets/vendor/ffmpeg (same origin) so Workers
 * work on GitHub Pages; cross-origin unpkg workers are blocked by the browser.
 * Core WASM is fetched from unpkg and passed as blob URLs to ffmpeg.load().
 */

import { FFmpeg } from '../../assets/vendor/ffmpeg/ffmpeg/index.js';
import { toBlobURL } from '../../assets/vendor/ffmpeg/util/index.js';

const DEFAULT_CORE_BASE = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';

/** @type {object | null} */
let ffmpegInstance = null;
/** @type {Promise<object> | null} */
let loadPromise = null;

/**
 * @param {object} ctx
 * @param {object} ctx.config
 * @param {string} [ctx.config.ffmpegCoreBaseUrl]
 * @param {Function} ctx.log
 */
export async function getFFmpeg(ctx) {
  if (ffmpegInstance) return ffmpegInstance;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const ffmpeg = new FFmpeg();
    ffmpeg.on('log', ({ message }) => {
      if (ctx?.log) ctx.log(`[ffmpeg] ${message}`);
    });

    const base = ctx?.config?.ffmpegCoreBaseUrl || DEFAULT_CORE_BASE;

    await ffmpeg.load({
      coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
    });

    ffmpegInstance = ffmpeg;
    return ffmpeg;
  })();

  return loadPromise;
}

/**
 * Extract a single frame at timestampSec from video bytes.
 * @param {object} ctx
 * @param {Uint8Array} videoBytes
 * @param {number} timestampSec
 * @param {string} [videoFileName]
 * @returns {Promise<Uint8Array>} PNG bytes
 */
export async function extractFrame(ctx, videoBytes, timestampSec, videoFileName = 'input.mp4') {
  const ffmpeg = await getFFmpeg(ctx);
  const inputName = videoFileName;
  const outputName = 'frame.png';
  const ts = Math.max(0, timestampSec);

  await ffmpeg.writeFile(inputName, videoBytes);

  const fastCmd = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', ts.toFixed(3),
    '-i', inputName,
    '-frames:v', '1',
    '-q:v', '2',
    outputName,
  ];

  const fallbackCmd = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', inputName,
    '-ss', ts.toFixed(3),
    '-frames:v', '1',
    '-q:v', '2',
    outputName,
  ];

  try {
    await ffmpeg.exec(fastCmd);
  } catch {
    await ffmpeg.deleteFile(outputName).catch(() => {});
    await ffmpeg.exec(fallbackCmd);
  }

  const pngData = await ffmpeg.readFile(outputName);
  await ffmpeg.deleteFile(inputName).catch(() => {});
  await ffmpeg.deleteFile(outputName).catch(() => {});

  return pngData instanceof Uint8Array ? pngData : new Uint8Array(pngData);
}

/**
 * Reset the lazy loader (e.g. for tests or re-init).
 */
export function resetFFmpeg() {
  ffmpegInstance = null;
  loadPromise = null;
}
