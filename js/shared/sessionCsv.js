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

export function normalizeSectionType(raw, defaultVal = 'regular') {
  const s = csvCellStr(raw) || csvCellStr(defaultVal) || 'regular';
  const lowered = s.toLowerCase();
  if (lowered === 'full curriculum') return 'regular';
  if (lowered === 'final revision') return 'revision';
  if (lowered === 'foundation') return 'foundation';
  return s;
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

export function expectedSectionTypeForMetasessionType(metasessionType) {
  const label = metasessionTypeLabel(metasessionType).toLowerCase();
  if (label === 'foundation') return 'foundation';
  if (label === 'final revision') return 'revision';
  return 'regular';
}

/**
 * @param {string} metasessionType
 * @param {{ slides?: Record<string, string>[], csvRows?: Record<string, string>[] }} [sources]
 * @returns {string[]}
 */
export function validateSectionTypesForMetasessionType(metasessionType, { slides = null, csvRows = null } = {}) {
  const expected = expectedSectionTypeForMetasessionType(metasessionType);
  if (expected === 'regular') return [];

  const errors = [];
  const inspect = (label, item) => {
    const raw = csvCellStr(item.section_type);
    if (!raw) return;
    const normalized = normalizeSectionType(raw, expected);
    if (normalized.toLowerCase() !== expected) {
      errors.push(
        `${label}: section_type '${raw}' is invalid for `
        + `metasession_type '${metasessionTypeLabel(metasessionType)}' (must be '${expected}').`,
      );
    }
  };

  if (slides) {
    for (const slide of slides) {
      const sn = csvCellStr(slide.slide_number) || '?';
      inspect(`Slide ${sn}`, slide);
    }
  }
  if (csvRows) {
    for (const row of csvRows) {
      const sn = csvCellStr(row.slide_number) || '?';
      inspect(`Slide ${sn}`, row);
    }
  }
  return errors;
}

/** Revision/foundation sections skip exact question-id cross-checks. */
export function skipSectionQuestionValidation(sectionType) {
  return ['revision', 'foundation'].includes(normalizeSectionType(sectionType).toLowerCase());
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
  const columns = fieldnames || (rows[0] ? Object.keys(rows[0]) : []);
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
      }
    } else if (element.tagName === 'section_group') {
      for (const child of element.children) {
        if (child.tagName === 'section_group_title') continue;
        if (child.tagName === 'section') {
          for (const sub of child.children) {
            if (sub.tagName === 'slide') slides.push(sub);
          }
        } else if (child.tagName === 'slide') {
          slides.push(child);
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
    const xmlSlide = slidesByQid.get(translated) || slidesByQid.get(formatted);
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
