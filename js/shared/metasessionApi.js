/** Metasession API client — port of metasession_api.py */

import { normalizeMetasessionId, validateMetasessionTypeSupported, validateSeasonFromApi } from './sessionCsv.js';
import { sessionNumberFromTitle } from './pptxNameValidator.js';

const API_URL = 'https://admin.classes.nagwa.com/api/v1/metasessions/{metasession_id}/';
const API_KEY = 'KbykjcvM9ljLd8P3YQLxyenWmNmKOuryjZJFFYmMxIc';
const MAX_RETRIES = 3;
const RETRY_DELAY_SEC = 2;
const TIMEOUT_SEC = 30;

const _cache = new Map();
const _rawCache = new Map();

/**
 * Split on the first ASCII or fullwidth colon only (matches Python re.split maxsplit=1).
 * JS String.split(/regex/, limit) is not equivalent — limit caps result length, not split count.
 * @param {string} text
 * @returns {{ before: string, after: string } | null}
 */
function splitOnceOnColon(text) {
  const idx = text.search(/[:：]/);
  if (idx < 0) return null;
  return {
    before: text.slice(0, idx).trim(),
    after: text.slice(idx + 1).trim(),
  };
}

export function stripSessionPrefix(metasessionTitle) {
  if (!metasessionTitle) return metasessionTitle;
  const parts = splitOnceOnColon(metasessionTitle);
  if (parts) return parts.after;
  return metasessionTitle.trim();
}

/**
 * @param {string} metasessionTitle
 * @returns {string | null}
 */
export function computeMetasessionNumber(metasessionTitle) {
  const result = sessionNumberFromTitle(metasessionTitle);
  if (result == null && metasessionTitle) {
    const parts = splitOnceOnColon(metasessionTitle);
    const prefix = parts ? parts.before : metasessionTitle.trim();
    console.warn(
      `Could not derive metasession_number from title prefix: '${prefix}' (full title: '${metasessionTitle}').`,
    );
  }
  return result;
}

/** @type {typeof fetch | null} */
let _fetchFn = null;

export function setMetasessionFetchFn(fn) {
  _fetchFn = fn;
}

function sleep(sec) {
  return new Promise((resolve) => setTimeout(resolve, sec * 1000));
}

async function fetchMetasessionData(metasessionId, log = console.log, fetchFn = null) {
  const fetchImpl = fetchFn || _fetchFn || fetch;
  const normalizedId = normalizeMetasessionId(metasessionId);
  if (!normalizedId) return null;
  metasessionId = normalizedId;

  const url = API_URL.replace('{metasession_id}', metasessionId);
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      log(`   [API] GET ${url} (attempt ${attempt}/${MAX_RETRIES})`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_SEC * 1000);
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          'X-API-KEY': API_KEY,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      const body = await response.text();
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        log(`   [API Error] ${lastError}`);
      } else {
        const payload = JSON.parse(body);
        if (!payload.success) {
          lastError = 'API returned success=false';
          log(`   [API Error] ${lastError}: ${JSON.stringify(payload)}`);
        } else {
          const data = payload.data;
          if (!data) {
            lastError = 'API returned empty data';
            log(`   [API Error] ${lastError}`);
          } else {
            return data;
          }
        }
      }
    } catch (e) {
      lastError = e.name === 'AbortError' ? 'TimeoutError' : `${e.name}: ${e.message}`;
      log(`   [API Error] ${lastError}`);
      if (String(e.message).includes('Failed to fetch')) {
        log('   [API Hint] Browser blocked the request (network/CORS/adblock).');
        log('   [API Hint] Clear "CORS proxy URL" unless you run: node proxy/local-server.mjs');
        log('   [API Hint] Hard-refresh (Cmd+Shift+R). Nagwa APIs use direct fetch (no proxy needed).');
      }
    }

    if (attempt < MAX_RETRIES) {
      log(`   [API] Retrying in ${RETRY_DELAY_SEC}s...`);
      await sleep(RETRY_DELAY_SEC);
    }
  }

  log(`   [API FATAL] Failed after ${MAX_RETRIES} attempts. Last error: ${lastError}`);
  return null;
}

export function buildReportRow(apiData, { extended = false, metasessionId = '' } = {}) {
  if (!apiData) return {};

  const gradeObj = apiData.grade || {};
  const subjectObj = apiData.subject || {};
  const languageObj = apiData.language || {};
  const countryObj = apiData.country || {};
  const termObj = apiData.term || {};

  const metasessionTitle = apiData.metasession_title || '';
  const metasessionNumber = apiData.metasession_number;
  const termId = typeof termObj === 'object' && termObj ? termObj.id : null;

  const row = {
    'Meta Session Number': metasessionNumber != null ? String(metasessionNumber) : '',
    'Class Type': apiData.metasession_type || '', // raw API type == course_type
    Title: metasessionTitle,
    Subject: subjectObj.name || '',
    Grade: gradeObj.title || '',
    Term: termId != null ? String(termId) : '',
    Language: languageObj.iso_code || '',
    Country: countryObj.iso_code || '',
  };

  if (extended) {
    const strippedTitle = stripSessionPrefix(metasessionTitle);
    const computedNumber = computeMetasessionNumber(metasessionTitle);
    row['Meta Session Id'] = String(metasessionId);
    row['Meta Session Number'] = computedNumber != null ? String(computedNumber) : '';
    row['Meta Class Id'] = String(apiData.metaclass_id || '');
    row['Class Type'] = String(apiData.metasession_type || '');
    row['Language'] = String(languageObj.iso_code || '');
    row['Country'] = String(countryObj.iso_code || 'eg');
    row['Academic Year'] = String(apiData.academic_year || '');
    row['Metasession Title'] = strippedTitle;
    row.Season = apiData.season != null ? String(apiData.season) : '';
  }

  return row;
}

export async function getRawMetasessionData(metasessionId, { fatal = true, log = console.log, fetchFn = null } = {}) {
  const normalizedId = normalizeMetasessionId(metasessionId);
  if (!normalizedId) {
    if (fatal) {
      log(`   [FATAL] Invalid metasession ID: ${metasessionId}`);
      throw new Error(`Invalid metasession ID: ${metasessionId}`);
    }
    return null;
  }
  metasessionId = normalizedId;

  if (_rawCache.has(metasessionId)) {
    return _rawCache.get(metasessionId);
  }

  const apiData = await fetchMetasessionData(metasessionId, log, fetchFn);
  if (!apiData) {
    if (fatal) {
      log(`   [FATAL] Could not fetch metasession data for '${metasessionId}' after ${MAX_RETRIES} attempts. Terminating.`);
      throw new Error(`Could not fetch metasession data for '${metasessionId}'`);
    }
    return null;
  }

  const typeErrors = validateMetasessionTypeSupported(apiData.metasession_type);
  if (typeErrors.length) {
    for (const err of typeErrors) log(`   [FATAL] ${err}`);
    if (fatal) {
      throw new Error(typeErrors[0]);
    }
    return null;
  }

  const seasonErrors = validateSeasonFromApi(apiData);
  if (seasonErrors.length) {
    for (const err of seasonErrors) log(`   [FATAL] ${err}`);
    if (fatal) {
      throw new Error(seasonErrors[0]);
    }
    return null;
  }

  _rawCache.set(metasessionId, apiData);
  return apiData;
}

export async function getMetasessionReportRow(
  metasessionId,
  { extended = false, fatal = true, log = console.log, fetchFn = null } = {},
) {
  if (!metasessionId) return null;

  const cacheKey = `${metasessionId}:${extended}`;
  if (_cache.has(cacheKey)) {
    return _cache.get(cacheKey);
  }

  const apiData = await getRawMetasessionData(metasessionId, { fatal, log, fetchFn });
  if (!apiData) return null;

  const reportRow = buildReportRow(apiData, { extended, metasessionId });
  _cache.set(cacheKey, reportRow);
  return reportRow;
}

export function setReportClassType(metasessionId, classType) {
  if (!metasessionId) return;
  for (const [key, row] of _cache.entries()) {
    if (key.startsWith(`${metasessionId}:`) && row) {
      row['Class Type'] = classType;
    }
  }
}
