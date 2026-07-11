/**
 * Port of copy_slides_content.py — sync remote slide content and reassign IDs.
 */

import {
  extractContentForInjection,
  injectRemoteContent,
} from '../latex/braceParser.js';
import { readRemoteSourceSlideId } from '../shared/sessionCsv.js';

const SHEETS_APPEND_CHUNK_SIZE = 200;
const SHEETS_RETRY_MAX = 8;
const SHEETS_RETRY_BASE_DELAY_SEC = 2.0;

/** @type {Record<string, string[]> | null} */
let idMappingCache = null;
/** @type {string[][]} */
let sheetLogBuffer = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string} value
 * @returns {Date}
 */
function parseChangeDate(value) {
  if (!value) return new Date(0);
  const s = String(value).trim();
  if (!s) return new Date(0);

  const formats = [
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) UTC$/,
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/,
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/,
    /^(\d{4})-(\d{2})-(\d{2})$/,
  ];

  for (const fmt of formats) {
    const m = s.match(fmt);
    if (m) {
      if (m.length >= 7) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
      if (m.length >= 5) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`);
      return new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    }
  }

  try {
    return new Date(s.replace(' UTC', '').trim());
  } catch {
    return new Date(0);
  }
}

/**
 * @param {object} ctx
 * @param {Function} requestFn
 * @param {string} action
 */
async function sheetsExecuteWithRetry(ctx, requestFn, action = 'Sheets API call') {
  let lastError;
  for (let attempt = 0; attempt < SHEETS_RETRY_MAX; attempt += 1) {
    try {
      return await requestFn();
    } catch (e) {
      lastError = e;
      const status = e?.status ?? e?.statusCode ?? e?.code;
      if (status !== 429 || attempt >= SHEETS_RETRY_MAX - 1) throw e;
      const delay = SHEETS_RETRY_BASE_DELAY_SEC * 2 ** attempt;
      ctx.log(
        `! Sheets rate limit during ${action}; waiting ${delay.toFixed(0)}s (retry ${attempt + 2}/${SHEETS_RETRY_MAX})...`,
      );
      await sleep(delay * 1000);
    }
  }
  throw lastError;
}

/**
 * @param {object} ctx
 * @returns {Promise<Record<string, string[]>>}
 */
async function loadIdMappingFromSheet(ctx) {
  if (idMappingCache) return idMappingCache;

  idMappingCache = {};
  const { googleSheets, config } = ctx;
  if (!googleSheets) {
    ctx.log('! Could not access Sheets service; skipping ID remap lookup.');
    return idMappingCache;
  }

  try {
    const rows = await sheetsExecuteWithRetry(
      ctx,
      () => googleSheets.read(config.sheetRange, config.sheetId),
      'read ID mapping',
    );

    const candidates = {};
    for (let idx = 0; idx < rows.length; idx += 1) {
      const row = rows[idx] || [];
      if (idx === 0) {
        const first = (row[0] || '').trim().toLowerCase();
        if (['original id', 'original_id', 'old id', 'old_id'].includes(first)) continue;
      }
      const original = (row[0] || '').trim();
      const newId = (row[1] || '').trim();
      const dateStr = (row[2] || '').trim();
      if (!original || !newId) continue;
      const dt = parseChangeDate(dateStr);
      if (!candidates[original]) candidates[original] = [];
      candidates[original].push({ dt, newId });
    }

    for (const [original, entries] of Object.entries(candidates)) {
      entries.sort((a, b) => b.dt - a.dt);
      const ordered = [];
      const seen = new Set();
      for (const { newId } of entries) {
        if (seen.has(newId)) continue;
        seen.add(newId);
        ordered.push(newId);
      }
      idMappingCache[original] = ordered;
    }

    if (Object.keys(idMappingCache).length) {
      ctx.log(`- Loaded ${Object.keys(idMappingCache).length} ID remap entries from sheet.`);
    }
  } catch (e) {
    ctx.log(`! Failed to read sheet for ID mapping: ${e.message}`);
  }

  return idMappingCache;
}

/**
 * @param {object} ctx
 * @param {string} folderId
 * @param {(candidate: string) => Promise<boolean> | boolean} [existsFn]
 */
async function resolveIdViaSheet(ctx, folderId, existsFn) {
  const mapping = await loadIdMappingFromSheet(ctx);
  const candidates = mapping[folderId];
  if (!candidates?.length) return folderId;

  if (!existsFn) {
    const chosen = candidates[0];
    if (chosen !== folderId) ctx.log(`- Sheet remap: ${folderId} -> ${chosen}`);
    return chosen;
  }

  for (let rank = 0; rank < candidates.length; rank += 1) {
    const candidate = candidates[rank];
    if (await existsFn(candidate)) {
      const labels = ['most recent', '2nd most recent', '3rd most recent'];
      const label = rank < 3 ? labels[rank] : `#${rank + 1} most recent`;
      if (candidate !== folderId) {
        ctx.log(`- Sheet remap (${label}): ${folderId} -> ${candidate}`);
      }
      return candidate;
    }
    ctx.log(`- Sheet remap candidate ${candidate} for ${folderId} not found on remote; trying older entry...`);
  }

  ctx.log(`- No sheet candidate found on remote for ${folderId}; falling back to original id.`);
  return folderId;
}

function logIdChangeToSheet(ctx, oldId, newId) {
  const timestamp = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  sheetLogBuffer.push([oldId, newId, timestamp]);
  ctx.log(`- Queued sheet log: ${oldId} -> ${newId}`);
  return true;
}

async function flushSheetLogBuffer(ctx) {
  if (!sheetLogBuffer.length) return true;

  const { googleSheets, config } = ctx;
  if (!googleSheets) {
    ctx.log(`! Could not flush ${sheetLogBuffer.length} queued sheet row(s): no Sheets service.`);
    return false;
  }

  const rows = [...sheetLogBuffer];
  let written = 0;

  try {
    for (let start = 0; start < rows.length; start += SHEETS_APPEND_CHUNK_SIZE) {
      const chunk = rows.slice(start, start + SHEETS_APPEND_CHUNK_SIZE);
      await sheetsExecuteWithRetry(
        ctx,
        () =>
          googleSheets.append(config.sheetRange, chunk, config.sheetId),
        `append ${chunk.length} ID log row(s)`,
      );
      written += chunk.length;
      if (start + SHEETS_APPEND_CHUNK_SIZE < rows.length) {
        await sleep(1200);
      }
    }
    ctx.log(
      `- Logged ${written} ID change(s) to sheet (${Math.floor((rows.length - 1) / SHEETS_APPEND_CHUNK_SIZE) + 1} write request(s)).`,
    );
    sheetLogBuffer = [];
    idMappingCache = null;
    return true;
  } catch (e) {
    ctx.log(`! Failed to flush sheet log (${rows.length - written} row(s) still queued): ${e.message}`);
    return false;
  }
}

/**
 * @param {object} ctx
 * @returns {Promise<string | null>}
 */
async function fetchNewId(ctx) {
  const url = ctx.config.newIdUrl;
  const fetchFn = ctx.fetchFn || ctx.config?.fetchFn || fetch;
  try {
    const resp = await fetchFn(url, {
      headers: {},
    });
    const raw = (await resp.text()).trim();
    const data = JSON.parse(raw);
    if (Array.isArray(data) && data.length) {
      const newId = String(data[0]).trim();
      if (/^\d{12}$/.test(newId)) return newId;
      ctx.log(`! Warning: Fetched ID is not 12 digits: ${newId}`);
      return null;
    }
    ctx.log(`! Warning: Unexpected response shape: ${raw}`);
    return null;
  } catch (e) {
    ctx.log(`! Error fetching new ID: ${e.message}`);
    return null;
  }
}

/**
 * @param {object} vfs
 * @param {string} filePath
 * @param {string} oldId
 * @param {string} newId
 */
async function replaceInFile(vfs, filePath, oldId, newId) {
  try {
    const bytes = await vfs.readBytes(filePath);
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      // Match Python _replace_in_file: skip binary assets (pdf, jpg, etc.).
      return false;
    }
    if (!text.includes(oldId)) return false;
    await vfs.writeText(filePath, text.split(oldId).join(newId));
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {object} vfs
 * @param {string} sessionPath
 * @param {string} oldId
 * @param {string} newId
 */
async function updateSlideIdInCsv(ctx, sessionPath, oldId, newId) {
  const { vfs, log } = ctx;
  let totalChanged = 0;
  const entries = await vfs.listDir(sessionPath);

  for (const fname of entries) {
    if (!fname.toLowerCase().endsWith('.csv')) continue;
    const csvPath = `${sessionPath}/${fname}`;
    if (!(await vfs.isFile(csvPath))) continue;

    try {
      const text = await vfs.readText(csvPath);
      const rows = parseCsv(text);
      if (!rows.length) continue;

      const header = rows[0];
      const slideIdCol = header.indexOf('slide_id');
      if (slideIdCol === -1) {
        log(`- No 'slide_id' column in ${fname}; skipping.`);
        continue;
      }

      let changed = 0;
      for (let i = 1; i < rows.length; i += 1) {
        const row = rows[i];
        if (row.length > slideIdCol && row[slideIdCol] === oldId) {
          row[slideIdCol] = newId;
          changed += 1;
        }
      }

      if (changed) {
        await vfs.writeText(csvPath, serializeCsv(rows));
        log(`- Updated ${changed} slide_id cell(s) in ${fname}`);
        totalChanged += changed;
      }
    } catch (e) {
      log(`- Error reading CSV ${fname}: ${e.message}`);
    }
  }

  return totalChanged;
}

/**
 * @param {object} ctx
 * @param {string} sessionPath
 * @param {string} oldId
 * @param {string} newId
 */
async function renameSlideId(ctx, sessionPath, oldId, newId) {
  const { vfs, log } = ctx;
  const oldFolder = `${sessionPath}/${oldId}`;
  if (!(await vfs.isDir(oldFolder))) {
    log(`- Cannot rename ${oldId}: folder not found.`);
    return false;
  }

  const walkFiles = async (dir) => {
    const names = await vfs.listDir(dir);
    for (const name of names) {
      const fpath = `${dir}/${name}`;
      if (await vfs.isDir(fpath)) {
        await walkFiles(fpath);
      } else if (await vfs.isFile(fpath)) {
        if (await replaceInFile(vfs, fpath, oldId, newId)) {
          log(`- Updated content in ${fpath.replace(`${sessionPath}/`, '')}`);
        }
      }
    }
  };

  await walkFiles(oldFolder);

  const names = await vfs.listDir(oldFolder);
  for (const fname of names) {
    if (fname.includes(oldId)) {
      const src = `${oldFolder}/${fname}`;
      const dst = `${oldFolder}/${fname.replaceAll(oldId, newId)}`;
      try {
        await vfs.rename(src, dst);
        log(`- Renamed file ${fname} -> ${fname.replaceAll(oldId, newId)}`);
      } catch (e) {
        log(`- Error renaming file ${src}: ${e.message}`);
      }
    }
  }

  const newFolder = `${sessionPath}/${newId}`;
  try {
    await vfs.rename(oldFolder, newFolder);
    log(`- Renamed folder ${oldId} -> ${newId}`);
  } catch (e) {
    log(`- Error renaming folder ${oldId}: ${e.message}`);
    return false;
  }

  const sessionEntries = await vfs.listDir(sessionPath);
  for (const metaName of sessionEntries) {
    if (metaName.includes('_metasession.') && (metaName.endsWith('.tex') || metaName.endsWith('.xml'))) {
      const metaPath = `${sessionPath}/${metaName}`;
      if (
        (await vfs.isFile(metaPath)) &&
        (metaName.endsWith('.tex') || metaName.endsWith('.xml'))
      ) {
        if (await replaceInFile(vfs, metaPath, oldId, newId)) {
          log(`- Updated ${metaName}`);
        }
      }
    }
  }

  await updateSlideIdInCsv(ctx, sessionPath, oldId, newId);
  return true;
}

async function loadTempTabMapping(ctx) {
  const mapping = {};
  const { googleSheets, config, log } = ctx;
  if (!googleSheets) {
    log('! Could not access Sheets service; skipping temp tab lookup.');
    return mapping;
  }

  try {
    const rows = await sheetsExecuteWithRetry(
      ctx,
      () => googleSheets.read(config.tempSheetRange, config.sheetId),
      'read temp tab',
    );

    for (let idx = 0; idx < rows.length; idx += 1) {
      const row = rows[idx] || [];
      const meta = (row[0] || '').trim();
      const slide = (row[1] || '').trim();
      if (idx === 0) {
        const lowMeta = meta.toLowerCase();
        const lowSlide = slide.toLowerCase();
        if (lowMeta.includes('metasession') || lowSlide.includes('slide')) continue;
      }
      if (!meta || !slide) continue;
      if (!mapping[meta]) mapping[meta] = [];
      mapping[meta].push(slide);
    }

    const total = Object.values(mapping).reduce((n, v) => n + v.length, 0);
    if (total) {
      log(`- Loaded ${total} slide entries across ${Object.keys(mapping).length} metasessions from 'temp' tab.`);
    }
  } catch (e) {
    log(`! Failed to read 'temp' tab: ${e.message}`);
  }

  return mapping;
}

async function reassignIdsFromTempTab(ctx, filesDir) {
  const { log } = ctx;
  log("\n--- Reassigning IDs for slides listed in 'temp' tab ---");
  const tempMapping = await loadTempTabMapping(ctx);
  if (!Object.keys(tempMapping).length) {
    log('No temp tab entries to process.');
    return;
  }

  if (!(await ctx.vfs.isDir(filesDir))) {
    log(`! 'files' directory not found at ${filesDir}`);
    return;
  }

  let totalRenamed = 0;
  let totalChecked = 0;
  const sessionFolders = await ctx.vfs.listDir(filesDir);

  for (const sessionFolder of sessionFolders) {
    const sessionPath = `${filesDir}/${sessionFolder}`;
    if (!(await ctx.vfs.isDir(sessionPath))) continue;

    const metaId = sessionFolder;
    if (!/^\d{12}$/.test(metaId)) {
      log(`- Skipping session folder ${sessionFolder}: name is not a 12-digit metasession ID.`);
      continue;
    }

    const slideIds = tempMapping[metaId];
    if (!slideIds?.length) continue;

    log(`\nSession: ${metaId} (${slideIds.length} candidate slide id(s) from temp tab)`);
    for (const oldId of slideIds) {
      totalChecked += 1;
      const oldFolder = `${sessionPath}/${oldId}`;
      if (!(await ctx.vfs.isDir(oldFolder))) continue;

      log(`- Found slide still named with old id ${oldId}. Requesting new ID...`);
      const newId = await fetchNewId(ctx);
      if (!newId) {
        log(`- Skipping ${oldId}: could not obtain a new ID.`);
        continue;
      }
      if (newId === oldId) {
        log(`- New ID equals old ID (${oldId}); nothing to do.`);
        continue;
      }
      log(`- ${oldId} -> ${newId}`);
      if (await renameSlideId(ctx, sessionPath, oldId, newId)) {
        totalRenamed += 1;
        logIdChangeToSheet(ctx, oldId, newId);
      }
    }
  }

  log(`\nTemp-tab reassignment: renamed ${totalRenamed} slide(s) from ${totalChecked} candidate(s).`);
}

/**
 * @param {object} ctx
 * @returns {Promise<{ ok: boolean }>}
 */
export async function runCopySlidesContent(ctx) {
  const { vfs, log, config, archivePaths } = ctx;
  const filesDir = config.filesDir || 'files';
  const slidesArchive = archivePaths.slidesArchive;

  idMappingCache = null;
  sheetLogBuffer = [];

  if (!(await vfs.isDir(filesDir))) {
    log(`Error: The 'files' directory was not found in ${filesDir}`);
    return { ok: false };
  }

  const sessionDirs = (await vfs.listDir(filesDir)).filter(
    (d) => !d.startsWith('.'),
  );
  const existingSessions = [];
  for (const d of sessionDirs) {
    if (await vfs.isDir(`${filesDir}/${d}`)) existingSessions.push(d);
  }

  if (!existingSessions.length) {
    log(`Error: No session folders found in ${filesDir}`);
    return { ok: false };
  }

  log('\nStarting file copy and injection process...');
  /** @type {Record<string, string[]>} */
  const matchedIdsBySession = {};

  for (const sessionFolder of existingSessions) {
    const sessionPath = `${filesDir}/${sessionFolder}`;
    log(`\nProcessing session folder: ${sessionFolder}`);
    matchedIdsBySession[sessionPath] = [];

    const items = await vfs.listDir(sessionPath);
    for (const item of items) {
      const level3Path = `${sessionPath}/${item}`;
      if (!(await vfs.isDir(level3Path)) || !/^\d{12}$/.test(item)) continue;

      const folderId = item;
      const remoteSourceId = (await readRemoteSourceSlideId(vfs, level3Path)) || folderId;
      const texFiles = (await vfs.listDir(level3Path)).filter((f) => f.endsWith('.tex'));
      if (!texFiles.length) {
        log(`- Warning: No .tex file found inside ${folderId}. Skipping sync for this ID.`);
        continue;
      }

      const localTexPath = `${level3Path}/${texFiles[0]}`;
      const lookupId = await resolveIdViaSheet(ctx, remoteSourceId, (cid) =>
        vfs.exists(`${slidesArchive}/${cid}`),
      );
      const remoteFolderPath = `${slidesArchive}/${lookupId}`;

      if (await vfs.exists(remoteFolderPath)) {
        if (lookupId !== folderId) {
          log(`- Match found for ${folderId} via remapped id ${lookupId}. Syncing files...`);
        } else {
          log(`- Match found for ${folderId}. Syncing files...`);
        }
        matchedIdsBySession[sessionPath].push(folderId);

        let remoteTexContent = '';
        let foundRemoteTex = false;
        const remoteItems = await vfs.listDir(remoteFolderPath);

        for (const remoteItem of remoteItems) {
          const srcItemPath = `${remoteFolderPath}/${remoteItem}`;
          const dstItemName =
            lookupId !== folderId ? remoteItem.replaceAll(lookupId, folderId) : remoteItem;
          const dstItemPath = `${level3Path}/${dstItemName}`;

          if (remoteItem.endsWith('.tex')) {
            if (foundRemoteTex) {
              log(`! Warning: Multiple .tex files found in remote ${folderId}. Ignoring ${remoteItem}`);
              continue;
            }
            try {
              remoteTexContent = await vfs.readText(srcItemPath);
              foundRemoteTex = true;
            } catch (e) {
              log(`- Error reading remote tex: ${e.message}`);
            }
          } else {
            try {
              if (await vfs.isDir(srcItemPath)) {
                await vfs.copyTree(srcItemPath, dstItemPath, { merge: true });
              } else {
                await vfs.copyFile(srcItemPath, dstItemPath);
              }
            } catch (e) {
              log(`- Error copying ${remoteItem}: ${e.message}`);
            }
          }
        }

        if (remoteTexContent && localTexPath) {
          let contentToInject = extractContentForInjection(remoteTexContent);
          if (lookupId !== folderId) {
            contentToInject = contentToInject.split(lookupId).join(folderId);
          }
          const localTex = await vfs.readText(localTexPath);
          const result = injectRemoteContent(localTex, contentToInject);
          if (result.ok) {
            await vfs.writeText(localTexPath, result.content);
            log(`- Successfully injected content into ${texFiles[0]}`);
          } else {
            log(`- Warning: ${result.error} in ${texFiles[0]}`);
          }
        }
      } else {
        log(`- No remote folder found for ${folderId}`);
      }
    }
  }

  log('\n--- Reassigning IDs for slides synced from remote ---');
  let totalRenamed = 0;
  const totalTargets = Object.values(matchedIdsBySession).reduce((n, ids) => n + ids.length, 0);

  if (!totalTargets) {
    log('No remote-matched slides to reassign.');
  } else {
    for (const [sessionPath, matchedIds] of Object.entries(matchedIdsBySession)) {
      if (!matchedIds.length) continue;
      log(`\nSession: ${sessionPath.split('/').pop()}`);
      for (const oldId of matchedIds) {
        log(`- Requesting new ID for ${oldId}...`);
        const newId = await fetchNewId(ctx);
        if (!newId) {
          log(`- Skipping ${oldId}: could not obtain a new ID.`);
          continue;
        }
        if (newId === oldId) {
          log(`- New ID equals old ID (${oldId}); nothing to do.`);
          continue;
        }
        log(`- ${oldId} -> ${newId}`);
        if (await renameSlideId(ctx, sessionPath, oldId, newId)) {
          totalRenamed += 1;
          logIdChangeToSheet(ctx, oldId, newId);
        }
      }
    }
    log(`\nReassigned ${totalRenamed}/${totalTargets} slide IDs.`);
  }

  await reassignIdsFromTempTab(ctx, filesDir);
  await flushSheetLogBuffer(ctx);
  log('\nProcess completed.');
  return { ok: true };
}

/** Minimal CSV parse/serialize for slide_id updates */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function serializeCsv(rows) {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const s = String(cell ?? '');
          return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(','),
    )
    .join('\n');
}
