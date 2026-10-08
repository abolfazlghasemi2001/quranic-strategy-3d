/**
 * Optional, license-gated Quran audio playback. The app does not bundle,
 * synthesize, or request any recitation unless the player enables it and taps play.
 */
let enabled = false;
let current = null;

export function isRecitationEnabled() {
  return enabled;
}

export function stopRecitation() {
  if (!current) return false;
  current.pause?.();
  try {
    current.currentTime = 0;
  } catch {
    // Some browser media shims do not expose a writable currentTime.
  }
  current = null;
  return true;
}

export function setRecitationEnabled(value) {
  enabled = Boolean(value);
  if (!enabled) stopRecitation();
  return enabled;
}

export function playRecitation(audio) {
  if (!enabled || !audio?.playable || !audio?.license || !audio?.licenseUrl || typeof Audio !== 'function') return false;
  let url;
  try {
    url = new URL(audio.url, typeof window !== 'undefined' ? window.location.href : 'https://localhost/');
  } catch {
    return false;
  }
  if (!['https:', 'http:'].includes(url.protocol)) return false;

  stopRecitation();
  try {
    const player = new Audio(url.href);
    player.preload = 'none';
    player.referrerPolicy = 'no-referrer';
    player.onended = () => { if (current === player) current = null; };
    player.onerror = () => { if (current === player) current = null; };
    current = player;
    const result = player.play();
    if (result && typeof result.catch === 'function') result.catch(() => { if (current === player) current = null; });
    return true;
  } catch {
    current = null;
    return false;
  }
}
