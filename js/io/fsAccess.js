/**
 * File System Access API helpers for reading/writing local directories.
 */

const WINDOWS_RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/**
 * Make a single path segment safe for getFileHandle / getDirectoryHandle on all OSes.
 * Bilingual merged PPTX names use ``|`` in-memory; on disk we use `` __ ``.
 * @param {string} name
 * @returns {string}
 */
export function sanitizePathSegmentForFileSystem(name) {
  let s = String(name ?? '').replace(/[\x00-\x1f\x7f]/g, '');
  s = s.replace(/\s*\|\s*/g, ' __ ');
  s = s.replace(/[<>:"/\\|?*]/g, '_');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/[. ]+$/g, '');
  if (!s || s === '.' || s === '..') return '_';
  if (WINDOWS_RESERVED_NAMES.has(s.toLowerCase())) s = `_${s}`;
  if (s.length > 240) s = s.slice(0, 240);
  return s;
}

function normalizePath(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
}

function sanitizeRelativePath(relPath) {
  const parts = normalizePath(relPath).split('/').filter(Boolean);
  return parts.map(sanitizePathSegmentForFileSystem).join('/');
}

async function getDirHandle(root, relPath, { create = false } = {}) {
  if (!relPath) return root;
  const parts = sanitizeRelativePath(relPath).split('/').filter(Boolean);
  let cur = root;
  for (const part of parts) {
    cur = await cur.getDirectoryHandle(part, { create });
  }
  return cur;
}

async function getFileHandle(root, relPath, { create = false } = {}) {
  const n = sanitizeRelativePath(relPath);
  const slash = n.lastIndexOf('/');
  const dir = slash >= 0 ? n.slice(0, slash) : '';
  const name = slash >= 0 ? n.slice(slash + 1) : n;
  const dirHandle = await getDirHandle(root, dir, { create });
  return dirHandle.getFileHandle(name, { create });
}

export class MountedDir {
  /**
   * @param {FileSystemDirectoryHandle} handle
   * @param {string} [label]
   */
  constructor(handle, label = '') {
    this.handle = handle;
    this.label = label || handle.name;
  }

  async exists(relPath) {
    try {
      const n = sanitizeRelativePath(relPath);
      if (!n) return true;
      const slash = n.lastIndexOf('/');
      const dir = slash >= 0 ? n.slice(0, slash) : '';
      const name = slash >= 0 ? n.slice(slash + 1) : n;
      const dirHandle = await getDirHandle(this.handle, dir);
      try {
        await dirHandle.getFileHandle(name);
        return true;
      } catch {
        await dirHandle.getDirectoryHandle(name);
        return true;
      }
    } catch {
      return false;
    }
  }

  async isFile(relPath) {
    try {
      const n = sanitizeRelativePath(relPath);
      const slash = n.lastIndexOf('/');
      const dir = slash >= 0 ? n.slice(0, slash) : '';
      const name = slash >= 0 ? n.slice(slash + 1) : n;
      const dirHandle = await getDirHandle(this.handle, dir);
      await dirHandle.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  }

  async isDir(relPath) {
    try {
      const n = sanitizeRelativePath(relPath);
      if (!n) return true;
      const slash = n.lastIndexOf('/');
      const dir = slash >= 0 ? n.slice(0, slash) : '';
      const name = slash >= 0 ? n.slice(slash + 1) : n;
      const dirHandle = await getDirHandle(this.handle, dir);
      await dirHandle.getDirectoryHandle(name);
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(relPath, { recursive = false } = {}) {
    await getDirHandle(this.handle, relPath, { create: recursive || true });
  }

  async readBytes(relPath) {
    const fh = await getFileHandle(this.handle, relPath);
    const file = await fh.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async writeBytes(relPath, bytes) {
    const fh = await getFileHandle(this.handle, relPath, { create: true });
    const w = await fh.createWritable();
    await w.write(bytes);
    await w.close();
  }

  async remove(relPath, { recursive = false } = {}) {
    const n = sanitizeRelativePath(relPath);
    const slash = n.lastIndexOf('/');
    const parentPath = slash >= 0 ? n.slice(0, slash) : '';
    const name = slash >= 0 ? n.slice(slash + 1) : n;
    const parent = await getDirHandle(this.handle, parentPath);
    await parent.removeEntry(name, { recursive });
  }

  async rename(relOld, relNew) {
    const data = await this.readBytes(relOld);
    await this.writeBytes(relNew, data);
    await this.remove(relOld, { recursive: await this.isDir(relOld) });
  }

  async listDir(relPath = '') {
    const dir = await getDirHandle(this.handle, relPath);
    const names = [];
    // eslint-disable-next-line no-restricted-syntax
    for await (const [name] of dir.entries()) {
      names.push(name);
    }
    return names.sort();
  }

  async copyTreeTo(targetMount, destRel, srcRel, { merge = false } = {}) {
    const srcDir = await getDirHandle(this.handle, normalizePath(srcRel));
    const destIsMounted = targetMount instanceof MountedDir;
    const destRoot = destIsMounted ? targetMount.handle : null;
    const destBase = normalizePath(destRel);

    async function walk(src, destPath) {
      // eslint-disable-next-line no-restricted-syntax
      for await (const [name, handle] of src.entries()) {
        const childDest = destPath ? `${destPath}/${name}` : name;
        if (handle.kind === 'file') {
          const file = await handle.getFile();
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (destIsMounted) {
            await targetMount.writeBytes(`${destBase}/${childDest}`.replace(/\/+/g, '/'), bytes);
          } else {
            await targetMount.writeBytes(childDest, bytes);
          }
        } else {
          if (destIsMounted) {
            await targetMount.mkdir(`${destBase}/${childDest}`.replace(/\/+/g, '/'), { recursive: true });
            await walk(handle, childDest);
          } else {
            await targetMount.mkdir(childDest, { recursive: true });
            const nested = new MountedDir(handle);
            await nested.copyTreeTo(targetMount, childDest, '', { merge });
          }
        }
      }
    }

    if (destIsMounted) {
      if (!merge) await targetMount.mkdir(destBase, { recursive: true });
      await walk(srcDir, '');
    } else {
      if (!merge) await targetMount.mkdir(destBase, { recursive: true });
      await walk(srcDir, destBase);
    }
  }
}

/**
 * Read-only directory backed by files collected from drag-and-drop.
 */
export class DroppedDir {
  /**
   * @param {string} label
   */
  constructor(label = 'dropped') {
    this.label = label;
    this.readOnly = true;
    /** @type {Map<string, Uint8Array>} */
    this.files = new Map();
  }

  /**
   * @param {FileSystemDirectoryEntry} entry
   * @param {string} [basePath]
   */
  async addFromEntry(entry, basePath = '') {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      const path = basePath ? `${basePath}/${entry.name}` : entry.name;
      this.files.set(normalizePath(path), new Uint8Array(await file.arrayBuffer()));
      return;
    }

    if (!entry.isDirectory) return;

    const reader = entry.createReader();
    const readBatch = () => new Promise((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });

    const prefix = basePath ? `${basePath}/${entry.name}` : entry.name;
    let batch;
    do {
      batch = await readBatch();
      for (const child of batch) {
        await this.addFromEntry(child, prefix);
      }
    } while (batch.length > 0);
  }

  _childNames(relPath) {
    const prefix = relPath ? `${normalizePath(relPath)}/` : '';
    const names = new Set();
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf('/');
      names.add(slash >= 0 ? rest.slice(0, slash) : rest);
    }
    return [...names].sort();
  }

  async exists(relPath) {
    const n = normalizePath(relPath);
    if (!n) return true;
    if (this.files.has(n)) return true;
    const prefix = `${n}/`;
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  async isFile(relPath) {
    return this.files.has(normalizePath(relPath));
  }

  async isDir(relPath) {
    const n = normalizePath(relPath);
    if (!n) return true;
    if (this.files.has(n)) return false;
    const prefix = `${n}/`;
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  async mkdir() {
    throw new Error('Dropped folder is read-only');
  }

  async readBytes(relPath) {
    const data = this.files.get(normalizePath(relPath));
    if (!data) throw new Error(`File not found in dropped folder: ${relPath}`);
    return data;
  }

  async writeBytes() {
    throw new Error('Dropped folder is read-only');
  }

  async remove() {
    throw new Error('Dropped folder is read-only');
  }

  async rename() {
    throw new Error('Dropped folder is read-only');
  }

  async listDir(relPath = '') {
    return this._childNames(relPath);
  }

  async copyTreeTo(targetMount, destRel, srcRel, { merge = false } = {}) {
    const srcBase = normalizePath(srcRel);
    const destBase = normalizePath(destRel);
    const srcPrefix = srcBase ? `${srcBase}/` : '';

    if (!merge && destBase) {
      await targetMount.mkdir(destBase, { recursive: true });
    }

    for (const [path, bytes] of this.files) {
      if (srcBase) {
        if (path === srcBase) continue;
        if (!path.startsWith(srcPrefix)) continue;
      }
      const rel = srcBase ? path.slice(srcPrefix.length) : path;
      const destPath = destBase ? `${destBase}/${rel}` : rel;
      await targetMount.writeBytes(destPath.replace(/\/+/g, '/'), bytes);
    }
  }
}

/**
 * Handle a drop event as a directory (FSA handle, or read-only scan).
 * @param {DragEvent} event
 * @param {{ mode?: 'read'|'readwrite', label?: string }} [opts]
 * @returns {Promise<MountedDir|DroppedDir|null>}
 */
export async function directoryFromDrop(event, { mode = 'read', label = 'folder' } = {}) {
  event.preventDefault();
  event.stopPropagation();

  const items = [...(event.dataTransfer?.items || [])];
  if (!items.length) return null;

  for (const item of items) {
    if (typeof item.getAsFileSystemHandle === 'function') {
      const handle = await item.getAsFileSystemHandle();
      if (handle?.kind === 'directory') {
        if (mode === 'readwrite') {
          const perm = await handle.requestPermission({ mode: 'readwrite' });
          if (perm !== 'granted') {
            throw new Error('Write permission denied for dropped folder.');
          }
        }
        return new MountedDir(handle, handle.name || label);
      }
    }
  }

  for (const item of items) {
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) {
      const dropped = new DroppedDir(entry.name || label);
      await dropped.addFromEntry(entry);
      return dropped;
    }
  }

  return null;
}

/**
 * @param {DragEvent} event
 * @returns {Promise<File|null>}
 */
export function fileFromDrop(event) {
  event.preventDefault();
  event.stopPropagation();
  const files = [...(event.dataTransfer?.files || [])];
  return files[0] || null;
}

export function setupDropZone(element, { onDrop, onDragOverClass = 'drag-over' } = {}) {
  if (!element) return;

  const add = () => element.classList.add(onDragOverClass);
  const remove = () => element.classList.remove(onDragOverClass);

  element.addEventListener('dragenter', (e) => {
    e.preventDefault();
    add();
  });
  element.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    add();
  });
  element.addEventListener('dragleave', (e) => {
    if (!element.contains(e.relatedTarget)) remove();
  });
  element.addEventListener('drop', async (e) => {
    remove();
    try {
      await onDrop(e);
    } catch (err) {
      console.error(err);
      throw err;
    }
  });
}

export async function pickDirectory({ mode = 'readwrite', label = 'folder' } = {}) {
  if (!window.showDirectoryPicker) {
    throw new Error('File System Access API is not supported in this browser.');
  }
  const handle = await window.showDirectoryPicker({ mode, id: `mmt-${label}` });
  return new MountedDir(handle, label);
}

/** Remove every entry in a writable directory handle (does not remove the root). */
export async function emptyDirectory(dirHandle) {
  const mount = dirHandle instanceof MountedDir ? dirHandle : new MountedDir(dirHandle, 'output');
  const names = await mount.listDir('');
  for (const name of names) {
    await mount.remove(name, { recursive: true });
  }
}

export async function flushVirtualFsToDirectory(vfs, dirHandle, { onProgress } = {}) {
  const mount = new MountedDir(dirHandle, 'output');
  const paths = vfs.allPaths();
  let i = 0;
  for (const path of paths) {
    if (path.endsWith('/.keep')) continue;
    const data = await vfs.readBytes(path);
    const diskPath = sanitizeRelativePath(path);
    await mount.writeBytes(diskPath, data);
    i += 1;
    if (onProgress) onProgress(i, paths.length, diskPath, path);
  }
}
