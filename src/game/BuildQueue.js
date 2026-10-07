/**
 * BuildQueue — pure logic (no DOM, no Three.js).
 *
 * Two builders ("بنّا"), FIFO queue:
 *   - enqueue() activates a job immediately if a builder is free,
 *     otherwise parks it as 'queued' (up to maxJobs total).
 *   - tick(now) completes due jobs in chronological order; each completion
 *     promotes the next queued job, chaining its start onto the completion
 *     time — so a long absence fast-forwards the whole queue correctly.
 *   - speedup(jobId, now) finishes an ACTIVE job instantly by spending gohar
 *     (the only in-game premium currency; no purchases anywhere).
 *
 * Jobs are timestamp-driven: {startedAt, endsAt} in epoch ms, persisted
 * through saves so timers survive reloads and offline gaps.
 */

export class BuildQueue {
  /**
   * @param {object} options
   * @param {object} options.economyData — src/data/economy.json contents
   * @param {import('./EconomySystem.js').EconomySystem} options.economy
   * @param {import('./GameState.js').GameState} options.state
   * @param {(job: object) => void} [options.onFinished] — called for every completed job
   */
  constructor({ economyData, economy, state, onFinished }) {
    this.data = economyData;
    this.economy = economy;
    this.state = state;
    this.onFinished = onFinished || null;
  }

  get jobs() {
    return this.state.jobs;
  }

  get maxJobs() {
    return this.data.queue.maxJobs;
  }

  get builderCount() {
    return this.data.builders.total;
  }

  activeJobs() {
    return this.jobs.filter((j) => j.status === 'active');
  }

  queuedJobs() {
    return this.jobs.filter((j) => j.status === 'queued');
  }

  busyBuilders() {
    return this.activeJobs().length;
  }

  freeBuilders() {
    return Math.max(0, this.builderCount - this.busyBuilders());
  }

  /** The (active or queued) job attached to an entity, if any. */
  jobFor(entityId) {
    return this.jobs.find((j) => j.entityId === entityId) || null;
  }

  isEntityBusy(entityId) {
    return this.jobFor(entityId) != null;
  }

  /**
   * Enqueue a build/upgrade job.
   * @param {object} spec — {kind, entityId, type, targetLevel, durationMs}
   * @param {number} now
   * @returns {{ok:boolean, job?:object, reason?:string}}
   */
  enqueue(spec, now = Date.now()) {
    if (this.jobs.length >= this.maxJobs) {
      return { ok: false, reason: 'queue-full' };
    }
    if (spec.entityId != null && this.isEntityBusy(spec.entityId)) {
      return { ok: false, reason: 'entity-busy' };
    }
    const job = {
      id: `job-${this.state.nextJobId++}`,
      kind: spec.kind, // 'build' | 'upgrade'
      entityId: spec.entityId,
      type: spec.type,
      targetLevel: spec.targetLevel,
      durationMs: spec.durationMs,
      startedAt: null,
      endsAt: null,
      status: 'queued',
    };
    this.jobs.push(job);
    this._promote(now);
    return { ok: true, job };
  }

  /**
   * Move queued jobs into active slots (FIFO).
   * @param {number} at — the time the builder becomes available (may be historical
   *                      when fast-forwarding offline; see tick()).
   */
  _promote(at) {
    for (const job of this.jobs) {
      if (job.status !== 'queued') continue;
      if (this.freeBuilders() <= 0) break;
      job.status = 'active';
      job.startedAt = at;
      job.endsAt = at + job.durationMs;
    }
  }

  /**
   * Advance the queue to `now`: complete due jobs (earliest first), promote
   * queued work chained onto each completion timestamp. Offline gaps therefore
   * resolve in one call, in the exact order the builders would have worked.
   *
   * @param {number} now
   * @returns {object[]} jobs completed by this call (in completion order)
   */
  tick(now = Date.now()) {
    const finished = [];
    // Loop until nothing is due: promotions may themselves be instantly due.
    for (;;) {
      let due = null;
      for (const job of this.jobs) {
        if (job.status === 'active' && job.endsAt <= now) {
          if (!due || job.endsAt < due.endsAt || (job.endsAt === due.endsAt && this.jobs.indexOf(job) < this.jobs.indexOf(due))) {
            due = job;
          }
        }
      }
      if (!due) break;

      due.status = 'done';
      const idx = this.jobs.indexOf(due);
      if (idx >= 0) this.jobs.splice(idx, 1);
      finished.push(due);

      // Builder frees at the job's real end time → promote next job from there.
      this._promote(due.endsAt);
      if (this.onFinished) this.onFinished(due, due.endsAt);
    }
    // Any builder still idle with queued work (e.g. right after load) starts now.
    if (this.freeBuilders() > 0) this._promote(now);
    return finished;
  }

  /**
   * Finish an active job immediately by paying gohar.
   * @returns {{ok:boolean, cost?:number, reason?:string}}
   */
  speedup(jobId, now = Date.now()) {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) return { ok: false, reason: 'missing' };
    if (job.status !== 'active') return { ok: false, reason: 'not-active' };

    const cost = this.economy.speedupCost(job, now);
    if (!this.economy.spendGohar(cost)) return { ok: false, reason: 'gohar' };

    job.endsAt = now;
    const remaining = this.tick(now);
    void remaining;
    return { ok: true, cost };
  }

  /* ----------------------------------------------------------- serialize */

  toJSON() {
    return this.jobs.map((j) => ({ ...j }));
  }
}
