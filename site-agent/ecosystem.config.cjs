const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'SiteAgent.WeMeWeb.com',
      script: 'server.js',
      cwd: __dirname,
      // Absolute, so it does not depend on the directory PM2 starts node from
      node_args: `--env-file=${path.join(__dirname, '.env')}`,
      instances: 1,
      autorestart: true,
      max_memory_restart: '150M'
    }
  ]
};
