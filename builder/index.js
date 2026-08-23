// CI entry point. Logs into iRacing, pulls catalogs + schedules, and writes a
// SINGLE static docs/data.json containing the full weekly schedule + content
// catalog. Ownership is NOT applied here — the browser filters by the viewer's
// locally-stored owned content, so changing what you own never needs a rebuild.
//
// If the API is unreachable, it falls back to parsing data/SeasonSchedule.pdf so
// the site still shows the schedule (car/track package ids unknown in that mode,
// so the front-end can't compute eligibility and shows the full list).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { IRacingClient } from './iracing.js';
import { buildIndexes, buildCatalog, buildWeeks } from './availability.js';
import { parseSchedule, looksLikeJunkName } from './pdf.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const PDF_PATH = resolve(REPO, 'data/SeasonSchedule.pdf');
const OUT_PATH = resolve(REPO, 'docs/data.json');

function memberLicenses(memberInfo) {
  const raw = memberInfo?.licenses || memberInfo?.member_info?.licenses || [];
  const list = Array.isArray(raw) ? raw : Object.values(raw);
  const out = {};
  for (const l of list) if (l.category_id != null) out[l.category_id] = l.group_id ?? null;
  return out; // { categoryId: groupId }
}

async function fromApi() {
  const client = new IRacingClient();
  await client.login({
    email: process.env.IRACING_EMAIL || process.env.IRACING_USERNAME,
    password: process.env.IRACING_PASSWORD,
    clientId: process.env.IRACING_CLIENT_ID,
    clientSecret: process.env.IRACING_CLIENT_SECRET,
  });
  console.log('Pulling catalogs…');

  const [seasons, cars, tracks, carClasses, memberInfo] = await Promise.all([
    client.getData('/data/series/seasons?include_series=true'),
    client.getData('/data/car/get'),
    client.getData('/data/track/get'),
    client.getData('/data/carclass/get'),
    client.getData('/data/member/info'),
  ]);
  const seasonArr = Array.isArray(seasons) ? seasons : seasons.seasons || [];
  console.log(
    `Pulled: ${seasonArr.length} seasons, ${cars.length} cars, ${tracks.length} tracks, ${carClasses.length} car classes.`,
  );

  const indexes = buildIndexes({ cars, tracks, carClasses });
  return {
    generatedAt: new Date().toISOString(),
    mode: 'api',
    myLicenses: memberLicenses(memberInfo),
    catalog: buildCatalog({ cars, tracks }),
    weeks: buildWeeks({ seasons: seasonArr, indexes }),
  };
}

// Season 3 week 0 begins here; the fallback buckets rows into a 13-week window
// by date, which drops the PDF's off-season / full-year noise rows.
const SEASON3_START = Date.parse('2026-06-16T00:00:00Z');
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function fromPdf() {
  console.log('Falling back to PDF parse (eligibility unknown; showing full schedule).');
  const series = parseSchedule(PDF_PATH).filter((s) => !looksLikeJunkName(s.series));
  const weeks = new Map();
  for (const s of series) {
    for (const w of s.weeks) {
      const wk = Math.round((Date.parse(w.startDate) - SEASON3_START) / WEEK_MS);
      if (wk < 0 || wk > 12) continue;
      if (!weeks.has(wk)) weeks.set(wk, []);
      weeks.get(wk).push({
        series: s.series,
        category: 'other',
        fixed: /fixed/i.test(s.series),
        track: { name: w.track, packageId: null },
        carPackageIds: [],
        carNames: [],
        categoryId: null,
        minLicense: null,
        startDate: w.startDate,
      });
    }
  }
  const weekList = [...weeks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([weekNum, ss]) => ({
      weekNum,
      startDate: ss.find((x) => x.startDate)?.startDate || null,
      series: ss.sort((a, b) => a.series.localeCompare(b.series)),
    }));
  return {
    generatedAt: new Date().toISOString(),
    mode: 'pdf-fallback',
    myLicenses: {},
    catalog: { cars: [], tracks: [] },
    weeks: weekList,
  };
}

async function main() {
  let result;
  try {
    result = await fromApi();
  } catch (e) {
    console.error(`API path failed: ${e.message}`);
    if (!existsSync(PDF_PATH)) throw e;
    result = fromPdf();
  }
  writeFileSync(OUT_PATH, JSON.stringify(result));
  const totalSeries = result.weeks.reduce((a, w) => a + w.series.length, 0);
  console.log(
    `Wrote ${OUT_PATH} — mode=${result.mode}, weeks=${result.weeks.length}, ` +
      `series-entries=${totalSeries}, catalog cars=${result.catalog.cars.length} tracks=${result.catalog.tracks.length}.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
