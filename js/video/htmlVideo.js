/**
 * Browser-native video helpers for AV1 (and other codecs ffmpeg.wasm cannot decode).
 * Frame extract via HTMLVideoElement; optional H.264 remux via MediaRecorder.
 */

const PLAYABLE_VIDEO_CODECS = new Set(['h264', 'avc1']);

const H264_RECORDER_MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1.4D401E,mp4a.40.2',
  'video/mp4;codecs=avc1.64001E,mp4a.40.2',
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
];

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
 * @param {Uint8Array} bytes
 * @param {string} [mime]
 * @returns {Promise<HTMLVideoElement>}
 */
async function loadVideoElement(bytes, mime = 'video/mp4') {
  const copy = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes);
  const blob = new Blob([copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength)], {
    type: mime,
  });
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;

  await new Promise((resolve, reject) => {
    const onError = () => {
      cleanup();
      reject(new Error('HTMLVideoElement failed to load media (browser may not decode this codec)'));
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('loadeddata', onReady, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.load();
  });

  video._blobUrl = url;
  return video;
}

/**
 * @param {HTMLVideoElement} video
 */
function revokeVideo(video) {
  const url = video._blobUrl;
  video.removeAttribute('src');
  video.load();
  if (url) URL.revokeObjectURL(url);
  delete video._blobUrl;
}

/**
 * @param {HTMLVideoElement} video
 * @param {number} timestampSec
 */
async function seekVideo(video, timestampSec) {
  const duration = Number.isFinite(video.duration) ? video.duration : Number.POSITIVE_INFINITY;
  let ts = Math.max(0, timestampSec);
  if (Number.isFinite(duration) && duration > 0 && ts >= duration) {
    ts = Math.max(0, duration - 1 / 30);
  }

  await new Promise((resolve, reject) => {
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('HTMLVideoElement seek failed'));
    };
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    try {
      video.currentTime = ts;
    } catch (e) {
      cleanup();
      reject(e);
    }
  });
}

/**
 * Extract a PNG frame at timestampSec using the browser decoder.
 * @param {Uint8Array} videoBytes
 * @param {number} timestampSec
 * @param {{ log?: Function }} [ctx]
 * @returns {Promise<Uint8Array>}
 */
export async function extractFrameHtml(videoBytes, timestampSec, ctx = {}) {
  const video = await loadVideoElement(videoBytes);
  try {
    if (!video.videoWidth || !video.videoHeight) {
      throw new Error('HTMLVideoElement has no video dimensions');
    }
    await seekVideo(video, timestampSec);
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
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
    revokeVideo(video);
  }
}

/**
 * @returns {string | null}
 */
function pickH264RecorderMime() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) {
    return null;
  }
  for (const mime of H264_RECORDER_MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return null;
}

/**
 * Best-effort AV1→H.264 remux via MediaRecorder while playing the element.
 * @param {Uint8Array} videoBytes
 * @param {{ log?: Function }} [ctx]
 * @returns {Promise<Uint8Array | null>} H.264 MP4 bytes, or null if unavailable
 */
export async function ensurePlayableHtml(videoBytes, ctx = {}) {
  const mime = pickH264RecorderMime();
  if (!mime) {
    ctx.log?.(
      '[compat] MediaRecorder H.264/MP4 not supported in this browser; '
        + 'keeping original codec. Use Scripts/video_slide.py or '
        + 'mt_tool_with_migration_2 for QuickTime-safe H.264.',
    );
    return null;
  }
  if (typeof HTMLVideoElement === 'undefined'
      || typeof HTMLVideoElement.prototype.captureStream !== 'function'
        && typeof HTMLVideoElement.prototype.mozCaptureStream !== 'function') {
    ctx.log?.('[compat] captureStream unavailable; keeping original codec.');
    return null;
  }

  const video = await loadVideoElement(videoBytes);
  try {
    video.currentTime = 0;
    const stream = (
      typeof video.captureStream === 'function'
        ? video.captureStream()
        : video.mozCaptureStream()
    );
    if (!stream) {
      ctx.log?.('[compat] captureStream returned empty; keeping original codec.');
      return null;
    }

    const chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunks.push(ev.data);
    };

    const stopped = new Promise((resolve, reject) => {
      recorder.onstop = () => resolve();
      recorder.onerror = () => reject(new Error('MediaRecorder failed'));
    });

    recorder.start(250);
    await video.play();
    await new Promise((resolve) => {
      const onEnded = () => {
        video.removeEventListener('ended', onEnded);
        resolve();
      };
      video.addEventListener('ended', onEnded);
      // Safety timeout for odd streams that never fire ended
      const durMs = Number.isFinite(video.duration) ? video.duration * 1000 + 2000 : 120_000;
      setTimeout(resolve, Math.min(Math.max(durMs, 3000), 300_000));
    });
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;

    if (!chunks.length) {
      ctx.log?.('[compat] MediaRecorder produced no data; keeping original codec.');
      return null;
    }
    const blob = new Blob(chunks, { type: mime.startsWith('video/mp4') ? 'video/mp4' : mime });
    const out = new Uint8Array(await blob.arrayBuffer());
    if (!out.length) return null;
    ctx.log?.(`[compat] wrote playable H.264 via MediaRecorder (${out.length} bytes)`);
    return out;
  } catch (e) {
    ctx.log?.(`[compat] MediaRecorder remux failed (${e.message || e}); keeping original codec.`);
    return null;
  } finally {
    try {
      video.pause();
    } catch {
      /* ignore */
    }
    revokeVideo(video);
  }
}
