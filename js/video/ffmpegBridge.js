/**
 * Lazy ffmpeg.wasm loader and video frame extraction.
 * @ffmpeg/ffmpeg is vendored under assets/vendor/ffmpeg (same origin) so Workers
 * work on GitHub Pages; cross-origin unpkg workers are blocked by the browser.
 * Core WASM is fetched from unpkg and passed as blob URLs to ffmpeg.load().
 *
 * All ffmpeg FS/exec calls are serialized — the worker is not safe for parallel use.
 */

import { FFmpeg } from '../../assets/vendor/ffmpeg/ffmpeg/index.js';
import { toBlobURL } from '../../assets/vendor/ffmpeg/util/index.js';

const DEFAULT_CORE_BASE = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
const DEFAULT_FPS = 30;
const EXEC_TIMEOUT_MS = 180_000;

/** @type {object | null} */
let ffmpegInstance = null;
/** @type {Promise<object> | null} */
let loadPromise = null;
/** @type {Promise<unknown>} */
let ffmpegQueue = Promise.resolve();

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withFfmpegLock(fn) {
  const run = ffmpegQueue.then(fn, fn);
  ffmpegQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

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
 * @param {object} ffmpeg
 * @param {string[]} args
 * @param {number} [timeoutMs]
 */
async function execChecked(ffmpeg, args, timeoutMs = EXEC_TIMEOUT_MS) {
  const ret = await ffmpeg.exec(args, timeoutMs);
  if (ret !== 0) {
    throw new Error(`ffmpeg exited with code ${ret}`);
  }
}

/**
 * Probe duration (seconds) and FPS from ffmpeg stderr logs.
 * @param {object} ffmpeg
 * @param {string} inputName
 * @returns {Promise<{ duration: number, fps: number }>}
 */
async function probeVideoMeta(ffmpeg, inputName) {
  /** @type {string[]} */
  const logs = [];
  const onLog = ({ message }) => logs.push(message);
  ffmpeg.on('log', onLog);
  try {
    await ffmpeg.exec(['-hide_banner', '-i', inputName], 60_000);
  } catch {
    /* ffmpeg prints stream info then exits non-zero without an output file */
  } finally {
    ffmpeg.off('log', onLog);
  }

  const text = logs.join('\n');

  let duration = Number.POSITIVE_INFINITY;
  const durMatch = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (durMatch) {
    duration =
      Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3]);
  }

  let fps = DEFAULT_FPS;
  const fpsMatch = text.match(/,\s*(\d+(?:\.\d+)?)\s*fps\b/);
  if (fpsMatch) {
    fps = Number(fpsMatch[1]);
  } else {
    const tbrMatch = text.match(/,\s*(\d+)\s*\/\s*(\d+)\s*tbr\b/);
    if (tbrMatch) {
      fps = Number(tbrMatch[1]) / Number(tbrMatch[2]);
    }
  }

  if (!Number.isFinite(fps) || fps <= 0) fps = DEFAULT_FPS;
  return { duration, fps };
}

/**
 * Build ffmpeg args matching video_slide.py frame selection (coarse seek + select filter).
 * @param {string} inputName
 * @param {string} outputName
 * @param {number} timestampSec
 * @param {number} fps
 * @param {number} duration
 * @returns {{ fastCmd: string[], fallbackCmd: string[], simpleCmd: string[] }}
 */
function buildFrameExtractCommands(inputName, outputName, timestampSec, fps, duration) {
  const frameDur = 1 / fps;
  let ts = timestampSec;
  if (Number.isFinite(duration) && ts >= duration) {
    ts = Math.max(0, duration - frameDur);
  }

  const coarse = Math.max(0, ts - 2);
  const relT0 = ts - coarse;
  const relT1 = relT0 + frameDur;
  const vf = `select='gte(t\\,${relT0.toFixed(6)})*lt(t\\,${relT1.toFixed(6)})',setpts=N/FRAME_RATE/TB`;

  const fastCmd = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-threads',
    '1',
    '-ss',
    coarse.toFixed(3),
    '-i',
    inputName,
    '-an',
    '-vf',
    vf,
    '-frames:v',
    '1',
    '-fps_mode',
    'vfr',
    outputName,
  ];

  const absVf = `select='gte(t\\,${ts.toFixed(6)})*lt(t\\,${(ts + frameDur).toFixed(6)})',setpts=N/FRAME_RATE/TB`;
  const fallbackCmd = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-threads',
    '1',
    '-i',
    inputName,
    '-an',
    '-vf',
    absVf,
    '-frames:v',
    '1',
    '-fps_mode',
    'vfr',
    outputName,
  ];

  const simpleCmd = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-threads',
    '1',
    '-ss',
    ts.toFixed(3),
    '-i',
    inputName,
    '-an',
    '-frames:v',
    '1',
    '-c:v',
    'png',
    outputName,
  ];

  return { fastCmd, fallbackCmd, simpleCmd };
}

/**
 * @param {object} ffmpeg
 * @param {string} path
 */
async function readPngOrThrow(ffmpeg, path) {
  const data = await ffmpeg.readFile(path);
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (!bytes.length) {
    throw new Error('ffmpeg produced empty frame');
  }
  return bytes;
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
  return withFfmpegLock(async () => {
    const ffmpeg = await getFFmpeg(ctx);
    const inputName = videoFileName;
    const outputName = 'frame.png';
    const ts = Math.max(0, timestampSec);

    await ffmpeg.writeFile(inputName, videoBytes);

    const { duration, fps } = await probeVideoMeta(ffmpeg, inputName);
    if (Number.isFinite(duration) && ts >= duration && ctx?.log) {
      ctx.log(
        `[ffmpeg] warn: requested ${timestampSec}s but duration is ${duration.toFixed(2)}s`,
      );
    }

    const { fastCmd, fallbackCmd, simpleCmd } = buildFrameExtractCommands(
      inputName,
      outputName,
      ts,
      fps,
      duration,
    );

    let pngData;
    try {
      await execChecked(ffmpeg, fastCmd);
      pngData = await readPngOrThrow(ffmpeg, outputName);
    } catch {
      await ffmpeg.deleteFile(outputName).catch(() => {});
      try {
        await execChecked(ffmpeg, fallbackCmd);
        pngData = await readPngOrThrow(ffmpeg, outputName);
      } catch {
        await ffmpeg.deleteFile(outputName).catch(() => {});
        await execChecked(ffmpeg, simpleCmd);
        pngData = await readPngOrThrow(ffmpeg, outputName);
      }
    }

    await ffmpeg.deleteFile(inputName).catch(() => {});
    await ffmpeg.deleteFile(outputName).catch(() => {});

    return pngData;
  });
}

/**
 * Reset the lazy loader (e.g. for tests or re-init).
 */
export function resetFFmpeg() {
  ffmpegInstance = null;
  loadPromise = null;
  ffmpegQueue = Promise.resolve();
}
