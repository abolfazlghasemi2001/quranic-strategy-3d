/**
 * Jamaat («جماعت») — the friendly alternative to clans.
 *
 * One shared home per jamaat id: member roster + presence, moderated chat,
 * mutual build help and a weekly cooperative event with a shared goal.
 *
 * Friendly by construction: there is no attack, no loot and no way to lose
 * resources to another player — help and donations only ever ADD progress.
 */

export function weekIdFor(timestamp) {
  const date = new Date(timestamp);
  // ISO week (UTC): Thursday decides the week number.
  const day = (date.getUTCDay() + 6) % 7;
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day + 3));
  const year = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round((thursday - firstThursday) / (7 * 24 * 3600 * 1000));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function createEvent(weekId, tuning) {
  return {
    weekId,
    title: tuning.title,
    goal: tuning.goal,
    points: 0,
    contributions: {}, // playerId -> points
    donors: {}, // playerId -> { rizq, nur, hekmat }
    completed: false,
    completedAt: null,
    rewarded: [],
    lastWeek: null,
  };
}

export class JamaatManager {
  /**
   * @param {object} options
   * @param {import('./data.js').GameData} options.data
   * @param {(playerId:string)=>object|null} options.getPlayer — resolve a player record
   */
  constructor({ data, getPlayer }) {
    this.data = data;
    this.getPlayer = getPlayer;
    const social = data.social || {};
    this.jamaatId = social.server?.jamaatId || 'jamaat-nur';
    this.jamaatName = social.server?.jamaatName || 'جماعت نور';
    this.maxMembers = social.server?.maxMembers || 50;
    this.chatHistory = social.chat?.history || 100;
    this.helpTuning = {
      helpMs: (social.help?.seconds || 60) * 1000,
      maxPerJob: social.help?.maxPerJob || 5,
      maxReductionFrac: social.help?.maxReductionFrac ?? 0.5,
      minRemainingMs: social.help?.minRemainingMs ?? 5000,
      giverCooldownMs: social.help?.giverCooldownMs ?? 30000,
    };
    this.eventTuning = {
      title: social.event?.title || 'رویداد هفتگی',
      goal: social.event?.goal || 1000,
      weights: { ...(social.event?.weights || { rizq: 1, nur: 2, hekmat: 3 }) },
      rewardGohar: social.event?.rewardGohar ?? 8,
    };
    this.members = new Set();
    this.chat = [];
    this.chatSeq = 1;
    this.helpRequests = new Map(); // id -> request
    this.helpSeq = 1;
    this.giverLastHelpAt = new Map(); // playerId -> timestamp
    this.event = createEvent(weekIdFor(Date.now()), this.eventTuning);
  }

  /* -------------------------------------------------------------- members */

  join(playerId) {
    if (this.members.has(playerId)) return { ok: true };
    if (this.members.size >= this.maxMembers) return { ok: false, error: 'jamaat-full' };
    this.members.add(playerId);
    return { ok: true };
  }

  leave(playerId) {
    this.members.delete(playerId);
    for (const request of this.helpRequests.values()) {
      if (request.playerId === playerId && request.status === 'open') request.status = 'closed';
    }
  }

  /* ----------------------------------------------------------------- chat */

  postChat({ playerId, name, text, preset }) {
    const message = {
      id: `m-${this.chatSeq++}`,
      from: { id: playerId, name },
      text,
      preset: !!preset,
      at: Date.now(),
    };
    this.chat.push(message);
    while (this.chat.length > this.chatHistory) this.chat.shift();
    return message;
  }

  findMessage(messageId) {
    return this.chat.find((message) => message.id === messageId) || null;
  }

  chatTail(limit = 50) {
    return this.chat.slice(-Math.max(1, limit));
  }

  /* ----------------------------------------------------------------- help */

  /**
   * Open a help request for one of the player's ACTIVE server jobs.
   * `jobResolver(playerId, jobId)` must return the authoritative job or null.
   */
  requestHelp(playerId, jobId, jobResolver) {
    const job = jobResolver(playerId, jobId);
    if (!job || job.status !== 'active') return { ok: false, error: 'not-active' };
    for (const request of this.helpRequests.values()) {
      if (request.playerId === playerId && request.jobId === jobId && request.status === 'open') {
        return { ok: true, request, duplicate: true };
      }
    }
    const request = {
      id: `h-${this.helpSeq++}`,
      playerId,
      jobId,
      defId: job.defId || job.type || null,
      level: job.level ?? job.targetLevel ?? 1,
      helps: 0,
      helpedBy: [],
      status: 'open',
      createdAt: Date.now(),
    };
    this.helpRequests.set(request.id, request);
    return { ok: true, request };
  }

  cancelHelp(playerId, requestId) {
    const request = this.helpRequests.get(requestId);
    if (!request || request.status !== 'open') return { ok: false, error: 'missing' };
    if (request.playerId !== playerId) return { ok: false, error: 'forbidden' };
    request.status = 'closed';
    return { ok: true, request };
  }

  /**
   * One member helps another's build. `ownerJob(playerId, jobId)` returns the
   * live authoritative job; `applyReduction(...)` mutates it on the owner's sim.
   */
  giveHelp(giverId, requestId, now, { ownerJob, applyReduction }) {
    const request = this.helpRequests.get(requestId);
    if (!request || request.status !== 'open') return { ok: false, error: 'missing' };
    if (request.playerId === giverId) return { ok: false, error: 'forbidden' };
    if (request.helpedBy.includes(giverId)) return { ok: false, error: 'exhausted' };
    const lastHelp = this.giverLastHelpAt.get(giverId) || 0;
    if (now - lastHelp < this.helpTuning.giverCooldownMs) {
      return { ok: false, error: 'cooldown', retryAfterMs: this.helpTuning.giverCooldownMs - (now - lastHelp) };
    }
    const job = ownerJob(request.playerId, request.jobId);
    if (!job || job.status !== 'active') {
      request.status = 'closed';
      return { ok: false, error: 'not-active' };
    }
    const applied = applyReduction(request.playerId, request.jobId, now);
    if (!applied.ok) {
      if (applied.error === 'exhausted') request.status = 'closed';
      return applied;
    }
    request.helps += 1;
    request.helpedBy.push(giverId);
    this.giverLastHelpAt.set(giverId, now);
    const owner = this.getPlayer(request.playerId);
    const giver = this.getPlayer(giverId);
    if (owner) owner.sim.helpsReceived += 1;
    if (giver) giver.sim.helpsGiven += 1;
    return { ok: true, request, reductionMs: applied.reductionMs, endsAt: applied.job.endsAt, job: applied.job };
  }

  /** Close requests whose job finished or vanished (called on job finish + tick). */
  closeRequestsForJob(playerId, jobId) {
    let closed = 0;
    for (const request of this.helpRequests.values()) {
      if (request.playerId === playerId && request.jobId === jobId && request.status === 'open') {
        request.status = 'closed';
        closed += 1;
      }
    }
    return closed;
  }

  openRequests() {
    return [...this.helpRequests.values()]
      .filter((request) => request.status === 'open')
      .map((request) => ({ ...request, helpedBy: [...request.helpedBy] }));
  }

  /* ---------------------------------------------------------------- event */

  rollover(now) {
    const weekId = weekIdFor(now);
    if (this.event.weekId === weekId) return null;
    const finished = this.event;
    const top = Object.entries(finished.contributions)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([playerId, points]) => ({ playerId, points }));
    const archived = {
      weekId: finished.weekId,
      points: finished.points,
      goal: finished.goal,
      completed: finished.completed,
      top,
    };
    this.event = createEvent(weekId, this.eventTuning);
    this.event.lastWeek = archived;
    return this.event;
  }

  /**
   * Donate stored resources to the shared weekly goal. The spend happens on
   * the donor's authoritative ledger first; points are only added after.
   */
  donate(playerId, resource, amount) {
    if (!['rizq', 'nur', 'hekmat'].includes(resource)) return { ok: false, error: 'invalid' };
    const value = Math.floor(Number(amount));
    if (!Number.isFinite(value) || value <= 0 || value > 1_000_000) return { ok: false, error: 'invalid' };
    if (this.event.completed) return { ok: false, error: 'completed' };
    const player = this.getPlayer(playerId);
    if (!player) return { ok: false, error: 'invalid' };
    const spent = player.sim.spend({ [resource]: value });
    if (!spent.ok) return spent;
    const weight = Number(this.eventTuning.weights[resource]) || 1;
    const points = value * weight;
    this.event.points += points;
    this.event.contributions[playerId] = (this.event.contributions[playerId] || 0) + points;
    const donor = this.event.donors[playerId] || { rizq: 0, nur: 0, hekmat: 0 };
    donor[resource] += value;
    this.event.donors[playerId] = donor;
    player.sim.addContribution(this.event.weekId, points);

    let rewarded = [];
    if (!this.event.completed && this.event.points >= this.event.goal) {
      this.event.completed = true;
      this.event.completedAt = Date.now();
      rewarded = this._rewardContributors();
    }
    return {
      ok: true,
      points,
      total: this.event.points,
      completed: this.event.completed,
      rewarded,
      ledger: player.sim.ledger(),
    };
  }

  /** Equal reward for every contributor — no ranking loot, no losers. */
  _rewardContributors() {
    const rewarded = [];
    for (const playerId of Object.keys(this.event.contributions)) {
      const player = this.getPlayer(playerId);
      if (!player) continue;
      player.sim.grant('gohar', this.eventTuning.rewardGohar, 'event');
      this.event.rewarded.push(playerId);
      rewarded.push(playerId);
    }
    return rewarded;
  }

  leaderboard(limit = 20) {
    return Object.entries(this.event.contributions)
      .map(([playerId, points]) => {
        const player = this.getPlayer(playerId);
        return {
          playerId,
          name: player?.displayName || '؟',
          points,
          helpsGiven: player?.sim.helpsGiven || 0,
        };
      })
      .sort((a, b) => b.points - a.points)
      .slice(0, limit);
  }

  eventSnapshot() {
    return {
      weekId: this.event.weekId,
      title: this.event.title,
      goal: this.event.goal,
      points: this.event.points,
      completed: this.event.completed,
      completedAt: this.event.completedAt,
      rewardGohar: this.eventTuning.rewardGohar,
      weights: { ...this.eventTuning.weights },
      lastWeek: this.event.lastWeek ? { ...this.event.lastWeek } : null,
    };
  }

  /* ------------------------------------------------------------ snapshots */

  roster(isOnline) {
    return [...this.members]
      .map((playerId) => {
        const player = this.getPlayer(playerId);
        if (!player) return null;
        return {
          id: playerId,
          name: player.displayName,
          online: !!isOnline(playerId),
          cityLevel: player.cityLevel || 1,
          points: this.event.contributions[playerId] || 0,
          helpsGiven: player.sim.helpsGiven || 0,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.points - a.points || String(a.name).localeCompare(String(b.name), 'fa'));
  }

  serialize() {
    return {
      members: [...this.members],
      chatSeq: this.chatSeq,
      helpSeq: this.helpSeq,
      helpRequests: [...this.helpRequests.values()].map((request) => ({ ...request, helpedBy: [...request.helpedBy] })),
      event: JSON.parse(JSON.stringify(this.event)),
    };
  }

  restore(saved) {
    if (!saved || typeof saved !== 'object') return;
    if (Array.isArray(saved.members)) this.members = new Set(saved.members.filter((id) => typeof id === 'string'));
    if (Number.isInteger(saved.chatSeq)) this.chatSeq = saved.chatSeq;
    if (Number.isInteger(saved.helpSeq)) this.helpSeq = saved.helpSeq;
    if (Array.isArray(saved.helpRequests)) {
      for (const request of saved.helpRequests) {
        if (request && typeof request.id === 'string') {
          // Open requests do not survive a restart — the owner re-requests.
          this.helpRequests.set(request.id, { ...request, status: 'closed', helpedBy: [...(request.helpedBy || [])] });
        }
      }
    }
    if (saved.event && typeof saved.event === 'object' && typeof saved.event.weekId === 'string') {
      const fresh = createEvent(saved.event.weekId, this.eventTuning);
      this.event = { ...fresh, ...saved.event };
      this.rollover(Date.now());
    }
  }
}
