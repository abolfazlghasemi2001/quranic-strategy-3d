/**
 * Simple token auth + display-name hygiene.
 *
 * Privacy: the server only ever sees a self-chosen display name and a child
 * flag. No e-mail, phone number, device id or any other personal data exists
 * anywhere in the protocol or the save file.
 */
import { randomBytes } from 'node:crypto';

export const MAX_DISPLAY_NAME = 16;

/** Unguessable session token for one player (reconnects reuse it). */
export function issueToken() {
  return randomBytes(24).toString('hex');
}

/**
 * Clean a player-chosen display name. Control characters, newlines and
 * excess whitespace are stripped; over-long names are truncated.
 * @returns {string|null} — null when nothing usable remains.
 */
export function sanitizeDisplayName(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DISPLAY_NAME)
    .trim();
  return cleaned.length >= 2 ? cleaned : null;
}

/** Short random suffix used when the server must invent a name. */
export function randomNameSuffix() {
  return String(1000 + (randomBytes(2).readUInt16BE(0) % 9000));
}
