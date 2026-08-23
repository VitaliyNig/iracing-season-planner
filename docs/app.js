// Static front-end. Reads the pre-built ./data.json (full schedule + catalog)
// and computes eligibility CLIENT-SIDE from your locally-stored owned content:
//   eligible = you own the week's track  AND  you own >=1 of the series' cars
// Free-with-subscription content counts as owned automatically. No iRacing calls.
//
// Layout: one collapsible row per week (accordion); expand a week to see the
// available series for it. Filters apply across every week.

const state = {
  data: null,
  expanded: new Set(),      // weekNums currently open
  freeCarPkgs: new Set(),
  freeTrackPkgs: new Set(),
  filters: {
    search: '', category: '',
    fixedOnly: false, openOnly: false, licenseOnly: false,
    ownedOnly: true,        // default: only count/show races you can enter
  },
};

const $ = (id) => document.getElementById(id);

async function load() {
  try {
    const res = await fetch('./data.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
  } catch (e) {
    $('meta').textContent = `Could not load data.json (${e.message}). Run the build once.`;
    return;
  }
  state.freeCarPkgs = new Set(state.data.catalog.cars.filter((c) => c.free).map((c) => c.packageId));
  state.freeTrackPkgs = new Set(state.data.catalog.tracks.filter((t) => t.free).map((t) => t.packageId));
  init();
}

function init() {
  const d = state.data;
  const built = d.generatedAt ? new Date(d.generatedAt).toLocaleString() : 'unknown';
  const modeNote = d.mode === 'pdf-fallback' ? ' · PDF fallback — full schedule, ownership unknown' : '';
  $('meta').textContent = `Built ${built}${modeNote}`;

  const cats = new Set();
  d.weeks.forEach((w) => w.series.forEach((s) => s.category && cats.add(s.category)));
  const sel = $('category');
  [...cats].sort().forEach((c) => {
    const o = document.createElement('option');
    o.value = c; o.textContent = pretty(c);
    sel.appendChild(o);
  });

  // Expand the current week by date, else the first.
  const now = Date.now();
  let cur = d.weeks.findIndex((w, i) => {
    const start = w.startDate ? Date.parse(w.startDate) : null;
    const next = d.weeks[i + 1]?.startDate ? Date.parse(d.weeks[i + 1].startDate) : Infinity;
    return start !== null && now >= start && now < next;
  });
  if (cur < 0) cur = 0;
  state.expanded.add(d.weeks[cur]?.weekNum ?? 0);

  $('search').addEventListener('input', (e) => { state.filters.search = e.target.value.toLowerCase(); render(); });
  sel.addEventListener('change', (e) => { state.filters.category = e.target.value; render(); });
  ['fixedOnly', 'openOnly', 'licenseOnly', 'ownedOnly'].forEach(bindChk);
  $('ownedOnly').checked = true;

  if (d.mode === 'pdf-fallback') {
    state.filters.ownedOnly = false;
    $('ownedOnly').checked = false;
    $('ownedOnly').disabled = true;
  }

  $('controls').hidden = false;
  buildAccordion();
  render();
}

function bindChk(id) {
  $(id).addEventListener('change', (e) => { state.filters[id] = e.target.checked; render(); });
}

// null when ownership can't be resolved (PDF fallback).
function eligibility(s) {
  if (state.data.mode === 'pdf-fallback') return { eligible: null };
  const ownedCars = window.Owned.effective('cars', [...state.freeCarPkgs]);
  const ownedTracks = window.Owned.effective('tracks', [...state.freeTrackPkgs]);
  const ownTrack = s.track.packageId != null && ownedTracks.has(s.track.packageId);
  const myCars = s.carNames.filter((_, i) => ownedCars.has(s.carPackageIds[i]));
  return { eligible: ownTrack && myCars.length > 0, ownTrack, myCars };
}

function licenseOk(s) {
  if (s.minLicense == null || s.categoryId == null) return null;
  const mine = state.data.myLicenses?.[s.categoryId];
  if (mine == null) return null;
  return mine >= s.minLicense;
}

// Which series in a week survive the current filters (with their computed state).
function filteredSeries(week) {
  const f = state.filters;
  const rows = [];
  let eligibleTotal = 0;
  for (const s of week.series) {
    const el = eligibility(s);
    if (el.eligible) eligibleTotal++;
    const lic = licenseOk(s);
    if (f.ownedOnly && el.eligible === false) continue;
    if (f.category && s.category !== f.category) continue;
    if (f.fixedOnly && !s.fixed) continue;
    if (f.openOnly && s.fixed) continue;
    if (f.licenseOnly && lic === false) continue;
    if (f.search && !`${s.series} ${s.track.name}`.toLowerCase().includes(f.search)) continue;
    rows.push({ s, el, lic });
  }
  return { rows, eligibleTotal };
}

// Build the static accordion skeleton once; render() fills bodies + counts.
function buildAccordion() {
  const acc = $('accordion');
  acc.innerHTML = '';
  for (const w of state.data.weeks) {
    const item = document.createElement('section');
    item.className = 'wk';
    item.dataset.week = String(w.weekNum);

    const head = document.createElement('button');
    head.className = 'wk-head';
    head.setAttribute('aria-expanded', 'false');
    head.addEventListener('click', () => {
      if (state.expanded.has(w.weekNum)) state.expanded.delete(w.weekNum);
      else state.expanded.add(w.weekNum);
      render();
    });

    const label = document.createElement('span');
    label.className = 'wk-label';
    label.textContent = `WEEK ${w.weekNum + 1}`;

    const date = document.createElement('span');
    date.className = 'wk-date';
    date.textContent = w.startDate ? new Date(w.startDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';

    const count = document.createElement('span');
    count.className = 'wk-count';

    const chev = document.createElement('span');
    chev.className = 'wk-chev';
    chev.textContent = '▾';

    head.append(label, date, count, chev);
    const body = document.createElement('div');
    body.className = 'wk-body grid';

    item.append(head, body);
    acc.appendChild(item);
  }
}

function render() {
  const d = state.data;
  let grandEligible = 0;

  for (const item of $('accordion').children) {
    const weekNum = Number(item.dataset.week);
    const week = d.weeks.find((w) => w.weekNum === weekNum);
    const { rows, eligibleTotal } = filteredSeries(week);
    grandEligible += eligibleTotal;

    const open = state.expanded.has(weekNum);
    const head = item.querySelector('.wk-head');
    head.setAttribute('aria-expanded', String(open));
    item.classList.toggle('open', open);

    const count = item.querySelector('.wk-count');
    count.textContent = d.mode === 'pdf-fallback'
      ? `${rows.length} series`
      : `${eligibleTotal} available`;
    count.classList.toggle('zero', d.mode !== 'pdf-fallback' && eligibleTotal === 0);

    const body = item.querySelector('.wk-body');
    body.hidden = !open;
    if (!open) { body.innerHTML = ''; continue; }
    body.innerHTML = '';
    if (rows.length === 0) {
      const p = document.createElement('p');
      p.className = 'status empty';
      p.textContent = 'Nothing matches. Set your content, or turn off “Available only”.';
      body.appendChild(p);
    } else {
      for (const r of rows) body.appendChild(card(r));
    }
  }

  $('status').textContent = d.mode === 'pdf-fallback'
    ? 'Full schedule (PDF fallback) — expand a week. Ownership can’t be resolved in this mode.'
    : `${grandEligible} races available to you this season · you own ${window.Owned.count('cars')} cars, ${window.Owned.count('tracks')} tracks (+ free).`;
}

function card({ s, el, lic }) {
  const c = document.createElement('article');
  c.className = 'card' + (el.eligible === false ? ' locked' : '');

  const h = document.createElement('h3');
  h.textContent = s.series;
  c.appendChild(h);
  c.appendChild(kv('Track', s.track.name));

  const badges = document.createElement('div');
  badges.className = 'badges';
  if (s.category && s.category !== 'other') badges.appendChild(badge(pretty(s.category), 'cat'));
  badges.appendChild(badge(s.fixed ? 'Fixed' : 'Open'));
  if (el.eligible === true) badges.appendChild(badge('Available', 'ok'));
  if (el.eligible === false) badges.appendChild(badge(!el.ownTrack ? 'Track not owned' : 'Car not owned', 'lock'));
  if (lic === false) badges.appendChild(badge('License too low', 'lock'));
  c.appendChild(badges);

  if (el.eligible !== null) {
    const cars = document.createElement('div');
    cars.className = 'cars';
    if (el.myCars?.length) cars.innerHTML = `Your car: <strong>${el.myCars.map(esc).join(', ')}</strong>`;
    else cars.textContent = `You own none of the ${s.carNames.length} eligible car(s).`;
    c.appendChild(cars);
  }
  return c;
}

function kv(k, v) {
  const r = document.createElement('div');
  r.className = 'row';
  r.innerHTML = `<span class="k">${k}</span><span>${esc(v)}</span>`;
  return r;
}
function badge(text, cls = '') {
  const b = document.createElement('span');
  b.className = 'badge' + (cls ? ' ' + cls : '');
  b.textContent = text;
  return b;
}
function pretty(s) {
  return String(s).replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

load();
