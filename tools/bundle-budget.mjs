#!/usr/bin/env node
/** Measures ALL statically imported initial JavaScript, not just the small entry facade. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { gzipSync, brotliCompressSync } from 'node:zlib';
const manifest = JSON.parse(readFileSync('dist/.vite/manifest.json', 'utf8'));
const initial = new Set();
function walk(key) { if (initial.has(key)) return; initial.add(key); for (const dependency of manifest[key]?.imports || []) walk(dependency); }
walk('index.html');
const files = Object.entries(manifest).filter(([, item]) => item.file.endsWith('.js')).map(([key, item]) => {
  const bytes = readFileSync(`dist/${item.file}`);
  return { file: item.file, name: item.name, initial: initial.has(key), bytes: bytes.length, gzipBytes: gzipSync(bytes).length, brotliBytes: brotliCompressSync(bytes).length };
});
const initialGzipBytes = files.filter((item) => item.initial).reduce((total, item) => total + item.gzipBytes, 0);
const report = { date: '2026-10-09', method: 'Vite manifest static-import graph + Node zlib gzip, decimal kB. Optional modules/idle fetches are reported separately.', baselineGzipBytes: 328160, requestedHistoricBaselineBytes: 288600, targetBytes: 202020, initialGzipBytes, reductionVsActualBaselinePercent: (1 - initialGzipBytes / 328160) * 100, reductionVsHistoricBaselinePercent: (1 - initialGzipBytes / 288600) * 100, totalGzipBytes: files.reduce((sum, file) => sum + file.gzipBytes, 0), files };
const index = process.argv.indexOf('--out');
if (index >= 0) { const out = process.argv[index + 1]; mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(report, null, 2) + '\n'); }
console.log(`Initial JS: ${(initialGzipBytes / 1000).toFixed(2)} kB gzip / target ≤202.02 kB. Actual baseline reduction ${report.reductionVsActualBaselinePercent.toFixed(2)}%; historical reduction ${report.reductionVsHistoricBaselinePercent.toFixed(2)}%.`);
if (initialGzipBytes > report.targetBytes) process.exitCode = 1;
if (files.some((item) => item.initial && ['battle', 'quran', 'PanelsFeature'].includes(item.name))) { console.error('Optional feature leaked into the initial static graph.'); process.exitCode = 1; }
