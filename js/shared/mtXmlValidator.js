import {
  canonicalQuestionSlideTitle,
  csvCellStr,
  expectedSectionTypeForMetasessionType,
  isPlainTwelveDigitId,
  isTwelveDigitId,
  metasessionTypeLabel,
  validateMetasessionTypeSupported,
} from './sessionCsv.js';
import { QMS_QUESTION_METADATA_URL } from './constants.js';

const PRESENTATION_ROLES = new Set(['title', 'toc', 'instructional', 'video', 'activity', 'thank_you']);
const QUESTION_ROLES = new Set(['example', 'interactive_example']);
const QUESTION_ID_RE = /^(\d{12})\.(\d{2})$/;

export function areQuestionTypesCompatible(xmlType, apiType) {
  const x = csvCellStr(xmlType);
  const a = csvCellStr(apiType);
  if (x === a) return true;
  if (x === 'frq' && ['frq', 'frq_ai', 'short_answer', 'essay'].includes(a)) return true;
  if (x === 'gap' && ['gap', 'gapText'].includes(a)) return true;
  return false;
}

function expectedSeason(grade, term, metasessionType) {
  const g = Number.parseInt(grade, 10);
  const t = Number.parseInt(term, 10);
  if (!Number.isFinite(g) || !Number.isFinite(t)) return null;
  let label = metasessionTypeLabel(metasessionType).toLowerCase();
  if (label === 'full curriculum') label = 'regular';
  if (g >= 1 && g <= 11) {
    if (label === 'foundation') return '1';
    if (t === 0) return '1';
    if (t === 1 && label === 'regular') return '2';
    if (t === 1 && label === 'final revision') return '3';
    if (t === 2 && label === 'regular') return '4';
    if (t === 2 && label === 'final revision') return '5';
  }
  if (g === 12 && t === 0) {
    if (label === 'foundation') return '6';
    if (label === 'regular') return '7';
    if (label === 'final revision') return '8';
  }
  return null;
}

function questionOccurrences(root) {
  const out = [];
  for (const slide of [...root.querySelectorAll('slide')]) {
    if (slide.getAttribute('slide_category') === 'question') {
      out.push({ kind: 'live slide', element: slide, qid: slide.getAttribute('question_id') || '' });
    }
  }
  for (const q of [...root.querySelectorAll('worksheet > question')]) {
    out.push({ kind: 'worksheet', element: q, qid: q.getAttribute('question_id') || '' });
  }
  for (const q of [...root.querySelectorAll('exam > question')]) {
    out.push({ kind: 'exam', element: q, qid: q.getAttribute('question_id') || '' });
  }
  return out;
}

async function fetchQuestionMetadata(baseIds, fetchFn = fetch) {
  const metadata = new Map();
  const errors = [];
  for (let start = 0; start < baseIds.length; start += 100) {
    const chunk = baseIds.slice(start, start + 100);
    let payload = null;
    let lastError = '';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetchFn(QMS_QUESTION_METADATA_URL, {
          method: 'POST',
          headers: { accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ question_ids: chunk }),
        });
        if (response.ok) {
          payload = await response.json();
          break;
        }
        lastError = `HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`;
      } catch (e) {
        lastError = `${e.name || 'Error'}: ${e.message || e}`;
      }
    }
    if (!Array.isArray(payload)) {
      errors.push(`Could not fetch QMS metadata for question ids ${chunk.join(', ')}: ${lastError}`);
      continue;
    }
    for (const item of payload) {
      if (item?.question_id != null) metadata.set(String(item.question_id), item);
    }
  }
  for (const baseId of baseIds) {
    if (!metadata.has(baseId)) errors.push(`Question '${baseId}' does not exist or was not returned by QMS metadata API.`);
  }
  return { metadata, errors };
}

function metaValue(metadata, key) {
  const val = metadata?.[key];
  if (val && typeof val === 'object') {
    return csvCellStr(val.iso_code || val.url_text || val.name || val.title);
  }
  return csvCellStr(val);
}

export async function validateMtXmlText(xmlText, { fetchFn = fetch, validateApi = true } = {}) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    return { errors: [`XML is not well formed: ${parseError.textContent || 'parse error'}`], warnings: [], summary: {} };
  }
  return validateMtXmlDocument(doc, { fetchFn, validateApi });
}

export async function validateMtXmlDocument(doc, { fetchFn = fetch, validateApi = true } = {}) {
  const errors = [];
  const warnings = [];
  const summary = {};
  const root = doc.documentElement;

  if (root.tagName !== 'metasession') {
    return { errors: ['Root element must be <metasession>.'], warnings, summary };
  }

  for (const attr of ['language', 'country', 'grade', 'subject', 'metasession_type', 'season', 'term']) {
    if (!csvCellStr(root.getAttribute(attr))) errors.push(`<metasession> missing required attribute '${attr}'.`);
  }
  const grade = csvCellStr(root.getAttribute('grade'));
  if (!/^(?:[1-9]|1[0-2])$/.test(grade)) {
    errors.push(`grade must be 1..12 without prefix/leading zero; got '${grade}'.`);
  }
  const metasessionType = csvCellStr(root.getAttribute('metasession_type'));
  errors.push(...validateMetasessionTypeSupported(metasessionType));
  const season = expectedSeason(grade, root.getAttribute('term') || '', metasessionType);
  if (season && root.getAttribute('season') !== season) {
    errors.push(`season must be '${season}' for metasession_type '${metasessionType}', grade ${grade}, term ${root.getAttribute('term')}; got '${root.getAttribute('season')}'.`);
  }

  const title = root.querySelector(':scope > metasession_title');
  if (!title?.textContent?.trim()) errors.push('<metasession_title> must exist and be non-empty.');

  for (const section of [...root.querySelectorAll('section')]) {
    const sectionId = section.getAttribute('section_id') || '?';
    const stype = csvCellStr(section.getAttribute('section_type'));
    const expected = expectedSectionTypeForMetasessionType(metasessionType);
    if (expected === 'regular') {
      if (!['regular', 'revision'].includes(stype)) errors.push(`section ${sectionId}: section_type must be regular or revision for Full Curriculum; got '${stype}'.`);
    } else if (stype !== expected) {
      errors.push(`section ${sectionId}: section_type must be '${expected}' for metasession_type '${metasessionType}'.`);
    }
    const worksheets = [...section.children].filter((el) => el.tagName === 'worksheet');
    if (!worksheets.length) errors.push(`section ${sectionId}: missing direct <worksheet> child.`);
    for (const worksheet of worksheets) {
      if (!isTwelveDigitId(worksheet.getAttribute('worksheet_id'))) errors.push(`section ${sectionId}: worksheet_id must be a 12-digit ID.`);
      if (!worksheet.querySelector(':scope > question')) errors.push(`section ${sectionId}: worksheet must contain at least one question.`);
    }
  }

  if (root.querySelector('checkpoint')) errors.push('Generated new XML must not contain <checkpoint> tags.');

  for (const slide of [...root.querySelectorAll('slide')]) {
    const sn = slide.getAttribute('slide_number') || '?';
    for (const attr of ['slide_id', 'slide_number', 'slide_category', 'slide_role', 'slide_title']) {
      if (!csvCellStr(slide.getAttribute(attr))) errors.push(`slide ${sn}: missing required attribute '${attr}'.`);
    }
    const category = slide.getAttribute('slide_category');
    const role = slide.getAttribute('slide_role');
    summary[`slide.${category}.${role}`] = (summary[`slide.${category}.${role}`] || 0) + 1;
    if (category === 'presentation') {
      if (!PRESENTATION_ROLES.has(role)) errors.push(`slide ${sn}: invalid presentation role '${role}'.`);
      if (role === 'video' && (!slide.getAttribute('video_id') || slide.getAttribute('video_id') !== slide.getAttribute('slide_id'))) errors.push(`slide ${sn}: video_id is required and must equal slide_id.`);
      if (role === 'activity' && (!slide.getAttribute('activity_id') || slide.getAttribute('activity_id') !== slide.getAttribute('slide_id'))) errors.push(`slide ${sn}: activity_id is required and must equal slide_id.`);
    } else if (category === 'question') {
      if (!QUESTION_ROLES.has(role)) errors.push(`slide ${sn}: invalid question role '${role}'.`);
      for (const attr of ['question_id', 'question_type', 'number_of_parts', 'part_number']) {
        if (!csvCellStr(slide.getAttribute(attr))) errors.push(`question slide ${sn}: missing '${attr}'.`);
      }
      if (slide.getAttribute('slide_id') !== slide.getAttribute('question_id')) errors.push(`question slide ${sn}: slide_id must equal question_id.`);
      if (!QUESTION_ID_RE.test(csvCellStr(slide.getAttribute('question_id')))) errors.push(`question slide ${sn}: question_id must be 12 digits plus .NN.`);
      const langAttr = csvCellStr(root.getAttribute('language'));
      if (!langAttr) {
        errors.push('metasession root missing language attribute from metasession API');
      } else {
        const expectedTitle = canonicalQuestionSlideTitle(langAttr, role);
        if (slide.getAttribute('slide_title') !== expectedTitle) errors.push(`question slide ${sn}: slide_title must be '${expectedTitle}'.`);
      }
    } else {
      errors.push(`slide ${sn}: invalid slide_category '${category}'.`);
    }
  }

  let thankSeen = false;
  for (const child of [...root.children]) {
    if (child.tagName === 'slide' && child.getAttribute('slide_role') === 'thank_you') thankSeen = true;
    if (child.tagName === 'exam' && !thankSeen) errors.push('<exam> must appear after the thank-you slide.');
  }
  for (const exam of [...root.querySelectorAll(':scope > exam')]) {
    for (const attr of ['exam_id', 'exam_title', 'duration']) {
      if (!csvCellStr(exam.getAttribute(attr))) errors.push(`<exam> missing required attribute '${attr}'.`);
    }
    if (!isPlainTwelveDigitId(exam.getAttribute('exam_id'))) errors.push(`exam_id '${exam.getAttribute('exam_id')}' must be a 12-digit ID.`);
    if (!exam.querySelector(':scope > question')) errors.push(`exam ${exam.getAttribute('exam_id') || '?'}: must contain at least one question.`);
  }

  const hasRevisionSection = [...root.querySelectorAll('section')]
    .some((section) => section.getAttribute('section_type') === 'revision');
  const examRequired = metasessionType === 'Final Revision' ||
    (metasessionType === 'Full Curriculum' && hasRevisionSection);
  if (examRequired && !root.querySelector(':scope > exam')) {
    errors.push('exam required by session type/section_type but no exam source was found in PPTX.');
  }

  const occurrences = questionOccurrences(root);
  const baseIds = [];
  for (const occurrence of occurrences) {
    const qid = csvCellStr(occurrence.qid);
    const match = qid.match(QUESTION_ID_RE);
    if (!match) {
      errors.push(`${occurrence.kind} question_id '${qid}' must be 12 digits plus .NN.`);
      continue;
    }
    occurrence.baseId = match[1];
    occurrence.partNumber = Number.parseInt(match[2], 10);
    if (!baseIds.includes(occurrence.baseId)) baseIds.push(occurrence.baseId);
    if (csvCellStr(occurrence.element.getAttribute('part_number')) !== String(occurrence.partNumber)) {
      errors.push(`${occurrence.kind} question '${qid}': part_number must match the .NN suffix.`);
    }
  }

  if (validateApi && baseIds.length) {
    const { metadata, errors: apiErrors } = await fetchQuestionMetadata(baseIds, fetchFn);
    errors.push(...apiErrors);
    for (const occurrence of occurrences) {
      const meta = metadata.get(occurrence.baseId);
      if (!meta) continue;
      const elem = occurrence.element;
      const apiParts = Number.parseInt(meta.number_of_parts ?? 1, 10) || 1;
      if (csvCellStr(elem.getAttribute('number_of_parts')) !== String(apiParts)) {
        errors.push(`${occurrence.kind} question '${occurrence.qid}': number_of_parts must be ${apiParts}.`);
      }
      const types = meta.type;
      const part = occurrence.partNumber;
      if (!Array.isArray(types) || part < 1 || part > types.length) {
        errors.push(`Question ${occurrence.baseId}: API type array missing part ${part}.`);
      } else if (!areQuestionTypesCompatible(elem.getAttribute('question_type') || '', String(types[part - 1]))) {
        errors.push(`${occurrence.kind} question '${occurrence.qid}': question_type '${elem.getAttribute('question_type')}' does not match API type '${types[part - 1]}'.`);
      }
      for (const key of ['language', 'country', 'grade', 'subject']) {
        const apiVal = metaValue(meta, key);
        const xmlVal = csvCellStr(root.getAttribute(key));
        if (apiVal && xmlVal && apiVal.toLowerCase() !== xmlVal.toLowerCase()) {
          errors.push(`Question ${occurrence.baseId}: API ${key} '${apiVal}' does not match XML '${xmlVal}'.`);
        }
      }
    }
  }

  const liveGroups = new Map();
  for (const section of [...root.querySelectorAll('section')]) {
    for (const slide of [...section.children].filter((el) => el.tagName === 'slide')) {
      if (slide.getAttribute('slide_category') !== 'question') continue;
      const match = csvCellStr(slide.getAttribute('question_id')).match(QUESTION_ID_RE);
      if (!match) continue;
      const key = `${section.getAttribute('section_id') || ''}:${match[1]}`;
      if (!liveGroups.has(key)) liveGroups.set(key, { baseId: match[1], slides: [] });
      liveGroups.get(key).slides.push(slide);
    }
  }
  for (const { baseId, slides } of liveGroups.values()) {
    const expectedParts = Number.parseInt(slides[0].getAttribute('number_of_parts') || '1', 10);
    if (!Number.isFinite(expectedParts)) continue;
    const parts = slides
      .map((slide) => Number.parseInt(slide.getAttribute('part_number') || '0', 10))
      .sort((a, b) => a - b);
    const expectedPartList = Array.from({ length: expectedParts }, (_, idx) => idx + 1);
    if (expectedParts > 1 && parts.join(',') !== expectedPartList.join(',')) {
      errors.push(`Live multipart question ${baseId}: expected parts 1..${expectedParts}, got ${JSON.stringify(parts)}.`);
    }
    const slideNumbers = slides
      .map((slide) => Number.parseInt(slide.getAttribute('slide_number') || '0', 10))
      .sort((a, b) => a - b);
    if (slideNumbers.length > 1) {
      const expectedSlideNumbers = Array.from(
        { length: slideNumbers.length },
        (_, idx) => slideNumbers[0] + idx,
      );
      if (slideNumbers.join(',') !== expectedSlideNumbers.join(',')) {
        errors.push(`Live multipart question ${baseId}: slide numbers must be consecutive.`);
      }
    }
  }

  return { errors, warnings, summary };
}

export async function validateXmlOutputs(ctx) {
  const { vfs, log, config = {} } = ctx;
  const fetchFn = config.fetchFn || fetch;
  const xmlPaths = (await vfs.glob('xml/*.xml')).sort();
  if (!xmlPaths.length) throw new Error("No XML files found in 'xml/'.");
  const allErrors = [];
  const allWarnings = [];
  for (const xmlPath of xmlPaths) {
    const name = xmlPath.split('/').pop();
    const result = await validateMtXmlText(await vfs.readText(xmlPath), { fetchFn });
    allErrors.push(...result.errors.map((err) => `${name}: ${err}`));
    allWarnings.push(...result.warnings.map((warn) => `${name}: ${warn}`));
  }
  for (const warn of allWarnings) log(`WARNING: ${warn}`);
  if (allErrors.length) {
    for (const err of allErrors) log(`ERROR: ${err}`);
    throw new Error('XML output validation failed.');
  }
  log(`Validated ${xmlPaths.length} XML file(s).`);
  return { ok: true, warnings: allWarnings };
}
