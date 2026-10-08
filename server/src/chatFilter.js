/**
 * Persian chat filter: normalise Arabic-script variants, then mask blocked
 * tokens. Data-driven — the word list lives in src/data/social.json and this
 * module never hardcodes any word.
 *
 * Normalisation handles the usual evasions: Arabic ي/ك, diacritics, tatweel,
 * zero-width joiners and stretched letters («جــنــده» → «جنده»).
 */

const ARABIC_YEH = /[يى]/g;
const ARABIC_KEH = /[كک]/g;
/* eslint-disable no-misleading-character-class */
const DIACRITICS = /[ً-ٰٟـ]/g;
const ZERO_WIDTH = /[‌‍]/g;
const REPEATS = /(.)\1{2,}/g;

/** Canonical form used ONLY for matching (the original text keeps its shape). */
export function normalizeForMatch(text) {
  return String(text || '')
    .replace(ARABIC_YEH, 'ی')
    .replace(ARABIC_KEH, 'ک')
    .replace(/ة/g, 'ه')
    .replace(DIACRITICS, '')
    .replace(ZERO_WIDTH, '')
    .replace(REPEATS, '$1')
    .toLowerCase();
}

/** Collapse whitespace/control characters and enforce the length cap. */
export function cleanChatText(text, { maxLength = 280 } = {}) {
  if (typeof text !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, Math.max(0, maxLength));
}

/**
 * @param {string} text — raw client text
 * @param {object} options — { wordlist:string[], mask:string, maxLength:number }
 * @returns {{text:string, blocked:boolean, hits:number}} — `text` is safe to broadcast.
 */
export function filterChat(text, { wordlist = [], mask = '⁂', maxLength = 280 } = {}) {
  const cleaned = cleanChatText(text, { maxLength });
  if (!cleaned) return { text: '', blocked: false, hits: 0 };
  const blocked = wordlist
    .filter((word) => typeof word === 'string' && word.trim().length >= 2)
    .map((word) => normalizeForMatch(word.trim()));
  if (blocked.length === 0) return { text: cleaned, blocked: false, hits: 0 };

  // Split while keeping separators so the rebuilt string preserves spacing.
  const parts = cleaned.split(/(\s+)/);
  let hits = 0;
  const masked = parts.map((part) => {
    if (/^\s*$/.test(part) || part.length === 0) return part;
    const canonical = normalizeForMatch(part).replace(/[^آ-یa-z]/g, '');
    if (canonical.length < 2) return part;
    const hit = blocked.some((word) => canonical.includes(word));
    if (!hit) return part;
    hits += 1;
    return String(mask).repeat(Math.min(Math.max(part.length, 3), 8));
  });
  return { text: masked.join(''), blocked: hits > 0, hits };
}
