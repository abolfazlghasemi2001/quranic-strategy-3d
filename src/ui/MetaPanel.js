import { el, button, formatFa, faDigits } from './dom.js';
import { EVENTS } from '../core/EventBus.js';

function progressNode(ratio, className = 'meta-progress') {
  const bar = el('div', { className, attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' } });
  const fill = el('i');
  fill.style.setProperty('--progress', `${Math.max(0, Math.min(100, ratio * 100))}%`);
  bar.append(fill);
  return bar;
}

/** Player profile: level/XP, persisted achievements, daily task and first-30 route. */
export class MetaPanel {
  constructor({ config, bus, metaSystem, parent = document.body, onReplay = null, onPause = null, onResume = null }) {
    this.config = config;
    this.bus = bus;
    this.metaSystem = metaSystem;
    this.onReplay = onReplay;
    this.onPause = onPause;
    this.onResume = onResume;
    this.open = false;
    this._extraActions = [];

    this.card = el('div', { className: 'ui-modal__card meta-card' });
    this.root = el('div', {
      className: 'ui-modal meta-ui is-hidden',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'کارنامهٔ بازیکن', dir: 'rtl', lang: 'fa' },
      children: [el('div', { className: 'ui-modal__backdrop' }), this.card],
    });
    this.root.querySelector('.ui-modal__backdrop').addEventListener('click', () => this.close());
    this._onKey = (event) => {
      if (event.key === 'Escape') this.close();
    };
    this._unsubscribers = [
      bus.on(EVENTS.META_CHANGED, (snapshot) => {
        if (this.open) this.render(snapshot);
      }),
      bus.on(EVENTS.FTUE_CHANGED, () => {
        if (this.open) this.render();
      }),
    ];
    parent.append(this.root);
  }

  /**
   * Secondary entry points owned by the HUD (پادگان / نبرد / راهنمای متن).
   * They live here instead of floating over the map: the top bar stays status
   * only and the action dock keeps its five thumb-zone slots. The nodes are
   * reused (not cloned) so badges keep updating in place.
   */
  setExtraActions(nodes = []) {
    this._extraActions = nodes.filter(Boolean);
    if (this.open) this.render();
  }

  show() {
    if (this.open) return;
    this.open = true;
    this.root.classList.remove('is-hidden');
    window.addEventListener('keydown', this._onKey);
    this.bus.emit(EVENTS.META_PANEL_OPENED, {});
    this.render();
    this.onPause?.();
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.root.classList.add('is-hidden');
    window.removeEventListener('keydown', this._onKey);
    this.onResume?.();
  }

  render(snapshot = this.metaSystem.snapshot()) {
    const { level, xp, currentXp, nextXp, progress, achievements, dailyMission, tutorial, timeline } = snapshot;
    const nextLabel = nextXp == null ? 'بالاترین سطح' : `${formatFa(xp)} / ${formatFa(nextXp)} XP`;
    const daily = dailyMission
      ? el('section', {
        className: `meta-daily${dailyMission.completed ? ' is-complete' : ''}`,
        children: [
          el('div', {
            className: 'meta-section-head',
            children: [el('span', { className: 'meta-daily__icon', text: dailyMission.icon || '✦' }), el('div', { children: [el('h3', { text: 'مأموریت روزانه — اختیاری' }), el('small', { text: dailyMission.title })] })],
          }),
          el('p', { className: 'meta-copy', text: dailyMission.description }),
          progressNode(dailyMission.progressRatio, 'meta-progress'),
          el('div', {
            className: 'meta-daily__status',
            children: [
              el('span', { text: dailyMission.completed ? 'انجام شد؛ XP ثبت شد.' : `پیشرفت ${formatFa(dailyMission.progress)} از ${formatFa(dailyMission.target)}` }),
              dailyMission.completed ? el('b', { text: '✓' }) : el('small', { text: 'بی‌مهلت' }),
            ],
          }),
          el('small', { className: 'meta-no-pressure', text: 'پیشرفت نیمه‌کاره ذخیره می‌ماند؛ روز ازدست‌رفته، جریمه و زنجیرهٔ ورود وجود ندارد.' }),
        ],
      })
      : el('section', { className: 'meta-daily', children: [el('h3', { text: 'تمرین روزانه فعلاً در دسترس نیست.' })] });

    const achievementList = el('div', {
      className: 'meta-achievements',
      children: achievements.map((achievement) => el('article', {
        className: `meta-achievement${achievement.unlocked ? ' is-unlocked' : ''}`,
        children: [
          el('span', { className: 'meta-achievement__icon', text: achievement.icon || '✦' }),
          el('div', {
            className: 'meta-achievement__body',
            children: [
              el('b', { text: achievement.title }),
              el('small', { text: achievement.description }),
              achievement.unlocked
                ? el('em', { text: `دریافت‌شده · +${formatFa(achievement.xp)} XP` })
                : el('em', { text: `پیشرفت ${formatFa(achievement.progress)} / ${formatFa(achievement.target)} · +${formatFa(achievement.xp)} XP` }),
            ],
          }),
          el('span', { className: 'meta-achievement__mark', text: achievement.unlocked ? '✓' : '○' }),
        ],
      })),
    });

    const routeList = el('ol', {
      className: 'meta-route',
      children: timeline.map((entry) => el('li', {
        className: `meta-route__item${entry.done ? ' is-done' : ''}${entry.suggested && !entry.done ? ' is-suggested' : ''}`,
        children: [
          el('span', { className: 'meta-route__mark', text: entry.done ? '✓' : faDigits(entry.range) }),
          el('div', {
            className: 'meta-route__body',
            children: [el('b', { text: entry.title }), el('small', { text: entry.body })],
          }),
        ],
      })),
    });

    const activeMinutes = Math.min(tutorial.targetMinutes, tutorial.playMinutes);
    const playtimeLine = el('p', {
      className: 'meta-route__time',
      text: `زمان بازی فعال در مسیر آغاز: ${formatFa(activeMinutes)} از ${formatFa(tutorial.targetMinutes)} دقیقه. این فقط ثبت پیشرفت است، نه شمارش معکوس.`,
    });
    const guideButton = button('نمایش دوبارهٔ راهنمای گام‌به‌گام', {
      className: 'ui-btn ui-btn--primary',
      onClick: () => {
        this.close();
        this.onReplay?.();
      },
    });

    this.card.replaceChildren(
      el('header', {
        className: 'ui-modal__header',
        children: [el('h2', { className: 'ui-modal__title', text: 'کارنامهٔ بازیکن' }), button('×', { className: 'ui-icon-btn', title: 'بستن', onClick: () => this.close() })],
      }),
      el('section', {
        className: 'meta-level-card',
        children: [
          el('div', { className: 'meta-level-card__head', children: [el('span', { className: 'meta-level__badge', text: formatFa(level) }), el('div', { children: [el('b', { text: `سطح بازیکن ${formatFa(level)}` }), el('small', { text: `${formatFa(xp)} XP · گام فعلی از سطح ${formatFa(level)}: ${formatFa(currentXp)} XP` })] })] }),
          progressNode(progress, 'meta-progress meta-progress--level'),
          el('small', { className: 'meta-level-card__next', text: nextLabel }),
          el('small', { className: 'meta-level-card__note', text: 'XP فقط برای کارنامه است؛ خریدنی نیست، از دست نمی‌رود و قدرت رزمی نمی‌دهد.' }),
        ],
      }),
      daily,
      el('section', { className: 'meta-section', children: [el('h3', { className: 'meta-section__title', text: `دستاوردها · ${formatFa(achievements.filter((item) => item.unlocked).length)} / ${formatFa(achievements.length)}` }), achievementList] }),
      el('section', {
        className: 'meta-section meta-route-section',
        children: [
          el('div', { className: 'meta-route__heading', children: [el('h3', { className: 'meta-section__title', text: 'نقشهٔ ۳۰ دقیقهٔ نخست' }), el('small', { text: 'دقایق تقریبی‌اند؛ هیچ بخش یا پاداشی با گذشت زمان از دست نمی‌رود.' })] }),
          playtimeLine,
          routeList,
        ],
      }),
      guideButton,
      ...(this._extraActions.length
        ? [el('section', {
          className: 'meta-section meta-actions-section',
          dataset: { hudRegion: 'meta-actions' },
          children: [
            el('h3', { className: 'meta-section__title', text: 'سپاه، نبرد و متن‌ها' }),
            el('small', {
              className: 'meta-copy',
              text: 'این کنش‌ها از نوار بالای صفحه برداشته شدند تا روی گوشی در دسترس شست باشند.',
            }),
            el('div', { className: 'meta-actions-grid', children: [...this._extraActions] }),
          ],
        })]
        : []),
    );   // spread, never a bare `null` slot: replaceChildren() would stringify it
  }

  dispose() {
    this.close();
    for (const unsubscribe of this._unsubscribers) unsubscribe();
    this._unsubscribers.length = 0;
    this.root.remove();
  }
}
