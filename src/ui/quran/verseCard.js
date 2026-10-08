/**
 * verseCard — کارت نمایش آیه، فقط برای رابط درس (فاز ۴).
 *
 * قواعد نمایش:
 *   - متن آیه همیشه با کلاس `quran-text` (فونت قرآنی + اعراب کامل) رندر می‌شود.
 *   - برچسب «نمونه — جایگزین شود» و «در انتظار بازبینی» همیشه دیده می‌شود.
 *   - منبع (دیتاست/نسخه) زیر کارت می‌آید.
 *   - این کارت هرگز در دنیای سه‌بعدی، روی زمین/سازه یا افکت استفاده نمی‌شود؛
 *     تنها مصرف‌کنندگانش LessonRunner و پنل‌های رابط کاربری‌اند.
 */
import { el, faDigits } from '../dom.js';
import { verseBadges, verseReference } from '../../game/quran/QuranDataset.js';
import { isRecitationEnabled, playRecitation } from './RecitationAudio.js';

/** صوت فقط در صورت داشتن مجوز مشخص پخش می‌شود. */
function audioNode(verse) {
  const audio = verse.audio;
  if (audio && audio.playable) {
    const enabled = isRecitationEnabled();
    const btn = el('button', {
      className: `verse-card__audio${enabled ? ' is-enabled' : ''}`,
      attrs: {
        type: 'button',
        disabled: !enabled,
        title: enabled ? `مجوز صوت: ${audio.license}` : 'برای پخش تلاوت، آن را از تنظیمات فعال کنید',
      },
      text: enabled
        ? `🎧 پخش تلاوت${audio.reciter ? ` — ${audio.reciter}` : ''} (${audio.license})`
        : '🎧 تلاوت خاموش است — فعال‌سازی از تنظیمات',
    });
    btn.addEventListener('click', () => playRecitation(audio));
    return el('div', {
      className: 'verse-card__audio-group',
      children: [
        btn,
        el('a', {
          className: 'verse-card__license',
          attrs: { href: audio.licenseUrl, target: '_blank', rel: 'noopener noreferrer' },
          text: `مجوز صوت: ${audio.license}`,
        }),
      ],
    });
  }
  return el('button', {
    className: 'verse-card__audio',
    attrs: { type: 'button', disabled: true, title: 'صوت دارای مجوز ثبت نشده است' },
    text: '🎧 صوت دارای مجوز ثبت نشده است',
  });
}

/**
 * @param {object} verse — آیهٔ نرمال‌شده
 * @param {object} [options]
 * @param {boolean} [options.showTranslation]
 * @param {boolean} [options.showSource]
 * @param {boolean} [options.compact]
 * @returns {HTMLElement}
 */
export function verseCard(verse, { showTranslation = true, showSource = true, compact = false } = {}) {
  if (!verse) return el('div', { className: 'verse-card is-empty', text: 'آیه‌ای برای نمایش نیست.' });
  const badges = verseBadges(verse);

  const head = el('figcaption', {
    className: 'verse-card__head',
    children: [
      el('span', { className: 'verse-card__ref', text: verseReference(verse) }),
      ...badges.map((badge) => el('span', { className: `verse-badge verse-badge--${badge.kind}`, text: badge.label })),
    ],
  });

  const source = verse.source || {};
  const sourceLine = [
    source.datasetId ? `منبع: ${source.datasetId}` : null,
    source.version ? `نسخهٔ ${source.version}` : null,
    source.script ? `رسم ${source.script}` : null,
    source.license ? `مجوز ${source.license}` : null,
  ].filter(Boolean).join(' · ');

  return el('figure', {
    className: `verse-card${compact ? ' verse-card--compact' : ''}`,
    attrs: { 'data-verse-id': verse.id },
    children: [
      head,
      el('p', { className: 'quran-text', attrs: { dir: 'rtl', lang: 'ar' }, text: verse.textUthmani }),
      showTranslation ? el('p', { className: 'verse-card__translation', text: verse.translationFa }) : null,
      showSource
        ? el('footer', {
          className: 'verse-card__source',
          children: [
            el('span', { className: 'verse-card__source-line', text: sourceLine || 'منبع ثبت نشده' }),
            audioNode(verse),
          ],
        })
        : null,
    ],
  });
}

/** خط راهنمای «بدون جریمه» که در همهٔ مینی‌گیم‌ها تکرار می‌شود. */
export function noPenaltyNote(text = 'پاسخ نادرست جریمه ندارد؛ فقط دوباره نشان داده می‌شود.') {
  return el('p', { className: 'minigame__note', text });
}

/** شمارندهٔ فارسی مرحله‌ها. */
export function stepCounter(index, total) {
  return `مرحلهٔ ${faDigits(index + 1)} از ${faDigits(total)}`;
}
