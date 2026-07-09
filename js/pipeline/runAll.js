/**
 * Pipeline orchestrator — port of run_all.py
 */

import { runDownloadWithRename } from './downloadWithRename.js';
import { runExtractCsv, PipelineAbortError as ExtractAbort } from './extractCsv.js';
import { runExtractCsvMerged, PipelineAbortError as MergedAbort } from './extractCsvMerged.js';
import { runXmlBuilder } from './xmlBuilder.js';
import { validateXmlOutputs } from '../shared/mtXmlValidator.js';
import { runTexBuilder } from './texBuilder.js';
import { runMakeFiles } from './makeFiles.js';
import { runCopySlidesContent } from './copySlidesContent.js';
import { runCleanWrappedSlides } from './cleanWrappedSlides.js';
import { runAddVerbatimToSlides } from './addVerbatimToSlides.js';
import { runVideoSlide } from './videoSlide.js';
import { runRenameSessionFolders } from './renameSessionFolders.js';
import { cleanupOutputFolders } from '../shared/outputFolders.js';
import { isMergedPptxBasename } from '../shared/sessionCsv.js';

export const PIPELINE_STEP_LABELS = {
  1: 'download_with_rename',
  2: 'extract_csv stage',
  3: 'xml_builder',
  4: 'mt_xml_validator',
  5: 'tex_builder',
  6: 'make_files',
  7: 'copy_slides_content',
  8: 'clean_wrapped_slides',
  9: 'add_verbatim_to_slides',
  10: 'video_slide',
  11: 'Rename session folders and remove CSV',
};

export const LAST_PIPELINE_STEP = 11;

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

async function appendFullLog(vfs, message) {
  let prev = '';
  try { prev = await vfs.readText('full_log.txt'); } catch { /* */ }
  await vfs.writeText('full_log.txt', `${prev}[${stamp()}] ${message}\n`);
}

async function initFullLog(vfs) {
  await vfs.writeText('full_log.txt', `[${stamp()}] PIPELINE START\n`);
}

async function countSessionCsvs(vfs) {
  try {
    const files = await vfs.listDir('csvs');
    return files.filter((f) => f.endsWith('.csv')).length;
  } catch {
    return 0;
  }
}

async function listPptxInSessions(vfs) {
  const files = await vfs.listDir('sessions');
  return files.filter((f) => f.endsWith('.pptx') && !f.startsWith('~'));
}

async function processExtractCsvStage(ctx) {
  const results = {};
  const sessionsPath = 'sessions';

  if (!(await ctx.vfs.exists(sessionsPath)) || !(await ctx.vfs.isDir(sessionsPath))) {
    ctx.log(`⚠️  Sessions directory not found at ${sessionsPath}. Skipping extract_csv stage.`);
    return results;
  }

  const pptxFiles = await listPptxInSessions(ctx.vfs);
  if (!pptxFiles.length) {
    ctx.log('⚠️  No .pptx files found in sessions directory. Skipping extract_csv stage.');
    return results;
  }

  const filesWithPipe = pptxFiles.filter((f) => isMergedPptxBasename(f));
  const filesWithoutPipe = pptxFiles.filter((f) => !isMergedPptxBasename(f));

  if (filesWithoutPipe.length) {
    ctx.log(`\nFound ${filesWithoutPipe.length} file(s) without '|' for extract_csv`);
    try {
      await runExtractCsv(ctx, filesWithoutPipe);
      results['extract_csv'] = true;
    } catch (e) {
      ctx.log(`\n❌ extract_csv failed: ${e.message}`);
      results['extract_csv'] = false;
    }
  } else {
    ctx.log("No files without '|' found. Skipping extract_csv");
    results['extract_csv'] = null;
  }

  if (filesWithPipe.length) {
    ctx.log(`\nFound ${filesWithPipe.length} file(s) with '|' for extract_csv_merged`);
    try {
      await runExtractCsvMerged(ctx, filesWithPipe);
      results['extract_csv_merged'] = true;
    } catch (e) {
      ctx.log(`\n❌ extract_csv_merged failed: ${e.message}`);
      results['extract_csv_merged'] = false;
    }
  } else {
    ctx.log("No files with '|' found. Skipping extract_csv_merged");
    results['extract_csv_merged'] = null;
  }

  return results;
}

/**
 * @param {object} ctx
 * @param {number} [startStep]
 * @param {(step: number, status: string) => void} [onStepStatus]
 */
export async function runPipeline(ctx, startStep = 1, onStepStatus = null) {
  const results = {};
  const setStatus = (step, status) => {
    if (onStepStatus) onStepStatus(step, status);
  };

  ctx.log('='.repeat(60));
  ctx.log('Pipeline Orchestrator');
  ctx.log('='.repeat(60));

  await cleanupOutputFolders(ctx.vfs, startStep, ctx.log);

  if (startStep <= 1) {
    await initFullLog(ctx.vfs);
  } else {
    await appendFullLog(ctx.vfs, `PIPELINE RESUME from step ${startStep}`);
    ctx.log(`\n▶ Resuming from step ${startStep} (${PIPELINE_STEP_LABELS[startStep]}) through step ${LAST_PIPELINE_STEP}.`);
  }

  const fail = async (step, reason) => {
    await appendFullLog(ctx.vfs, `PIPELINE STOP: ${reason}`);
    setStatus(step, 'failed');
    throw new Error(`${reason}\nFix the issue, then resume from step ${step}.`);
  };

  // Step 1
  if (startStep <= 1) {
    setStatus(1, 'running');
    ctx.log('\nStep 1: download_with_rename');
    const r = await runDownloadWithRename(ctx);
    results['download_with_rename'] = r?.ok !== false;
    if (r?.ok === false) {
      await fail(1, 'download_with_rename failed');
    }
    setStatus(1, 'success');
  } else {
    results['download_with_rename'] = null;
    setStatus(1, 'skipped');
  }

  // Step 2
  if (startStep <= 2) {
    setStatus(2, 'running');
    ctx.log('\nStep 2: Processing extract_csv stage');
    const extractResults = await processExtractCsvStage(ctx);
    Object.assign(results, extractResults);

    const extractRan = Object.values(extractResults).some((v) => v !== null);
    let extractFailed = Object.values(extractResults).some((v) => v === false);

    if (extractRan && !extractFailed && (await countSessionCsvs(ctx.vfs)) === 0) {
      extractFailed = true;
      ctx.log('\n❌ Extract stage reported success but no CSV files exist in csvs/.');
      await appendFullLog(ctx.vfs, 'PIPELINE STOP: extract produced no CSV files');
      if (extractResults['extract_csv'] === true) results['extract_csv'] = false;
      if (extractResults['extract_csv_merged'] === true) results['extract_csv_merged'] = false;
    }

    if (extractFailed) {
      await fail(2, 'extract_csv stage failed');
    }
    setStatus(2, 'success');
  } else {
    results['extract_csv'] = null;
    results['extract_csv_merged'] = null;
    setStatus(2, 'skipped');
  }

  const remaining = [
    [3, 'xml_builder', runXmlBuilder],
    [4, 'mt_xml_validator', validateXmlOutputs],
    [5, 'tex_builder', runTexBuilder],
    [6, 'make_files', runMakeFiles],
    [7, 'copy_slides_content', runCopySlidesContent],
    [8, 'clean_wrapped_slides', runCleanWrappedSlides],
    [9, 'add_verbatim_to_slides', runAddVerbatimToSlides],
    [10, 'video_slide', runVideoSlide],
  ];

  for (const [stepNum, name, fn] of remaining) {
    if (startStep <= stepNum) {
      setStatus(stepNum, 'running');
      ctx.log(`\nStep ${stepNum}: ${name}`);
      try {
        const result = await fn(ctx);
        const failed = result === false || (result && typeof result === 'object' && result.ok === false);
        if (failed) {
          results[name] = false;
          await fail(stepNum, `${name} failed`);
        }
        results[name] = true;
        setStatus(stepNum, 'success');
      } catch (e) {
        if (e instanceof ExtractAbort || e instanceof MergedAbort) {
          results[name] = false;
          await fail(stepNum, `${name} failed: ${e.message}`);
        }
        results[name] = false;
        await fail(stepNum, `${name} failed: ${e.message}`);
      }
    } else {
      results[name] = null;
      setStatus(stepNum, 'skipped');
    }
  }

  // Step 11
  if (startStep <= 11) {
    setStatus(11, 'running');
    ctx.log('\nStep 11: Rename session folders and remove CSV');
    ctx.log(`${'='.repeat(60)}\n`);
    const renameResult = await runRenameSessionFolders(ctx);
    results.rename_session_folders = renameResult?.ok !== false;
    setStatus(11, 'success');
  } else {
    results.rename_session_folders = null;
    setStatus(11, 'skipped');
  }

  ctx.log(`\n${'='.repeat(60)}`);
  ctx.log('Execution Summary');
  ctx.log('='.repeat(60));
  for (const [name, success] of Object.entries(results)) {
    let status;
    if (success === null) status = '⏭️  SKIPPED';
    else if (success) status = '✅ SUCCESS';
    else status = '❌ FAILED';
    ctx.log(`${status}: ${name}`);
  }

  const successful = Object.values(results).filter((s) => s === true).length;
  const skipped = Object.values(results).filter((s) => s === null).length;
  ctx.log(`\nCompleted: ${successful} succeeded, ${skipped} skipped (out of ${Object.keys(results).length} total)`);

  if (startStep > 1) {
    ctx.log(`🎉 Pipeline steps ${startStep}–${LAST_PIPELINE_STEP} completed successfully!`);
    await appendFullLog(ctx.vfs, `PIPELINE END: resumed from step ${startStep}, all steps succeeded`);
  } else {
    ctx.log('🎉 All pipeline steps completed successfully!');
    await appendFullLog(ctx.vfs, 'PIPELINE END: all steps succeeded');
  }

  return results;
}
