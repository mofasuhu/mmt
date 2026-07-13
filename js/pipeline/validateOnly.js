/**
 * Validate-only orchestration — port of Scripts/validation_runner.py
 */

import { downloadAllFromLinks } from './downloadWithRename.js';
import { validatePresentationFile as validateSinglePptx } from './extractCsv.js';
import { validatePresentationFile as validateMergedPptx } from './extractCsvMerged.js';
import { validateSessionCsv, resetXmlBuilderCaches } from './xmlBuilder.js';
import { csvCellStr, isMergedPptxBasename } from '../shared/sessionCsv.js';
import { loadSkippingValidationsByMetasession } from '../shared/skippingValidations.js';
import {
  initSectionsValidationResults,
  SECTIONS_VALIDATION_RESULTS_FILE,
} from '../shared/sectionValidator.js';

export const FULL_VALIDATION_PATH = 'full_validation.txt';
export { SECTIONS_VALIDATION_RESULTS_FILE };

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function downloadProgressLine(done, total) {
  const safeTotal = Math.max(Number(total) || 0, 1);
  const safeDone = Math.min(Math.max(Number(done) || 0, 0), safeTotal);
  const width = 24;
  const filled = Math.round((width * safeDone) / safeTotal);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const pct = Math.round((100 * safeDone) / safeTotal);
  return `Validate-only: downloading [${bar}] ${String(pct).padStart(3, ' ')}% (${safeDone}/${safeTotal})`;
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
    && !report.xmlOutputErrors.length
  );
}

function reportFromOutcome({ sourceUrl, pptxName, pptxErrors, outcome }) {
  return {
    sourceUrl,
    pptxName,
    metasessionId: outcome.metasessionId || '',
    csvFilename: outcome.csvFilename || '',
    metasessionIds: outcome.metasessionId ? [outcome.metasessionId] : [],
    pptxErrors: [...pptxErrors, ...(outcome.pptxNameErrors || [])],
    csvErrors: [...(outcome.csvErrors || [])],
    metasessionErrors: [...(outcome.metasessionErrors || [])],
    sectionErrors: [],
    sectionWarnings: [],
    permissionInfos: [],
    missingQuestionErrors: [],
    xmlOutputErrors: [],
    xmlOutputWarnings: [],
    downloadOk: true,
    downloadError: '',
  };
}

function permissionInfoLines(permissionsByMeta, metasessionId) {
  if (!metasessionId || !permissionsByMeta) return [];
  const permissions = permissionsByMeta.get(csvCellStr(metasessionId));
  if (!permissions) return [];
  const infos = [];
  for (const tag of [...permissions.sessionTags].sort()) {
    infos.push(`permission_tag '${tag}' applied for this session.`);
  }
  for (const sectionId of [...permissions.sectionTags.keys()].sort()) {
    for (const tag of [...permissions.sectionTags.get(sectionId)].sort()) {
      infos.push(`permission_tag '${tag}' applied for section ${sectionId}.`);
    }
  }
  return infos;
}

function normalizePresentationUrl(url) {
  const match = String(url || '').match(/\/presentation\/d\/([a-zA-Z0-9-_]+)/);
  return match ? `https://docs.google.com/presentation/d/${match[1]}` : (url || '');
}

function formatReportBlock(report) {
  const lines = [
    '='.repeat(80),
    `SESSION: ${sessionLabel(report)}`,
  ];
  if (report.pptxName) lines.push(`PPTX: ${report.pptxName}`);
  if (report.csvFilename) lines.push(`CSV: ${report.csvFilename}`);
  if (report.sourceUrl) lines.push(`URL: ${normalizePresentationUrl(report.sourceUrl)}`);
  lines.push(`Overall: ${sessionPassed(report) ? 'PASSED' : 'FAILED'}`);
  lines.push('');

  if (!report.downloadOk) {
    lines.push('--- Download ---');
    lines.push(`  FAILED: ${report.downloadError}`);
    lines.push('');
    return `${lines.join('\n')}\n`;
  }

  if (report.permissionInfos?.length) {
    lines.push('--- Permission tags applied ---');
    for (const info of report.permissionInfos) lines.push(`  ✓ ${info}`);
    lines.push('');
  }

  lines.push('--- PPTX / extraction ---');
  if (report.pptxErrors.length) {
    for (const err of report.pptxErrors) lines.push(`  ${err}`);
  } else {
    lines.push('  PASSED');
  }
  lines.push('');

  lines.push('--- CSV validation ---');
  if (report.csvErrors.length) {
    for (const err of report.csvErrors) lines.push(`  ${err}`);
  } else {
    lines.push('  PASSED');
  }
  lines.push('');

  lines.push('--- Metasession API ---');
  if (report.metasessionErrors.length) {
    for (const err of report.metasessionErrors) lines.push(`  ${err}`);
  } else {
    lines.push('  PASSED');
  }
  lines.push('');

  lines.push('--- Section validation ---');
  if (report.sectionErrors.length) {
    for (const err of report.sectionErrors) lines.push(`  ${err}`);
  } else {
    lines.push('  PASSED');
  }
  if (report.sectionWarnings.length) {
    for (const warn of report.sectionWarnings) lines.push(`  WARNING: ${warn}`);
  }
  lines.push('');

  if (report.missingQuestionErrors.length) {
    lines.push('--- Missing QMS questions ---');
    for (const err of report.missingQuestionErrors) lines.push(`  ${err}`);
    lines.push('');
  }

  lines.push('--- XML output validation ---');
  if (report.xmlOutputErrors.length) {
    for (const err of report.xmlOutputErrors) lines.push(`  ${err}`);
  } else {
    lines.push('  PASSED');
  }
  if (report.xmlOutputWarnings.length) {
    for (const warn of report.xmlOutputWarnings) lines.push(`  WARNING: ${warn}`);
  }
  lines.push('');

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

function collectSessionIssues(report) {
  const errors = [];
  const warnings = [];
  const infos = [];
  if (!report.downloadOk) {
    errors.push(`Download: ${report.downloadError}`);
    return { errors, warnings, infos };
  }
  for (const err of report.pptxErrors) errors.push(`PPTX: ${err}`);
  for (const err of report.csvErrors) errors.push(`CSV: ${err}`);
  for (const err of report.metasessionErrors) errors.push(`Metasession API: ${err}`);
  for (const err of report.sectionErrors) errors.push(`Section: ${err}`);
  for (const err of report.missingQuestionErrors) errors.push(`Missing QMS: ${err}`);
  for (const err of report.xmlOutputErrors) errors.push(`XML output: ${err}`);
  for (const warn of report.sectionWarnings) warnings.push(`Section warning: ${warn}`);
  for (const warn of report.xmlOutputWarnings) warnings.push(`XML output warning: ${warn}`);
  for (const info of report.permissionInfos || []) infos.push(info);
  return { errors, warnings, infos };
}

function logSessionResult(log, report) {
  const { errors, warnings, infos } = collectSessionIssues(report);
  const label = sessionLabel(report);
  if (!sessionPassed(report)) {
    log(`  ❌ ${label}: FAILED`);
    for (const err of errors) log(`      ${err}`);
    for (const warn of warnings) log(`      ⚠️  ${warn}`);
    for (const info of infos) log(`      ✓ ${info}`);
  } else if (warnings.length) {
    log(`  ⚠️  ${label}: PASSED (warnings)`);
    for (const warn of warnings) log(`      ${warn}`);
    for (const info of infos) log(`      ✓ ${info}`);
  } else {
    log(`  ✅ ${label}: PASSED`);
    for (const info of infos) log(`      ✓ ${info}`);
  }
}

function printDoneSummary(log, reports, reportPath) {
  const passed = reports.filter((r) => sessionPassed(r)).length;
  const failed = reports.length - passed;
  const warned = reports.filter((r) => sessionPassed(r) && (r.sectionWarnings?.length)).length;
  if (failed && warned) {
    log(`Done: ✅ ${passed}/${reports.length} passed, ❌ ${failed} failed, ⚠️  ${warned} with warnings — ${reportPath}`);
  } else if (failed) {
    log(`Done: ✅ ${passed}/${reports.length} passed, ❌ ${failed} failed — ${reportPath}`);
  } else if (warned) {
    log(`Done: ✅ ${passed}/${reports.length} passed, ⚠️  ${warned} with warnings — ${reportPath}`);
  } else {
    log(`Done: ✅ ${passed}/${reports.length} passed — ${reportPath}`);
  }
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
    config: {
      ...config,
      validateOnlyQuiet: true,
      onDownloadProgress: (done, total) => {
        if (typeof log === 'function') {
          log(downloadProgressLine(done, total), { progress: true });
        }
      },
    },
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

  let permissionsByMeta = null;
  if (!ctx.googleSheets) {
    throw new Error('Could not load skipping_validations sheet: Google Sheets API is not available.');
  }
  {
    log('Loading skipping_validations permissions sheet...');
    const [byMeta, permErrors] = await loadSkippingValidationsByMetasession(ctx.googleSheets);
    if (permErrors.length) {
      const message = permErrors.join('; ');
      throw new Error(`Could not load skipping_validations sheet: ${message}`);
    }
    permissionsByMeta = byMeta;
  }

  const linksText = await vfs.readText(linksCsvPath);
  const rowCount = Math.max(0, linksText.split('\n').filter((l) => l.trim()).length - 1);
  log(downloadProgressLine(0, rowCount), { progress: true });

  const download = await downloadAllFromLinks(quietCtx);
  log(downloadProgressLine(download.results.length, rowCount), { progress: true });
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
        sectionWarnings: [],
        missingQuestionErrors: [],
        xmlOutputErrors: [],
        xmlOutputWarnings: [],
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
    printDoneSummary(log, reports, FULL_VALIDATION_PATH);
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
        config: {
          ...quietCtx.config,
          csvsPath,
          sessionsPath: sessionsDir,
          permissionsByMeta,
        },
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
            sectionWarnings: [],
            missingQuestionErrors: [],
            xmlOutputErrors: [],
            xmlOutputWarnings: [],
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

          if (outcome.csvPath && !outcome.csvErrors.length) {
            const {
              sectionErrors,
              sectionWarnings,
              missingQuestionErrors,
              xmlOutputErrors,
              xmlOutputWarnings,
              metasessionId,
            } = await validateSessionCsv(validateCtx, outcome.csvPath, {
              metasessionDetailsCache: metasessionCache,
              writeReports: true,
              fatalMetasessionApi: false,
              permissionsByMeta,
            });
            sessionReport.sectionErrors = sectionErrors;
            sessionReport.sectionWarnings = sectionWarnings;
            sessionReport.missingQuestionErrors = missingQuestionErrors;
            sessionReport.xmlOutputErrors = xmlOutputErrors;
            sessionReport.xmlOutputWarnings = xmlOutputWarnings;
            if (metasessionId) {
              sessionReport.metasessionId = metasessionId;
              sessionReport.metasessionIds = [metasessionId];
            }
          }

          sessionReport.permissionInfos = permissionInfoLines(
            permissionsByMeta,
            sessionReport.metasessionId,
          );

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
          sectionWarnings: [],
          missingQuestionErrors: [],
          xmlOutputErrors: [],
          xmlOutputWarnings: [],
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
  await vfs.writeText(
    FULL_VALIDATION_PATH,
    buildReportText({ linksCsvPath, reports, sessionBlocks, started, completed }),
  );
  printDoneSummary(log, reports, FULL_VALIDATION_PATH);

  return {
    ok: true,
    reportPath: FULL_VALIDATION_PATH,
    sectionsReportPath: SECTIONS_VALIDATION_RESULTS_FILE,
    reports,
  };
}
