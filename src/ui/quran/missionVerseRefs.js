/**
 * verseRefs — نمایش «ارجاع» آیه‌های یک مأموریت (فاز ۶).
 *
 * قاعدهٔ محتوایی (نقض‌نشدنی):
 *   • متن آیه هرگز در کد یا دادهٔ مأموریت نوشته نمی‌شود؛ فقط شناسهٔ آیه
 *     (`ayah:سوره:آیه`) در missions.json است.
 *   • اگر آیه در دیتاست قرآنی موجود باشد، متن از همان دیتاست خوانده و با
 *     `verseCard` (فونت قرآنی + اعراب کامل + برچسب‌ها + منبع) رندر می‌شود.
 *   • اگر نباشد، فقط ارجاع (سوره:آیه) با برچسب «نیازمند بازبینی» نشان داده
 *     می‌شود و هیچ متنی از حافظه نوشته نمی‌شود.
 *   • این کارت‌ها فقط در رابط می‌آیند: هرگز روی زمین، سازه یا افکت سه‌بعدی.
 */
import { el, faDigits } from '../dom.js';
import { verseCard } from './verseCard.js';
import { toFaDigits } from '../../game/quran/QuranDataset.js';

/** برچسب کوتاه ارجاع: «سورهٔ یوسف ۱۲:۴۷». */
export function refLabel(ref, mission) {
  const surah = mission?.qasas?.surahName || ref.surahName || 'سوره';
  return `${surah} ${toFaDigits(ref.surahIndex)}:${toFaDigits(ref.ayahIndex)}`;
}

/** کارت یک ارجاع: متن از دیتاست، یا فقط ارجاع. */
export function verseRefCard({ dataset, mission, refId, campaignData }) {
  const ref = (mission?.refs || [])
    .map((id) => {
      const match = /^ayah:(\d+):(\d+)$/.exec(id);
      return match ? { id, surahIndex: Number(match[1]), ayahIndex: Number(match[2]), surahName: mission.qasas?.surahName || '' } : null;
    })
    .find((entry) => entry && entry.id === refId);
  const verse = dataset?.verses?.get(refId) || null;

  if (verse) {
    return el('div', {
      className: 'mission-ref mission-ref--dataset',
      children: [
        el('div', {
          className: 'mission-ref__head',
          children: [
            el('span', { className: 'mission-ref__label', text: ref ? refLabel(ref, mission) : refId }),
            el('span', { className: 'verse-badge verse-badge--dataset', text: 'متن از دیتاست قرآنی' }),
          ],
        }),
        verseCard(verse, { compact: true, showTranslation: true, showSource: true }),
      ],
    });
  }

  const missing = campaignData?.fallback || {};
  return el('div', {
    className: 'mission-ref mission-ref--missing',
    children: [
      el('div', {
        className: 'mission-ref__head',
        children: [
          el('span', { className: 'mission-ref__label', text: ref ? refLabel(ref, mission) : refId }),
          el('span', { className: 'verse-badge verse-badge--pending', text: missing.missingVerseBadge || 'ارجاع — نیازمند بازبینی' }),
        ],
      }),
      el('p', {
        className: 'mission-ref__note',
        text: missing.missingVerseNote
          || 'متن این ارجاع در دیتاست فعلی نیست؛ فقط ارجاع (سوره:آیه) نمایش داده می‌شود.',
      }),
    ],
  });
}

/** فهرست کامل ارجاع‌های یک مأموریت. */
export function verseRefList({ dataset, mission, campaignData }) {
  const refs = mission?.refs || [];
  if (!refs.length) return el('div', { className: 'mission-refs is-empty', text: 'ارجاعی برای این مأموریت ثبت نشده است.' });
  const withVerse = refs.filter((id) => dataset?.verses?.get(id)).length;
  return el('section', {
    className: 'mission-refs',
    children: [
      el('h4', {
        className: 'mission-refs__title',
        children: [
          el('span', { text: 'ارجاع آیه‌ها (از دیتاست)' }),
          el('span', {
            className: `hub-chip ${withVerse === refs.length ? 'is-ok' : 'is-pending'}`,
            text: `${faDigits(withVerse)} از ${faDigits(refs.length)} در دیتاست فعلی`,
          }),
        ],
      }),
      ...refs.map((id) => verseRefCard({ dataset, mission, refId: id, campaignData })),
    ],
  });
}

/** سطر روایت + نشان ارجاع آن سطر (بدون هیچ متن آیه). */
export function narrativeLine({ mission, line }) {
  const ref = (mission?.refs || []).find((id) => id === line.ref) || null;
  const match = ref ? /^ayah:(\d+):(\d+)$/.exec(ref) : null;
  const label = match
    ? `${mission.qasas?.surahName || 'سوره'} ${toFaDigits(Number(match[1]))}:${toFaDigits(Number(match[2]))}`
    : null;
  return el('p', {
    className: 'mission-line',
    children: [
      el('span', { className: 'mission-line__text', text: line.text }),
      label ? el('span', { className: 'mission-line__ref', text: `→ ${label}` }) : null,
    ],
  });
}

export { toFaDigits };
