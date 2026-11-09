import http from 'node:http';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { SiteError } from './sites.js';

const JSON_LIMIT = 8 * 1024;

function send(res, status, body) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > JSON_LIMIT) throw new SiteError(413, 'The request is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new SiteError(400, 'The request is not valid JSON.');
  }
}

/** Streams the request body to a temporary file, stopping as soon as it passes the limit */
async function saveUpload(req, dir, maxBytes) {
  if (Number(req.headers['content-length']) > maxBytes) {
    throw new SiteError(413, `The upload is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  }
  const file = path.join(dir, 'upload.zip');
  let received = 0;
  const limit = async function* (source) {
    for await (const chunk of source) {
      received += chunk.length;
      if (received > maxBytes) throw new SiteError(413, `The upload is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`);
      yield chunk;
    }
  };
  await pipeline(req, limit, createWriteStream(file));
  if (received === 0) throw new SiteError(400, 'The upload is empty.');
  return file;
}

// Who changed what, in the PM2 log
function audit(admin, action, detail) {
  console.log(JSON.stringify({ at: new Date().toISOString(), admin: admin.username ?? admin._id, action, ...detail }));
}

export function createApp({ sites, apps, authenticate, allowedOrigins = [], maxUploadBytes = 100 * 1024 * 1024 }) {
  const origins = new Set(allowedOrigins);

  function cors(req, res) {
    const origin = req.headers.origin;
    res.setHeader('vary', 'Origin');
    if (origin && origins.has(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('access-control-allow-headers', 'Authorization, Content-Type');
      res.setHeader('access-control-max-age', '600');
    }
  }

  async function route(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');
    const method = req.method;

    if (method === 'GET' && pathname === '/health') return send(res, 200, { ok: true });

    const admin = await authenticate(req.headers.authorization);

    if (pathname === '/sites') {
      if (method === 'GET') return send(res, 200, { sites: await sites.list() });
      if (method === 'POST') {
        const { name } = await readJson(req);
        const site = await sites.create(name);
        audit(admin, 'site.create', { name: site.name });
        return send(res, 201, { site });
      }
    }

    const content = /^\/sites\/([^/]+)\/content$/.exec(pathname);
    if (content && method === 'PUT') {
      const dir = await mkdtemp(path.join(tmpdir(), 'wmw-deploy-'));
      try {
        const zip = await saveUpload(req, dir, maxUploadBytes);
        // A single page is sent as text/html; anything else must be a zip
        const html = /^text\/html\b/i.test(req.headers['content-type'] ?? '');
        const site = await sites.deploy(decodeURIComponent(content[1]), zip, { html });
        audit(admin, 'site.deploy', { name: site.name, html });
        return send(res, 200, { site });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    const one = /^\/sites\/([^/]+)$/.exec(pathname);
    if (one && method === 'DELETE') {
      await sites.remove(decodeURIComponent(one[1]));
      audit(admin, 'site.delete', { name: decodeURIComponent(one[1]) });
      return send(res, 200, { ok: true });
    }

    // Apps: subdomains that nginx proxies to a local port
    if (apps && pathname === '/apps') {
      if (method === 'GET') return send(res, 200, { apps: await apps.list() });
      if (method === 'POST') {
        const input = await readJson(req);
        const app = await apps.create(input);
        audit(admin, 'app.create', { name: app.name, port: app.port });
        return send(res, 201, { app });
      }
    }

    const oneApp = apps && /^\/apps\/([^/]+)$/.exec(pathname);
    if (oneApp && method === 'PUT') {
      const name = decodeURIComponent(oneApp[1]);
      const app = await apps.update(name, await readJson(req));
      audit(admin, 'app.update', { name, port: app.port });
      return send(res, 200, { app });
    }
    if (oneApp && method === 'DELETE') {
      const name = decodeURIComponent(oneApp[1]);
      await apps.remove(name);
      audit(admin, 'app.delete', { name });
      return send(res, 200, { ok: true });
    }

    throw new SiteError(404, 'Not found.');
  }

  return http.createServer(async (req, res) => {
    cors(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    try {
      await route(req, res);
    } catch (error) {
      if (res.headersSent) return res.destroy();
      if (error instanceof SiteError) {
        // An early error leaves the upload unread; close so the client does not keep sending it
        if (error.status === 413) res.setHeader('connection', 'close');
        return send(res, error.status, { error: error.message });
      }
      console.error(`${req.method} ${req.url}`, error);
      return send(res, 500, { error: 'Something went wrong on the server.' });
    }
  });
}
