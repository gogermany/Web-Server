#!/usr/bin/env node

import { mkdir, writeFile, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

const WEMEWEB_DOMAIN = 'wemeweb.com';
const WWW_ROOT = '/var/www';

function printUsage() {
  console.log('Usage: node scripts/create-wmw-subdomain.js <subdomain|subdomain.wemeweb.com>');
  console.log('Example: node scripts/create-wmw-subdomain.js blog');
}

function normalizeHost(input) {
  const value = String(input || '').trim().toLowerCase();

  if (!value) {
    throw new Error('Missing subdomain name.');
  }

  const host = value.endsWith(`.${WEMEWEB_DOMAIN}`)
    ? value
    : `${value}.${WEMEWEB_DOMAIN}`;

  if (!/^[a-z0-9][a-z0-9-]*\.[a-z0-9.-]+$/.test(host)) {
    throw new Error(`Invalid subdomain value: ${input}`);
  }

  return host;
}

async function fileExists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    printUsage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  const host = normalizeHost(args[0]);
  const siteRoot = path.join(WWW_ROOT, host, 'current');
  const indexFile = path.join(siteRoot, 'index.html');

  await mkdir(siteRoot, { recursive: true });

  const indexExists = await fileExists(indexFile);
  if (!indexExists) {
    const title = host.replace(`.${WEMEWEB_DOMAIN}`, '');
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${host}</title>
  <style>
    body {
      font-family: system-ui, sans-serif;
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #0f172a;
      color: #e2e8f0;
    }
    main {
      max-width: 720px;
      padding: 32px;
    }
    h1 {
      margin: 0 0 12px;
      font-size: 2.5rem;
    }
    p {
      line-height: 1.6;
      margin: 0;
      color: #cbd5e1;
    }
    code {
      background: rgba(148, 163, 184, 0.16);
      padding: 0.15rem 0.35rem;
      border-radius: 0.35rem;
    }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>This subdomain is ready. Replace this page with your website content in <code>${siteRoot}</code>.</p>
  </main>
</body>
</html>
`;

    await writeFile(indexFile, html, 'utf8');
  }

  console.log(`Created subdomain: ${host}`);
  console.log(`Directory: ${siteRoot}`);
  console.log(`Index page: ${indexFile}`);
  console.log('URL: https://' + host);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});