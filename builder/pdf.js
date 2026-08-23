// Offline parser for the official "Current iRacing Race Schedule" PDF.
//
// This is the FALLBACK / cross-check source. The Data API (ID-based) is
// authoritative; the PDF only gives a car *class* name, not exact car ids,
// so it can't drive ownership matching on its own — but it's handy when the
// API is unreachable and for sanity-checking the API's week/track list.
//
// Extraction is dependency-free: PDF content streams are FlateDecode'd with
// zlib, then text is pulled from `( … )` string literals. The layout of each
// series block was reverse-engineered from the real file:
//
//   <Series Name> - 2026 Season 3 [Fixed|Open]
//   <Car class + license range>          e.g. "Late Model Stock Class D 4.0 --> ..."
//   <session timing line>
//   <week row> x N:  START-DATE\ Track Name  RACE-DATE HH:MM Nx\ weather…. laps

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const STREAM_RE = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
const PAREN_RE = /\(([^()]*)\)/g;
// A single weekly race row. Trailing "…NN laps" is grabbed best-effort within
// the same row (bounded so it can't bleed into the next week).
const ROW_RE = /(\d{4}-\d{2}-\d{2})\\?\s+(.+?)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(\d+)x(?:[^]{0,220}?(\d+)\s+laps)?/g;
// A series header ("... - 2026 Season 3", with optional Fixed/Open suffix).
const HDR_RE = /([A-Za-z0-9][A-Za-z0-9 '&.,!\/\-]{2,70}?) - 2026 Season(?: 3)?(?: - Fixed| Fixed| - Open| Open)?/g;

export function extractPdfText(pdfPath) {
  const data = readFileSync(pdfPath);
  const parts = [];
  const buf = data.toString('latin1');
  let m;
  while ((m = STREAM_RE.exec(buf)) !== null) {
    const raw = Buffer.from(m[1], 'latin1');
    let dec;
    try {
      dec = inflateSync(raw);
    } catch {
      continue; // not a flate stream (image, etc.)
    }
    const text = dec.toString('latin1');
    let t;
    while ((t = PAREN_RE.exec(text)) !== null) parts.push(t[1]);
  }
  return parts.join(' ');
}

// Returns [{ series, weeks: [{ startDate, track, raceDate, time, laps }] }].
export function parseSchedule(pdfPath) {
  const text = extractPdfText(pdfPath);

  // Collect header + row hits with their positions, then walk in document order.
  const tokens = [];
  let m;
  HDR_RE.lastIndex = 0;
  while ((m = HDR_RE.exec(text)) !== null) {
    tokens.push({ i: m.index, type: 'hdr', name: cleanName(m[1]) });
  }
  ROW_RE.lastIndex = 0;
  while ((m = ROW_RE.exec(text)) !== null) {
    tokens.push({
      i: m.index,
      type: 'row',
      startDate: m[1],
      // Cut a trailing per-week car list (comma-separated) that some GT3/multi-
      // class rows append after the track name; track configs have no commas.
      track: m[2].replace(/\\/g, '').split(',')[0].trim(),
      raceDate: m[3],
      time: m[4],
      mult: Number(m[5]),
      laps: Number(m[6]),
    });
  }
  tokens.sort((a, b) => a.i - b.i);

  const series = [];
  let current = null;
  const byName = new Map();
  for (const tok of tokens) {
    if (tok.type === 'hdr') {
      // Header appears once in the table of contents and once in the body.
      // The TOC copies precede every row, so overwriting `current` there is
      // harmless — only the body copy (followed by rows) collects weeks.
      if (byName.has(tok.name)) {
        current = byName.get(tok.name);
      } else {
        current = { series: tok.name, weeks: [] };
        byName.set(tok.name, current);
        series.push(current);
      }
    } else if (tok.type === 'row' && current) {
      current.weeks.push({
        startDate: tok.startDate,
        track: tok.track,
        raceDate: tok.raceDate,
        time: tok.time,
        mult: tok.mult,
        laps: tok.laps,
      });
    }
  }
  // Keep only series that actually gathered week rows (drops pure-TOC noise).
  return series.filter((s) => s.weeks.length > 0);
}

function cleanName(s) {
  let n = s.replace(/\s+/g, ' ').trim();
  // The lazy header match can begin inside the previous week's sentence
  // ("… tire sets 110 laps 23 NASCAR …"); cut everything up to the last such
  // boundary token so only the real series name remains.
  n = n.replace(/^.*?(?:\d+\s+laps|\d+\s+mins|incidents\.?|tire sets|scrutiny[^.]*\.|Drops:\s*\d+)\s*\d*\s*/i, '');
  n = n.replace(/^[\d.\s]+/, '').trim();
  return n;
}

// True when a header name still looks like leaked sentence text, not a series.
export function looksLikeJunkName(n) {
  return n.length < 3 || /\b(laps|mins|incidents|tire sets|penalties|scrutiny)\b/i.test(n);
}
