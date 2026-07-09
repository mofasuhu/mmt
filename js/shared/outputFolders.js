/** Pipeline output folders and step-aware cleanup — port of run_all.py helpers. */

export const OUTPUT_FOLDERS_BY_STEP = [
  [1, 'sessions'],
  [2, 'csvs'],
  [3, 'xml'],
  [5, 'tex'],
  [6, 'files'],
  [7, 'CLS'],
];

/**
 * Remove in-memory output folders that will be recreated from startStep onward.
 * @param {import('../io/virtualFs.js').VirtualFs} vfs
 * @param {number} startStep
 * @param {(msg: string) => void} [log]
 */
export async function cleanupOutputFolders(vfs, startStep, log) {
  const keep = new Set(
    OUTPUT_FOLDERS_BY_STEP.filter(([step]) => step < startStep).map(([, folder]) => folder),
  );
  const removed = [];
  for (const [, folder] of OUTPUT_FOLDERS_BY_STEP) {
    if (keep.has(folder)) continue;
    if (await vfs.exists(folder)) {
      await vfs.remove(folder, { recursive: true });
      removed.push(folder);
    }
  }
  if (removed.length && log) {
    log(`\n🧹 Cleared output folder(s): ${removed.join(', ')}`);
  }
  if (keep.size && log) {
    log(`   Kept from previous run: ${[...keep].sort().join(', ')}`);
  }
}
