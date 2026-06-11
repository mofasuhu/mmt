/**
 * Metasession Markup Tool — browser UI entry point.
 */

import { createVirtualFs } from './io/virtualFs.js';
import {
  pickDirectory,
  flushVirtualFsToDirectory,
  MountedDir,
  directoryFromDrop,
  fileFromDrop,
  setupDropZone,
} from './io/fsAccess.js';
import { downloadVfsAsZip } from './io/zipExport.js';
import { runPipeline, PIPELINE_STEP_LABELS, LAST_PIPELINE_STEP } from './pipeline/runAll.js';
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
let clsArchiveHandle = null;
/** @type {MountedDir|import('./io/fsAccess.js').DroppedDir|null} */
let slidesArchiveHandle = null;

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
 * @param {{ progress?: boolean }} [options]
 */
function log(msg, options = {}) {
  const line = String(msg);

  if (options.progress) {
    if (progressEl) {
      progressEl.textContent = line;
      progressEl.hidden = false;
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
      clsSource: clsArchiveHandle ? 'mount/cls' : null,
      slidesArchive: slidesArchiveHandle ? 'mount/slides' : null,
    },
    config: {
      fetchFn,
      linksCsvPath: 'links.csv',
      sessionsDir: 'sessions',
      csvsDir: 'csvs',
      filesDir: 'files',
      clsDir: 'CLS',
      sheetId: '1Qc9LrE54LyDzAB1sAyK6iBJDJUbT1Y3sh9-7MNSm85M',
      sheetRange: 'Sheet1!A:C',
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

function updateAuthStatusUi() {
  const st = googleAuth.getAuthStatus();
  const el = $('#auth-status');
  const signInBtn = $('#sign-in-google');
  if (!el) return;

  if (st.interactive) {
    el.textContent = 'Signed in with Google (browser).';
    if (signInBtn) signInBtn.textContent = 'Sign in again';
  } else if (st.staticReady) {
    const parts = [];
    if (st.drive) parts.push('token.json');
    if (st.driveRead) parts.push('token_read.json');
    if (st.sheets) parts.push('token_sheet.json');
    el.textContent = `Local tokens: ${parts.join(', ')}`;
  } else if (st.browserSignIn) {
    el.textContent = 'Click “Sign in with Google” to continue.';
  } else {
    el.textContent = 'Auth not configured — site admin must set client_id in oauth-config.json.';
  }

  if (signInBtn) {
    signInBtn.disabled = !st.browserSignIn;
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

async function loadStaticLinksCsv() {
  try {
    const res = await fetch('links.csv');
    if (!res.ok) return false;
    const text = await res.text();
    await vfs.writeText('links.csv', text);
    $('#links-csv-name').textContent = 'links.csv (bundled)';
    log('Loaded links.csv from project folder');
    return true;
  } catch {
    return false;
  }
}

async function handleLinksCsv(file) {
  const text = await file.text();
  await vfs.writeText('links.csv', text);
  $('#links-csv-name').textContent = `Loaded: ${file.name}`;
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
  $('#links-csv-name').textContent = 'Loaded from pasted URL';
  log('Created links.csv from pasted Google Slides URL.');
}

function mountArchives() {
  vfs.unmount('mount/cls');
  vfs.unmount('mount/slides');
  if (clsArchiveHandle) vfs.mount('mount/cls', clsArchiveHandle);
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

async function assignClsArchive(handle) {
  clsArchiveHandle = handle;
  setFolderLabel('#cls-folder-name', handle);
  mountArchives();
  log(`CLS archive: ${handle.label}`);
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

async function pickClsArchive() {
  await assignClsArchive(await pickDirectory({ mode: 'read', label: 'cls' }));
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

async function dropClsArchive(event) {
  const dir = await directoryFromDrop(event, { mode: 'read', label: 'cls' });
  if (!dir) {
    log('Drop the CLS folder here.');
    return;
  }
  await assignClsArchive(dir);
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
  log('Writing files to output folder...');
  await flushVirtualFsToDirectory(vfs, outputDirHandle.handle, {
    onProgress: (i, total, path) => {
      if (i % 10 === 0 || i === total) log(`  ${i}/${total}: ${path}`);
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
    updateAuthStatusUi();
    return true;
  } catch (e) {
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
  } catch (e) {
    log(`\n❌ ${e.message}`);
  } finally {
    btn.disabled = false;
  }
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

  setupDropZone($('#drop-cls'), {
    onDrop: async (e) => {
      try {
        await dropClsArchive(e);
      } catch (err) {
        log(`CLS drop failed: ${err.message}`);
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
  $('#pick-cls').addEventListener('click', () => pickClsArchive().catch((e) => log(e.message)));
  $('#pick-slides').addEventListener('click', () => pickSlidesArchive().catch((e) => log(e.message)));
  $('#run-btn').addEventListener('click', runAll);
  $('#write-folder').addEventListener('click', () => writeToFolder().catch((e) => log(e.message)));
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
}

async function probeApisOnLoad() {
  const proxy = getProxyUrl();
  const onDevServer = typeof window !== 'undefined' && window.location?.pathname !== undefined
    && (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost')
    && window.location.port === '8788';

  if (onDevServer) {
    log('Dev server detected — Nagwa APIs fall back to /proxy if direct fetch fails.');
  } else if (isGitHubPagesHost()) {
    log('Published mode — sign in with Google, paste a Slides URL, pick folders, then run pipeline.');
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
  await googleAuth.loadStaticAuthFiles(log);
  updateAuthStatusUi();
  await probeApisOnLoad();
}

bootstrap();
