/**
 * Wire protocol: message types, error codes and small validators.
 *
 * Client → server requests are always `{ id, type, payload }`.
 * Server → client answers are `{ id, ok, ... }` and pushes are `{ push, payload }`.
 *
 * There is deliberately NO message that sets resources or timers directly:
 * the client only sends intents (spend/grant/harvest/enqueue/complete/...) and
 * the server recomputes everything with its own clock and data. That single
 * property is what makes client-side tampering useless.
 */

export const PROTOCOL_VERSION = 1;

/** Request types the server understands. Anything else → `unknown-type`. */
export const REQUEST_TYPES = Object.freeze(new Set([
  'hello',
  'city:sync',
  'ledger:harvest',
  'ledger:spend',
  'ledger:grant',
  'build:enqueue',
  'build:complete',
  'build:speedup',
  'help:request',
  'help:give',
  'help:cancel',
  'chat:send',
  'chat:preset',
  'chat:report',
  'event:donate',
  'presence:ping',
  'state:pull',
]));

/** Server → client pushes (fire-and-forget, no `id`). */
export const PUSH_TYPES = Object.freeze(new Set([
  'ledger',
  'chat',
  'presence',
  'help',
  'event',
  'notice',
]));

/**
 * Stable error codes. The client maps them to Persian strings locally, so the
 * server never needs to know the player's locale.
 */
export const ERRORS = Object.freeze({
  INVALID: 'invalid',
  UNKNOWN_TYPE: 'unknown-type',
  RATE_LIMITED: 'rate-limited',
  UNAUTHENTICATED: 'unauthenticated',
  JAMAAT_FULL: 'jamaat-full',
  INSUFFICIENT: 'insufficient',
  TOO_EARLY: 'too-early',
  MISSING: 'missing',
  NOT_ACTIVE: 'not-active',
  QUEUE_FULL: 'queue-full',
  ENTITY_BUSY: 'entity-busy',
  COOLDOWN: 'cooldown',
  EXHAUSTED: 'exhausted',
  FORBIDDEN: 'forbidden',
  CHILD_RESTRICTED: 'child-restricted',
  COMPLETED: 'completed',
  OFFLINE: 'offline',
  TIMEOUT: 'timeout',
  UNSUPPORTED: 'unsupported',
  CONNECT_FAILED: 'connect-failed',
  BUSY: 'busy',
});

export function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function asInt(value, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return null;
  const floored = Math.floor(number);
  if (floored < min || floored > max) return null;
  return floored;
}

export function asNumber(value, { min = -Infinity, max = Infinity } = {}) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return null;
  if (number < min || number > max) return null;
  return number;
}

export function asString(value, { maxLength = 512 } = {}) {
  if (typeof value !== 'string') return null;
  if (value.length > maxLength) return null;
  return value;
}

/** Validate a `{ resource: amount }` cost map (spend intents). */
export function asCostMap(value, { allowed = ['rizq', 'nur', 'hekmat', 'gohar'], maxTotal = 1_000_000 } = {}) {
  if (!isPlainObject(value)) return null;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > allowed.length) return null;
  const cost = {};
  let total = 0;
  for (const [key, amount] of entries) {
    if (!allowed.includes(key)) return null;
    const number = asNumber(amount, { min: 0, max: maxTotal });
    if (number === null || number <= 0) return null;
    cost[key] = number;
    total += number;
  }
  if (total > maxTotal) return null;
  return cost;
}
