import { createHash } from 'node:crypto';
import { SiteError } from './sites.js';

const QUERY = '{ administrator { _id username } }';

/**
 * Accepts a request only when Rura says the bearer token belongs to an admin. Rura stays the one
 * place that knows tokens, expiry and blocked admins; nothing from Rura is copied to this server.
 * Answers are cached for a short time so a page load does not call Rura for every request.
 */
export function createRuraAuth({ url, allowedAdminIds = [], ttlMs = 60_000, fetchImpl = fetch }) {
  const allowed = new Set(allowedAdminIds);
  const cache = new Map();

  return async function authenticate(authorization) {
    const token = /^Bearer (.+)$/i.exec(authorization ?? '')?.[1];
    if (!token) throw new SiteError(401, 'Log in to the BackOffice first.');

    const key = createHash('sha256').update(token).digest('hex');
    let admin = cache.get(key);
    if (!admin || admin.expires < Date.now()) {
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'apollo-require-preflight': 'true',
            authorization: `Bearer ${token}`,
            'auth-user': 'Admin'
          },
          body: JSON.stringify({ query: QUERY }),
          signal: AbortSignal.timeout(8000)
        });
      } catch {
        throw new SiteError(502, 'Cannot reach the login service. Try again.');
      }
      if (response.status >= 500) throw new SiteError(502, 'The login service is not available. Try again.');

      const body = await response.json().catch(() => null);
      const found = body?.data?.administrator;
      if (!found?._id) throw new SiteError(401, 'Your login has expired. Log in again.');

      admin = { _id: String(found._id), username: found.username, expires: Date.now() + ttlMs };
      if (cache.size >= 500) cache.clear();
      cache.set(key, admin);
    }

    if (allowed.size && !allowed.has(admin._id)) {
      throw new SiteError(403, 'Your admin account is not allowed to manage sites.');
    }
    return admin;
  };
}
