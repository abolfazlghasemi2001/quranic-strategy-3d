#!/usr/bin/env node
/**
 * build-quran.mjs — تبدیل فایل‌های متنی Tanzil به public/quran/quran.json
 *
 * استفاده:
 *   node tools/build-quran.mjs [uthmani.txt] [translation.txt] [out.json]
 *
 * پیش‌فرض‌ها:
 *   tools/tanzil/quran-uthmani.txt
 *   tools/tanzil/fa_gharaati.txt
 *   public/quran/quran.json
 *
 * قاعدهٔ شرایط استفادهٔ Tanzil: متن نباید تغییر کند. این اسکریپت فقط «قالب» را عوض می‌کند
 * (سطر «سوره|آیه|متن» ← JSON) و بلوک حق نشر را در meta نگه می‌دارد.
 * در پایان، JSON ساخته‌شده دوباره به سطرهای Tanzil برگردانده و با فایل اصلی مقایسه می‌شود.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const [, , uthmaniPath = 'tools/tanzil/quran-uthmani.txt', translationPath = 'tools/tanzil/fa_gharaati.txt', outPath = 'public/quran/quran.json'] = process.argv;

const DIACRITICS_RE = /[\u064B-\u065F\u0670\u06D6-\u06ED]/;

function read(path) {
  return readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
}

/** سطرهای «سوره|آیه|متن» و بلوک توضیحات (#) را جدا می‌کند. */
function parse(path) {
  const verses = new Map();
  const comments = [];
  const order = [];
  for (const line of read(path)) {
    if (line.startsWith('#')) { comments.push(line); continue; }
    if (!line.trim()) continue;
    const m = /^(\d+)\|(\d+)\|(.*)$/.exec(line);
    if (!m) throw new Error(`سطر نامعتبر در ${path}: ${line.slice(0, 60)}`);
    const key = `${Number(m[1])}:${Number(m[2])}`;
    if (verses.has(key)) throw new Error(`آیهٔ تکراری ${key} در ${path}`);
    verses.set(key, m[3]);
    order.push([Number(m[1]), Number(m[2]), m[0]]);
  }
  return { verses, comments, order };
}

const uth = parse(uthmaniPath);
const tr = parse(translationPath);

// ــ تطبیق دو فایل
if (uth.verses.size !== tr.verses.size) throw new Error(`تعداد آیه‌ها برابر نیست: ${uth.verses.size} ≠ ${tr.verses.size}`);
for (const key of uth.verses.keys()) if (!tr.verses.has(key)) throw new Error(`ترجمهٔ ${key} نیست`);

// ــ گروه‌بندی سوره‌ها (شماره‌ها باید پیوسته باشند)
const surahMap = new Map();
for (const [s, a] of uth.order) {
  if (!surahMap.has(s)) surahMap.set(s, []);
  surahMap.get(s).push(a);
}
const surahIndexes = [...surahMap.keys()];
surahIndexes.forEach((s, i) => { if (s !== i + 1) throw new Error(`شمارهٔ سوره ناپیوسته: ${s}`); });
for (const [s, list] of surahMap) list.forEach((a, i) => { if (a !== i + 1) throw new Error(`شمارهٔ آیه ناپیوسته در سورهٔ ${s}: ${a}`); });

const strip = (lines) => lines.map((l) => l.replace(/^#\s?/, '')).join('\n').trim();

const meta = {
  datasetId: 'tanzil-uthmani-1.1',
  title: 'قرآن کریم — رسم عثمانی (Uthmani) با ترجمهٔ قرائتی',
  version: '1.1',
  script: 'uthmani',
  scriptVariant: 'uthmani',
  source: 'Tanzil.net',
  sourceUrl: 'https://tanzil.net/',
  license: 'Creative Commons Attribution 3.0',
  translator: 'محسن قرائتی (Mohsen Gharaati) — fa.gharaati — Tanzil.net — آخرین به‌روزرسانی ۱۱ آوریل ۲۰۲۲',
  reviewed: false,
  placeholder: false,
  status: 'external-unreviewed',
  audio: { note: 'صوت فقط با مجوز مشخص پخش می‌شود. در این دیتاست صوتی نیست.' },
  copyrightNotice: strip(uth.comments),
  translationNotice: strip(tr.comments),
};

// ــ خروجی: هر آیه در یک سطر (برای diff خوانا و حجم کم)
const parts = [];
parts.push('{\n  "meta": ' + JSON.stringify(meta, null, 2).replace(/\n/g, '\n  ') + ',\n  "surahs": [\n');
const surahChunks = [];
for (const [s, list] of surahMap) {
  const ayahLines = list.map((a) =>
    '        ' + JSON.stringify({ index: a, textUthmani: uth.verses.get(`${s}:${a}`), translationFa: tr.verses.get(`${s}:${a}`) }));
  surahChunks.push(
    `    {\n      "index": ${s},\n      "name": ${JSON.stringify(`سورهٔ ${s}`)},\n      "namePlaceholder": true,\n      "ayahCount": ${list.length},\n      "ayahs": [\n${ayahLines.join(',\n')}\n      ]\n    }`);
}
parts.push(surahChunks.join(',\n'));
parts.push('\n  ]\n}\n');
const output = parts.join('');

// ــ راستی‌آزمایی: برگرداندن JSON به سطرهای Tanzil و مقایسهٔ کلمه‌به‌کلمه با فایل‌های اصلی
const back = JSON.parse(output);
let count = 0;
let noDiacritics = 0;
for (const surah of back.surahs) {
  for (const ayah of surah.ayahs) {
    count += 1;
    const key = `${surah.index}:${ayah.index}`;
    if (ayah.textUthmani !== uth.verses.get(key)) throw new Error(`عدم تطابق متن عثمانی ${key}`);
    if (ayah.translationFa !== tr.verses.get(key)) throw new Error(`عدم تطابق ترجمه ${key}`);
    if (!ayah.textUthmani.trim() || !ayah.translationFa.trim()) throw new Error(`متن یا ترجمهٔ خالی ${key}`);
    if (!DIACRITICS_RE.test(ayah.textUthmani)) noDiacritics += 1;
  }
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, output, 'utf8');
console.log(`OK: ${back.surahs.length} سوره، ${count} آیه → ${outPath} (${(Buffer.byteLength(output) / 1024).toFixed(0)} KB)`);
console.log(`آیه‌های بدون علامت اعرابِ بازهٔ اعتبارسنج بازی: ${noDiacritics}`);
