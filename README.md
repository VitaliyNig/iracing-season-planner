# iRacing Season Planner

Helper that shows, **week by week**, which official iRacing series you can actually
race this season — the ones where you own the week's **track** *and* at least one of
the series' **cars**. Free-with-subscription content counts as owned.

**GitHub Actions** logs into iRacing and builds a static `docs/data.json` (full
schedule + content catalog). **GitHub Pages** serves a filterable weekly grid.
Which content *you* own is picked in the browser and stored locally — so changing
your owned content is instant and never needs a rebuild. No iRacing login happens
in the page.

## Why it's built this way

- **iRacing has no "owned content" API.** Verified against the current Data API and
  every comparable open-source planner — they all have you pick owned cars/tracks
  by hand. The login is only ever used to download the *schedule/catalog*.
- **A static page can't log into iRacing** (no CORS, nowhere safe for a secret), so
  the login runs **server-side in GitHub Actions** using repo Secrets.
- **Ownership is client-side.** The build ships the whole schedule + catalog; the
  browser filters by your locally-stored picks. Same model the reference apps use.

## Setup

1. **Create a repo** (public → free Actions + Pages) and push these files.
2. **Add iRacing credentials as Actions secrets**
   (*Settings → Secrets and variables → Actions*):
   - `IRACING_EMAIL`, `IRACING_PASSWORD` — always required.
   - `IRACING_CLIENT_ID`, `IRACING_CLIENT_SECRET` — *optional*. Set these to use the
     official **OAuth password-limited flow**. That flow needs a client registered
     with iRacing (not self-service — email them; it must allow < 3 users). Without
     them, the builder uses the legacy `/auth` login automatically.

   You add these yourself — they're only read by the CI job, never shipped to the page.
3. **Enable Pages**: *Settings → Pages → Deploy from a branch → `main` / `/docs`*.
4. **Run the build**: *Actions → “Build season data” → Run workflow*. It writes
   `docs/data.json` and commits it; Pages then serves the site.
5. **Pick your content**: open `https://<you>.github.io/<repo>/content-picker.html`,
   tick your paid cars/tracks. Saved instantly in your browser — no commit, no rebuild.
   Free content is always included.

Open the site → it defaults to the current week and shows only what you can enter;
toggle **Available only** off to see everything, and use the category / fixed-open /
license / search filters.

## How it works

```
iRacing Data API ─┐
                  ├─> builder/ (Node, in CI) ─> docs/data.json ──> docs/ site (Pages)
SeasonSchedule.pdf┘        (fallback if API down)                    owned picks: localStorage
```

- `builder/iracing.js` — auth (OAuth password-limited flow, or legacy `/auth`
  fallback) + Data API fetch (handles `{link}` / chunked responses). The plaintext
  password is SHA-256+base64 masked before sending, in both flows.
- `builder/availability.js` — turns the catalog + schedules into per-week series with
  each week's track package_id and the eligible car package_ids.
- `builder/pdf.js` — dependency-free parser for `data/SeasonSchedule.pdf`, an offline
  fallback (no package ids, so eligibility is unknown in that mode).
- `docs/owned.js` — the localStorage owned-content store (shared by both pages).
- `docs/app.js` — computes `eligible = own track AND own ≥1 car` in the browser.
- `docs/content-picker.html` — interactive owned-content editor.

## Run locally

```bash
cd builder
# legacy auth (email + password only):
IRACING_EMAIL=you@example.com IRACING_PASSWORD=secret node index.js
# or OAuth password-limited flow (needs a registered client):
IRACING_EMAIL=... IRACING_PASSWORD=... IRACING_CLIENT_ID=... IRACING_CLIENT_SECRET=... node index.js
# or, with no credentials, it falls back to parsing the committed PDF:
node index.js
cd ../docs && npx serve .
```

## Notes / limits

- Owned content lives in the browser (localStorage), so it's per-device. Re-pick on a
  new browser, or (future) wire up a sync backend.
- Legacy `/auth` is unofficial; the OAuth flow is the official path but needs a
  registered client. Auth is isolated in `iracing.js`.
- License-eligibility is best-effort, shown as a filter and reported as unknown when
  it can't be resolved.
- Storing credentials as GitHub Secrets is the trade-off for a zero-touch build. Use a
  repo you control. Credentials are never entered by anyone but you.
