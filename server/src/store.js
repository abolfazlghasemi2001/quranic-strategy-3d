/**
 * Tiny debounced JSON persistence for the multiplayer server.
 *
 * Only minimal multiplayer state is stored (players' ledgers/jobs, jamaat
 * event, moderation reports). Chat history is deliberately NEVER persisted.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class JsonStore {
  /**
   * @param {string|null} filePath — null disables disk persistence (pure memory, used by tests).
   * @param {{debounceMs?:number}} [options]
   */
  constructor(filePath, { debounceMs = 2000 } = {}) {
    this.filePath = filePath;
    this.debounceMs = debounceMs;
    this.timer = null;
    this.pending = null;
  }

  load() {
    if (!this.filePath || !existsSync(this.filePath)) return null;
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  saveSoon(data) {
    if (!this.filePath) return;
    this.pending = data;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.pending) this.saveNow(this.pending);
      this.pending = null;
    }, this.debounceMs);
    this.timer.unref?.();
  }

  saveNow(data) {
    if (!this.filePath) return false;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(data));
      return true;
    } catch {
      return false;
    }
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending) {
      this.saveNow(this.pending);
      this.pending = null;
    }
  }
}
