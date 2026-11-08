#!/usr/bin/env node

import { createSiteManager, SiteError } from '../site-agent/lib/sites.js';

function printUsage() {
  console.log('Usage: node scripts/create-wmw-subdomain.js <subdomain|subdomain.wemeweb.com>');
  console.log('Example: node scripts/create-wmw-subdomain.js blog');
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    printUsage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  const sites = createSiteManager();

  try {
    const site = await sites.create(args[0]);
    console.log(`Created subdomain: ${site.host}`);
    console.log(`Directory: /var/www/${site.host}/current`);
    console.log(`URL: ${site.url}`);
  } catch (error) {
    // Running it twice is harmless: report it instead of failing
    if (error instanceof SiteError && error.status === 409) {
      console.log(error.message);
      return;
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
