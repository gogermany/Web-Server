NGINX Configuration and Subdomain Management
===========================================

This directory contains the main NGINX virtual host configuration for `wemeweb.com` and its subdomains.

Current layout
--------------

- Main config file: `wemeweb.com`
- Active symlink: `sites-enabled/wemeweb.com`
- Shared gzip include: `/etc/nginx/includes/gzip.conf`
- SSL certificate: `/etc/letsencrypt/live/wemeweb.com/`
- Wildcard website root pattern: `/var/www/<subdomain>.wemeweb.com/current`

How subdomains are managed
--------------------------

The config uses explicit server blocks for known services such as:

- `wemeweb.com`
- `api.wemeweb.com`
- `n8n.wemeweb.com`
- `portainer.wemeweb.com`
- `wiz.wemeweb.com`
- `wiz-api.wemeweb.com`
- `storage.wemeweb.com`
- `igupload.wemeweb.com`

There is also a wildcard subdomain block for `*.wemeweb.com` that:

- Redirects HTTP traffic to HTTPS
- Serves content from `/var/www/$host/current`
- Returns `404` if the mapped directory does not exist
- Writes access logs per host name, for example:
  - `/var/log/nginx/wemeweb.com/wildcard-access-newsite.wemeweb.com.log`

This means you can add a new website by creating a directory that matches the full subdomain name.

How to add a new website in a subdomain
---------------------------------------

Use the Node.js script in `scripts/create-wmw-subdomain.js` to create a new subdomain site.

Example: add `blog.wemeweb.com`

1. Run the script with the subdomain name.

	```bash
	node scripts/create-wmw-subdomain.js blog
	```

	You can also pass the full hostname:

	```bash
	node scripts/create-wmw-subdomain.js blog.wemeweb.com
	```

2. The script creates the site directory and starter page.

	It will create:

	- `/var/www/blog.wemeweb.com/current`
	- `/var/www/blog.wemeweb.com/current/index.html`

3. Replace the generated `index.html` with your site content or deploy your app into the `current` directory.

4. Make sure DNS points the subdomain to this server.

	Add an `A` record or `CNAME` record for `blog.wemeweb.com`.

5. Test and reload NGINX if you changed configuration.

	```bash
	sudo nginx -t
	sudo systemctl reload nginx
	```

6. Verify the site.

	```bash
	curl -Ik https://blog.wemeweb.com
	```

Script notes
------------

- The script is an ESM Node.js CLI.
- It creates the subdomain folder structure under `/var/www/<subdomain>.wemeweb.com/current`.
- It writes a basic starter `index.html` if one does not already exist.
- Run `node scripts/create-wmw-subdomain.js --help` to see usage.

Recommended folder convention
-----------------------------

Use one folder per subdomain:

- `/var/www/blog.wemeweb.com/current`
- `/var/www/docs.wemeweb.com/current`
- `/var/www/app.wemeweb.com/current`

If you deploy with releases, keep `current` as the active symlink and update it on deploy.

Common checks
-------------

- If the subdomain returns `404`, confirm the directory exists and contains content.
- If the browser shows the wrong site, confirm the DNS record points to the correct server.
- If NGINX fails to reload, run `sudo nginx -t` and fix the reported config error before reloading.
- If you need to add a proxy-based app instead of a static site, create a dedicated explicit server block instead of using the wildcard static block.

Operational notes
-----------------

- Keep explicit server blocks for special services that need custom proxying, CORS, or upload rules.
- Use the wildcard block only for simple subdomain sites that map cleanly to `/var/www/<host>/current`.
- Access logs are separated by host name for easier troubleshooting.
- The wildcard error log is shared.
