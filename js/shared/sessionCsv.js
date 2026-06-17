/** Shared CSV session row handling — port of session_csv.py */

const EMPTY_VALUES = new Set(['', 'nan', 'none', 'nat']);
const TWELVE_DIGIT_ID_RE = /^\d{12}(\.\d+)?$/;
const SECTION_ID_RE = /^\d{12}$/;
const TASHKEEL_RE = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/;
const RECAP_TITLES = new Set(['recap', 'ملخص']);

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
  question: { ar: 'سؤال', en: 'Question' },
  example: { ar: 'مثال', en: 'Example' },
};

export function languageFromCsvPath(csvPath) {
  const base = String(csvPath).split('/').pop() || '';
  const lower = base.toLowerCase();
  if (lower.endsWith('_ar.csv')) return 'ar';
  if (lower.endsWith('_en.csv')) return 'en';
  if (ARABIC_SCRIPT_RE.test(base)) return 'ar';
  return 'en';
}

export function normalizeLanguageCode(lang) {
  const code = csvCellStr(lang).toLowerCase();
  if (!code) return 'en';
  return LANGUAGE_ALIASES[code] || code;
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

/** Map canonical Example/Question slide titles to the session language. */
export function localizeCanonicalSlideTitle(title, lang) {
  const text = csvCellStr(title);
  if (!text) return text;
  const code = normalizeLanguageCode(lang);
  const mapping = CANONICAL_SLIDE_TITLES[text.toLowerCase()];
  if (mapping) return mapping[code] || text;
  return text;
}

export function isNewId(val) {
  return csvCellStr(val).toLowerCase() === 'new';
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

export function isRecapTitle(title) {
  return RECAP_TITLES.has(stripTashkeel(title).toLowerCase());
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
    // Metasession slide_number follows slide order in tex/XML (1-based), not the
    // trailing % comment which is the PPTX slide index and may repeat when a slide
    // id is reused.
    const slideNumber = String(index + 1);

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

export function patchPackageXmlSlideIds(xmlText, slideNumberToPackageId) {
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

export function isVideoCsvRow(row) {
  return isTwelveDigitId(csvCellStr(row?.video_id));
}

export function rowUsesApiSectionTitle(row) {
  if (!isSectionId(row?.section_id)) return false;
  if (csvCellStr(row.question_id)) return false;
  if (isVideoCsvRow(row)) return false;
  if (isThankYouRow(row)) return false;
  if (isRecapTitle(row.section_title || '')) return false;
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

export function normalizeSectionType(raw, defaultVal = 'regular') {
  const s = csvCellStr(raw) || csvCellStr(defaultVal) || 'regular';
  if (s.toLowerCase() === 'full curriculum') return 'regular';
  return s;
}

/** ``revision`` sections skip exact question-id cross-check against the section API. */
export function skipSectionQuestionValidation(sectionType) {
  return normalizeSectionType(sectionType).toLowerCase() === 'revision';
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
    if (qid) byId[qid] = row;
    const vid = csvCellStr(row.video_id);
    if (vid && vid.toLowerCase() !== 'new') byId[vid] = row;
  }
  return byId;
}

export function resolveSlideId(row) {
  const sid = csvCellStr(row.slide_id);
  if (sid && sid.toLowerCase() !== 'new') return sid;
  const qid = csvCellStr(row.question_id);
  if (qid) return qid;
  const vid = csvCellStr(row.video_id);
  if (vid && vid.toLowerCase() !== 'new') return vid;
  return sid;
}

export function xmlQuestionPlacement(row) {
  const role = csvCellStr(row.question_role).toLowerCase().replace(/ /g, '_');
  if (role) return role;
  return csvCellStr(row.question_placement).toLowerCase();
}

export function isThankYouRow(row) {
  const title = csvCellStr(row.section_title).toLowerCase();
  return ['thank you!', 'thank you', 'شكرًا جزيلًا', 'شكرا جزيلا'].includes(title);
}

export function texTypeFromRow(row, xmlSlideType = null) {
  const purpose = row ? csvCellStr(row.slide_purpose).toLowerCase() : '';
  const xmlType = xmlSlideType ? csvCellStr(xmlSlideType).toLowerCase() : '';

  if (purpose === 'video' || (row && csvCellStr(row.video_id))) return 'video';
  if (['example', 'interactive_example', 'instructional', 'title', 'toc', 'thank_you'].includes(purpose)) {
    return purpose === 'instructional' ? 'image' : purpose;
  }
  if (xmlType === 'instructional') return 'image';
  if (xmlType) return xmlType;
  if (row) {
    const sn = csvCellStr(row.slide_number);
    if (sn === '2') return 'toc';
    if (sn === '1') return 'title';
    if (isThankYouRow(row)) return 'thank_you';
  }
  return 'image';
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
export async function validatePracticeQuestionTypesFromRows(rows, fetchFn = fetch) {
  const practiceIds = collectBaseQuestionIds(rows, { practiceOnly: true });
  if (!practiceIds.length) return [];

  const { fetchQuestionsMetadata } = await import('./sectionsApi.js');
  const raw = await fetchQuestionsMetadata(practiceIds, { fetchFn });
  if (raw == null) {
    return ['Could not fetch QMS question metadata to validate practice question types.'];
  }

  const metadataById = new Map();
  for (const item of raw) {
    if (item && item.question_id != null) {
      metadataById.set(String(item.question_id), item);
    }
  }
  return validatePracticeQuestionTypes(rows, metadataById);
}
