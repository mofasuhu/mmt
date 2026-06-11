/**
 * Port of make_files.py — generate per-slide .tex trees under files/.
 */
import { csvCellStr, isTwelveDigitId, loadSessionRows } from '../shared/sessionCsv.js';

const ARABIC_SESSION_NUMBERS = {
  1: 'الأولى', 2: 'الثانية', 3: 'الثالثة', 4: 'الرابعة', 5: 'الخامسة',
  6: 'السادسة', 7: 'السابعة', 8: 'الثامنة', 9: 'التاسعة', 10: 'العاشرة',
  11: 'الحادية عشرة', 12: 'الثانية عشرة', 13: 'الثالثة عشرة', 14: 'الرابعة عشرة',
  15: 'الخامسة عشرة', 16: 'السادسة عشرة', 17: 'السابعة عشرة', 18: 'الثامنة عشرة',
  19: 'التاسعة عشرة', 20: 'العشرون', 21: 'الحادية والعشرون', 22: 'الثانية والعشرون',
  23: 'الثالثة والعشرون', 24: 'الرابعة والعشرون', 25: 'الخامسة والعشرون',
  26: 'السادسة والعشرون', 27: 'السابعة والعشرون', 28: 'الثامنة والعشرون',
  29: 'التاسعة والعشرون', 30: 'الثلاثون', 31: 'الحادية والثلاثون', 32: 'الثانية والثلاثون',
  33: 'الثالثة والثلاثون', 34: 'الرابعة والثلاثون', 35: 'الخامسة والثلاثون',
  36: 'السادسة والثلاثون', 37: 'السابعة والثلاثون', 38: 'الثامنة والثلاثون',
  39: 'التاسعة والثلاثون', 40: 'الأربعون', 41: 'الحادية والأربعون', 42: 'الثانية والأربعون',
  43: 'الثالثة والأربعون', 44: 'الرابعة والأربعون', 45: 'الخامسة والأربعون',
  46: 'السادسة والأربعون', 47: 'السابعة والأربعون', 48: 'الثامنة والأربعون',
  49: 'التاسعة والأربعون', 50: 'الخمسون', 51: 'الحادية والخمسون', 52: 'الثانية والخمسون',
  53: 'الثالثة والخمسون', 54: 'الرابعة والخمسون', 55: 'الخامسة والخمسون',
  56: 'السادسة والخمسون', 57: 'السابعة والخمسون', 58: 'الثامنة والخمسون',
  59: 'التاسعة والخمسون', 60: 'الستون', 61: 'الحادية والستون', 62: 'الثانية والستون',
  63: 'الثالثة والستون', 64: 'الرابعة والستون',
};

const THANK_YOU_MESSAGES = {
  en: '\\ThankYou{Thank You!}',
  ar: '\\ThankYou{شكرًا جزيلًا}',
  fr: '\\ThankYou{Merci}',
  es: '\\ThankYou{¡Gracias!}',
  de: '\\ThankYou{Vielen Dank}',
  it: '\\ThankYou{Grazie}',
};

/**
 * @param {import('../io/virtualFs.js').VirtualFs} vfs
 * @param {string} texFileIdPart
 */
async function loadSessionCsv(vfs, texFileIdPart) {
  const matches = (await vfs.glob(`csvs/${texFileIdPart}*.csv`)).sort();
  if (!matches.length) return { rows: null, path: null };
  const csvPath = matches[0];
  try {
    const rows = await loadSessionRows(vfs, csvPath);
    for (const row of rows) {
      if ('slide_id' in row) row.slide_id = csvCellStr(row.slide_id);
    }
    return { rows, path: csvPath };
  } catch (e) {
    return { rows: null, path: null, error: e };
  }
}

function twelveDigitIdKey(val) {
  const s = csvCellStr(val);
  if (!isTwelveDigitId(s)) return '';
  const match = /^(\d{12})/.exec(s);
  return match ? match[1] : '';
}

function exclusionIdKeys(val) {
  const s = csvCellStr(val);
  if (!s) return new Set();
  const keys = new Set([s]);
  if (isTwelveDigitId(s)) {
    const base = twelveDigitIdKey(s);
    if (base) keys.add(base);
  }
  return keys;
}

function isExcludedSlideId(slideId, excluded) {
  const keys = exclusionIdKeys(slideId);
  for (const k of keys) {
    if (excluded.has(k)) return true;
  }
  return false;
}

function addExclusionKeys(excluded, val) {
  for (const k of exclusionIdKeys(val)) excluded.add(k);
}

function slideIdsExcludedFromMainTex(csvRows) {
  const excluded = new Set();
  if (!csvRows) return excluded;

  const mediaColumns = ['question_id', 'activity_id'];
  for (const row of csvRows) {
    const hasMediaId = mediaColumns.some(
      (col) => col in row && twelveDigitIdKey(row[col]),
    );
    if (!hasMediaId) continue;
    for (const col of ['slide_id', ...mediaColumns]) {
      if (col in row) addExclusionKeys(excluded, row[col]);
    }
  }
  return excluded;
}

function localXmlTag(elem) {
  const tag = elem.tagName || '';
  const idx = tag.lastIndexOf(':');
  return idx >= 0 ? tag.slice(idx + 1) : tag;
}

function isQuestionLikeSlideType(slideType) {
  return slideType === 'example' || slideType === 'interactive_example' || slideType.startsWith('question');
}

function shouldSkipSlideFolder(slideId, slideType, excludedIds) {
  if (isQuestionLikeSlideType(slideType)) return true;
  return isExcludedSlideId(slideId, excludedIds);
}

/**
 * @param {import('../io/virtualFs.js').VirtualFs} vfs
 * @param {string} dirPath
 */
async function removeDirRecursive(vfs, dirPath) {
  if (typeof vfs.removeDir === 'function') {
    await vfs.removeDir(dirPath);
    return;
  }
  if (!(await vfs.exists(dirPath))) return;
  const entries = await vfs.listDir(dirPath);
  for (const name of entries) {
    const child = `${dirPath}/${name}`;
    if (await vfs.isDir(child)) {
      await removeDirRecursive(vfs, child);
    } else if (await vfs.isFile(child) && typeof vfs.remove === 'function') {
      await vfs.remove(child);
    }
  }
  if (typeof vfs.remove === 'function') {
    await vfs.remove(dirPath);
  }
}

async function cleanupOrphanSlideFolders(vfs, sessionFolderPath, keptSlideIds) {
  let removed = 0;
  if (!(await vfs.exists(sessionFolderPath))) return removed;
  const names = await vfs.listDir(sessionFolderPath);
  for (const name of names) {
    const folderPath = `${sessionFolderPath}/${name}`;
    if (!(await vfs.isDir(folderPath))) continue;
    const baseMatch = /^(\d{12})/.exec(name);
    if (!baseMatch) continue;
    if (keptSlideIds.has(name) || keptSlideIds.has(baseMatch[1])) continue;
    await removeDirRecursive(vfs, folderPath);
    removed += 1;
  }
  return removed;
}

function parseXmlRoot(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) return null;
  return doc.documentElement;
}

function slideIdsExcludedFromMainTexXml(xmlRoot) {
  const excluded = new Set();
  if (!xmlRoot) return excluded;

  const mediaAttrs = ['question_id', 'activity_id'];
  const walk = (elem) => {
    const tag = localXmlTag(elem);
    if (tag === 'slide') {
      const hasMedia = mediaAttrs.some((attr) => twelveDigitIdKey(elem.getAttribute(attr)));
      if (hasMedia) {
        addExclusionKeys(excluded, elem.getAttribute('slide_id'));
        for (const attr of mediaAttrs) addExclusionKeys(excluded, elem.getAttribute(attr));
      }
    } else if (tag === 'question') {
      addExclusionKeys(excluded, elem.getAttribute('question_id'));
    }
    for (const child of elem.children) walk(child);
  };
  walk(xmlRoot);
  return excluded;
}

async function copyFile(vfs, src, dest) {
  if (typeof vfs.copyFile === 'function') {
    await vfs.copyFile(src, dest);
    return;
  }
  const bytes = await vfs.readBytes(src);
  await vfs.writeBytes(dest, bytes);
}

/**
 * @param {object} ctx
 * @param {import('../io/virtualFs.js').VirtualFs} ctx.vfs
 * @param {(msg: string) => void} ctx.log
 */
export async function runMakeFiles(ctx) {
  const { vfs, log } = ctx;

  if (!(await vfs.exists('tex'))) {
    throw new Error("tex/ directory not found. Fix the issue and rerun the full pipeline.");
  }

  const texFiles = (await vfs.listDir('tex')).filter((n) => n.endsWith('.tex'));
  if (!texFiles.length) {
    throw new Error('No .tex files found in tex/. Fix the issue and rerun the full pipeline.');
  }

  log("✅ Output will be generated in: 'files/'");

  for (const filename of texFiles) {
    const filePath = `tex/${filename}`;
    const baseFilename = filename.replace(/\.tex$/i, '');
    const texFileIdPart = baseFilename.split('_')[0];

    log(`\n📄 Processing file: ${filename}`);

    const content = await vfs.readText(filePath);

    const langMatch = /\\languageofinstruction\{(\w+)\}/.exec(content);
    const language = langMatch ? langMatch[1] : 'en';
    const isArabic = language === 'ar';

    const subjectMatch = /\\subject\{(.*?)\}/.exec(content);
    const subject = subjectMatch ? subjectMatch[1] : '';

    const titleMatch = /\\sessiontitle\{(.*?)\}/.exec(content);
    const title = titleMatch ? titleMatch[1] : '';

    const sessionMatch = /\\metasessionID\{(\d+)\}/.exec(content);
    if (!sessionMatch) {
      log(`⚠️ Warning: No '\\metasessionID' found in ${filename}. Skipping.`);
      continue;
    }

    const metasessionId = sessionMatch[1];
    const sessionFolderPath = `files/${metasessionId}`;
    await vfs.mkdir(sessionFolderPath, { recursive: true });

    const slideRe = /\\slide\{(.*?)\}\{([0-9_.]+)\}\{(.*?)\}\{(.*?)\}(\s*%[^\n]*)?/g;
    const slides = [];
    let m;
    while ((m = slideRe.exec(content)) !== null) {
      slides.push([m[1], m[2], m[3], m[4], m[5] || '']);
    }

    if (!slides.length) {
      log('   └── ⚠️ Warning: No slide entries found.');
      continue;
    }

    const { rows: currentCsvRows, path: csvSourcePath, error: csvError } =
      await loadSessionCsv(vfs, texFileIdPart);
    if (csvError) {
      log(`   └── ⚠️ Failed to read CSV for data extraction: ${csvError}`);
    } else if (currentCsvRows) {
      log(`   └── 💾 Loaded data from: ${csvSourcePath.split('/').pop()}`);
    }

    const xmlLookupPath = `xml/${baseFilename}.xml`;
    let xmlRoot = null;
    if (await vfs.exists(xmlLookupPath)) {
      try {
        xmlRoot = parseXmlRoot(await vfs.readText(xmlLookupPath));
      } catch (e) {
        log(`   └── ⚠️ Warning: Failed to parse XML for exclusion: ${e}`);
      }
    }

    const excludedFromMainTex = slideIdsExcludedFromMainTexXml(xmlRoot);
    for (const k of slideIdsExcludedFromMainTex(currentCsvRows)) excludedFromMainTex.add(k);
    if (excludedFromMainTex.size) {
      log(`   └── 🚫 Excluding ${excludedFromMainTex.size} slide ids from main tex slideinput list`);
    }

    const docClassMatch = /\\documentclass\[.*?\]\{nagwa\}/.exec(content);
    const headerDocClass = docClassMatch ? docClassMatch[0] : '';

    const metaKeys = [
      /\\metasessionID\{.*?\}/,
      /\\sessioncountry\{.*?\}/,
      /\\subject\{.*?\}/,
      /\\languageofinstruction\{.*?\}/,
      /\\grade\{.*?\}/,
      /\\term\{.*?\}/,
      /\\sessiontitle\{.*?\}/,
    ];

    let headerMetadata = '';
    for (const key of metaKeys) {
      const km = key.exec(content);
      if (km) headerMetadata += `    ${km[0]}\n`;
    }

    try {
      const mainTexOutputPath = `${sessionFolderPath}/${filename}`;
      let mainBody = `${headerDocClass}\n\n\\begin{document}\n${headerMetadata}\n`;
      for (const slideTuple of slides) {
        const slideId = slideTuple[1];
        if (isExcludedSlideId(slideId, excludedFromMainTex)) continue;
        const slideComment = (slideTuple[4] || '').trim();
        mainBody += `\\slideinput{${slideId}}${slideComment ? ` ${slideComment}` : ''}\n`;
      }
      mainBody += '\n\\end{document}';
      await vfs.writeText(mainTexOutputPath, mainBody);
      log(`   └── ✅ Generated modified main file: ${filename}`);
    } catch (e) {
      log(`   └── ❌ Error generating main file: ${e}`);
    }

    let sessionNum = '';
    try {
      if (xmlRoot) {
        const metasessionNumber = xmlRoot.getAttribute('metasession_number');
        if (metasessionNumber) {
          sessionNum = String(metasessionNumber).trim();
          log(`   └── 📊 Found Session Number from XML: ${sessionNum}`);
        } else {
          log(`   └── ⚠️ Warning: 'metasession_number' attribute missing in ${baseFilename}.xml.`);
        }
      } else if (await vfs.exists(xmlLookupPath)) {
        log(`   └── ⚠️ Warning: XML file could not be loaded from '${xmlLookupPath}'.`);
      } else {
        log(`   └── ⚠️ Warning: XML file not found at '${xmlLookupPath}'.`);
      }
    } catch (e) {
      log(`   └── ⚠️ Failed to read session number from XML: ${e}`);
    }

    const sessionXmlPath = `${sessionFolderPath}/${baseFilename}.xml`;
    if (await vfs.exists(xmlLookupPath)) {
      await copyFile(vfs, xmlLookupPath, sessionXmlPath);
      log(`   └── 📄 Copied XML to ${baseFilename}.xml`);
    } else {
      log(`   └── ⚠️ Warning: XML file not found at '${xmlLookupPath}'.`);
    }

    if (csvSourcePath && (await vfs.exists(csvSourcePath))) {
      const csvDestName = csvSourcePath.split('/').pop();
      await copyFile(vfs, csvSourcePath, `${sessionFolderPath}/${csvDestName}`);
      log(`   └── 📄 Copied CSV to ${csvDestName}`);
    } else {
      log('   └── ⚠️ Warning: Session CSV not found for copying into files/ folder.');
    }

    const mainTexPath = `${sessionFolderPath}/${filename}`;
    if (!(await vfs.exists(mainTexPath))) {
      log(`   └── ❌ Main session .tex missing at ${mainTexPath}`);
    }
    if (!(await vfs.exists(sessionXmlPath))) {
      log(`   └── ❌ Session .xml missing at ${sessionXmlPath}`);
    }

    const createdFolders = new Set();

    for (let i = 0; i < slides.length; i += 1) {
      const slideTuple = slides[i];
      const slideId = slideTuple[1];
      const slideTitleRaw = slideTuple[2];
      const slideType = slideTuple[3];
      const slideComment = (slideTuple[4] || '').trim();
      const slideFolderPath = `${sessionFolderPath}/${slideId}`;

      if (shouldSkipSlideFolder(slideId, slideType, excludedFromMainTex)) {
        if (await vfs.exists(slideFolderPath)) {
          await removeDirRecursive(vfs, slideFolderPath);
        }
        continue;
      }

      if (!createdFolders.has(slideId)) {
        await vfs.mkdir(slideFolderPath, { recursive: true });
        createdFolders.add(slideId);
      }

      if (
        currentCsvRows &&
        currentCsvRows.some((r) => 'slide_id' in r) &&
        currentCsvRows.some((r) => 'slide_purpose' in r)
      ) {
        const sidStr = String(slideId);
        let row = currentCsvRows.find((r) => csvCellStr(r.slide_id) === sidStr);
        if (!row && currentCsvRows.some((r) => 'question_id' in r)) {
          row = currentCsvRows.find((r) => csvCellStr(r.question_id) === sidStr);
        }
        if (row) {
          const purposeContent = csvCellStr(row.slide_purpose);
          if (purposeContent) {
            const txtPath = `${slideFolderPath}/${slideId}_purpose.txt`;
            try {
              await vfs.writeText(txtPath, purposeContent);
            } catch (e) {
              log(`       ⚠️ Could not write purpose file: ${e}`);
            }
          }
        }
      }

      let innerTexContent = null;

      if (i === 0) {
        let effectiveSessionNum = sessionNum;
        if (isArabic && sessionNum in ARABIC_SESSION_NUMBERS) {
          effectiveSessionNum = ARABIC_SESSION_NUMBERS[sessionNum];
        }
        innerTexContent =
          `    \\SessionNumber{${effectiveSessionNum}}\n` +
          '    %\n' +
          `    \\SessionTitle{${title}}\n` +
          '    %\n' +
          `    \\SessionSubject{${subject}}`;
      } else if (i === slides.length - 1) {
        innerTexContent = `    ${THANK_YOU_MESSAGES[language] || THANK_YOU_MESSAGES.en}`;
      } else if (slideType === 'image' || slideType === 'toc') {
        innerTexContent = '    session';
      }

      if (innerTexContent !== null) {
        let finalTexContent = `${headerDocClass}\n\n\\begin{document}\n`;
        if (slideComment) finalTexContent += `    ${slideComment}\n`;
        finalTexContent += headerMetadata;

        if (i === 0 || i === slides.length - 1) {
          finalTexContent += `\n${innerTexContent}\n`;
        } else {
          finalTexContent +=
            `    \\slidestandalone{${slideTitleRaw}}{\n` +
            `    ${innerTexContent}\n` +
            '    }\n';
        }

        finalTexContent += '\\end{document}';
        await vfs.writeText(`${slideFolderPath}/${slideId}.tex`, finalTexContent);
      }
    }

    const removedOrphans = await cleanupOrphanSlideFolders(vfs, sessionFolderPath, createdFolders);
    if (removedOrphans) {
      log(`   └── 🧹 Removed ${removedOrphans} stale slide folder(s)`);
    }

    if (createdFolders.size) {
      let xmlDirEntries = [];
      if (await vfs.exists('xml')) {
        xmlDirEntries = await vfs.listDir('xml');
      }
      for (const jsonName of xmlDirEntries) {
        if (!jsonName.toLowerCase().endsWith('_verbatim.json')) continue;
        const slideIdMatch = jsonName.slice(0, -'_verbatim.json'.length);
        if (!createdFolders.has(slideIdMatch)) continue;
        const jsonPath = `xml/${jsonName}`;
        try {
          await copyFile(vfs, jsonPath, `${sessionFolderPath}/${slideIdMatch}/${jsonName}`);
        } catch {
          /* ignore copy failures */
        }
      }
    }
  }

  log('\n🎉 Script finished.');
  return { ok: true };
}
