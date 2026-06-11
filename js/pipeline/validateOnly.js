/**
 * Validate-only orchestration — port of Scripts/validation_runner.py
 */

import { downloadAllFromLinks } from './downloadWithRename.js';
import { validatePresentationFile as validateSinglePptx } from './extractCsv.js';
import { validatePresentationFile as validateMergedPptx } from './extractCsvMerged.js';
import { validateSessionCsv, resetXmlBuilderCaches } from './xmlBuilder.js';
import { isMergedPptxBasename } from '../shared/sessionCsv.js';
import {
  initSectionsValidationResults,
  SECTIONS_VALIDATION_RESULTS_FILE,
} from '../shared/sectionValidator.js';

export const FULL_VALIDATION_PATH = 'full_validation.txt';
export { SECTIONS_VALIDATION_RESULTS_FILE };

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function sessionLabel(report) {
  if (report.metasessionId) return report.metasessionId;
  if (report.csvFilename) return report.csvFilename;
  return report.pptxName || 'unknown';
}

function sessionPassed(report) {
  return (
    report.downloadOk
    && !report.pptxErrors.length
    && !report.csvErrors.length
    && !report.metasessionErrors.length
    && !report.sectionErrors.length
    && !report.missingQuestionErrors.length
  );
}

function reportFromOutcome({ sourceUrl, pptxName, pptxErrors, outcome }) {
  return {
    sourceUrl,
    pptxName,
    metasessionId: outcome.metasessionId || '',
    csvFilename: outcome.csvFilename || '',
    metasessionIds: outcome.metasessionId ? [outcome.metasessionId] : [],
    pptxErrors: [...pptxErrors],
    csvErrors: [...(outcome.csvErrors || [])],
    metasessionErrors: [...(outcome.metasessionErrors || [])],
    sectionErrors: [],
    missingQuestionErrors: [],
    downloadOk: true,
    downloadError: '',
  };
}

function formatReportBlock(report) {
  const lines = [
    '='.repeat(80),
    `SESSION: ${sessionLabel(report)}`,
  ];
  if (report.pptxName) lines.push(`PPTX: ${report.pptxName}`);
  if (report.csvFilename) lines.push(`CSV: ${report.csvFilename}`);
  if (report.sourceUrl) lines.push(`URL: ${report.sourceUrl}`);
  if (report.metasessionId) lines.push(`Metasession ID: ${report.metasessionId}`);
  lines.push(`Overall: ${sessionPassed(report) ? 'PASSED' : 'FAILED'}`);
  lines.push('');

  if (!report.downloadOk) {
    lines.push('--- Download ---');
    lines.push(`  FAILED: ${report.downloadError}`);
    lines.push('');
    return `${lines.join('\n')}\n`;
  }

  lines.push('--- PPTX / extract (step 2) ---');
  if (report.pptxErrors.length) {
    for (const err of report.pptxErrors) lines.push(`  ${err}`);
  } else {
    lines.push('  PASSED');
  }
  lines.push('');

  lines.push('--- CSV validation (step 2) ---');
  if (report.csvErrors.length) {
    for (const err of report.csvErrors) lines.push(`  ${err}`);
  } else {
    lines.push('  PASSED');
  }
  lines.push('');

  lines.push('--- Metasession API (step 2/3) ---');
  if (report.metasessionErrors.length) {
    for (const err of report.metasessionErrors) lines.push(`  ${err}`);
  } else {
    lines.push('  PASSED');
  }
  lines.push('');

  lines.push('--- Section validation (step 3) ---');
  if (report.sectionErrors.length) {
    for (const err of report.sectionErrors) lines.push(`  ${err}`);
  } else {
    lines.push('  PASSED');
  }
  lines.push('');

  if (report.missingQuestionErrors.length) {
    lines.push('--- Missing QMS questions (step 3) ---');
    for (const err of report.missingQuestionErrors) lines.push(`  ${err}`);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function formatSummary(reports, completed) {
  const passed = reports.filter((r) => sessionPassed(r)).length;
  const failed = reports.length - passed;
  const lines = [
    '='.repeat(80),
    'SUMMARY',
    '='.repeat(80),
    `Total sessions: ${reports.length}`,
    `Passed: ${passed}`,
    `Failed: ${failed}`,
  ];
  if (failed) {
    lines.push('');
    lines.push('Failed sessions:');
    for (const r of reports) {
      if (!sessionPassed(r)) lines.push(`  - ${sessionLabel(r)}`);
    }
  }
  lines.push('');
  lines.push(`Report completed: ${completed}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function buildReportText({ linksCsvPath, reports, sessionBlocks, started, completed }) {
  const header = `${'='.repeat(80)}\nFULL VALIDATION REPORT (validate-only mode)\n${'='.repeat(80)}\n`
    + `Report started: ${started}\nlinks.csv: ${linksCsvPath}\n\n`;
  const summary = formatSummary(reports, completed);
  return header + summary + sessionBlocks.join('');
}

function logSessionResult(log, report) {
  const status = sessionPassed(report) ? 'PASSED' : 'FAILED';
  log(`  ${sessionLabel(report)}: ${status}`);
}

/**
 * @param {object} ctx
 * @returns {Promise<{ ok: boolean, reportPath: string, reports: object[] }>}
 */
export async function runValidateOnly(ctx) {
  const { vfs, log, config = {} } = ctx;
  const linksCsvPath = config.linksCsvPath || 'links.csv';
  const sessionsDir = config.sessionsDir || 'sessions';
  const tempRoot = '_validate_tmp';
  const silentLog = () => {};
  const quietCtx = {
    ...ctx,
    log: silentLog,
    config: { ...config, validateOnlyQuiet: true },
  };

  if (!(await vfs.exists(linksCsvPath))) {
    throw new Error(`links.csv not found at ${linksCsvPath}`);
  }

  if (await vfs.exists(sessionsDir)) {
    await vfs.removeDir(sessionsDir);
  }
  await vfs.mkdir(sessionsDir, { recursive: true });

  if (await vfs.exists(tempRoot)) {
    await vfs.removeDir(tempRoot);
  }

  const reports = [];
  const sessionBlocks = [];
  const urlByPptx = {};
  const started = stamp();

  resetXmlBuilderCaches();
  await initSectionsValidationResults(vfs);

  const linksText = await vfs.readText(linksCsvPath);
  const rowCount = Math.max(0, linksText.split('\n').filter((l) => l.trim()).length - 1);
  log(`Validate-only: downloading ${rowCount} session(s)...`);

  const download = await downloadAllFromLinks(quietCtx);
  if (!download.ok) {
    throw new Error(download.error || 'Download orchestration failed');
  }
  const downloaded = download.results.filter((r) => r.ok).length;
  log(`Downloaded ${downloaded}/${download.results.length}`);

  for (const item of download.results) {
    const fname = item.filename || item.name;
    if (fname && item.url) urlByPptx[fname] = item.url;
    if (!item.ok) {
      const failReport = {
        sourceUrl: item.url || '',
        pptxName: item.name || item.url || 'unknown',
        metasessionId: '',
        csvFilename: '',
        metasessionIds: [],
        pptxErrors: [],
        csvErrors: [],
        metasessionErrors: [],
        sectionErrors: [],
        missingQuestionErrors: [],
        downloadOk: false,
        downloadError: item.error || 'Download failed',
      };
      reports.push(failReport);
      sessionBlocks.push(formatReportBlock(failReport));
      logSessionResult(log, failReport);
    }
  }

  const pptxNames = (await vfs.listDir(sessionsDir))
    .filter((f) => f.endsWith('.pptx') && !f.startsWith('~'))
    .sort();

  if (!pptxNames.length) {
    const completed = stamp();
    await vfs.writeText(
      FULL_VALIDATION_PATH,
      buildReportText({
        linksCsvPath,
        reports,
        sessionBlocks: ['No .pptx files found in sessions after download.\n'],
        started,
        completed,
      }),
    );
    log(`Report: ${FULL_VALIDATION_PATH}`);
    return { ok: true, reportPath: FULL_VALIDATION_PATH, reports };
  }

  log(`Validating ${pptxNames.length} presentation(s)...`);
  const metasessionCache = new Map();
  let sessionIndex = 0;

  try {
    for (let i = 0; i < pptxNames.length; i += 1) {
      const pptxName = pptxNames[i];
      const sourceUrl = urlByPptx[pptxName] || '';
      const csvsPath = `${tempRoot}/session_${sessionIndex}/csvs`;
      sessionIndex += 1;
      await vfs.mkdir(csvsPath, { recursive: true });

      const validateCtx = {
        ...quietCtx,
        config: { ...quietCtx.config, csvsPath, sessionsPath: sessionsDir },
      };

      log(`[${i + 1}/${pptxNames.length}] ${pptxName}`);

      try {
        const extractFn = isMergedPptxBasename(pptxName) ? validateMergedPptx : validateSinglePptx;
        const { pptxErrors, csvOutcomes } = await extractFn(validateCtx, pptxName);

        if (!csvOutcomes.length) {
          const sessionReport = {
            sourceUrl,
            pptxName,
            metasessionId: '',
            csvFilename: '',
            metasessionIds: [],
            pptxErrors: pptxErrors.length
              ? pptxErrors
              : ['No CSV output was produced for this presentation.'],
            csvErrors: [],
            metasessionErrors: [],
            sectionErrors: [],
            missingQuestionErrors: [],
            downloadOk: true,
            downloadError: '',
          };
          reports.push(sessionReport);
          sessionBlocks.push(formatReportBlock(sessionReport));
          logSessionResult(log, sessionReport);
          continue;
        }

        for (const outcome of csvOutcomes) {
          const sessionReport = reportFromOutcome({
            sourceUrl,
            pptxName,
            pptxErrors,
            outcome,
          });

          if (outcome.csvPath) {
            const {
              sectionErrors,
              missingQuestionErrors,
              metasessionId,
            } = await validateSessionCsv(validateCtx, outcome.csvPath, {
              metasessionDetailsCache: metasessionCache,
              writeReports: true,
              fatalMetasessionApi: false,
            });
            sessionReport.sectionErrors = sectionErrors;
            sessionReport.missingQuestionErrors = missingQuestionErrors;
            if (metasessionId) {
              sessionReport.metasessionId = metasessionId;
              sessionReport.metasessionIds = [metasessionId];
            }
          }

          reports.push(sessionReport);
          sessionBlocks.push(formatReportBlock(sessionReport));
          logSessionResult(log, sessionReport);
        }
      } catch (e) {
        const sessionReport = {
          sourceUrl,
          pptxName,
          metasessionId: '',
          csvFilename: '',
          metasessionIds: [],
          pptxErrors: [`Unexpected validation error: ${e.message || e}`],
          csvErrors: [],
          metasessionErrors: [],
          sectionErrors: [],
          missingQuestionErrors: [],
          downloadOk: true,
          downloadError: '',
        };
        reports.push(sessionReport);
        sessionBlocks.push(formatReportBlock(sessionReport));
        logSessionResult(log, sessionReport);
      }
    }
  } finally {
    if (await vfs.exists(tempRoot)) {
      await vfs.removeDir(tempRoot);
    }
  }

  const completed = stamp();
  const passed = reports.filter((r) => sessionPassed(r)).length;
  await vfs.writeText(
    FULL_VALIDATION_PATH,
    buildReportText({ linksCsvPath, reports, sessionBlocks, started, completed }),
  );
  log(`Done: ${passed}/${reports.length} passed — ${FULL_VALIDATION_PATH}`);

  return {
    ok: true,
    reportPath: FULL_VALIDATION_PATH,
    sectionsReportPath: SECTIONS_VALIDATION_RESULTS_FILE,
    reports,
  };
}
