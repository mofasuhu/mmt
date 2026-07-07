/**
 * Bilingual merged CSV extraction — JavaScript port of extract_csv_merged.py
 */

import {
  QUESTIONS_METADATA_API_URL,
  QUESTIONS_METADATA_API_MAX_RETRIES,
  QUESTIONS_METADATA_API_RETRY_DELAY_SEC,
  QUESTIONS_METADATA_API_TIMEOUT_SEC,
  SHEETS_SPREADSHEET_ID,
  SHEETS_TEMP_TAB_NAME,
  REQUIRED_SECTION_TITLES_FOR_QID,
} from '../shared/constants.js';
import {
  tocTitleForLanguage,
  validatePptxSlide1MergedMetasessionIds,
  validatePptxSlide2Toc,
  isTwelveDigitId,
  isSectionId,
  isRecapTitle,
  sectionIdValidationError,
  validateSessionSectionCoverage,
  validateSectionTitlesFromCsv,
  normalizeSectionId,
  splitMergedPptxBasename,
  csvCellStr,
  rowHasPrimaryId,
  rowRequiresEmptySlideId,
  isSlideOrMediaId,
  clearSlideIdForMediaRow,
  parseCsvText,
  rowsToCsv,
  validatePracticeQuestionTypesFromRows,
  processQuestionIdsFromApi,
  validateSectionTypesForMetasessionType,
  normalizeVideoThumbnailTs,
  isInstructionalInSectionSlide,
} from '../shared/sessionCsv.js';
import { getMetasessionReportRow, getRawMetasessionData } from '../shared/metasessionApi.js';
import { validatePptxNameAgainstApi } from '../shared/pptxNameValidator.js';
import { openPresentationFromVfs } from '../pptx/openPresentation.js';
import { getNumeralConvention, collectSlideTexts, stripExclamationMarks } from '../pptx/tagParser.js';
import { buildCsvOutcomes, ValidationAbort } from './extractCsv.js';

const QUESTION_ID_PATTERN = /^\d{12}(\.\d+)?$/;
const ARABIC_RE = /[\u0600-\u06FF]/;

const LEGACY_MERGED_FIELDS = [
  'ar_slide_id', 'en_slide_id',
  'ar_slide_title', 'en_slide_title',
  'en_section_id', 'ar_section_id',
  'ar_section_gp', 'en_section_gp',
  'ar_video_id', 'en_video_id',
  'ar_video_title', 'en_video_title',
  'ar_timestamp', 'en_timestamp', 'timestamp',
  'question_id', 'question_placement',
  'required_correct', 'attempt_window', 'homework',
  'activity_id',
  'ar_verbatim', 'en_verbatim',
  'en_metasession_id', 'ar_metasession_id',
  'en_metasession_number', 'ar_metasession_number',
  'en_metasession_type', 'ar_metasession_type',
  'en_grade', 'ar_grade',
  'en_term', 'ar_term',
  'en_subject', 'ar_subject',
  'en_language', 'ar_language',
  'en_country', 'ar_country',
  'en_numerals', 'ar_numerals',
  'en_duration', 'ar_duration',
];

const NEW_MODE_MERGED_FIELDS = [
  'ar_slide_id', 'en_slide_id',
  'ar_slide_title', 'en_slide_title',
  'en_section_id', 'ar_section_id',
  'ar_section_title', 'en_section_title',
  'ar_section_gp', 'en_section_gp',
  'ar_video_id', 'en_video_id',
  'ar_video_title', 'en_video_title',
  'ar_timestamp', 'en_timestamp', 'timestamp',
  'video_title',
  'question_id', 'question_role',
  'required_correct', 'attempt_window', 'homework',
  'activity_id',
  'ar_verbatim', 'en_verbatim',
  'en_metasession_id', 'ar_metasession_id',
  'section_type',
];

const LEGACY_META_FIELDS = [
  'ar_metasession_number', 'en_metasession_number',
  'ar_metasession_type', 'en_metasession_type',
  'ar_grade', 'en_grade',
  'ar_term', 'en_term',
  'ar_subject', 'en_subject',
  'ar_duration', 'en_duration',
];

const SECTION_TITLE_TAGS = new Set(['ar_section_title', 'en_section_title']);
const SECTION_ID_TAGS = new Set(['ar_section_id', 'en_section_id']);

const META_COLUMNS = [
  'metasession_id', 'metasession_number', 'metasession_type',
  'grade', 'term', 'subject', 'language', 'country',
  'numerals', 'duration',
];

const BASE_COLUMNS = [
  'slide_number', 'slide_id', 'section_id', 'section_title', 'question_id',
  'question_placement', 'required_correct', 'attempt_window', 'homework',
  'section_gp', 'video_id', 'video_thumbnail_ts', 'activity_id', 'verbatim',
];

const NEW_MODE_COLUMNS = [
  ...BASE_COLUMNS,
  'metasession_id', 'numerals', 'slide_purpose', 'question_role', 'section_type',
];

const BASE_AR_KEYS = [
  'slide_number', 'ar_slide_id', 'ar_section_id', 'ar_slide_title', 'question_id',
  'question_placement', 'required_correct', 'attempt_window', 'homework',
  'ar_section_gp', 'ar_video_id', 'activity_id', 'ar_verbatim',
];

const BASE_EN_KEYS = [
  'slide_number', 'en_slide_id', 'en_section_id', 'en_slide_title', 'question_id',
  'question_placement', 'required_correct', 'attempt_window', 'homework',
  'en_section_gp', 'en_video_id', 'activity_id', 'en_verbatim',
];

export class PipelineAbortError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'PipelineAbortError';
    this.errors = errors;
  }
}

function sleep(sec) {
  return new Promise((resolve) => setTimeout(resolve, sec * 1000));
}

function basename(filePath) {
  return filePath.split(/[/\\]/).pop();
}

function stemName(filename) {
  return filename.replace(/\.[^.]+$/, '');
}

function joinPath(...parts) {
  return parts.filter(Boolean).join('/').replace(/\/+/g, '/');
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function localName(el) {
  if (!el) return '';
  return el.localName || String(el.tagName || '').split(':').pop();
}

function findDescendant(node, name) {
  if (!node) return null;
  const stack = [node];
  while (stack.length) {
    const cur = stack.pop();
    if (localName(cur) === name) return cur;
    for (let i = cur.childNodes.length - 1; i >= 0; i -= 1) {
      stack.push(cur.childNodes[i]);
    }
  }
  return null;
}

function collectTextFromTxBody(txBody) {
  if (!txBody) return '';

  const paragraphs = [];
  const walk = (node) => {
    if (!node) return;
    if (localName(node) === 'p') {
      const parts = [];
      const collectRuns = (n) => {
        if (!n) return;
        if (localName(n) === 'br') {
          parts.push('\n');
          return;
        }
        if (localName(n) === 't') {
          parts.push(n.textContent || '');
          return;
        }
        for (const child of n.childNodes) {
          collectRuns(child);
        }
      };
      collectRuns(node);
      paragraphs.push(parts.join(''));
      return;
    }
    for (const child of node.childNodes) {
      walk(child);
    }
  };

  walk(txBody);

  if (paragraphs.length === 0) {
    const parts = [];
    for (const el of txBody.getElementsByTagName('*')) {
      if (localName(el) === 't') parts.push(el.textContent || '');
    }
    return parts.join('');
  }

  return paragraphs.join('\n');
}

function normalizeQuestionPlacement(rawValue, slideNumber, warn) {
  if (!rawValue) return '';
  let normalized = rawValue.toLowerCase().trim();
  if (normalized === 'hw') normalized = 'homework';
  const validPlacements = ['live', 'ai', 'homework', 'not_homework'];
  if (validPlacements.includes(normalized)) return normalized;
  if (normalized.includes('not_homework')) return 'not_homework';
  if (normalized.includes('homework')) return 'homework';
  if (normalized.includes('live')) return 'live';
  if (normalized.includes('ai')) return 'ai';
  warn(`Warning (Slide ${slideNumber}): Invalid question_placement '${rawValue}' found. Clearing field.`);
  return '';
}

function extractMergedFieldValue(text, fieldToFind, allPossibleFields) {
  let normalized = text.replace(/\x0b/g, '\n').replace(/\r/g, '\n');
  const otherFields = allPossibleFields.filter(
    (f) => f.toLowerCase() !== fieldToFind.toLowerCase(),
  );
  const nextFieldPattern = otherFields.map(escapeRegex).join('|');
  let pattern;
  if (fieldToFind.toLowerCase().includes('verbatim')) {
    pattern = new RegExp(
      `^\\s*${escapeRegex(fieldToFind)}\\s*[:=]\\s*\\{(.*?)\\}`,
      'ims',
    );
  } else {
    pattern = new RegExp(
      `^\\s*${escapeRegex(fieldToFind)}\\s*[:=]\\s*(.*?)(?=^\\s*(?:${nextFieldPattern})\\s*[:=]|$)`,
      'ims',
    );
  }
  const match = normalized.match(pattern);
  return match ? match[1].trim() : '';
}

function findMergedTagOccurrences(text, tags) {
  const normalized = text.replace(/\x0b/g, '\n').replace(/\r/g, '\n');
  const counts = {};
  for (const tag of tags) {
    const pattern = new RegExp(`^\\s*${escapeRegex(tag)}\\s*[:=]`, 'gim');
    const matches = normalized.match(pattern);
    if (matches && matches.length > 0) counts[tag] = matches.length;
  }
  return counts;
}

function extractPurposeFromNotes(notesText) {
  if (!notesText) return ['', ''];
  const enPattern = /en_tn.*?(?:purpose|slide_purpose)\s*[:=]\s*(.*?)(?=\s*ar_tn|$)/is;
  const arPattern = /ar_tn.*?(?:purpose|slide_purpose)\s*[:=]\s*(.*)/is;
  const enMatch = notesText.match(enPattern);
  const arMatch = notesText.match(arPattern);
  return [
    enMatch ? enMatch[1].trim() : '',
    arMatch ? arMatch[1].trim() : '',
  ];
}

function pptxLanguageStems(pptxFilename) {
  return splitMergedPptxBasename(basename(pptxFilename));
}

function isThankYouSlideMerged(slideData) {
  const enTitle = stripExclamationMarks((slideData.en_slide_title || '').trim().toLowerCase());
  const arTitle = stripExclamationMarks((slideData.ar_slide_title || '').trim());
  const arNormalized = arTitle.replace(/ً/g, '');
  return enTitle === 'thank you' && arNormalized === 'شكرا جزيلا';
}

function videoThumbnailTsForSlide(slide, lang) {
  const raw = lang === 'ar'
    ? (slide.ar_timestamp || '').trim() || (slide.timestamp || '').trim()
    : (slide.en_timestamp || '').trim() || (slide.timestamp || '').trim();
  return normalizeVideoThumbnailTs(raw);
}

function applyVideoSlideTitles(slide) {
  const bareTitle = (slide.video_title || '').trim();
  const arVid = (slide.ar_video_id || '').trim();
  const enVid = (slide.en_video_id || '').trim();
  if (!arVid && !enVid) return;
  const arVt = (slide.ar_video_title || '').trim() || bareTitle;
  const enVt = (slide.en_video_title || '').trim() || bareTitle;
  if (arVid) slide.ar_slide_title = arVt || 'فيديو';
  if (enVid) slide.en_slide_title = enVt || 'Video';
}

function rowWithVideoThumbnailTs(slide, keys, lang) {
  const row = keys.map((key) => slide[key] ?? '');
  const videoKey = lang === 'ar' ? 'ar_video_id' : 'en_video_id';
  const videoIndex = keys.indexOf(videoKey);
  if (videoIndex >= 0) {
    row.splice(videoIndex + 1, 0, videoThumbnailTsForSlide(slide, lang));
  }
  return row;
}

function mergedSyntheticTocRow(baseKeys, lang) {
  const slideIdKey = `${lang}_slide_id`;
  const slideTitleKey = `${lang}_slide_title`;
  const slide = {
    slide_number: 2,
    [slideIdKey]: 'new',
    [`${lang}_section_id`]: '',
    [slideTitleKey]: tocTitleForLanguage(lang),
  };
  const row = rowWithVideoThumbnailTs(slide, baseKeys, lang);
  row[0] = 2;
  row.push('', '', '', '', '');
  return row;
}

function propagateBilingualSectionIds(slides) {
  for (const idKey of ['ar_section_id', 'en_section_id']) {
    let currentId = '';
    for (const slide of slides) {
      const sid = (slide[idKey] || '').trim();
      if (sid) currentId = sid;
      else if (currentId) slide[idKey] = currentId;
    }
  }
}

function detectExtractionMode(firstSlideData) {
  const hasMetaId = Boolean(
    (firstSlideData.ar_metasession_id || '').trim()
    || (firstSlideData.en_metasession_id || '').trim(),
  );
  const hasLegacyFields = LEGACY_META_FIELDS.some(
    (field) => (firstSlideData[field] || '').trim(),
  );
  return hasMetaId && !hasLegacyFields ? 'new_mode' : 'legacy_mode';
}

function extractInfoFromSlideLegacy(slideText, slideNumber, warn) {
  const res = {};
  for (const f of LEGACY_MERGED_FIELDS) {
    res[f] = extractMergedFieldValue(slideText, f, LEGACY_MERGED_FIELDS);
  }
  if (res.question_id) {
    res.question_id = res.question_id.replace(/checkpoint/gi, '').trim();
  }
  res.question_placement = normalizeQuestionPlacement(
    res.question_placement || '', slideNumber, warn,
  );
  return res;
}

function extractInfoFromSlideNewMode(slideText, slideNumber) {
  const terminators = slideNumber === 1
    ? [...NEW_MODE_MERGED_FIELDS, 'metasession_id']
    : NEW_MODE_MERGED_FIELDS;
  const res = {};
  for (const f of NEW_MODE_MERGED_FIELDS) {
    res[f] = extractMergedFieldValue(slideText, f, terminators);
  }
  if (res.question_id) {
    res.question_id = res.question_id.replace(/checkpoint/gi, '').trim();
  }

  const bareSlideId = extractMergedFieldValue(slideText, 'slide_id', terminators);
  if (bareSlideId) {
    const cleaned = bareSlideId.replace(/[()]/g, '').trim();
    if (!res.ar_slide_id) res.ar_slide_id = cleaned;
    if (!res.en_slide_id) res.en_slide_id = cleaned;
  }
  const bareVideoId = extractMergedFieldValue(slideText, 'video_id', terminators);
  if (bareVideoId) {
    if (!res.ar_video_id) res.ar_video_id = bareVideoId;
    if (!res.en_video_id) res.en_video_id = bareVideoId;
  }
  const bareTs = extractMergedFieldValue(slideText, 'timestamp', terminators);
  if (bareTs) {
    if (!res.ar_timestamp) res.ar_timestamp = bareTs;
    if (!res.en_timestamp) res.en_timestamp = bareTs;
  }
  const bareVtitle = extractMergedFieldValue(slideText, 'video_title', terminators);
  if (bareVtitle) {
    if (!res.ar_video_title) res.ar_video_title = bareVtitle;
    if (!res.en_video_title) res.en_video_title = bareVtitle;
    if (!res.video_title) res.video_title = bareVtitle;
  }
  if (res.question_role) {
    res.question_role = res.question_role.toLowerCase().trim();
  }
  return res;
}

async function resolveSlidePathsFromZip(zip) {
  const presXml = await zip.file('ppt/presentation.xml')?.async('string');
  const relsXml = await zip.file('ppt/_rels/presentation.xml.rels')?.async('string');
  if (!presXml || !relsXml) return [];

  const presDoc = new DOMParser().parseFromString(presXml, 'application/xml');
  const relsDoc = new DOMParser().parseFromString(relsXml, 'application/xml');
  const relMap = new Map();
  for (const rel of relsDoc.getElementsByTagName('*')) {
    if (localName(rel) !== 'Relationship') continue;
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    if (id && target) relMap.set(id, target);
  }

  function relationshipId(el) {
    for (const attr of el.attributes || []) {
      if (attr.localName === 'id' && (attr.prefix === 'r' || attr.name === 'r:id')) {
        return attr.value;
      }
    }
    return el.getAttribute('r:id')
      || el.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
  }

  function resolveTarget(target) {
    const t = (target || '').replace(/^\.\//, '');
    if (t.startsWith('ppt/')) return t;
    if (t.startsWith('slides/')) return `ppt/${t}`;
    return `ppt/slides/${t}`;
  }

  const slidePaths = [];
  for (const sldId of presDoc.getElementsByTagName('*')) {
    if (localName(sldId) !== 'sldId') continue;
    const rId = relationshipId(sldId);
    if (rId && relMap.has(rId)) slidePaths.push(resolveTarget(relMap.get(rId)));
  }
  return slidePaths;
}

async function readSlideNotesFromZip(zip, slidePath) {
  const relsPath = slidePath
    .replace('ppt/slides/', 'ppt/slides/_rels/')
    .replace(/\.xml$/, '.xml.rels');
  const relsXml = await zip.file(relsPath)?.async('string');
  if (!relsXml) return '';

  const relsDoc = new DOMParser().parseFromString(relsXml, 'application/xml');
  let notesTarget = null;
  for (const rel of relsDoc.getElementsByTagName('*')) {
    if (localName(rel) !== 'Relationship') continue;
    const type = rel.getAttribute('Type') || '';
    if (type.includes('notesSlide')) {
      notesTarget = rel.getAttribute('Target');
      break;
    }
  }
  if (!notesTarget) return '';

  const slideDir = slidePath.slice(0, slidePath.lastIndexOf('/') + 1);
  const notesPath = notesTarget.startsWith('../')
    ? `ppt/${notesTarget.replace(/^\.\.\//, '')}`
    : `${slideDir}${notesTarget.replace(/^\.\//, '')}`;

  const notesXml = await zip.file(notesPath)?.async('string');
  if (!notesXml) return '';
  const doc = new DOMParser().parseFromString(notesXml, 'application/xml');
  return collectTextFromTxBody(findDescendant(doc.documentElement, 'txBody'));
}

async function loadSlideNotesTexts(vfs, filePath, options = {}) {
  const JSZip = options.JSZip || globalThis.JSZip;
  if (!JSZip) return [];
  const data = await vfs.read(filePath, { binary: true });
  const zip = await JSZip.loadAsync(data);
  const slidePaths = await resolveSlidePathsFromZip(zip);
  const notesTexts = [];
  for (const slidePath of slidePaths) {
    notesTexts.push(await readSlideNotesFromZip(zip, slidePath));
  }
  return notesTexts;
}

function joinSlideTexts(collectedTexts) {
  return collectedTexts.join('\n\n');
}

async function processPresentationLegacy(vfs, filePath, log, options) {
  const warn = (msg) => log(msg);
  try {
    const prs = await openPresentationFromVfs(vfs, filePath, options);
    const notesTexts = await loadSlideNotesTexts(vfs, filePath, options);
    const extractedData = [];

    for (let i = 0; i < prs.slides.length; i += 1) {
      const slide = prs.slides[i];
      const slideNumber = i + 1;
      const collectedTexts = collectSlideTexts(slide);
      const fullSlideText = joinSlideTexts(collectedTexts);
      const notesText = notesTexts[i] || '';

      const slideData = extractInfoFromSlideLegacy(fullSlideText, slideNumber, warn);
      const [enPurpose, arPurpose] = extractPurposeFromNotes(notesText);
      slideData.en_slide_purpose = enPurpose;
      slideData.ar_slide_purpose = arPurpose;
      slideData.slide_number = slideNumber;
      extractedData.push(slideData);
    }

    for (const currentSlide of extractedData) {
      const isArTitleEmpty = !(currentSlide.ar_slide_title || '').trim();
      const isEnTitleEmpty = !(currentSlide.en_slide_title || '').trim();
      const isPlacementEmpty = !(currentSlide.question_placement || '').trim();
      if (isArTitleEmpty && isPlacementEmpty) currentSlide.ar_slide_title = 'سؤال';
      if (isEnTitleEmpty && isPlacementEmpty) currentSlide.en_slide_title = 'Question';
    }

    return extractedData;
  } catch (e) {
    log(`Could not process file ${basename(filePath)}. Error: ${e.message}`);
    console.error(e);
    return null;
  }
}

async function processPresentationNewMode(vfs, filePath, log, options) {
  const rawSlides = [];
  let thankYouRawIndex = null;
  let thankYouPptSlideNumber = null;
  const validationErrorsBySlide = [];
  const warn = (msg) => log(msg);

  try {
    const prs = await openPresentationFromVfs(vfs, filePath, options);
    const notesTexts = await loadSlideNotesTexts(vfs, filePath, options);

    for (let i = 0; i < prs.slides.length; i += 1) {
      const slide = prs.slides[i];
      const slideNumber = i + 1;
      const collectedTexts = collectSlideTexts(slide);
      const fullSlideText = joinSlideTexts(collectedTexts);

      const tagCounts = findMergedTagOccurrences(fullSlideText, NEW_MODE_MERGED_FIELDS);
      for (const [tag, count] of Object.entries(tagCounts).sort(([a], [b]) => a.localeCompare(b))) {
        if (count > 1) {
          validationErrorsBySlide.push([
            slideNumber,
            `Slide ${slideNumber}: tag '${tag}' is duplicated (${count} occurrences). `
            + 'Each tag must appear only once per slide.',
          ]);
        }
      }

      const sectionTitlePresent = [...SECTION_TITLE_TAGS].some((t) => t in tagCounts);
      if (sectionTitlePresent) {
        const allowedCompanions = new Set([
          ...SECTION_TITLE_TAGS,
          ...SECTION_ID_TAGS,
          'section_type',
        ]);
        if (slideNumber === 1) {
          allowedCompanions.add('ar_metasession_id');
          allowedCompanions.add('en_metasession_id');
        }
        const disallowed = Object.keys(tagCounts)
          .filter((t) => !allowedCompanions.has(t))
          .sort();
        if (disallowed.length > 0) {
          validationErrorsBySlide.push([
            slideNumber,
            `Slide ${slideNumber}: placeholder slide (with section_title tag) `
            + `must not contain other tags. Also found: ${disallowed.join(', ')}.`,
          ]);
        }
      }

      const notesText = notesTexts[i] || '';
      const slideData = extractInfoFromSlideNewMode(fullSlideText, slideNumber);
      const [enPurpose, arPurpose] = extractPurposeFromNotes(notesText);
      slideData.en_slide_purpose = enPurpose;
      slideData.ar_slide_purpose = arPurpose;
      slideData.slide_number = slideNumber;

      if (slideNumber === 1) {
        for (const metaErr of validatePptxSlide1MergedMetasessionIds(
          `Slide ${slideNumber}`,
          slideData.ar_metasession_id,
          slideData.en_metasession_id,
        )) {
          validationErrorsBySlide.push([slideNumber, metaErr]);
        }
      }

      if (slideNumber === 2) {
        const tocErr = validatePptxSlide2Toc(`Slide ${slideNumber}`, fullSlideText);
        if (tocErr) validationErrorsBySlide.push([slideNumber, tocErr]);
        log(
          `   [Slide ${slideNumber}] TOC slide `
          + `(${slideData.ar_slide_title || slideData.en_slide_title || 'no slide_title tag'}) `
          + '— skipped (synthetic toc row).',
        );
        continue;
      }

      rawSlides.push(slideData);

      if (thankYouRawIndex === null && isThankYouSlideMerged(slideData)) {
        thankYouRawIndex = rawSlides.length - 1;
        thankYouPptSlideNumber = slideNumber;
        log(`   Found 'Thank You' slide at slide ${slideNumber}. Slides after this will be ignored.`);
      }
    }

    if (prs.slides.length < 2) {
      validationErrorsBySlide.push([
        2,
        'Slide 2 must be the Table of Contents slide; presentation has fewer than 2 slides.',
      ]);
    }

    let thankYouFound = thankYouRawIndex !== null;
    if (thankYouFound) {
      rawSlides.splice(thankYouRawIndex + 1);
      const thankYouSlide = rawSlides[rawSlides.length - 1];
      thankYouSlide.en_slide_title = 'Thank You!';
      thankYouSlide.ar_slide_title = 'شكرًا جزيلًا';
      thankYouSlide.en_slide_id = 'new';
      thankYouSlide.ar_slide_id = 'new';
      thankYouSlide.en_section_id = '';
      thankYouSlide.ar_section_id = '';
    }

    const maxSlideInclusive = thankYouFound ? thankYouPptSlideNumber : Infinity;
    const slideValidationErrors = validationErrorsBySlide
      .filter(([sn]) => sn <= maxSlideInclusive)
      .map(([, msg]) => msg);
    const sectionIdValidationErrors = [];

    let currentArSection = '';
    let currentEnSection = '';
    let currentArSectionId = '';
    let currentEnSectionId = '';
    let currentSectionType = '';
    let sectionTypeUsed = false;
    let previousWasCheckpoint = false;
    let postQuestionSectionActive = false;

    let defaultRequiredCorrect = '3';
    let defaultAttemptWindow = '5';
    for (const slide of rawSlides) {
      if (slide.question_role === 'checkpoint') {
        if (slide.required_correct) defaultRequiredCorrect = slide.required_correct;
        if (slide.attempt_window) defaultAttemptWindow = slide.attempt_window;
        break;
      }
    }

    let lastQuestionRawIndex = -1;
    for (let idx = 0; idx < rawSlides.length; idx += 1) {
      if ((rawSlides[idx].question_id || '').trim()) lastQuestionRawIndex = idx;
    }

    const processedSlides = [];
    for (let slideIdx = 0; slideIdx < rawSlides.length; slideIdx += 1) {
      const slide = { ...rawSlides[slideIdx] };
      const hasArSectionTitle = Boolean((slide.ar_section_title || '').trim());
      const hasEnSectionTitle = Boolean((slide.en_section_title || '').trim());
      const isPlaceholder = hasArSectionTitle || hasEnSectionTitle;

      if (isPlaceholder) {
        const slideNumber = slide.slide_number || slideIdx + 1;
        if (hasArSectionTitle) {
          const err = sectionIdValidationError(
            `Slide ${slideNumber}`,
            slide.ar_section_id,
            { fieldName: 'ar_section_id' },
          );
          if (err) sectionIdValidationErrors.push(err);
        }
        if (hasEnSectionTitle) {
          const err = sectionIdValidationError(
            `Slide ${slideNumber}`,
            slide.en_section_id,
            { fieldName: 'en_section_id' },
          );
          if (err) sectionIdValidationErrors.push(err);
        }
        if (hasArSectionTitle) currentArSection = slide.ar_section_title;
        if (hasEnSectionTitle) currentEnSection = slide.en_section_title;
        const arSid = (slide.ar_section_id || '').trim();
        const enSid = (slide.en_section_id || '').trim();
        if (isSectionId(arSid)) currentArSectionId = arSid;
        if (isSectionId(enSid)) currentEnSectionId = enSid;
        if (slide.section_type) {
          currentSectionType = slide.section_type;
          sectionTypeUsed = false;
        }
        if (slideIdx > lastQuestionRawIndex) postQuestionSectionActive = true;
        continue;
      }

      const isRecapSlide = isRecapTitle(slide.ar_slide_title || '')
        || isRecapTitle(slide.en_slide_title || '');
      const afterLastQuestion = lastQuestionRawIndex >= 0 && slideIdx > lastQuestionRawIndex;
      let isRootTailSlide = afterLastQuestion && !postQuestionSectionActive;
      if (isThankYouSlideMerged(slide) || isRecapSlide) isRootTailSlide = true;
      if (isRootTailSlide) {
        currentArSection = '';
        currentEnSection = '';
        currentArSectionId = '';
        currentEnSectionId = '';
        currentSectionType = '';
        sectionTypeUsed = true;
      }

      const questionRole = (slide.question_role || '').trim();
      if (questionRole) {
        if (questionRole === 'example') {
          slide.ar_slide_title = 'مثال';
          slide.en_slide_title = 'Example';
        } else if (['interactive_example', 'checkpoint', 'practice'].includes(questionRole)) {
          slide.ar_slide_title = 'سؤال';
          slide.en_slide_title = 'Question';
        }

        if (questionRole === 'checkpoint') {
          slide.question_placement = 'ai';
          if (!previousWasCheckpoint) {
            if (!slide.required_correct) slide.required_correct = defaultRequiredCorrect;
            if (!slide.attempt_window) slide.attempt_window = defaultAttemptWindow;
          } else {
            slide.required_correct = '';
            slide.attempt_window = '';
          }
          previousWasCheckpoint = true;
        } else if (questionRole === 'practice') {
          slide.question_placement = 'homework';
          slide.required_correct = '';
          slide.attempt_window = '';
        } else {
          slide.question_placement = '';
          slide.required_correct = '';
          slide.attempt_window = '';
        }
      } else {
        slide.question_placement = '';
        slide.required_correct = '';
        slide.attempt_window = '';
        previousWasCheckpoint = false;
        if (isInstructionalInSectionSlide(slide, { bilingual: true })) {
          slide.ar_slide_title = currentArSection;
          slide.en_slide_title = currentEnSection;
        }
      }

      const isRecapAfterProp = isRecapTitle(slide.ar_slide_title || '')
        || isRecapTitle(slide.en_slide_title || '');
      if (isRecapAfterProp) {
        isRootTailSlide = true;
        currentArSection = '';
        currentEnSection = '';
        currentArSectionId = '';
        currentEnSectionId = '';
        currentSectionType = '';
        sectionTypeUsed = true;
      }

      if ((slide.ar_video_id || '').trim() || (slide.en_video_id || '').trim()) {
        applyVideoSlideTitles(slide);
      }

      if (isThankYouSlideMerged(slide) || isRootTailSlide) {
        slide.ar_section_id = '';
        slide.en_section_id = '';
      } else {
        const arSid = (slide.ar_section_id || '').trim();
        const enSid = (slide.en_section_id || '').trim();
        if (isSectionId(arSid)) currentArSectionId = arSid;
        else if (currentArSectionId) slide.ar_section_id = currentArSectionId;
        if (isSectionId(enSid)) currentEnSectionId = enSid;
        else if (currentEnSectionId) slide.en_section_id = currentEnSectionId;
      }

      if (currentSectionType && !sectionTypeUsed) {
        slide.section_type = currentSectionType;
        sectionTypeUsed = true;
      } else {
        slide.section_type = '';
      }

      processedSlides.push(slide);
    }

    return {
      processedSlides,
      thankYouFound,
      slideValidationErrors: slideValidationErrors.concat(sectionIdValidationErrors),
    };
  } catch (e) {
    log(`Could not process file ${basename(filePath)}. Error: ${e.message}`);
    console.error(e);
    return null;
  }
}

function validateMetasessionData(pptMetaData, reportMap, langPrefix) {
  const errors = [];
  const numerals = (pptMetaData[`${langPrefix}_numerals`] || '').trim().toLowerCase();
  if (!['arabic', 'european'].includes(numerals)) {
    errors.push(`Invalid numerals value: '${numerals}'. Must be 'Arabic' or 'European'.`);
  }

  const metaId = (pptMetaData[`${langPrefix}_metasession_id`] || '').trim();
  if (!reportMap || !metaId || !(metaId in reportMap)) {
    if (!reportMap) errors.push('Metasession data could not be loaded for validation.');
    else errors.push(`Meta Session Id '${metaId}' not found via API.`);
    return { valid: false, errors };
  }

  const reportRow = reportMap[metaId];
  const checks = {
    metasession_number: 'Meta Session Number',
    language: 'Language',
    grade: 'Grade',
    term: 'Term',
    metasession_type: 'Class Type',
    subject: 'Subject',
    country: 'Country',
  };

  for (const [pptSuffix, reportCol] of Object.entries(checks)) {
    const pptVal = (pptMetaData[`${langPrefix}_${pptSuffix}`] || '').trim().toLowerCase();
    const reportVal = String(reportRow[reportCol] || '').trim().toLowerCase();
    if (!pptVal && !reportVal) continue;
    if (pptVal !== reportVal) {
      errors.push(`Mismatch for ${pptSuffix}: Slide='${pptVal}' vs Report='${reportVal}'`);
    }
  }

  return { valid: errors.length === 0, errors };
}

async function saveToCsv(vfs, csvPath, columns, dataRows, log) {
  await vfs.write(csvPath, rowsToCsv(columns, dataRows));
  log(`   Saved ${basename(csvPath)}.`);
}

async function readCsvFromVfs(vfs, csvPath) {
  const text = await vfs.read(csvPath);
  return parseCsvText(typeof text === 'string' ? text : new TextDecoder().decode(text));
}

function validateCsvFromRows(rows) {
  const validationErrors = [];
  const idLocations = {};
  const requiredSectionTitles = new Set(REQUIRED_SECTION_TITLES_FOR_QID);

  for (const row of rows) {
    const qid = csvCellStr(row.question_id);
    const slideNum = row.slide_number;
    const sectionTitle = csvCellStr(row.section_title);

    if (requiredSectionTitles.has(sectionTitle)) {
      if (!qid) {
        validationErrors.push(
          `Row ${slideNum}: Section title is '${sectionTitle}' but 'question_id' is missing.`,
        );
        continue;
      }
      if (!isTwelveDigitId(qid)) {
        validationErrors.push(
          `Row ${slideNum}: Invalid format for question_id '${qid}'. Must be 12-digit or 12-digit.N.`,
        );
      }
      continue;
    }

    if (!qid) continue;
    if (!isTwelveDigitId(qid)) {
      validationErrors.push(
        `Row ${slideNum}: Invalid format for question_id '${qid}'. Must be 12-digit or 12-digit.N.`,
      );
      continue;
    }
    if (!idLocations[qid]) idLocations[qid] = [];
    idLocations[qid].push(slideNum);
  }

  for (const [qid, slideNums] of Object.entries(idLocations)) {
    if (slideNums.length > 1) {
      validationErrors.push(`Duplicate question_id '${qid}' found on rows: ${slideNums.join(', ')}.`);
    }
  }

  return { valid: validationErrors.length === 0, errors: validationErrors };
}

function validateCsvNewModeFromRows(rows) {
  const validationErrors = [];
  const idLocations = {};
  for (const row of rows) {
    const slideNum = row.slide_number;
    const qid = csvCellStr(row.question_id);
    const slideId = csvCellStr(row.slide_id);
    const videoId = csvCellStr(row.video_id);
    const activityId = csvCellStr(row.activity_id);
    const questionRole = csvCellStr(row.question_role);
    const sectionId = csvCellStr(row.section_id);

    if (sectionId && !isSectionId(sectionId)) {
      validationErrors.push(
        `Row ${slideNum}: Invalid format for section_id '${sectionId}'. `
        + "Must be a 12-digit ID (not 'new').",
      );
    }

    if (qid && !questionRole) {
      validationErrors.push(`Row ${slideNum}: question_id '${qid}' exists but question_role is missing.`);
    }
    if (questionRole && !qid) {
      validationErrors.push(`Row ${slideNum}: question_role '${questionRole}' exists but question_id is missing.`);
    }

    if (qid) {
      if (!isTwelveDigitId(qid)) {
        validationErrors.push(
          `Row ${slideNum}: Invalid format for question_id '${qid}'. Must be 12-digit or 12-digit.N.`,
        );
      } else {
        if (!idLocations[qid]) idLocations[qid] = [];
        idLocations[qid].push(slideNum);
      }
    }

    if (!rowHasPrimaryId({
      slide_id: slideId,
      question_id: qid,
      video_id: videoId,
      activity_id: activityId,
    })) {
      validationErrors.push(
        `Row ${slideNum}: No slide_id, question_id, video_id, or activity_id `
        + "(slide_id may be 12-digit, 12-digit.N, or 'new'; video_id and activity_id must be 12-digit).",
      );
    } else if (slideId && !isSlideOrMediaId(slideId)) {
      validationErrors.push(
        `Row ${slideNum}: Invalid format for slide_id '${slideId}'. Must be 12-digit, 12-digit.N, or 'new'.`,
      );
    }

    if (rowRequiresEmptySlideId({
      question_id: qid,
      video_id: videoId,
      activity_id: activityId,
    }) && slideId) {
      validationErrors.push(
        `Row ${slideNum}: slide_id must be empty when question_id, video_id, or activity_id is set.`,
      );
    }

    if (videoId && !isTwelveDigitId(videoId)) {
      validationErrors.push(
        `Row ${slideNum}: Invalid format for video_id '${videoId}'. Must be a 12-digit ID (not 'new').`,
      );
    }
    if (activityId && !isTwelveDigitId(activityId)) {
      validationErrors.push(
        `Row ${slideNum}: Invalid format for activity_id '${activityId}'. Must be a 12-digit ID (not 'new').`,
      );
    }
  }

  for (const [qid, slideNums] of Object.entries(idLocations)) {
    if (slideNums.length > 1) {
      validationErrors.push(`Duplicate question_id '${qid}' found on rows: ${slideNums.join(', ')}.`);
    }
  }

  validationErrors.push(...validateSessionSectionCoverage(rows));

  return { valid: validationErrors.length === 0, errors: validationErrors };
}

async function fetchQuestionsMetadata(questionIds, log, config = {}) {
  if (!questionIds || questionIds.length === 0) return {};

  const seen = new Set();
  const uniqueIds = [];
  for (const qid of questionIds) {
    if (qid && !seen.has(qid)) {
      seen.add(qid);
      uniqueIds.push(qid);
    }
  }
  if (uniqueIds.length === 0) return {};

  const url = config.questionsMetadataApiUrl || QUESTIONS_METADATA_API_URL;
  const maxRetries = config.questionsMetadataApiMaxRetries ?? QUESTIONS_METADATA_API_MAX_RETRIES;
  const retryDelay = config.questionsMetadataApiRetryDelaySec ?? QUESTIONS_METADATA_API_RETRY_DELAY_SEC;
  const timeoutSec = config.questionsMetadataApiTimeoutSec ?? QUESTIONS_METADATA_API_TIMEOUT_SEC;

  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      log(`   [API] POST ${url} for ${uniqueIds.length} question(s) (attempt ${attempt}/${maxRetries})`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
      const fetchImpl = config.fetchFn || fetch;
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ question_ids: uniqueIds }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      const body = await response.text();
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        log(`   [API Error] ${lastError}`);
      } else {
        const data = JSON.parse(body);
        if (!Array.isArray(data)) {
          lastError = 'API did not return a list';
          log(`   [API Error] ${lastError}: ${JSON.stringify(data)}`);
        } else {
          const metadataById = {};
          for (const item of data) {
            if (item && typeof item === 'object' && item.question_id != null) {
              metadataById[String(item.question_id)] = item;
            }
          }
          return metadataById;
        }
      }
    } catch (e) {
      lastError = e.name === 'AbortError' ? 'TimeoutError' : `${e.name}: ${e.message}`;
      log(`   [API Error] ${lastError}`);
    }

    if (attempt < maxRetries) {
      log(`   [API] Retrying in ${retryDelay}s...`);
      await sleep(retryDelay);
    }
  }

  log(`   [API FATAL] Failed after ${maxRetries} attempts. Last error: ${lastError}`);
  return null;
}

function applyMultipartQuestionId(row, baseId, partIndex) {
  return { ...row, question_id: `${baseId}.${partIndex}`, slide_id: '' };
}

function multipartRowsChanged(originalRows, finalRows) {
  if (originalRows.length !== finalRows.length) return true;
  for (let i = 0; i < originalRows.length; i += 1) {
    if (csvCellStr(originalRows[i].question_id) !== csvCellStr(finalRows[i].question_id)) return true;
    if (csvCellStr(originalRows[i].slide_id) !== csvCellStr(finalRows[i].slide_id)) return true;
  }
  return false;
}

function dedupeRowsByQuestionId(rows) {
  const seen = new Set();
  const deduped = [];
  for (const row of rows) {
    const qid = csvCellStr(row.question_id);
    if (qid && QUESTION_ID_PATTERN.test(qid)) {
      if (seen.has(qid)) continue;
      seen.add(qid);
    }
    deduped.push(row);
  }
  return deduped;
}

async function applyQuestionTypeDuplication(vfs, csvPath, log, config, subject = '') {
  const fetchFn = config.fetchFn || fetch;
  const { headers, rows } = await readCsvFromVfs(vfs, csvPath);
  const [expanded, errors] = await processQuestionIdsFromApi(rows, {
    subject,
    log,
    fetchFn,
  });
  if (errors.length) return errors;

  const changed = expanded.length !== rows.length
    || expanded.some((row, i) =>
      csvCellStr(row.question_id) !== csvCellStr(rows[i]?.question_id)
      || csvCellStr(row.slide_id) !== csvCellStr(rows[i]?.slide_id));

  if (changed) {
    const dataRows = expanded.map((row) => headers.map((col) => row[col] ?? ''));
    await vfs.write(csvPath, rowsToCsv(headers, dataRows));
    if (expanded.length !== rows.length) {
      log(`   [Question ID Expansion] ${rows.length} rows -> ${expanded.length} rows`);
    }
  }
  log('   Applied Question Type duplication.');
  return [];
}

async function applySessionDetailsTranslations(vfs, csvPath, metasessionId, sessionReportMap, log) {
  try {
    const isArabic = csvPath.endsWith('_ar.csv');
    let subject = '';
    let grade = null;

    if (sessionReportMap && metasessionId in sessionReportMap) {
      const reportRow = sessionReportMap[metasessionId];
      subject = csvCellStr(reportRow.Subject);
      const gradeStr = csvCellStr(reportRow.Grade);
      const gradeDigitsMatch = gradeStr.match(/(\d+)\s*$/) || gradeStr.match(/\d+/);
      if (gradeDigitsMatch) {
        grade = parseInt(gradeDigitsMatch[1] || gradeDigitsMatch[0], 10);
        if (Number.isNaN(grade)) grade = null;
      }
    }

    const { headers, rows } = await readCsvFromVfs(vfs, csvPath);
    const reportLanguage = sessionReportMap?.[metasessionId]?.Language || '';
    const csvLanguage = reportLanguage || (isArabic ? 'ar' : 'en');
    let translationCount = 0;

    for (let rowIdx = 0; rowIdx < rows.length; rowIdx += 1) {
      const row = rows[rowIdx];
      const sectionTitle = csvCellStr(row.section_title);
      const slideId = csvCellStr(row.slide_id).toLowerCase();
      const slideNumber = csvCellStr(row.slide_number);

      if (slideNumber === '2') {
        row.section_title = tocTitleForLanguage(csvLanguage);
        row.slide_id = 'new';
        continue;
      }

      if (isArabic) {
        if (sectionTitle.toLowerCase() === 'example') {
          row.section_title = 'مثال';
          translationCount += 1;
        } else if (sectionTitle.toLowerCase() === 'question' && slideId === 'new') {
          row.section_title = 'سؤال';
          translationCount += 1;
        }
      }

      if (rowIdx === 0 && grade != null && subject) {
        row.numerals = getNumeralConvention(subject, grade);
      }
    }

    const dataRows = rows.map((row) => headers.map((col) => row[col] ?? ''));
    await vfs.write(csvPath, rowsToCsv(headers, dataRows));

    if (isArabic && translationCount > 0) {
      log(`   Applied ${translationCount} translation(s) for Arabic CSV.`);
    }
    log('   Applied post-processing (translations and numeral conventions).');
  } catch (e) {
    log(`   [ERROR] Failed to apply post-processing: ${e.message}`);
  }
}

function collectSlideIdRowsFromRows(rows) {
  const rowsOut = [];
  let metasessionId = '';
  const slideIds = [];
  const idPattern = /^\d{12}(\.\d+)?$/;

  for (const row of rows) {
    const mid = csvCellStr(row.metasession_id);
    if (mid && !metasessionId) metasessionId = mid;
    const sid = csvCellStr(row.slide_id);
    if (sid && idPattern.test(sid)) slideIds.push(sid);
  }

  if (!metasessionId) return [];
  for (const sid of slideIds) rowsOut.push([metasessionId, sid]);
  return rowsOut;
}

async function collectSlideIdRowsFromCsv(vfs, csvPath, log) {
  try {
    const { rows } = await readCsvFromVfs(vfs, csvPath);
    return collectSlideIdRowsFromRows(rows);
  } catch (e) {
    log(`   [Sheets] Failed to read '${basename(csvPath)}': ${e.message}`);
    return [];
  }
}

function getFirstSlideTitleFromReport(reportRow) {
  let firstSlideTitle = csvCellStr(reportRow?.Title);
  if (!firstSlideTitle && reportRow) {
    const reportValues = Object.values(reportRow);
    if (reportValues.length > 12) firstSlideTitle = csvCellStr(reportValues[12]);
  }
  if (firstSlideTitle.includes(':')) {
    return firstSlideTitle.split(':', 2)[1].trim();
  }
  return firstSlideTitle;
}

function buildNewModeLangRows(slides, lang, metaId, firstSlideTitle) {
  const baseKeys = lang === 'ar' ? BASE_AR_KEYS : BASE_EN_KEYS;
  const slideTitleKey = lang === 'ar' ? 'ar_slide_title' : 'en_slide_title';
  const purposeKey = lang === 'ar' ? 'ar_slide_purpose' : 'en_slide_purpose';
  const rows = [];

  for (let idx = 0; idx < slides.length; idx += 1) {
    const slide = slides[idx];
    const row = rowWithVideoThumbnailTs(slide, baseKeys, lang);
    if (idx === 0 && firstSlideTitle) {
      row[baseKeys.indexOf(slideTitleKey)] = firstSlideTitle;
    }
    if (idx === 0) {
      row.push(metaId, '');
    } else {
      row.push('', '');
    }
    row.push(slide[purposeKey] || '');
    row.push(slide.question_role || '');
    row.push(slide.section_type || '');
    rows.push(row);
    if (idx === 0) rows.push(mergedSyntheticTocRow(baseKeys, lang));
  }
  return rows;
}

function buildLegacyLangRows(slides, lang) {
  const baseKeys = lang === 'ar' ? BASE_AR_KEYS : BASE_EN_KEYS;
  const purposeKey = lang === 'ar' ? 'ar_slide_purpose' : 'en_slide_purpose';
  const rows = [];
  for (const slide of slides) {
    const row = rowWithVideoThumbnailTs(slide, baseKeys, lang);
    for (const mc of META_COLUMNS) {
      row.push(slide[`${lang}_${mc}`] ?? '');
    }
    row.push(slide[purposeKey] || '');
    rows.push(row);
  }
  return rows;
}

let _abortOnError = true;
let _skipSheets = false;

function abortPipeline(log, message, errors = [], { filename } = {}) {
  log(`\n❌ ${message}`);
  for (const err of errors) log(`   - ${err}`);
  if (!_abortOnError) {
    throw new ValidationAbort(message, errors, { filename });
  }
  log('   Fix the issue and rerun the full pipeline (run_all.py).');
  throw new PipelineAbortError(message, errors);
}

async function processAndValidateCsv(vfs, rows, columns, csvPath, log) {
  log(`\n-> Processing ${basename(csvPath)}...`);
  await saveToCsv(vfs, csvPath, columns, rows, log);
  log(`   Validating ${basename(csvPath)}...`);
  const { rows: parsedRows } = await readCsvFromVfs(vfs, csvPath);
  const { valid, errors } = validateCsvFromRows(parsedRows);
  if (valid) {
    log('   [SUCCESS] Validation passed.');
    return { status: 'VALID', errors: [] };
  }
  log('   [FAILURE] Validation failed.');
  try {
    if (vfs.remove) await vfs.remove(csvPath);
    log('   Deleted invalid file.');
  } catch (e) {
    log(`   Error deleting file: ${e.message}`);
  }
  return { status: 'FAILED', errors };
}

async function validateSectionTitlesAgainstApi(vfs, csvPath, log, config) {
  const fetchFn = config.fetchFn || fetch;
  const errors = await validateSectionTitlesFromCsv(vfs, csvPath, { fetchFn });
  if (!errors.length) {
    log('   [Section title] PPTX section_title values match QMS API');
    return { ok: true, errors: [] };
  }
  log('   [FAILURE] Section title validation failed.');
  for (const err of errors) log(`      - ${err}`);
  return { ok: false, errors };
}

async function processAndValidateCsvNewMode(
  vfs, rows, columns, csvPath, metasessionId, sessionReportMap, log, config,
) {
  log(`\n-> Processing ${basename(csvPath)} (NEW MODE)...`);
  await saveToCsv(vfs, csvPath, columns, rows, log);

  const reportRow = sessionReportMap?.[metasessionId] || {};
  const subject = csvCellStr(reportRow.Subject);

  log('   Processing question IDs from QMS API...');
  const questionIdErrors = await applyQuestionTypeDuplication(
    vfs, csvPath, log, config, subject,
  );
  if (questionIdErrors.length > 0) {
    log('   [FAILURE] Question ID processing failed.');
    for (const err of questionIdErrors) log(`      - ${err}`);
    try {
      if (vfs.remove) await vfs.remove(csvPath);
      log('   Deleted invalid file.');
    } catch (e) {
      log(`   Error deleting file: ${e.message}`);
    }
    return { status: 'FAILED', errors: questionIdErrors };
  }

  log('   Applying Session Details translations...');
  await applySessionDetailsTranslations(vfs, csvPath, metasessionId, sessionReportMap, log);
  log('   Validating section titles against QMS section API...');
  const titleCheck = await validateSectionTitlesAgainstApi(vfs, csvPath, log, config);
  if (!titleCheck.ok) {
    try {
      if (vfs.remove) await vfs.remove(csvPath);
      log('   Deleted invalid file.');
    } catch (e) {
      log(`   Error deleting file: ${e.message}`);
    }
    return { status: 'FAILED', errors: titleCheck.errors };
  }
  log(`   Validating ${basename(csvPath)}...`);
  const { rows: parsedRows } = await readCsvFromVfs(vfs, csvPath);
  const { valid, errors } = validateCsvNewModeFromRows(parsedRows);
  const practiceTypeErrors = await validatePracticeQuestionTypesFromRows(
    parsedRows,
    config.fetchFn || fetch,
    { subject },
  );
  const allErrors = [...errors, ...practiceTypeErrors];
  if (valid && practiceTypeErrors.length === 0) {
    log('   [SUCCESS] Validation passed.');
    return { status: 'VALID', errors: [] };
  }
  log('   [FAILURE] Validation failed.');
  for (const err of allErrors) log(`      - ${err}`);
  try {
    if (vfs.remove) await vfs.remove(csvPath);
    log('   Deleted invalid file.');
  } catch (e) {
    log(`   Error deleting file: ${e.message}`);
  }
  return { status: 'FAILED', errors: allErrors };
}

/**
 * Run bilingual merged CSV extraction for one or more PPTX files.
 * @param {object} ctx
 * @param {object} ctx.vfs
 * @param {(msg: string) => void} [ctx.log]
 * @param {object} [ctx.googleSheets]
 * @param {object} [ctx.config]
 * @param {string[]} pptxFilenames
 */
export async function runExtractCsvMerged(ctx, pptxFilenames) {
  _abortOnError = ctx.abortOnError !== false;
  _skipSheets = ctx.skipSheets === true;
  const { vfs, log = console.log, googleSheets, config = {} } = ctx;
  const sessionsPath = config.sessionsPath || 'sessions';
  const csvsPath = config.csvsPath || 'csvs';
  const pptxOptions = { JSZip: config.JSZip };

  const filesToProcess = [];
  for (let filename of pptxFilenames) {
    if (!filename.endsWith('.pptx')) filename = `${filename}.pptx`;
    const filePath = joinPath(sessionsPath, filename);
    if (filename.startsWith('~')) {
      log(`Warning: File '${filename}' appears to be a temporary file. Skipping.`);
      continue;
    }
    try {
      const exists = vfs.exists ? await vfs.exists(filePath) : true;
      if (exists === false) {
        log(`Warning: File '${filename}' not found in '${sessionsPath}'. Skipping.`);
        continue;
      }
      filesToProcess.push({ filename, filePath });
    } catch {
      filesToProcess.push({ filename, filePath });
    }
  }

  if (filesToProcess.length === 0) {
    abortPipeline(log, 'No valid PowerPoint files to process.');
  }

  const sessionReportMap = {};
  const processingSummary = [];
  const sheetsRowsToUpload = [];
  const seenSheetPairs = new Set();

  async function queueSheetRows(csvFilepath) {
    const rows = await collectSlideIdRowsFromCsv(vfs, csvFilepath, log);
    let added = 0;
    for (const r of rows) {
      const key = `${r[0]}:${r[1]}`;
      if (seenSheetPairs.has(key)) continue;
      seenSheetPairs.add(key);
      sheetsRowsToUpload.push(r);
      added += 1;
    }
    if (added) log(`   [Sheets] Queued ${added} new slide_id row(s) for upload.`);
  }

  for (const { filename, filePath } of filesToProcess) {
    log('\n' + '='.repeat(60));
    log(`Processing PowerPoint: ${filename}`);
    log('='.repeat(60));

    const [arPptxStem, enPptxStem] = pptxLanguageStems(filename);
    if (arPptxStem !== enPptxStem) {
      log(`   Output stems: AR='${arPptxStem}' | EN='${enPptxStem}'`);
    }

    const tempSlides = await processPresentationLegacy(vfs, filePath, log, pptxOptions);
    if (!tempSlides) {
      abortPipeline(log, `No data was extracted from ${filename}`);
    }

    const extractionMode = detectExtractionMode(tempSlides[0]);
    log(`   Detected Mode: ${extractionMode.toUpperCase()}`);

    let allSlidesData;
    let thankYouFound = false;
    let slideValidationErrors = [];

    if (extractionMode === 'new_mode') {
      const result = await processPresentationNewMode(vfs, filePath, log, pptxOptions);
      if (!result) abortPipeline(log, `No data was extracted from ${filename}`);
      ({ processedSlides: allSlidesData, thankYouFound, slideValidationErrors } = result);

      if (!thankYouFound) {
        const thankYouErr = [
          "Missing 'Thank You' slide (en_slide_title='Thank You', ar_slide_title='شكرًا جزيلًا')",
        ];
        processingSummary.push({
          filename: `${arPptxStem}_ar.csv (Not Created)`,
          status: 'FAILED',
          errors: thankYouErr,
        });
        processingSummary.push({
          filename: `${enPptxStem}_en.csv (Not Created)`,
          status: 'FAILED',
          errors: thankYouErr,
        });
        if (_abortOnError) {
          abortPipeline(log, `Missing 'Thank You' slide in ${filename}`, thankYouErr);
        }
        continue;
      }

      if (slideValidationErrors.length > 0) {
        log('   [FAILURE] Slide structure validation failed.');
        for (const err of slideValidationErrors) log(`     - ${err}`);
        processingSummary.push({
          filename: `${arPptxStem}_ar.csv (Not Created)`,
          status: 'FAILED',
          errors: slideValidationErrors,
        });
        processingSummary.push({
          filename: `${enPptxStem}_en.csv (Not Created)`,
          status: 'FAILED',
          errors: slideValidationErrors,
        });
        if (_abortOnError) {
          abortPipeline(log, `Slide structure validation failed for ${filename}`, slideValidationErrors);
        }
        continue;
      }
    } else {
      allSlidesData = tempSlides;
    }

    if (!allSlidesData || allSlidesData.length === 0) {
      abortPipeline(log, `No data was extracted from ${filename}`);
    }

    const slide1 = allSlidesData[0];
    for (const metaId of [
      csvCellStr(slide1.ar_metasession_id),
      csvCellStr(slide1.en_metasession_id),
    ]) {
      if (metaId && !(metaId in sessionReportMap)) {
        log(`   Fetching metasession data for '${metaId}'...`);
        sessionReportMap[metaId] = await getMetasessionReportRow(metaId, {
          log,
          fetchFn: config.fetchFn || fetch,
        });
      }
    }

    const pptxNameErrorsByMeta = {};
    for (const [langKey, metaId, pptxStem] of [
      ['AR', csvCellStr(slide1.ar_metasession_id), arPptxStem],
      ['EN', csvCellStr(slide1.en_metasession_id), enPptxStem],
    ]) {
      if (!metaId) continue;
      const apiData = await getRawMetasessionData(metaId, {
        log,
        fetchFn: config.fetchFn || fetch,
        fatal: false,
      });
      if (!apiData) continue;
      pptxNameErrorsByMeta[metaId] = validatePptxNameAgainstApi(
        pptxStem,
        apiData,
        { stemLabel: `${langKey} stem` },
      );
    }

    if (extractionMode === 'new_mode') {
      const arMetaId = csvCellStr(slide1.ar_metasession_id);
      const enMetaId = csvCellStr(slide1.en_metasession_id);

      if (!arMetaId) {
        processingSummary.push({
          filename: `${arPptxStem}_ar.csv (Not Created)`,
          status: 'FAILED',
          errors: ['ar_metasession_id is missing'],
        });
        if (_abortOnError) {
          abortPipeline(log, `ar_metasession_id is missing for ${filename}`, ['ar_metasession_id is missing']);
        }
      }
      if (!enMetaId) {
        processingSummary.push({
          filename: `${enPptxStem}_en.csv (Not Created)`,
          status: 'FAILED',
          errors: ['en_metasession_id is missing'],
        });
        if (_abortOnError) {
          abortPipeline(log, `en_metasession_id is missing for ${filename}`, ['en_metasession_id is missing']);
        }
      }

      if (arMetaId) {
        const arNameErrors = pptxNameErrorsByMeta[arMetaId] || [];
        if (arNameErrors.length) {
          log('   [FAILURE] PPTX filename validation failed (AR).');
          for (const err of arNameErrors) log(`      - ${err}`);
          processingSummary.push({
            filename: `${arMetaId}_${arPptxStem}_ar.csv (Not Created)`,
            status: 'FAILED',
            errors: arNameErrors,
          });
          if (_abortOnError) {
            abortPipeline(log, `PPTX filename does not match metasession API for ${arMetaId}`, arNameErrors);
          }
        } else {
          const arReport = sessionReportMap[arMetaId];
          const arSectionTypeErrors = validateSectionTypesForMetasessionType(
            csvCellStr(arReport?.['Class Type']),
            { slides: allSlidesData },
          );
          if (arSectionTypeErrors.length > 0) {
            log('   [FAILURE] Metasession section_type validation failed (AR).');
            for (const err of arSectionTypeErrors) log(`      - ${err}`);
            processingSummary.push({
              filename: `${arMetaId}_${arPptxStem}_ar.csv (Not Created)`,
              status: 'FAILED',
              errors: arSectionTypeErrors,
            });
            if (_abortOnError) {
              abortPipeline(log, `Invalid section_type for metasession ${arMetaId}`, arSectionTypeErrors);
            }
          } else {
            const arFirstTitle = getFirstSlideTitleFromReport(arReport);
            const arRows = buildNewModeLangRows(allSlidesData, 'ar', arMetaId, arFirstTitle);
            const arSavePath = joinPath(csvsPath, `${arMetaId}_${arPptxStem}_ar.csv`);
            const arResult = await processAndValidateCsvNewMode(
              vfs, arRows, NEW_MODE_COLUMNS, arSavePath, arMetaId, sessionReportMap, log, config,
            );
            processingSummary.push({
              filename: basename(arSavePath),
              status: arResult.status,
              errors: arResult.errors,
            });
            if (arResult.status === 'VALID') await queueSheetRows(arSavePath);
            else if (_abortOnError) {
              abortPipeline(log, `CSV validation failed for ${basename(arSavePath)}`, arResult.errors);
            }
          }
        }
      }

      if (enMetaId) {
        const enNameErrors = pptxNameErrorsByMeta[enMetaId] || [];
        if (enNameErrors.length) {
          log('   [FAILURE] PPTX filename validation failed (EN).');
          for (const err of enNameErrors) log(`      - ${err}`);
          processingSummary.push({
            filename: `${enMetaId}_${enPptxStem}_en.csv (Not Created)`,
            status: 'FAILED',
            errors: enNameErrors,
          });
          if (_abortOnError) {
            abortPipeline(log, `PPTX filename does not match metasession API for ${enMetaId}`, enNameErrors);
          }
        } else {
          const enReport = sessionReportMap[enMetaId];
          const enSectionTypeErrors = validateSectionTypesForMetasessionType(
            csvCellStr(enReport?.['Class Type']),
            { slides: allSlidesData },
          );
          if (enSectionTypeErrors.length > 0) {
            log('   [FAILURE] Metasession section_type validation failed (EN).');
            for (const err of enSectionTypeErrors) log(`      - ${err}`);
            processingSummary.push({
              filename: `${enMetaId}_${enPptxStem}_en.csv (Not Created)`,
              status: 'FAILED',
              errors: enSectionTypeErrors,
            });
            if (_abortOnError) {
              abortPipeline(log, `Invalid section_type for metasession ${enMetaId}`, enSectionTypeErrors);
            }
          } else {
            const enFirstTitle = getFirstSlideTitleFromReport(enReport);
            const enRows = buildNewModeLangRows(allSlidesData, 'en', enMetaId, enFirstTitle);
            const enSavePath = joinPath(csvsPath, `${enMetaId}_${enPptxStem}_en.csv`);
            const enResult = await processAndValidateCsvNewMode(
              vfs, enRows, NEW_MODE_COLUMNS, enSavePath, enMetaId, sessionReportMap, log, config,
            );
            processingSummary.push({
              filename: basename(enSavePath),
              status: enResult.status,
              errors: enResult.errors,
            });
            if (enResult.status === 'VALID') await queueSheetRows(enSavePath);
            else if (_abortOnError) {
              abortPipeline(log, `CSV validation failed for ${basename(enSavePath)}`, enResult.errors);
            }
          }
        }
      }

      continue;
    }

    propagateBilingualSectionIds(allSlidesData);
    const legacyColumns = [...BASE_COLUMNS, ...META_COLUMNS, 'slide_purpose'];

    let arPrefix = arPptxStem;
    const arMetaId = csvCellStr(slide1.ar_metasession_id);
    let arMetaErrors = [];
    let arValid = Boolean(arMetaId);
    const arNameErrors = arMetaId ? (pptxNameErrorsByMeta[arMetaId] || []) : [];
    if (arNameErrors.length) {
      arValid = false;
      arMetaErrors = arNameErrors;
    } else if (!arMetaId) {
      arMetaErrors = ["Validation Error: Mandatory tag 'ar_metasession_id' is missing from the first slide."];
      arValid = false;
    } else {
      ({ valid: arValid, errors: arMetaErrors } = validateMetasessionData(
        slide1, sessionReportMap, 'ar',
      ));
      if (arValid) arPrefix = `${arMetaId}_${arPptxStem}`;
    }

    if (arValid) {
      const arRows = buildLegacyLangRows(allSlidesData, 'ar');
      const arSavePath = joinPath(csvsPath, `${arPrefix}_ar.csv`);
      const arResult = await processAndValidateCsv(vfs, arRows, legacyColumns, arSavePath, log);
      processingSummary.push({
        filename: basename(arSavePath),
        status: arResult.status,
        errors: arResult.errors,
      });
      if (arResult.status === 'VALID') await queueSheetRows(arSavePath);
      else if (_abortOnError) {
        abortPipeline(log, `CSV validation failed for ${basename(arSavePath)}`, arResult.errors);
      }
    } else {
      processingSummary.push({
        filename: `${arPrefix}_ar.csv (Not Created)`,
        status: 'FAILED',
        errors: arMetaErrors,
      });
      if (_abortOnError) {
        abortPipeline(log, `Metadata validation failed for AR (${filename})`, arMetaErrors);
      }
    }

    let enPrefix = enPptxStem;
    const enMetaId = csvCellStr(slide1.en_metasession_id);
    let enMetaErrors = [];
    let enValid = Boolean(enMetaId);
    const enNameErrors = enMetaId ? (pptxNameErrorsByMeta[enMetaId] || []) : [];
    if (enNameErrors.length) {
      enValid = false;
      enMetaErrors = enNameErrors;
    } else if (!enMetaId) {
      enMetaErrors = ["Validation Error: Mandatory tag 'en_metasession_id' is missing from the first slide."];
      enValid = false;
    } else {
      ({ valid: enValid, errors: enMetaErrors } = validateMetasessionData(
        slide1, sessionReportMap, 'en',
      ));
      if (enValid) enPrefix = `${enMetaId}_${enPptxStem}`;
    }

    if (enValid) {
      const enRows = buildLegacyLangRows(allSlidesData, 'en');
      const enSavePath = joinPath(csvsPath, `${enPrefix}_en.csv`);
      const enResult = await processAndValidateCsv(vfs, enRows, legacyColumns, enSavePath, log);
      processingSummary.push({
        filename: basename(enSavePath),
        status: enResult.status,
        errors: enResult.errors,
      });
      if (enResult.status === 'VALID') await queueSheetRows(enSavePath);
      else if (_abortOnError) {
        abortPipeline(log, `CSV validation failed for ${basename(enSavePath)}`, enResult.errors);
      }
    } else {
      processingSummary.push({
        filename: `${enPrefix}_en.csv (Not Created)`,
        status: 'FAILED',
        errors: enMetaErrors,
      });
      if (_abortOnError) {
        abortPipeline(log, `Metadata validation failed for EN (${filename})`, enMetaErrors);
      }
    }
  }

  log('\n' + '='.repeat(60));
  log('                      FINAL SUMMARY REPORT');
  log('='.repeat(60));

  let validFilesCount = 0;
  for (const result of processingSummary) {
    if (result.status === 'VALID') {
      log(`✅ ${result.filename}`);
      validFilesCount += 1;
    } else {
      log(`❌ ${result.filename}`);
      for (const error of result.errors) log(`   - ${error}`);
    }
  }
  log('-'.repeat(60));
  log(`Processing Complete. ${validFilesCount} valid CSV file(s) created in '${csvsPath}'.`);

  if (!_skipSheets && sheetsRowsToUpload.length > 0) {
    log('\n' + '='.repeat(60));
    log(`Uploading ${sheetsRowsToUpload.length} row(s) to Google Sheets 'temp' tab...`);
    log('='.repeat(60));

    const spreadsheetId = config.sheetsSpreadsheetId || SHEETS_SPREADSHEET_ID;
    const tabName = config.sheetsTempTabName || SHEETS_TEMP_TAB_NAME;
    let ok = false;
    if (googleSheets && typeof googleSheets.appendRows === 'function') {
      ok = await googleSheets.appendRows(spreadsheetId, tabName, sheetsRowsToUpload);
    } else if (googleSheets && typeof googleSheets.appendToTempTab === 'function') {
      ok = await googleSheets.appendToTempTab(sheetsRowsToUpload);
    } else {
      log('   [Sheets] No googleSheets API provided; skipping upload.');
      ok = true;
    }
    if (!ok) abortPipeline(log, 'Google Sheets upload failed');
    else if (googleSheets) {
      log(`   [Sheets] Appended ${sheetsRowsToUpload.length} row(s) to '${tabName}'.`);
    }
  } else {
    log('\nNo 12-digit slide_id rows to upload to Google Sheets.');
  }

  if (_abortOnError) {
    if (processingSummary.some((r) => r.status !== 'VALID')) {
      abortPipeline(log, 'One or more CSV outputs failed');
    }
    if (processingSummary.length > 0 && validFilesCount === 0) {
      abortPipeline(log, 'No valid CSV files were created');
    }
  }

  return {
    ok: processingSummary.every((r) => r.status === 'VALID') && validFilesCount > 0,
    processingSummary,
    validFilesCount,
    sheetsRowsQueued: sheetsRowsToUpload.length,
    csvsPath,
  };
}

export async function validatePresentationFile(ctx, pptxFilename) {
  const csvsPath = ctx.config?.csvsPath || 'csvs';
  const pptxErrors = [];

  try {
    const result = await runExtractCsvMerged(
      { ...ctx, abortOnError: false, skipSheets: true },
      [pptxFilename],
    );
    return {
      pptxErrors,
      csvOutcomes: buildCsvOutcomes(result.processingSummary, csvsPath),
    };
  } catch (e) {
    if (e instanceof ValidationAbort) {
      if (e.errors.length) {
        pptxErrors.push(...e.errors);
      } else {
        pptxErrors.push(e.message);
      }
      return { pptxErrors, csvOutcomes: [] };
    }
    if (e instanceof PipelineAbortError) {
      pptxErrors.push(...(e.errors || [e.message]));
    } else {
      pptxErrors.push(e.message);
    }
    return { pptxErrors, csvOutcomes: [] };
  }
}
