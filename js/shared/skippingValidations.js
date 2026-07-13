/** Load skipping_validations Google Sheet permissions (hard-fail if unreadable). */

import {
  SKIP_VALIDATIONS_SPREADSHEET_ID,
  SKIP_VALIDATIONS_TAB,
  SKIP_VALIDATIONS_RANGE,
} from './constants.js';
import { skippingValidationsFromSheetRows } from './sessionCsv.js';

/**
 * @param {import('../auth/googleAuth.js').GoogleSheets} googleSheets
 * @returns {Promise<[string[][], string | null]>}
 */
export async function loadSkippingValidationsRows(googleSheets) {
  if (!googleSheets) {
    return [[], 'Google Sheets API is not available.'];
  }
  try {
    const range = `${SKIP_VALIDATIONS_TAB}!${SKIP_VALIDATIONS_RANGE}`;
    const rows = await googleSheets.read(range, SKIP_VALIDATIONS_SPREADSHEET_ID);
    return [rows || [], null];
  } catch (e) {
    return [[], `Could not read skipping_validations sheet: ${e.message || e}`];
  }
}

/**
 * @param {import('../auth/googleAuth.js').GoogleSheets} googleSheets
 * @returns {Promise<[Map<string, import('./sessionCsv.js').PermissionContext>, string[]]>}
 */
export async function loadSkippingValidationsByMetasession(googleSheets) {
  const [rows, loadErr] = await loadSkippingValidationsRows(googleSheets);
  if (loadErr) return [new Map(), [loadErr]];
  const [byMeta, tagErrors] = skippingValidationsFromSheetRows(rows);
  return [byMeta, tagErrors];
}
