/**
 * Image compositing for video slides (Canvas API port of video_slide.py).
 */

export const DESIGN_SIZE = { width: 1280, height: 960 };
export const THUMB_SIZE = { width: 512, height: 384 };
export const PDF_PAGE_PT = { width: 800, height: 600 };

export const PLAY_DIAMETER = 106;
export const PLAY_ICON_COMPOSITE_SUPERSAMPLE = 4;
export const TITLE_FONT_SIZE = 57;
export const TITLE_LINE_GAP_EN = 30;
export const TITLE_LINE_GAP_AR = 15;
export const EDGE_MARGIN = 68.5;
export const BOX_HEIGHT_ONE_LINE = 115.3;
export const BOX_HEIGHT_TWO_LINE = 188.5;
export const BOX_BG = '#0075bb';
export const TEXT_COLOR = '#ffffff';
export const TEXT_PAD_X = 39;
export const TITLE_BOX_MAX_WIDTH = 1000;
export const BOX_RADIUS = 8;

/** @type {HTMLImageElement | null} */
let playIconMaster = null;

/**
 * Load play icon from URL or bytes.
 * @param {string | Blob} source
 * @returns {Promise<HTMLImageElement>}
 */
export async function loadPlayIcon(source) {
  if (playIconMaster) return playIconMaster;

  const img = new Image();
  img.decoding = 'async';

  if (source instanceof Blob) {
    img.src = URL.createObjectURL(source);
  } else {
    img.src = source;
  }

  await img.decode();
  playIconMaster = img;
  return img;
}

/**
 * Cover-resize an image to exact dimensions (center crop).
 * @param {CanvasImageSource} img
 * @param {number} targetW
 * @param {number} targetH
 * @returns {HTMLCanvasElement}
 */
function applyHighQualitySmoothing(ctx) {
  ctx.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in ctx) {
    ctx.imageSmoothingQuality = 'high';
  }
}

export function resizeCover(img, targetW, targetH) {
  const srcW = img.width ?? /** @type {HTMLImageElement} */ (img).naturalWidth;
  const srcH = img.height ?? /** @type {HTMLImageElement} */ (img).naturalHeight;
  const scale = Math.max(targetW / srcW, targetH / srcH);
  const newW = Math.round(srcW * scale);
  const newH = Math.round(srcH * scale);

  const scratch = document.createElement('canvas');
  scratch.width = newW;
  scratch.height = newH;
  const sctx = scratch.getContext('2d');
  applyHighQualitySmoothing(sctx);
  sctx.drawImage(img, 0, 0, newW, newH);

  const left = Math.floor((newW - targetW) / 2);
  const top = Math.floor((newH - targetH) / 2);

  const out = document.createElement('canvas');
  out.width = targetW;
  out.height = targetH;
  const octx = out.getContext('2d');
  applyHighQualitySmoothing(octx);
  octx.drawImage(scratch, left, top, targetW, targetH, 0, 0, targetW, targetH);
  return out;
}

function configureTitleTextCtx(ctx, lang) {
  ctx.direction = 'ltr';
  ctx.lang = lang === 'ar' ? 'ar' : 'en';
}

/**
 * RTL isolate + LTR isolates around Latin tokens (mixed AR/EN video titles).
 * @param {string} line
 * @param {string} lang
 * @returns {string}
 */
export function prepareVideoTitleLine(line, lang) {
  if (lang !== 'ar' || !line) return line;
  const isolated = line.replace(/([A-Za-z][A-Za-z0-9._-]*)/g, '\u2066$1\u2069');
  return `\u2067${isolated}\u2069`;
}

/**
 * @param {string} lang
 * @returns {CanvasRenderingContext2D}
 */
function makeTitleMeasureCtx(lang) {
  const ctx = document.createElement('canvas').getContext('2d');
  configureTitleTextCtx(ctx, lang);
  return ctx;
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {string} font
 * @returns {{ width: number, height: number, ascent: number }}
 */
function measureText(ctx, text, font) {
  ctx.font = font;
  const metrics = ctx.measureText(text);
  const ascent = metrics.actualBoundingBoxAscent ?? TITLE_FONT_SIZE * 0.8;
  const descent = metrics.actualBoundingBoxDescent ?? TITLE_FONT_SIZE * 0.2;
  return {
    width: metrics.width,
    height: ascent + descent,
    ascent,
  };
}

/**
 * @param {string} title
 * @param {string} font
 * @param {number} maxInnerWidth
 * @param {number} [maxLines]
 * @returns {string[]}
 */
export function wrapTitleLines(title, font, maxInnerWidth, maxLines = 2, lang = 'en') {
  const words = title.split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  const probe = makeTitleMeasureCtx(lang);
  const lines = [];
  let current = [];

  for (const word of words) {
    const trial = current.length ? `${current.join(' ')} ${word}` : word;
    const measureLine = prepareVideoTitleLine(trial, lang);
    const { width } = measureText(probe, measureLine, font);
    if (width <= maxInnerWidth) {
      current.push(word);
    } else {
      if (current.length) lines.push(current.join(' '));
      current = [word];
      if (lines.length >= maxLines) break;
    }
  }
  if (current.length && lines.length < maxLines) {
    lines.push(current.join(' '));
  }
  return lines.slice(0, maxLines);
}

/**
 * @param {HTMLImageElement} master
 * @param {number} diameter
 * @returns {HTMLCanvasElement}
 */
export function renderPlayIconCanvas(master, diameter = PLAY_DIAMETER) {
  const canvas = document.createElement('canvas');
  canvas.width = diameter;
  canvas.height = diameter;
  const ctx = canvas.getContext('2d');

  let cur = master;
  let curCanvas = document.createElement('canvas');
  curCanvas.width = master.naturalWidth;
  curCanvas.height = master.naturalHeight;
  curCanvas.getContext('2d').drawImage(master, 0, 0);

  while (curCanvas.width > Math.max(diameter * 2, diameter + 1)) {
    const nxt = Math.max(diameter, Math.floor(curCanvas.width / 2));
    const next = document.createElement('canvas');
    next.width = nxt;
    next.height = nxt;
    next.getContext('2d').drawImage(curCanvas, 0, 0, nxt, nxt);
    curCanvas = next;
  }

  if (curCanvas.width !== diameter) {
    const final = document.createElement('canvas');
    final.width = diameter;
    final.height = diameter;
    final.getContext('2d').drawImage(curCanvas, 0, 0, diameter, diameter);
    curCanvas = final;
  }

  ctx.drawImage(curCanvas, 0, 0);
  return canvas;
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {HTMLImageElement} playIcon
 * @param {number} [diameter]
 */
export function drawPlayIcon(ctx, playIcon, diameter = PLAY_DIAMETER) {
  const ss = PLAY_ICON_COMPOSITE_SUPERSAMPLE;
  const iconCanvas = renderPlayIconCanvas(playIcon, diameter * ss);

  const overlay = document.createElement('canvas');
  overlay.width = ctx.canvas.width * ss;
  overlay.height = ctx.canvas.height * ss;
  const octx = overlay.getContext('2d');

  const left = Math.round(overlay.width / 2 - iconCanvas.width / 2);
  const top = Math.round(overlay.height / 2 - iconCanvas.height / 2);
  octx.drawImage(iconCanvas, left, top);

  const scaled = document.createElement('canvas');
  scaled.width = ctx.canvas.width;
  scaled.height = ctx.canvas.height;
  scaled.getContext('2d').drawImage(overlay, 0, 0, scaled.width, scaled.height);
  ctx.drawImage(scaled, 0, 0);
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} title
 * @param {string} lang
 * @param {string} font
 */
export function drawTitleBox(ctx, title, lang, font) {
  if (!title) return;

  const edge = Math.round(EDGE_MARGIN);
  const maxInnerW = Math.min(
    ctx.canvas.width - 2 * edge - 2 * TEXT_PAD_X,
    TITLE_BOX_MAX_WIDTH - 2 * TEXT_PAD_X,
  );
  const lines = wrapTitleLines(title, font, maxInnerW, 2, lang);
  if (!lines.length) return;

  configureTitleTextCtx(ctx, lang);
  ctx.font = font;
  ctx.fillStyle = TEXT_COLOR;

  const lineMetrics = lines.map((line) => {
    const drawLine = prepareVideoTitleLine(line, lang);
    const m = measureText(ctx, drawLine, font);
    return { line: drawLine, ...m };
  });

  const lineGap = lang === 'ar' ? TITLE_LINE_GAP_AR : TITLE_LINE_GAP_EN;
  const textBlockH =
    lineMetrics.reduce((sum, m) => sum + m.height, 0) + lineGap * (lines.length - 1);
  const boxH = lines.length === 1 ? BOX_HEIGHT_ONE_LINE : BOX_HEIGHT_TWO_LINE;
  const boxW = Math.min(
    Math.max(...lineMetrics.map((m) => m.width)) + 2 * TEXT_PAD_X,
    TITLE_BOX_MAX_WIDTH,
  );

  const y2 = ctx.canvas.height - edge;
  const y1 = Math.round(y2 - boxH);

  let x1;
  let x2;
  if (lang === 'ar') {
    x2 = ctx.canvas.width - edge;
    x1 = Math.round(x2 - boxW);
  } else {
    x1 = edge;
    x2 = Math.round(x1 + boxW);
  }

  ctx.fillStyle = BOX_BG;
  roundRect(ctx, x1, y1, x2 - x1, y2 - y1, BOX_RADIUS);
  ctx.fill();

  ctx.font = font;
  ctx.fillStyle = TEXT_COLOR;
  configureTitleTextCtx(ctx, lang);
  let yCursor = y1 + (boxH - textBlockH) / 2;

  for (const m of lineMetrics) {
    let x;
    if (lang === 'ar') {
      ctx.textAlign = 'right';
      x = x2 - TEXT_PAD_X;
    } else {
      ctx.textAlign = 'left';
      x = x1 + TEXT_PAD_X;
    }
    ctx.fillText(m.line, x, yCursor + m.ascent);
    yCursor += m.height + lineGap;
  }
}

function roundRect(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/**
 * Draw play icon and title on a copy of the frame canvas.
 * @param {HTMLCanvasElement} frameCanvas
 * @param {string} title
 * @param {string} lang
 * @param {string} font
 * @param {HTMLImageElement} playIcon
 * @returns {HTMLCanvasElement}
 */
export function applyVideoOverlays(frameCanvas, title, lang, font, playIcon) {
  const out = document.createElement('canvas');
  out.width = frameCanvas.width;
  out.height = frameCanvas.height;
  const ctx = out.getContext('2d');
  ctx.drawImage(frameCanvas, 0, 0);
  drawPlayIcon(ctx, playIcon);
  drawTitleBox(ctx, title, lang, font);
  return out;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {string} [type]
 * @param {number} [quality]
 * @returns {Promise<Blob>}
 */
export function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('canvas.toBlob failed'));
    }, type, quality);
  });
}

/**
 * Build a minimal single-page PDF embedding a JPEG image at exact page dimensions.
 * @param {Uint8Array} jpegBytes
 * @param {number} pageW
 * @param {number} pageH
 * @returns {Uint8Array}
 */
export function jpegToPdf(jpegBytes, pageW = PDF_PAGE_PT.width, pageH = PDF_PAGE_PT.height) {
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [0];

  const size = () => chunks.reduce((n, c) => n + c.length, 0);
  const append = (bytes) => chunks.push(bytes);
  const appendStr = (s) => append(enc.encode(s));
  const startObj = () => offsets.push(size());

  appendStr('%PDF-1.4\n');

  startObj();
  appendStr('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  startObj();
  appendStr('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  startObj();
  appendStr(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] ` +
      `/Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`,
  );
  startObj();
  appendStr(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pageW} /Height ${pageH} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`,
  );
  append(jpegBytes);
  appendStr('\nendstream\nendobj\n');

  const contentStream = `q ${pageW} 0 0 ${pageH} 0 0 cm /Im1 Do Q`;
  startObj();
  appendStr(`5 0 obj\n<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream\nendobj\n`);

  const xrefPos = size();
  let xref = 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i += 1) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  appendStr(xref);
  appendStr(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`);

  const out = new Uint8Array(size());
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Convert canvas to JPEG bytes for PDF embedding.
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<Uint8Array>}
 */
export async function canvasToJpegBytes(canvas, quality = 0.98) {
  const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {number} [pageW]
 * @param {number} [pageH]
 * @returns {Promise<Uint8Array>}
 */
export async function canvasToPdfBytes(canvas, pageW = PDF_PAGE_PT.width, pageH = PDF_PAGE_PT.height) {
  const pdfCanvas = document.createElement('canvas');
  pdfCanvas.width = pageW;
  pdfCanvas.height = pageH;
  const ctx = pdfCanvas.getContext('2d');
  applyHighQualitySmoothing(ctx);
  ctx.drawImage(canvas, 0, 0, pageW, pageH);
  const jpeg = await canvasToJpegBytes(pdfCanvas);
  return jpegToPdf(jpeg, pageW, pageH);
}
