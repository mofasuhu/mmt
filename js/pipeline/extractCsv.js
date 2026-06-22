/**
 * CSV extraction pipeline — JavaScript port of extract_csv.py
 */

import {
  QUESTIONS_METADATA_API_URL,
  QUESTIONS_METADATA_API_MAX_RETRIES,
  QUESTIONS_METADATA_API_RETRY_DELAY_SEC,
  QUESTIONS_METADATA_API_TIMEOUT_SEC,
  SHEETS_SPREADSHEET_ID,
  SHEETS_TEMP_TAB_NAME,
  SLIDE_FIELDS,
  HEADER_FIELDS,
  NEW_MODE_SLIDE_FIELDS,
  SECTION_ID_TAGS,
  REQUIRED_SECTION_TITLES_FOR_QID,
} from '../shared/constants.js';
import {
  tocTitleForLanguage,
  validatePptxSlide1MetasessionId,
  validatePptxSlide2Toc,
  isTwelveDigitId,
  isSectionId,
  isRecapTitle,
  sectionIdValidationError,
  validateSessionSectionCoverage,
  validateSectionTitlesFromCsv,
  normalizeSectionId,
  csvCellStr,
  rowHasPrimaryId,
  rowRequiresEmptySlideId,
  isSlideOrMediaId,
  clearSlideIdForMediaRow,
  validatePracticeQuestionTypesFromRows,
  processQuestionIdsFromApi,
  validateSectionTypesForMetasessionType,
} from '../shared/sessionCsv.js';
import { getMetasessionReportRow } from '../shared/metasessionApi.js';
import { openPresentationFromVfs } from '../pptx/openPresentation.js';
import {
  isThankYouSlide,
  getStandardizedThankYouTitle,
  getNumeralConvention,
  extractFieldValue,
  findVerbatimMultipartTags,
  findTagOccurrences,
  findVerbatimNOccurrences,
  extractVerbatimMultipart,
  extractInfoFromSlide,
  validationErrorSlideNumber,
  languageFromPresentationFilename,
  detectNewMode,
  extractSectionTitle,
  collectSlideTexts,
} from '../pptx/tagParser.js';

const QUESTION_ID_PATTERN = /^\d{12}(\.\d+)?$/;
const UTF8_BOM = '\uFEFF';

export class PipelineAbortError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'PipelineAbortError';
    this.errors = errors;
  }
}

/** Non-fatal abort for validate-only — mirrors validation_types.ValidationAbort. */
export class ValidationAbort extends Error {
  constructor(message, errors = [], { filename } = {}) {
    super(message);
    this.name = 'ValidationAbort';
    this.message = message;
    this.errors = errors;
    this.filename = filename || '';
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

function escapeCsvCell(val) {
  const s = val == null ? '' : String(val);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowsToCsv(columns, dataRows) {
  const lines = [columns.map(escapeCsvCell).join(',')];
  for (const row of dataRows) {
    lines.push(row.map(escapeCsvCell).join(','));
  }
  return UTF8_BOM + lines.join('\n');
}

function parseCsvText(text) {
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
          if (raw[i + 1] === '"') {
            cell += '"';
            i += 2;
          } else {
            i += 1;
            break;
          }
        } else {
          cell += raw[i];
          i += 1;
        }
      }
      if (raw[i] === ',') i += 1;
      return cell;
    }
    let start = i;
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

function getCsvColumns(isNewMode) {
  const columns = [
    'slide_number', 'slide_id', 'section_id', 'section_title', 'question_id',
    'question_placement', 'required_correct', 'attempt_window',
    'homework', 'section_gp', 'video_id', 'video_thumbnail_ts', 'activity_id', 'verbatim',
  ];
  columns.push(...HEADER_FIELDS);
  if (isNewMode) {
    columns.push('section_type', 'question_role');
  }
  columns.push('verbatim_listening', 'verbatim_multipart', 'verbatim_number');
  return columns;
}

function newModeBlankRow(slideNumber, slideId, sectionTitle, metasessionId) {
  return [
    slideNumber,
    slideId,
    '',
    sectionTitle,
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    slideNumber === 1 ? metasessionId : '',
    '', '', '', '', '', '', '', '', '',
    '',
    '',
    '',
    '',
    '',
  ];
}

async function processPresentationNewMode(vfs, filePath, log, options) {
  const extractedRows = [];
  const rawSlides = [];
  let metasessionId = '';
  let defaultRequiredCorrect = '3';
  let defaultAttemptWindow = '5';
  let checkpointDefaultsFound = false;
  let thankYouRawIndex = null;
  let thankYouPptSlideNumber = null;
  const slideValidationErrors = [];

  const warn = (msg) => log(msg);

  try {
    const prs = await openPresentationFromVfs(vfs, filePath, options);

    for (let i = 0; i < prs.slides.length; i += 1) {
      const slide = prs.slides[i];
      const slideNumber = i + 1;
      const collectedTexts = collectSlideTexts(slide);
      const combinedText = collectedTexts.join(' ');

      const knownTagsForValidation = [...NEW_MODE_SLIDE_FIELDS];
      if (slideNumber === 1) knownTagsForValidation.push('metasession_id');

      const baseTagCounts = findTagOccurrences(combinedText, knownTagsForValidation);
      const verbatimNCounts = findVerbatimNOccurrences(combinedText);
      const allTagCounts = { ...baseTagCounts, ...verbatimNCounts };

      for (const [tag, count] of Object.entries(allTagCounts).sort(([a], [b]) => a.localeCompare(b))) {
        if (count > 1) {
          slideValidationErrors.push(
            `Slide ${slideNumber}: tag '${tag}' is duplicated (${count} occurrences). `
            + 'Each tag must appear only once per slide.',
          );
        }
      }

      if ('section_title' in baseTagCounts) {
        const allowedCompanions = new Set(['section_title', 'section_type', ...SECTION_ID_TAGS]);
        if (slideNumber === 1) allowedCompanions.add('metasession_id');
        const disallowed = Object.keys(allTagCounts)
          .filter((t) => !allowedCompanions.has(t))
          .sort();
        if (disallowed.length > 0) {
          slideValidationErrors.push(
            `Slide ${slideNumber}: placeholder slide (with 'section_title' tag) `
            + `must not contain other tags. Also found: ${disallowed.join(', ')}.`,
          );
        }
      }

      if (slideNumber === 1) {
        for (const textBlock of collectedTexts) {
          const val = extractFieldValue(textBlock, 'metasession_id', slideNumber, ['metasession_id'], warn);
          if (val && !metasessionId) metasessionId = val;
        }
        const metaErr = validatePptxSlide1MetasessionId(`Slide ${slideNumber}`, metasessionId);
        if (metaErr) slideValidationErrors.push(metaErr);
        continue;
      }

      const slideData = Object.fromEntries(NEW_MODE_SLIDE_FIELDS.map((f) => [f, '']));
      slideData.section_title_colored = extractSectionTitle(slide);

      const verbatimNTags = findVerbatimMultipartTags(combinedText);
      const baseTerminators = [...NEW_MODE_SLIDE_FIELDS, ...verbatimNTags];
      const terminatorFields = slideNumber === 1
        ? [...baseTerminators, 'metasession_id']
        : baseTerminators;

      for (const textBlock of collectedTexts) {
        const info = extractInfoFromSlide(textBlock, slideNumber, NEW_MODE_SLIDE_FIELDS, terminatorFields, warn);
        for (const [key, value] of Object.entries(info)) {
          if (value && !slideData[key]) slideData[key] = value;
        }
      }

      const [verbatimMultipart, verbatimNumber] = extractVerbatimMultipart(
        collectedTexts, slideNumber, terminatorFields, warn,
      );
      slideData.slide_number = slideNumber;
      slideData.verbatim_multipart = verbatimMultipart;
      slideData.verbatim_number = verbatimNumber;

      if (slideNumber === 2) {
        const tocErr = validatePptxSlide2Toc(`Slide ${slideNumber}`, combinedText);
        if (tocErr) slideValidationErrors.push(tocErr);
        log(
          `   [Slide ${slideNumber}] TOC slide `
          + `('${slideData.slide_title || 'no slide_title tag'}') `
          + '— skipped (synthetic toc row).',
        );
        continue;
      }

      const hasSectionTitleTag = Boolean(slideData.section_title);
      const hasQuestionId = Boolean(slideData.question_id);
      const hasSlideTitle = Boolean(slideData.slide_title);
      const hasSlideId = Boolean(slideData.slide_id);
      const hasVideoId = Boolean(slideData.video_id);
      const hasActivityId = Boolean(slideData.activity_id);

      const isPlaceholder = hasSectionTitleTag && !hasQuestionId && !hasSlideTitle
        && !hasSlideId && !hasVideoId && !hasActivityId;

      if (isPlaceholder) {
        const sidErr = sectionIdValidationError(
          `Slide ${slideNumber}`,
          slideData.section_id,
        );
        if (sidErr) slideValidationErrors.push(sidErr);
        rawSlides.push(slideData);
        log(
          `   [Slide ${slideNumber}] Placeholder slide - Section: '${slideData.section_title || ''}', `
          + `Type: '${slideData.section_type || ''}'`,
        );
        continue;
      }

      rawSlides.push(slideData);

      const currentSlideTitle = slideData.slide_title || '';
      if (thankYouRawIndex === null && isThankYouSlide(currentSlideTitle)) {
        thankYouRawIndex = rawSlides.length - 1;
        thankYouPptSlideNumber = slideNumber;
        log(
          `   [Slide ${slideNumber}] 'Thank You' slide detected `
          + `(slide_title: '${currentSlideTitle}'). Slides after this will be ignored.`,
        );
        break;
      }
    }

    if (prs.slides.length < 2) {
      slideValidationErrors.push(
        'Slide 2 must be the Table of Contents slide; presentation has fewer than 2 slides.',
      );
    }

    let thankYouFound = thankYouRawIndex !== null;
    if (thankYouFound) {
      rawSlides.splice(thankYouRawIndex + 1);
      const thankYouSlide = rawSlides[rawSlides.length - 1];
      const standardizedTitle = getStandardizedThankYouTitle(thankYouSlide.slide_title || '');
      if (standardizedTitle) thankYouSlide.slide_title = standardizedTitle;
      thankYouSlide.slide_id = 'new';
      thankYouSlide.section_id = '';

      slideValidationErrors.splice(0, slideValidationErrors.length,
        ...slideValidationErrors.filter(
          (err) => validationErrorSlideNumber(err) <= thankYouPptSlideNumber,
        ),
      );
    }

    let procSectionTitle = '';
    let procSectionId = '';
    let procSectionType = '';
    let sectionTypeUsed = false;
    let procPreviousCheckpoint = false;
    let postQuestionSectionActive = false;

    let lastQuestionRawIndex = -1;
    for (let idx = 0; idx < rawSlides.length; idx += 1) {
      if ((rawSlides[idx].question_id || '').trim()) {
        lastQuestionRawIndex = idx;
      }
    }

    for (let slideIdx = 0; slideIdx < rawSlides.length; slideIdx += 1) {
      const slideData = rawSlides[slideIdx];
      const slideNumber = slideData.slide_number || slideIdx + 1;
      const hasSectionTitleTag = Boolean(slideData.section_title);
      const hasQuestionId = Boolean(slideData.question_id);
      const hasSlideTitle = Boolean(slideData.slide_title);
      const hasSlideId = Boolean(slideData.slide_id);
      const hasVideoId = Boolean(slideData.video_id);
      const hasActivityId = Boolean(slideData.activity_id);
      const isPlaceholder = hasSectionTitleTag && !hasQuestionId && !hasSlideTitle
        && !hasSlideId && !hasVideoId && !hasActivityId;

      if (isPlaceholder) {
        if (slideIdx > lastQuestionRawIndex) postQuestionSectionActive = true;
        procSectionTitle = slideData.section_title || '';
        const sid = (slideData.section_id || '').trim();
        if (isSectionId(sid)) procSectionId = sid;
        if (slideData.section_type) {
          procSectionType = slideData.section_type;
          sectionTypeUsed = false;
        }
        procPreviousCheckpoint = false;
        continue;
      }

      const isThankYou = isThankYouSlide(slideData.slide_title || '');
      const isRecap = isRecapTitle(
        slideData.slide_title || slideData.section_title_colored || '',
      );
      const afterLastQuestion = lastQuestionRawIndex >= 0 && slideIdx > lastQuestionRawIndex;
      let isRootTail = afterLastQuestion && !postQuestionSectionActive;
      if (isThankYou || isRecap) isRootTail = true;
      if (isRootTail) {
        procSectionTitle = '';
        procSectionId = '';
        procSectionType = '';
        sectionTypeUsed = true;
      }

      let finalSectionTitle = '';
      if ((slideData.video_id || '').trim()) {
        const vt = (slideData.video_title || '').trim() || (slideData.slide_title || '').trim();
        if (vt) finalSectionTitle = vt;
      } else if (hasSlideTitle) {
        finalSectionTitle = slideData.slide_title;
      } else if (slideData.question_role) {
        const role = (slideData.question_role || '').toLowerCase();
        if (role === 'example') finalSectionTitle = 'Example';
        else if (['interactive_example', 'interactive example', 'checkpoint', 'practice'].includes(role)) {
          finalSectionTitle = 'Question';
        }
      } else if (procSectionTitle) {
        finalSectionTitle = procSectionTitle;
      } else if (slideData.section_title_colored) {
        finalSectionTitle = slideData.section_title_colored;
      }

      let questionPlacement = '';
      const questionRole = (slideData.question_role || '').toLowerCase();
      if (questionRole === 'checkpoint') questionPlacement = 'ai';
      else if (questionRole === 'practice') questionPlacement = 'homework';

      let requiredCorrect = slideData.required_correct || '';
      let attemptWindow = slideData.attempt_window || '';
      if (questionRole === 'checkpoint') {
        const isFirstCheckpointInGroup = !procPreviousCheckpoint;
        if (!checkpointDefaultsFound) {
          if (requiredCorrect) defaultRequiredCorrect = requiredCorrect;
          if (attemptWindow) defaultAttemptWindow = attemptWindow;
          checkpointDefaultsFound = true;
        }
        if (isFirstCheckpointInGroup) {
          if (!requiredCorrect) requiredCorrect = defaultRequiredCorrect;
          if (!attemptWindow) attemptWindow = defaultAttemptWindow;
        }
      }

      let slideId = slideData.slide_id || '';
      if (isThankYou) {
        slideId = 'new';
        const standardizedTitle = getStandardizedThankYouTitle(slideData.slide_title || '');
        if (standardizedTitle) finalSectionTitle = standardizedTitle;
      }

      let rowSectionId = (slideData.section_id || '').trim() || procSectionId;
      if (isThankYou || isRootTail) rowSectionId = '';

      let rowSectionType = '';
      if (procSectionType && !sectionTypeUsed) {
        rowSectionType = procSectionType;
        sectionTypeUsed = true;
      }

      const row = [
        slideNumber,
        slideId,
        rowSectionId,
        finalSectionTitle,
        slideData.question_id || '',
        questionPlacement,
        requiredCorrect,
        attemptWindow,
        '',
        slideData.section_gp || '',
        slideData.video_id || '',
        slideData.timestamp || '',
        slideData.activity_id || '',
        slideData.verbatim || '',
        '', '', '', '', '', '', '', '', '', '',
        rowSectionType,
        questionRole,
        slideData.verbatim_listening || '',
        slideData.verbatim_multipart || '',
        slideData.verbatim_number || '',
      ];
      extractedRows.push(row);

      if (slideData.question_role) {
        procPreviousCheckpoint = questionRole === 'checkpoint';
      } else {
        procPreviousCheckpoint = false;
      }

      const sid = (slideData.section_id || '').trim();
      if (isSectionId(sid)) procSectionId = sid;
    }

    const deckLang = languageFromPresentationFilename(filePath);
    const tocTitle = tocTitleForLanguage(deckLang || 'en');
    const syntheticTitle = newModeBlankRow(1, 'new', '', metasessionId);
    const syntheticToc = newModeBlankRow(2, 'new', tocTitle, metasessionId);
    extractedRows.unshift(syntheticToc);
    extractedRows.unshift(syntheticTitle);

    return {
      extractedRows,
      headerMetadata: { metasession_id: metasessionId },
      thankYouFound,
      slideValidationErrors,
    };
  } catch (e) {
    log(`Could not process file ${basename(filePath)}. Error: ${e.message}`);
    console.error(e);
    return null;
  }
}

async function processPresentation(vfs, filePath, log, options) {
  const extractedRows = [];
  const headerMetadata = {};
  const warn = (msg) => log(msg);

  try {
    const prs = await openPresentationFromVfs(vfs, filePath, options);

    for (let i = 0; i < prs.slides.length; i += 1) {
      const slide = prs.slides[i];
      const slideNumber = i + 1;
      const collectedTexts = collectSlideTexts(slide);

      if (slideNumber === 1) {
        for (const f of HEADER_FIELDS) headerMetadata[f] = '';
        const combinedFields = [...HEADER_FIELDS, ...SLIDE_FIELDS];
        for (const textBlock of collectedTexts) {
          const info = extractInfoFromSlide(textBlock, slideNumber, HEADER_FIELDS, combinedFields, warn);
          for (const [k, v] of Object.entries(info)) {
            if (v && !headerMetadata[k]) headerMetadata[k] = v;
          }
        }
      }

      const finalData = { section_title: extractSectionTitle(slide) };
      for (const f of SLIDE_FIELDS) finalData[f] = '';

      const combinedText = collectedTexts.join(' ');
      const verbatimNTags = findVerbatimMultipartTags(combinedText);
      const combinedFieldsRow = [...SLIDE_FIELDS, ...HEADER_FIELDS, ...verbatimNTags];

      for (const textBlock of collectedTexts) {
        const infoFromBlock = extractInfoFromSlide(
          textBlock, slideNumber, SLIDE_FIELDS, combinedFieldsRow, warn,
        );
        for (const [key, value] of Object.entries(infoFromBlock)) {
          if (value && !finalData[key]) finalData[key] = value;
        }
      }

      const [multipartVal, numbersVal] = extractVerbatimMultipart(
        collectedTexts, slideNumber, combinedFieldsRow, warn,
      );
      finalData.verbatim_multipart = multipartVal;
      finalData.verbatim_number = numbersVal;

      const row = [
        slideNumber,
        finalData.slide_id || '',
        '',
        finalData.section_title || '',
        finalData.question_id || '',
        finalData.question_placement || '',
        finalData.required_correct || '',
        finalData.attempt_window || '',
        finalData.homework || '',
        finalData.section_gp || '',
        finalData.video_id || '',
        finalData.timestamp || '',
        finalData.activity_id || '',
        finalData.verbatim || '',
      ];

      for (const hf of HEADER_FIELDS) {
        row.push(slideNumber === 1 ? (headerMetadata[hf] || '') : '');
      }

      row.push(finalData.verbatim_listening || '');
      row.push(finalData.verbatim_multipart || '');
      row.push(finalData.verbatim_number || '');

      extractedRows.push(row);
    }

    for (const row of extractedRows) {
      const isSectionTitleEmpty = !row[3];
      const isQuestionPlacementEmpty = !row[5];
      if (isSectionTitleEmpty && isQuestionPlacementEmpty) {
        row[3] = 'Question';
      }
    }

    return { extractedRows, headerMetadata };
  } catch (e) {
    log(`Could not process file ${basename(filePath)}. Error: ${e.message}`);
    console.error(e);
    return null;
  }
}

async function detectModeFromPresentation(vfs, filePath, log, options) {
  try {
    const prs = await openPresentationFromVfs(vfs, filePath, options);
    if (prs.slides.length === 0) return 'original';
    const collectedTexts = collectSlideTexts(prs.slides[0]);
    return detectNewMode(collectedTexts) ? 'new' : 'original';
  } catch (e) {
    log(`Error detecting mode: ${e.message}`);
    return 'original';
  }
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

function validateHeaderAgainstReport(headerData, reportData) {
  const errors = [];
  const fieldMap = {
    metasession_number: 'Meta Session Number',
    language: 'Language',
    grade: 'Grade',
    term: 'Term',
    metasession_type: 'Class Type',
    subject: 'Subject',
    country: 'Country',
  };

  for (const [pptxKey, reportKey] of Object.entries(fieldMap)) {
    const pptxVal = (headerData[pptxKey] || '').trim();
    let reportVal = reportData[reportKey];
    if (reportVal == null) reportVal = '';
    reportVal = String(reportVal).trim();

    if (!pptxVal && !reportVal) continue;

    if (pptxVal.toLowerCase() !== reportVal.toLowerCase()) {
      errors.push(
        `Validation Mismatch: ${pptxKey} ('${pptxVal}') != ${reportKey} ('${reportVal}')`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

async function saveToCsv(vfs, csvPath, data, isNewMode, log) {
  const columns = getCsvColumns(isNewMode);
  const content = rowsToCsv(columns, data || []);
  await vfs.write(csvPath, content);
  log(`   Saved ${basename(csvPath)}.`);
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
          `Missing question_id on slide ${slideNum} (section_title: '${sectionTitle}' requires a 12-digit question_id).`,
        );
        continue;
      }
      if (!isTwelveDigitId(qid)) {
        validationErrors.push(
          `Invalid format for question_id '${qid}' on slide ${slideNum} `
          + `(section_title: '${sectionTitle}' requires a 12-digit or 12-digit.N question_id).`,
        );
        continue;
      }
    }

    if (!qid) continue;

    if (!isTwelveDigitId(qid)) {
      validationErrors.push(
        `Invalid format for question_id '${qid}' on slide ${slideNum}. Must be 12-digit or 12-digit.N.`,
      );
      continue;
    }

    if (!idLocations[qid]) idLocations[qid] = [];
    idLocations[qid].push(slideNum);
  }

  for (const [qid, slides] of Object.entries(idLocations)) {
    if (slides.length > 1) {
      validationErrors.push(`Duplicate question_id '${qid}' found on slides: ${slides.join(', ')}.`);
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
        `Invalid format for section_id '${sectionId}' on slide ${slideNum}. `
        + "Must be a 12-digit ID (not 'new').",
      );
    }

    if (qid && !questionRole) {
      validationErrors.push(`Slide ${slideNum}: question_id '${qid}' found but no question_role.`);
    }
    if (questionRole && !qid) {
      validationErrors.push(`Slide ${slideNum}: question_role '${questionRole}' found but no question_id.`);
    }

    if (qid) {
      if (!isTwelveDigitId(qid)) {
        validationErrors.push(
          `Invalid format for question_id '${qid}' on slide ${slideNum}. Must be 12-digit or 12-digit.N.`,
        );
        continue;
      }
      if (!idLocations[qid]) idLocations[qid] = [];
      idLocations[qid].push(slideNum);
    }

    if (!rowHasPrimaryId({
      slide_id: slideId,
      question_id: qid,
      video_id: videoId,
      activity_id: activityId,
    })) {
      validationErrors.push(
        `Slide ${slideNum}: No slide_id, question_id, video_id, or activity_id `
        + "(slide_id may be 12-digit, 12-digit.N, or 'new'; video_id and activity_id must be 12-digit).",
      );
    } else if (slideId && !isSlideOrMediaId(slideId)) {
      validationErrors.push(
        `Invalid format for slide_id '${slideId}' on slide ${slideNum}. Must be 12-digit, 12-digit.N, or 'new'.`,
      );
    }

    if (rowRequiresEmptySlideId({
      question_id: qid,
      video_id: videoId,
      activity_id: activityId,
    }) && slideId) {
      validationErrors.push(
        `Slide ${slideNum}: slide_id must be empty when question_id, video_id, or activity_id is set.`,
      );
    }

    if (videoId && !isTwelveDigitId(videoId)) {
      validationErrors.push(
        `Invalid format for video_id '${videoId}' on slide ${slideNum}. Must be a 12-digit ID (not 'new').`,
      );
    }
    if (activityId && !isTwelveDigitId(activityId)) {
      validationErrors.push(
        `Invalid format for activity_id '${activityId}' on slide ${slideNum}. Must be a 12-digit ID (not 'new').`,
      );
    }
  }

  for (const [qid, slides] of Object.entries(idLocations)) {
    if (slides.length > 1) {
      validationErrors.push(`Duplicate question_id '${qid}' found on slides: ${slides.join(', ')}.`);
    }
  }

  validationErrors.push(...validateSessionSectionCoverage(rows));

  return { valid: validationErrors.length === 0, errors: validationErrors };
}

async function readCsvFromVfs(vfs, csvPath) {
  const text = await vfs.read(csvPath);
  return parseCsvText(typeof text === 'string' ? text : new TextDecoder().decode(text));
}

function dedupeRowsByQuestionId(rows, getQuestionId) {
  const seen = new Set();
  const deduped = [];
  for (const row of rows) {
    const qid = (getQuestionId(row) || '').trim();
    if (qid && QUESTION_ID_PATTERN.test(qid)) {
      if (seen.has(qid)) continue;
      seen.add(qid);
    }
    deduped.push(row);
  }
  return deduped;
}

function multipartRowsChanged(originalRows, finalRows) {
  if (originalRows.length !== finalRows.length) return true;
  for (let i = 0; i < originalRows.length; i += 1) {
    if ((originalRows[i].question_id || '').trim() !== (finalRows[i].question_id || '').trim()) return true;
    if ((originalRows[i].slide_id || '').trim() !== (finalRows[i].slide_id || '').trim()) return true;
  }
  return false;
}

function applyMultipartQuestionId(row, baseId, partIndex) {
  return {
    ...row,
    question_id: `${baseId}.${partIndex}`,
    slide_id: '',
  };
}

async function expandQuestionIdsFromApi(vfs, csvPath, log, config, subject = '') {
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
  }
  return [];
}

async function applyLanguageAndNumerals(vfs, csvPath, reportRow, log) {
  if (!reportRow) {
    log('   [Warning] Cannot apply language/numerals - missing metasession data');
    return;
  }

  const language = csvCellStr(reportRow.Language).toLowerCase();
  const subject = csvCellStr(reportRow.Subject);
  const gradeStr = csvCellStr(reportRow.Grade);
  const sessionTitle = csvCellStr(reportRow.Title);

  let grade = 0;
  const gradeDigitsMatch = gradeStr.match(/(\d+)\s*$/) || gradeStr.match(/\d+/);
  if (gradeDigitsMatch) {
    grade = parseInt(gradeDigitsMatch[1] || gradeDigitsMatch[0], 10) || 0;
  }
  if (grade === 0 && gradeStr) {
    log(`   [Warning] Could not parse grade '${gradeStr}' as integer, defaulting to 0`);
  }

  const numerals = getNumeralConvention(subject, grade);
  log(`   [Numerals] Subject='${subject}', Grade=${grade} -> '${numerals}'`);

  try {
    const { headers, rows } = await readCsvFromVfs(vfs, csvPath);

    for (const row of rows) {
      const sectionTitle = csvCellStr(row.section_title);
      const slideId = csvCellStr(row.slide_id).toLowerCase();
      const slideNum = csvCellStr(row.slide_number);

      if (slideNum === '1' && sessionTitle) {
        const colonIdx = sessionTitle.indexOf(':');
        const cleanedTitle = colonIdx >= 0
          ? sessionTitle.slice(colonIdx + 1).trim()
          : sessionTitle;
        row.section_title = cleanedTitle;
        log(`   [Slide 1 Title] Set to '${cleanedTitle}' from metasession API`);
      } else if (slideNum === '2') {
        row.section_title = tocTitleForLanguage(language);
        row.slide_id = 'new';
        log(`   [Slide 2 TOC] Set to '${row.section_title}'`);
      } else if (language === 'ar') {
        if (sectionTitle.toLowerCase() === 'example') {
          row.section_title = 'مثال';
        } else if (sectionTitle.toLowerCase() === 'question' && slideId === 'new') {
          row.section_title = 'سؤال';
        }
      }

      if (csvCellStr(row.metasession_id)) {
        row.numerals = numerals;
      }
    }

    const dataRows = rows.map((row) => headers.map((col) => row[col] ?? ''));
    await vfs.write(csvPath, rowsToCsv(headers, dataRows));
    log(`   [Language] Applied language='${language}' transformations`);
  } catch (e) {
    log(`   [Error] Failed to apply language/numerals: ${e.message}`);
  }
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
  for (const sid of slideIds) {
    rowsOut.push([metasessionId, sid]);
  }
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

/**
 * Run CSV extraction for one or more PPTX files.
 * @param {object} ctx
 * @param {object} ctx.vfs - virtual filesystem with read/write/remove
 * @param {(msg: string) => void} ctx.log
 * @param {object} [ctx.googleSheets] - optional { appendRows(spreadsheetId, tabName, rows) }
 * @param {object} [ctx.config]
 * @param {string[]} pptxFilenames
 */
export async function runExtractCsv(ctx, pptxFilenames) {
  _abortOnError = ctx.abortOnError !== false;
  _skipSheets = ctx.skipSheets === true;
  const { vfs, log = console.log, googleSheets, config = {} } = ctx;
  const fetchFn = config.fetchFn || fetch;
  const apiOpts = { log, fetchFn };
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

  log(`Processing ${filesToProcess.length} file(s) from: ${sessionsPath}`);

  const processingSummary = [];
  const sheetsRowsToUpload = [];

  for (const { filename, filePath } of filesToProcess) {
    try {
    log('\n' + '='.repeat(60));
    log(`Processing PowerPoint: ${filename}`);
    log('='.repeat(60));

    const mode = await detectModeFromPresentation(vfs, filePath, log, pptxOptions);
    log(`-> Detected mode: ${mode.toUpperCase()}`);

    if (mode === 'new') {
      const result = await processPresentationNewMode(vfs, filePath, log, pptxOptions);
      if (!result) {
        abortPipeline(log, `No data was extracted from ${filename}`);
      }

      const {
        extractedRows: allSlidesData,
        headerMetadata,
        thankYouFound,
        slideValidationErrors,
      } = result;

      const originalBaseName = stemName(filename);
      const metaId = csvCellStr(headerMetadata.metasession_id);

      if (!metaId) {
        abortPipeline(log, `Missing metasession_id on slide 1 in ${filename}`, [
          "Missing mandatory field 'metasession_id' on Slide 1.",
        ]);
      }

      if (!thankYouFound) {
        abortPipeline(log, `Missing 'Thank You' slide in ${filename}`, [
          "Missing 'Thank You' slide. Expected slide_title = 'Thank You' or 'شكرًا جزيلًا'.",
        ]);
      }

      if (slideValidationErrors.length > 0) {
        log('   [FAILURE] Slide structure validation failed.');
        for (const err of slideValidationErrors) log(`     - ${err}`);
        abortPipeline(
          log,
          `Slide structure validation failed for ${filename}`,
          slideValidationErrors,
          { filename: `${metaId}_${originalBaseName}.csv` },
        );
      }

      log(`-> Found metasession_id: ${metaId}`);
      log('   Fetching metasession data from API...');
      const reportRow = await getMetasessionReportRow(metaId, apiOpts);

      const sectionTypeErrors = validateSectionTypesForMetasessionType(
        csvCellStr(reportRow?.['Class Type']),
        { slides: allSlidesData },
      );
      if (sectionTypeErrors.length > 0) {
        log('   [FAILURE] Metasession section_type validation failed.');
        for (const err of sectionTypeErrors) log(`     - ${err}`);
        abortPipeline(
          log,
          `Invalid section_type for metasession ${metaId}`,
          sectionTypeErrors,
          { filename: `${metaId}_${originalBaseName}.csv` },
        );
      }

      const finalSaveName = `${metaId}_${originalBaseName}.csv`;
      const saveFilepath = joinPath(csvsPath, finalSaveName);

      log(`-> Saving to ${finalSaveName}...`);
      await saveToCsv(vfs, saveFilepath, allSlidesData, true, log);

      const subject = csvCellStr(reportRow?.Subject);

      log('   Processing question IDs from QMS API...');
      const questionIdErrors = await expandQuestionIdsFromApi(
        vfs, saveFilepath, log, config, subject,
      );
      if (questionIdErrors.length > 0) {
        log('   [FAILURE] Question ID processing failed.');
        for (const err of questionIdErrors) log(`     - ${err}`);
        try {
          if (vfs.remove) await vfs.remove(saveFilepath);
          log('   Deleted invalid file.');
        } catch (e) {
          log(`   Error deleting file: ${e.message}`);
        }
        abortPipeline(log, `Question ID processing failed for ${finalSaveName}`, questionIdErrors);
      }

      log('   Validating extracted content (new mode)...');
      const { rows } = await readCsvFromVfs(vfs, saveFilepath);
      const { valid: isValidContent, errors: contentErrors } = validateCsvNewModeFromRows(rows);

      if (!isValidContent) {
        log('   [FAILURE] Content validation failed.');
        for (const err of contentErrors) log(`     - ${err}`);
        try {
          if (vfs.remove) await vfs.remove(saveFilepath);
          log('   Deleted invalid file.');
        } catch (e) {
          log(`   Error deleting file: ${e.message}`);
        }
        if (!_abortOnError) {
          processingSummary.push({
            filename: finalSaveName,
            status: 'INVALID',
            errors: contentErrors,
          });
        } else {
          abortPipeline(log, `CSV validation failed for ${finalSaveName}`, contentErrors);
        }
      } else {
        log('   [SUCCESS] Content validation passed.');

        log('   Validating practice question types...');
        const { rows: expandedRows } = await readCsvFromVfs(vfs, saveFilepath);
        const practiceTypeErrors = await validatePracticeQuestionTypesFromRows(
          expandedRows,
          ctx.fetchFn || config.fetchFn,
          { subject },
        );
        if (practiceTypeErrors.length > 0) {
          log('   [FAILURE] Practice question type validation failed.');
          for (const err of practiceTypeErrors) log(`     - ${err}`);
          try {
            if (vfs.remove) await vfs.remove(saveFilepath);
            log('   Deleted invalid file.');
          } catch (e) {
            log(`   Error deleting file: ${e.message}`);
          }
          abortPipeline(
            log,
            `Practice question type validation failed for ${finalSaveName}`,
            practiceTypeErrors,
            { filename: finalSaveName },
          );
        }

        log('   Applying language and numerals from metasession API...');
        await applyLanguageAndNumerals(vfs, saveFilepath, reportRow, log);

        log('   Validating section titles against QMS section API...');
        const titleCheck = await validateSectionTitlesAgainstApi(
          vfs, saveFilepath, log, config,
        );
        if (!titleCheck.ok) {
          abortPipeline(
            log,
            `Section title validation failed for ${finalSaveName}`,
            titleCheck.errors,
            { filename: finalSaveName },
          );
        }

        processingSummary.push({ filename: finalSaveName, status: 'VALID', errors: [] });

        const sheetRows = await collectSlideIdRowsFromCsv(vfs, saveFilepath, log);
        if (sheetRows.length > 0) {
          sheetsRowsToUpload.push(...sheetRows);
          log(`   [Sheets] Queued ${sheetRows.length} slide_id row(s) for upload.`);
        }
      }
    } else {
      const result = await processPresentation(vfs, filePath, log, pptxOptions);
      if (!result) {
        abortPipeline(log, `No data was extracted from ${filename}`);
      }

      const { extractedRows: allSlidesData, headerMetadata } = result;
      const originalBaseName = stemName(filename);
      let finalSaveName = `${originalBaseName}.csv`;
      let savePermission = true;
      const validationErrors = [];

      const numeralsVal = csvCellStr(headerMetadata.numerals);
      if (numeralsVal) {
        if (!['arabic', 'european'].includes(numeralsVal.toLowerCase())) {
          log(`   [ERROR] Invalid value for 'numerals': '${numeralsVal}'. Must be 'Arabic' or 'European'.`);
          savePermission = false;
          validationErrors.push(`Invalid numerals value: '${numeralsVal}'`);
        }
      }

      if (savePermission) {
        const metaId = csvCellStr(headerMetadata.metasession_id);
        if (metaId) {
          log(`-> Found metasession_id: ${metaId}`);
          log('   Fetching metasession data from API...');
          const reportRow = await getMetasessionReportRow(metaId, apiOpts);

          log('   Validating metadata against API response...');
          const { valid: isValidMeta, errors: metaErrors } = validateHeaderAgainstReport(
            headerMetadata, reportRow,
          );

          if (isValidMeta) {
            log('   [SUCCESS] Metadata validation passed.');
            finalSaveName = `${metaId}_${originalBaseName}.csv`;
          } else {
            log('   [FAILURE] Metadata validation failed.');
            for (const err of metaErrors) log(`     - ${err}`);
            savePermission = false;
            validationErrors.push(...metaErrors);
          }
        } else {
          log("   [ERROR] Missing mandatory field 'metasession_id' on Slide 1.");
          savePermission = false;
          validationErrors.push("Missing mandatory field 'metasession_id' on Slide 1.");
        }
      }

      if (savePermission) {
        const saveFilepath = joinPath(csvsPath, finalSaveName);
        log(`-> Saving to ${finalSaveName}...`);
        await saveToCsv(vfs, saveFilepath, allSlidesData, false, log);

        log('   Validating extracted content...');
        const { rows } = await readCsvFromVfs(vfs, saveFilepath);
        const { valid: isValidContent, errors: contentErrors } = validateCsvFromRows(rows);

        if (isValidContent) {
          log('   [SUCCESS] Content validation passed.');
          processingSummary.push({ filename: finalSaveName, status: 'VALID', errors: [] });

          const sheetRows = await collectSlideIdRowsFromCsv(vfs, saveFilepath, log);
          if (sheetRows.length > 0) {
            sheetsRowsToUpload.push(...sheetRows);
            log(`   [Sheets] Queued ${sheetRows.length} slide_id row(s) for upload.`);
          }
        } else {
          try {
            if (vfs.remove) await vfs.remove(saveFilepath);
            log('   Deleted invalid file.');
          } catch (e) {
            log(`   Error deleting file: ${e.message}`);
          }
          if (!_abortOnError) {
            processingSummary.push({
              filename: finalSaveName,
              status: 'INVALID',
              errors: contentErrors,
            });
          } else {
            abortPipeline(log, `CSV validation failed for ${finalSaveName}`, contentErrors);
          }
        }
      } else {
        abortPipeline(log, `Validation failed for ${filename}`, validationErrors);
      }
    }
    } catch (e) {
      if (e instanceof ValidationAbort && !_abortOnError) {
        if (e.filename) {
          processingSummary.push({
            filename: e.filename,
            status: 'INVALID',
            errors: e.errors,
          });
        } else {
          throw e;
        }
      } else {
        throw e;
      }
    }
  }

  log('\n' + '='.repeat(60));
  log('                      FINAL SUMMARY REPORT');
  log('='.repeat(60));

  let validFilesCount = 0;
  if (processingSummary.length === 0) {
    log('No PowerPoint files were found or processed.');
  } else {
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
  }

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

    if (!ok) {
      abortPipeline(log, 'Google Sheets upload failed');
    } else if (googleSheets) {
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

/**
 * Validate one PPTX (step 2) without aborting the outer validate-only run.
 */
export function buildCsvOutcomes(processingSummary, csvsPath) {
  const outcomes = [];
  for (const item of processingSummary || []) {
    const fname = String(item.filename || '');
    const base = fname.split(' (')[0].trim();
    const mid = /^\d+$/.test(base.split('_')[0]) ? base.split('_')[0] : '';
    let csvPath = '';
    if (item.status === 'VALID' && base.endsWith('.csv')) {
      csvPath = `${csvsPath}/${base}`;
    }
    const errs = item.errors || [];
    const metasessionErrors = errs.filter((e) => /metasession|metadata/i.test(e));
    const csvErrors = errs.filter((e) => !metasessionErrors.includes(e));
    outcomes.push({
      csvFilename: base.endsWith('.csv') ? base : fname,
      csvPath,
      metasessionId: mid,
      csvErrors,
      metasessionErrors,
    });
  }
  return outcomes;
}

export async function validatePresentationFile(ctx, pptxFilename) {
  const csvsPath = ctx.config?.csvsPath || 'csvs';
  const pptxErrors = [];

  try {
    const result = await runExtractCsv(
      { ...ctx, abortOnError: false, skipSheets: true },
      [pptxFilename],
    );
    return {
      pptxErrors,
      csvOutcomes: buildCsvOutcomes(result.processingSummary, csvsPath),
    };
  } catch (e) {
    if (e instanceof ValidationAbort) {
      const summary = [];
      if (e.filename) {
        summary.push({ filename: e.filename, status: 'INVALID', errors: e.errors });
      } else if (e.errors.length) {
        pptxErrors.push(...e.errors);
      } else {
        pptxErrors.push(e.message);
      }
      return { pptxErrors, csvOutcomes: buildCsvOutcomes(summary, csvsPath) };
    }
    if (e instanceof PipelineAbortError) {
      pptxErrors.push(...(e.errors || [e.message]));
    } else {
      pptxErrors.push(e.message);
    }
    return { pptxErrors, csvOutcomes: [] };
  }
}
