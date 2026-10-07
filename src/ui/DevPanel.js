/**
 * DevPanel — development tools:
 *   - FPS / frame time / draw call overlay (Persian labels, Latin numbers)
 *   - grid visibility button (and the G shortcut)
 *   - camera reset, pause, and a world summary (seed, prop counts, quality tier)
 */
import { el, button, formatFa } from './dom.js';
import { EVENTS } from '../core/EventBus.js';

const TIER_LABEL = { low: 'پایین (low)', medium: 'متوسط (medium)', high: 'بالا (high)' };

export class DevPanel {
  constructor({ config, engine, bus, monitor, rig, world, onSaveNow, onSimulateOffline }) {
    this.config = config;
    this.engine = engine;
    this.bus = bus;
    this.monitor = monitor;
    this.rig = rig;
    this.world = world;
    this.onSaveNow = onSaveNow || null;
    this.onSimulateOffline = onSimulateOffline || null;

    const t = (key, fallback) => config.t(key, fallback);

    this.rows = {};
    const panel = el('div', { className: 'ui-dev-panel is-hidden' });
    panel.append(el('h2', { className: 'ui-dev-panel__title', text: t('dev.title', 'ابزار توسعه') }));

    const addRow = (key, label) => {
      const value = el('span', { className: 'ui-stat__value', text: '—' });
      panel.append(
        el('div', {
          className: 'ui-stat',
          children: [el('span', { className: 'ui-stat__label', text: label }), value],
        }),
      );
      this.rows[key] = value;
    };

    addRow('fps', t('dev.fps', 'FPS'));
    addRow('frameMs', t('dev.frameTime', 'زمان فریم'));
    addRow('drawCalls', t('dev.drawCalls', 'Draw Call'));
    addRow('triangles', t('dev.triangles', 'مثلث‌ها'));
    addRow('geometries', t('dev.geometries', 'هندسه‌ها'));
    addRow('textures', t('dev.textures', 'تکسچرها'));
    addRow('programs', t('dev.programs', 'برنامه‌های شیدر'));
    addRow('tier', t('dev.tier', 'سطح'));
    addRow('seed', 'Seed');
    addRow('props', 'Props');
    addRow('chunks', 'Chunks');
    addRow('camera', 'Camera');

    panel.append(
      el('p', {
        className: 'ui-legend',
        text: t('dev.toggles', 'کلیدهای میان‌بر'),
        children: [
          el('br'),
          el('span', { html: '<code>G</code> گرید — <code>H</code> این پنل — <code>R</code> بازنشانی دوربین — <code>P</code> توقف' }),
        ],
      }),
    );

    this.tierValue = TIER_LABEL[config.quality.tier] || config.quality.tier;

    this.saveButton = button(t('hud.saveNow', 'ذخیرهٔ فوری'), {
      className: 'ui-btn',
      dataset: { action: 'save' },
      onClick: () => this.saveNow(),
    });
    this.offlineButton = button(t('hud.simulateOffline', 'شبیه‌سازی ۱ ساعت غیبت'), {
      className: 'ui-btn',
      dataset: { action: 'offline' },
      onClick: () => this.simulateOffline(),
    });
    panel.append(el('div', { className: 'ui-dev-extra', children: [this.saveButton, this.offlineButton] }));

    this.gridButton = button(t('hud.gridOn', 'گرید: روشن'), {
      className: 'ui-btn',
      dataset: { action: 'grid' },
      onClick: () => this.toggleGrid(),
    });
    const statsButton = button(t('hud.devShow', 'نمایش پنل توسعه'), {
      className: 'ui-btn',
      dataset: { action: 'stats' },
      onClick: () => this.togglePanel(),
    });
    const resetButton = button(t('hud.cameraReset', 'بازنشانی دوربین'), {
      className: 'ui-btn',
      dataset: { action: 'reset' },
      onClick: () => this.resetCamera(),
    });
    const pauseButton = button(t('hud.pause', 'توقف'), {
      className: 'ui-btn',
      dataset: { action: 'pause' },
      onClick: () => this.togglePause(),
    });
    this.statsButton = statsButton;
    this.pauseButton = pauseButton;

    this.actions = el('div', {
      className: 'ui-dev-actions',
      children: [this.gridButton, statsButton, resetButton, pauseButton],
    });

    this.panel = panel;
    this.root = el('div', {
      className: 'ui-root',
      attrs: { dir: 'rtl', lang: 'fa' },
      children: [this.actions, panel],
    });
    document.body.append(this.root);

    this._onKeyDown = (event) => {
      if (event.repeat) return;
      switch (event.code) {
        case 'KeyG':
          this.toggleGrid();
          break;
        case 'KeyH':
          this.togglePanel();
          break;
        case 'KeyR':
          this.resetCamera();
          break;
        case 'KeyP':
          this.togglePause();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', this._onKeyDown);

    this.bus.emit(EVENTS.GRID_VISIBILITY, { visible: this.world.gridVisible });
  }

  toggleGrid() {
    const visible = !this.world.gridVisible;
    this.world.setGridVisible(visible);
    this.gridButton.querySelector('.ui-btn__label').textContent = visible
      ? this.config.t('hud.gridOn', 'گرید: روشن')
      : this.config.t('hud.gridOff', 'گرید: خاموش');
    this.gridButton.setAttribute('aria-pressed', String(visible));
    this.bus.emit(EVENTS.GRID_VISIBILITY, { visible });
  }

  togglePanel(force) {
    const hidden = typeof force === 'boolean' ? !force : !this.panel.classList.contains('is-hidden');
    this.panel.classList.toggle('is-hidden', hidden);
    this.statsButton.setAttribute('aria-pressed', String(!hidden));
    this.statsButton.querySelector('.ui-btn__label').textContent = hidden
      ? this.config.t('hud.devShow', 'نمایش پنل توسعه')
      : this.config.t('hud.devHide', 'پنهان‌کردن پنل توسعه');
  }

  resetCamera() {
    this.rig.reset();
    this.bus.emit(EVENTS.CAMERA_RESET, {});
  }

  saveNow() {
    if (this.onSaveNow) this.onSaveNow();
  }

  simulateOffline() {
    if (this.onSimulateOffline) this.onSimulateOffline();
  }

  togglePause() {
    this.engine.togglePause();
    const paused = this.engine.paused;
    this.pauseButton.querySelector('.ui-btn__label').textContent = paused
      ? this.config.t('hud.resume', 'ادامه')
      : this.config.t('hud.pause', 'توقف');
    this.pauseButton.setAttribute('aria-pressed', String(paused));
  }

  update(dt, engine) {
    const snapshot = this.monitor.update(dt, engine.stats);
    if (!snapshot) return;

    this.rows.fps.textContent = snapshot.fps.toFixed(1);
    this.rows.frameMs.textContent = `${snapshot.frameMs.toFixed(1)} ms`;
    this.rows.drawCalls.textContent = String(snapshot.drawCalls);
    this.rows.triangles.textContent = snapshot.triangles.toLocaleString('en-US');
    this.rows.geometries.textContent = String(snapshot.geometries);
    this.rows.textures.textContent = String(snapshot.textures);
    this.rows.programs.textContent = String(snapshot.programs);
    this.rows.tier.textContent = this.tierValue;
    this.rows.seed.textContent = String(this.config.seed);
    this.rows.camera.textContent = `${this.rig.distance.toFixed(1)} / ${Math.round((this.rig.yaw * 180) / Math.PI)}°`;

    const props = this.world.placements;
    this.rows.props.textContent = `${props.tree.length} / ${props.rock.length} / ${props.shrub.length}`;
    this.rows.chunks.textContent = String(this.world.chunks.size);

    const budget = this.config.targets.maxDrawCalls || 150;
    this.rows.drawCalls.classList.toggle('ui-stat__value--bad', snapshot.drawCalls > budget);
    this.rows.fps.classList.toggle('ui-stat__value--good', snapshot.fps >= 55);
    this.rows.fps.classList.toggle('ui-stat__value--bad', snapshot.fps < 40);
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    this.root.remove();
  }
}
