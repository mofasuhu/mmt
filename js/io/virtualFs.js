/**
 * In-memory virtual filesystem mirroring the Python project layout.
 */

function normalizePath(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
}

function joinPath(...parts) {
  return normalizePath(parts.filter(Boolean).join('/'));
}

function parentDir(p) {
  const n = normalizePath(p);
  const i = n.lastIndexOf('/');
  return i >= 0 ? n.slice(0, i) : '';
}

function baseName(p) {
  const n = normalizePath(p);
  const i = n.lastIndexOf('/');
  return i >= 0 ? n.slice(i + 1) : n;
}

export class VirtualFs {
  constructor() {
    /** @type {Map<string, Uint8Array>} */
    this.files = new Map();
    /** @type {Map<string, import('./fsAccess.js').MountedDir>} */
    this.mounts = new Map();
  }

  clear() {
    this.files.clear();
  }

  mount(prefix, mountedDir) {
    this.mounts.set(normalizePath(prefix), mountedDir);
  }

  unmount(prefix) {
    this.mounts.delete(normalizePath(prefix));
  }

  async _resolveMount(path) {
    const n = normalizePath(path);
    for (const [prefix, mount] of this.mounts) {
      if (n === prefix || n.startsWith(`${prefix}/`)) {
        const rel = n === prefix ? '' : n.slice(prefix.length + 1);
        return { mount, rel };
      }
    }
    return null;
  }

  _isDirPath(path) {
    const n = normalizePath(path);
    if (this.files.has(n)) return false;
    const prefix = `${n}/`;
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  async exists(path) {
    const n = normalizePath(path);
    const m = await this._resolveMount(n);
    if (m) return m.mount.exists(m.rel);
    return this.files.has(n) || this._isDirPath(n);
  }

  async isDir(path) {
    const n = normalizePath(path);
    const m = await this._resolveMount(n);
    if (m) return m.mount.isDir(m.rel);
    if (this.files.has(n)) return false;
    return this._isDirPath(n);
  }

  async isFile(path) {
    const n = normalizePath(path);
    const m = await this._resolveMount(n);
    if (m) return m.mount.isFile(m.rel);
    return this.files.has(n);
  }

  /**
   * @param {string} path
   * @returns {Promise<{ size: number, isFile: boolean, isDir: boolean } | null>}
   */
  async stat(path) {
    const n = normalizePath(path);
    const m = await this._resolveMount(n);
    if (m) {
      if (typeof m.mount.stat === 'function') {
        return m.mount.stat(m.rel);
      }
      if (await m.mount.isFile(m.rel)) {
        const bytes = await m.mount.readBytes(m.rel);
        return { size: bytes.byteLength, isFile: true, isDir: false };
      }
      if (await m.mount.isDir(m.rel)) {
        return { size: 0, isFile: false, isDir: true };
      }
      return null;
    }

    const data = this.files.get(n);
    if (data) {
      return { size: data.byteLength, isFile: true, isDir: false };
    }
    if (this._isDirPath(n)) {
      return { size: 0, isFile: false, isDir: true };
    }
    return null;
  }

  async mkdir(path, { recursive = false } = {}) {
    const n = normalizePath(path);
    const m = await this._resolveMount(n);
    if (m) return m.mount.mkdir(m.rel, { recursive });
    if (!recursive && !(await this.exists(parentDir(n))) && parentDir(n)) {
      throw new Error(`Parent missing: ${parentDir(n)}`);
    }
    if (!this.files.has(n) && !this._isDirPath(n)) {
      this.files.set(`${n}/.keep`, new Uint8Array());
    }
  }

  async read(path, opts = {}) {
    if (opts.binary) return this.readBytes(path);
    return this.readText(path);
  }

  async readText(path) {
    const bytes = await this.readBytes(path);
    return new TextDecoder('utf-8').decode(bytes);
  }

  async readBytes(path) {
    const n = normalizePath(path);
    const m = await this._resolveMount(n);
    if (m) return m.mount.readBytes(m.rel);
    const data = this.files.get(n);
    if (!data) throw new Error(`File not found: ${n}`);
    return data;
  }

  async write(path, content) {
    if (typeof content === 'string') return this.writeText(path, content);
    return this.writeBytes(path, content);
  }

  async writeText(path, text) {
    const enc = new TextEncoder();
    await this.writeBytes(path, enc.encode(text));
  }

  async writeBytes(path, bytes) {
    const n = normalizePath(path);
    const m = await this._resolveMount(n);
    if (m) return m.mount.writeBytes(m.rel, bytes);
    const dir = parentDir(n);
    if (dir) await this.mkdir(dir, { recursive: true });
    this.files.set(n, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  }

  async remove(path, { recursive = false } = {}) {
    const n = normalizePath(path);
    const m = await this._resolveMount(n);
    if (m) return m.mount.remove(m.rel, { recursive });

    if (this.files.has(n)) {
      this.files.delete(n);
      return;
    }
    if (!recursive) {
      const prefix = `${n}/`;
      for (const key of [...this.files.keys()]) {
        if (key.startsWith(prefix)) throw new Error(`Directory not empty: ${n}`);
      }
      return;
    }
    const prefix = `${n}/`;
    for (const key of [...this.files.keys()]) {
      if (key === n || key.startsWith(prefix)) this.files.delete(key);
    }
  }

  async removeDir(path) {
    return this.remove(path, { recursive: true });
  }

  async rename(oldPath, newPath) {
    const o = normalizePath(oldPath);
    const n = normalizePath(newPath);
    const mOld = await this._resolveMount(o);
    const mNew = await this._resolveMount(n);
    if (mOld || mNew) {
      if (mOld?.mount === mNew?.mount) {
        return mOld.mount.rename(mOld.rel, mNew?.rel ?? n);
      }
      throw new Error('Cross-mount rename not supported');
    }

    if (await this.isFile(o)) {
      const data = await this.readBytes(o);
      await this.writeBytes(n, data);
      await this.remove(o);
      return;
    }

    if (await this.isDir(o)) {
      const prefix = `${o}/`;
      const entries = [...this.files.keys()].filter((k) => k.startsWith(prefix));
      for (const key of entries) {
        const rel = key.slice(prefix.length);
        const data = this.files.get(key);
        this.files.delete(key);
        await this.writeBytes(joinPath(n, rel), data);
      }
      return;
    }
    throw new Error(`Rename source not found: ${o}`);
  }

  async list(path) {
    const names = await this.listDir(path);
    return names;
  }

  async listDir(path) {
    const n = normalizePath(path);
    const m = await this._resolveMount(n);
    if (m) return m.mount.listDir(m.rel);

    const prefix = n ? `${n}/` : '';
    const names = new Set();
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf('/');
      names.add(slash >= 0 ? rest.slice(0, slash) : rest);
    }
    return [...names].sort();
  }

  async copyFile(src, dest) {
    const bytes = await this.readBytes(src);
    await this.writeBytes(dest, bytes);
  }

  async copyTree(src, dest, { merge = false } = {}) {
    const s = normalizePath(src);
    const d = normalizePath(dest);
    const mSrc = await this._resolveMount(s);
    const mDst = await this._resolveMount(d);

    if (mSrc) {
      await this.mkdir(d, { recursive: true });
      await mSrc.mount.copyTreeTo(mDst ? mDst.mount : this, mDst?.rel ?? d, mSrc.rel, { merge });
      return;
    }

    if (await this.isFile(s)) {
      await this.writeBytes(d, await this.readBytes(s));
      return;
    }

    await this.mkdir(d, { recursive: true });
    for (const name of await this.listDir(s)) {
      await this.copyTree(joinPath(s, name), joinPath(d, name), { merge });
    }
  }

  /** Enumerate all in-memory file paths (not mounts). */
  allPaths() {
    return [...this.files.keys()].sort();
  }

  /**
   * Simple glob: `dir/*.ext` or `prefix*suffix` against in-memory files.
   * @param {string} pattern
   */
  async glob(pattern) {
    const p = normalizePath(pattern);
    const slash = p.lastIndexOf('/');
    const dir = slash >= 0 ? p.slice(0, slash) : '';
    const filePat = slash >= 0 ? p.slice(slash + 1) : p;

    const re = new RegExp(
      `^${filePat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
    );

    const names = new Set();
    for (const path of this.files.keys()) {
      if (path.endsWith('/.keep')) continue;
      if (dir && !path.startsWith(`${dir}/`)) continue;
      const base = dir ? path.slice(dir.length + 1) : path;
      if (re.test(base)) names.add(path);
    }
    return [...names].sort();
  }
}

export function createVirtualFs() {
  return new VirtualFs();
}
