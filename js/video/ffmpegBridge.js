/**
 * Lazy ffmpeg.wasm loader and video frame extraction.
 * Loads @ffmpeg/ffmpeg from unpkg (no npm/bundler in the static browser app).
 */

const FFMPEG_MODULE_URL = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js';
const FFMPEG_UTIL_MODULE_URL = 'https://unpkg.com/@ffmpeg/util@0.12.1/dist/esm/index.js';

/** @type {object | null} */
let ffmpegInstance = null;
/** @type {Promise<object> | null} */
let loadPromise = null;

/**
 * @param {object} ctx
 * @param {object} ctx.config
 * @param {string} [ctx.config.ffmpegCoreBaseUrl]
 * @param {string} [ctx.config.ffmpegModuleUrl]
 * @param {string} [ctx.config.ffmpegUtilModuleUrl]
 * @param {Function} ctx.log
 */
export async function getFFmpeg(ctx) {
  if (ffmpegInstance) return ffmpegInstance;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const ffmpegModuleUrl = ctx?.config?.ffmpegModuleUrl || FFMPEG_MODULE_URL;
    const utilModuleUrl = ctx?.config?.ffmpegUtilModuleUrl || FFMPEG_UTIL_MODULE_URL;

    const { FFmpeg } = await import(ffmpegModuleUrl);
    const { toBlobURL } = await import(utilModuleUrl);

    const ffmpeg = new FFmpeg();
    ffmpeg.on('log', ({ message }) => {
      if (ctx?.log) ctx.log(`[ffmpeg] ${message}`);
    });

    const base =
      ctx?.config?.ffmpegCoreBaseUrl ||
      'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';

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
