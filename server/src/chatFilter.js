/** Data-driven Persian moderation. Matching never rewrites innocent display text. */
export function normalizeForMatch(text) {
  return String(text || '').normalize('NFKC')
    .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/ة/g, 'ه')
    .replace(/[\p{M}\p{Cf}\u0640]/gu, '')
    .replace(/(.)\1{2,}/gu, '$1').toLowerCase();
}
export function cleanChatText(text, { maxLength = 280 } = {}) {
  if (typeof text !== 'string') return '';
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, Math.max(0, maxLength));
}
const canonical = (text) => normalizeForMatch(text).replace(/[^\p{L}]/gu, '');

export function filterChat(text, { wordlist = [], mask = '⁂', maxLength = 280 } = {}) {
  const cleaned = cleanChatText(text, { maxLength });
  if (!cleaned) return { text: '', blocked: false, hits: 0 };
  const blocked = [...new Set(wordlist.filter((word) => typeof word === 'string' && word.trim().length >= 2).map(canonical))].filter(Boolean);
  if (!blocked.length) return { text: cleaned, blocked: false, hits: 0 };
  const parts = cleaned.split(/(\s+)/);
  const words = parts.map((part, index) => ({ index, value: canonical(part) })).filter((entry) => entry.value);
  const masked = new Set();
  let hits = 0;
  for (let i = 0; i < words.length; i += 1) {
    if (blocked.some((word) => words[i].value.includes(word))) { masked.add(words[i].index); hits += 1; }
    // Across whitespace, match complete canonical tokens ONLY. This catches
    // arbitrary cuts of a blocked word without joining unrelated whole words
    // and censoring a substring at their accidental boundary ("ab cd" ≠ "bc").
    for (const word of blocked) {
      let joined = words[i].value;
      if (!word.startsWith(joined) || joined === word) continue;
      for (let j = i + 1; j < words.length && joined.length < word.length; j += 1) {
        joined += words[j].value;
        if (!word.startsWith(joined)) break;
        if (joined === word) {
          for (let k = i; k <= j; k += 1) masked.add(words[k].index);
          hits += 1; break;
        }
      }
    }
  }
  for (const index of masked) parts[index] = String(mask).repeat(Math.min(Math.max(parts[index].length, 3), 8));
  return { text: parts.join(''), blocked: hits > 0, hits };
}
