/** Validate PPTX filename tags against metasession API data. */
import {
  csvCellStr,
  courseTypeFromApiData,
  validatePptxMtypeAgainstCourseType,
} from './sessionCsv.js';
import { SESSION_NUMBER_MAP } from './sessionNumberDict.js';

const PPTX_NAME_RE = /^(?<country>[^_]+)_G(?<grade>\d+)_T(?<term>\d+)_(?<subject>.+)_S(?<session>\d+)_(?<mtype>.+)$/;

/**
 * @param {string} metasessionTitle
 * @returns {string | null}
 */
export function sessionNumberFromTitle(metasessionTitle) {
  if (!metasessionTitle) return null;
  const idx = metasessionTitle.search(/[:：]/);
  const prefix = (idx >= 0 ? metasessionTitle.slice(0, idx) : metasessionTitle).trim();
  if (!prefix) return null;
  if (prefix in SESSION_NUMBER_MAP) return String(SESSION_NUMBER_MAP[prefix]);
  const match = /^Session\s+(\d+)$/i.exec(prefix);
  return match ? match[1] : null;
}

/**
 * @param {string} stem
 * @returns {Record<string, string> | null}
 */
export function parsePptxNameTags(stem) {
  const base = stem.replace(/\.pptx$/i, '').trim();
  const match = PPTX_NAME_RE.exec(base);
  if (!match?.groups) return null;
  return { ...match.groups };
}

function normalizeTagToken(value) {
  return csvCellStr(value).toLowerCase();
}

function normalizeNumberToken(value) {
  const text = csvCellStr(value);
  if (!text) return '';
  const parsed = Number.parseInt(text, 10);
  return Number.isNaN(parsed) ? text : String(parsed);
}

/**
 * @param {string} stem
 * @param {object} apiData
 * @param {{ stemLabel?: string, slides?: Record<string, string>[], csvRows?: Record<string, string>[] }} [opts]
 * @returns {string[]}
 */
export function validatePptxNameAgainstApi(stem, apiData, {
  stemLabel = '',
  slides = null,
  csvRows = null,
} = {}) {
  const errors = [];
  const label = stemLabel || stem.replace(/\.pptx$/i, '').trim();
  const prefix = `PPTX name (${label})`;

  const tags = parsePptxNameTags(stem);
  if (!tags) {
    errors.push(
      `${prefix}: could not parse filename tags `
      + '(expected <country>_G<grade>_T<term>_<subject>_S<n>_<type>)',
    );
    return errors;
  }

  const countryObj = apiData?.country || {};
  const gradeObj = apiData?.grade || {};
  const termObj = apiData?.term || {};
  const subjectObj = apiData?.subject || {};

  const apiCountry = csvCellStr(countryObj.iso_code).toUpperCase();
  const fileCountry = tags.country.toUpperCase();
  if (apiCountry && fileCountry !== apiCountry) {
    errors.push(`${prefix}: country '${fileCountry}' does not match API '${apiCountry}'`);
  }

  const fileGrade = normalizeNumberToken(tags.grade);
  const apiGradeOrder = normalizeNumberToken(String(gradeObj.order ?? ''));
  const apiGradeUrl = normalizeNumberToken(csvCellStr(gradeObj.url_text));
  if (fileGrade && apiGradeOrder && fileGrade !== apiGradeOrder && fileGrade !== apiGradeUrl) {
    errors.push(
      `${prefix}: grade G${tags.grade} does not match API grade `
      + `(order=${apiGradeOrder || '?'}, url_text=${apiGradeUrl || '?'})`,
    );
  }

  const fileTerm = normalizeNumberToken(tags.term);
  const apiTerm = normalizeNumberToken(String(termObj.id ?? ''));
  if (fileTerm && apiTerm && fileTerm !== apiTerm) {
    errors.push(`${prefix}: term T${tags.term} does not match API term id ${apiTerm}`);
  }

  const fileSubject = csvCellStr(tags.subject);
  const apiSubject = csvCellStr(subjectObj.name);
  if (apiSubject && fileSubject !== apiSubject) {
    errors.push(`${prefix}: subject '${fileSubject}' does not match API '${apiSubject}'`);
  }

  const title = csvCellStr(apiData?.metasession_title);
  const apiSession = sessionNumberFromTitle(title);
  const fileSession = normalizeNumberToken(tags.session);
  if (apiSession == null) {
    errors.push(
      `${prefix}: could not derive session number from API metasession_title '${title}'`,
    );
  } else if (fileSession && apiSession !== fileSession) {
    errors.push(
      `${prefix}: session S${tags.session} does not match API session number ${apiSession}`,
    );
  }

  const courseType = courseTypeFromApiData(apiData);
  errors.push(...validatePptxMtypeAgainstCourseType(courseType, tags.mtype));

  return errors;
}

/**
 * @param {string[]} errors
 * @param {(msg: string) => void} log
 */
export function logPptxNameErrors(errors, log) {
  for (const error of errors) {
    log(`   [ERROR] ${error}`);
  }
}
