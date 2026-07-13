/**
 * Shared tag extraction from slide text — port of extract_csv.py field/tag helpers.
 */

import {
  HEADER_FIELDS,
  VALID_QUESTION_ROLES,
  SECTION_TITLE_TARGET_RGB,
} from '../shared/constants.js';
import {
  isThankYouTitle,
  normalizeQuestionIdBase,
  standardizedThankYouTitle,
} from '../shared/sessionCsv.js';

const ARABIC_RE = /[\u0600-\u06FF]/;
const SCIENCE_KEYWORDS = ['علوم', 'فيزياء', 'كيمياء', 'أحياء'];
const MATH_ICT_KEYWORDS = ['رياضيات', 'إحصاء', 'تكنولوجيا'];

/** Strip leading/trailing "!" (Python str.strip('!')). */
export function stripExclamationMarks(text) {
  return String(text).replace(/^!+/, '').replace(/!+$/, '');
}

export function isThankYouSlide(slideTitle) {
  return isThankYouTitle(slideTitle);
}

export function getStandardizedThankYouTitle(slideTitle, language = 'en') {
  return standardizedThankYouTitle(language, slideTitle);
}

export function getNumeralConvention(subject, grade) {
  if (!ARABIC_RE.test(subject)) {
    return 'european';
  }

  const isScience = SCIENCE_KEYWORDS.some((kw) => subject.includes(kw));
  const isMathIct = MATH_ICT_KEYWORDS.some((kw) => subject.includes(kw));

  if (isScience) {
    return grade >= 4 ? 'european' : 'arabic';
  }
  if (isMathIct) {
    return grade >= 4 && grade <= 9 ? 'european' : 'arabic';
  }
  return 'arabic';
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} text
 * @param {string} field
 * @param {number} slideNumber
 * @param {string[]} allFields
 * @param {(msg: string) => void} [warn]
 * @param {string[]} [validationErrors]
 */
export function extractFieldValue(text, field, slideNumber, allFields, warn = () => {}, validationErrors = null) {
  const fieldProbable = field.replace(/_/g, ' ');

  const processedText = text.replace(/[:=]\s*(\r\n|\n|\r)+\s*/gi, ': ');

  let otherFields = allFields.filter((f) => f !== field);
  if (field === 'question_placement') {
    otherFields = otherFields.filter((f) => f !== 'homework');
  }

  const terminatorsBase = [
    ...otherFields,
    ...otherFields.map((f) => f.replace(/_/g, ' ')),
    'checkpoint',
  ].sort((a, b) => b.length - a.length);

  const terminatorPattern = terminatorsBase
    .map((t) => `\\b${escapeRegex(t)}\\b\\s*[:=]`)
    .join('|');

  const pattern = new RegExp(
    `\\b(?:${escapeRegex(field)}|${escapeRegex(fieldProbable)})\\b\\s*[:=]\\s*(.*?)(?=\\s*(?:${terminatorPattern})|$)`,
    'is',
  );

  let v = '';
  const match = processedText.match(pattern);
  if (match) {
    v = match[1].trim();
  }
  if (!v) return '';

  if (field === 'question_id') {
    v = v.replace(/\s*checkpoint\s*$/i, '').trim();
    const base = normalizeQuestionIdBase(v);
    return base || '';
  }

  if (field === 'homework') {
    const allowed = ['true', 'false'];
    if (!allowed.includes(v.toLowerCase())) {
      warn(`  [Warning on Slide ${slideNumber}] Invalid value for 'homework': '${v}'. Must be 'true' or 'false'. Ignoring.`);
      return '';
    }
    v = v.toLowerCase();
  }

  if (field === 'question_placement') {
    const originalV = v;
    let normV = v.toLowerCase().trim();
    if (normV === 'hw') normV = 'homework';

    const allowedPlacements = ['live', 'ai', 'homework', 'not_homework'];
    if (allowedPlacements.includes(normV)) {
      v = normV;
    } else {
      const corePlacements = ['not_homework', 'live', 'ai', 'homework'];
      let corrected = '';
      for (const placement of corePlacements) {
        if (normV.includes(placement)) {
          corrected = placement;
          warn(`  [Info on Slide ${slideNumber}] Corrected 'question_placement' from '${originalV}' to '${corrected}'.`);
          break;
        }
      }
      if (corrected) {
        v = corrected;
      } else {
        warn(`  [Warning on Slide ${slideNumber}] Invalid value for 'question_placement': '${originalV}'. Ignoring.`);
        return '';
      }
    }
  }

  if (field === 'slide_id') {
    if (v.replace(/[()]/g, '').toLowerCase() === 'new') {
      v = 'new';
    }
  }

  const normMatch = v.match(/^(\d{12})\s+\.\s+(\d{1,2})$/);
  if (field !== 'question_id' && normMatch) {
    v = `${normMatch[1]}.${normMatch[2]}`;
  }

  if (field === 'question_role') {
    v = v.toLowerCase().trim().replace(/ /g, '_');
    if (v && !VALID_QUESTION_ROLES.includes(v)) {
      const msg = `Slide ${slideNumber}: invalid question_role '${v}'`;
      if (validationErrors) {
        validationErrors.push(msg);
      } else {
        warn(`  [Error on Slide ${slideNumber}] Invalid value for 'question_role': '${v}'.`);
      }
      return '';
    }
  }

  return v;
}

export function findVerbatimMultipartTags(text) {
  const re = /\bverbatim[_ ](\d+)\b\s*[:=]/gi;
  const seen = new Map();
  let m;
  while ((m = re.exec(text)) !== null) {
    const numInt = parseInt(m[1], 10);
    if (!seen.has(numInt)) {
      seen.set(numInt, `verbatim_${numInt}`);
    }
  }
  return [...seen.keys()].sort((a, b) => a - b).map((k) => seen.get(k));
}

export function findTagOccurrences(text, tags) {
  const counts = {};
  for (const tag of tags) {
    const tagProbable = tag.replace(/_/g, ' ');
    const pattern = tag === tagProbable
      ? new RegExp(`\\b${escapeRegex(tag)}\\b\\s*[:=]`, 'gi')
      : new RegExp(`\\b(?:${escapeRegex(tag)}|${escapeRegex(tagProbable)})\\b\\s*[:=]`, 'gi');
    const matches = text.match(pattern);
    if (matches && matches.length > 0) {
      counts[tag] = matches.length;
    }
  }
  return counts;
}

export function findVerbatimNOccurrences(text) {
  const re = /\bverbatim[_ ](\d+)\b\s*[:=]/gi;
  const counts = {};
  let m;
  while ((m = re.exec(text)) !== null) {
    const tag = `verbatim_${parseInt(m[1], 10)}`;
    counts[tag] = (counts[tag] || 0) + 1;
  }
  return counts;
}

export function extractVerbatimMultipart(collectedTexts, slideNumber, allKnownFields, warn) {
  const combinedText = collectedTexts.join(' ');
  const verbatimNTags = findVerbatimMultipartTags(combinedText);
  if (verbatimNTags.length === 0) return ['', ''];

  const values = {};
  for (const tag of verbatimNTags) {
    for (const textBlock of collectedTexts) {
      const val = extractFieldValue(textBlock, tag, slideNumber, allKnownFields, warn);
      if (val && !(tag in values)) {
        values[tag] = val;
      }
    }
  }

  if (Object.keys(values).length === 0) return ['', ''];

  const sortedTags = Object.keys(values).sort(
    (a, b) => parseInt(a.split('_')[1], 10) - parseInt(b.split('_')[1], 10),
  );
  const valuesStr = sortedTags.map((t) => values[t]).join(' | ');
  const numbersStr = sortedTags.map((t) => String(parseInt(t.split('_')[1], 10))).join(' | ');
  return [valuesStr, numbersStr];
}

export function extractInfoFromSlide(slideText, slideNumber, fieldsToExtract, allKnownFields, warn, validationErrors = null) {
  const res = {};
  for (const f of fieldsToExtract) {
    res[f] = extractFieldValue(
      slideText, f, slideNumber, allKnownFields, warn, validationErrors,
    );
  }

  const exceptions = new Set([
    'section_title', 'section_gp', 'verbatim', 'verbatim_listening', 'verbatim_multipart',
    'slide_title', 'section_type', 'ar_section_type', 'en_section_type', 'video_title', ...HEADER_FIELDS,
  ]);

  for (const [key, value] of Object.entries(res)) {
    if (!exceptions.has(key) && typeof value === 'string') {
      res[key] = value.toLowerCase();
    }
  }
  return res;
}

export function validationErrorSlideNumber(message) {
  const match = message.match(/^Slide (\d+):/);
  return match ? parseInt(match[1], 10) : 0;
}

export function languageFromPresentationFilename(filePath) {
  throw new Error(
    'languageFromPresentationFilename is deprecated; use requireLanguageFromReportRow() with metasession API data instead',
  );
}

export function detectNewMode(slideTexts) {
  const combinedText = slideTexts.join(' ');
  const foundHeaderFields = [];

  for (const field of HEADER_FIELDS) {
    const fieldProbable = field.replace(/_/g, ' ');
    const pattern = new RegExp(
      `\\b(?:${escapeRegex(field)}|${escapeRegex(fieldProbable)})\\b\\s*[:=]`,
      'i',
    );
    if (pattern.test(combinedText)) {
      foundHeaderFields.push(field);
    }
  }

  return foundHeaderFields.length === 1 && foundHeaderFields[0] === 'metasession_id';
}

/**
 * Extract section title from a shape with solid fill RGB (0, 114, 180).
 * @param {{ shapes: Array<{ hasTextFrame: boolean, text: string, fillRgb: number[]|null }> }} slide
 */
export function extractSectionTitle(slide) {
  const [tr, tg, tb] = SECTION_TITLE_TARGET_RGB;
  for (const shape of slide.shapes) {
    if (!shape.hasTextFrame) continue;
    if (!shape.fillRgb) continue;
    const [r, g, b] = shape.fillRgb;
    if (r === tr && g === tg && b === tb) {
      return (shape.text || '').trim();
    }
  }
  return '';
}

export function collectSlideTexts(slide) {
  const collectedTexts = [];
  const titleShape = slide.titleShape;
  const titleShapeId = titleShape ? titleShape.shapeId : null;

  if (titleShape && titleShape.hasTextFrame) {
    const txt = (titleShape.text || '').trim();
    if (txt) collectedTexts.push(txt);
  }

  for (const shape of slide.shapes) {
    if (titleShapeId != null && shape.shapeId === titleShapeId) continue;
    if (!shape.hasTextFrame) continue;
    const txt = (shape.text || '').trim();
    if (txt) collectedTexts.push(txt);
  }

  return collectedTexts;
}
