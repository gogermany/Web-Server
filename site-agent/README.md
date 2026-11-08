# Site agent

Small API (no dependencies, Node 20.12+) that the BackOffice **Sites** page uses to manage `*.wemeweb.com` on this server. It works on the layout the wildcard nginx block already serves: `/var/www/<name>.wemeweb.com/current`. nginx never needs a change or a reload when a site is added.

| Method and path | What it does |
|---|---|
| `GET /health` | `{ ok: true }`, no login (for monitoring) |
| `GET /sites` | Lists the sites (`live`, `placeholder` or `empty`; `reserved` for other services) |
| `POST /sites` `{ "name": "blog" }` | Creates `blog.wemeweb.com` with a placeholder page |
| `PUT /sites/:name/content` | Body: a zip. Replaces the site (needs `index.html`) |
| `DELETE /sites/:name` | Moves the folder to `/var/www/.trash/` |
| `GET /apps` | Subdomains nginx proxies to a port: `proxy` (managed here) and `system` (hand-written in the main file, read only) |
| `POST /apps` `{ name, port, scheme?, websocket?, streaming?, maxBodyMb? }` | Adds an app |
| `PUT /apps/:name` | Changes an app's settings (the name is fixed) |
| `DELETE /apps/:name` | Removes an app; its file is kept in `managed/.trash/` |

## Apps and nginx

Each app is one generated file, `managed/<name>.conf`, which the main file pulls in with `include .../managed/*.conf;`. Apps are rendered from a fixed template, so only a port (1024-65535, minus `BLOCKED_PORTS`), http/https, two switches and an upload limit can be set. Nothing from the UI is ever copied into the config as text, and the upstream is always `127.0.0.1`.

Every change goes through the same steps, one at a time:

1. write the file, 2. `sudo nginx -t`, 3. `sudo systemctl reload nginx`.

If nginx refuses at step 2 or 3, the previous file is put back and the API answers with nginx's error; nothing goes live. A reload returns before the new workers take over, so a change can take a moment to show. Each change is logged in PM2 with the admin's name (`app.create`, `app.update`, `app.delete`).

The agent needs passwordless `sudo` for those two commands (the `ubuntu` user has it on this server). Names that nginx already answers for (any block in the main file, any app) cannot be reused, for apps or for static sites.

`playda`, `wiz`, `dozzle`, `portainer` and `n8n` were moved out of `wemeweb.com` into `managed/` on 2026-11-08. `api`, `storage`, `igupload`, `sites`, the apex and the wildcard stay in the main file because they need hand-written settings (CORS, a Rura upstream, an `alias`). The BackOffice shows them as System.

## Safety rules

- **Login:** every call needs `Authorization: Bearer <Rura admin token>`. The agent asks Rura (`administrator` query) if the token is an admin; the answer is cached for 60 s. `ALLOWED_ADMIN_IDS` can narrow it to chosen admins.
- **Names:** one DNS label only (the wildcard certificate covers one level). Names with their own nginx block (`api`, `n8n`, `wiz`, ...) are reserved, see `DEFAULT_RESERVED` in `lib/sites.js`.
- **Zip uploads:** size and file-count limits, links and special files are rejected, `../` paths cannot escape, hidden files (`.env`, `.git`, ...) are removed (`.well-known` is kept).
- **Deploys** are unpacked next to the site and swapped in with a rename. The previous version stays in `<site>/.previous`. A failed deploy leaves the live site untouched.
- **Delete** moves to `/var/www/.trash/`, nothing is erased.
- **Audit:** every create, deploy, update and delete is logged with the admin's name.
- Listens on `127.0.0.1` only; nginx (`sites.wemeweb.com`) is the public entry. CORS only for `ALLOWED_ORIGINS`.

## Set up

```bash
cd /etc/nginx/sites-available/site-agent
cp .env.example .env            # then edit ALLOWED_ORIGINS / ALLOWED_ADMIN_IDS
pm2 start ecosystem.config.cjs && pm2 save
sudo nginx -t && sudo systemctl reload nginx    # activates the sites.wemeweb.com block
curl https://sites.wemeweb.com/health
```

The agent runs as the `ubuntu` user, which owns `/var/www`. No sudo is involved.

## Tests and CLI

```bash
npm run test:site-agent                  # from /etc/nginx/sites-available
npm run subdomain -- blog                # same rules as the API, without the UI
```
