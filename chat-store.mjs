import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

export class ChatStore {
  constructor(directory) { this.directory = directory; }
  path(userId) { return join(this.directory, createHash('sha256').update(userId).digest('hex') + '.json'); }
  detailsPath(userId, id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid tool details ID.');
    return join(this.directory, 'tool-details', createHash('sha256').update(userId).digest('hex'), id + '.json');
  }
  async saveDetails(userId, details) {
    const id = randomUUID(); const path = this.detailsPath(userId, id);
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(details), { mode: 0o600, flag: 'wx' });
    return id;
  }
  async loadDetails(userId, id) {
    try { return JSON.parse(await readFile(this.detailsPath(userId, id), 'utf8')); }
    catch { throw new Error('These tool details are unavailable. The saved conversation is unchanged.'); }
  }
  async load(userId) {
    try { return JSON.parse(await readFile(this.path(userId), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Your chats could not be loaded. No saved data was overwritten.'); return { version: 1, threads: [] }; }
  }
  async save(userId, data) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = this.path(userId); const temporary = destination + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
    await rename(temporary, destination);
  }
}
