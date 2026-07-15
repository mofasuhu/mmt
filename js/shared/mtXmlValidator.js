import {
  canonicalQuestionSlideTitle,
  csvCellStr,
  isPlainTwelveDigitId,
  isRule40Exempt,
  isTwelveDigitId,
  permissionsForMetasession,
  PermissionContext,
  validateSessionContentRulesFromXml,
  validateXmlMetasessionTypeSupported,
  validateSectionsForXmlMetasessionType,
  validateSeasonFromApi,
  loadSessionRows,
  sessionDurationFromCsvRows,
} from './sessionCsv.js';
import { QMS_QUESTION_METADATA_URL, SUBJECTS_REQUIRING_TRANSLATION } from './constants.js';
import { getRawMetasessionData } from './metasessionApi.js';
import { loadSkippingValidationsByMetasession } from './skippingValidations.js';

const PRESENTATION_ROLES = new Set(['title', 'toc', 'instructional', 'video', 'activity', 'thank_you']);
const QUESTION_ROLES = new Set(['example', 'interactive_example']);
const QUESTION_ID_RE = /^(\d{12})\.(\d{2})$/;
const SLIDE_GROUP_PAGES = new Set(['single', 'multiple']);

async function sessionDurationFallbackFromCsvs(vfs, metasessionId) {
  const mid = csvCellStr(metasessionId);
  if (!mid) return null;
  const csvPaths = (await vfs.glob(`csvs/${mid}_*.csv`)).sort();
  for (const csvPath of csvPaths) {
    try {
      const rows = await loadSessionRows(vfs, csvPath);
      const duration = sessionDurationFromCsvRows(rows);
      if (duration != null) return duration;
    } catch {
      // ignore unreadable CSV and try next match
    }
  }
  return null;
}

export function areQuestionTypesCompatible(xmlType, apiType) {
  const x = csvCellStr(xmlType);
  const a = csvCellStr(apiType);
  if (x === a) return true;
  if (x === 'frq' && ['frq', 'frq_ai', 'short_answer', 'essay'].includes(a)) return true;
  if (x === 'gap' && ['gap', 'gapText'].includes(a)) return true;
  return false;
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
          if (Array.isArray(payload)) break;
          lastError = `unexpected response shape ${typeof payload}`;
          payload = null;
        } else {
          lastError = `HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`;
        }
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

export async function validateMtXmlText(xmlText, {
  fetchFn = fetch,
  validateApi = true,
  apiData = null,
  permissions = null,
  sessionDurationFallback = null,
} = {}) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    return { errors: [`XML is not well formed: ${parseError.textContent || 'parse error'}`], warnings: [], summary: {} };
  }
  return validateMtXmlDocument(doc, {
    fetchFn,
    validateApi,
    apiData,
    permissions,
    sessionDurationFallback,
  });
}

export async function validateMtXmlDocument(doc, {
  fetchFn = fetch,
  validateApi = true,
  apiData = null,
  permissions = null,
  sessionDurationFallback = null,
} = {}) {
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
  errors.push(...validateXmlMetasessionTypeSupported(metasessionType));

  // Detect if this session uses translated questions (Arabic Science subjects)
  const sessionSubject = csvCellStr(root.getAttribute('subject'));
  const requiresTranslation = SUBJECTS_REQUIRING_TRANSLATION.has(sessionSubject);

  let resolvedApiData = apiData;
  if (!resolvedApiData && validateApi) {
    const metasessionId = csvCellStr(root.getAttribute('metasession_id'));
    if (metasessionId) {
      resolvedApiData = await getRawMetasessionData(metasessionId, { fatal: false, fetchFn });
    }
  }
  if (resolvedApiData) {
    errors.push(...validateSeasonFromApi(resolvedApiData, root.getAttribute('season')));
  } else if (validateApi) {
    errors.push('Could not fetch metasession API data to validate season.');
  }

  const title = root.querySelector(':scope > metasession_title');
  if (!title?.textContent?.trim()) errors.push('<metasession_title> must exist and be non-empty.');

  const perms = permissions instanceof PermissionContext ? permissions : new PermissionContext();
  const sectionTypeValues = [];
  const sectionIdValues = [];
  for (const section of [...root.querySelectorAll('section')]) {
    const sectionId = section.getAttribute('section_id') || '?';
    const stype = csvCellStr(section.getAttribute('section_type'));
    let stypeNorm = stype.toLowerCase().replace(/ /g, '_');
    if (stypeNorm === 'full_curriculum' || stypeNorm === 'fullcurriculum') {
      stypeNorm = 'regular';
    }
    sectionTypeValues.push(stype);
    sectionIdValues.push(sectionId);
    const worksheets = [...section.children].filter((el) => el.tagName === 'worksheet');
    if (!worksheets.length) errors.push(`section ${sectionId}: missing direct <worksheet> child.`);
    for (const worksheet of worksheets) {
      if (!isTwelveDigitId(worksheet.getAttribute('worksheet_id'))) errors.push(`section ${sectionId}: worksheet_id must be a 12-digit ID.`);
      if (
        !worksheet.querySelector(':scope > question')
        && stypeNorm === 'regular'
        && !perms.hasSectionPermission(sectionId, 'questionless_section')
      ) {
        warnings.push(`section ${sectionId}: worksheet has no questions.`);
      }
    }
  }
  errors.push(...validateSectionsForXmlMetasessionType(
    metasessionType,
    sectionTypeValues,
    { sectionIds: sectionIdValues },
  ));

  if (root.querySelector('checkpoint')) errors.push('Generated new XML must not contain <checkpoint> tags.');

  const seenSlideGroupIds = new Set();
  for (const group of [...root.querySelectorAll('slide_group')]) {
    const groupId = csvCellStr(group.getAttribute('slide_group_id'));
    const pages = csvCellStr(group.getAttribute('pages'));
    const label = `slide_group ${groupId || '?'}`;
    if (!isPlainTwelveDigitId(groupId)) errors.push(`${label}: slide_group_id must be a plain 12-digit ID.`);
    if (!SLIDE_GROUP_PAGES.has(pages)) errors.push(`${label}: pages must be 'single' or 'multiple'.`);
    if (groupId) {
      if (seenSlideGroupIds.has(groupId)) errors.push(`${label}: duplicate slide_group_id.`);
      else seenSlideGroupIds.add(groupId);
    }
    const childSlides = [...group.children].filter((el) => el.tagName === 'slide');
    for (const child of [...group.children]) {
      if (child.tagName !== 'slide') {
        errors.push(`${label}: only <slide> children allowed; found <${child.tagName}>.`);
      }
    }
    if (!childSlides.length) warnings.push(`${label}: has no child slides.`);
  }

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
  if (!thankSeen) errors.push('missing thank-you slide.');
  for (const exam of [...root.querySelectorAll(':scope > exam')]) {
    for (const attr of ['exam_id', 'exam_title', 'duration']) {
      if (!csvCellStr(exam.getAttribute(attr))) errors.push(`<exam> missing required attribute '${attr}'.`);
    }
    if (!isPlainTwelveDigitId(exam.getAttribute('exam_id'))) errors.push(`exam_id '${exam.getAttribute('exam_id')}' must be a 12-digit ID.`);
    if (!exam.querySelector(':scope > question')) errors.push(`exam ${exam.getAttribute('exam_id') || '?'}: must contain at least one question.`);
  }

  const examRequired = metasessionType.toLowerCase() === 'revision';
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

  let metadataById = new Map();
  if (validateApi && baseIds.length) {
    const { metadata, errors: apiErrors } = await fetchQuestionMetadata(baseIds, fetchFn);
    errors.push(...apiErrors);
    metadataById = metadata;
    for (const occurrence of occurrences) {
      const meta = metadata.get(occurrence.baseId);
      if (!meta) continue;
      const elem = occurrence.element;
      const apiParts = Number.parseInt(meta.number_of_parts ?? 1, 10) || 1;
      if (csvCellStr(elem.getAttribute('number_of_parts')) !== String(apiParts)) {
        if (requiresTranslation) {
          errors.push(
            `${occurrence.kind} question '${occurrence.qid}': ` +
            `number_of_parts must be ${apiParts} ` +
            `(parent question metadata vs translated question API).`
          );
        } else {
          errors.push(
            `${occurrence.kind} question '${occurrence.qid}': ` +
            `number_of_parts must be ${apiParts}.`
          );
        }
      }
      const types = meta.type;
      const part = occurrence.partNumber;
      if (!Array.isArray(types) || part < 1 || part > types.length) {
        let msg = `Question ${occurrence.baseId}: API type array missing part ${part}.`;
        if (requiresTranslation) msg += ' (translated question)';
        errors.push(msg);
      } else if (!areQuestionTypesCompatible(elem.getAttribute('question_type') || '', String(types[part - 1]))) {
        if (requiresTranslation) {
          errors.push(
            `${occurrence.kind} question '${occurrence.qid}': ` +
            `question_type '${elem.getAttribute('question_type')}' (from parent question) ` +
            `does not match translated question API type '${types[part - 1]}'.`
          );
        } else {
          errors.push(
            `${occurrence.kind} question '${occurrence.qid}': ` +
            `question_type '${elem.getAttribute('question_type')}' ` +
            `does not match API type '${types[part - 1]}'.`
          );
        }
      }
      for (const key of ['language', 'country', 'grade', 'subject']) {
        const apiVal = metaValue(meta, key);
        const xmlVal = csvCellStr(root.getAttribute(key));
        if (apiVal && xmlVal && apiVal.toLowerCase() !== xmlVal.toLowerCase()) {
          let msg = `Question ${occurrence.baseId}: API ${key} '${apiVal}' does not match XML '${xmlVal}'.`;
          if (requiresTranslation && ['language', 'country'].includes(key)) {
            msg += ' (parent vs translated question)';
          }
          errors.push(msg);
        }
      }
    }
  }

  if (validateApi) {
    const perms = permissions instanceof PermissionContext ? permissions : new PermissionContext();
    const needsRule40 = (
      metasessionType.toLowerCase() === 'regular'
      && !isRule40Exempt(grade, csvCellStr(root.getAttribute('subject')))
      && !perms.hasSessionPermission('mcq_free_percentage')
    );
    errors.push(...validateSessionContentRulesFromXml(root, {
      xmlMetasessionType: metasessionType,
      metadataById: needsRule40 ? metadataById : null,
      grade,
      subject: csvCellStr(root.getAttribute('subject')),
      permissions: perms,
      apiData: resolvedApiData,
      sessionDurationFallback,
    }));
  }

  const liveGroups = new Map();
  for (const section of [...root.querySelectorAll('section')]) {
    for (const slide of [...section.querySelectorAll('slide')]) {
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
  const { vfs, log, googleSheets, config = {} } = ctx;
  const fetchFn = config.fetchFn || fetch;
  const xmlPaths = (await vfs.glob('xml/*.xml')).sort();
  if (!xmlPaths.length) throw new Error("No XML files found in 'xml/'.");

  let permissionsByMeta = config.permissionsByMeta || null;
  if (!permissionsByMeta) {
    const [loadedPermissionsByMeta, permissionErrors] = await loadSkippingValidationsByMetasession(googleSheets);
    if (permissionErrors.length) {
      for (const err of permissionErrors) log(`ERROR: skipping_validations: ${err}`);
      throw new Error('Could not load skipping_validations sheet.');
    }
    permissionsByMeta = loadedPermissionsByMeta;
  }

  const allErrors = [];
  const allWarnings = [];
  for (const xmlPath of xmlPaths) {
    const name = xmlPath.split('/').pop();
    const xmlText = await vfs.readText(xmlPath);
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'application/xml');
    const root = doc.documentElement;
    const metasessionId = root?.tagName === 'metasession'
      ? csvCellStr(root.getAttribute('metasession_id'))
      : '';
    const result = await validateMtXmlText(xmlText, {
      fetchFn,
      permissions: permissionsForMetasession(permissionsByMeta, metasessionId),
      sessionDurationFallback: await sessionDurationFallbackFromCsvs(vfs, metasessionId),
    });
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
