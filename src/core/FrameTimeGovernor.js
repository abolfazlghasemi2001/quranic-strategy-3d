/** Hysteretic resolution controller; consumes measured frame intervals, never gameplay clocks. */
export class FrameTimeGovernor {
  constructor(policy = {}) { this.policy = policy; this.enabled = policy.enabled !== false; this.reset(); }
  reset({ fps = 60, minScale = 0.7 } = {}) {
    this.targetMs = 1000 / fps; this.minScale = minScale; this.scale = 1; this.ema = 0;
    this.frames = 0; this.slow = 0; this.fast = 0; this.cooldown = 0;
  }
  sample(frameMs) {
    if (!this.enabled || !Number.isFinite(frameMs) || frameMs <= 0) return null;
    const p = this.policy;
    this.frames += 1; this.ema = this.ema ? this.ema * (1 - p.alpha) + frameMs * p.alpha : frameMs;
    if (this.frames <= p.warmupFrames) return null;
    if (this.cooldown > 0) { this.cooldown -= 1; return null; }
    this.slow = this.ema > this.targetMs * p.downThreshold ? this.slow + 1 : 0;
    this.fast = this.ema < this.targetMs * p.upThreshold ? this.fast + 1 : 0;
    let next = this.scale;
    if (this.slow >= p.slowFrames) next = Math.max(this.minScale, this.scale - p.step);
    else if (this.fast >= p.fastFrames) next = Math.min(1, this.scale + p.step);
    next = Math.round(next * 1000) / 1000;
    if (next === this.scale) return null;
    this.scale = next; this.slow = 0; this.fast = 0; this.cooldown = p.cooldownFrames; return next;
  }
}
