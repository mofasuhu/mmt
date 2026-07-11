/**
 * Metasession Markup Tool — browser UI entry point.
 */

import { createVirtualFs } from './io/virtualFs.js';
import {
  pickDirectory,
  emptyDirectory,
  flushVirtualFsToDirectory,
  MountedDir,
  directoryFromDrop,
  fileFromDrop,
  setupDropZone,
} from './io/fsAccess.js';
import { ServerMountedDir } from './io/serverMountedDir.js';
import { loadArchiveConfig, getArchiveConfig, resolveFsApiBase, isDevServerHost } from './shared/archiveConfig.js';
import { downloadVfsAsZip } from './io/zipExport.js';
import { runPipeline, PIPELINE_STEP_LABELS, LAST_PIPELINE_STEP } from './pipeline/runAll.js';
import {
  runValidateOnly,
  FULL_VALIDATION_PATH,
  SECTIONS_VALIDATION_RESULTS_FILE,
} from './pipeline/validateOnly.js';
import { createGoogleAuth, GoogleSheets } from './auth/googleAuth.js';
import { setMetasessionFetchFn } from './shared/metasessionApi.js';
import { createAppFetch, isGitHubPagesHost, probeMetasessionApi } from './shared/httpFetch.js';

const $ = (sel) => document.querySelector(sel);
const logEl = $('#log-panel');
const progressEl = $('#log-progress');
const stepListEl = $('#step-list');

/** @type {import('./io/virtualFs.js').VirtualFs} */
let vfs = createVirtualFs();
const googleAuth = createGoogleAuth();
const googleSheets = new GoogleSheets(googleAuth);

/** @type {MountedDir|import('./io/fsAccess.js').DroppedDir|null} */
let outputDirHandle = null;
/** @type {MountedDir|import('./io/fsAccess.js').DroppedDir|null} */
let slidesArchiveHandle = null;
let archivesAutoMounted = false;

function flushProgressToLog() {
  if (!progressEl || progressEl.hidden) return;
  const line = progressEl.textContent;
  if (line) {
    logEl.textContent += `${line}\n`;
  }
  progressEl.textContent = '';
  progressEl.hidden = true;
}

/**
 * @param {string} msg
 * @param {{ progress?: boolean, clear?: boolean }} [options]
 */
function log(msg, options = {}) {
  const line = String(msg);

  if (options.progress) {
    if (progressEl) {
      if (options.clear) {
        progressEl.textContent = '';
        progressEl.hidden = true;
      } else {
        progressEl.textContent = line;
        progressEl.hidden = false;
      }
      logEl.scrollTop = logEl.scrollHeight;
    }
    return;
  }

  flushProgressToLog();
  logEl.textContent += `${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
  console.log(line);
}

function clearLog() {
  logEl.textContent = '';
  if (progressEl) {
    progressEl.textContent = '';
    progressEl.hidden = true;
  }
}

function getProxyUrl() {
  return ($('#proxy-url').value || '').trim().replace(/\/$/, '');
}

const appFetch = createAppFetch(getProxyUrl);

function createFetchFn() {
  return appFetch;
}

function buildCtx() {
  const fetchFn = createFetchFn();
  setMetasessionFetchFn(fetchFn);
  googleSheets.setLog(log);
  return {
    vfs,
    log,
    fetchFn,
    googleAuth,
    googleSheets,
    archivePaths: {
      slidesArchive: slidesArchiveHandle ? 'mount/slides' : null,
    },
    config: {
      fetchFn,
      proxyUrl: getProxyUrl(),
      linksCsvPath: 'links.csv',
      sessionsDir: 'sessions',
      csvsDir: 'csvs',
      filesDir: 'files',
      sheetId: '1Qc9LrE54LyDzAB1sAyK6iBJDJUbT1Y3sh9-7MNSm85M',
      sheetRange: 'Original_Slide_ID-New_Slide_ID!A:C',
      tempSheetRange: 'temp!A:B',
      newIdUrl: 'https://12digit.nagwa.com/get.bulk.codes/1/cps/cps.system/',
      playIconPath: 'assets/video_play_icon.png',
      fontPath: 'assets/fonts/Rubik-Bold.ttf',
      ffmpegCoreBaseUrl: 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm',
      JSZip: window.JSZip,
    },
  };
}

function renderSteps() {
  stepListEl.innerHTML = '';
  for (let i = 1; i <= LAST_PIPELINE_STEP; i += 1) {
    const li = document.createElement('li');
    li.dataset.step = String(i);
    li.className = 'step-item pending';
    li.innerHTML = `<span class="step-num">${i}</span><span class="step-label">${PIPELINE_STEP_LABELS[i]}</span><span class="step-status">pending</span>`;
    stepListEl.appendChild(li);
  }
}

function setStepStatus(step, status) {
  const li = stepListEl.querySelector(`[data-step="${step}"]`);
  if (!li) return;
  li.className = `step-item ${status}`;
  li.querySelector('.step-status').textContent = status;
}

let staticAuthVerified = false;

function updateAuthStatusUi() {
  const st = googleAuth.getAuthStatus();
  const el = $('#auth-status');
  const signInBtn = $('#sign-in-google');
  const verifyBtn = $('#verify-auth');
  const authBlock = $('.auth-block');
  if (!el) return;

  if (st.interactive) {
    el.textContent = 'Signed in with Google (browser).';
    if (signInBtn) {
      signInBtn.hidden = false;
      signInBtn.textContent = 'Sign in again';
      signInBtn.disabled = false;
    }
  } else if (st.staticReady && staticAuthVerified) {
    el.textContent = 'Google access ready (shared tokens — no sign-in needed).';
    if (signInBtn) signInBtn.hidden = true;
  } else if (st.staticReady) {
    el.textContent = 'Shared tokens loaded — use Verify access or sign in if refresh failed.';
    if (signInBtn) {
      signInBtn.hidden = !st.browserSignIn;
      signInBtn.textContent = 'Sign in with Google';
      signInBtn.disabled = !st.browserSignIn;
    }
  } else if (st.browserSignIn) {
    el.textContent = 'Click “Sign in with Google” to continue.';
    if (signInBtn) {
      signInBtn.hidden = false;
      signInBtn.textContent = 'Sign in with Google';
      signInBtn.disabled = false;
    }
  } else {
    el.textContent = 'Auth not configured — site admin must set client_id in oauth-config.json.';
    if (signInBtn) {
      signInBtn.hidden = false;
      signInBtn.disabled = true;
    }
  }

  if (verifyBtn) {
    verifyBtn.hidden = Boolean(st.staticReady && staticAuthVerified);
  }
  if (authBlock) {
    authBlock.classList.toggle('auth-block--shared', Boolean(st.staticReady && staticAuthVerified));
  }
}

async function loadBundledAssets() {
  const assets = [
    ['assets/video_play_icon.png', 'assets/video_play_icon.png'],
    ['assets/fonts/Rubik-Bold.ttf', 'assets/fonts/Rubik-Bold.ttf'],
  ];
  for (const [url, dest] of assets) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        await vfs.writeBytes(dest, new Uint8Array(await res.arrayBuffer()));
      }
    } catch {
      /* optional assets */
    }
  }
}

function setLinksCsvStatus(hint, dropStatus) {
  const nameEl = $('#links-csv-name');
  const dropEl = $('#links-csv-drop-status');
  const zone = $('#drop-links-csv');
  if (nameEl) nameEl.textContent = hint;
  if (dropEl) dropEl.textContent = dropStatus;
  if (zone) {
    zone.classList.toggle('drop-zone-loaded', !/^not loaded$/i.test(dropStatus));
  }
}

async function loadStaticLinksCsv() {
  try {
    const res = await fetch('links.csv');
    if (!res.ok) return false;
    const text = await res.text();
    await vfs.writeText('links.csv', text);
    setLinksCsvStatus('links.csv (bundled)', 'Loaded: links.csv (bundled)');
    log('Loaded links.csv from project folder');
    return true;
  } catch {
    return false;
  }
}

async function handleLinksCsv(file) {
  const text = await file.text();
  await vfs.writeText('links.csv', text);
  const label = `Loaded: ${file.name}`;
  setLinksCsvStatus(label, label);
  log(`Loaded links.csv (${file.name})`);
}

async function useSlidesUrl() {
  const url = ($('#slides-url').value || '').trim();
  if (!url) {
    log('Paste a Google Slides URL first.');
    return;
  }
  if (!url.includes('docs.google.com/presentation')) {
    log('URL should be a Google Slides presentation link.');
    return;
  }
  const csv = `url,name\n${url},\n`;
  await vfs.writeText('links.csv', csv);
  setLinksCsvStatus('Loaded from pasted URL', 'Loaded from pasted URL');
  log('Created links.csv from pasted Google Slides URL.');
}

function setArchiveFolderUiVisible(showPickers) {
  const slidesRow = $('#slides-folder-row');
  if (slidesRow) slidesRow.hidden = !showPickers;

  const hint = document.querySelector('.folder-hint');
  if (!hint) return;
  if (!showPickers) {
    hint.textContent = 'Output folder: drag or Browse. Slides archive loads automatically from configured paths.';
  } else {
    hint.textContent = 'Drag a folder onto a zone, or click Browse.';
  }
}

async function mountStaticArchivesIfAvailable() {
  const config = getArchiveConfig();
  if (!config.auto_mount) return false;

  const fsApiBase = resolveFsApiBase(config);
  if (!fsApiBase && !isDevServerHost()) {
    log(
      'Archive auto-mount skipped on static hosting — browsers cannot read local disk paths. '
      + 'Run node proxy/dev-server.mjs (http://127.0.0.1:8788) or set fs_api_base in archive-config.json.',
    );
    return false;
  }

  try {
    const statusUrl = fsApiBase ? `${fsApiBase}/fs/status` : '/fs/status';
    const res = await fetch(statusUrl);
    if (!res.ok) return false;
    const { mounts } = await res.json();
    if (!mounts?.slides?.ok) {
      log(`Slides archive not found at ${config.remote_base_path}`);
      return false;
    }

    slidesArchiveHandle = new ServerMountedDir('slides', config.remote_base_path, fsApiBase);
    archivesAutoMounted = true;
    mountArchives();
    setFolderLabel('#slides-folder-name', slidesArchiveHandle);
    setArchiveFolderUiVisible(false);

    log(`Slides archive: ${config.remote_base_path}`);
    return true;
  } catch (e) {
    log(`Static archive mount failed: ${e.message}`);
    return false;
  }
}

function mountArchives() {
  vfs.unmount('mount/slides');
  if (slidesArchiveHandle) vfs.mount('mount/slides', slidesArchiveHandle);
}

function setFolderLabel(elementId, handle, fallback = 'Not selected') {
  const el = $(elementId);
  if (!el) return;
  if (!handle) {
    el.textContent = fallback;
    return;
  }
  const ro = handle.readOnly ? ' (read-only drop)' : '';
  el.textContent = `${handle.label}${ro}`;
}

async function assignOutputDir(handle) {
  outputDirHandle = handle;
  setFolderLabel('#output-folder-name', handle, 'Not selected');
  if (handle?.readOnly) {
    log(`Output folder loaded (read-only): ${handle.label} — use Download ZIP to save results`);
  } else {
    log(`Output folder: ${handle.label}`);
  }
}

async function assignSlidesArchive(handle) {
  slidesArchiveHandle = handle;
  setFolderLabel('#slides-folder-name', handle);
  mountArchives();
  log(`Slides archive: ${handle.label}`);
}

async function pickOutputFolder() {
  await assignOutputDir(await pickDirectory({ mode: 'readwrite', label: 'output' }));
}

async function pickSlidesArchive() {
  await assignSlidesArchive(await pickDirectory({ mode: 'read', label: 'slides' }));
}

async function dropOutputFolder(event) {
  const dir = await directoryFromDrop(event, { mode: 'readwrite', label: 'output' });
  if (!dir) {
    log('Drop a folder on the output zone (or click Browse).');
    return;
  }
  await assignOutputDir(dir);
}

async function dropSlidesArchive(event) {
  const dir = await directoryFromDrop(event, { mode: 'read', label: 'slides' });
  if (!dir) {
    log('Drop the slides archive folder here.');
    return;
  }
  await assignSlidesArchive(dir);
}

async function dropLinksCsv(event) {
  const file = fileFromDrop(event);
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.csv')) {
    log('Please drop a .csv file (links.csv).');
    return;
  }
  await handleLinksCsv(file);
}

async function writeToFolder() {
  if (!outputDirHandle) {
    log('Pick or drop an output folder first.');
    return;
  }
  if (outputDirHandle.readOnly) {
    log('Dropped output folder is read-only. Use Browse to pick a writable folder, or Download ZIP.');
    return;
  }
  if (!(outputDirHandle instanceof MountedDir)) {
    log('Output target must be a writable folder (use Browse).');
    return;
  }
  log('Clearing output folder...');
  await emptyDirectory(outputDirHandle);
  log('Writing files to output folder...');
  await flushVirtualFsToDirectory(vfs, outputDirHandle.handle, {
    onProgress: (i, total, diskPath, vfsPath) => {
      const label = vfsPath && vfsPath !== diskPath ? `${diskPath} (from ${vfsPath})` : diskPath;
      if (i % 10 === 0 || i === total) log(`  ${i}/${total}: ${label}`);
    },
  });
  log('Done writing to output folder.');
}

async function downloadZip() {
  if (!window.JSZip) {
    log('JSZip not loaded.');
    return;
  }
  log('Building ZIP...');
  await downloadVfsAsZip(vfs, window.JSZip);
  log('ZIP download started.');
}

async function signInGoogle() {
  try {
    await googleAuth.signInInteractive(log, { prompt: 'consent' });
    updateAuthStatusUi();
    return true;
  } catch (e) {
    log(`Google sign-in failed: ${e.message}`);
    updateAuthStatusUi();
    return false;
  }
}

async function verifyGoogleAuth() {
  try {
    await googleAuth.connectDrive(log);
    await googleAuth.connectSheets(log);
    staticAuthVerified = googleAuth.prefersSharedTokens || Boolean(googleAuth.getAuthStatus().interactive);
    updateAuthStatusUi();
    return true;
  } catch (e) {
    staticAuthVerified = false;
    log(`Google auth check: ${e.message}`);
    updateAuthStatusUi();
    return false;
  }
}

async function runAll() {
  const startStep = Number($('#start-step').value) || 1;
  clearLog();
  renderSteps();
  await loadBundledAssets();
  mountArchives();

  const btn = $('#run-btn');
  btn.disabled = true;
  try {
    if (startStep <= 1) {
      await verifyGoogleAuth();
    }
    await runPipeline(buildCtx(), startStep, setStepStatus);
    log('\nPipeline finished. Use "Write to folder" or "Download ZIP" to save output.');
    const downloadSectionsValidationBtn = $('#download-sections-validation');
    if (downloadSectionsValidationBtn && (await vfs.exists(SECTIONS_VALIDATION_RESULTS_FILE))) {
      downloadSectionsValidationBtn.disabled = false;
    }
  } catch (e) {
    log(`\n❌ ${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

async function runValidateOnlyMode() {
  clearLog();

  const validateBtn = $('#validate-only-btn');
  const runBtn = $('#run-btn');
  const downloadValidationBtn = $('#download-validation');
  const downloadSectionsValidationBtn = $('#download-sections-validation');
  validateBtn.disabled = true;
  runBtn.disabled = true;
  if (downloadValidationBtn) downloadValidationBtn.disabled = true;
  if (downloadSectionsValidationBtn) downloadSectionsValidationBtn.disabled = true;

  try {
    await loadBundledAssets();
    if (!(await vfs.exists('links.csv'))) {
      throw new Error('links.csv is required. Drop or bundle links.csv first.');
    }
    const authed = await verifyGoogleAuth();
    if (!authed) {
      throw new Error('Google sign-in is required to download presentations.');
    }
    await runValidateOnly(buildCtx());
    log('Download full_validation.txt and sections_validation_results.txt when ready.');
    if (downloadValidationBtn) downloadValidationBtn.disabled = false;
    if (downloadSectionsValidationBtn) downloadSectionsValidationBtn.disabled = false;
  } catch (e) {
    log(`\n❌ ${e.message}`);
  } finally {
    validateBtn.disabled = false;
    runBtn.disabled = false;
  }
}

async function downloadTextReport(vfsPath, downloadName, missingMessage) {
  try {
    const text = await vfs.readText(vfsPath);
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = downloadName;
    a.click();
  } catch {
    log(missingMessage);
  }
}

async function downloadValidationReport() {
  await downloadTextReport(
    FULL_VALIDATION_PATH,
    'full_validation.txt',
    'No full_validation.txt yet. Run Validate only first.',
  );
}

async function downloadSectionsValidationReport() {
  await downloadTextReport(
    SECTIONS_VALIDATION_RESULTS_FILE,
    'sections_validation_results.txt',
    'No sections_validation_results.txt yet. Run Validate only or the full pipeline first.',
  );
}

function initDropZones() {
  setupDropZone($('#drop-links-csv'), {
    onDrop: async (e) => {
      try {
        await dropLinksCsv(e);
      } catch (err) {
        log(`links.csv drop failed: ${err.message}`);
      }
    },
  });

  setupDropZone($('#drop-output'), {
    onDrop: async (e) => {
      try {
        await dropOutputFolder(e);
      } catch (err) {
        log(`Output folder drop failed: ${err.message}`);
      }
    },
  });

  setupDropZone($('#drop-slides'), {
    onDrop: async (e) => {
      try {
        await dropSlidesArchive(e);
      } catch (err) {
        log(`Slides archive drop failed: ${err.message}`);
      }
    },
  });
}

function initUi() {
  renderSteps();
  initDropZones();

  const savedProxy = localStorage.getItem('mmt_proxy_url');
  if (savedProxy) $('#proxy-url').value = savedProxy;

  $('#proxy-url').addEventListener('change', (e) => {
    localStorage.setItem('mmt_proxy_url', e.target.value.trim());
  });

  $('#sign-in-google').addEventListener('click', () => signInGoogle());
  $('#verify-auth').addEventListener('click', () => verifyGoogleAuth());
  $('#use-slides-url').addEventListener('click', () => useSlidesUrl().catch((e) => log(e.message)));
  $('#slides-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') useSlidesUrl().catch((err) => log(err.message));
  });

  $('#pick-output').addEventListener('click', () => pickOutputFolder().catch((e) => log(e.message)));
  $('#pick-slides').addEventListener('click', () => pickSlidesArchive().catch((e) => log(e.message)));
  $('#run-btn').addEventListener('click', runAll);
  $('#validate-only-btn').addEventListener('click', () => runValidateOnlyMode().catch((e) => log(e.message)));
  $('#write-folder').addEventListener('click', () => writeToFolder().catch((e) => {
    log(e.message || String(e));
    if (e.name) log(`  (${e.name})`);
  }));
  $('#download-zip').addEventListener('click', () => downloadZip().catch((e) => log(e.message)));
  $('#download-log').addEventListener('click', async () => {
    try {
      const text = await vfs.readText('full_log.txt');
      const blob = new Blob([text], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'full_log.txt';
      a.click();
    } catch {
      log('No full_log.txt yet.');
    }
  });
  $('#download-validation').addEventListener('click', () => downloadValidationReport().catch((e) => log(e.message)));
  $('#download-sections-validation').addEventListener('click', () => downloadSectionsValidationReport().catch((e) => log(e.message)));
}

async function probeApisOnLoad() {
  const proxy = getProxyUrl();
  const onDevServer = isDevServerHost();

  if (onDevServer) {
    log('Dev server detected — Nagwa APIs fall back to /proxy if direct fetch fails.');
    if (!archivesAutoMounted) {
      await mountStaticArchivesIfAvailable();
    }
  } else if (isGitHubPagesHost()) {
    log('Published mode — paste a Slides URL, pick folders, then run pipeline.');
    if (proxy) {
      log(`CORS proxy: ${proxy}`);
    } else {
      log('⚠️  No CORS proxy configured — Nagwa API calls will fail on GitHub Pages until you deploy proxy/worker.js and set cors_proxy_url in oauth-config.json.');
    }
  } else if (proxy) {
    log(`CORS proxy configured: ${proxy}`);
  }

  try {
    const result = await probeMetasessionApi(appFetch, 'KbykjcvM9ljLd8P3YQLxyenWmNmKOuryjZJFFYmMxIc');
    if (result.ok) {
      log(`Metasession API reachable (${result.via}).`);
    } else {
      log(`Metasession API returned HTTP ${result.status} (${result.via}).`);
      if (isGitHubPagesHost() && !proxy) {
        log('Deploy the CORS proxy: cd proxy && npx wrangler deploy');
        log('Then set cors_proxy_url in oauth-config.json, push, and hard-refresh this page.');
      } else if (onDevServer) {
        log('Run: node proxy/dev-server.mjs  then open http://127.0.0.1:8788');
      }
    }
  } catch (e) {
    log(`Metasession API probe failed: ${e.message}`);
    if (onDevServer) {
      log('Run: node proxy/dev-server.mjs  then open http://127.0.0.1:8788');
    } else if (isGitHubPagesHost() && !proxy) {
      log('Deploy proxy/worker.js to Cloudflare and set cors_proxy_url in oauth-config.json.');
    }
    if (proxy) log('Check the CORS proxy URL is correct, or clear it and hard-refresh (Cmd+Shift+R).');
  }
}

async function bootstrap() {
  initUi();
  await loadBundledAssets();
  await googleAuth.loadOAuthConfig(log);
  if (googleAuth.corsProxyUrl && !getProxyUrl()) {
    $('#proxy-url').value = googleAuth.corsProxyUrl;
    localStorage.setItem('mmt_proxy_url', googleAuth.corsProxyUrl);
  }
  await loadStaticLinksCsv();
  await loadArchiveConfig(log);
  await mountStaticArchivesIfAvailable();
  await googleAuth.loadStaticAuthFiles(log);
  updateAuthStatusUi();
  if (googleAuth.prefersSharedTokens) {
    log('Shared Google tokens found — connecting automatically…');
    await verifyGoogleAuth();
  }
  await probeApisOnLoad();
}

bootstrap();
