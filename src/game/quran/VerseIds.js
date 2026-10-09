/** شناسهٔ استاندارد یک آیه: ayah:سوره:آیه */
export function verseId(surahIndex, ayahIndex) {
  return `ayah:${Number(surahIndex)}:${Number(ayahIndex)}`;
}

export function parseVerseId(id) {
  const match = /^ayah:(\d+):(\d+)$/.exec(String(id || ''));
  if (!match) return null;
  return { surahIndex: Number(match[1]), ayahIndex: Number(match[2]) };
}

