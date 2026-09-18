import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

export class ChatStore {
  constructor(directory) { this.directory = directory; }
  path(userId) { return join(this.directory, createHash('sha256').update(userId).digest('hex') + '.json'); }
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
