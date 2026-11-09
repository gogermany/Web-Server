// A short note for each subdomain, shown in the BackOffice. Kept in one JSON file, apart from the
// nginx files, so changing a note never touches nginx.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DOMAIN, SiteError, parseLabel } from './sites.js';

export const MAX_DESCRIPTION = 200;

export function createDescriptions({ file, domain = DOMAIN }) {
  let queue = Promise.resolve();
  // Writes run one at a time so two edits never overwrite each other
  const serial = (task) => {
    const result = queue.then(task, task);
    queue = result.catch(() => {});
    return result;
  };

  async function read() {
    try {
      const data = JSON.parse(await readFile(file, 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
  }

  async function write(data) {
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`);
    await rename(temp, file);
  }

  const list = read;

  /** Saves the note for a subdomain (an empty text removes it) and returns the name and the saved text */
  function set(input, text) {
    const name = parseLabel(input, domain);
    if (text !== undefined && typeof text !== 'string') throw new SiteError(400, 'The description must be text.');
    // One line of plain text: control characters and line breaks become spaces
    const value = (text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    if (value.length > MAX_DESCRIPTION) throw new SiteError(400, `The description is longer than ${MAX_DESCRIPTION} characters.`);
    return serial(async () => {
      const data = await read();
      if (value) data[name] = value;
      else delete data[name];
      await write(data);
      return { name, description: value };
    });
  }

  /** Drops the note of a subdomain that was deleted, so a new one with the same name starts clean */
  function remove(name) {
    return serial(async () => {
      const data = await read();
      if (!(name in data)) return;
      delete data[name];
      await write(data);
    });
  }

  return { list, set, remove };
}
