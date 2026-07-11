/**
 * Read-only directory mount backed by the local dev server's /fs API.
 */

function normalizePath(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
}

export class ServerMountedDir {
  /**
   * @param {'slides'} mountName
   * @param {string} label
   * @param {string} [apiBase] - optional origin for /fs API (e.g. CORS worker /archive route)
   */
  constructor(mountName, label, apiBase = '') {
    this.mountName = mountName;
    this.label = label;
    this.apiBase = String(apiBase || '').replace(/\/$/, '');
    this.readOnly = true;
  }

  _fsPrefix() {
    return this.apiBase
      ? `${this.apiBase}/fs/${this.mountName}`
      : `/fs/${this.mountName}`;
  }

  async _fetchJson(action, relPath = '') {
    const path = normalizePath(relPath);
    const q = path ? `?path=${encodeURIComponent(path)}` : '';
    const res = await fetch(`${this._fsPrefix()}/${action}${q}`);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text || `FS ${action} failed (${res.status})`);
    }
    return res.json();
  }

  async exists(relPath) {
    const data = await this._fetchJson('stat', relPath);
    return Boolean(data.exists);
  }

  async isFile(relPath) {
    const data = await this._fetchJson('stat', relPath);
    return Boolean(data.isFile);
  }

  async isDir(relPath) {
    const data = await this._fetchJson('stat', relPath);
    return Boolean(data.isDir);
  }

  async mkdir() {
    throw new Error('Server-mounted archive is read-only');
  }

  async readBytes(relPath) {
    const path = normalizePath(relPath);
    const q = path ? `?path=${encodeURIComponent(path)}` : '';
    const res = await fetch(`${this._fsPrefix()}/read${q}`);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text || `FS read failed (${res.status})`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  async writeBytes() {
    throw new Error('Server-mounted archive is read-only');
  }

  async remove() {
    throw new Error('Server-mounted archive is read-only');
  }

  async rename() {
    throw new Error('Server-mounted archive is read-only');
  }

  async listDir(relPath = '') {
    const data = await this._fetchJson('list', relPath);
    return Array.isArray(data.names) ? data.names : [];
  }

  async copyTreeTo(targetMount, destRel, srcRel, { merge = false } = {}) {
    const srcBase = normalizePath(srcRel);
    const destBase = normalizePath(destRel);

    if (!merge && destBase) {
      await targetMount.mkdir(destBase, { recursive: true });
    }

    async function walk(mount, rel, destPath) {
      for (const name of await mount.listDir(rel)) {
        const childRel = rel ? `${rel}/${name}` : name;
        const childDest = destPath ? `${destPath}/${name}` : name;
        if (await mount.isFile(childRel)) {
          const bytes = await mount.readBytes(childRel);
          await targetMount.writeBytes(childDest.replace(/\/+/g, '/'), bytes);
        } else if (await mount.isDir(childRel)) {
          await targetMount.mkdir(childDest.replace(/\/+/g, '/'), { recursive: true });
          await walk(mount, childRel, childDest);
        }
      }
    }

    await walk(this, srcBase, destBase);
  }
}
