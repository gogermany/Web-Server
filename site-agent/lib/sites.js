import { execFile } from 'node:child_process';
import { copyFile, mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const DOMAIN = 'wemeweb.com';

// Hosts that have their own nginx server block (or live elsewhere). The wildcard block never
// serves them, so a folder created for one of these would do nothing.
export const DEFAULT_RESERVED = [
  'www', 'api', 'rura', 'n8n', 'portainer', 'dozzle', 'storage',
  'wiz', 'playda', 'igupload', 'backoffice', 'sites', 'admin', 'mail'
];

// A single DNS label: the wildcard certificate only covers one level (`*.wemeweb.com`)
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const PLACEHOLDER_MARKER = '<!-- wmw:placeholder -->';

export class SiteError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** `blog` or `blog.wemeweb.com` -> `blog`; anything else is rejected */
export function parseLabel(input, domain = DOMAIN) {
  let value = String(input ?? '').trim().toLowerCase();
  if (value.endsWith(`.${domain}`)) value = value.slice(0, -(domain.length + 1));
  if (!value) throw new SiteError(422, 'Enter a subdomain name.');
  if (!LABEL.test(value)) {
    throw new SiteError(422, 'Use letters, numbers and hyphens only (no dots), and do not start or end with a hyphen.');
  }
  return value;
}

export function placeholderHtml(host) {
  const title = host.split('.')[0];
  return `<!doctype html>
${PLACEHOLDER_MARKER}
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${host}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f172a; color: #e2e8f0; }
    main { max-width: 720px; padding: 32px; }
    h1 { margin: 0 0 12px; font-size: 2.5rem; }
    p { line-height: 1.6; margin: 0; color: #cbd5e1; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>This subdomain is ready. Upload your website from the BackOffice to replace this page.</p>
  </main>
</body>
</html>
`;
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function isPlaceholder(indexFile) {
  const handle = await open(indexFile, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(256), 0, 256, 0);
    return buffer.toString('utf8', 0, bytesRead).includes(PLACEHOLDER_MARKER);
  } finally {
    await handle.close();
  }
}

/**
 * Removes what must never be served (hidden files such as `.git` or `.env`, macOS junk) and rejects
 * links and special files. Only `.well-known` at the top level is kept.
 */
async function sanitizeTree(dir, top = true) {
  let pruned = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !(entry.isFile() || entry.isDirectory())) {
      throw new SiteError(422, `The archive contains a link or special file (${entry.name}), which is not allowed.`);
    }
  }
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const hidden = entry.name === '__MACOSX' || (entry.name.startsWith('.') && !(top && entry.name === '.well-known'));
    if (hidden) {
      await rm(full, { recursive: true, force: true });
      pruned += 1;
    } else if (entry.isDirectory()) {
      pruned += await sanitizeTree(full, false);
    }
  }
  return pruned;
}

export function createSiteManager({
  root = '/var/www',
  domain = DOMAIN,
  reserved = DEFAULT_RESERVED,
  // Names that nginx serves with its own server block (read when needed, so it follows the config)
  extraReserved = async () => [],
  maxUnzippedBytes = 300 * 1024 * 1024,
  maxFiles = 20000
} = {}) {
  const reservedSet = new Set(reserved);
  const busy = new Set();

  const hostOf = (name) => `${name}.${domain}`;
  const dirOf = (name) => path.join(root, hostOf(name));

  const parseName = (input) => parseLabel(input, domain);

  async function reservedNames() {
    return new Set([...reservedSet, ...(await extraReserved())]);
  }

  async function assertManageable(name) {
    if ((await reservedNames()).has(name)) throw new SiteError(403, `"${name}" is reserved for another service.`);
  }

  async function withLock(name, task) {
    if (busy.has(name)) throw new SiteError(409, `"${name}" is being changed right now. Try again in a moment.`);
    busy.add(name);
    try {
      return await task();
    } finally {
      busy.delete(name);
    }
  }

  async function describe(name, reservedList) {
    const reservedNow = reservedList ?? (await reservedNames());
    const dir = dirOf(name);
    const index = path.join(dir, 'current', 'index.html');
    let status = 'empty';
    let updatedAt = (await stat(dir)).mtime;
    if (await exists(index)) {
      status = (await isPlaceholder(index)) ? 'placeholder' : 'live';
      updatedAt = (await stat(index)).mtime;
    }
    const host = hostOf(name);
    return {
      name,
      host,
      url: `https://${host}`,
      status,
      reserved: reservedNow.has(name),
      updatedAt: updatedAt.toISOString()
    };
  }

  async function list() {
    const suffix = `.${domain}`;
    const sites = [];
    const reservedNow = await reservedNames();
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith(suffix)) continue;
      const name = entry.name.slice(0, -suffix.length);
      if (LABEL.test(name)) sites.push(await describe(name, reservedNow));
    }
    return sites.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function create(input) {
    const name = parseName(input);
    await assertManageable(name);
    return withLock(name, async () => {
      try {
        await mkdir(dirOf(name));
      } catch (error) {
        if (error.code === 'EEXIST') throw new SiteError(409, `${hostOf(name)} already exists.`);
        throw error;
      }
      await mkdir(path.join(dirOf(name), 'current'));
      await writeFile(path.join(dirOf(name), 'current', 'index.html'), placeholderHtml(hostOf(name)), 'utf8');
      return describe(name);
    });
  }

  /** The folder is moved to `<root>/.trash`, not erased, so a mistake can be undone by hand */
  async function remove(input) {
    const name = parseName(input);
    await assertManageable(name);
    return withLock(name, async () => {
      if (!(await exists(dirOf(name)))) throw new SiteError(404, `${hostOf(name)} does not exist.`);
      const trash = path.join(root, '.trash');
      await mkdir(trash, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await rename(dirOf(name), path.join(trash, `${hostOf(name)}-${stamp}`));
    });
  }

  /**
   * Replaces `current` with the contents of a zip. The archive is unpacked next to the live folder
   * and swapped in with a rename; the old version stays in `.previous` for one-step rollback.
   * With `{ html: true }` the file is a single page, which becomes the site's `index.html`.
   */
  async function deploy(input, zipPath, { html = false } = {}) {
    const name = parseName(input);
    await assertManageable(name);
    return withLock(name, async () => {
      const siteDir = dirOf(name);
      if (!(await exists(siteDir))) throw new SiteError(404, `${hostOf(name)} does not exist.`);

      if (!html) {
        let totals;
        try {
          totals = (await run('unzip', ['-Z', '-t', zipPath], { timeout: 30000 })).stdout;
        } catch {
          throw new SiteError(422, 'This is not a valid zip file.');
        }
        const match = totals.match(/(\d+) files?, (\d+) bytes uncompressed/);
        if (!match) throw new SiteError(422, 'This is not a valid zip file.');
        if (Number(match[1]) > maxFiles) throw new SiteError(413, `The archive has more than ${maxFiles} files.`);
        if (Number(match[2]) > maxUnzippedBytes) {
          throw new SiteError(413, `The archive is larger than ${Math.round(maxUnzippedBytes / 1024 / 1024)} MB unpacked.`);
        }
      }

      const incoming = path.join(siteDir, `.incoming-${randomBytes(6).toString('hex')}`);
      await mkdir(incoming);
      try {
        if (html) {
          await copyFile(zipPath, path.join(incoming, 'index.html'));
        } else {
          try {
            await run('unzip', ['-q', '-o', zipPath, '-d', incoming], { timeout: 60000 });
          } catch {
            throw new SiteError(422, 'The zip file could not be unpacked.');
          }
        }

        const pruned = await sanitizeTree(incoming);

        // A zipped folder has one top-level directory: serve what is inside it
        let content = incoming;
        if (!(await exists(path.join(incoming, 'index.html')))) {
          const entries = await readdir(incoming, { withFileTypes: true });
          if (entries.length === 1 && entries[0].isDirectory()) content = path.join(incoming, entries[0].name);
        }
        if (!(await exists(path.join(content, 'index.html')))) {
          throw new SiteError(422, 'The archive needs an index.html at its top level.');
        }

        // nginx runs as another user and must be able to read everything
        await run('chmod', ['-R', 'u+rwX,go+rX,go-w', content]);

        const current = path.join(siteDir, 'current');
        const previous = path.join(siteDir, '.previous');
        await rm(previous, { recursive: true, force: true });
        const hadCurrent = await exists(current);
        if (hadCurrent) await rename(current, previous);
        try {
          await rename(content, current);
        } catch (error) {
          if (hadCurrent) await rename(previous, current);
          throw error;
        }
        return { ...(await describe(name)), pruned };
      } finally {
        await rm(incoming, { recursive: true, force: true });
      }
    });
  }

  return { parseName, hostOf, list, create, remove, deploy };
}
