import buildingData from '../data/buildings.json';
import { el, button, formatFa } from './dom.js';
import { EVENTS } from '../core/EventBus.js';

const resource = (icon, label) => el('div', { className: 'game-resource', children: [el('span', { text: icon }), el('b', { text: '۰' }), el('small', { text: label })] });

export class HUD {
  constructor({ config, engine, bus, monitor, rig, buildings, onOpenQuran }) {
    Object.assign(this, { config, engine, bus, monitor, rig, buildings });
    this.levelValue = el('b', { text: '۱' });
    this.builderValue = el('b', { text: '۰/۰' });
    this.gold = resource('●', 'سکه'); this.wood = resource('▰', 'چوب'); this.stone = resource('◆', 'سنگ');
    this.player = el('div', { className: 'game-player', children: [el('span', { className: 'game-avatar', text: 'ن' }), el('div', { children: [el('small', { text: 'سطح شهر' }), this.levelValue] })] });
    this.buildersView = el('div', { className: 'game-builders', children: [el('span', { text: '⚒' }), el('div', { children: [el('small', { text: 'بنّاها' }), this.builderValue] })] });
    this.resourcesView = el('div', { className: 'game-resources', children: [this.gold, this.wood, this.stone] });

    this.shopList = el('div', { className: 'shop-list' });
    for (const def of buildingData.buildings) {
      const costs = Object.entries(def.cost).filter(([, v]) => v).map(([k, v]) => `${k === 'gold' ? 'سکه' : k === 'wood' ? 'چوب' : 'سنگ'} ${formatFa(v)}`).join(' · ');
      const item = el('button', { className: 'shop-item', attrs: { type: 'button' }, children: [
        el('span', { className: 'shop-item__icon', text: def.icon }),
        el('span', { className: 'shop-item__body', children: [el('b', { text: def.name }), el('small', { text: `${formatFa(def.size[0])}×${formatFa(def.size[1])} — ${costs}` }), el('em', { text: def.description })] }),
      ] });
      item.addEventListener('click', () => { if (buildings.startPlacement(def.id)) this.toggleShop(false); });
      this.shopList.append(item);
    }
    this.shop = el('section', { className: 'game-shop is-hidden', children: [el('header', { children: [el('h2', { text: 'فروشگاه ساختمان' }), button('×', { className: 'ui-icon-btn', onClick: () => this.toggleShop(false) })] }), this.shopList] });
    this.shopButton = button('ساخت‌وساز', { className: 'game-corner-btn game-shop-btn', onClick: () => this.toggleShop() });
    this.shopButton.prepend(el('span', { text: '🏛' }));
    this.questButton = button('مأموریت‌ها', { className: 'game-corner-btn game-quest-btn', onClick: () => this.toast('مأموریت‌ها در فاز بعد فعال می‌شوند.') });
    this.questButton.prepend(el('span', { text: '☼' }));

    this.confirmButton = button('تأیید ساخت', { className: 'ui-btn ui-btn--primary', onClick: () => buildings.confirmPlacement() });
    this.placementBar = el('div', { className: 'placement-bar is-hidden', children: [el('span', { className: 'placement-title', text: '' }), this.confirmButton, button('لغو', { className: 'ui-btn', onClick: () => buildings.cancelPlacement() })] });
    this.selection = el('div', { className: 'building-menu is-hidden' });
    this.toastNode = el('div', { className: 'game-toast' });
    this.pauseBadge = el('div', { className: 'ui-pause', text: 'متوقف' });
    this.root = el('div', { className: 'ui-root game-hud', attrs: { dir: 'rtl', lang: 'fa' }, children: [
      el('div', { className: 'ui-vignette' }), this.player, this.buildersView, this.resourcesView,
      this.shopButton, this.questButton, this.shop, this.placementBar, this.selection, this.toastNode, this.pauseBadge,
      button('راهنمای متن', { className: 'quran-policy-btn', onClick: () => onOpenQuran?.() }),
    ] });
    document.body.append(this.root);
    this._unsubscribers = [
      bus.on(EVENTS.GAME_PAUSED, ({ paused }) => this.pauseBadge.classList.toggle('is-visible', paused)),
      bus.on(EVENTS.ECONOMY_CHANGED, (v) => this.renderEconomy(v)),
      bus.on(EVENTS.PLACEMENT_CHANGED, (v) => this.renderPlacement(v)),
      bus.on(EVENTS.BUILDING_SELECTED, (v) => this.renderSelection(v)),
      bus.on(EVENTS.UI_TOAST, (v) => this.toast(v)),
    ];
    buildings._emitState();
  }

  toggleShop(force) { this.shop.classList.toggle('is-hidden', force === undefined ? !this.shop.classList.contains('is-hidden') : !force); }
  renderEconomy({ resources, level, builders }) {
    this.levelValue.textContent = formatFa(level); this.builderValue.textContent = `${formatFa(builders.available)}/${formatFa(builders.total)}`;
    this.gold.querySelector('b').textContent = formatFa(resources.gold); this.wood.querySelector('b').textContent = formatFa(resources.wood); this.stone.querySelector('b').textContent = formatFa(resources.stone);
  }
  renderPlacement(v) {
    this.placementBar.classList.toggle('is-hidden', !v.active);
    this.shopButton.classList.toggle('is-hidden', v.active);
    if (v.active) { this.placementBar.querySelector('.placement-title').textContent = `جانمایی ${v.def.name}`; this.confirmButton.disabled = !v.valid; }
  }
  renderSelection(v) {
    this.selection.replaceChildren(); this.selection.classList.toggle('is-hidden', !v); if (!v) return;
    this.selection.append(el('b', { text: v.def.name }), el('small', { text: `سطح ${formatFa(v.entity.level)} · ${v.def.description}` }), el('div', { children: [button('اطلاعات', { className: 'ui-btn', onClick: () => this.toast(v.def.description) }), button('ارتقا', { className: 'ui-btn ui-btn--primary', onClick: () => this.buildings.upgradeSelected() })] }));
  }
  toast(text) { this.toastNode.textContent = text; this.toastNode.classList.add('is-visible'); clearTimeout(this.toastTimer); this.toastTimer = setTimeout(() => this.toastNode.classList.remove('is-visible'), 2100); }
  update(dt, engine) { this.monitor.update(dt, engine.stats); }
  dispose() { clearTimeout(this.toastTimer); for (const fn of this._unsubscribers) fn(); this.root.remove(); }
}
