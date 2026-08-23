// iRacing Data API client (runs only in CI / Node — never in the browser).
//
// Two auth paths, picked automatically:
//   1. OAuth2 "password limited flow" (preferred) — used when IRACING_CLIENT_ID
//      and IRACING_CLIENT_SECRET are set. This is iRacing's official script flow.
//      NOTE: the client_id/secret are NOT self-service — you must ask iRacing to
//      register a client (see README). Yields a short-lived Bearer token.
//   2. Legacy members-ng /auth (fallback) — just email + password, works today
//      with no client registration. Yields an authtoken cookie.
//
// In both flows the plaintext password never leaves this process: it is hashed
//   mask(value, id) = base64( sha256( value + lower(id) ) )
// before being sent — exactly what the iRacing UI / community loaders do.
//
// Most /data/* endpoints don't return the payload directly — they return
// { link } (a signed S3 URL) or a chunked descriptor. getData() resolves both.

import { createHash } from 'node:crypto';

const DATA_BASE = 'https://members-ng.iracing.com';
const OAUTH_TOKEN_URL = 'https://oauth.iracing.com/oauth2/token';

function mask(value, id) {
  return createHash('sha256')
    .update(`${value}${String(id).toLowerCase().trim()}`)
    .digest('base64');
}

export class IRacingClient {
  #cookie = null;
  #bearer = null;

  async login({ email, password, clientId, clientSecret } = {}) {
    if (!email || !password) {
      throw new Error('IRACING_EMAIL/IRACING_USERNAME and IRACING_PASSWORD must be set.');
    }
    if (clientId && clientSecret) {
      await this.#oauthLogin({ email, password, clientId, clientSecret });
    } else {
      await this.#legacyLogin({ email, password });
    }
    return this;
  }

  async #oauthLogin({ email, password, clientId, clientSecret }) {
    const body = new URLSearchParams({
      grant_type: 'password_limited',
      scope: 'iracing.auth',
      client_id: clientId,
      client_secret: mask(clientSecret, clientId),
      username: email,
      password: mask(password, email),
    });
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`OAuth token request failed: HTTP ${res.status} ${res.statusText} ${detail.slice(0, 200)}`);
    }
    const tok = await res.json();
    if (!tok.access_token) throw new Error('OAuth response had no access_token.');
    this.#bearer = tok.access_token;
    console.log('Authenticated via OAuth password-limited flow.');
  }

  async #legacyLogin({ email, password }) {
    const res = await fetch(`${DATA_BASE}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: mask(password, email) }),
    });
    if (!res.ok) {
      throw new Error(`iRacing legacy auth failed: HTTP ${res.status} ${res.statusText}`);
    }
    const b = await res.json().catch(() => ({}));
    if (b.authcode === 0 || b.authcode === '0') {
      const why = b.verificationRequired ? 'email verification / captcha required' : (b.message || 'invalid credentials');
      throw new Error(`iRacing legacy auth rejected: ${why}`);
    }
    const jar = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]);
    if (jar.length === 0) throw new Error('iRacing legacy auth returned no cookies.');
    this.#cookie = jar.join('; ');
    console.log('Authenticated via legacy members-ng /auth.');
  }

  #authHeaders() {
    if (this.#bearer) return { Authorization: `Bearer ${this.#bearer}` };
    if (this.#cookie) return { Cookie: this.#cookie };
    return {};
  }

  async #raw(path) {
    const url = path.startsWith('http') ? path : `${DATA_BASE}${path}`;
    const res = await fetch(url, { headers: this.#authHeaders() });
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after')) || 5;
      await sleep(retry * 1000);
      return this.#raw(path);
    }
    if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status} ${res.statusText}`);
    return res;
  }

  // Resolve the {link} / {chunk_info} indirection into concrete JSON.
  async getData(path) {
    const outer = await (await this.#raw(path)).json();
    if (outer && typeof outer.link === 'string') {
      const linked = await fetch(outer.link);
      if (!linked.ok) throw new Error(`link fetch failed: HTTP ${linked.status}`);
      return this.#maybeChunks(await linked.json());
    }
    return this.#maybeChunks(outer);
  }

  async #maybeChunks(payload) {
    const info = payload?.chunk_info ?? payload?.data?.chunk_info ?? null;
    if (!info || !Array.isArray(info.chunk_file_names) || info.chunk_file_names.length === 0) {
      return payload;
    }
    const rows = [];
    for (const name of info.chunk_file_names) {
      const res = await fetch(info.base_download_url + name);
      if (!res.ok) throw new Error(`chunk fetch failed: HTTP ${res.status}`);
      const part = await res.json();
      if (Array.isArray(part)) rows.push(...part);
    }
    return rows;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
