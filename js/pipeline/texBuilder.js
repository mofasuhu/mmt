/**
 * Port of tex_builder.py — build session .tex files from XML + CSV lookups.
 */
import {
  csvCellStr,
  findCsvForMetasession,
  loadSessionRows,
  buildRowLookups,
  buildRowsByLookupId,
  createOccurrenceRowLookup,
  getNumeralsFromRows,
  resolveSlideId,
  texTypeFromRow,
  slideTitleFromRow,
  slideNumberFromRow,
  xmlRoleFromSlideElement,
} from '../shared/sessionCsv.js';

/**
 * @param {string} xmlString
 * @param {string} xmlFilenameStem
 * @param {import('../io/virtualFs.js').VirtualFs} vfs
 * @returns {Promise<string>}
 */
export async function buildTexFromXml(xmlString, xmlFilenameStem, vfs) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'application/xml');
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    return `Error parsing XML: ${parseError.textContent || 'unknown parse error'}`;
  }

  const root = doc.documentElement;
  const metasessionId = xmlFilenameStem.split('_')[0];
  const csvPath = await findCsvForMetasession(metasessionId, vfs, 'csvs');

  let csvRows = [];
  let lookupRow = () => null;
  if (csvPath) {
    csvRows = await loadSessionRows(vfs, csvPath);
    const rowById = buildRowLookups(csvRows);
    const rowsById = buildRowsByLookupId(csvRows);
    lookupRow = createOccurrenceRowLookup(rowsById, rowById);
  }

  const metaAttrs = root.attributes;
  const lang = metaAttrs.getNamedItem('language')?.value || 'en';
  const numerals = csvRows.length ? getNumeralsFromRows(csvRows) : 'european';

  let direction = 'ltr';
  if (numerals === 'arabic') {
    direction = 'rtl';
  }

  const gradeStr = metaAttrs.getNamedItem('grade')?.value || '0';
  let gradeVal = parseInt(gradeStr, 10);
  if (Number.isNaN(gradeVal)) gradeVal = 0;
  const nagwaGrade = gradeVal < 4 ? 'low' : 'high';

  const texParts = [
    '% !TeX program = lualatex --interaction=nonstopmode -synctex=1 -include-directory=./CLS %.tex | txs:///view',
    `\\documentclass[Session_Slide, nagwalang = ${lang}, numerals = ${numerals}, directions = ${direction}, nagwagrade = ${nagwaGrade}]{nagwa}\n`,
    '\\begin{document}',
  ];

  const metadataMap = {
    metasession_id: 'metasessionID',
    country: 'sessioncountry',
    subject: 'subject',
    language: 'languageofinstruction',
    grade: 'grade',
    term: 'term',
  };

  for (const [xmlKey, texCmd] of Object.entries(metadataMap)) {
    const attr = metaAttrs.getNamedItem(xmlKey);
    if (attr) {
      let value = attr.value;
      if (xmlKey === 'grade' && /^\d$/.test(value)) {
        value = `0${value}`;
      }
      texParts.push(`    \\${texCmd}{${value}}`);
    }
  }

  const sessionTitleEl = root.querySelector(':scope > metasession_title');
  if (sessionTitleEl?.textContent?.trim()) {
    texParts.push(`    \\sessiontitle{${sessionTitleEl.textContent.trim()}}`);
  }

  texParts.push('');

  function formatSlide(element, row = undefined) {
    if (row === undefined) {
      row = lookupRow(element);
    }
    const xmlType = xmlRoleFromSlideElement(element);
    const slideIdVal = csvCellStr(element.getAttribute('slide_id'));
    const questionIdVal = csvCellStr(element.getAttribute('question_id'));

    let slideId;
    let slideNumber;
    let slideType;
    let slideTitle;

    if (row) {
      if (element.getAttribute('slide_category') === 'question') {
        slideId = slideIdVal || questionIdVal;
      } else {
        slideId = resolveSlideId(row);
      }
      slideNumber = slideNumberFromRow(row, element.getAttribute('slide_number'));
      slideType = texTypeFromRow(row, xmlType);
      slideTitle = slideTitleFromRow(row, element.getAttribute('slide_title'));
    } else {
      slideId = slideIdVal || questionIdVal;
      slideNumber = csvCellStr(element.getAttribute('slide_number')) || '0';
      slideType = texTypeFromRow(null, xmlType);
      slideTitle = csvCellStr(element.getAttribute('slide_title')) || 'Question';
    }

    if (lang === 'ar') {
      if (slideTitle === 'Example') slideTitle = 'مثال';
      else if (slideTitle === 'Question') slideTitle = 'سؤال';
    }

    const formattedNumber = String(parseInt(slideNumber, 10)).padStart(3, '0');
    let line = `\\slide{${formattedNumber}}{${slideId}}{${slideTitle}}{${slideType}}`;
    let csvSn = row ? csvCellStr(row.slide_number) : '';
    if (!csvSn) csvSn = csvCellStr(element.getAttribute('slide_number'));
    if (csvSn) line += ` %${csvSn}`;
    return line;
  }

  function processCheckpoint(checkpointEl, indent) {
    const rc = csvCellStr(checkpointEl.getAttribute('required_correct')) || '0';
    const aw = csvCellStr(checkpointEl.getAttribute('attempt_window')) || '0';
    return [
      `${indent}\\begin{checkpoint}{${rc}}{${aw}}`,
      `${indent}\\end{checkpoint}`,
    ];
  }

  function processSectionElement(sectionElement, indent = '    ') {
    const lines = [];
    const sectionId = sectionElement.getAttribute('section_id') || '';
    const sectionTitleEl = sectionElement.querySelector(':scope > section_title');
    const sectionTitle =
      sectionTitleEl?.textContent?.trim() ? sectionTitleEl.textContent.trim() : '';
    lines.push(`${indent}\\begin{section}{${sectionId}}{${sectionTitle}}`);

    for (const sub of sectionElement.children) {
      if (sub.tagName === 'section_title') continue;
      if (sub.tagName === 'checkpoint') {
        lines.push(...processCheckpoint(sub, indent + '    '));
      } else if (sub.tagName === 'slide') {
        lines.push(`${indent}    ${formatSlide(sub)}`);
      }
    }

    lines.push(`${indent}\\end{section}`);
    return lines;
  }

  for (const element of root.children) {
    if (element.tagName === 'metasession_title') continue;

    if (element.tagName === 'slide') {
      if (!element.getAttribute('slide_number')) continue;
      const row = lookupRow(element);
      const texType = texTypeFromRow(row, xmlRoleFromSlideElement(element));
      if (texType === 'toc') {
        texParts.push('    \\begin{toc}');
        texParts.push(`        ${formatSlide(element, row)}`);
        texParts.push('    \\end{toc}');
      } else {
        texParts.push(`    ${formatSlide(element, row)}`);
      }
    } else if (element.tagName === 'section') {
      texParts.push(...processSectionElement(element));
    } else if (element.tagName === 'section_group') {
      const groupTitleEl = element.querySelector(':scope > section_group_title');
      if (groupTitleEl?.textContent?.trim()) {
        texParts.push(`    \\begin{sectiongroup}{${groupTitleEl.textContent.trim()}}`);
      } else {
        texParts.push('    \\begin{sectiongroup}');
      }

      for (const child of element.children) {
        if (child.tagName === 'section_group_title') continue;
        if (child.tagName === 'section') {
          texParts.push(...processSectionElement(child, '        '));
        } else if (child.tagName === 'slide') {
          texParts.push(`        ${formatSlide(child)}`);
        } else if (child.tagName === 'checkpoint') {
          texParts.push(...processCheckpoint(child, '        '));
        }
      }

      texParts.push('    \\end{sectiongroup}');
    }
  }

  texParts.push('\\end{document}');
  return texParts.join('\n');
}

/**
 * @param {object} ctx
 * @param {import('../io/virtualFs.js').VirtualFs} ctx.vfs
 * @param {(msg: string) => void} ctx.log
 */
export async function runTexBuilder(ctx) {
  const { vfs, log } = ctx;

  log("Output directory will be: 'tex/'");

  const xmlPaths = (await vfs.glob('xml/*.xml')).sort();
  if (!xmlPaths.length) {
    throw new Error("No XML files found in 'xml/'.");
  }

  if (!(await vfs.exists('csvs'))) {
    log("\n[Warning] 'csvs' directory not found.");
  }

  log(`\nFound ${xmlPaths.length} XML file(s) to process...`);

  let successCount = 0;
  let failureCount = 0;

  for (const xmlPath of xmlPaths) {
    const name = xmlPath.split('/').pop();
    log(`Processing '${name}'...`);
    try {
      const xmlString = await vfs.readText(xmlPath);
      const stem = name.replace(/\.xml$/i, '');
      const texContent = await buildTexFromXml(xmlString, stem, vfs);

      if (texContent.startsWith('Error')) {
        log(`  -> Failed: ${texContent}`);
        failureCount += 1;
        continue;
      }

      const outputPath = `tex/${stem}.tex`;
      await vfs.writeText(outputPath, texContent);
      log(`  -> Success: Created '${outputPath}'`);
      successCount += 1;
    } catch (e) {
      log(`  -> An unexpected error occurred: ${e}`);
      failureCount += 1;
    }
  }

  log(`\nProcessing complete. ${successCount} succeeded, ${failureCount} failed.`);
  if (failureCount > 0) {
    throw new Error(
      'One or more sessions failed TeX build. Fix the issue and rerun the full pipeline.',
    );
  }
}
