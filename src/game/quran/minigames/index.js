/** فهرست مینی‌گیم‌های فاز ۴ (منطق خالص). */
export { AyahCompletionGame, AYAH_COMPLETION_ID } from './AyahCompletion.js';
export { WordMatchGame, buildPairs, WORD_MATCH_ID } from './WordMatch.js';
export { AyahOrderGame, AYAH_ORDER_ID } from './AyahOrder.js';

export const MINIGAMES = Object.freeze({
  'ayah-completion': { id: 'ayah-completion', name: 'تکمیل آیه', icon: '▤' },
  'word-match': { id: 'word-match', name: 'تطبیق واژه و معنی', icon: '⇄' },
  'ayah-order': { id: 'ayah-order', name: 'ترتیب آیات', icon: '⇅' },
});
