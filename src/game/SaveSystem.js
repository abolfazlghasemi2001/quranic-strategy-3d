/**
 * SaveSystem — IndexedDB persistence with schema versioning + migrations.
 *
 * Record shape (schemaVersion 2):
 *   { id:'main', schemaVersion:2, savedAt:number, payload:{...GameState} }
 *
 * Migrations are pure functions keyed by the version they upgrade FROM:
 *   1 → 2 : legacy {gold,wood,stone} resources → {rizq,nur,hekmat,gohar},
 *           adds pending/status/jobs/dailyGoharAt/nextEntityId/nextJobId.
 *
 * A record with a NEWER schemaVersion than we understand is preserved as a
 * backup (`main-backup-v{n}`) and the game starts fresh — never crashes.
 *
 * When IndexedDB is unavailable (unit tests / private mode), an in-memory
 * store is used so the game logic remains fully functional and testable.
 */

export const SAVE_SCHEMA_VERSION = 2;
export const SAVE_DB_NAME = 'shahr-nur';
export const SAVE_STORE = 'saves';
export const SAVE_KEY = 'main';

/** Pure migrations: version → (payload) => payload of version+1. */
export const MIGRATIONS = {
  1(payload) {
    const next = { ...payload };
    // v1 named the resources after generic city-builders; rename to quranic set.
    const legacy = payload.resources || {};
    next.resources = {
      rizq: legacy.gold ?? legacy.rizq ?? 0,
      nur: legacy.wood ?? legacy.nur ?? 0,
      hekmat: legacy.stone ?? legacy.hekmat ?? 0,
      gohar: legacy.gohar ?? 20,
    };
    next.jobs = [];
    // Offline clock: the record's save time is the accrual baseline.
    next.lastAccrualAt = payload.lastAccrualAt ?? payload.savedAt ?? Date.now();
    // Legacy entities lacked production state — add safe defaults per entity.
    next.entities = (payload.entities || []).map((e) => ({
      ...e,
      status: 'ready',
      pending: 0,
      lastAccrualAt: payload.savedAt ?? Date.now(),
    }));
    next.lastDailyAt = payload.lastDailyAt ?? payload.dailyGoharAt ?? payload.savedAt ?? 0;
    next.dailyGranted = payload.dailyGranted ?? true;
    next.nextEntityId = payload.nextEntityId ?? 1;
    next.nextJobId = payload.nextJobId ?? 1;
    delete next.savedAt;
    return next;
  },
};

/**
 * Upgrade a raw record to SAVE_SCHEMA_VERSION.
 * @returns {{payload:object, migratedFrom:number|null} | null}
 *          null ⇒ nothing to load (missing/invalid/future record).
 */
export function migrateRecord(record) {
  if (!record || typeof record !== 'object') return null;
  let version = record.schemaVersion ?? 1;
  let payload = record.payload;
  if (!payload || typeof payload !== 'object') return null;
  // Migrations may need the record's save time (e.g. accrual resync on v1→v2).
  if (payload.savedAt == null && record.savedAt != null) payload = { ...payload, savedAt: record.savedAt };

  if (version > SAVE_SCHEMA_VERSION) {
    return { future: true, version };
  }
  const from = version;
  while (version < SAVE_SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) return null; // gap we cannot cross
    payload = step(payload);
    version += 1;
  }
  return { payload, migratedFrom: from === SAVE_SCHEMA_VERSION ? null : from };
}

export class SaveSystem {
  /**
   * @param {object} [opts]
   * @param {'idb'|'memory'} [opts.backend] — force a backend (tests use memory)
   */
  constructor({ backend } = {}) {
    this.backend = backend || (typeof indexedDB !== 'undefined' ? 'idb' : 'memory');
    this.dbPromise = null;
    this.memory = new Map(); // backend fallback: key → record
  }

  /* ------------------------------------------------------------- IndexedDB */

  _open() {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(SAVE_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(SAVE_STORE)) {
          db.createObjectStore(SAVE_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => {
      this.backend = 'memory';
      console.warn('[SaveSystem] IndexedDB unavailable, using memory backend:', err);
      return null;
    });
    return this.dbPromise;
  }

  async _idbGet(key) {
    const db = await this._open();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(SAVE_STORE, 'readonly');
        const req = tx.objectStore(SAVE_STORE).get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async _idbPut(record) {
    const db = await this._open();
    if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(SAVE_STORE, 'readwrite');
        tx.objectStore(SAVE_STORE).put(record);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  }

  /* ------------------------------------------------------------------ API */

  /**
   * Load and migrate the main save.
   * @returns {Promise<{payload:object, migratedFrom:number|null, savedAt:number}|null>}
   */
  async load() {
    let record = null;
    if (this.backend === 'idb') {
      record = await this._idbGet(SAVE_KEY);
    } else {
      record = this.memory.get(SAVE_KEY) || null;
    }
    if (!record) return null;

    const migrated = migrateRecord(record);
    if (!migrated) return null;

    if (migrated.future) {
      // Future save we cannot read: keep a backup, start fresh.
      await this.saveRecord({ ...record, id: `${SAVE_KEY}-backup-v${record.schemaVersion}` });
      return null;
    }
    return { payload: migrated.payload, migratedFrom: migrated.migratedFrom, savedAt: record.savedAt || 0 };
  }

  async saveRecord(record) {
    if (this.backend === 'idb') {
      const ok = await this._idbPut(record);
      if (ok) return true;
    }
    this.memory.set(record.id, record);
    return true;
  }

  /**
   * Persist the game payload under the current schema version.
   * @param {object} payload — GameState.serialize()
   * @returns {Promise<number>} savedAt timestamp
   */
  async save(payload) {
    const savedAt = Date.now();
    const record = {
      id: SAVE_KEY,
      schemaVersion: SAVE_SCHEMA_VERSION,
      savedAt,
      payload: { ...payload, savedAt },
    };
    await this.saveRecord(record);
    return savedAt;
  }

  /** Wipe the main save (dev reset). */
  async clear() {
    if (this.backend === 'idb') {
      const db = await this._open();
      if (db) {
        await new Promise((resolve) => {
          try {
            const tx = db.transaction(SAVE_STORE, 'readwrite');
            tx.objectStore(SAVE_STORE).delete(SAVE_KEY);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
          } catch {
            resolve(false);
          }
        });
        return;
      }
    }
    this.memory.delete(SAVE_KEY);
  }
}
