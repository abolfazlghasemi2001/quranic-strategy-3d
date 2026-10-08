import { EVENTS } from './EventBus.js';

const CUES = {
  harvest: { frequency: 620, endFrequency: 820, duration: 0.12, gain: 0.035 },
  build: { frequency: 420, endFrequency: 680, duration: 0.18, gain: 0.04 },
  lesson: { frequency: 540, endFrequency: 760, duration: 0.16, gain: 0.03 },
  achievement: { frequency: 660, endFrequency: 990, duration: 0.24, gain: 0.04 },
};

/**
 * Optional environmental sound synthesis (wind, water, short bird chirps) and
 * restrained UI cues. No instruments, music, or bundled audio assets.
 */
export class SoundManager {
  constructor({ bus, enabled = true } = {}) {
    this.bus = bus;
    this.enabled = Boolean(enabled);
    this.context = null;
    this.ambientMaster = null;
    this.ambientSources = [];
    this.ambientRunning = false;
    this.gestureUnlocked = false;
    this.birdTimer = 0;
    this.birdSeed = 0x51a7;
    this.voices = new Set();
    this._unsubscribers = [];

    this._onGesture = () => {
      if (this.gestureUnlocked) return;
      this.gestureUnlocked = true;
      window.removeEventListener('pointerdown', this._onGesture, true);
      window.removeEventListener('keydown', this._onGesture, true);
      if (this.enabled) this._startAmbient();
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('pointerdown', this._onGesture, { capture: true, passive: true });
      window.addEventListener('keydown', this._onGesture, { capture: true, passive: true });
    }

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
    if (!this.enabled) this._stopAmbient();
    else if (this.gestureUnlocked) this._startAmbient();
    return this.enabled;
  }

  _getContext() {
    if (typeof window === 'undefined') return null;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (typeof AudioContextClass !== 'function') return null;
    try {
      if (!this.context || this.context.state === 'closed') this.context = new AudioContextClass();
      if (this.context.state === 'suspended') this.context.resume().catch(() => {});
      return this.context;
    } catch {
      return null;
    }
  }

  _noiseBuffer(context) {
    const duration = 2;
    const frameCount = Math.max(1, Math.floor(context.sampleRate * duration));
    const buffer = context.createBuffer(1, frameCount, context.sampleRate);
    const samples = buffer.getChannelData(0);
    let state = 0x9e3779b9;
    let brown = 0;
    for (let i = 0; i < frameCount; i += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const white = (state / 0xffffffff) * 2 - 1;
      brown = (brown + 0.035 * white) / 1.035;
      samples[i] = brown * 2.8;
    }
    return buffer;
  }

  _startAmbient() {
    if (!this.enabled || !this.gestureUnlocked || this.ambientRunning) return false;
    const context = this._getContext();
    if (!context) return false;
    try {
      const buffer = this._noiseBuffer(context);
      const master = context.createGain();
      master.gain.setValueAtTime(0.0001, context.currentTime);
      master.gain.exponentialRampToValueAtTime(0.48, context.currentTime + 0.4);
      master.connect(context.destination);
      this.ambientMaster = master;

      const wind = context.createBufferSource();
      wind.buffer = buffer;
      wind.loop = true;
      const windFilter = context.createBiquadFilter();
      windFilter.type = 'lowpass';
      windFilter.frequency.value = 420;
      const windGain = context.createGain();
      windGain.gain.value = 0.018;
      wind.connect(windFilter);
      windFilter.connect(windGain);
      windGain.connect(master);
      wind.start();
      this.ambientSources.push(wind);

      const water = context.createBufferSource();
      water.buffer = buffer;
      water.loop = true;
      const waterHigh = context.createBiquadFilter();
      waterHigh.type = 'highpass';
      waterHigh.frequency.value = 250;
      const waterLow = context.createBiquadFilter();
      waterLow.type = 'lowpass';
      waterLow.frequency.value = 1500;
      const waterGain = context.createGain();
      waterGain.gain.value = 0.011;
      water.connect(waterHigh);
      waterHigh.connect(waterLow);
      waterLow.connect(waterGain);
      waterGain.connect(master);
      water.start();
      this.ambientSources.push(water);

      this.ambientRunning = true;
      this._scheduleBird();
      return true;
    } catch {
      this._stopAmbient();
      return false;
    }
  }

  _nextBirdRandom() {
    this.birdSeed = (Math.imul(this.birdSeed, 1664525) + 1013904223) >>> 0;
    return this.birdSeed / 0x100000000;
  }

  _scheduleBird() {
    if (!this.ambientRunning || !this.enabled) return;
    const delay = 8500 + Math.round(this._nextBirdRandom() * 8500);
    this.birdTimer = window.setTimeout(() => {
      this.birdTimer = 0;
      if (this.ambientRunning && this.enabled) this._playBirdChirp();
      this._scheduleBird();
    }, delay);
  }

  _playBirdChirp() {
    const context = this.context;
    if (!context || !this.ambientMaster || context.state === 'closed') return;
    const count = this._nextBirdRandom() > 0.62 ? 2 : 1;
    const now = context.currentTime;
    for (let index = 0; index < count; index += 1) {
      const start = now + index * 0.13;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const first = 1800 + this._nextBirdRandom() * 900;
      const second = first + (this._nextBirdRandom() - 0.35) * 1100;
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(first, start);
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(900, second), start + 0.13);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.0035, start + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.15);
      oscillator.connect(gain);
      gain.connect(this.ambientMaster);
      oscillator.onended = () => this.voices.delete(oscillator);
      this.voices.add(oscillator);
      oscillator.start(start);
      oscillator.stop(start + 0.17);
    }
  }

  _stopAmbient() {
    if (this.birdTimer && typeof window !== 'undefined') window.clearTimeout(this.birdTimer);
    this.birdTimer = 0;
    const now = this.context?.currentTime || 0;
    if (this.ambientMaster && this.context?.state !== 'closed') {
      try {
        this.ambientMaster.gain.cancelScheduledValues(now);
        this.ambientMaster.gain.setTargetAtTime(0.0001, now, 0.025);
      } catch {
        // Ignore partially suspended/closing contexts.
      }
    }
    for (const source of this.ambientSources) {
      try { source.stop(now + 0.04); } catch { /* already stopped */ }
      try { source.disconnect(); } catch { /* already disconnected */ }
    }
    this.ambientSources.length = 0;
    for (const voice of this.voices) {
      try { voice.stop(now + 0.02); } catch { /* already stopped */ }
    }
    this.voices.clear();
    try { this.ambientMaster?.disconnect(); } catch { /* already disconnected */ }
    this.ambientMaster = null;
    this.ambientRunning = false;
  }

  play(name = 'harvest') {
    if (!this.enabled) return false;
    const context = this._getContext();
    if (!context) return false;
    try {
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
      // Audio is optional; failed playback must never block a game action.
      return false;
    }
  }

  dispose() {
    for (const unsubscribe of this._unsubscribers) unsubscribe();
    this._unsubscribers.length = 0;
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', this._onGesture, true);
      window.removeEventListener('keydown', this._onGesture, true);
    }
    this._stopAmbient();
    if (this.context && this.context.state !== 'closed') this.context.close().catch(() => {});
    this.context = null;
  }
}
