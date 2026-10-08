import { EVENTS } from './EventBus.js';

const CUES = {
  harvest: { frequency: 620, endFrequency: 820, duration: 0.12, gain: 0.035 },
  build: { frequency: 420, endFrequency: 680, duration: 0.18, gain: 0.04 },
  lesson: { frequency: 540, endFrequency: 760, duration: 0.16, gain: 0.03 },
  achievement: { frequency: 660, endFrequency: 990, duration: 0.24, gain: 0.04 },
};

/** Tiny optional UI sound cues synthesized with Web Audio; no binary assets. */
export class SoundManager {
  constructor({ bus, enabled = true } = {}) {
    this.bus = bus;
    this.enabled = Boolean(enabled);
    this.context = null;
    this._unsubscribers = [];
    if (bus) {
      this._unsubscribers.push(
        bus.on(EVENTS.RESOURCE_HARVESTED, () => this.play('harvest')),
        bus.on(EVENTS.JOB_FINISHED, ({ job } = {}) => {
          if (job?.kind === 'build') this.play('build');
        }),
        bus.on(EVENTS.QURAN_LESSON_COMPLETED, () => this.play('lesson')),
        bus.on(EVENTS.META_ACHIEVEMENT_UNLOCKED, () => this.play('achievement')),
      );
    }
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    return this.enabled;
  }

  play(name = 'harvest') {
    if (!this.enabled || typeof window === 'undefined') return false;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (typeof AudioContextClass !== 'function') return false;
    try {
      if (!this.context || this.context.state === 'closed') this.context = new AudioContextClass();
      const context = this.context;
      if (context.state === 'suspended') context.resume().catch(() => {});
      const cue = CUES[name] || CUES.harvest;
      const start = context.currentTime;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(cue.frequency, start);
      oscillator.frequency.exponentialRampToValueAtTime(cue.endFrequency, start + cue.duration);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(cue.gain, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + cue.duration);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + cue.duration + 0.01);
      return true;
    } catch {
      // Audio is an optional preference, never a prerequisite for play.
      return false;
    }
  }

  dispose() {
    for (const unsubscribe of this._unsubscribers) unsubscribe();
    this._unsubscribers.length = 0;
    if (this.context && this.context.state !== 'closed') this.context.close().catch(() => {});
    this.context = null;
  }
}
