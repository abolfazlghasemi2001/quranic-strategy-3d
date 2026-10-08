/**
 * Sliding-window rate limiter (per connection + action).
 *
 * Every chat message, harvest, donation, help and build intent passes here.
 * State is tiny (timestamps per key) and swept periodically by the server tick.
 */
export class RateLimiter {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    /** @type {Map<string, number[]>} */
    this.hits = new Map();
  }

  /**
   * @param {string} key — e.g. `conn-3:chat:send`
   * @param {{windowMs:number, max:number}} rule
   * @returns {{ok:boolean, retryAfterMs:number}}
   */
  check(key, { windowMs, max }) {
    const now = this.now();
    const windowStart = now - windowMs;
    let list = this.hits.get(key);
    if (!list) {
      list = [];
      this.hits.set(key, list);
    }
    while (list.length > 0 && list[0] <= windowStart) list.shift();
    if (list.length >= max) {
      return { ok: false, retryAfterMs: Math.max(0, list[0] + windowMs - now) };
    }
    list.push(now);
    return { ok: true, retryAfterMs: 0 };
  }

  /** Drop empty/expired buckets so memory stays flat. */
  sweep(windowMs = 3_600_000) {
    const cutoff = this.now() - windowMs;
    for (const [key, list] of this.hits) {
      while (list.length > 0 && list[0] <= cutoff) list.shift();
      if (list.length === 0) this.hits.delete(key);
    }
    return this.hits.size;
  }

  reset(key) {
    this.hits.delete(key);
  }
}
