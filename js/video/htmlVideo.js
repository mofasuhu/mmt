/**
 * Browser-native video helpers for AV1 (and other codecs ffmpeg.wasm cannot decode).
 * Frame extract via HTMLVideoElement. Full-file MediaRecorder remux is not used
 * (it hangs and holds a second copy of the bitstream in RAM).
 */

const PLAYABLE_VIDEO_CODECS = new Set(['h264', 'avc1']);
const LOAD_TIMEOUT_MS = 30_000;
const SEEK_TIMEOUT_MS = 20_000;
const FRAME_TIMEOUT_MS = 2_000;

/**
 * @param {string} title
 * @returns {string}
 */
export function normalizeVideoTitle(title) {
  if (!title) return title;
  return title.normalize('NFKC');
}

/**
 * @param {string} codec
 * @returns {boolean}
 */
export function isPlayableVideoCodec(codec) {
  return PLAYABLE_VIDEO_CODECS.has(String(codec || '').toLowerCase());
}

/**
 * @param {EventTarget} target
 * @param {string} successEvent
 * @param {string} errorEvent
 * @param {number} timeoutMs
 * @param {string} timeoutMsg
 * @param {string} [errorMsg]
 */
function waitForEvent(target, successEvent, errorEvent, timeoutMs, timeoutMsg, errorMsg) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      target.removeEventListener(successEvent, onOk);
      if (errorEvent) target.removeEventListener(errorEvent, onErr);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error(timeoutMsg)), timeoutMs);
    const onOk = () => finish(null);
    const onErr = () => finish(new Error(errorMsg || timeoutMsg));
    target.addEventListener(successEvent, onOk, { once: true });
    if (errorEvent) target.addEventListener(errorEvent, onErr, { once: true });
  });
}

/**
 * @param {Uint8Array} bytes
 * @param {string} [mime]
 * @param {{ log?: Function }} [ctx]
 * @returns {Promise<HTMLVideoElement>}
 */
async function loadVideoElement(bytes, mime = 'video/mp4', ctx = {}) {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;

  ctx.log?.('[html-video] load');
  try {
    await waitForEvent(
      video,
      'loadeddata',
      'error',
      LOAD_TIMEOUT_MS,
      `HTMLVideoElement load timed out after ${LOAD_TIMEOUT_MS / 1000}s`,
      'HTMLVideoElement failed to load media (browser may not decode this codec)',
    );
    try {
      await video.play();
      video.pause();
    } catch {
      /* muted autoplay can still fail; seek may work anyway */
    }
  } catch (err) {
    video.removeAttribute('src');
    try {
      video.load();
    } catch {
      /* ignore */
    }
    URL.revokeObjectURL(url);
    throw err;
  }

  video._blobUrl = url;
  return video;
}

/**
 * @param {HTMLVideoElement} video
 */
function revokeVideo(video) {
  try {
    video.pause();
  } catch {
    /* ignore */
  }
  const url = video._blobUrl;
  video.removeAttribute('src');
  try {
    video.load();
  } catch {
    /* ignore */
  }
  if (url) URL.revokeObjectURL(url);
  delete video._blobUrl;
}

/**
 * @param {HTMLVideoElement} video
 * @param {number} timestampSec
 * @param {{ log?: Function }} [ctx]
 */
async function seekVideo(video, timestampSec, ctx = {}) {
  const duration = Number.isFinite(video.duration) ? video.duration : Number.POSITIVE_INFINITY;
  let ts = Math.max(0, timestampSec);
  if (Number.isFinite(duration) && duration > 0 && ts >= duration) {
    ts = Math.max(0, duration - 1 / 30);
  }

  ctx.log?.(`[html-video] seek ${ts.toFixed(3)}s`);
  if (Math.abs((video.currentTime || 0) - ts) < 0.04) {
    return ts;
  }

  const seeked = waitForEvent(
    video,
    'seeked',
    'error',
    SEEK_TIMEOUT_MS,
    `HTMLVideoElement seek to ${ts.toFixed(3)}s timed out after ${SEEK_TIMEOUT_MS / 1000}s`,
    'HTMLVideoElement seek failed',
  );
  try {
    video.currentTime = ts;
  } catch (e) {
    throw e;
  }
  await seeked;
  return ts;
}

/**
 * @param {HTMLVideoElement} video
 */
async function waitForVideoFrame(video) {
  const waitRvfc = () => new Promise((resolve) => {
    if (typeof video.requestVideoFrameCallback === 'function') {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const id = video.requestVideoFrameCallback(() => finish());
      setTimeout(() => {
        try {
          video.cancelVideoFrameCallback?.(id);
        } catch {
          /* ignore */
        }
        finish();
      }, FRAME_TIMEOUT_MS);
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

  try {
    await video.play();
  } catch {
    /* capture a paused frame if play is blocked */
  }
  await waitRvfc();
  try {
    video.pause();
  } catch {
    /* ignore */
  }
}

/**
 * @param {HTMLVideoElement} video
 * @returns {Promise<Uint8Array>}
 */
async function captureFramePng(video) {
  if (!video.videoWidth || !video.videoHeight) {
    throw new Error('HTMLVideoElement has no video dimensions');
  }
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  try {
    const g = canvas.getContext('2d');
    if (!g) throw new Error('2d canvas unavailable');
    g.drawImage(video, 0, 0);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob failed'))),
        'image/png',
      );
    });
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * Extract a PNG frame at timestampSec using the browser decoder.
 * @param {Uint8Array} videoBytes
 * @param {number} timestampSec
 * @param {{ log?: Function }} [ctx]
 * @returns {Promise<Uint8Array>}
 */
export async function extractFrameHtml(videoBytes, timestampSec, ctx = {}) {
  const video = await loadVideoElement(videoBytes, 'video/mp4', ctx);
  try {
    if (!video.videoWidth || !video.videoHeight) {
      throw new Error('HTMLVideoElement has no video dimensions');
    }
    try {
      await seekVideo(video, timestampSec, ctx);
      await waitForVideoFrame(video);
      ctx.log?.('[html-video] frame');
      return await captureFramePng(video);
    } catch (err) {
      if (!(timestampSec > 0)) throw err;
      ctx.log?.(
        `[html-video] seek ${timestampSec}s failed (${err.message || err}); retrying t=0`,
      );
      await seekVideo(video, 0, ctx);
      await waitForVideoFrame(video);
      ctx.log?.('[html-video] frame at t=0');
      return await captureFramePng(video);
    }
  } finally {
    revokeVideo(video);
  }
}
