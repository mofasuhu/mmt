/**
 * Port of add_verbatim_to_slides.py — inject verbatim text and optional ID renames.
 */

import { ID_URL } from '../shared/constants.js';
import { getRawMetasessionData } from '../shared/metasessionApi.js';
import {
  csvCellStr,
  isTwelveDigitId,
  loadSessionRows,
  matchSlideFolder,
  normalizeMetasessionId,
  normalizeSlideIdForFolder,
} from '../shared/sessionCsv.js';

/**
 * @param {object} ctx
 * @param {string} metasessionId
 * @returns {Promise<string | null>}
 */
async function getSubjectForMetasession(ctx, metasessionId) {
  const apiData = await getRawMetasessionData(metasessionId, { fatal: false, log: ctx.log });
  return apiData?.subject?.name ?? null;
}

/**
 * @param {string | null | undefined} subject
 * @returns {boolean}
 */
function isDiscoverSubject(subject) {
  if (!subject) return false;
  const s = subject.trim();
  if (s === 'اكتشف') return true;
  return s.toLowerCase() === 'discover';
}

/**
 * @param {object} ctx
 * @returns {Promise<string | null>}
 */
async function fetchNew12DigitId(ctx) {
  const url = ctx.config?.newIdUrl || ID_URL;
  const fetchFn = ctx.fetchFn || ctx.config?.fetchFn || fetch;
  try {
    const resp = await fetchFn(url);
    const data = await resp.json();
    if (Array.isArray(data) && data.length) return String(data[0]).trim();
    if (typeof data === 'string') return data.trim();
    return null;
  } catch (e) {
    ctx.log(`⚠ Could not fetch new 12-digit ID: ${e.message}`);
    return null;
  }
}

/**
 * @param {string} folderName
 * @returns {string | null}
 */
function extractSessionId(folderName) {
  const match = folderName.match(/^(\d{12})/);
  return match ? match[1] : null;
}

/**
 * @param {object} vfs
 * @param {string} dir
 * @param {string} sessionId
 * @returns {Promise<string | null>}
 */
async function findCsvForSession(vfs, dir, sessionId) {
  if (!(await vfs.isDir(dir))) return null;
  const files = await vfs.listDir(dir);
  for (const f of files) {
    if (f.endsWith('.csv') && f.includes(sessionId)) return `${dir}/${f}`;
  }
  return null;
}

/**
 * @param {*} slideIdRaw
 * @returns {string | null}
 */
function normalizeSlideIdFromCsv(slideIdRaw) {
  return normalizeSlideIdForFolder(slideIdRaw);
}

/**
 * @param {*} slideIdRaw
 * @param {string[]} availableFolders
 * @returns {string | null}
 */
function slideIdToFolder(slideIdRaw, availableFolders) {
  return matchSlideFolder(slideIdRaw, availableFolders);
}

/**
 * @param {*} raw
 * @returns {string | null}
 */
function extractVerbatimText(raw) {
  if (raw == null || !String(raw).trim()) return null;
  const s = String(raw).trim();
  const match = s.match(/\{([\s\S]*)\}/);
  if (match) {
    const inner = match[1].trim();
    if (inner) return inner;
  }
  return s || null;
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeLatexArg(text) {
  return text
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/#/g, '\\#')
    .replace(/\$/g, '\\$')
    .replace(/&/g, '\\&')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
    .replace(/\^/g, '\\^{}')
    .replace(/~/g, '\\textasciitilde{}');
}

/**
 * @param {string} content
 * @param {string} verbatimText
 * @returns {string}
 */
function addVerbatimToTex(content, verbatimText) {
  const escaped = escapeLatexArg(verbatimText);
  return content.replace(
    /(\\slidestandalone\{[^}]*\}\{)\s*/,
    `$1\n        \\verbatimreading{${escaped}}\n        `,
  );
}

/**
 * @param {string} content
 * @returns {boolean}
 */
function alreadyHasVerbatim(content) {
  return /\\slidestandalone\{[^}]*\}\{[\s\S]*?\\verbatimreading\{/.test(content);
}

/**
 * @param {object} vfs
 * @param {string} texPath
 * @param {string} verbatimText
 * @param {string} slideLabel
 * @param {Function} log
 */
async function injectVerbatimIntoSlide(vfs, texPath, verbatimText, slideLabel, log) {
  try {
    const content = await vfs.readText(texPath);
    if (alreadyHasVerbatim(content)) return false;
    const newContent = addVerbatimToTex(content, verbatimText);
    if (newContent === content) return false;
    await vfs.writeText(texPath, newContent);
    log(`✓ ${slideLabel}`);
    return true;
  } catch (e) {
    log(`⚠ Could not read/write ${texPath}: ${e.message}`);
    return false;
  }
}

/**
 * @param {string} slideId
 * @param {Record<string, string>} oldToNew
 * @returns {string}
 */
function resolveCurrentName(slideId, oldToNew) {
  return oldToNew[slideId] ?? slideId;
}

/**
 * @param {object} vfs
 * @param {string} slideFolder
 * @param {string} slideId
 * @param {string} text
 * @param {Function} log
 */
async function writeListeningFile(vfs, slideFolder, slideId, text, log) {
  const path = `${slideFolder}/${slideId}.listening.txt`;
  try {
    await vfs.writeText(path, text);
    log(`✓ ${slideId}.listening.txt`);
    return true;
  } catch (e) {
    log(`⚠ Could not write ${path}: ${e.message}`);
    return false;
  }
}

/**
 * @param {*} raw
 * @returns {number | null}
 */
function parseVerbatimNumber(raw) {
  if (raw == null || raw === '') return null;
  try {
    const s = String(raw).trim();
    if (!s) return null;
    return parseInt(Number(s), 10);
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, string>[]} rows
 * @returns {Array<Array<[string, string, number, string, boolean]>>}
 */
function slideGroupChildIdsFromXmlText(xmlText) {
  const ids = new Set();
  if (!xmlText) return ids;
  try {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (doc.querySelector('parsererror')) return ids;
    for (const group of [...doc.querySelectorAll('slide_group')]) {
      for (const slide of [...group.children]) {
        if (slide.tagName !== 'slide') continue;
        const slideId = csvCellStr(slide.getAttribute('slide_id'));
        if (slideId) ids.add(slideId);
      }
    }
  } catch {
    /* ignore malformed/missing XML */
  }
  return ids;
}

function directParentAndIndex(root, slideId) {
  const walk = (parent) => {
    const children = [...parent.children];
    for (let idx = 0; idx < children.length; idx += 1) {
      const child = children[idx];
      if (child.tagName === 'slide' && csvCellStr(child.getAttribute('slide_id')) === slideId) {
        return [parent, idx];
      }
      const nested = walk(child);
      if (nested) return nested;
    }
    return null;
  };
  return walk(root);
}

function wrapMultipartRunInXmlText(xmlText, { groupId, partChildIds }) {
  if (!xmlText || !partChildIds.length) return [xmlText, false];
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) return [xmlText, false];
  const root = doc.documentElement;
  const positions = [];
  for (const childId of partChildIds) {
    const found = directParentAndIndex(root, childId);
    if (!found) return [xmlText, false];
    positions.push(found);
  }
  const [parent] = positions[0];
  if (!positions.every(([candidate]) => candidate === parent)) return [xmlText, false];
  const indices = positions.map(([, idx]) => idx).sort((a, b) => a - b);
  const firstIdx = indices[0];
  const lastIdx = indices[indices.length - 1];
  const children = [...parent.children];
  const spanChildren = children.slice(firstIdx, lastIdx + 1);
  if (!spanChildren.length || spanChildren.some((child) => child.tagName !== 'slide')) {
    return [xmlText, false];
  }

  const group = doc.createElement('slide_group');
  group.setAttribute('slide_group_id', groupId);
  group.setAttribute(
    'pages',
    spanChildren.length > partChildIds.length || partChildIds.length >= 4 ? 'multiple' : 'single',
  );
  parent.insertBefore(group, spanChildren[0]);
  for (const child of spanChildren) {
    group.appendChild(child);
  }
  return [new XMLSerializer().serializeToString(doc), true];
}

function multipartRunsByVerbatimNumber(rows, groupedSlideIds = new Set()) {
  const runs = [];
  let currentRun = [];
  let expectedNext = null;

  for (const row of rows) {
    const text = extractVerbatimText(row.verbatim_multipart);
    const num = parseVerbatimNumber(row.verbatim_number);
    if (!text) {
      if (num != null && currentRun.length) {
        runs.push(currentRun);
        currentRun = [];
        expectedNext = null;
      }
      continue;
    }

    const slideId = normalizeSlideIdFromCsv(row.slide_id);
    const slideNumber = csvCellStr(row.slide_number) || '?';
    const alreadyGrouped = Boolean(
      csvCellStr(row.package_source_slide_id) || groupedSlideIds.has(slideId),
    );

    if (!slideId) {
      if (currentRun.length) runs.push(currentRun);
      currentRun = [];
      expectedNext = null;
      continue;
    }

    if (num == null) {
      if (currentRun.length) runs.push(currentRun);
      currentRun = [];
      expectedNext = null;
      continue;
    }

    if (num === 1) {
      if (currentRun.length) runs.push(currentRun);
      currentRun = [[slideId, text, num, slideNumber, alreadyGrouped]];
      expectedNext = 2;
    } else if (expectedNext != null && num === expectedNext) {
      currentRun.push([slideId, text, num, slideNumber, alreadyGrouped]);
      expectedNext = num + 1;
    } else {
      if (currentRun.length) runs.push(currentRun);
      if (num === 1) {
        currentRun = [[slideId, text, num, slideNumber, alreadyGrouped]];
        expectedNext = 2;
      } else {
        currentRun = [];
        expectedNext = null;
      }
    }
  }

  if (currentRun.length) runs.push(currentRun);
  return runs;
}

/**
 * @param {string} filename
 * @param {string} oldId
 * @param {string} newId
 * @returns {string}
 */
function remapSlideAssetName(filename, oldId, newId) {
  if (filename.startsWith(oldId)) return `${newId}${filename.slice(oldId.length)}`;
  return filename;
}

/**
 * Move all assets from oldId/ into newId/, renaming files prefixed with oldId.
 * @param {object} ctx
 * @param {string} sessionFolder
 * @param {string} oldId
 * @param {string} newId
 * @returns {Promise<boolean>}
 */
async function mergeSlideFolder(ctx, sessionFolder, oldId, newId) {
  const { vfs } = ctx;
  const oldFolder = `${sessionFolder}/${oldId}`;
  if (!(await vfs.isDir(oldFolder))) return false;

  const newFolder = `${sessionFolder}/${newId}`;
  await vfs.mkdir(newFolder, { recursive: true });

  let movedAny = false;
  const names = (await vfs.listDir(oldFolder)).filter((n) => !n.startsWith('.'));
  for (const name of names.sort()) {
    const srcPath = `${oldFolder}/${name}`;
    const destName = remapSlideAssetName(name, oldId, newId);
    const destPath = `${newFolder}/${destName}`;

    if (await vfs.isDir(srcPath)) {
      if (await vfs.exists(destPath)) {
        await vfs.remove(destPath, { recursive: true });
      }
      await vfs.rename(srcPath, destPath);
      movedAny = true;
      continue;
    }

    if (await vfs.isFile(srcPath)) {
      if (await vfs.exists(destPath)) {
        await vfs.remove(destPath);
      }
      await vfs.rename(srcPath, destPath);
      movedAny = true;
    }
  }

  try {
    const remaining = await vfs.listDir(oldFolder);
    if (!remaining.length) {
      await vfs.remove(oldFolder);
    } else {
      await vfs.remove(oldFolder, { recursive: true });
    }
  } catch {
    /* ignore */
  }

  return movedAny;
}

/**
 * @param {object} ctx
 * @param {string} sessionFolder
 * @param {Record<string, string>} oldToNew
 * @param {string} metasessionStem
 */
async function applyRenames(ctx, sessionFolder, oldToNew, metasessionStem) {
  const { vfs, log } = ctx;

  for (const [oldId, newId] of Object.entries(oldToNew)) {
    if (await mergeSlideFolder(ctx, sessionFolder, oldId, newId)) {
      log(`↷ ${oldId} → ${newId}`);
    }
  }

  const mainTex = `${sessionFolder}/${metasessionStem}.tex`;
  const mainXml = `${sessionFolder}/${metasessionStem}.xml`;

  for (const mainPath of [mainTex, mainXml]) {
    if (!(await vfs.isFile(mainPath))) continue;
    try {
      let content = await vfs.readText(mainPath);
      for (const [oldId, newId] of Object.entries(oldToNew)) {
        content = content.split(oldId).join(newId);
      }
      await vfs.writeText(mainPath, content);
      log(`✓ Updated ${mainPath.split('/').pop()}`);
    } catch (e) {
      log(`⚠ Could not update ${mainPath}: ${e.message}`);
    }
  }
}

/**
 * @param {object} ctx
 * @param {string} sessionFolder
 * @param {string} csvPath
 * @returns {Promise<number>}
 */
async function processSession(ctx, sessionFolder, csvPath) {
  const { vfs, log } = ctx;
  const sessionId = extractSessionId(sessionFolder.split('/').pop());
  if (!sessionId) return 0;
  if (!(await vfs.isFile(csvPath))) return 0;

  let rows;
  try {
    rows = await loadSessionRows(vfs, csvPath);
  } catch (e) {
    log(`⚠ Could not read CSV ${csvPath}: ${e.message}`);
    return 0;
  }

  if (!rows.length || !('slide_id' in rows[0])) {
    log('⚠ CSV missing column slide_id');
    return 0;
  }

  let metasessionId = sessionId;
  if ('metasession_id' in rows[0]) {
    for (const row of rows) {
      const normalized = normalizeMetasessionId(row.metasession_id);
      if (normalized) {
        metasessionId = normalized;
        break;
      }
    }
  }

  const subject = await getSubjectForMetasession(ctx, metasessionId);
  let discoverMode = isDiscoverSubject(subject);

  const slideFolders = [];
  for (const name of await vfs.listDir(sessionFolder)) {
    if ((await vfs.isDir(`${sessionFolder}/${name}`)) && isTwelveDigitId(name)) {
      slideFolders.push(name);
    }
  }

  const metasessionStem = `${sessionFolder.split('/').pop()}_metasession`;
  /** @type {Array<[string, string, string]>} */
  const verbatimSlides = [];
  /** @type {Array<[string, string, string]>} */
  const listeningSlides = [];

  for (const row of rows) {
    const oldSlideId = slideIdToFolder(row.slide_id, slideFolders);
    if (!oldSlideId) continue;
    const slideNumber = csvCellStr(row.slide_number) || '?';

    if ('verbatim' in row) {
      const vt = extractVerbatimText(row.verbatim);
      if (vt) verbatimSlides.push([oldSlideId, vt, slideNumber]);
    }
    if ('verbatim_listening' in row) {
      const vl = extractVerbatimText(row.verbatim_listening);
      if (vl) listeningSlides.push([oldSlideId, vl, slideNumber]);
    }
  }

  let groupedSlideIds = new Set();
  const packageXmlPath = `${sessionFolder}/${metasessionStem}.xml`;
  if (await vfs.isFile(packageXmlPath)) {
    try {
      groupedSlideIds = slideGroupChildIdsFromXmlText(await vfs.readText(packageXmlPath));
    } catch {
      groupedSlideIds = new Set();
    }
  }
  const multipartRuns = multipartRunsByVerbatimNumber(rows, groupedSlideIds);

  if (!verbatimSlides.length && !listeningSlides.length && !multipartRuns.length) {
    return 0;
  }

  /** @type {Record<string, string>} */
  const oldToNew = {};

  if (discoverMode && verbatimSlides.length) {
    const baseId = await fetchNew12DigitId(ctx);
    if (baseId && /^\d{12}$/.test(baseId)) {
      verbatimSlides.forEach(([oldId], i) => {
        oldToNew[oldId] = `${baseId}.${i + 1}`;
      });
      await applyRenames(ctx, sessionFolder, { ...oldToNew }, metasessionStem);
    } else {
      log('⚠ Discover mode: could not get valid 12-digit ID, skipping renames');
      discoverMode = false;
    }
  }

  const multipartWraps = [];
  for (const run of multipartRuns) {
    if (run.every((entry) => entry[4])) {
      continue;
    }
    const groupId = await fetchNew12DigitId(ctx);
    const childIds = [];
    for (let i = 0; i < run.length; i += 1) {
      childIds.push(await fetchNew12DigitId(ctx));
    }
    if (
      !groupId
      || !/^\d{12}$/.test(groupId)
      || childIds.some((childId) => !childId || !/^\d{12}$/.test(childId))
    ) {
      log('⚠ verbatim_multipart: could not get valid 12-digit ID, skipping run');
      continue;
    }
    /** @type {Record<string, string>} */
    const runOldToNew = {};
    run.forEach(([oldId], index) => {
      const currentName = resolveCurrentName(oldId, oldToNew);
      const childId = childIds[index];
      runOldToNew[currentName] = childId;
      oldToNew[oldId] = childId;
    });
    await applyRenames(ctx, sessionFolder, runOldToNew, metasessionStem);
    multipartWraps.push({ groupId, partChildIds: childIds });
  }

  const mainXml = `${sessionFolder}/${metasessionStem}.xml`;
  if (multipartWraps.length && await vfs.isFile(mainXml)) {
    let xmlText = await vfs.readText(mainXml);
    let changed = false;
    for (const wrapSpec of multipartWraps) {
      const [nextXmlText, didWrap] = wrapMultipartRunInXmlText(xmlText, wrapSpec);
      xmlText = nextXmlText;
      if (didWrap) {
        changed = true;
        log(`✓ Wrapped verbatim_multipart slide_group ${wrapSpec.groupId}`);
      }
    }
    if (changed) {
      await vfs.writeText(mainXml, xmlText);
    }
  }

  let updated = 0;

  for (const [oldSlideId, text, slideNumber] of listeningSlides) {
    const current = resolveCurrentName(oldSlideId, oldToNew);
    const slideFolderPath = `${sessionFolder}/${current}`;
    if (await vfs.isDir(slideFolderPath)) {
      if (await writeListeningFile(vfs, slideFolderPath, current, text, log)) {
        log(`  slide ${slideNumber} → ${current} (verbatim_listening)`);
        updated += 1;
      }
    }
  }

  for (const [oldSlideId, verbatimText, slideNumber] of verbatimSlides) {
    const current = resolveCurrentName(oldSlideId, oldToNew);
    const texPath = `${sessionFolder}/${current}/${current}.tex`;
    if (await vfs.isFile(texPath)) {
      if (await injectVerbatimIntoSlide(vfs, texPath, verbatimText, `${current}.tex`, log)) {
        log(`  slide ${slideNumber} → ${current} (verbatim)`);
        updated += 1;
      }
    }
  }

  for (const run of multipartRuns) {
    for (const [oldSlideId, verbatimText, _partNumber, slideNumber] of run) {
      const current = resolveCurrentName(oldSlideId, oldToNew);
      const texPath = `${sessionFolder}/${current}/${current}.tex`;
      if (await vfs.isFile(texPath)) {
        if (await injectVerbatimIntoSlide(vfs, texPath, verbatimText, `${current}.tex`, log)) {
          log(`  slide ${slideNumber} → ${current} (verbatim_multipart)`);
          updated += 1;
        }
      }
    }
  }

  return updated;
}

/**
 * @param {object} ctx
 * @returns {Promise<{ ok: boolean, totalUpdated: number }>}
 */
export async function runAddVerbatimToSlides(ctx) {
  const { vfs, log, config } = ctx;
  const filesDir = config.filesDir || 'files';
  const csvsDir = config.csvsDir || 'csvs';

  if (!(await vfs.isDir(filesDir))) {
    log(`❌ files/ directory not found at ${filesDir}`);
    return { ok: false, totalUpdated: 0 };
  }

  const sessionItems = (await vfs.listDir(filesDir)).filter((d) => !d.startsWith('.'));
  if (!sessionItems.length) {
    log(`❌ No session folders found in ${filesDir}`);
    return { ok: false, totalUpdated: 0 };
  }

  let totalUpdated = 0;
  const sorted = [...sessionItems].sort();

  for (const item of sorted) {
    const path = `${filesDir}/${item}`;
    if (!(await vfs.isDir(path))) continue;

    const sessionId = extractSessionId(item);
    if (!sessionId) continue;

    let csvPath = await findCsvForSession(vfs, path, sessionId);
    let csvSource = 'package';
    if (!csvPath) {
      csvPath = await findCsvForSession(vfs, csvsDir, sessionId);
      csvSource = 'csvs';
    }
    if (!csvPath) {
      log(`⊘ ${item}: no CSV found`);
      continue;
    }

    log(`\n📁 ${item}`);
    log(`  CSV source: ${csvSource} (${csvPath.split('/').pop()})`);
    const n = await processSession(ctx, path, csvPath);
    totalUpdated += n;
    if (n === 0) log('(no updates)');
  }

  log(`\n✅ Done. Updated/created ${totalUpdated} file(s) (.tex and/or .listening.txt).`);
  return { ok: true, totalUpdated };
}
