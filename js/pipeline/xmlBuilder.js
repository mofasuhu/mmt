/**
 * Port of xml_builder.py — build metasession XML from CSV + API metadata.
 */
import {
  csvCellStr,
  normalizeSectionId,
  normalizeSectionType,
  tocTitleForLanguage,
  localizeCanonicalSlideTitle,
  isTwelveDigitId,
  rowRequiresEmptySlideId,
  xmlQuestionPlacement,
  loadSessionRows,
  writeSessionRows,
} from '../shared/sessionCsv.js';
import { getRawMetasessionData, buildReportRow } from '../shared/metasessionApi.js';
import {
  initSectionsValidationResults,
  validateSectionsInCsv,
  SECTIONS_VALIDATION_RESULTS_FILE,
} from '../shared/sectionValidator.js';
import {
  SUBJECTS_REQUIRING_TRANSLATION,
  ID_URL,
  QMS_QUESTION_METADATA_URL,
  QMS_QUESTION_METADATA_BATCH_SIZE,
  QMS_QUESTION_METADATA_TIMEOUT_SEC,
  QMS_QUESTION_METADATA_MAX_RETRIES,
  QMS_QUESTION_METADATA_RETRY_DELAY_SEC,
  QMS_QUESTION_TRANSLATION_URL,
  QMS_QUESTION_TRANSLATION_LANGUAGE,
  QMS_QUESTION_TRANSLATION_BATCH_SIZE,
  QMS_QUESTION_TRANSLATION_TIMEOUT_SEC,
  QMS_QUESTION_TRANSLATION_MAX_RETRIES,
  QMS_QUESTION_TRANSLATION_RETRY_DELAY_SEC,
} from '../shared/constants.js';

const QMS_QUESTION_METADATA_TIMEOUT_MS = QMS_QUESTION_METADATA_TIMEOUT_SEC * 1000;
const QMS_QUESTION_METADATA_RETRY_DELAY_MS = QMS_QUESTION_METADATA_RETRY_DELAY_SEC * 1000;
const QMS_QUESTION_TRANSLATION_TIMEOUT_MS = QMS_QUESTION_TRANSLATION_TIMEOUT_SEC * 1000;
const QMS_QUESTION_TRANSLATION_RETRY_DELAY_MS = QMS_QUESTION_TRANSLATION_RETRY_DELAY_SEC * 1000;

function subjectRequiresTranslation(subject) {
  if (SUBJECTS_REQUIRING_TRANSLATION instanceof Set) {
    return SUBJECTS_REQUIRING_TRANSLATION.has(subject);
  }
  return SUBJECTS_REQUIRING_TRANSLATION.includes(subject);
}

/** @type {Map<string, object>} */
const questionMetadataCache = new Map();
/** @type {Map<string, string|null>} */
const questionTranslationCache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBlank(val) {
  if (val == null) return true;
  const s = String(val).trim();
  return !s || ['nan', 'none', 'nat'].includes(s.toLowerCase());
}

function stripTashkeel(text) {
  return String(text)
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

function normalizeGradeForXml(gradeRaw) {
  const raw = String(gradeRaw ?? '');
  const match = /\d+/.exec(raw);
  if (match) return String(parseInt(match[0], 10));
  return raw;
}

function buildMetasessionRootAttributes(apiData, detailsRow) {
  const api = apiData || {};
  const details = detailsRow || {};

  let metasessionNum = String(details['Meta Session Number'] ?? '');
  try {
    metasessionNum = String(parseInt(parseFloat(metasessionNum), 10));
  } catch {
    metasessionNum = String(details['Meta Session Number'] ?? '');
  }

  const gradeObj = api.grade || {};
  let gradeNormalized;
  if (gradeObj.url_text != null && String(gradeObj.url_text).trim()) {
    gradeNormalized = normalizeGradeForXml(String(gradeObj.url_text));
  } else if (gradeObj.title) {
    gradeNormalized = normalizeGradeForXml(String(gradeObj.title));
  } else {
    gradeNormalized = normalizeGradeForXml(String(details.Grade ?? ''));
  }

  const termObj = api.term || {};
  const term =
    typeof termObj === 'object' && termObj?.id != null
      ? String(termObj.id)
      : String(details.Term ?? '');

  const languageObj = api.language || {};
  const language = String(languageObj.iso_code || details.Language || 'en');

  const countryObj = api.country || {};
  const country = String(countryObj.iso_code || details.Country || 'eg');

  const subjectObj = api.subject || {};
  const subject = String(subjectObj.name || details.Subject || '');

  const metasessionType = String(
    api.metasession_type || details['Class Type'] || 'regular',
  );

  const metaclassId = String(api.metaclass_id || details['Meta Class Id'] || '');
  const academicYear = String(api.academic_year || details['Academic Year'] || '');

  let season;
  if (api.season != null) {
    season = String(api.season);
  } else if (String(details.Season ?? '').trim()) {
    season = String(details.Season);
  } else {
    season = getSeason(gradeNormalized, term, metasessionType);
  }

  return {
    metasession_id: String(details['Meta Session Id'] ?? ''),
    metasession_number: metasessionNum,
    metaclass_id: metaclassId,
    metasession_type: metasessionType,
    language,
    country,
    subject,
    grade: gradeNormalized,
    term,
    season,
    academic_year: academicYear,
  };
}

function renumberSlidesSequentially(metasession) {
  const slides = metasession.querySelectorAll('slide');
  slides.forEach((slide, i) => {
    slide.setAttribute('slide_number', String(i + 1));
  });
}

function getSeason(grade, term, classType) {
  let g = parseInt(grade, 10);
  let t = parseInt(term, 10);
  if (Number.isNaN(g) || Number.isNaN(t)) {
    return '1';
  }

  const ct = String(classType).toLowerCase();

  if (g >= 1 && g <= 11) {
    if (t === 0) return '1';
    if (t === 1 && ct === 'regular') return '2';
    if (t === 1 && ct === 'final revision') return '3';
    if (t === 2 && ct === 'regular') return '4';
    if (t === 2 && ct === 'final revision') return '5';
  } else if (g === 12) {
    if (t === 0 && ct === 'foundation') return '6';
    if (t === 0 && ct === 'regular') return '7';
    if (t === 0 && ct === 'final revision') return '8';
  }

  return '1';
}

function formatQuestionId(qId) {
  if (isBlank(qId)) return null;
  const s = String(qId).trim();
  const f = parseFloat(s);
  if (!Number.isNaN(f) && f === Math.trunc(f)) return String(Math.trunc(f));
  if (!Number.isNaN(f)) return String(f);
  return s.replace(/\.0$/, '');
}

function splitQuestionIdForApi(qId) {
  if (isBlank(qId)) return [null, null];

  const s = String(qId).trim();
  if (!s) return [null, null];

  if (s.includes('.')) {
    const [intPart, decPart] = s.split('.', 2);
    const base = intPart.trim();
    const dec = decPart.trim();
    if (!base) return [null, null];
    if (!dec || dec === '0') return [base, null];
    const typeIndex = parseInt(dec, 10);
    if (Number.isNaN(typeIndex)) return [base, null];
    return [base, typeIndex];
  }

  return [s, null];
}

async function fetchJsonWithRetries(fetchFn, url, options, {
  maxRetries,
  retryDelayMs,
  log,
  label,
}) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      log(`[${label}] ${options.method || 'GET'} ${url} (attempt ${attempt}/${maxRetries})`);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 30000);
      const response = await fetchFn(url, { ...options.fetchInit, signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) {
        const text = await response.text();
        lastError = `HTTP ${response.status}: ${text.slice(0, 300)}`;
        log(`[${label} Error] ${lastError}`);
      } else {
        return await response.json();
      }
    } catch (e) {
      lastError = `${e.name || 'Error'}: ${e.message || e}`;
      log(`[${label} Error] ${lastError}`);
    }

    if (attempt < maxRetries) {
      log(`[${label}] Retrying in ${retryDelayMs / 1000}s...`);
      await sleep(retryDelayMs);
    }
  }

  log(`[${label} FATAL] Failed after ${maxRetries} attempts. Last error: ${lastError}`);
  return null;
}

async function fetchQuestionMetadata(questionIds, fetchFn, log) {
  if (!questionIds?.length) return;

  const seen = new Set();
  const uniqueIds = [];
  for (const q of questionIds) {
    if (!q || seen.has(q) || questionMetadataCache.has(q)) continue;
    seen.add(q);
    uniqueIds.push(q);
  }
  if (!uniqueIds.length) return;

  const headers = {
    accept: 'application/json',
    'Content-Type': 'application/json',
  };

  for (let start = 0; start < uniqueIds.length; start += QMS_QUESTION_METADATA_BATCH_SIZE) {
    const chunk = uniqueIds.slice(start, start + QMS_QUESTION_METADATA_BATCH_SIZE);
    const payload = await fetchJsonWithRetries(
      fetchFn,
      QMS_QUESTION_METADATA_URL,
      {
        method: 'POST',
        fetchInit: {
          method: 'POST',
          headers,
          body: JSON.stringify({ question_ids: chunk }),
        },
        timeoutMs: QMS_QUESTION_METADATA_TIMEOUT_MS,
      },
      {
        maxRetries: QMS_QUESTION_METADATA_MAX_RETRIES,
        retryDelayMs: QMS_QUESTION_METADATA_RETRY_DELAY_MS,
        log,
        label: 'QMS',
      },
    );

    if (Array.isArray(payload)) {
      for (const item of payload) {
        if (item && typeof item === 'object') {
          const qid = String(item.question_id || '').trim();
          if (qid) questionMetadataCache.set(qid, item);
        }
      }
    }
  }
}

async function fetchQuestionTranslations(questionIds, fetchFn, log, language = QMS_QUESTION_TRANSLATION_LANGUAGE) {
  if (!questionIds?.length) return;

  const seen = new Set();
  const uniqueIds = [];
  for (const q of questionIds) {
    if (!q || seen.has(q) || questionTranslationCache.has(q)) continue;
    seen.add(q);
    uniqueIds.push(q);
  }
  if (!uniqueIds.length) return;

  const headers = {
    accept: 'application/json',
    'Content-Type': 'application/json',
  };
  const url = `${QMS_QUESTION_TRANSLATION_URL}?translation-language=${encodeURIComponent(language)}`;

  for (let start = 0; start < uniqueIds.length; start += QMS_QUESTION_TRANSLATION_BATCH_SIZE) {
    const chunk = uniqueIds.slice(start, start + QMS_QUESTION_TRANSLATION_BATCH_SIZE);
    const payload = await fetchJsonWithRetries(
      fetchFn,
      url,
      {
        method: 'POST',
        fetchInit: {
          method: 'POST',
          headers,
          body: JSON.stringify({ question_parent_ids: chunk }),
        },
        timeoutMs: QMS_QUESTION_TRANSLATION_TIMEOUT_MS,
      },
      {
        maxRetries: QMS_QUESTION_TRANSLATION_MAX_RETRIES,
        retryDelayMs: QMS_QUESTION_TRANSLATION_RETRY_DELAY_MS,
        log,
        label: 'QMS-Translations',
      },
    );

    if (Array.isArray(payload)) {
      for (const item of payload) {
        if (!item || typeof item !== 'object') continue;
        const parentId = String(item.parent_question_id || '').trim();
        const translatedId = String(item.question_id || '').trim();
        if (parentId && translatedId) {
          questionTranslationCache.set(parentId, translatedId);
        }
      }
      for (const q of chunk) {
        if (!questionTranslationCache.has(q)) questionTranslationCache.set(q, null);
      }
    }
  }
}

function collectQuestionIdsForApi(rows) {
  const ids = [];
  const seen = new Set();
  for (const row of rows) {
    const [baseId] = splitQuestionIdForApi(row.question_id);
    if (baseId && !seen.has(baseId)) {
      seen.add(baseId);
      ids.push(baseId);
    }
  }
  return ids;
}

function getQuestionType(qId, missingQuestionsList, log) {
  if (isBlank(qId)) return 'N/A';

  const [baseId, typeIndex] = splitQuestionIdForApi(qId);
  if (!baseId) return 'N/A';

  const metadata = questionMetadataCache.get(baseId);
  if (!metadata) {
    log(`Question ID '${baseId}' not found in QMS metadata API response.`);
    const formattedId = formatQuestionId(qId);
    if (!missingQuestionsList.some((m) => m['Question ID'] === formattedId)) {
      missingQuestionsList.push({ 'Question ID': formattedId });
    }
    return 'N/A';
  }

  const types = metadata.type;
  if (!Array.isArray(types) || !types.length) {
    log(`Question ID '${baseId}' has no 'type' values in QMS response.`);
    return 'N/A';
  }

  if (typeIndex == null) return String(types[0]);

  const idx = typeIndex - 1;
  if (idx >= 0 && idx < types.length) return String(types[idx]);

  log(
    `Decimal index ${typeIndex} for question '${qId}' is out of range (type array length: ${types.length}).`,
  );
  return 'N/A';
}

async function getNewId(fetchFn) {
  try {
    const response = await fetchFn(ID_URL, {
      method: 'GET',
      headers: {},
    });
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data) && data[0] != null) return String(data[0]);
    }
  } catch {
    /* fall through */
  }
  return null;
}

async function getSlideId(idFromCsv, fetchFn) {
  if (isBlank(idFromCsv) || String(idFromCsv).trim().toLowerCase() === 'new') {
    return getNewId(fetchFn);
  }
  const s = csvCellStr(idFromCsv);
  if (isTwelveDigitId(s)) return s;
  try {
    return String(parseInt(parseFloat(s), 10));
  } catch {
    return s;
  }
}

function translateQuestionId(qId, subject, log) {
  if (!subjectRequiresTranslation(subject)) return qId;
  if (qId == null) return qId;

  const s = String(qId).trim();
  if (!s) return qId;

  let basePart;
  let decimalPart;
  if (s.includes('.')) {
    [basePart, decimalPart] = s.split('.', 2);
    basePart = basePart.trim();
    decimalPart = decimalPart.trim();
  } else {
    basePart = s;
    decimalPart = '';
  }

  if (!basePart) return qId;

  const translatedBase = questionTranslationCache.get(basePart);
  if (!translatedBase) {
    log(
      `Question ID '${qId}' for subject '${subject}' requires translation but no translation was returned by the QMS API. Keeping original ID.`,
    );
    return qId;
  }

  return decimalPart ? `${translatedBase}.${decimalPart}` : translatedBase;
}

function createEl(doc, tag, attrs = {}, text = null) {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null && v !== '') el.setAttribute(k, String(v));
  }
  if (text != null) el.textContent = text;
  return el;
}

/**
 * @param {object[]} sessionRows
 * @param {object} detailsRow
 * @param {object|null} apiData
 * @param {(msg: string) => void} log
 * @param {typeof fetch} fetchFn
 */
async function buildXmlStructure(sessionRows, detailsRow, apiData, log, fetchFn) {
  const missingQuestions = [];
  const verbatimTasks = [];
  const sessionRowsProcessed = sessionRows.map((r) => ({ ...r }));

  const doc = document.implementation.createDocument('', '', null);
  const metaAttributes = buildMetasessionRootAttributes(apiData, detailsRow);
  const metasession = createEl(doc, 'metasession', metaAttributes);
  doc.appendChild(metasession);

  const apiMetasessionTitle = String(detailsRow['Metasession Title'] ?? '').trim();
  const metasessionTitleText = apiMetasessionTitle
    ? apiMetasessionTitle
    : String(sessionRowsProcessed[0]?.section_title ?? '');
  metasession.appendChild(createEl(doc, 'metasession_title', {}, metasessionTitleText));

  const subject = metaAttributes.subject || '';
  const lang = metaAttributes.language || 'en';

  const initialSlides = sessionRowsProcessed.slice(0, 2);
  let remaining = sessionRowsProcessed.slice(2);

  const recapKeywords = ['recap', 'ملخص'];
  const wellDoneKeywords = ['well done', 'well done!', 'عمل رائع', 'عمل رائع!'];

  let recapSlides = remaining.filter((r) =>
    recapKeywords.includes(stripTashkeel(String(r.section_title ?? '')).toLowerCase()),
  );
  let wellDoneSlides = remaining.filter((r) =>
    wellDoneKeywords.includes(stripTashkeel(String(r.section_title ?? '')).toLowerCase()),
  );

  const lastRow = remaining.length ? remaining[remaining.length - 1] : null;
  let hasThankYou = false;

  if (lastRow) {
    const lastTitle = String(lastRow.section_title ?? '');
    const stripped = stripTashkeel(lastTitle).toLowerCase();
    if (
      stripped === 'thank you!' ||
      stripped === 'شكرا جزيلا' ||
      ['Thank You!', 'thank you!', 'Thank you!', 'شكرًا جزيلًا'].includes(lastTitle)
    ) {
      hasThankYou = true;
      remaining = remaining.slice(0, -1);
      recapSlides = recapSlides.filter((r) => r !== lastRow);
      wellDoneSlides = wellDoneSlides.filter((r) => r !== lastRow);
    }
  }

  const mainContent = remaining.filter(
    (r) =>
      !recapKeywords.includes(stripTashkeel(String(r.section_title ?? '')).toLowerCase()) &&
      !wellDoneKeywords.includes(stripTashkeel(String(r.section_title ?? '')).toLowerCase()),
  );

  const sectionGroups = {};
  const pendingGroupEnds = {};

  for (let i = 0; i < initialSlides.length; i += 1) {
    const row = initialSlides[i];
    const rowIndex = i;
    let slideId = await getSlideId(row.slide_id, fetchFn);

    if (String(row.slide_id ?? '').trim().toLowerCase() === 'new' && slideId) {
      sessionRowsProcessed[rowIndex].slide_id = slideId;
    }

    const slideType = i === 0 ? 'title' : 'toc';
    const slideTitle = i === 1 ? tocTitleForLanguage(lang) : String(row.section_title ?? '');

    if (slideId) {
      metasession.appendChild(
        createEl(doc, 'slide', {
          slide_id: slideId,
          slide_number: '0',
          slide_type: slideType,
          slide_title: slideTitle,
        }),
      );
    }
  }

  let currentSectionElement = null;
  let currentSectionId = null;
  let currentCheckpointElement = null;
  const questionsInCheckpoint = new Set();
  let currentSectionGroupElement = null;
  let lastSectionTitle = '';
  let activeGroupName = null;

  for (let mainIdx = 0; mainIdx < mainContent.length; mainIdx += 1) {
    const row = mainContent[mainIdx];
    const rowIndex = sessionRowsProcessed.indexOf(row);
    const idx = rowIndex >= 0 ? rowIndex : mainIdx + 2;

    const qId = row.question_id;
    if (!isBlank(qId) && questionsInCheckpoint.has(formatQuestionId(qId))) continue;

    const sectionTitle = csvCellStr(row.section_title);
    const sectionGp = csvCellStr(row.section_gp);

    if (activeGroupName && pendingGroupEnds[idx]) {
      currentSectionGroupElement = null;
      activeGroupName = null;
      currentSectionElement = null;
      currentSectionId = null;
      lastSectionTitle = '';
    }

    if (sectionGp && sectionGp.toLowerCase() !== 'nan') {
      if (!(sectionGp in sectionGroups)) {
        sectionGroups[sectionGp] = idx;
        currentSectionGroupElement = createEl(doc, 'section_group');
        metasession.appendChild(currentSectionGroupElement);
        currentSectionGroupElement.appendChild(
          createEl(doc, 'section_group_title', {}, sectionGp),
        );
        currentSectionElement = null;
        currentSectionId = null;
        lastSectionTitle = '';
        activeGroupName = sectionGp;

        let nextOccurrence = null;
        for (let fi = mainIdx + 1; fi < mainContent.length; fi += 1) {
          if (csvCellStr(mainContent[fi].section_gp) === sectionGp) {
            nextOccurrence = sessionRowsProcessed.indexOf(mainContent[fi]);
            if (nextOccurrence < 0) nextOccurrence = fi + 2;
            break;
          }
        }
        if (nextOccurrence != null) pendingGroupEnds[nextOccurrence] = sectionGp;
      }
    }

    const normalizedTitle = sectionTitle.toLowerCase();
    const isSpecialTitle = [
      'example', 'question', 'سؤال', 'مثال', 'essempio', 'domanda',
      'ejemplo', 'bregunta', 'beispiel', 'frage',
    ].includes(normalizedTitle);

    const videoIdOnRow = csvCellStr(row.video_id);
    const slidePurpose = csvCellStr(row.slide_purpose).toLowerCase();

    const sectionIdFromCsv = normalizeSectionId(row.section_id);
    if (!sectionIdFromCsv && currentSectionElement && !sectionGp) {
      currentSectionElement = null;
      currentSectionId = null;
    }

    if (sectionIdFromCsv && sectionIdFromCsv !== currentSectionId) {
      const sectionParent = currentSectionGroupElement || metasession;
      const sectionTypeValue = normalizeSectionType(
        row.section_type,
        metaAttributes.metasession_type || 'regular',
      );
      currentSectionElement = createEl(doc, 'section', {
        section_id: sectionIdFromCsv,
        section_type: sectionTypeValue,
      });
      sectionParent.appendChild(currentSectionElement);
      const sectTitle = sectionTitle || lastSectionTitle || '';
      if (sectTitle) {
        currentSectionElement.appendChild(createEl(doc, 'section_title', {}, sectTitle));
        lastSectionTitle = sectTitle;
      }
      currentSectionId = sectionIdFromCsv;
      currentCheckpointElement = null;
      questionsInCheckpoint.clear();
    }

    const parentForItem = currentSectionElement || currentSectionGroupElement || metasession;
    if (!parentForItem) {
      log(`Nowhere to place element from row with slide number: ${row.slide_number}`);
      continue;
    }

    const slideIdEmpty = !csvCellStr(row.slide_id);
    const questionRole = csvCellStr(row.question_role).toLowerCase().replace(/ /g, '_');
    const placementCol = csvCellStr(row.question_placement).toLowerCase();
    const isCheckpointRow =
      slideIdEmpty &&
      !isBlank(qId) &&
      (questionRole === 'checkpoint' ||
        questionRole === 'practice' ||
        (placementCol && placementCol !== 'example'));

    if (isCheckpointRow) {
      let placement = xmlQuestionPlacement({
        question_role: csvCellStr(row.question_role),
        question_placement: csvCellStr(row.question_placement),
      });
      if (!placement) placement = placementCol || questionRole;
      if (placement !== 'example') {
        if (!currentCheckpointElement) {
          const requiredCorrect = !isBlank(row.required_correct)
            ? parseInt(row.required_correct, 10)
            : 0;
          const attemptWindow = !isBlank(row.attempt_window)
            ? parseInt(row.attempt_window, 10)
            : 0;
          currentCheckpointElement = createEl(doc, 'checkpoint', {
            required_correct: String(requiredCorrect),
            attempt_window: String(attemptWindow),
          });
          parentForItem.appendChild(currentCheckpointElement);
          questionsInCheckpoint.clear();
        }

        if (!isBlank(qId)) {
          const formattedQId = formatQuestionId(qId);
          const translatedQId = translateQuestionId(formattedQId, subject, log);
          questionsInCheckpoint.add(formattedQId);
          const qType = getQuestionType(qId, missingQuestions, log);
          currentCheckpointElement.appendChild(
            createEl(doc, 'question', {
              question_id: translatedQId,
              question_type: qType,
              question_placement: placement,
            }),
          );
        }
      }
    }

    if (questionsInCheckpoint.has(formatQuestionId(qId))) continue;

    if (!sectionTitle && isBlank(qId)) continue;

    const isVideoRow =
      isBlank(qId) &&
      (videoIdOnRow || slidePurpose === 'video' || ['video', 'فيديو'].includes(normalizedTitle));

    if (isVideoRow && videoIdOnRow) {
      const csvSlideId = csvCellStr(row.slide_id);
      let videoSlideId;
      if (csvSlideId && csvSlideId.toLowerCase() !== 'new') {
        videoSlideId = await getSlideId(row.slide_id, fetchFn);
      } else {
        videoSlideId = (await getSlideId(videoIdOnRow, fetchFn)) || videoIdOnRow;
      }
      if (csvCellStr(row.slide_id).toLowerCase() === 'new' && videoSlideId) {
        sessionRowsProcessed[idx].slide_id = videoSlideId;
      }
      const defaultVideoTitle = lang === 'ar' ? 'فيديو' : 'Video';
      const slideTitleText = sectionTitle || defaultVideoTitle;
      parentForItem.appendChild(
        createEl(doc, 'slide', {
          slide_id: videoSlideId,
          slide_number: '0',
          video_id: videoIdOnRow,
          slide_type: 'video',
          slide_title: slideTitleText,
        }),
      );
      continue;
    }

    if (isVideoRow && ['video', 'فيديو'].includes(normalizedTitle) && !videoIdOnRow) {
      log("Row has 'Video' section_title but is missing a 'video_id'. Skipping slide creation.");
      continue;
    }

    const hasQuestion = !isBlank(qId);
    let slideType;
    if (['example', 'interactive_example', 'instructional', 'video'].includes(slidePurpose)) {
      slideType = slidePurpose;
    } else if (hasQuestion || isSpecialTitle) {
      slideType = 'example';
    } else {
      slideType = 'instructional';
    }

    if (hasQuestion && ['question', 'سؤال'].includes(normalizedTitle)) {
      slideType = 'interactive_example';
    }

    let slideId;
    if (slideType === 'example' || slideType === 'interactive_example') {
      slideId = translateQuestionId(formatQuestionId(qId), subject, log);
    } else {
      slideId = await getSlideId(row.slide_id, fetchFn);
      if (String(row.slide_id ?? '').trim().toLowerCase() === 'new' && slideId) {
        sessionRowsProcessed[idx].slide_id = slideId;
      }
    }

    let slideTitleText;
    if (hasQuestion) {
      slideTitleText = sectionTitle;
    } else if (slideType === 'instructional') {
      slideTitleText = sectionTitle || lastSectionTitle;
    } else if (
      sectionGp === sectionTitle &&
      sectionGp === activeGroupName &&
      idx === sectionGroups[sectionGp]
    ) {
      slideTitleText = sectionGp;
    } else {
      slideTitleText = slideType === 'example' ? 'Example' : lastSectionTitle;
    }

    slideTitleText = localizeCanonicalSlideTitle(slideTitleText, lang);

    const slideAttrs = {
      slide_id: slideId,
      slide_number: '0',
      slide_type: slideType,
      slide_title: slideTitleText,
    };

    if (hasQuestion) {
      const formattedQId = formatQuestionId(qId);
      slideAttrs.question_id = translateQuestionId(formattedQId, subject, log);
      slideAttrs.question_type = getQuestionType(qId, missingQuestions, log);
    }

    parentForItem.appendChild(createEl(doc, 'slide', slideAttrs));

    const verbatimRaw = row.verbatim;
    if (slideId && !isBlank(verbatimRaw)) {
      const match = /\{(.*)\}/s.exec(String(verbatimRaw));
      if (match) {
        const textToProcess = match[1].trim();
        if (textToProcess) {
          verbatimTasks.push({ slide_id: slideId, text: textToProcess });
          log(`Found verbatim text for slide ID ${slideId}. Queued for processing.`);
        }
      }
    }
  }

  for (const row of recapSlides) {
    const rIdx = sessionRowsProcessed.indexOf(row);
    let slideId = await getSlideId(row.slide_id, fetchFn);
    if (String(row.slide_id ?? '').trim().toLowerCase() === 'new' && slideId && rIdx >= 0) {
      sessionRowsProcessed[rIdx].slide_id = slideId;
    }
    if (slideId) {
      metasession.appendChild(
        createEl(doc, 'slide', {
          slide_id: slideId,
          slide_number: '0',
          slide_type: 'instructional',
          slide_title: String(row.section_title ?? 'Recap').trim(),
        }),
      );
    }
  }

  for (const row of wellDoneSlides) {
    const wIdx = sessionRowsProcessed.indexOf(row);
    let slideId = await getSlideId(row.slide_id, fetchFn);
    if (String(row.slide_id ?? '').trim().toLowerCase() === 'new' && slideId && wIdx >= 0) {
      sessionRowsProcessed[wIdx].slide_id = slideId;
    }
    if (slideId) {
      metasession.appendChild(
        createEl(doc, 'slide', {
          slide_id: slideId,
          slide_number: '0',
          slide_type: 'instructional',
          slide_title: String(row.section_title ?? 'Well Done!').trim(),
        }),
      );
    }
  }

  if (hasThankYou && lastRow) {
    const thankIdx = sessionRowsProcessed.indexOf(lastRow);
    const thankSlideId = await getSlideId(lastRow.slide_id, fetchFn);
    if (
      String(lastRow.slide_id ?? '').trim().toLowerCase() === 'new' &&
      thankSlideId &&
      thankIdx >= 0
    ) {
      sessionRowsProcessed[thankIdx].slide_id = thankSlideId;
    }
    let thankTitle = csvCellStr(lastRow.section_title);
    if (!thankTitle) thankTitle = lang === 'ar' ? 'شكرًا جزيلًا' : 'Thank You!';
    metasession.appendChild(
      createEl(doc, 'slide', {
        slide_id: thankSlideId,
        slide_number: '0',
        slide_type: 'thank_you',
        slide_title: thankTitle,
      }),
    );
  }

  renumberSlidesSequentially(metasession);

  return {
    metasessionElement: metasession,
    document: doc,
    missingQuestions,
    verbatimTasks,
    sessionRowsProcessed,
  };
}

function groupOrphanInteractiveSlides(metasessionElement, log) {
  const orphans = [...metasessionElement.children].filter(
    (c) => c.tagName === 'slide' && c.getAttribute('slide_type') === 'interactive_example',
  );
  if (orphans.length) {
    const ids = orphans.slice(0, 10).map((c) => c.getAttribute('slide_id') || '?').join(', ');
    log(
      `Found ${orphans.length} interactive_example slide(s) outside any <section> (expected section_id from CSV). Slide IDs: ${ids}`,
    );
  }
}

function formatXmlPretty(doc) {
  const root = doc.documentElement;
  const lines = [];

  function esc(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function attrs(el) {
    const parts = [];
    for (const attr of [...el.attributes].sort((a, b) => a.name.localeCompare(b.name))) {
      parts.push(`${attr.name}="${esc(attr.value)}"`);
    }
    return parts.length ? ` ${parts.join(' ')}` : '';
  }

  function walk(el, depth) {
    const indent = '    '.repeat(depth);
    const children = [...el.childNodes].filter(
      (n) => n.nodeType === Node.ELEMENT_NODE || (n.nodeType === Node.TEXT_NODE && n.textContent.trim()),
    );

    const elementChildren = children.filter((n) => n.nodeType === Node.ELEMENT_NODE);
    const textChild = children.find((n) => n.nodeType === Node.TEXT_NODE);

    if (!elementChildren.length && textChild) {
      lines.push(`${indent}<${el.tagName}${attrs(el)}>${esc(textChild.textContent.trim())}</${el.tagName}>`);
      return;
    }

    if (!elementChildren.length && !textChild) {
      lines.push(`${indent}<${el.tagName}${attrs(el)}></${el.tagName}>`);
      return;
    }

    lines.push(`${indent}<${el.tagName}${attrs(el)}>`);
    for (const child of elementChildren) walk(child, depth + 1);
    if (textChild && !elementChildren.length) {
      lines.push(`${indent}    ${esc(textChild.textContent.trim())}`);
    }
    lines.push(`${indent}</${el.tagName}>`);
  }

  walk(root, 0);
  return `${lines.join('\n')}\n`;
}

/**
 * @param {object} ctx
 * @param {import('../io/virtualFs.js').VirtualFs} ctx.vfs
 * @param {(msg: string) => void} ctx.log
 * @param {object} ctx.config
 * @param {string} [ctx.config.apiKey]
 * @param {typeof fetch} [ctx.config.fetchFn]
 */
export async function runXmlBuilder(ctx) {
  const { vfs, log, config } = ctx;
  const fetchFn = config?.fetchFn || fetch;

  questionMetadataCache.clear();
  questionTranslationCache.clear();

  const csvPaths = (await vfs.glob('csvs/*.csv')).sort();
  if (!csvPaths.length) {
    throw new Error("No CSV files found in the 'csvs/' directory.");
  }

  await initSectionsValidationResults(vfs);

  /** @type {Map<string, {detailsRow: object, apiData: object}>} */
  const metasessionDetailsCache = new Map();

  for (const sessionCsvPath of csvPaths) {
    const filename = sessionCsvPath.split('/').pop();
    log(`Processing session file: ${filename}`);

    let metasessionId;
    try {
      metasessionId = filename.split('_')[0];
      if (!/^\d+$/.test(metasessionId)) throw new Error('Extracted ID is not a number.');
      log(`Extracted metasession ID from filename: ${metasessionId}`);
    } catch (e) {
      throw new Error(`Could not extract a valid metasession ID from filename '${filename}': ${e.message || e}`);
    }

    let sessionRows;
    try {
      sessionRows = await loadSessionRows(vfs, sessionCsvPath);
    } catch (e) {
      throw new Error(`An error occurred while reading ${filename}: ${e.message || e}`);
    }

    let detailsRow;
    let apiData;
    if (metasessionDetailsCache.has(metasessionId)) {
      ({ detailsRow, apiData } = metasessionDetailsCache.get(metasessionId));
    } else {
      apiData = await getRawMetasessionData(metasessionId, { fatal: true, log, fetchFn });
      if (!apiData) {
        throw new Error(
          `Could not fetch metasession data for '${metasessionId}' after retries. Terminating.`,
        );
      }
      detailsRow = buildReportRow(apiData, { extended: true, metasessionId });
      metasessionDetailsCache.set(metasessionId, { detailsRow, apiData });
    }

    const questionIdsForApi = collectQuestionIdsForApi(sessionRows);
    if (questionIdsForApi.length) {
      log(`Fetching QMS metadata for ${questionIdsForApi.length} question id(s)...`);
      await fetchQuestionMetadata(questionIdsForApi, fetchFn, log);
    }

    const sessionSubject = String(detailsRow.Subject ?? '');
    if (subjectRequiresTranslation(sessionSubject) && questionIdsForApi.length) {
      log(
        `Subject '${sessionSubject}' requires translation. Fetching translations for ${questionIdsForApi.length} question id(s)...`,
      );
      await fetchQuestionTranslations(questionIdsForApi, fetchFn, log);
    }

    const idsNote = subjectRequiresTranslation(sessionSubject)
      ? 'IDs compared after xml_builder translation (section API uses translated question_ids).'
      : 'IDs compared from CSV (no question-id translation for this subject).';

    const secErrors = await validateSectionsInCsv(ctx, sessionCsvPath, metasessionId, {
      questionIdTransform: (q) => translateQuestionId(q, sessionSubject, log),
      questionIdsNote: idsNote,
    });

    if (secErrors.length) {
      log(
        `Section validation reported ${secErrors.length} issue(s) for ${filename}; see ${SECTIONS_VALIDATION_RESULTS_FILE}`,
      );
      for (const err of secErrors) log(`  - ${err}`);
      throw new Error('XML build stopped due to section validation failure.');
    }

    log(`Section validation passed for ${filename}; see ${SECTIONS_VALIDATION_RESULTS_FILE}`);
    log('Building XML structure...');

    const {
      document: xmlDoc,
      missingQuestions,
      sessionRowsProcessed,
    } = await buildXmlStructure(sessionRows, detailsRow, apiData, log, fetchFn);

    groupOrphanInteractiveSlides(xmlDoc.documentElement, log);

    try {
      for (const row of sessionRowsProcessed) {
        if (
          rowRequiresEmptySlideId({
            question_id: csvCellStr(row.question_id),
            video_id: csvCellStr(row.video_id),
            activity_id: csvCellStr(row.activity_id),
          })
        ) {
          row.slide_id = '';
        }
      }
      await writeSessionRows(vfs, sessionCsvPath, sessionRowsProcessed);
      log(`Updated CSV file with new IDs: ${sessionCsvPath}`);
    } catch (e) {
      throw new Error(`Failed to update CSV file ${sessionCsvPath}: ${e.message || e}`);
    }

    const finalXmlString = formatXmlPretty(xmlDoc);
    const outputXmlPath = `xml/${metasessionId}_metasession.xml`;
    await vfs.writeText(outputXmlPath, finalXmlString);
    log(`Successfully created XML file: ${outputXmlPath}`);

    if (missingQuestions.length) {
      const header = 'Question ID\n';
      const body = missingQuestions.map((m) => m['Question ID']).join('\n');
      const missingPath = `${metasessionId}_missing_questions.csv`;
      await vfs.writeText(missingPath, `${header}${body}\n`);
      log(
        `Found ${missingQuestions.length} missing question(s) for ${metasessionId}. Report: ${missingPath}`,
      );
      throw new Error('XML build stopped due to missing questions.');
    }

    log('No missing questions found for this session.');
  }
}
