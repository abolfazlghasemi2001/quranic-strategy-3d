import * as THREE from 'three';
import { el, button, faDigits } from './dom.js';
import { EVENTS } from '../core/EventBus.js';

/** Interactive, replayable first-session guide with DOM and world-space targets. */
export class FTUEGuide {
  constructor({ config, bus, metaSystem, engine, hud, buildings, rig, parent = document.body, isModalOpen = null }) {
    Object.assign(this, { config, bus, metaSystem, engine, hud, buildings, rig, isModalOpen });
    this._targetNode = null;
    this._targetCanvas = false;
    this._lastKey = '';
    this._positionTimer = 0;

    this.worldRing = el('div', { className: 'ftue-world-ring is-hidden', attrs: { 'aria-hidden': 'true' } });
    this.arrow = el('div', { className: 'ftue-arrow is-hidden', text: '↓', attrs: { 'aria-hidden': 'true' } });
    this.card = el('section', { className: 'ftue-card', attrs: { 'aria-live': 'polite' } });
    this.root = el('div', {
      className: 'ftue-guide is-hidden',
      attrs: { dir: 'rtl', lang: 'fa' },
      children: [this.worldRing, this.arrow, this.card],
    });
    parent.append(this.root);

    this._unsubscribers = [
      bus.on(EVENTS.FTUE_CHANGED, () => this.render()),
      bus.on(EVENTS.META_CHANGED, () => this.render()),
      bus.on(EVENTS.FTUE_COMPLETED, () => this.render()),
      bus.on(EVENTS.FTUE_SKIPPED, () => this.render()),
      bus.on(EVENTS.QURAN_PANEL_OPENED, () => this.render()),
      bus.on(EVENTS.QURAN_PANEL_CLOSED, () => this.render()),
    ];
    this.render();
  }

  render() {
    const tutorial = this.metaSystem.tutorialSnapshot();
    const visible = tutorial.active && !this.isModalOpen?.();
    this.root.classList.toggle('is-hidden', !visible);
    if (!visible) {
      this._clearTarget();
      this._lastKey = '';
      return;
    }
    const step = tutorial.step;
    const key = `${step?.id || 'none'}:${tutorial.replaying}:${tutorial.stepIndex}:${tutorial.status}`;
    if (key !== this._lastKey) {
      this._lastKey = key;
      this._renderCard(tutorial);
    }
    this._positionTarget(step?.target);
  }

  _renderCard(tutorial) {
    const step = tutorial.step;
    if (!step) {
      this.card.replaceChildren(el('h2', { text: 'راهنما در دسترس نیست' }));
      return;
    }
    const replaying = tutorial.replaying;
    const counter = `گام ${faDigits(tutorial.stepIndex + 1)} از ${faDigits(tutorial.totalSteps)}`;
    const buttons = [];

    if (replaying) {
      buttons.push(button('قبلی', {
        className: 'ui-btn ftue-action',
        onClick: () => this.metaSystem.stepReplay(-1),
      }));
      buttons.push(button(tutorial.stepIndex === tutorial.totalSteps - 1 ? 'پایان بازبینی' : 'بعدی', {
        className: 'ui-btn ui-btn--primary ftue-action',
        onClick: () => this.metaSystem.stepReplay(1),
      }));
      buttons.push(button('بستن بازبینی', {
        className: 'ui-btn ftue-action ftue-action--skip',
        onClick: () => this.metaSystem.closeReplay(),
      }));
    } else {
      if (step.id !== 'free-play') {
        buttons.push(button('بعداً / رد این نکته', {
          className: 'ui-btn ftue-action',
          onClick: () => this.metaSystem.advanceTutorialHint(),
        }));
      }
      buttons.push(button(step.id === 'free-play' ? 'بستن راهنما' : 'رد کردن راهنما', {
        className: 'ui-btn ftue-action ftue-action--skip',
        onClick: () => {
          this.metaSystem.skipTutorial();
          this.bus.emit(EVENTS.UI_TOAST, { message: 'راهنما پنهان شد؛ هر زمان از تنظیمات می‌توانی دوباره ببینی.', type: 'info' });
        },
      }));
    }

    this.card.replaceChildren(
      el('div', {
        className: 'ftue-card__top',
        children: [el('span', { className: 'ftue-card__eyebrow', text: replaying ? 'بازبینی راهنمای شروع' : 'راهنمای ۳۰ دقیقهٔ نخست' }), el('small', { text: counter })],
      }),
      el('h2', { className: 'ftue-card__title', text: step.title }),
      el('p', { className: 'ftue-card__body', text: step.body }),
      el('small', { className: 'ftue-card__target', text: `هدف این گام: ${step.actionLabel || 'ادامه به انتخاب خودت'}` }),
      el('small', { className: 'ftue-card__policy', text: 'بدون مهلت، جریمهٔ غیبت یا پاداش ازدست‌رفتنی.' }),
      el('div', { className: 'ftue-card__actions', children: buttons }),
    );
  }

  _positionTarget(targetId) {
    this._clearTarget();
    if (!targetId) return;

    if (targetId === 'free-plot') {
      const point = this._nearestFreeFarmPoint();
      if (point) {
        const screen = this._project(point);
        if (screen) this._placeWorldTarget(screen);
      }
      this._targetCanvas = true;
      document.getElementById('scene')?.classList.add('ftue-canvas-focus');
      return;
    }

    if (targetId === 'farm-world') {
      const entity = [...this.buildings.state.entities.values()].find((item) => item.type === 'farm');
      if (entity) {
        const point = {
          x: (entity.col + entity.size[0] / 2) * this.config.tileSize,
          y: 3.5,
          z: (entity.row + entity.size[1] / 2) * this.config.tileSize,
        };
        const screen = this._project(point);
        if (screen) this._placeWorldTarget(screen);
      }
      return;
    }

    const node = this._resolveTarget(targetId);
    if (!node || !node.isConnected || node.classList.contains('is-hidden')) return;
    node.classList.add('ftue-focused');
    this._targetNode = node;
    const rect = node.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      this._placeArrow(rect.left + rect.width / 2, Math.max(14, rect.top - 38));
    }
  }

  _resolveTarget(targetId) {
    switch (targetId) {
      case 'shop': return this.hud.shopButton;
      case 'farm-card':
        return this.hud.shop.classList.contains('is-hidden')
          ? this.hud.shopButton
          : this.hud.shopList.querySelector('.shop-item[data-def="farm"]');
      case 'queue': return this.hud.queuePanel.classList.contains('is-hidden') ? this.hud.shopButton : this.hud.queuePanel;
      case 'study': return this.hud.studyButton;
      case 'campaign': return this.hud.questButton;
      case 'settings': return this.hud.settingsButton;
      case 'profile': return this.hud.player;
      default: return null;
    }
  }

  _nearestFreeFarmPoint() {
    const definition = this.buildings.byId.get('farm');
    if (!definition) return null;
    const placement = this.buildings.placing;
    if (placement?.def?.id === 'farm' && placement.valid) {
      return {
        x: (placement.col + definition.size[0] / 2) * this.config.tileSize,
        y: 0.4,
        z: (placement.row + definition.size[1] / 2) * this.config.tileSize,
      };
    }
    const focus = this.rig.focus || this.config.mapCenter;
    let best = null;
    let bestDistance = Infinity;
    for (let row = 0; row <= this.config.rows - definition.size[1]; row += 1) {
      for (let col = 0; col <= this.config.cols - definition.size[0]; col += 1) {
        if (!this.buildings.canPlace(definition, col, row)) continue;
        const point = {
          x: (col + definition.size[0] / 2) * this.config.tileSize,
          y: 0.4,
          z: (row + definition.size[1] / 2) * this.config.tileSize,
        };
        const distance = (point.x - focus.x) ** 2 + (point.z - focus.z) ** 2;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = point;
        }
      }
    }
    return best;
  }

  _project(point) {
    if (!this.engine?.camera) return null;
    this.engine.camera.updateMatrixWorld(true);
    const vector = new THREE.Vector3(point.x, point.y, point.z).project(this.engine.camera);
    if (vector.z < -1 || vector.z > 1) return null;
    const width = window.innerWidth || this.engine.viewport?.width || 1;
    const height = window.innerHeight || this.engine.viewport?.height || 1;
    return { x: (vector.x * 0.5 + 0.5) * width, y: (-vector.y * 0.5 + 0.5) * height };
  }

  _placeWorldTarget(screen) {
    this.worldRing.classList.remove('is-hidden');
    this.worldRing.style.left = `${screen.x}px`;
    this.worldRing.style.top = `${screen.y}px`;
    this._placeArrow(screen.x, Math.max(14, screen.y - 48));
  }

  _placeArrow(x, y) {
    this.arrow.classList.remove('is-hidden');
    this.arrow.style.left = `${x}px`;
    this.arrow.style.top = `${y}px`;
  }

  _clearTarget() {
    this._targetNode?.classList.remove('ftue-focused');
    this._targetNode = null;
    if (this._targetCanvas) document.getElementById('scene')?.classList.remove('ftue-canvas-focus');
    this._targetCanvas = false;
    this.worldRing.classList.add('is-hidden');
    this.arrow.classList.add('is-hidden');
  }

  update(dt) {
    this._positionTimer += dt;
    if (this._positionTimer < 0.16) return;
    this._positionTimer = 0;
    this.render();
  }

  dispose() {
    for (const unsubscribe of this._unsubscribers) unsubscribe();
    this._unsubscribers.length = 0;
    this._clearTarget();
    this.root.remove();
  }
}
