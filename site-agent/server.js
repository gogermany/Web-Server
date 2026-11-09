#!/usr/bin/env node
// Site agent: the API the BackOffice uses to manage *.wemeweb.com subdomains on this server.
// Run with `node --env-file=site-agent/.env site-agent/server.js` (see site-agent/README.md).

import { createApp } from './lib/app.js';
import { createRuraAuth } from './lib/auth.js';
import { createNginxManager, systemNginx } from './lib/nginx.js';
import { DEFAULT_RESERVED, createSiteManager } from './lib/sites.js';

const list = (value) => (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);

const port = Number(process.env.PORT ?? 3010);
const host = process.env.HOST ?? '127.0.0.1';
const adminIds = list(process.env.ALLOWED_ADMIN_IDS);

const apps = createNginxManager({
  managedDir: process.env.MANAGED_DIR ?? '/etc/nginx/sites-available/managed',
  mainFile: process.env.NGINX_MAIN_FILE ?? '/etc/nginx/sites-available/wemeweb.com',
  blockedPorts: list(process.env.BLOCKED_PORTS ?? '2376,3010').map(Number),
  // A name is a static site or an app, never both: `sites` is created just below
  extraTaken: async () => (await sites.list()).filter((site) => !site.reserved).map((site) => site.name),
  ...systemNginx()
});

const sites = createSiteManager({
  root: process.env.SITES_ROOT ?? '/var/www',
  reserved: [...DEFAULT_RESERVED, ...list(process.env.EXTRA_RESERVED_NAMES)],
  // A name nginx already serves with its own block can't also be a static site
  extraReserved: () => apps.definedNames()
});

const authenticate = createRuraAuth({
  url: process.env.RURA_GRAPHQL_URL ?? 'https://api.wemeweb.com/graphql',
  allowedAdminIds: adminIds
});

const app = createApp({
  sites,
  apps,
  authenticate,
  allowedOrigins: list(process.env.ALLOWED_ORIGINS ?? 'https://backoffice.wemeweb.com'),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 100) * 1024 * 1024
});

app.listen(port, host, () => {
  console.log(`site-agent listening on http://${host}:${port}`);
  if (!adminIds.length) console.warn('ALLOWED_ADMIN_IDS is empty: every Rura admin can manage sites.');
});
