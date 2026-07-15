#!/usr/bin/env node
'use strict';

// Bouwt een CSV met de populairste websites volgens het Chrome UX Report (CrUX):
// de publieke maandelijkse export van Google's CrUX Top Lists (zakird/crux-top-lists),
// die origins rangschikt op basis van echte Chrome-bezoekdata.
//
//   exports/crux-top-10000.csv  — kolommen: rank, origin, domain
//
// LET OP: CrUX rangschikt niet op exacte bezoekaantallen maar in
// magnitude-buckets (1000 = top 1k, 5000 = top 5k, 10000 = top 10k, ...).
// Binnen een bucket is er geen fijnmazige volgorde; de `rank`-kolom is de bucket.
//
// Gebruik:  node scripts/export-crux-top.js [aantal] [uitvoermap]
//   aantal   = rank-drempel (standaard 10000; moet een CrUX-bucket zijn)
//   uitvoermap = standaard exports/ in de projectroot

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRUX_URL =
  'https://raw.githubusercontent.com/zakird/crux-top-lists/main/data/global/current.csv.gz';

function csvField(value) {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function originToDomain(origin) {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  }
}

async function main() {
  const threshold = parseInt(process.argv[2] || '10000', 10);
  const outDir = process.argv[3]
    ? path.resolve(process.argv[3])
    : path.resolve(__dirname, '..', 'exports');
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`CrUX Top Lists downloaden…`);
  const res = await fetch(CRUX_URL, {
    headers: { 'User-Agent': 'maflplus-favicon-api/crux-export' },
  });
  if (!res.ok) throw new Error(`Download mislukt: HTTP ${res.status}`);

  const gz = Buffer.from(await res.arrayBuffer());
  const csv = zlib.gunzipSync(gz).toString('utf8');
  const lines = csv.split('\n');

  // Kopregel: origin,rank
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const comma = line.lastIndexOf(',');
    if (comma < 0) continue;
    const origin = line.slice(0, comma).trim();
    const rank = parseInt(line.slice(comma + 1).trim(), 10);
    if (!origin || !Number.isFinite(rank)) continue;
    if (rank > threshold) continue;
    rows.push({ rank, origin, domain: originToDomain(origin) });
  }

  rows.sort((a, b) => a.rank - b.rank || a.origin.localeCompare(b.origin));

  const header = ['rank', 'origin', 'domain'];
  const out = [header.join(',')];
  for (const r of rows) {
    out.push(header.map((k) => csvField(r[k])).join(','));
  }

  const outPath = path.join(outDir, `crux-top-${threshold}.csv`);
  fs.writeFileSync(outPath, '\uFEFF' + out.join('\r\n') + '\r\n', 'utf8');
  console.log(`${rows.length} origins (rank <= ${threshold}) → ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
