import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../lib/app.js';
import { createRuraAuth } from '../lib/auth.js';
import { createDescriptions } from '../lib/descriptions.js';
import { createSiteManager } from '../lib/sites.js';

const ORIGIN = 'https://backoffice.test';
const tmp = mkdtempSync(path.join(tmpdir(), 'site-agent-test-'));
const root = path.join(tmp, 'www');
mkdirSync(root);

let rura, agent, base, ruraCalls = 0;

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

before(async () => {
  // Fake Rura: token "good" is admin a1, "other" is admin b2, anything else is rejected
  rura = http.createServer((req, res) => {
    ruraCalls += 1;
    const token = /Bearer (.+)/.exec(req.headers.authorization ?? '')?.[1];
    const admin = { good: { _id: 'a1', username: 'goh' }, other: { _id: 'b2', username: 'bob' } }[token];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(admin ? { data: { administrator: admin } } : { errors: [{ extensions: { code: 'UNAUTHENTICATED' } }], data: null }));
  });
  const ruraPort = await listen(rura);

  agent = createApp({
    sites: createSiteManager({ root }),
    descriptions: createDescriptions({ file: path.join(tmp, 'data', 'descriptions.json') }),
    authenticate: createRuraAuth({ url: `http://127.0.0.1:${ruraPort}/graphql`, allowedAdminIds: ['a1'] }),
    allowedOrigins: [ORIGIN],
    maxUploadBytes: 1024 * 1024
  });
  base = `http://127.0.0.1:${await listen(agent)}`;
});

after(() => {
  rura.close();
  agent.close();
  rmSync(tmp, { recursive: true, force: true });
});

const call = (method, url, { token = 'good', body, headers = {} } = {}) =>
  fetch(base + url, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body
  }).then(async (res) => ({ status: res.status, headers: res.headers, json: await res.json().catch(() => null) }));

const create = (name) => call('POST', '/sites', { body: JSON.stringify({ name }), headers: { 'content-type': 'application/json' } });

function makeZip(files, name = 'site.zip') {
  const src = mkdtempSync(path.join(tmp, 'src-'));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(src, file)), { recursive: true });
    writeFileSync(path.join(src, file), content);
  }
  const zip = path.join(tmp, `${path.basename(src)}-${name}`);
  execFileSync('zip', ['-qr', zip, '.'], { cwd: src });
  return zip;
}

const upload = (name, zipFile) => call('PUT', `/sites/${name}/content`, { body: readFileSync(zipFile) });

describe('authentication', () => {
  it('needs a token', async () => {
    assert.equal((await call('GET', '/sites', { token: null })).status, 401);
  });

  it('rejects a token Rura does not know', async () => {
    assert.equal((await call('GET', '/sites', { token: 'nope' })).status, 401);
  });

  it('rejects an admin who is not on the allow list', async () => {
    assert.equal((await call('GET', '/sites', { token: 'other' })).status, 403);
  });

  it('asks Rura once for repeated requests with the same token', async () => {
    await call('GET', '/sites');
    const before = ruraCalls;
    await call('GET', '/sites');
    await call('GET', '/sites');
    assert.equal(ruraCalls, before);
  });

  it('answers 502 when Rura cannot be reached', async () => {
    const authenticate = createRuraAuth({ url: 'http://127.0.0.1:1/graphql' });
    await assert.rejects(authenticate('Bearer x'), { status: 502 });
  });

  it('serves /health without a token', async () => {
    assert.deepEqual((await call('GET', '/health', { token: null })).json, { ok: true });
  });
});

describe('CORS', () => {
  it('answers the preflight for the BackOffice origin', async () => {
    const res = await fetch(`${base}/sites`, { method: 'OPTIONS', headers: { origin: ORIGIN } });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
    assert.match(res.headers.get('access-control-allow-headers'), /Authorization/);
  });

  it('gives other origins no CORS headers', async () => {
    const res = await fetch(`${base}/sites`, { method: 'OPTIONS', headers: { origin: 'https://evil.test' } });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
});

describe('creating sites', () => {
  it('creates a site with a placeholder page', async () => {
    const res = await create('blog');
    assert.equal(res.status, 201);
    assert.equal(res.json.site.host, 'blog.wemeweb.com');
    assert.equal(res.json.site.status, 'placeholder');
    assert.match(readFileSync(path.join(root, 'blog.wemeweb.com/current/index.html'), 'utf8'), /blog\.wemeweb\.com/);
  });

  it('accepts the full host name and any case', async () => {
    const res = await create('  Shop.WemeWeb.com ');
    assert.equal(res.json.site.name, 'shop');
  });

  it('refuses a name that already exists', async () => {
    assert.equal((await create('blog')).status, 409);
  });

  for (const bad of ['', 'a.b', '../etc', 'a/b', '-a', 'a-', 'wemeweb.com', 'a b', 'x'.repeat(64)]) {
    it(`refuses the invalid name ${JSON.stringify(bad)}`, async () => {
      assert.equal((await create(bad)).status, 422);
    });
  }

  for (const reserved of ['api', 'n8n', 'www', 'sites', 'backoffice']) {
    it(`refuses the reserved name ${reserved}`, async () => {
      assert.equal((await create(reserved)).status, 403);
      assert.equal(existsSync(path.join(root, `${reserved}.wemeweb.com`)), false);
    });
  }

  it('lists only managed sites, sorted', async () => {
    mkdirSync(path.join(root, 'something.wemeweb.com.bk'));
    mkdirSync(path.join(root, 'wiz.shopping'));
    const { json } = await call('GET', '/sites');
    assert.deepEqual(json.sites.map((site) => site.name), ['blog', 'shop']);
  });
});

describe('deploying', () => {
  it('replaces the page and keeps the old one as .previous', async () => {
    const res = await upload('blog', makeZip({ 'index.html': '<h1>v1</h1>', 'css/app.css': 'body{}' }));
    assert.equal(res.status, 200);
    assert.equal(res.json.site.status, 'live');
    assert.equal(readFileSync(path.join(root, 'blog.wemeweb.com/current/index.html'), 'utf8'), '<h1>v1</h1>');

    await upload('blog', makeZip({ 'index.html': '<h1>v2</h1>' }));
    assert.equal(readFileSync(path.join(root, 'blog.wemeweb.com/current/index.html'), 'utf8'), '<h1>v2</h1>');
    assert.equal(readFileSync(path.join(root, 'blog.wemeweb.com/.previous/index.html'), 'utf8'), '<h1>v1</h1>');
  });

  it('serves the inside of a single zipped folder', async () => {
    await upload('shop', makeZip({ 'dist/index.html': '<h1>dist</h1>' }));
    assert.equal(readFileSync(path.join(root, 'shop.wemeweb.com/current/index.html'), 'utf8'), '<h1>dist</h1>');
  });

  it('removes hidden files but keeps .well-known', async () => {
    const res = await upload('blog', makeZip({
      'index.html': 'x', '.env': 'SECRET=1', '.git/config': 'x', 'sub/.htpasswd': 'x', '.well-known/security.txt': 'ok', '__MACOSX/._index.html': 'x'
    }));
    assert.equal(res.json.site.pruned, 4);
    const current = path.join(root, 'blog.wemeweb.com/current');
    assert.deepEqual(readdirSync(current).sort(), ['.well-known', 'index.html', 'sub']);
    assert.deepEqual(readdirSync(path.join(current, 'sub')), []);
  });

  it('needs an index.html', async () => {
    assert.equal((await upload('blog', makeZip({ 'about.html': 'x' }))).status, 422);
  });

  it('keeps the live site when a deploy fails', async () => {
    await upload('blog', makeZip({ 'index.html': 'stable' }));
    await upload('blog', makeZip({ 'about.html': 'x' }));
    assert.equal(readFileSync(path.join(root, 'blog.wemeweb.com/current/index.html'), 'utf8'), 'stable');
    assert.deepEqual(readdirSync(path.join(root, 'blog.wemeweb.com')).filter((n) => n.startsWith('.incoming')), []);
  });

  it('rejects a file that is not a zip', async () => {
    const file = path.join(tmp, 'fake.zip');
    writeFileSync(file, 'not a zip');
    assert.equal((await upload('blog', file)).status, 422);
  });

  it('accepts a single HTML file and serves it as index.html', async () => {
    const res = await call('PUT', '/sites/blog/content', { body: '<h1>one page</h1>', headers: { 'content-type': 'text/html' } });
    assert.equal(res.status, 200);
    assert.equal(res.json.site.status, 'live');
    assert.equal(readFileSync(path.join(root, 'blog.wemeweb.com/current/index.html'), 'utf8'), '<h1>one page</h1>');
    assert.deepEqual(readdirSync(path.join(root, 'blog.wemeweb.com/current')), ['index.html']);
  });

  it('treats a non-zip body without text/html as a bad zip and keeps the live site', async () => {
    await call('PUT', '/sites/blog/content', { body: '<h1>stable</h1>', headers: { 'content-type': 'text/html' } });
    const res = await call('PUT', '/sites/blog/content', { body: '<h1>not a zip</h1>', headers: { 'content-type': 'application/zip' } });
    assert.equal(res.status, 422);
    assert.equal(readFileSync(path.join(root, 'blog.wemeweb.com/current/index.html'), 'utf8'), '<h1>stable</h1>');
  });

  it('rejects an empty upload', async () => {
    assert.equal((await call('PUT', '/sites/blog/content', { body: '' })).status, 400);
  });

  it('rejects an upload over the limit', async () => {
    const res = await call('PUT', '/sites/blog/content', { body: Buffer.alloc(1024 * 1024 + 1) });
    assert.equal(res.status, 413);
  });

  it('rejects a zip with a symbolic link', async () => {
    const src = mkdtempSync(path.join(tmp, 'link-'));
    writeFileSync(path.join(src, 'index.html'), 'x');
    symlinkSync('/etc/passwd', path.join(src, 'passwd'));
    const zip = path.join(tmp, 'link.zip');
    execFileSync('zip', ['-qry', zip, '.'], { cwd: src });
    const res = await upload('blog', zip);
    assert.equal(res.status, 422);
    assert.match(res.json.error, /link/);
  });

  it('cannot write outside the site with ../ paths', async () => {
    const zip = path.join(tmp, 'slip.zip');
    execFileSync('python3', ['-c', `
import zipfile, sys
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    z.writestr('index.html', 'x')
    z.writestr('../../escaped.txt', 'pwned')
    z.writestr('/tmp/escaped-abs.txt', 'pwned')
`, zip]);
    await upload('blog', zip);
    assert.equal(existsSync(path.join(root, 'escaped.txt')), false);
    assert.equal(existsSync(path.join(tmp, 'escaped.txt')), false);
    assert.equal(existsSync('/tmp/escaped-abs.txt'), false);
  });

  it('answers 404 for a site that does not exist', async () => {
    assert.equal((await upload('ghost', makeZip({ 'index.html': 'x' }))).status, 404);
  });

  it('refuses to deploy to a reserved name', async () => {
    assert.equal((await upload('api', makeZip({ 'index.html': 'x' }))).status, 403);
  });
});

describe('deleting', () => {
  it('moves the folder to .trash', async () => {
    assert.equal((await call('DELETE', '/sites/shop')).status, 200);
    assert.equal(existsSync(path.join(root, 'shop.wemeweb.com')), false);
    assert.equal(readdirSync(path.join(root, '.trash')).filter((n) => n.startsWith('shop.wemeweb.com-')).length, 1);
  });

  it('answers 404 for a site that does not exist', async () => {
    assert.equal((await call('DELETE', '/sites/shop')).status, 404);
  });

  it('refuses reserved names and traversal', async () => {
    assert.equal((await call('DELETE', '/sites/api')).status, 403);
    assert.equal((await call('DELETE', '/sites/..%2F..%2Fetc')).status, 422);
  });
});

describe('descriptions', () => {
  const put = (name, body, token = 'good') =>
    call('PUT', `/descriptions/${name}`, { token, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

  it('needs a login', async () => {
    assert.equal((await call('GET', '/descriptions', { token: null })).status, 401);
    assert.equal((await put('blog', { description: 'x' }, 'other')).status, 403);
  });

  it('starts empty, then saves and lists a note', async () => {
    assert.deepEqual((await call('GET', '/descriptions')).json.descriptions, {});
    const res = await put('Blog', { description: '  My blog  ' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { name: 'blog', description: 'My blog' });
    assert.deepEqual((await call('GET', '/descriptions')).json.descriptions, { blog: 'My blog' });
  });

  it('turns line breaks and control characters into spaces', async () => {
    await put('blog', { description: 'one\ntwo\u0000three' });
    assert.equal((await call('GET', '/descriptions')).json.descriptions.blog, 'one two three');
  });

  it('removes the note when it is emptied', async () => {
    await put('blog', { description: '' });
    assert.deepEqual((await call('GET', '/descriptions')).json.descriptions, {});
  });

  it('rejects a bad name, a long text and a non-text value', async () => {
    assert.equal((await put('a.b', { description: 'x' })).status, 422);
    assert.equal((await put('blog', { description: 'x'.repeat(201) })).status, 400);
    assert.equal((await put('blog', { description: 42 })).status, 400);
  });

  it('is dropped when the site is deleted', async () => {
    await create('notes');
    await put('notes', { description: 'to be removed' });
    assert.equal((await call('DELETE', '/sites/notes')).status, 200);
    assert.equal((await call('GET', '/descriptions')).json.descriptions.notes, undefined);
  });
});
