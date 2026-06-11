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

/** Canonical Example/Question titles → session language (matches session_csv.py). */
const CANONICAL_SLIDE_TITLES = {
  question: { ar: 'سؤال', en: 'Question' },
  example: { ar: 'مثال', en: 'Example' },
};

export function normalizeLanguageCode(lang) {
  const code = csvCellStr(lang).toLowerCase();
  if (!code) return 'en';
  return LANGUAGE_ALIASES[code] || code;
}

export function tocTitleForLanguage(lang) {
  const code = normalizeLanguageCode(lang);
  return TOC_TITLE_BY_LANGUAGE[code] || TOC_TITLE_BY_LANGUAGE.en;
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
  const s = csvCellStr(val);
  if (!s || isNewId(s)) return false;
  return SECTION_ID_RE.test(s);
}

export function stripTashkeel(text) {
  return csvCellStr(text).replace(TASHKEEL_RE, '');
}

export function isRecapTitle(title) {
  return RECAP_TITLES.has(stripTashkeel(title).toLowerCase());
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
