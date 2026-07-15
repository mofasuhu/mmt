/** Shared CSV session row handling — port of session_csv.py */

const EMPTY_VALUES = new Set(['', 'nan', 'none', 'nat']);
const TWELVE_DIGIT_ID_RE = /^\d{12}(\.\d+)?$/;
const SECTION_ID_RE = /^\d{12}$/;
const TASHKEEL_RE = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;
const RECAP_TITLES = new Set([
  'recap',
  'ملخص',
  // French
  'récap',
  'récapitulatif',
  'recapitulatif',
  // Spanish
  'resumen',
  'recapitulación',
  'recapitulacion',
  // Italian
  'riepilogo',
  // German
  'zusammenfassung',
  'rekapitulation',
]);

export const TOC_TITLE_BY_LANGUAGE = {
  ar: 'محتوى الحصة',
  en: 'Table of Contents',
  fr: 'Table des matières',
  es: 'Índice',
  it: 'Indice',
  de: 'Inhaltsverzeichnis',
};

const LANGUAGE_ALIASES = {
  arabic: 'ar',
  english: 'en',
  french: 'fr',
  spanish: 'es',
  italian: 'it',
  german: 'de',
};

/** Bilingual merged-deck delimiters: legacy pipe + Windows-safe `` __ ``. */
export const MERGED_PPTX_DELIMITERS = ['|', ' __ '];
const ARABIC_SCRIPT_RE = /[\u0600-\u06FF]/;
const WINDOWS_MERGED_PPTX_DELIMITER = ' __ ';

export function isMergedPptxBasename(name) {
  const base = name.toLowerCase().endsWith('.pptx')
    ? name.slice(0, -5).trim()
    : String(name).trim();
  return MERGED_PPTX_DELIMITERS.some((delim) => base.includes(delim));
}

/** @returns {[string, string]} arStem, enStem */
export function splitMergedPptxBasename(name) {
  const base = (name.toLowerCase().endsWith('.pptx')
    ? name.slice(0, -5)
    : String(name)).trim();
  const delim = MERGED_PPTX_DELIMITERS.find((d) => base.includes(d));
  if (!delim) return [base, base];

  const parts = base.split(delim).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 1) return [parts[0], parts[0]];

  const arParts = parts.filter((p) => ARABIC_SCRIPT_RE.test(p));
  const enParts = parts.filter((p) => !ARABIC_SCRIPT_RE.test(p));
  if (arParts.length === 1 && enParts.length === 1) {
    return [arParts[0], enParts[0]];
  }
  return [parts[parts.length - 1], parts[0]];
}

export function sanitizePptxDownloadBasename(name, { windowsSafe = false } = {}) {
  let sanitized = String(name).trim().replace(/[\\/*?:"<>]/g, '_');
  if (windowsSafe) {
    sanitized = sanitized.replace(/\s*\|\s*/g, WINDOWS_MERGED_PPTX_DELIMITER);
  }
  if (!sanitized.toLowerCase().endsWith('.pptx')) {
    sanitized = `${sanitized}.pptx`;
  }
  return sanitized;
}

export function sanitizePptxDownloadBasenameForPlatform(name) {
  // Always filesystem-safe in the web tool (File System Access API rejects ``|`` etc.).
  return sanitizePptxDownloadBasename(name, { windowsSafe: true });
}

/** Canonical Example/Question titles → session language (matches session_csv.py). */
const CANONICAL_SLIDE_TITLES = {
  question: {
    ar: 'سؤال',
    en: 'Question',
    fr: 'Question',
    es: 'Pregunta',
    de: 'Frage',
    it: 'Domanda',
  },
  example: {
    ar: 'مثال',
    en: 'Example',
    fr: 'Exemple',
    es: 'Ejemplo',
    de: 'Beispiel',
    it: 'Esempio',
  },
  interactive_example: {
    ar: 'مثال تفاعلي',
    en: 'Interactive Example',
    fr: 'Exemple Interactif',
    es: 'Ejemplo Interactivo',
    de: 'Interaktives Beispiel',
    it: 'Esempio Interattivo',
  },
};

export const PRESENTATION_ROLES = new Set(['title', 'toc', 'instructional', 'video', 'activity', 'thank_you']);
export const QUESTION_ROLES = new Set(['example', 'interactive_example']);
export const VALID_QUESTION_ROLES = new Set([
  'interactive_example', 'interactive example', 'example', 'checkpoint', 'practice', 'exam',
]);
export const LIVE_QUESTION_ROLES = new Set(['example', 'interactive_example']);
export const WORKSHEET_QUESTION_ROLES = new Set(['checkpoint', 'practice']);
export const EXAM_QUESTION_ROLE = 'exam';
/** Rule 40/60 counts live example/interactive_example + worksheet practice only (excludes exam). */
export const RULE40_LIVE_ROLES = new Set(['example', 'interactive_example']);
export const RULE40_WORKSHEET_ROLES = new Set(['practice']);
export const SLIDE_DURATION_EXCLUDED_ROLES = new Set(['title', 'toc', 'thank_you']);
export const SESSION_DURATION_MISSING_MSG = (
  'Session duration is missing from the Metasession API response. '
  + "As a temporary workaround, please add 'session_duration: <duration>' "
  + '(in minutes) to the first slide of the PPTX, then rerun. '
  + 'Note: This is a temporary fallback until the technology unit adds the '
  + 'duration field to the Metasession API response.'
);

const CANONICAL_QUESTION_SLIDE_TITLES = {
  question: {
    ar: 'سؤال',
    en: 'Question',
    fr: 'Question',
    es: 'Pregunta',
    de: 'Frage',
    it: 'Domanda',
  },
  example: {
    ar: 'مثال',
    en: 'Example',
    fr: 'Exemple',
    es: 'Ejemplo',
    de: 'Beispiel',
    it: 'Esempio',
  },
  interactive_example: {
    ar: 'مثال تفاعلي',
    en: 'Interactive Example',
    fr: 'Exemple Interactif',
    es: 'Ejemplo Interactivo',
    de: 'Interaktives Beispiel',
    it: 'Esempio Interattivo',
  },
};

export const THANK_YOU_TITLE_BY_LANGUAGE = {
  ar: 'شكرًا جزيلًا!',
  de: 'Vielen Dank!',
  en: 'Thank You!',
  es: '¡Gracias!',
  fr: 'Merci!',
  it: 'Grazie!',
};

const THANK_YOU_TITLE_NORMALIZED = new Set([
  'thank you',
  'شكرا جزيلا',
  'vielen dank',
  'gracias',
  'merci',
  'grazie',
]);

export function languageFromCsvPath(csvPath) {
  throw new Error(
    'languageFromCsvPath is deprecated; use requireLanguageFromReportRow() with metasession API data instead',
  );
}

export function normalizeLanguageCode(lang) {
  const code = csvCellStr(lang).toLowerCase();
  if (!code) return 'en';
  return LANGUAGE_ALIASES[code] || code;
}

/** Session language from metasession API report row only (never filename/CSV path). */
export function requireLanguageFromReportRow(reportRow) {
  if (!reportRow) {
    throw new Error('metasession API report is missing; cannot determine session language');
  }
  const raw = csvCellStr(reportRow.Language);
  if (!raw) {
    throw new Error('metasession API report has no Language field');
  }
  return normalizeLanguageCode(raw);
}

/** Session language from raw metasession API data only. */
export function requireLanguageFromApiData(apiData) {
  if (!apiData) {
    throw new Error('metasession API data is missing; cannot determine session language');
  }
  const languageObj = apiData.language || {};
  const raw = csvCellStr(
    typeof languageObj === 'object' && languageObj
      ? (languageObj.iso_code || languageObj.name)
      : languageObj,
  );
  if (!raw) {
    throw new Error('metasession API data has no language.iso_code');
  }
  return normalizeLanguageCode(raw);
}

/** Session title for slide 1 from metasession API report (prefix stripped). */
export function cleanedSessionTitleFromReportRow(reportRow) {
  if (!reportRow) return '';
  const raw = csvCellStr(reportRow.Title || reportRow['Metasession Title']);
  if (!raw) return '';
  const colonIdx = raw.indexOf(':');
  return colonIdx >= 0 ? raw.slice(colonIdx + 1).trim() : raw;
}

export function tocTitleForLanguage(lang) {
  const code = normalizeLanguageCode(lang);
  return TOC_TITLE_BY_LANGUAGE[code] || TOC_TITLE_BY_LANGUAGE.en;
}

export function tocTitleKeywords() {
  return [...new Set(Object.values(TOC_TITLE_BY_LANGUAGE))];
}

export function slideTextContainsTocKeyword(text) {
  const haystack = csvCellStr(text).toLowerCase();
  if (!haystack) return false;
  return tocTitleKeywords().some((keyword) => haystack.includes(keyword.toLowerCase()));
}

export function validatePptxSlide2Toc(slideLabel, slideText) {
  if (slideTextContainsTocKeyword(slideText)) return null;
  const keywords = tocTitleKeywords().map((kw) => `'${kw}'`).join(', ');
  return (
    `${slideLabel}: Slide 2 must be the Table of Contents slide; `
    + `expected text matching one of: ${keywords} (case-insensitive).`
  );
}

export function validatePptxSlide1MetasessionId(slideLabel, metasessionId) {
  if (csvCellStr(metasessionId)) return null;
  return `${slideLabel}: Missing mandatory field 'metasession_id' on Slide 1.`;
}

export function validatePptxSlide1MergedMetasessionIds(slideLabel, arMetasessionId, enMetasessionId) {
  const errors = [];
  if (!csvCellStr(arMetasessionId)) {
    errors.push(`${slideLabel}: Missing mandatory tag 'ar_metasession_id' on Slide 1.`);
  }
  if (!csvCellStr(enMetasessionId)) {
    errors.push(`${slideLabel}: Missing mandatory tag 'en_metasession_id' on Slide 1.`);
  }
  return errors;
}

/** Map canonical Example/Question/Thank-you slide titles to the session language. */
export function localizeCanonicalSlideTitle(title, lang) {
  const text = csvCellStr(title);
  if (!text) return text;
  if (isThankYouTitle(text)) return thankYouTitleForLanguage(lang);
  const code = normalizeLanguageCode(lang);
  const mapping = CANONICAL_SLIDE_TITLES[text.toLowerCase()];
  if (mapping) return mapping[code] || text;
  return text;
}

export function slideCategoryAndRole(slideTypeOrPurpose) {
  const role = csvCellStr(slideTypeOrPurpose).toLowerCase().replace(/ /g, '_');
  if (QUESTION_ROLES.has(role)) return ['question', role];
  if (PRESENTATION_ROLES.has(role)) return ['presentation', role];
  if (role.startsWith('question')) return ['question', 'interactive_example'];
  return ['presentation', 'instructional'];
}

export function canonicalQuestionSlideTitle(language, role) {
  const code = normalizeLanguageCode(language);
  let roleKey = csvCellStr(role).toLowerCase().replace(/ /g, '_');
  if (['interactive_example', 'interactive'].includes(roleKey)) {
    roleKey = 'interactive_example';
  } else if (roleKey !== 'example') {
    roleKey = 'question';
  }
  const mapping = CANONICAL_QUESTION_SLIDE_TITLES[roleKey] || CANONICAL_QUESTION_SLIDE_TITLES.question;
  return mapping[code] || mapping.en;
}

export function splitPartQualifiedQuestionId(raw) {
  const s = csvCellStr(raw);
  if (!s) return [null, 1];
  const match = s.match(/^(\d{12})(?:\.(\d+))?$/);
  if (!match) return [normalizeQuestionIdBase(s), 1];
  return [match[1], match[2] ? Number.parseInt(match[2], 10) : 1];
}

export const STORY_SECTION_TITLE_PREFIXES = [
  'story',
  'قصة',
  'القصة',
  'the story',
];

export function isStorySectionTitle(title) {
  const text = stripTashkeel(csvCellStr(title)).toLowerCase();
  if (!text) return false;
  for (const prefix of STORY_SECTION_TITLE_PREFIXES) {
    const normalizedPrefix = stripTashkeel(prefix).toLowerCase();
    if (text.startsWith(normalizedPrefix)) return true;
  }
  return false;
}

export function isMultipartInstructionalPartRow(row) {
  if (csvCellStr(row.question_id)) return false;
  if (isWorksheetQuestionRow(row)) return false;
  const slideId = csvCellStr(row.slide_id);
  if (!slideId || isNewId(slideId)) return false;
  if (!slideId.includes('.')) return false;
  const [base, part] = splitPartQualifiedQuestionId(slideId);
  return Boolean(base && isPlainTwelveDigitId(base) && part >= 1);
}

function parseVerbatimNumber(raw) {
  const s = csvCellStr(raw);
  if (!s) return null;
  const number = Number.parseInt(Number(s), 10);
  return Number.isFinite(number) && number >= 1 ? number : null;
}

export function isVerbatimMultipartInstructionalPartRow(row) {
  if (csvCellStr(row.question_id)) return false;
  if (isWorksheetQuestionRow(row)) return false;
  if (!csvCellStr(row.slide_id) || isNewId(row.slide_id)) return false;
  if (!csvCellStr(row.verbatim_multipart)) return false;
  return parseVerbatimNumber(row.verbatim_number) !== null;
}

export function isSlideGroupSpanChildRow(row) {
  if (csvCellStr(row.question_id)) return false;
  if (isWorksheetQuestionRow(row)) return false;
  return Boolean(csvCellStr(row.slide_id));
}

/**
 * @typedef {object} SlideGroupPlan
 * @property {string} section_id
 * @property {string} base_id
 * @property {number} first_row_index
 * @property {number} last_row_index
 * @property {number[]} part_row_indices
 * @property {number[]} child_row_indices
 * @property {'single'|'multiple'} pages
 * @property {string} slide_group_id
 * @property {Record<string, string>} part_id_map
 */

/**
 * @param {Array<[number, object]>} sectionRows
 * @returns {SlideGroupPlan[]}
 */
export function planInstructionalSlideGroups(sectionRows, { sectionId = '', sectionTitle = '' } = {}) {
  /** @type {Map<string, Array<[number, object]>>} */
  const byBase = new Map();
  for (const [idx, row] of sectionRows) {
    if (!isMultipartInstructionalPartRow(row)) continue;
    const [base] = splitPartQualifiedQuestionId(row.slide_id);
    if (!base) continue;
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push([idx, row]);
  }

  /** @type {SlideGroupPlan[]} */
  const plans = [];
  for (const [baseId, entries] of byBase.entries()) {
    if (entries.length < 2) continue;
    const partIndices = entries.map(([idx]) => idx).sort((a, b) => a - b);
    const firstIdx = partIndices[0];
    const lastIdx = partIndices[partIndices.length - 1];
    const partCount = partIndices.length;
    const childIndices = sectionRows
      .filter(([idx, row]) => idx >= firstIdx && idx <= lastIdx && isSlideGroupSpanChildRow(row))
      .map(([idx]) => idx);
    const hasInterrupt = childIndices.length > partCount;
    const pages = (hasInterrupt || partCount >= 4 || isStorySectionTitle(sectionTitle))
      ? 'multiple'
      : 'single';
    plans.push({
      section_id: sectionId,
      base_id: baseId,
      first_row_index: firstIdx,
      last_row_index: lastIdx,
      part_row_indices: partIndices,
      child_row_indices: childIndices,
      pages,
      slide_group_id: '',
      part_id_map: {},
    });
  }

  const plannedPartRows = new Set();
  for (const plan of plans) {
    for (const idx of plan.part_row_indices) plannedPartRows.add(idx);
  }

  let currentRun = [];
  let expectedNext = null;
  const flushVerbatimRun = () => {
    if (currentRun.length >= 2) {
      const partIndices = currentRun.map(([idx]) => idx);
      const firstIdx = partIndices[0];
      const lastIdx = partIndices[partIndices.length - 1];
      const partCount = partIndices.length;
      const childIndices = sectionRows
        .filter(([idx, row]) => idx >= firstIdx && idx <= lastIdx && isSlideGroupSpanChildRow(row))
        .map(([idx]) => idx);
      const hasInterrupt = childIndices.length > partCount;
      const firstSlideId = csvCellStr(currentRun[0]?.[1]?.slide_id);
      plans.push({
        section_id: sectionId,
        base_id: firstSlideId || `verbatim_multipart_${firstIdx}`,
        first_row_index: firstIdx,
        last_row_index: lastIdx,
        part_row_indices: partIndices,
        child_row_indices: childIndices,
        pages: (hasInterrupt || partCount >= 4 || isStorySectionTitle(sectionTitle))
          ? 'multiple'
          : 'single',
        slide_group_id: '',
        part_id_map: {},
      });
    }
    currentRun = [];
    expectedNext = null;
  };

  for (const [idx, row] of sectionRows) {
    if (plannedPartRows.has(idx) || !isVerbatimMultipartInstructionalPartRow(row)) {
      flushVerbatimRun();
      continue;
    }
    const partNumber = parseVerbatimNumber(row.verbatim_number);
    if (partNumber === 1) {
      flushVerbatimRun();
      currentRun = [[idx, row]];
      expectedNext = 2;
    } else if (expectedNext !== null && partNumber === expectedNext) {
      currentRun.push([idx, row]);
      expectedNext = partNumber + 1;
    } else {
      flushVerbatimRun();
      if (partNumber === 1) {
        currentRun = [[idx, row]];
        expectedNext = 2;
      }
    }
  }
  flushVerbatimRun();
  return plans;
}

/**
 * @returns {[SlideGroupPlan[], Map<number, SlideGroupPlan>]}
 */
export function collectInstructionalSlideGroupPlansFromRows(rows) {
  /** @type {Array<[number, object]>} */
  const indexedRows = rows.map((row, index) => [index, row]);
  return collectInstructionalSlideGroupPlansFromIndexedRows(indexedRows);
}

/**
 * @param {Array<[number, object]>} indexedRows
 * @returns {[SlideGroupPlan[], Map<number, SlideGroupPlan>]}
 */
export function collectInstructionalSlideGroupPlansFromIndexedRows(indexedRows) {
  /** @type {SlideGroupPlan[]} */
  const plans = [];
  /** @type {Map<number, SlideGroupPlan>} */
  const indexToPlan = new Map();

  let currentSectionId = '';
  /** @type {Array<[number, object]>} */
  let sectionRows = [];
  let sectionTitle = '';

  const flushSection = () => {
    if (!sectionRows.length || !currentSectionId) {
      sectionRows = [];
      sectionTitle = '';
      return;
    }
    for (const plan of planInstructionalSlideGroups(sectionRows, {
      sectionId: currentSectionId,
      sectionTitle,
    })) {
      plans.push(plan);
      for (const rowIdx of plan.child_row_indices) {
        indexToPlan.set(rowIdx, plan);
      }
    }
    sectionRows = [];
    sectionTitle = '';
  };

  for (const [idx, row] of indexedRows) {
    const sid = normalizeSectionId(row.section_id);
    if (sid && sid !== currentSectionId) {
      flushSection();
      currentSectionId = sid;
      sectionTitle = csvCellStr(row.section_title);
    } else if (sid && csvCellStr(row.section_title)) {
      sectionTitle = csvCellStr(row.section_title);
    }
    if (currentSectionId) sectionRows.push([idx, row]);
  }
  flushSection();
  return [plans, indexToPlan];
}

/**
 * @param {object[]} mainContent
 * @param {object[]} sessionRowsProcessed
 * @returns {[SlideGroupPlan[], Map<number, SlideGroupPlan>]}
 */
export function collectInstructionalSlideGroupPlansForMainContent(
  mainContent,
  sessionRowsProcessed,
) {
  const indexedRows = mainContent.map((row) => {
    const rowIndex = sessionRowsProcessed.indexOf(row);
    return [rowIndex >= 0 ? rowIndex : sessionRowsProcessed.length, row];
  });
  return collectInstructionalSlideGroupPlansFromIndexedRows(indexedRows);
}

export function applySlideGroupMintedIds(plans, mintedIds, rowByIndex) {
  let offset = 0;
  for (const plan of plans) {
    if (offset >= mintedIds.length) break;
    plan.slide_group_id = mintedIds[offset];
    offset += 1;
    plan.part_id_map = {};
    for (const partIdx of plan.part_row_indices) {
      if (offset >= mintedIds.length) break;
      const row = rowByIndex.get(partIdx) || {};
      const oldId = csvCellStr(row.slide_id);
      if (oldId) plan.part_id_map[oldId] = mintedIds[offset];
      offset += 1;
    }
  }
}

/** @returns {[string, string|null]} */
export function resolveSlideIdForSlideGroupRow(row, rowIndex, plan) {
  const oldId = csvCellStr(row.slide_id);
  if (plan && plan.part_row_indices.includes(rowIndex)) {
    const newId = plan.part_id_map[oldId] || '';
    if (newId) return [newId, oldId];
  }
  return [oldId, null];
}

export function formatQuestionPartId(rawId, partNumber = null) {
  const [base, parsedPart] = splitPartQualifiedQuestionId(rawId);
  if (!base) return csvCellStr(rawId);
  let part = partNumber == null ? parsedPart : Number.parseInt(partNumber, 10);
  if (!Number.isFinite(part) || part < 1) part = parsedPart || 1;
  return `${base}.${String(part).padStart(2, '0')}`;
}

export function questionPartAttrs(questionId, metadataByParent = null) {
  const [baseId, partNumber] = splitPartQualifiedQuestionId(questionId);
  const metadata = metadataByParent instanceof Map
    ? metadataByParent.get(baseId || '')
    : metadataByParent?.[baseId || ''];
  const numberOfParts = Number.parseInt(metadata?.number_of_parts ?? 1, 10) || 1;
  return {
    question_id: formatQuestionPartId(questionId, partNumber),
    number_of_parts: String(numberOfParts),
    part_number: String(partNumber),
  };
}

export function xmlRoleFromSlideElement(element) {
  return csvCellStr(element.getAttribute('slide_role')) || csvCellStr(element.getAttribute('slide_type'));
}

export function isNewId(val) {
  return csvCellStr(val).toLowerCase() === 'new';
}

export function isPlainTwelveDigitId(val) {
  const s = csvCellStr(val);
  if (!s || isNewId(s)) return false;
  return SECTION_ID_RE.test(s);
}

export function isValidRawExamId(val) {
  const s = csvCellStr(val);
  return isNewId(s) || isPlainTwelveDigitId(s);
}

export function isTwelveDigitId(val) {
  const s = csvCellStr(val);
  if (!s || isNewId(s)) return false;
  return TWELVE_DIGIT_ID_RE.test(s);
}

/** Strict 12-digit section id (not ``new``, no ``.N`` suffix). */
export function isSectionId(val) {
  const sid = normalizeSectionId(val);
  if (!sid || isNewId(sid)) return false;
  return SECTION_ID_RE.test(sid);
}

export function stripTashkeel(text) {
  return csvCellStr(text).replace(TASHKEEL_RE, '');
}

export function normalizeThankYouTitleForMatch(title) {
  return stripTashkeel(title)
    .toLowerCase()
    .trim()
    .replace(/¡/g, '')
    .replace(/^[!؟?。．.\s]+|[!؟?。．.\s]+$/g, '')
    .replace(/\s+/g, ' ');
}

export function isThankYouTitle(title) {
  return THANK_YOU_TITLE_NORMALIZED.has(normalizeThankYouTitleForMatch(title));
}

export function thankYouTitleForLanguage(lang) {
  const code = normalizeLanguageCode(lang);
  return THANK_YOU_TITLE_BY_LANGUAGE[code] || THANK_YOU_TITLE_BY_LANGUAGE.en;
}

export function standardizedThankYouTitle(lang, detectedTitle = '') {
  if (detectedTitle && !isThankYouTitle(detectedTitle)) return null;
  return thankYouTitleForLanguage(lang);
}

export function isRecapTitle(title) {
  return RECAP_TITLES.has(stripTashkeel(title).toLowerCase());
}

/** True when a CSV row is a session-level recap slide (root, not inside a section). */
export function isRecapRow(row) {
  if (isRecapTitle(row?.section_title || '')) return true;
  for (const key of ['slide_title', 'ar_slide_title', 'en_slide_title']) {
    if (isRecapTitle(row?.[key] || '')) return true;
  }
  return false;
}

export const SOURCE_SLIDE_ID_MARKER = '.source_slide_id';

export function extractSlideNumberFromTexComment(comment, fallback) {
  const match = csvCellStr(comment).match(/%(\d+)/);
  return match ? match[1] : String(fallback);
}

/**
 * @param {Array<[string, string, string, string, string?]>} slides
 * @param {{ fetchNewId?: () => Promise<string | null> }} [opts]
 */
export async function planPackageSlideIds(slides, { fetchNewId } = {}) {
  const plan = [];
  const seenCounts = {};

  for (let index = 0; index < slides.length; index += 1) {
    const slideTuple = slides[index];
    const sourceSlideId = csvCellStr(slideTuple[1]);
    const slideComment = slideTuple.length > 4 ? slideTuple[4] : '';
    const slideNumber = extractSlideNumberFromTexComment(slideComment, String(index + 1));

    const occurrence = seenCounts[sourceSlideId] || 0;
    let packageSlideId = sourceSlideId;
    if (occurrence > 0) {
      if (!fetchNewId) {
        throw new Error(
          `Duplicate slide_id '${sourceSlideId}' requires a new 12-digit ID `
          + `(slide_number ${slideNumber}) but no ID fetcher was provided.`,
        );
      }
      packageSlideId = csvCellStr(await fetchNewId());
      if (!isTwelveDigitId(packageSlideId)) {
        throw new Error(
          `Could not fetch a new 12-digit slide ID for duplicate of `
          + `'${sourceSlideId}' (slide_number ${slideNumber}).`,
        );
      }
    }
    seenCounts[sourceSlideId] = occurrence + 1;

    plan.push({
      packageSlideId,
      sourceSlideId,
      slideNumber,
      slideTuple,
      index,
    });
  }

  return plan;
}

export function resolvePackageSourceSlideId(sourceSlideId, { slideNumber = '', csvRows = null } = {}) {
  if (!csvRows?.length || !slideNumber) return csvCellStr(sourceSlideId);
  for (const row of csvRows) {
    if (csvCellStr(row.slide_number) !== csvCellStr(slideNumber)) continue;
    const packageSource = csvCellStr(row.package_source_slide_id);
    if (packageSource) return packageSource;
    break;
  }
  return csvCellStr(sourceSlideId);
}

export async function readRemoteSourceSlideId(vfs, folderPath) {
  const marker = `${folderPath}/${SOURCE_SLIDE_ID_MARKER}`;
  try {
    if (!(await vfs.exists(marker))) return '';
    return csvCellStr(await vfs.readText(marker));
  } catch {
    return '';
  }
}

export async function writeRemoteSourceSlideIdMarker(vfs, folderPath, sourceSlideId) {
  const source = csvCellStr(sourceSlideId);
  if (!source) return;
  await vfs.writeText(`${folderPath}/${SOURCE_SLIDE_ID_MARKER}`, source);
}

export function applySlideIdMapToCsvRows(rows, slideNumberToPackageId) {
  let changes = 0;
  for (const row of rows) {
    const slideNumber = csvCellStr(row.slide_number);
    if (!(slideNumber in slideNumberToPackageId)) continue;
    const newId = slideNumberToPackageId[slideNumber];
    if (csvCellStr(row.slide_id) !== newId) {
      row.slide_id = newId;
      changes += 1;
    }
  }
  return changes;
}

export function patchPackageXmlSlideIds(xmlText, slideNumberToPackageId, packagePlan = null) {
  if (packagePlan?.length) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'application/xml');
    const xmlSlides = iterSlidesDocumentOrder(doc.documentElement);
    let changes = 0;
    for (let i = 0; i < Math.min(xmlSlides.length, packagePlan.length); i += 1) {
      const slideElem = xmlSlides[i];
      const packageId = csvCellStr(packagePlan[i].packageSlideId ?? packagePlan[i].package_slide_id);
      if (!packageId) continue;
      const currentId = csvCellStr(slideElem.getAttribute('slide_id'));
      if (currentId !== packageId) {
        slideElem.setAttribute('slide_id', packageId);
        changes += 1;
      }
    }
    const serializer = new XMLSerializer();
    return { xml: serializer.serializeToString(doc), changes };
  }

  if (!xmlText || !slideNumberToPackageId || !Object.keys(slideNumberToPackageId).length) {
    return { xml: xmlText, changes: 0 };
  }
  let changes = 0;
  const xml = xmlText.replace(
    /(<slide\b[^>]*\bslide_number=")(\d+)("[^>]*\bslide_id=")([^"]*)(")/g,
    (match, p1, slideNumber, p3, slideId, p5) => {
      const packageId = slideNumberToPackageId[slideNumber];
      if (!packageId || packageId === slideId) return match;
      changes += 1;
      return `${p1}${slideNumber}${p3}${packageId}${p5}`;
    },
  );
  return { xml, changes };
}

const ROLE_SECTION_TITLES_LOWER = new Set([
  'question', 'example', 'سؤال', 'مثال',
  'essempio', 'domanda', 'ejemplo', 'pregunta', 'beispiel', 'frage',
  'video',
]);

export function sectionTitleReservedForRole(title) {
  const text = csvCellStr(title).toLowerCase();
  if (!text) return false;
  if (ROLE_SECTION_TITLES_LOWER.has(text)) return true;
  if (isRecapTitle(title)) return true;
  return Object.values(TOC_TITLE_BY_LANGUAGE).some((toc) => text === toc.toLowerCase());
}

const ZERO_VIDEO_THUMBNAIL_TS_RE = /^(?:0{1,2}:0{2}(?:\.0+)?|(?:0{1,2}:){2}0{2}(?:\.0+)?)$/;

export function normalizeVideoThumbnailTs(raw) {
  const s = csvCellStr(raw);
  if (!s || !s.includes(':')) return s;
  if (ZERO_VIDEO_THUMBNAIL_TS_RE.test(s)) return '00:00.5';
  return s;
}

export function isVideoCsvRow(row) {
  return isTwelveDigitId(csvCellStr(row?.video_id));
}

/**
 * @param {Record<string, string>} slide
 * @param {{ bilingual?: boolean }} [opts]
 */
export function isInstructionalInSectionSlide(slide, { bilingual = false } = {}) {
  if (csvCellStr(slide?.question_id)) return false;
  if (csvCellStr(slide?.question_role)) return false;
  if (bilingual) {
    if (csvCellStr(slide?.ar_video_id) || csvCellStr(slide?.en_video_id)) return false;
  } else if (csvCellStr(slide?.video_id)) {
    return false;
  }
  if (csvCellStr(slide?.activity_id)) return false;
  return true;
}

const WELL_DONE_TITLES = new Set(['well done', 'عمل رائع']);

export function isWellDoneTitle(title) {
  return WELL_DONE_TITLES.has(stripTashkeel(csvCellStr(title)).toLowerCase().replace(/^!+|!+$/g, ''));
}

export function isBilingualThankYouSlide(slide) {
  return ['en_slide_title', 'ar_slide_title', 'slide_title']
    .some((key) => isThankYouTitle(slide?.[key] || ''));
}

export function slideHasTailTitle(slide, { bilingual = false } = {}) {
  if (bilingual) {
    if (isBilingualThankYouSlide(slide)) return true;
    for (const key of ['ar_slide_title', 'en_slide_title']) {
      const val = csvCellStr(slide?.[key]);
      if (isRecapTitle(val) || isWellDoneTitle(val)) return true;
    }
    return false;
  }
  const val = csvCellStr(slide?.slide_title);
  return isThankYouTitle(val) || isRecapTitle(val) || isWellDoneTitle(val);
}

export function shouldUseSectionPlaceholderTitle(slide, { bilingual = false, isRootTail = false } = {}) {
  if (isRootTail) return false;
  if (slideHasTailTitle(slide, { bilingual })) return false;
  return isInstructionalInSectionSlide(slide, { bilingual });
}

export function rowUsesApiSectionTitle(row) {
  if (!isSectionId(row?.section_id)) return false;
  if (csvCellStr(row.question_id)) return false;
  if (isVideoCsvRow(row)) return false;
  if (isThankYouRow(row)) return false;
  if (isRecapRow(row)) return false;
  return !sectionTitleReservedForRole(row.section_title || '');
}

/** @returns {number} rows updated */
export function applySectionTitlesToRows(rows, titleBySection) {
  let changes = 0;
  for (const row of rows) {
    const sid = normalizeSectionId(row.section_id);
    if (!sid || !titleBySection[sid]) continue;
    if (!rowUsesApiSectionTitle(row)) continue;
    const apiTitle = titleBySection[sid];
    if (csvCellStr(row.section_title) !== apiTitle) {
      row.section_title = apiTitle;
      changes += 1;
    }
  }
  return changes;
}

/**
 * @param {string} text
 */
export function sanitizeTexField(text) {
  let s = csvCellStr(text);
  if (!s) return '';
  const replacements = [
    ['\\', '\\textbackslash{}'],
    ['{', '\\{'],
    ['}', '\\}'],
    ['#', '\\#'],
    ['%', '\\%'],
    ['&', '\\&'],
    ['$', '\\$'],
    ['_', '\\_'],
    ['^', '\\textasciicircum{}'],
    ['~', '\\textasciitilde{}'],
  ];
  for (const [old, rep] of replacements) {
    s = s.split(old).join(rep);
  }
  return s;
}

/**
 * @param {Array<{ title?: string, children?: unknown[] }>} entries
 * @param {string} [indent]
 */
export function renderTocEntriesTex(entries, indent = '') {
  const nestedIndent = `${indent}  `;
  const lines = [`${indent}\\begin{slideToC}`];
  for (const entry of entries) {
    const title = sanitizeTexField(entry.title || '');
    if (!title) continue;
    lines.push(`${nestedIndent}\\item {\\bullet} ${title}`);
    const children = entry.children || [];
    if (children.length) {
      lines.push(renderTocEntriesTex(children, nestedIndent));
    }
  }
  lines.push(`${indent}\\end{slideToC}`);
  return lines.join('\n');
}

/**
 * @param {Record<string, string>[]} rows
 */
export function collectTocEntriesFromRows(rows) {
  const seen = new Set();
  const entries = [];
  for (const row of rows) {
    const sid = normalizeSectionId(row.section_id);
    if (!sid || !isSectionId(sid) || seen.has(sid)) continue;
    if (!rowUsesApiSectionTitle(row)) continue;
    const title = csvCellStr(row.section_title);
    if (!title) continue;
    seen.add(sid);
    entries.push({ title, children: [] });
  }
  return entries;
}

/**
 * @param {Record<string, string>[]} rows
 * @param {{ titleBySection?: Record<string, string>, fetchFn?: typeof fetch }} [opts]
 * @returns {Promise<string[]>}
 */
export async function validateSectionTitlesAgainstApiRows(rows, { titleBySection = null, fetchFn = fetch } = {}) {
  const errors = [];
  if (!rows?.length) return errors;

  const sectionIds = new Set();
  for (const row of rows) {
    const sid = normalizeSectionId(row.section_id);
    if (sid && isSectionId(sid)) sectionIds.add(sid);
  }
  if (!sectionIds.size) return errors;

  /** @type {Record<string, string>} */
  let titles = titleBySection;
  if (!titles) {
    const { fetchSectionData } = await import('./sectionsApi.js');
    titles = {};
    for (const sid of [...sectionIds].sort()) {
      const data = await fetchSectionData(sid, { fetchFn });
      const apiTitle = csvCellStr(data?.section_title);
      if (apiTitle) {
        titles[sid] = apiTitle;
      } else {
        errors.push(
          `[section_id=${sid}] Could not load section_title from QMS API for validation.`,
        );
      }
    }
  }

  /** @type {Map<string, { pptx: string, api: string }>} */
  const mismatches = new Map();
  for (const row of rows) {
    const sid = normalizeSectionId(row.section_id);
    if (!sid || !titles[sid]) continue;
    if (!rowUsesApiSectionTitle(row)) continue;
    const pptxTitle = csvCellStr(row.section_title);
    const apiTitle = titles[sid];
    if (pptxTitle !== apiTitle) {
      mismatches.set(sid, { pptx: pptxTitle, api: apiTitle });
    }
  }

  for (const [sid, { pptx, api }] of [...mismatches.entries()].sort()) {
    errors.push(
      `[section_id=${sid}] section_title from PPTX (${JSON.stringify(pptx)}) `
      + `does not match API section_title (${JSON.stringify(api)}).`,
    );
  }
  return errors;
}

/**
 * @param {import('../io/virtualFs.js').VirtualFs} vfs
 * @param {string} csvPath
 * @param {{ fetchFn?: typeof fetch }} [opts]
 */
export async function validateSectionTitlesFromCsv(vfs, csvPath, { fetchFn = fetch } = {}) {
  try {
    const rows = await loadSessionRows(vfs, csvPath);
    return validateSectionTitlesAgainstApiRows(rows, { fetchFn });
  } catch (e) {
    return [`Failed to validate section titles from API: ${e.message}`];
  }
}

export function sectionIdValidationError(slideLabel, sectionId, { fieldName = 'section_id' } = {}) {
  const sid = csvCellStr(sectionId);
  if (!sid) {
    return (
      `${slideLabel}: section placeholder slide is missing ${fieldName}. `
      + "Must be a 12-digit ID (not 'new')."
    );
  }
  if (isNewId(sid)) {
    return `${slideLabel}: ${fieldName} must be a 12-digit ID, not '${sid}'.`;
  }
  if (!SECTION_ID_RE.test(sid)) {
    return `${slideLabel}: invalid ${fieldName} '${sid}'. Must be exactly 12 digits.`;
  }
  return null;
}

/**
 * Return errors when a session has no sections or question rows lack section_id.
 * @param {Record<string, string>[]} rows
 * @param {{ fieldnames?: string[] }} [opts]
 * @returns {string[]}
 */
export function validateSessionSectionCoverage(rows, { fieldnames = null } = {}) {
  const errors = [];
  if (!rows || rows.length === 0) return errors;

  const names = fieldnames || Object.keys(rows[0] || {});
  if (!names.length) return errors;

  const merged = !names.includes('section_id')
    && (names.includes('ar_section_id') || names.includes('en_section_id'));
  const sectionIds = new Set();

  if (merged) {
    for (const row of rows) {
      for (const col of ['ar_section_id', 'en_section_id']) {
        const sid = csvCellStr(row[col]);
        if (isSectionId(sid)) sectionIds.add(sid);
      }
    }
  } else {
    if (!names.includes('section_id')) return errors;
    for (const row of rows) {
      const sid = csvCellStr(row.section_id);
      if (isSectionId(sid)) sectionIds.add(sid);
    }
  }

  if (sectionIds.size === 0) {
    errors.push('Session has no sections: CSV contains no valid section_id values.');
  }

  const orphanExamples = [];
  for (const row of rows) {
    const qid = csvCellStr(row.question_id);
    if (!qid) continue;
    if (csvCellStr(row.question_role).toLowerCase().replace(/ /g, '_') === 'exam') continue;
    const slideNum = csvCellStr(row.slide_number) || '?';

    let hasSection;
    let fieldLabel;
    if (merged) {
      hasSection = isSectionId(row.ar_section_id) || isSectionId(row.en_section_id);
      fieldLabel = 'section_id (ar_section_id or en_section_id)';
    } else {
      hasSection = isSectionId(row.section_id);
      fieldLabel = 'section_id';
    }

    if (!hasSection) {
      orphanExamples.push(
        `Slide ${slideNum}: question_id '${qid}' is not assigned to a section `
        + `(missing ${fieldLabel}).`,
      );
    }
  }

  if (orphanExamples.length) {
    const count = orphanExamples.length;
    const noun = count === 1 ? 'question' : 'questions';
    errors.push(`${count} ${noun} are not assigned to a section.`);
    errors.push(`Example: ${orphanExamples[0]}`);
  }

  return errors;
}

export function isSlideOrMediaId(val) {
  const s = csvCellStr(val);
  if (!s) return false;
  if (isNewId(s)) return true;
  return isTwelveDigitId(s);
}

export function rowRequiresEmptySlideId({ question_id = '', video_id = '', activity_id = '' } = {}) {
  return (
    isTwelveDigitId(question_id)
    || isTwelveDigitId(video_id)
    || isTwelveDigitId(activity_id)
  );
}

export function clearSlideIdForMediaRow(row) {
  const out = { ...row };
  if (rowRequiresEmptySlideId({
    question_id: csvCellStr(out.question_id),
    video_id: csvCellStr(out.video_id),
    activity_id: csvCellStr(out.activity_id),
  })) {
    out.slide_id = '';
  }
  return out;
}

export function rowHasPrimaryId({
  slide_id = '',
  question_id = '',
  video_id = '',
  activity_id = '',
} = {}) {
  return (
    isSlideOrMediaId(slide_id)
    || isTwelveDigitId(question_id)
    || isTwelveDigitId(video_id)
    || isTwelveDigitId(activity_id)
  );
}

export function csvCellStr(val) {
  if (val == null) return '';
  if (typeof val === 'number' && Number.isNaN(val)) return '';
  const s = String(val).trim();
  if (EMPTY_VALUES.has(s.toLowerCase())) return '';
  return s;
}

export function normalizeSectionId(raw) {
  const s = csvCellStr(raw);
  if (!s) return null;
  const n = Number(s);
  if (!Number.isNaN(n) && Number.isFinite(n)) return String(Math.trunc(n));
  return s;
}

/** Normalize metasession_id from CSV (strips float ``.0`` suffixes from spreadsheets). */
export function normalizeMetasessionId(raw) {
  const s = csvCellStr(raw);
  if (!s) return null;
  const n = Number(s);
  if (!Number.isNaN(n) && Number.isFinite(n)) {
    const normalized = String(Math.trunc(n));
    return /^\d{12}$/.test(normalized) ? normalized : null;
  }
  const match = s.match(/^(\d{12})/);
  return match ? match[1] : null;
}

export function normalizeSlideIdForFolder(raw) {
  const s = csvCellStr(raw);
  if (!s || s.toLowerCase() === 'new') return null;
  const compact = s.replace(/\s+/g, '');
  const match = compact.match(/^(\d{12})(?:\.(\d+))?$/);
  if (match) {
    const [, base, suffix] = match;
    if (!suffix || Number.parseInt(suffix, 10) === 0) return base;
    return `${base}.${Number.parseInt(suffix, 10)}`;
  }
  const value = Number(s);
  if (Number.isFinite(value) && Number.isInteger(value)) {
    const normalized = String(Math.trunc(value));
    return /^\d{12}$/.test(normalized) ? normalized : null;
  }
  return null;
}

export function matchSlideFolder(rawSlideId, folderNames) {
  const slideId = normalizeSlideIdForFolder(rawSlideId);
  if (!slideId) return null;

  const folders = folderNames.map((name) => csvCellStr(name));
  if (folders.includes(slideId)) return slideId;

  if (!slideId.includes('.')) {
    const escaped = slideId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const multipartMatches = folders
      .filter((name) => new RegExp(`^${escaped}\\.\\d+$`).test(name))
      .sort();
    if (multipartMatches.length) return multipartMatches[0];
  }

  return null;
}

export const XML_METASESSION_TYPES = new Set(['regular', 'revision', 'foundation']);

export function normalizeSectionType(raw, defaultVal = 'regular') {
  const s = csvCellStr(raw) || csvCellStr(defaultVal) || 'regular';
  const lowered = s.toLowerCase();
  if (XML_METASESSION_TYPES.has(lowered)) return lowered;
  return s;
}

function courseTypeKey(courseType) {
  return metasessionTypeLabel(courseType).toLowerCase();
}

export function defaultSectionTypeForCourseType(courseType) {
  const key = courseTypeKey(courseType);
  if (key === 'foundation') return 'foundation';
  if (key === 'final revision') return 'revision';
  return 'regular';
}

export function allowedPptxSectionTypesForCourseType(courseType) {
  const key = courseTypeKey(courseType);
  if (key === 'foundation') return new Set(['foundation']);
  if (key === 'final revision') return new Set(['revision']);
  if (key === 'full curriculum') return new Set(['regular', 'revision']);
  return new Set();
}

/**
 * @returns {[string|null, string[]]}
 */
export function sectionTypeForCourseType(courseType, pptxSectionTypeRaw) {
  const key = courseTypeKey(courseType);
  if (!key) return [null, ['Metasession API did not return metasession_type.']];
  if (!SUPPORTED_METASESSION_TYPE_LABELS.has(key)) {
    return [null, [`The session type is '${metasessionTypeLabel(courseType)}' and the tool doesn't handle this type till now.`]];
  }

  const defaultType = defaultSectionTypeForCourseType(courseType);
  const raw = csvCellStr(pptxSectionTypeRaw);
  if (!raw) return [defaultType, []];

  const normalized = normalizeSectionType(raw, defaultType);
  const allowed = allowedPptxSectionTypesForCourseType(courseType);
  if (!allowed.has(normalized.toLowerCase())) {
    const allowedText = [...allowed].sort().join(', ');
    return [null, [`section_type '${raw}' is invalid for course_type '${metasessionTypeLabel(courseType)}' (allowed: ${allowedText}).`]];
  }
  return [normalized.toLowerCase(), []];
}

/** @returns {string[]} */
export function validatePptxSectionTypeForCourseType(courseType, pptxSectionTypeRaw) {
  if (!csvCellStr(pptxSectionTypeRaw)) return [];
  const [, errors] = sectionTypeForCourseType(courseType, pptxSectionTypeRaw);
  return errors;
}

/**
 * @param {Record<string, string>} slide
 * @param {{ bilingual?: boolean, context?: string }} [opts]
 * @returns {[string, string[]]}
 */
export function resolveSectionTypeFromSlide(slide, { bilingual = false, context = '' } = {}) {
  const errors = [];
  const prefix = context ? `${context}: ` : '';

  if (bilingual) {
    const arRaw = csvCellStr(slide.ar_section_type);
    const enRaw = csvCellStr(slide.en_section_type);
    const sharedRaw = csvCellStr(slide.section_type);
    const ar = arRaw.toLowerCase();
    const en = enRaw.toLowerCase();
    if (ar && en && ar !== en) {
      errors.push(
        `${prefix}ar_section_type '${arRaw}' differs from en_section_type '${enRaw}'.`,
      );
      return ['', errors];
    }
    if (arRaw) return [arRaw, errors];
    if (enRaw) return [enRaw, errors];
    if (sharedRaw) return [sharedRaw, errors];
    return ['', errors];
  }

  return [csvCellStr(slide.section_type), errors];
}

const BARE_QUESTION_ID_LINE_RE = /^\d{12}(?:\.\d+)?$/;

/** Extract tagless newline-separated 12-digit question IDs from slide text. */
export function extractBareQuestionIdLines(text) {
  if (!text) return [];
  const ids = [];
  const seen = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const token = line.trim();
    if (!token) continue;
    if (/\w\s*[:=]/.test(token)) continue;
    if (!BARE_QUESTION_ID_LINE_RE.test(token)) continue;
    if (!isTwelveDigitId(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    ids.push(token);
  }
  return ids;
}

/**
 * Return the numeric minutes portion of an exam duration (e.g. `30 minutes` -> `30`).
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeExamDuration(value) {
  const text = csvCellStr(value);
  if (!text) return '';
  const match = text.match(/\d+/);
  return match ? match[0] : text;
}

/**
 * @param {Record<string, string>} slide
 * @param {{ context?: string }} [opts]
 * @returns {[string, string[]]}
 */
export function resolveExamMarkerDuration(slide, { context = '' } = {}) {
  const errors = [];
  const prefix = context ? `${context}: ` : '';
  const values = [];
  for (const key of ['duration', 'ar_duration', 'en_duration']) {
    const val = csvCellStr(slide[key]);
    if (val) values.push([key, val]);
  }
  if (!values.length) {
    errors.push(`${prefix}exam marker must include duration, ar_duration, or en_duration.`);
    return ['', errors];
  }
  const normalized = values.map(([key, val]) => [key, normalizeExamDuration(val)]);
  const uniqueVals = new Set(normalized.map(([, val]) => val).filter(Boolean));
  if (uniqueVals.size > 1) {
    const detail = values.map(([key, val]) => `${key}='${val}'`).join(', ');
    errors.push(`${prefix}conflicting exam marker durations (${detail}).`);
    return ['', errors];
  }
  if (!uniqueVals.size) {
    errors.push(`${prefix}exam marker duration must include a numeric minutes value.`);
    return ['', errors];
  }
  return [[...uniqueVals][0], errors];
}

/**
 * @param {Record<string, string>} slide
 * @param {{ context?: string }} [opts]
 * @returns {[Record<string, string>, string[]]}
 */
export function resolveBilingualExamMarkerFields(slide, { context = '' } = {}) {
  const errors = [];
  const prefix = context ? `${context}: ` : '';

  const examTitle = csvCellStr(slide.exam_title);
  const arTitle = csvCellStr(slide.ar_exam_title);
  const enTitle = csvCellStr(slide.en_exam_title);
  if (!examTitle && !(arTitle && enTitle)) {
    errors.push(
      `${prefix}exam marker must include exam_title or both ar_exam_title and en_exam_title.`,
    );
  }

  const [resolvedDuration, durErrors] = resolveExamMarkerDuration(slide, { context });
  errors.push(...durErrors);

  let examId = csvCellStr(slide.exam_id);
  if (!examId) {
    examId = csvCellStr(slide.ar_exam_id) || csvCellStr(slide.en_exam_id);
  }

  return [{
    exam_title: examTitle || arTitle,
    ar_exam_title: arTitle || examTitle,
    en_exam_title: enTitle || examTitle,
    duration: resolvedDuration,
    ar_duration: resolvedDuration,
    en_duration: resolvedDuration,
    exam_id: examId,
    ar_exam_id: csvCellStr(slide.ar_exam_id) || examId,
    en_exam_id: csvCellStr(slide.en_exam_id) || examId,
  }, errors];
}

/**
 * @param {Record<string, string>} slide
 * @param {{ context?: string }} [opts]
 * @returns {[Record<string, string>, string[]]}
 */
export function resolveMonoExamMarkerFields(slide, { context = '' } = {}) {
  const errors = [];
  const prefix = context ? `${context}: ` : '';
  const examTitle = csvCellStr(slide.exam_title);
  const [resolvedDuration, durErrors] = resolveExamMarkerDuration(slide, { context });
  errors.push(...durErrors);
  if (!examTitle) {
    errors.push(`${prefix}exam marker must include exam_title.`);
  }
  return [{
    exam_title: examTitle,
    duration: resolvedDuration,
    exam_id: csvCellStr(slide.exam_id),
  }, errors];
}

export const KNOWN_PERMISSION_TAGS = new Set([
  'questionless_section',
  'mcq_free_percentage',
  'free_worksheet_question_count',
  'no_examples',
  'no_interactive_examples',
]);

const ICT_SUBJECTS_RULE40_EXEMPT = new Set([
  'تكنولوجيا المعلومات والاتصالات',
  'information and communication technology',
  'ict',
  'تكنولوجيا المعلومات والاتصالات (ict)',
  'information and communication technology (ict)',
]);

export const WORKSHEET_COUNT_BOUNDS = {
  1: [20, 40],
  2: [15, 25],
  3: [10, 20],
  4: [10, 15],
};

export const REGULAR_SECTION_MIN_EXAMPLE_SLIDES = 2;
export const REGULAR_SECTION_MIN_INTERACTIVE_EXAMPLE_SLIDES = 2;

export class PermissionContext {
  constructor() {
    this.sessionTags = new Set();
    /** @type {Map<string, Set<string>>} */
    this.sectionTags = new Map();
  }

  hasSessionPermission(tag) {
    return this.sessionTags.has(tag);
  }

  hasSectionPermission(sectionId, tag) {
    return this.sectionTags.get(csvCellStr(sectionId))?.has(tag) ?? false;
  }
}

/**
 * @param {string[][]} rows
 * @returns {[Map<string, PermissionContext>, string[]]}
 */
export function skippingValidationsFromSheetRows(rows) {
  /** @type {Map<string, PermissionContext>} */
  const byMeta = new Map();
  const errors = [];
  if (!rows?.length) return [byMeta, errors];

  const start = rows[0] && csvCellStr(rows[0][0]).toLowerCase() === 'metasession_id' ? 1 : 0;
  for (const row of rows.slice(start)) {
    if (!row?.length) continue;
    const metaId = csvCellStr(row[0]);
    const sectionId = csvCellStr(row[1]);
    const tag = csvCellStr(row[2]);
    if (!metaId || !tag) continue;
    if (!KNOWN_PERMISSION_TAGS.has(tag)) {
      errors.push(`Unknown permission_tag '${tag}' for metasession_id '${metaId}'.`);
      continue;
    }
    let ctx = byMeta.get(metaId);
    if (!ctx) {
      ctx = new PermissionContext();
      byMeta.set(metaId, ctx);
    }
    if (sectionId) {
      if (!ctx.sectionTags.has(sectionId)) ctx.sectionTags.set(sectionId, new Set());
      ctx.sectionTags.get(sectionId).add(tag);
    } else {
      ctx.sessionTags.add(tag);
    }
  }
  return [byMeta, errors];
}

/**
 * @param {Map<string, PermissionContext> | null | undefined} byMeta
 * @param {string} metasessionId
 * @returns {PermissionContext}
 */
export function permissionsForMetasession(byMeta, metasessionId) {
  if (!byMeta) return new PermissionContext();
  return byMeta.get(csvCellStr(metasessionId)) || new PermissionContext();
}

const BILINGUAL_EXAM_MARKER_KEYS = [
  'exam_title', 'duration', 'exam_id',
  'ar_exam_title', 'en_exam_title', 'ar_duration', 'en_duration',
  'ar_exam_id', 'en_exam_id',
];
const MONO_EXAM_MARKER_KEYS = ['exam_id', 'exam_title', 'duration'];

export function isBilingualExamMarkerSlide(slide) {
  if (csvCellStr(slide?.question_id)) return false;
  if (csvCellStr(slide?.ar_section_title) || csvCellStr(slide?.en_section_title)) return false;
  return BILINGUAL_EXAM_MARKER_KEYS.some((key) => csvCellStr(slide?.[key]));
}

export function isMonoExamMarkerSlide(slide) {
  if (csvCellStr(slide?.question_id)) return false;
  if (csvCellStr(slide?.section_title)) return false;
  return MONO_EXAM_MARKER_KEYS.some((key) => csvCellStr(slide?.[key]));
}

export function bilingualExamMarkerPurityErrors(slide, { context = '' } = {}) {
  const prefix = context ? `${context}: ` : '';
  const errors = [];
  const forbidden = {
    question_id: 'question_id',
    question_role: 'question_role',
    ar_slide_id: 'ar_slide_id',
    en_slide_id: 'en_slide_id',
    slide_id: 'slide_id',
    ar_video_id: 'ar_video_id',
    en_video_id: 'en_video_id',
    video_id: 'video_id',
    activity_id: 'activity_id',
    ar_section_id: 'ar_section_id',
    en_section_id: 'en_section_id',
    section_id: 'section_id',
    ar_section_title: 'ar_section_title',
    en_section_title: 'en_section_title',
    section_title: 'section_title',
  };
  for (const [key, label] of Object.entries(forbidden)) {
    if (csvCellStr(slide?.[key])) {
      errors.push(`${prefix}exam marker slide must not include ${label}.`);
    }
  }
  return errors;
}

export function monoExamMarkerPurityErrors(slide, { context = '' } = {}) {
  const prefix = context ? `${context}: ` : '';
  const errors = [];
  for (const key of [
    'question_id', 'question_role', 'slide_id', 'video_id', 'activity_id',
    'section_id', 'section_title', 'slide_title',
  ]) {
    if (csvCellStr(slide?.[key])) {
      errors.push(`${prefix}exam marker slide must not include ${key}.`);
    }
  }
  return errors;
}

/**
 * @param {Record<string, string>[]} rows
 * @param {string} courseType
 * @returns {[Record<string, string>, string[]]}
 */
export function collectRegularSectionsFromRows(rows, courseType) {
  const typesBySection = {};
  const errors = [];
  for (const row of rows) {
    if (isStructuralSessionRow(row)) continue;
    const sid = csvCellStr(row.section_id);
    if (!isSectionId(sid) || typesBySection[sid]) continue;
    const [resolved, rowErrors] = sectionTypeForCourseType(courseType, row.section_type);
    const sn = csvCellStr(row.slide_number) || '?';
    for (const err of rowErrors) errors.push(`Slide ${sn}: ${err}`);
    if (resolved) typesBySection[sid] = resolved;
  }
  const regular = Object.fromEntries(
    Object.entries(typesBySection).filter(([, st]) => st === 'regular'),
  );
  return [regular, errors];
}

/** @returns {string[]} */
export function validateRegularSectionCount(xmlMetasessionType, regularSections) {
  if (csvCellStr(xmlMetasessionType).toLowerCase() !== 'regular') return [];
  const count = Object.keys(regularSections).length;
  if (count < 1 || count > 4) {
    return [`Regular session must have between 1 and 4 regular sections; found ${count}.`];
  }
  return [];
}

/**
 * @param {Record<string, string>[]} rows
 * @param {string} courseType
 * @returns {[Record<string, string>, string[]]}
 */
export function collectAllSectionsFromRows(rows, courseType) {
  const typesBySection = {};
  const errors = [];
  for (const row of rows) {
    if (isStructuralSessionRow(row)) continue;
    const sid = csvCellStr(row.section_id);
    if (!isSectionId(sid) || typesBySection[sid]) continue;
    const [resolved, rowErrors] = sectionTypeForCourseType(courseType, row.section_type);
    const sn = csvCellStr(row.slide_number) || '?';
    for (const err of rowErrors) errors.push(`Slide ${sn}: ${err}`);
    if (resolved) typesBySection[sid] = resolved;
  }
  return [typesBySection, errors];
}

/** @returns {Record<string, string>} */
export function collectAllSectionsFromXml(root) {
  const sections = {};
  for (const section of [...root.querySelectorAll('section')]) {
    const sid = csvCellStr(section.getAttribute('section_id'));
    const stype = csvCellStr(section.getAttribute('section_type')).toLowerCase();
    if (sid) sections[sid] = stype || 'unknown';
  }
  return sections;
}

/** @returns {string[]} */
export function validateTotalSectionCount(sections) {
  const count = Object.keys(sections || {}).length;
  if (count < 1 || count > 4) {
    return [`Session must have between 1 and 4 sections; found ${count}.`];
  }
  return [];
}

export function countWorksheetQuestionsForSectionRows(rows, sectionId) {
  let count = 0;
  for (const row of rows) {
    if (csvCellStr(row.section_id) !== sectionId) continue;
    if (isWorksheetQuestionRow(row)) count += 1;
  }
  return count;
}

/**
 * @param {Record<string, string>} regularSections
 * @param {Record<string, string>[]} rows
 * @param {PermissionContext | null} [permissions]
 * @returns {string[]}
 */
export function validateRegularSectionWorksheetCounts(regularSections, rows, permissions = null) {
  if (!regularSections || !Object.keys(regularSections).length) return [];
  const bounds = WORKSHEET_COUNT_BOUNDS[Object.keys(regularSections).length];
  if (!bounds) return [];
  const [minQ, maxQ] = bounds;
  const errors = [];
  const perms = permissions || new PermissionContext();
  for (const sid of Object.keys(regularSections)) {
    if (
      perms.hasSectionPermission(sid, 'questionless_section')
      || perms.hasSectionPermission(sid, 'free_worksheet_question_count')
    ) continue;
    const count = countWorksheetQuestionsForSectionRows(rows, sid);
    if (count === 0) {
      errors.push(`section ${sid}: regular section must have a worksheet with questions.`);
    } else if (count < minQ || count > maxQ) {
      errors.push(
        `section ${sid}: worksheet has ${count} question(s); `
        + `expected ${minQ}–${maxQ} for ${Object.keys(regularSections).length} regular section(s).`,
      );
    }
  }
  return errors;
}

/**
 * @param {Record<string, string>} regularSections
 * @param {Record<string, string>[]} rows
 * @param {PermissionContext | null} [permissions]
 * @returns {string[]}
 */
export function validateRegularSectionLiveRoles(regularSections, rows, permissions = null) {
  const errors = [];
  const perms = permissions || new PermissionContext();
  for (const sid of Object.keys(regularSections)) {
    if (perms.hasSectionPermission(sid, 'questionless_section')) continue;
    let exampleCount = 0;
    let interactiveCount = 0;
    for (const row of rows) {
      if (csvCellStr(row.section_id) !== sid) continue;
      const role = liveSlideRoleFromRow(row);
      if (role === 'example') exampleCount += 1;
      else if (role === 'interactive_example') interactiveCount += 1;
    }
    if (exampleCount < REGULAR_SECTION_MIN_EXAMPLE_SLIDES && !perms.hasSectionPermission(sid, 'no_examples')) {
      errors.push(`section ${sid}: missing at least two example question slides.`);
    }
    if (
      interactiveCount < REGULAR_SECTION_MIN_INTERACTIVE_EXAMPLE_SLIDES
      && !perms.hasSectionPermission(sid, 'no_interactive_examples')
    ) {
      errors.push(`section ${sid}: missing at least two interactive_example question slides.`);
    }
  }
  return errors;
}

export function isRule40Exempt(grade, subject) {
  const g = Number.parseInt(normalizeGradeForXml(grade), 10);
  if ([10, 11, 12].includes(g)) return true;
  return ICT_SUBJECTS_RULE40_EXEMPT.has(csvCellStr(subject).toLowerCase());
}

function rule40BucketForRole(role) {
  let normalized = normalizeQuestionRole(role);
  if (normalized === 'interactive') normalized = 'interactive_example';
  if (RULE40_LIVE_ROLES.has(normalized)) return 'live';
  if (RULE40_WORKSHEET_ROLES.has(normalized)) return 'worksheet';
  return null;
}

/**
 * @param {string} xmlMetasessionType
 * @param {Record<string, string>[]} rows
 * @param {Map<string, object>|Record<string, object>} metadataById
 * @param {{ grade?: string, subject?: string, permissions?: PermissionContext | null }} [opts]
 * @returns {string[]}
 */
export function validateRule40_60Mcq(
  xmlMetasessionType,
  rows,
  metadataById,
  { grade = '', subject = '', permissions = null } = {},
) {
  if (csvCellStr(xmlMetasessionType).toLowerCase() !== 'regular') return [];
  const perms = permissions || new PermissionContext();
  if (perms.hasSessionPermission('mcq_free_percentage')) return [];
  if (isRule40Exempt(grade, subject)) return [];

  let liveTotal = 0;
  let liveMcq = 0;
  let worksheetTotal = 0;
  let worksheetMcq = 0;
  for (const row of rows) {
    const qid = csvCellStr(row.question_id);
    if (!qid || !isTwelveDigitId(qid)) continue;
    const bucket = rule40BucketForRole(row.question_role);
    if (!bucket) continue;
    const qType = questionTypeFromMetadata(qid, metadataById);
    if (!qType) continue;
    if (bucket === 'live') {
      liveTotal += 1;
      if (qType === 'mcq') liveMcq += 1;
    } else {
      worksheetTotal += 1;
      if (qType === 'mcq') worksheetMcq += 1;
    }
  }

  const errors = [];
  const total = liveTotal + worksheetTotal;
  const mcq = liveMcq + worksheetMcq;
  if (total > 0 && mcq / total >= 0.6) {
    const pct = Math.round((100 * mcq) / total * 10) / 10;
    const nonMcq = total - mcq;
    const nonPct = Math.round((100 * nonMcq) / total * 10) / 10;
    errors.push(
      `MCQ share is ${pct}% (${mcq}/${total}); must be less than 60% `
      + `(non-MCQ must be at least 40%; currently ${nonPct}%).`,
    );
  }
  if (liveTotal > 0 && liveMcq === liveTotal) {
    errors.push(
      `Live question slides have 0% non-MCQ (${liveMcq}/${liveTotal} MCQ); `
      + 'at least one non-MCQ live question is required.',
    );
  }
  if (worksheetTotal > 0 && worksheetMcq === worksheetTotal) {
    errors.push(
      `Worksheet questions have 0% non-MCQ (${worksheetMcq}/${worksheetTotal} MCQ); `
      + 'at least one non-MCQ practice question is required.',
    );
  }
  return errors;
}

export function validateRevisionExamPresence(xmlMetasessionType, rows) {
  if (csvCellStr(xmlMetasessionType).toLowerCase() !== 'revision') return [];
  let afterThankYou = false;
  for (const row of rows) {
    if (isThankYouRow(row)) {
      afterThankYou = true;
      continue;
    }
    if (!afterThankYou) continue;
    const role = csvCellStr(row.question_role).toLowerCase().replace(/ /g, '_');
    if (role === 'exam' && csvCellStr(row.question_id)) return [];
  }
  return ['exam required by session type/section_type but no exam source was found in PPTX.'];
}

/** @returns {Record<string, string>} */
export function collectRegularSectionsFromXml(root) {
  const regular = {};
  for (const section of [...root.querySelectorAll('section')]) {
    const sid = csvCellStr(section.getAttribute('section_id'));
    const stype = csvCellStr(section.getAttribute('section_type')).toLowerCase();
    if (sid && stype === 'regular') regular[sid] = stype;
  }
  return regular;
}

export function countWorksheetQuestionsForSectionXml(section) {
  let count = 0;
  for (const child of [...section.children]) {
    if (child.tagName === 'worksheet') {
      count += child.querySelectorAll(':scope > question').length;
    }
  }
  return count;
}

export function validateRegularSectionWorksheetCountsXml(
  regularSections,
  root,
  permissions = null,
) {
  if (!regularSections || !Object.keys(regularSections).length) return [];
  const bounds = WORKSHEET_COUNT_BOUNDS[Object.keys(regularSections).length];
  if (!bounds) return [];
  const [minQ, maxQ] = bounds;
  const errors = [];
  const perms = permissions || new PermissionContext();
  for (const section of [...root.querySelectorAll('section')]) {
    const sid = csvCellStr(section.getAttribute('section_id'));
    if (!(sid in regularSections)) continue;
    if (
      perms.hasSectionPermission(sid, 'questionless_section')
      || perms.hasSectionPermission(sid, 'free_worksheet_question_count')
    ) continue;
    const count = countWorksheetQuestionsForSectionXml(section);
    if (count === 0) {
      errors.push(`section ${sid}: regular section must have a worksheet with questions.`);
    } else if (count < minQ || count > maxQ) {
      errors.push(
        `section ${sid}: worksheet has ${count} question(s); `
        + `expected ${minQ}–${maxQ} for ${Object.keys(regularSections).length} regular section(s).`,
      );
    }
  }
  return errors;
}

export function validateRegularSectionLiveRolesXml(regularSections, root, permissions = null) {
  const errors = [];
  const perms = permissions || new PermissionContext();
  for (const section of [...root.querySelectorAll('section')]) {
    const sid = csvCellStr(section.getAttribute('section_id'));
    if (!(sid in regularSections)) continue;
    if (perms.hasSectionPermission(sid, 'questionless_section')) continue;
    let exampleCount = 0;
    let interactiveCount = 0;
    for (const slide of [...section.querySelectorAll('slide')]) {
      if (slide.getAttribute('slide_category') !== 'question') continue;
      const role = csvCellStr(slide.getAttribute('slide_role')).toLowerCase().replace(/ /g, '_');
      if (role === 'example') exampleCount += 1;
      else if (role === 'interactive_example') interactiveCount += 1;
    }
    if (exampleCount < REGULAR_SECTION_MIN_EXAMPLE_SLIDES && !perms.hasSectionPermission(sid, 'no_examples')) {
      errors.push(`section ${sid}: missing at least two example question slides.`);
    }
    if (
      interactiveCount < REGULAR_SECTION_MIN_INTERACTIVE_EXAMPLE_SLIDES
      && !perms.hasSectionPermission(sid, 'no_interactive_examples')
    ) {
      errors.push(`section ${sid}: missing at least two interactive_example question slides.`);
    }
  }
  return errors;
}

function xmlQuestionRowsForRule40(root) {
  const rows = [];
  for (const slide of [...root.querySelectorAll('slide')]) {
    if (slide.getAttribute('slide_category') !== 'question') continue;
    const qid = csvCellStr(slide.getAttribute('question_id'));
    if (!qid) continue;
    let role = csvCellStr(slide.getAttribute('slide_role')).toLowerCase().replace(/ /g, '_');
    if (role === 'interactive') role = 'interactive_example';
    if (RULE40_LIVE_ROLES.has(role)) {
      rows.push({ question_id: qid, question_role: role });
    }
  }
  for (const question of [...root.querySelectorAll('worksheet > question')]) {
    const qid = csvCellStr(question.getAttribute('question_id'));
    if (qid) rows.push({ question_id: qid, question_role: 'practice' });
  }
  return rows;
}

/** @returns {string[]} */
export function validateQuestionIdUniqueness(rows) {
  /** @type {Record<string, string[]>} */
  const locations = {};
  rows.forEach((row, i) => {
    const qid = csvCellStr(row.question_id);
    if (!qid || !isTwelveDigitId(qid)) return;
    const sn = csvCellStr(row.slide_number) || String(i + 1);
    if (!locations[qid]) locations[qid] = [];
    locations[qid].push(sn);
  });
  const errors = [];
  for (const qid of Object.keys(locations).sort()) {
    if (locations[qid].length > 1) {
      errors.push(`Duplicate question_id '${qid}' found on slides: ${locations[qid].join(', ')}.`);
    }
  }
  return errors;
}

/** @returns {string[]} */
export function validateQuestionIdUniquenessFromXml(root) {
  /** @type {Record<string, string[]>} */
  const locations = {};
  const add = (qid, label) => {
    if (qid && isTwelveDigitId(qid)) {
      if (!locations[qid]) locations[qid] = [];
      locations[qid].push(label);
    }
  };
  for (const slide of [...root.querySelectorAll('slide')]) {
    if (slide.getAttribute('slide_category') !== 'question') continue;
    const qid = csvCellStr(slide.getAttribute('question_id'));
    const sn = csvCellStr(slide.getAttribute('slide_number')) || '?';
    add(qid, `live slide ${sn}`);
  }
  for (const question of [...root.querySelectorAll('worksheet > question')]) {
    add(csvCellStr(question.getAttribute('question_id')), 'worksheet');
  }
  for (const question of [...root.querySelectorAll('exam > question')]) {
    add(csvCellStr(question.getAttribute('question_id')), 'exam');
  }
  const errors = [];
  for (const qid of Object.keys(locations).sort()) {
    if (locations[qid].length > 1) {
      errors.push(`Duplicate question_id '${qid}' found at: ${locations[qid].join(', ')}.`);
    }
  }
  return errors;
}

export function sessionDurationFromApiData(apiData) {
  if (!apiData) return null;
  const raw = apiData.duration;
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

export function sessionDurationFromCsvRows(rows) {
  if (!rows) return null;
  for (const row of rows) {
    const raw = csvCellStr(row.session_duration);
    if (!raw) continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

/**
 * @returns {[number|null, string[]]}
 */
export function resolveSessionDurationMinutes({
  apiData = null,
  rows = null,
  sessionDurationFallback = null,
} = {}) {
  const apiDuration = sessionDurationFromApiData(apiData);
  if (apiDuration != null) return [apiDuration, []];
  const csvDuration = sessionDurationFromCsvRows(rows);
  if (csvDuration != null) return [csvDuration, []];
  if (sessionDurationFallback != null && String(sessionDurationFallback).trim()) {
    const value = Number(sessionDurationFallback);
    if (Number.isFinite(value) && value > 0) return [value, []];
  }
  return [null, [SESSION_DURATION_MISSING_MSG]];
}

export function countSlidesForDurationFromXml(root) {
  let count = 0;
  for (const slide of [...root.querySelectorAll('slide')]) {
    const role = csvCellStr(slide.getAttribute('slide_role')).toLowerCase().replace(/ /g, '_');
    if (SLIDE_DURATION_EXCLUDED_ROLES.has(role)) continue;
    const title = csvCellStr(slide.getAttribute('slide_title'));
    if (title === 'Well Done!' || isWellDoneTitle(title)) continue;
    count += 1;
  }
  return count;
}

export function countSlidesForDurationFromRows(rows) {
  let count = 0;
  for (const row of rows) {
    if (!csvCellStr(row.slide_id)) continue;
    const sn = csvCellStr(row.slide_number);
    if (sn === '1' || sn === '2') continue;
    const sectionTitle = csvCellStr(row.section_title);
    const slideTitle = csvCellStr(row.slide_title);
    if (isThankYouTitle(sectionTitle) || isThankYouTitle(slideTitle)) continue;
    if (
      slideTitle === 'Well Done!'
      || isWellDoneTitle(slideTitle)
      || isWellDoneTitle(sectionTitle)
    ) continue;
    count += 1;
  }
  return count;
}

export function validateSlideDuration({
  durationMinutes = null,
  slideCount = 0,
  missingErrors = null,
} = {}) {
  const errors = [...(missingErrors || [])];
  if (durationMinutes == null) return errors;
  if (slideCount <= 0) {
    errors.push(
      'Cannot compute slide_duration: no countable content slides found '
      + '(excluding title, toc, thank_you, and Well Done!).',
    );
    return errors;
  }
  const slideDuration = durationMinutes / slideCount;
  if (slideDuration < 1) {
    errors.push(
      `slide_duration is ${slideDuration.toFixed(2)} minutes `
      + `(${durationMinutes} / ${slideCount} slides); must be at least 1 minute.`,
    );
  }
  return errors;
}

export function validateSlideDurationFromRows(rows, { apiData = null } = {}) {
  const [duration, missing] = resolveSessionDurationMinutes({ apiData, rows });
  return validateSlideDuration({
    durationMinutes: duration,
    slideCount: countSlidesForDurationFromRows(rows),
    missingErrors: missing,
  });
}

export function validateSlideDurationFromXml(root, {
  apiData = null,
  sessionDurationFallback = null,
} = {}) {
  const [duration, missing] = resolveSessionDurationMinutes({
    apiData,
    sessionDurationFallback,
  });
  return validateSlideDuration({
    durationMinutes: duration,
    slideCount: countSlidesForDurationFromXml(root),
    missingErrors: missing,
  });
}

/**
 * @param {Element} root
 * @param {{ xmlMetasessionType: string, metadataById?: Map<string, object> | null, grade?: string, subject?: string, permissions?: PermissionContext | null, apiData?: object | null, sessionDurationFallback?: string|number|null }} opts
 * @returns {string[]}
 */
export function validateSessionContentRulesFromXml(
  root,
  {
    xmlMetasessionType,
    metadataById = null,
    grade = '',
    subject = '',
    permissions = null,
    apiData = null,
    sessionDurationFallback = null,
  },
) {
  const regularSections = collectRegularSectionsFromXml(root);
  const allSections = collectAllSectionsFromXml(root);
  const errors = validateTotalSectionCount(allSections);
  errors.push(...validateQuestionIdUniquenessFromXml(root));
  errors.push(...validateRegularSectionWorksheetCountsXml(regularSections, root, permissions));
  errors.push(...validateRegularSectionLiveRolesXml(regularSections, root, permissions));
  if (metadataById) {
    errors.push(...validateRule40_60Mcq(
      xmlMetasessionType,
      xmlQuestionRowsForRule40(root),
      metadataById,
      { grade, subject, permissions },
    ));
  }
  errors.push(...validateSlideDurationFromXml(root, {
    apiData,
    sessionDurationFallback,
  }));
  return errors;
}

/**
 * @param {Record<string, string>[]} rows
 * @param {{ courseType: string, xmlMetasessionType: string, metadataById?: Map<string, object> | null, grade?: string, subject?: string, permissions?: PermissionContext | null, apiData?: object | null }} opts
 * @returns {string[]}
 */
export function validateSessionContentRules(
  rows,
  {
    courseType,
    xmlMetasessionType,
    metadataById = null,
    grade = '',
    subject = '',
    permissions = null,
    apiData = null,
  },
) {
  const [regularSections, typeErrors] = collectRegularSectionsFromRows(rows, courseType);
  const [allSections, allTypeErrors] = collectAllSectionsFromRows(rows, courseType);
  const errors = [...typeErrors, ...allTypeErrors];
  errors.push(...validateRevisionExamPresence(xmlMetasessionType, rows));
  errors.push(...validateTotalSectionCount(allSections));
  errors.push(...validateQuestionIdUniqueness(rows));
  errors.push(...validateRegularSectionWorksheetCounts(regularSections, rows, permissions));
  errors.push(...validateRegularSectionLiveRoles(regularSections, rows, permissions));
  if (metadataById) {
    errors.push(...validateRule40_60Mcq(
      xmlMetasessionType,
      rows,
      metadataById,
      { grade, subject, permissions },
    ));
  }
  errors.push(...validateSlideDurationFromRows(rows, { apiData }));
  return errors;
}

export function isStructuralSessionRow(row) {
  const title = csvCellStr(row.section_title);
  if (isThankYouTitle(title) || isRecapTitle(title) || isWellDoneTitle(title)) return true;
  return ['1', '2'].includes(csvCellStr(row.slide_number));
}

/**
 * @returns {[string[], string[]]}
 */
export function collectContentSectionTypesFromRows(rows, courseType) {
  const errors = [];
  const typesBySection = {};

  for (const row of rows) {
    if (isStructuralSessionRow(row)) continue;
    const sid = csvCellStr(row.section_id);
    if (!isSectionId(sid) || typesBySection[sid]) continue;
    const [resolved, rowErrors] = sectionTypeForCourseType(courseType, row.section_type);
    const sn = csvCellStr(row.slide_number) || '?';
    for (const err of rowErrors) errors.push(`Slide ${sn}: ${err}`);
    if (resolved) typesBySection[sid] = resolved;
  }

  return [Object.values(typesBySection), errors];
}

/**
 * @returns {[string|null, string[]]}
 */
export function xmlMetasessionTypeForCourseType(courseType, sectionTypes) {
  const key = courseTypeKey(courseType);
  if (!key) return [null, ['Metasession API did not return metasession_type.']];
  if (!SUPPORTED_METASESSION_TYPE_LABELS.has(key)) {
    return [null, [`The session type is '${metasessionTypeLabel(courseType)}' and the tool doesn't handle this type till now.`]];
  }
  if (key === 'foundation') return ['foundation', []];
  if (key === 'final revision') return ['revision', []];
  if (key === 'full curriculum') {
    if (!sectionTypes.length) return [null, ['Full Curriculum session has no content sections.']];
    if (sectionTypes.every((st) => st === 'revision')) return ['revision', []];
    return ['regular', []];
  }
  return [null, [`Unsupported course_type '${courseType}'.`]];
}

/**
 * @returns {[string|null, string[]]}
 */
export function computedMetasessionTypeForSession(courseType, rows) {
  const [sectionTypes, secErrors] = collectContentSectionTypesFromRows(rows, courseType);
  if (secErrors.length) return [null, secErrors];
  return xmlMetasessionTypeForCourseType(courseType, sectionTypes);
}

/**
 * @param {string} courseType
 * @param {{ slides?: Record<string, string>[], csvRows?: Record<string, string>[] }} [sources]
 * @returns {string[]}
 */
export function validateSectionTypesForCourseType(courseType, { slides = null, csvRows = null } = {}) {
  const errors = [];
  const inspect = (label, item) => {
    const raw = csvCellStr(item.section_type);
    if (!raw) return;
    for (const err of validatePptxSectionTypeForCourseType(courseType, raw)) {
      errors.push(`${label}: ${err}`);
    }
  };

  if (slides) {
    for (const slide of slides) {
      inspect(`Slide ${csvCellStr(slide.slide_number) || '?'}`, slide);
    }
  }
  if (csvRows) {
    for (const row of csvRows) {
      inspect(`Slide ${csvCellStr(row.slide_number) || '?'}`, row);
    }
  }
  return errors;
}

/** @returns {string[]} */
export function validateXmlMetasessionTypeSupported(value) {
  const label = csvCellStr(value).toLowerCase();
  if (!label) return ['<metasession> missing metasession_type.'];
  if (!XML_METASESSION_TYPES.has(label)) {
    return [`metasession_type must be one of regular, revision, foundation; got '${value}'.`];
  }
  return [];
}

/** @returns {string[]} */
export function validateSectionsForXmlMetasessionType(xmlMetasessionType, sectionTypes, { sectionIds = null } = {}) {
  const xmlType = csvCellStr(xmlMetasessionType).toLowerCase();
  const errors = [];
  sectionTypes.forEach((stype, idx) => {
    const sid = sectionIds && idx < sectionIds.length ? sectionIds[idx] : '?';
    const stLower = csvCellStr(stype).toLowerCase();
    if (xmlType === 'regular') {
      if (!['regular', 'revision'].includes(stLower)) {
        errors.push(`section ${sid}: section_type must be regular or revision; got '${stype}'.`);
      }
    } else if (xmlType === 'revision') {
      if (stLower !== 'revision') {
        errors.push(`section ${sid}: section_type must be 'revision' for revision session; got '${stype}'.`);
      }
    } else if (xmlType === 'foundation') {
      if (stLower !== 'foundation') {
        errors.push(`section ${sid}: section_type must be 'foundation' for foundation session; got '${stype}'.`);
      }
    }
  });
  return errors;
}

export function allowedPptxMtypesForXmlMetasessionType(xmlMetasessionType, courseType) {
  const xmlType = csvCellStr(xmlMetasessionType).toLowerCase();
  const courseKey = courseTypeKey(courseType);
  if (xmlType === 'regular') return new Set(['regular']);
  if (xmlType === 'revision') {
    const allowed = new Set(['revision']);
    if (courseKey === 'final revision') allowed.add('final revision');
    return allowed;
  }
  if (xmlType === 'foundation') return new Set(['foundation']);
  return new Set();
}

/** Allowed PPTX filename <mtype> tokens matched directly against API course_type. */
export function allowedPptxMtypesForCourseType(courseType) {
  const courseKey = courseTypeKey(courseType);
  if (courseKey === 'full curriculum') {
    return new Set(['full curriculum', 'full_curriculum', 'regular']);
  }
  if (courseKey === 'final revision') {
    return new Set(['final revision', 'final_revision', 'revision']);
  }
  if (courseKey === 'foundation') return new Set(['foundation']);
  return new Set();
}

export function normalizePptxMtypeToken(value) {
  return csvCellStr(value).toLowerCase();
}

/** Match PPTX filename <mtype> directly to Metasession API course_type. */
export function validatePptxMtypeAgainstCourseType(courseType, mtype) {
  const courseKey = courseTypeKey(courseType);
  if (!courseKey) {
    return [`type '${mtype}': could not resolve course_type from API.`];
  }
  const allowed = allowedPptxMtypesForCourseType(courseType);
  if (!allowed.size) {
    return [
      `type '${mtype}': unsupported course_type '${courseType}' for PPTX filename matching.`,
    ];
  }
  const fileType = normalizePptxMtypeToken(mtype);
  const allowedNormalized = new Set([...allowed].map(normalizePptxMtypeToken));
  if (!allowedNormalized.has(fileType)) {
    const allowedText = [...allowed].sort().join(', ');
    return [
      `type '${mtype}' does not match course_type '${courseType}' (allowed: ${allowedText}).`,
    ];
  }
  return [];
}

/** @returns {string[]} */
export function validatePptxMtypeForSession(courseType, sectionTypes, mtype) {
  const [xmlType, metaErrors] = xmlMetasessionTypeForCourseType(courseType, sectionTypes);
  if (metaErrors.length) return metaErrors;
  const fileType = csvCellStr(mtype).toLowerCase();
  const allowed = allowedPptxMtypesForXmlMetasessionType(xmlType, courseType);
  if (!allowed.has(fileType)) {
    const allowedText = [...allowed].sort().join(', ');
    return [`type '${mtype}' does not match computed session kind '${xmlType}' (allowed: ${allowedText}).`];
  }
  return [];
}

/** Revision/foundation sessions skip exact question-id cross-checks. */
export function skipSectionQuestionValidationForSession(xmlMetasessionType) {
  return ['revision', 'foundation'].includes(csvCellStr(xmlMetasessionType).toLowerCase());
}

export const NEW_MODE_CSV_COLUMNS = [
  'slide_number', 'slide_id', 'section_id', 'section_title', 'question_id',
  'question_placement', 'required_correct', 'attempt_window',
  'homework', 'section_gp', 'video_id', 'video_thumbnail_ts', 'activity_id', 'verbatim',
  'metasession_id', 'metasession_number', 'metasession_type', 'grade', 'term', 'subject',
  'language', 'country', 'numerals', 'duration', 'session_duration',
  'section_type', 'question_role', 'exam_id', 'exam_title',
  'verbatim_listening', 'verbatim_multipart', 'verbatim_number',
];

export function dictRowsFromNewModeLists(rows) {
  return rows.map((row) => {
    const item = {};
    NEW_MODE_CSV_COLUMNS.forEach((col, idx) => {
      item[col] = csvCellStr(row[idx]);
    });
    return item;
  });
}

export function applyComputedMetasessionTypeToNewModeRows(rows, computedType) {
  const colIdx = NEW_MODE_CSV_COLUMNS.indexOf('metasession_type');
  if (colIdx < 0) return;
  for (const row of rows) {
    if (csvCellStr(row[0]) === '1' && row.length > colIdx) {
      row[colIdx] = computedType;
      break;
    }
  }
}

export function monoRowsFromBilingualSlides(slides, langPrefix) {
  const idKey = `${langPrefix}_section_id`;
  const titleKey = `${langPrefix}_section_title`;
  const slideTitleKey = `${langPrefix}_slide_title`;
  return slides.map((slide) => {
    const [resolved] = resolveSectionTypeFromSlide(slide, { bilingual: true });
    return {
      slide_number: csvCellStr(slide.slide_number),
      section_id: csvCellStr(slide[idKey]),
      section_title: csvCellStr(slide[titleKey] || slide[slideTitleKey]),
      section_type: resolved,
    };
  });
}

export const SUPPORTED_METASESSION_TYPE_LABELS = new Set(['full curriculum', 'final revision', 'foundation']);

export function metasessionTypeLabel(raw) {
  return csvCellStr(raw);
}

/** @returns {string[]} */
export function validateMetasessionTypeSupported(metasessionType) {
  const label = metasessionTypeLabel(metasessionType);
  if (!label) return ['Metasession API did not return metasession_type.'];
  if (!SUPPORTED_METASESSION_TYPE_LABELS.has(label.toLowerCase())) {
    return [`The session type is '${label}' and the tool doesn't handle this type till now.`];
  }
  return [];
}

/** Extract plain integer grade from API title (e.g. EG07) or url_text (e.g. 7). */
export function normalizeGradeForXml(gradeRaw) {
  const raw = String(gradeRaw ?? '');
  const match = /\d+/.exec(raw);
  if (match) return String(parseInt(match[0], 10));
  return raw;
}

/** Raw API metasession_type without normalizing Full Curriculum to regular. */
export function courseTypeFromApiData(apiData) {
  return metasessionTypeLabel(apiData?.metasession_type);
}

/** Normalized grade digits from metasession API grade object only. */
export function gradeFromApiData(apiData) {
  const gradeObj = apiData?.grade || {};
  if (gradeObj.url_text != null && String(gradeObj.url_text).trim()) {
    return normalizeGradeForXml(String(gradeObj.url_text));
  }
  if (gradeObj.title) {
    return normalizeGradeForXml(String(gradeObj.title));
  }
  return '';
}

/** Term id string from metasession API term object only. */
export function termFromApiData(apiData) {
  const termObj = apiData?.term || {};
  if (typeof termObj === 'object' && termObj?.id != null) {
    return String(termObj.id);
  }
  return '';
}

/** Validation-only season lookup from API grade, term, and raw course_type. */
export function expectedSeason(grade, term, courseType) {
  const g = Number.parseInt(grade, 10);
  const t = Number.parseInt(term, 10);
  if (!Number.isFinite(g) || !Number.isFinite(t)) return null;

  const label = metasessionTypeLabel(courseType).toLowerCase();

  if (g >= 1 && g <= 11) {
    if (label === 'foundation') return '1';
    if (t === 0) return '1';
    if (t === 1 && label === 'full curriculum') return '2';
    if (t === 1 && label === 'final revision') return '3';
    if (t === 2 && label === 'full curriculum') return '4';
    if (t === 2 && label === 'final revision') return '5';
  }
  if (g === 12 && t === 0) {
    if (label === 'foundation') return '6';
    if (label === 'full curriculum') return '7';
    if (label === 'final revision') return '8';
  }
  return null;
}

/** @returns {string[]} */
export function validateSeasonFromApi(apiData, seasonValue = null) {
  const data = apiData || {};
  if (data.season == null || !csvCellStr(data.season)) {
    return ['Metasession API did not return season.'];
  }

  const courseType = courseTypeFromApiData(data);
  const grade = gradeFromApiData(data);
  const term = termFromApiData(data);
  const expected = expectedSeason(grade, term, courseType);
  const apiSeason = String(data.season);

  const errors = [];
  if (expected == null) {
    errors.push(
      `Cannot derive expected season for course_type '${courseType}', grade '${grade}', term '${term}'.`,
    );
  } else if (apiSeason !== expected) {
    errors.push(
      `API season '${apiSeason}' is inconsistent with grade/term/course_type (expected '${expected}').`,
    );
  }

  if (seasonValue != null && String(seasonValue) !== apiSeason) {
    errors.push(`season '${seasonValue}' does not match Metasession API season '${apiSeason}'.`);
  }

  return errors;
}

/** @returns {string[]} */
export function requireApiSeason(apiData) {
  return validateSeasonFromApi(apiData);
}

const UTF8_BOM = '\uFEFF';

function escapeCsvCell(val) {
  const s = val == null ? '' : String(val);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function parseCsvText(text) {
  const raw = text.startsWith(UTF8_BOM) ? text.slice(1) : text;
  const rows = [];
  let i = 0;
  const len = raw.length;

  function readCell() {
    if (i >= len) return '';
    if (raw[i] === '"') {
      i += 1;
      let cell = '';
      while (i < len) {
        if (raw[i] === '"') {
          if (raw[i + 1] === '"') { cell += '"'; i += 2; }
          else { i += 1; break; }
        } else { cell += raw[i]; i += 1; }
      }
      if (raw[i] === ',') i += 1;
      return cell;
    }
    const start = i;
    while (i < len && raw[i] !== ',' && raw[i] !== '\n' && raw[i] !== '\r') i += 1;
    const cell = raw.slice(start, i);
    if (raw[i] === ',') i += 1;
    return cell;
  }

  function readRow() {
    const cells = [];
    while (i < len && raw[i] !== '\n' && raw[i] !== '\r') {
      cells.push(readCell());
    }
    if (raw[i] === '\r') i += 1;
    if (raw[i] === '\n') i += 1;
    return cells;
  }

  const headers = readRow();
  while (i < len) {
    const cells = readRow();
    if (cells.length === 1 && cells[0] === '') continue;
    const row = {};
    for (let c = 0; c < headers.length; c += 1) {
      row[headers[c]] = cells[c] ?? '';
    }
    rows.push(row);
  }
  return { headers, rows };
}

export function rowsToCsv(columns, dataRows) {
  const lines = [columns.map(escapeCsvCell).join(',')];
  for (const row of dataRows) lines.push(row.map(escapeCsvCell).join(','));
  return UTF8_BOM + lines.join('\n');
}

export async function loadSessionRows(vfsOrPath, csvPathMaybe) {
  let vfs;
  let csvPath;
  if (typeof csvPathMaybe === 'string') {
    vfs = vfsOrPath;
    csvPath = csvPathMaybe;
  } else {
    csvPath = vfsOrPath;
    vfs = null;
  }

  const text = vfs
    ? await vfs.read(csvPath)
    : await (await fetch(csvPath)).text();
  const decoded = typeof text === 'string' ? text : new TextDecoder().decode(text);
  const { headers, rows } = parseCsvText(decoded);
  if (!headers.length) return [];

  return rows.map((raw) => {
    const row = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k) row[k.trim().toLowerCase()] = csvCellStr(v);
    }
    return row;
  });
}

export async function writeSessionRows(vfs, csvPath, rows, fieldnames) {
  let columns = fieldnames || (rows[0] ? Object.keys(rows[0]) : []);
  if (!fieldnames) {
    const seen = new Set(columns);
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (!seen.has(key)) {
          seen.add(key);
          columns.push(key);
        }
      }
    }
  }
  const dataRows = rows.map((row) => columns.map((col) => row[col] ?? row[col.toLowerCase()] ?? ''));
  await vfs.write(csvPath, rowsToCsv(columns, dataRows));
}

export async function findCsvForMetasession(metasessionId, vfs, csvsDir = 'csvs') {
  if (!metasessionId || !vfs?.list) return null;
  const files = await vfs.list(csvsDir);
  const matches = files
    .filter((f) => f.startsWith(`${metasessionId}`) && f.endsWith('.csv'))
    .sort();
  return matches[0] ? `${csvsDir}/${matches[0]}` : null;
}

export function getNumeralsFromRows(rows, defaultVal = 'european') {
  for (const row of rows) {
    const num = csvCellStr(row.numerals);
    if (num) return num.toLowerCase();
  }
  return defaultVal;
}

export function buildRowLookups(rows) {
  const byId = {};
  for (const row of rows) {
    const sn = csvCellStr(row.slide_number);
    if (!sn) continue;
    const sid = csvCellStr(row.slide_id);
    if (sid && sid.toLowerCase() !== 'new') byId[sid] = row;
    const qid = csvCellStr(row.question_id);
    if (qid) {
      byId[qid] = row;
      byId[formatQuestionPartId(qid)] = row;
    }
    const vid = csvCellStr(row.video_id);
    if (vid && vid.toLowerCase() !== 'new') byId[vid] = row;
    const aid = csvCellStr(row.activity_id);
    if (aid && aid.toLowerCase() !== 'new') byId[aid] = row;
  }
  return byId;
}

function slideNumberSortKey(row) {
  const sn = csvCellStr(row.slide_number);
  const parsed = parseInt(sn, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function buildRowsByLookupId(rows) {
  const byId = {};
  const sortedRows = rows
    .filter((row) => csvCellStr(row.slide_number))
    .sort((a, b) => slideNumberSortKey(a) - slideNumberSortKey(b));
  for (const row of sortedRows) {
    const keys = [];
    const sid = csvCellStr(row.slide_id);
    if (sid && sid.toLowerCase() !== 'new') keys.push(sid);
    const qid = csvCellStr(row.question_id);
    if (qid) {
      keys.push(qid);
      keys.push(formatQuestionPartId(qid));
    }
    const vid = csvCellStr(row.video_id);
    if (vid && vid.toLowerCase() !== 'new') keys.push(vid);
    const aid = csvCellStr(row.activity_id);
    if (aid && aid.toLowerCase() !== 'new') keys.push(aid);
    for (const key of [...new Set(keys)]) {
      if (!byId[key]) byId[key] = [];
      byId[key].push(row);
    }
  }
  return byId;
}

export function createOccurrenceRowLookup(rowsById, rowById) {
  const counters = {};
  return function lookupRow(element) {
    for (const attr of ['slide_id', 'question_id', 'video_id', 'activity_id']) {
      const val = csvCellStr(element.getAttribute(attr));
      if (!val) continue;
      const rowsList = rowsById[val];
      if (rowsList?.length) {
        const occ = counters[val] || 0;
        if (occ < rowsList.length) {
          counters[val] = occ + 1;
          return rowsList[occ];
        }
        continue;
      }
      if (rowById[val]) return rowById[val];
    }
    return null;
  };
}

export function iterSlidesDocumentOrder(root) {
  const slides = [];
  for (const element of root.children) {
    if (element.tagName === 'metasession_title') continue;
    if (element.tagName === 'slide') {
      if (!element.getAttribute('slide_number')) continue;
      slides.push(element);
    } else if (element.tagName === 'section') {
      for (const sub of element.children) {
        if (sub.tagName === 'slide') slides.push(sub);
        else if (sub.tagName === 'slide_group') {
          for (const groupChild of sub.children) {
            if (groupChild.tagName === 'slide') slides.push(groupChild);
          }
        }
      }
    } else if (element.tagName === 'section_group') {
      for (const child of element.children) {
        if (child.tagName === 'section_group_title') continue;
        if (child.tagName === 'section') {
          for (const sub of child.children) {
            if (sub.tagName === 'slide') slides.push(sub);
            else if (sub.tagName === 'slide_group') {
              for (const groupChild of sub.children) {
                if (groupChild.tagName === 'slide') slides.push(groupChild);
              }
            }
          }
        } else if (child.tagName === 'slide') {
          slides.push(child);
        } else if (child.tagName === 'slide_group') {
          for (const groupChild of child.children) {
            if (groupChild.tagName === 'slide') slides.push(groupChild);
          }
        }
      }
    }
  }
  return slides;
}

export function resolveSlideId(row) {
  const sid = csvCellStr(row.slide_id);
  if (sid && sid.toLowerCase() !== 'new') return sid;
  const qid = csvCellStr(row.question_id);
  if (qid) return qid;
  const vid = csvCellStr(row.video_id);
  if (vid && vid.toLowerCase() !== 'new') return vid;
  const aid = csvCellStr(row.activity_id);
  if (aid && aid.toLowerCase() !== 'new') return aid;
  return sid;
}

export function xmlQuestionPlacement(row) {
  const role = csvCellStr(row.question_role).toLowerCase().replace(/ /g, '_');
  if (role) return role;
  return csvCellStr(row.question_placement).toLowerCase();
}

export function isThankYouRow(row) {
  return isThankYouTitle(row?.section_title);
}

export function normalizeQuestionRole(raw) {
  return csvCellStr(raw).toLowerCase().replace(/ /g, '_');
}

export function liveSlideRoleFromRow(row) {
  if (!row) return null;
  let role = normalizeQuestionRole(row.question_role);
  if (role === 'interactive') role = 'interactive_example';
  if (LIVE_QUESTION_ROLES.has(role)) return role;
  return null;
}

export function isWorksheetQuestionRow(row) {
  if (!row) return false;
  if (csvCellStr(row.slide_id)) return false;
  if (!csvCellStr(row.question_id)) return false;
  const role = normalizeQuestionRole(row.question_role);
  if (WORKSHEET_QUESTION_ROLES.has(role)) return true;
  return csvCellStr(row.question_placement).toLowerCase() === 'homework';
}

export function validateQuestionRoleValue(role, context = '') {
  const normalized = normalizeQuestionRole(role);
  if (!normalized) return null;
  const raw = csvCellStr(role).toLowerCase();
  if (VALID_QUESTION_ROLES.has(raw) || VALID_QUESTION_ROLES.has(normalized)) return null;
  const prefix = context ? `${context}: ` : '';
  return `${prefix}invalid question_role '${role}'`;
}

export function validateCsvQuestionRoles(rows) {
  const errors = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const qid = csvCellStr(row.question_id);
    const roleRaw = csvCellStr(row.question_role);
    const role = normalizeQuestionRole(roleRaw);
    const slideNum = csvCellStr(row.slide_number) || String(i + 1);
    const label = slideNum ? `Row ${slideNum}` : `Row ${i + 1}`;
    if (qid && !role) {
      errors.push(`${label}: question_id '${qid}' exists but question_role is missing.`);
      continue;
    }
    if (role && !qid) {
      errors.push(`${label}: question_role '${roleRaw}' exists but question_id is missing.`);
      continue;
    }
    if (qid && role) {
      const err = validateQuestionRoleValue(roleRaw, label);
      if (err) errors.push(err);
    }
  }
  return errors;
}

export function validateLiveQuestionsCsvXml(rows, root, { lang, translateFn = (q) => q } = {}) {
  const errors = [];
  if (!root) return errors;
  const langCode = normalizeLanguageCode(lang);
  const slidesByQid = new Map();
  for (const slide of [...root.querySelectorAll('slide')]) {
    if (slide.getAttribute('slide_category') !== 'question') continue;
    const qid = csvCellStr(slide.getAttribute('question_id'));
    if (qid) slidesByQid.set(qid, slide);
  }

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const qidRaw = csvCellStr(row.question_id);
    if (!qidRaw || csvCellStr(row.slide_id)) continue;
    const expectedRole = liveSlideRoleFromRow(row);
    if (!expectedRole) continue;
    const slideNum = csvCellStr(row.slide_number) || String(i + 1);
    const formatted = formatQuestionPartId(qidRaw);
    const translated = translateFn(formatted);
    const xmlSlide = slidesByQid.has(translated)
      ? slidesByQid.get(translated)
      : slidesByQid.get(formatted);
    if (!xmlSlide) {
      errors.push(
        `Slide ${slideNum}: live question '${qidRaw}' with question_role `
        + `'${expectedRole}' not found in generated XML.`,
      );
      continue;
    }
    const actualRole = xmlRoleFromSlideElement(xmlSlide);
    if (actualRole !== expectedRole) {
      errors.push(
        `Slide ${slideNum}: CSV question_role '${expectedRole}' does not match `
        + `XML slide_role '${actualRole}' for question '${qidRaw}'.`,
      );
    }
    const expectedTitle = canonicalQuestionSlideTitle(langCode, expectedRole);
    const actualTitle = csvCellStr(xmlSlide.getAttribute('slide_title'));
    if (actualTitle !== expectedTitle) {
      errors.push(
        `Slide ${slideNum}: XML slide_title '${actualTitle}' does not match `
        + `expected '${expectedTitle}' for question_role '${expectedRole}'.`,
      );
    }
  }
  return errors;
}

export function texTypeFromRow(row, xmlSlideType = null) {
  const xmlType = xmlSlideType ? csvCellStr(xmlSlideType).toLowerCase() : '';

  if (row) {
    const liveRole = liveSlideRoleFromRow(row);
    if (liveRole) return liveRole;
    if (csvCellStr(row.video_id)) return 'video';
    const sn = csvCellStr(row.slide_number);
    if (sn === '2') return 'toc';
    if (sn === '1') return 'title';
    if (isThankYouRow(row)) return 'thank_you';
  }

  if (['instructional', 'activity'].includes(xmlType)) return 'image';
  if (LIVE_QUESTION_ROLES.has(xmlType)) return xmlType;
  if (xmlType) return xmlType;
  return 'image';
}

export function texSlideTitleFromRow(row, texType, lang, xmlTitle = null) {
  const code = normalizeLanguageCode(lang);
  const t = csvCellStr(texType).toLowerCase();
  if (LIVE_QUESTION_ROLES.has(t)) return canonicalQuestionSlideTitle(code, t);
  if (t === 'toc') return tocTitleForLanguage(code);
  if (t === 'thank_you') return thankYouTitleForLanguage(code);
  if (row) {
    const title = csvCellStr(row.section_title);
    if (title) return title;
  }
  return csvCellStr(xmlTitle) || 'Question';
}

export function slideTitleFromRow(row, xmlTitle = null) {
  if (row) {
    const title = csvCellStr(row.section_title);
    if (title) return title;
  }
  return csvCellStr(xmlTitle) || 'Question';
}

export function slideNumberFromRow(row, fallback = null) {
  if (row) {
    const sn = csvCellStr(row.slide_number);
    if (sn) return sn;
  }
  return csvCellStr(fallback) || '0';
}

export const PRACTICE_FORBIDDEN_QUESTION_TYPES = new Set(['puzzle', 'opinion']);

/** Parse author question_id input to 12-digit base only (strip .N / spaced decimals). */
export function normalizeQuestionIdBase(raw) {
  let s = csvCellStr(raw);
  if (!s) return null;
  s = s.replace(/\s*checkpoint\s*$/i, '').trim();
  const compact = s.replace(/\s+/g, '');
  const m = compact.match(/^(\d{12})/);
  if (m) return m[1];
  const m2 = s.match(/^(\d{12})/);
  return m2 ? m2[1] : null;
}

export function normalizeQuestionIdsInRows(rows) {
  return rows.map((row) => {
    const r = { ...row };
    const base = normalizeQuestionIdBase(r.question_id);
    if (base) {
      r.question_id = base;
      return clearSlideIdForMediaRow(r);
    }
    return r;
  });
}

export function dedupeQuestionRowsByBasePerSection(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const base = normalizeQuestionIdBase(row.question_id);
    if (!base) {
      out.push(row);
      continue;
    }
    const sid = normalizeSectionId(row.section_id) || '';
    const key = `${sid}\0${base}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = { ...row, question_id: base };
    out.push(clearSlideIdForMediaRow(r));
  }
  return out;
}

export function validateQuestionMetadataParts(baseId, metadata) {
  const errors = [];
  let numParts;
  try {
    numParts = Number.parseInt(metadata.number_of_parts ?? 1, 10);
    if (!Number.isFinite(numParts)) throw new Error();
  } catch {
    errors.push(`question_id '${baseId}': invalid number_of_parts in API metadata.`);
    return errors;
  }
  const types = metadata.type;
  if (!Array.isArray(types) || !types.length) {
    errors.push(`question_id '${baseId}': missing or empty type array in API metadata.`);
    return errors;
  }
  if (types.length < numParts) {
    errors.push(
      `question_id '${baseId}': API type array length ${types.length} `
      + `is less than number_of_parts ${numParts}.`,
    );
  }
  return errors;
}

/**
 * @param {string[]} parentBaseIds
 * @param {{ subject?: string, fetchFn?: typeof fetch }} [options]
 * @returns {Promise<[Map<string, object>, string[]]>}
 */
export async function fetchQuestionMetadataByParentIds(
  parentBaseIds,
  { subject = '', fetchFn = fetch } = {},
) {
  const errors = [];
  if (!parentBaseIds.length) return [new Map(), errors];

  const { fetchQuestionsMetadata, fetchTranslationForParents, translationResponseToParentMap } =
    await import('./sectionsApi.js');
  const { SUBJECTS_REQUIRING_TRANSLATION } = await import('./constants.js');

  let translationMap = {};
  let apiIds = [...parentBaseIds];
  const needsTranslation = SUBJECTS_REQUIRING_TRANSLATION.has(subject);

  if (needsTranslation) {
    const trans = await fetchTranslationForParents(parentBaseIds, { fetchFn });
    if (trans == null) {
      return [
        new Map(),
        [`Could not fetch question translations for ${parentBaseIds.length} question_id(s).`],
      ];
    }
    translationMap = translationResponseToParentMap(trans);
    const missingTrans = parentBaseIds.filter((p) => !translationMap[p]);
    if (missingTrans.length) {
      return [
        new Map(),
        missingTrans.map((p) => `Could not resolve translated question_id for parent '${p}'.`),
      ];
    }
    apiIds = parentBaseIds.map((p) => translationMap[p]);
  }

  const raw = await fetchQuestionsMetadata(apiIds, { fetchFn });
  if (raw == null) {
    return [
      new Map(),
      [`Could not fetch QMS question metadata for ${parentBaseIds.length} question_id(s).`],
    ];
  }

  const apiMetadata = new Map();
  for (const item of raw) {
    if (item?.question_id != null) apiMetadata.set(String(item.question_id), item);
  }

  const parentMetadata = new Map();
  for (const parentId of parentBaseIds) {
    const apiId = needsTranslation ? translationMap[parentId] : parentId;
    const meta = apiMetadata.get(apiId);
    if (!meta) {
      errors.push(`No QMS metadata for question_id '${parentId}' (API id '${apiId}').`);
      continue;
    }
    const metaErrors = validateQuestionMetadataParts(parentId, meta);
    if (metaErrors.length) {
      errors.push(...metaErrors);
      continue;
    }
    parentMetadata.set(parentId, meta);
  }
  if (errors.length) return [new Map(), errors];
  return [parentMetadata, errors];
}

export function expandQuestionRowsFromApi(rows, metadataByParent) {
  const out = [];
  for (const row of rows) {
    const base = normalizeQuestionIdBase(row.question_id);
    if (!base) {
      out.push(row);
      continue;
    }
    const meta = metadataByParent.get(base);
    if (!meta) {
      out.push(row);
      continue;
    }
    const numParts = Number.parseInt(meta.number_of_parts ?? 1, 10) || 1;
    if (numParts <= 1) {
      const r = { ...row, question_id: base };
      out.push(clearSlideIdForMediaRow(r));
    } else {
      for (let partIndex = 1; partIndex <= numParts; partIndex += 1) {
        out.push({ ...row, question_id: `${base}.${partIndex}`, slide_id: '' });
      }
    }
  }
  return out;
}

function questionRowsContentChanged(before, after) {
  if (before.length !== after.length) return true;
  for (let i = 0; i < before.length; i += 1) {
    if (csvCellStr(before[i].question_id) !== csvCellStr(after[i].question_id)) return true;
    if (csvCellStr(before[i].slide_id) !== csvCellStr(after[i].slide_id)) return true;
  }
  return false;
}

/**
 * @param {Record<string, string>[]} rows
 * @param {{ subject?: string, log?: (msg: string) => void, fetchFn?: typeof fetch }} [options]
 * @returns {Promise<[Record<string, string>[], string[]]>}
 */
export async function processQuestionIdsFromApi(
  rows,
  { subject = '', log = () => {}, fetchFn = fetch } = {},
) {
  let processed = normalizeQuestionIdsInRows(rows);
  processed = dedupeQuestionRowsByBasePerSection(processed);
  const baseIds = collectBaseQuestionIds(processed);
  if (!baseIds.length) return [processed, []];

  const [metadataByParent, errors] = await fetchQuestionMetadataByParentIds(
    baseIds,
    { subject, fetchFn },
  );
  if (errors.length) {
    for (const err of errors) log(`   [ERROR] ${err}`);
    return [processed, errors];
  }

  const expanded = expandQuestionRowsFromApi(processed, metadataByParent);
  if (expanded.length !== processed.length) {
    log(`   [Question ID Expansion] ${processed.length} rows -> ${expanded.length} rows`);
  }
  return [expanded, []];
}

/**
 * @param {string} qId
 * @returns {[string | null, number | null]}
 */
export function splitQuestionIdForApi(qId) {
  const s = csvCellStr(qId);
  if (!s) return [null, null];
  if (s.includes('.')) {
    const [intPart, decPartRaw] = s.split('.', 2);
    const intPartTrim = intPart.trim();
    const decPart = decPartRaw.trim();
    if (!intPartTrim) return [null, null];
    if (!decPart || decPart === '0') return [intPartTrim, null];
    const typeIndex = Number.parseInt(decPart, 10);
    return Number.isFinite(typeIndex) ? [intPartTrim, typeIndex] : [intPartTrim, null];
  }
  return [s, null];
}

/**
 * @param {string} qId
 * @param {Map<string, object>} metadataById
 * @returns {string | null}
 */
export function questionTypeFromMetadata(qId, metadataById) {
  const [baseId, typeIndex] = splitQuestionIdForApi(qId);
  if (!baseId) return null;
  const metadata = metadataById.get(baseId);
  if (!metadata) return null;
  const types = metadata.type;
  if (!Array.isArray(types) || !types.length) return null;
  if (typeIndex == null) return csvCellStr(types[0]).toLowerCase();
  const idx = typeIndex - 1;
  if (idx >= 0 && idx < types.length) return csvCellStr(types[idx]).toLowerCase();
  return null;
}

/**
 * @param {Record<string, string>[]} rows
 * @param {{ practiceOnly?: boolean }} [options]
 * @returns {string[]}
 */
export function collectBaseQuestionIds(rows, { practiceOnly = false } = {}) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (practiceOnly) {
      const role = csvCellStr(row.question_role).toLowerCase().replace(/ /g, '_');
      if (role !== 'practice') continue;
    }
    const qid = csvCellStr(row.question_id);
    if (!qid || !isTwelveDigitId(qid)) continue;
    const [baseId] = splitQuestionIdForApi(qid);
    if (baseId && !seen.has(baseId)) {
      seen.add(baseId);
      out.push(baseId);
    }
  }
  return out;
}

/**
 * @param {Record<string, string>[]} rows
 * @param {Map<string, object>} metadataById
 * @returns {string[]}
 */
export function validatePracticeQuestionTypes(rows, metadataById) {
  const errors = [];
  for (const row of rows) {
    const role = csvCellStr(row.question_role).toLowerCase().replace(/ /g, '_');
    if (role !== 'practice') continue;
    const qid = csvCellStr(row.question_id);
    const slideNum = csvCellStr(row.slide_number);
    if (!qid) continue;
    const qType = questionTypeFromMetadata(qid, metadataById);
    if (qType == null) {
      errors.push(
        `Slide ${slideNum}: question_role 'practice' question_id '${qid}' `
        + 'has no question type in QMS metadata.',
      );
      continue;
    }
    if (PRACTICE_FORBIDDEN_QUESTION_TYPES.has(qType)) {
      errors.push(
        `Slide ${slideNum}: question_role 'practice' must not use `
        + `question type '${qType}' (question_id '${qid}').`,
      );
    }
  }
  return errors;
}

/**
 * @param {Record<string, string>[]} rows
 * @param {typeof fetch} fetchFn
 * @returns {Promise<string[]>}
 */
export async function validatePracticeQuestionTypesFromRows(
  rows,
  fetchFn = fetch,
  { subject = '' } = {},
) {
  const practiceIds = collectBaseQuestionIds(rows, { practiceOnly: true });
  if (!practiceIds.length) return [];

  const [metadataById, errors] = await fetchQuestionMetadataByParentIds(
    practiceIds,
    { subject, fetchFn },
  );
  if (errors.length) return errors;
  return validatePracticeQuestionTypes(rows, metadataById);
}
