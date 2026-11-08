import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { createApp } from '../lib/app.js';
import { createNginxManager, parseServerBlocks, renderApp } from '../lib/nginx.js';
import { createSiteManager } from '../lib/sites.js';

const tmp = mkdtempSync(path.join(tmpdir(), 'nginx-test-'));
const managedDir = path.join(tmp, 'managed');
const mainFile = path.join(tmp, 'wemeweb.com');
const www = path.join(tmp, 'www');

const MAIN = `
# a comment with server { braces } and server_name fake.wemeweb.com;
map $host $x { default y; }
server {
    listen 443 ssl;
    server_name *.wemeweb.com;   # wildcard
    root /var/www/$host/current;
}
server {
    server_name wemeweb.com;
}
# API
server {
    server_name api.wemeweb.com;
    location /graphql { proxy_pass https://$rura_upstream_host/graphql; }
}
server {
    listen 443 ssl;
    server_name storage.wemeweb.com;
    if ($http_origin ~* "^(https?://)?(.*\\.)?wemeweb\\.com$") { set $cors "$http_origin"; }
    location / { proxy_pass https://$rura_upstream_host; }
}
`;

let calls, failValidate, failReload, manager;

const fakeValidate = async () => {
  calls.push('validate');
  if (failValidate) throw Object.assign(new Error('x'), { stderr: 'nginx: [emerg] unknown directive "oops" in /etc/x.conf:3\nnginx: configuration file test failed' });
};
const fakeReload = async () => {
  calls.push('reload');
  if (failReload) throw new Error('reload failed');
};

beforeEach(() => {
  rmSync(managedDir, { recursive: true, force: true });
  rmSync(www, { recursive: true, force: true });
  mkdirSync(www);
  writeFileSync(mainFile, MAIN);
  calls = [];
  failValidate = false;
  failReload = false;
  manager = createNginxManager({ managedDir, mainFile, blockedPorts: [2376, 3010], validate: fakeValidate, reload: fakeReload });
});

after(() => rmSync(tmp, { recursive: true, force: true }));

const file = (name) => path.join(managedDir, `${name}.conf`);
const settings = { port: 3001, scheme: 'http', websocket: false, streaming: false, maxBodyMb: 50 };

describe('renderApp', () => {
  it('proxies to the local port with the usual headers', () => {
    const text = renderApp('playda', settings);
    assert.match(text, /server_name playda\.wemeweb\.com;/);
    assert.match(text, /proxy_pass\s+http:\/\/127\.0\.0\.1:3001;/);
    assert.match(text, /client_max_body_size 50m;/);
    assert.match(text, /X-Forwarded-Proto\s+\$scheme;/);
    assert.doesNotMatch(text, /Upgrade/);
    assert.match(text, /^# wmw-managed \{"v":1,"kind":"proxy","port":3001/);
  });

  it('adds WebSocket and streaming settings only when asked', () => {
    const text = renderApp('n8n', { ...settings, port: 5678, websocket: true, streaming: true, scheme: 'https' });
    assert.match(text, /proxy_pass\s+https:\/\/127\.0\.0\.1:5678;/);
    assert.match(text, /Upgrade \$http_upgrade/);
    assert.match(text, /proxy_buffering\s+off;/);
    assert.match(text, /proxy_read_timeout\s+3600;/);
  });
});

describe('parseServerBlocks', () => {
  it('finds names and proxy targets, ignoring comments and nested braces', () => {
    const blocks = parseServerBlocks(MAIN);
    assert.deepEqual(blocks.map((b) => b.names), [['*.wemeweb.com'], ['wemeweb.com'], ['api.wemeweb.com'], ['storage.wemeweb.com']]);
    assert.equal(blocks[2].upstream, 'https://$rura_upstream_host/graphql');
  });
});

describe('creating apps', () => {
  it('writes the file, tests it, then reloads', async () => {
    const app = await manager.create({ name: 'Playda', ...settings });
    assert.deepEqual(calls, ['validate', 'reload']);
    assert.equal(app.kind, 'proxy');
    assert.equal(app.port, 3001);
    assert.match(readFileSync(file('playda'), 'utf8'), /server_name playda\.wemeweb\.com;/);
  });

  it('undoes everything when nginx rejects the config', async () => {
    failValidate = true;
    await assert.rejects(manager.create({ name: 'bad', ...settings }), (e) => e.status === 422 && /unknown directive/.test(e.message) && /Nothing was changed/.test(e.message));
    assert.equal(existsSync(file('bad')), false);
    assert.deepEqual(calls, ['validate']);
  });

  it('undoes the change when the reload fails', async () => {
    failReload = true;
    await assert.rejects(manager.create({ name: 'oops', ...settings }), { status: 500 });
    assert.equal(existsSync(file('oops')), false);
  });

  it('refuses a name nginx already serves, in the main file or as an app', async () => {
    await assert.rejects(manager.create({ name: 'api', ...settings }), { status: 409 });
    await assert.rejects(manager.create({ name: 'storage', ...settings }), { status: 409 });
    await manager.create({ name: 'blog', ...settings });
    await assert.rejects(manager.create({ name: 'blog', ...settings }), { status: 409 });
    await assert.rejects(manager.create({ name: 'www', ...settings }), { status: 409 });
  });

  for (const bad of ['', 'a.b', '../x', 'a/b', 'a\nserver_name evil.com', 'x;}', 'a b']) {
    it(`refuses the name ${JSON.stringify(bad)}`, async () => {
      await assert.rejects(manager.create({ name: bad, ...settings }), { status: 422 });
      assert.deepEqual(calls, []);
    });
  }

  for (const port of [0, 80, 443, 1023, 65536, 2376, 3010, 3000.5, '3000; return 301 http://evil;', '3000}', null, undefined, '0x10']) {
    it(`refuses the port ${JSON.stringify(port)}`, async () => {
      await assert.rejects(manager.create({ name: 'p', ...settings, port }), { status: 422 });
      assert.equal(existsSync(file('p')), false);
    });
  }

  it('refuses settings outside the allowed values', async () => {
    await assert.rejects(manager.create({ name: 'p', ...settings, scheme: 'file' }), { status: 422 });
    await assert.rejects(manager.create({ name: 'p', ...settings, maxBodyMb: 0 }), { status: 422 });
    await assert.rejects(manager.create({ name: 'p', ...settings, maxBodyMb: '5m; evil' }), { status: 422 });
  });

  it('never puts unexpected input into the file', async () => {
    await manager.create({ name: 'safe', ...settings, root: '/etc', extra: '}\nserver{', websocket: 'yes' });
    const text = readFileSync(file('safe'), 'utf8');
    assert.doesNotMatch(text, /\/etc\b(?!\/(nginx|letsencrypt))/);
    assert.doesNotMatch(text, /evil|server\{/);
    assert.doesNotMatch(text, /Upgrade/); // websocket only for a real `true`
  });
});

describe('editing and removing', () => {
  it('changes the port and keeps the other settings', async () => {
    await manager.create({ name: 'blog', ...settings, websocket: true });
    calls = [];
    const app = await manager.update('blog', { port: 4000 });
    assert.equal(app.port, 4000);
    assert.equal(app.websocket, true);
    assert.deepEqual(calls, ['validate', 'reload']);
    assert.match(readFileSync(file('blog'), 'utf8'), /127\.0\.0\.1:4000/);
  });

  it('keeps the old file when the new one is rejected', async () => {
    await manager.create({ name: 'blog', ...settings });
    failValidate = true;
    await assert.rejects(manager.update('blog', { port: 4000 }), { status: 422 });
    assert.match(readFileSync(file('blog'), 'utf8'), /127\.0\.0\.1:3001/);
  });

  it('cannot edit or remove a block that lives in the main file', async () => {
    await assert.rejects(manager.update('api', { port: 4000 }), { status: 404 });
    await assert.rejects(manager.remove('api'), { status: 403 });
    assert.equal(readFileSync(mainFile, 'utf8'), MAIN);
  });

  it('removes an app, keeping a copy in .trash', async () => {
    await manager.create({ name: 'blog', ...settings });
    await manager.remove('blog');
    assert.equal(existsSync(file('blog')), false);
    assert.equal(readdirSync(path.join(managedDir, '.trash')).filter((n) => n.startsWith('blog-')).length, 1);
  });

  it('restores a removed app when nginx refuses the result', async () => {
    await manager.create({ name: 'blog', ...settings });
    failReload = true;
    await assert.rejects(manager.remove('blog'), { status: 500 });
    assert.equal(existsSync(file('blog')), true);
  });

  it('answers 404 for an app that does not exist', async () => {
    await assert.rejects(manager.remove('ghost'), { status: 404 });
  });
});

describe('listing', () => {
  it('merges managed apps with the read-only blocks of the main file', async () => {
    await manager.create({ name: 'blog', ...settings });
    const apps = await manager.list();
    assert.deepEqual(apps.map((a) => [a.name, a.kind]), [['api', 'system'], ['blog', 'proxy'], ['storage', 'system']]);
    assert.equal(apps[0].upstream, 'https://$rura_upstream_host/graphql');
    assert.equal(apps.find((a) => a.name === 'fake'), undefined);
  });

  it('shows a file without the agent header as read-only', async () => {
    mkdirSync(managedDir, { recursive: true });
    writeFileSync(file('legacy'), 'server { server_name legacy.wemeweb.com; location / { proxy_pass http://127.0.0.1:9999; } }');
    const legacy = (await manager.list()).find((a) => a.name === 'legacy');
    assert.equal(legacy.kind, 'system');
    assert.equal(legacy.upstream, 'http://127.0.0.1:9999');
    await assert.rejects(manager.update('legacy', { port: 4000 }), { status: 403 });
  });

  it('runs changes one at a time', async () => {
    const order = [];
    const slow = createNginxManager({
      managedDir, mainFile, validate: async () => { order.push('start'); await new Promise((r) => setTimeout(r, 30)); order.push('end'); }, reload: async () => {}
    });
    await Promise.all([slow.create({ name: 'a1', ...settings }), slow.create({ name: 'a2', ...settings, port: 3002 })]);
    assert.deepEqual(order, ['start', 'end', 'start', 'end']);
  });
});

describe('with the static sites and the HTTP API', () => {
  let server, base;

  beforeEach(async () => {
    const sites = createSiteManager({ root: www, extraReserved: () => manager.definedNames() });
    server = createApp({ sites, apps: manager, authenticate: async () => ({ _id: 'a1', username: 'goh' }), allowedOrigins: [] });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(() => server.closeAllConnections() ?? server.close());

  const api = (method, url, body) =>
    fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(async (res) => ({ status: res.status, json: await res.json() }));

  it('creates, lists, edits and deletes an app', async () => {
    assert.equal((await api('POST', '/apps', { name: 'blog', ...settings })).status, 201);
    assert.equal((await api('GET', '/apps')).json.apps.find((a) => a.name === 'blog').port, 3001);
    assert.equal((await api('PUT', '/apps/blog', { port: 4001 })).json.app.port, 4001);
    assert.equal((await api('DELETE', '/apps/blog')).status, 200);
    assert.equal((await api('DELETE', '/apps/blog')).status, 404);
  });

  it('answers 422 for bad settings', async () => {
    assert.equal((await api('POST', '/apps', { name: 'blog', port: 'abc' })).status, 422);
  });

  it('stops a static site from taking a name that nginx serves', async () => {
    assert.equal((await api('POST', '/sites', { name: 'storage' })).status, 403);
    await api('POST', '/apps', { name: 'blog', ...settings });
    assert.equal((await api('POST', '/sites', { name: 'blog' })).status, 403);
  });

  it('allows a static site once the app is removed', async () => {
    await api('POST', '/apps', { name: 'blog', ...settings });
    await api('DELETE', '/apps/blog');
    assert.equal((await api('POST', '/sites', { name: 'blog' })).status, 201);
  });
});
