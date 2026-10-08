/**
 * JamaatPanel — «جماعت»: the friendly multiplayer home.
 *
 * Three tabs: chat (filtered + reportable, presets for child accounts),
 * members (roster + mutual build help) and the weekly cooperative event
 * (shared goal, donations, friendly leaderboard). Fully offline-safe: every
 * action degrades to a clear message when the server is unreachable.
 *
 * Never renders Quran text (no .quran-text anywhere near this panel).
 */
import buildingData from '../../data/buildings.json';
import { el, button, formatFa, faDigits, clear } from '../dom.js';
import { EVENTS } from '../../core/EventBus.js';

const TABS = [
  ['chat', '💬', 'tabChat', 'گفتگو'],
  ['members', '🤝', 'tabMembers', 'جماعت و کمک'],
  ['event', '🎯', 'tabEvent', 'رویداد هفتگی'],
];

const DONATE_AMOUNTS = [25, 50, 100];

export class JamaatPanel {
  /**
   * @param {object} options
   * @param {import('../../game/social/SocialSystem.js').SocialSystem} options.social
   * @param {import('../../game/Game.js').Game} options.game
   */
  constructor({ config, bus, social, game, parent = document.body }) {
    Object.assign(this, { config, bus, social, game });
    this.open = false;
    this.tab = 'chat';
    this._reportingFor = null; // message id with the reason picker open
    this._giveCooldownUntil = 0;
    this._acc = 0;

    this.t = (key, fallback) => config.t(`social.${key}`, fallback);

    this.statusPill = el('span', { className: 'social-status social-status--offline', text: '' });
    this.card = el('div', { className: 'ui-modal__card social-card' });
    this.root = el('div', {
      className: 'ui-modal social-ui is-hidden',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'جماعت', dir: 'rtl', lang: 'fa' },
      children: [el('div', { className: 'ui-modal__backdrop' }), this.card],
    });
    this.root.querySelector('.ui-modal__backdrop').addEventListener('click', () => this.close());

    this.connectBox = el('section', { className: 'social-connect' });
    this.tabBar = el('nav', { className: 'social-tabs' });
    this.tabButtons = {};
    for (const [id, icon, labelKey, fallback] of TABS) {
      const btn = button(this.t(labelKey, fallback), {
        className: 'ui-btn social-tab',
        onClick: () => this.setTab(id),
      });
      btn.prepend(el('span', { text: icon }));
      this.tabButtons[id] = btn;
      this.tabBar.append(btn);
    }
    this.chatLog = el('div', { className: 'social-chat-log' });
    this.chatComposer = el('div', { className: 'social-composer' });
    this.chatTab = el('section', { className: 'social-tabpane', children: [this.chatLog, this.chatComposer] });
    this.membersTab = el('section', { className: 'social-tabpane is-hidden' });
    this.eventTab = el('section', { className: 'social-tabpane is-hidden' });

    this.card.replaceChildren(
      el('header', {
        className: 'ui-modal__header',
        children: [
          el('div', {
            className: 'social-header-actions',
            children: [el('h2', { className: 'ui-modal__title', text: this.t('title', '◈ جماعت') }), this.statusPill],
          }),
          button('×', { className: 'ui-icon-btn', title: 'بستن', onClick: () => this.close() }),
        ],
      }),
      this.connectBox,
      this.tabBar,
      this.chatTab,
      this.membersTab,
      this.eventTab,
      el('p', { className: 'social-privacy', text: this.t('privacy', 'فقط نام نمایشی ذخیره می‌شود؛ بدون اطلاعات شخصی. گفتگو ذخیرهٔ دائم ندارد.') }),
    );
    parent.append(this.root);

    this._onKey = (event) => {
      if (event.key === 'Escape') this.close();
    };
    this._unsubscribers = [
      bus.on(EVENTS.SOCIAL_STATUS, () => this.renderAll()),
      bus.on(EVENTS.SOCIAL_CHAT, () => this.renderChat()),
      bus.on(EVENTS.SOCIAL_PRESENCE, () => this.renderMembers()),
      bus.on(EVENTS.SOCIAL_HELP, () => this.renderMembers()),
      bus.on(EVENTS.SOCIAL_EVENT, () => this.renderEvent()),
      bus.on(EVENTS.BUILD_QUEUE_CHANGED, () => {
        if (this.open && this.tab === 'members') this.renderMembers();
      }),
    ];
    this.renderAll();
  }

  /* ------------------------------------------------------------ show/hide */

  show() {
    if (this.open) return;
    this.open = true;
    this.root.classList.remove('is-hidden');
    window.addEventListener('keydown', this._onKey);
    this.social.setPanelOpen(true);
    this.renderAll();
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.root.classList.add('is-hidden');
    window.removeEventListener('keydown', this._onKey);
    this.social.setPanelOpen(false);
  }

  setTab(id) {
    this.tab = id;
    this.chatTab.classList.toggle('is-hidden', id !== 'chat');
    this.membersTab.classList.toggle('is-hidden', id !== 'members');
    this.eventTab.classList.toggle('is-hidden', id !== 'event');
    for (const [key, btn] of Object.entries(this.tabButtons)) {
      btn.classList.toggle('ui-btn--primary', key === id);
    }
    if (id === 'chat') this.renderChat();
    if (id === 'members') this.renderMembers();
    if (id === 'event') this.renderEvent();
  }

  update(dt) {
    if (!this.open) return;
    // Re-enable help buttons when the giver cooldown expires.
    this._acc += dt;
    if (this._acc < 1) return;
    this._acc = 0;
    if (this._giveCooldownUntil && Date.now() >= this._giveCooldownUntil) {
      this._giveCooldownUntil = 0;
      if (this.tab === 'members') this.renderMembers();
    }
  }

  /* --------------------------------------------------------------- render */

  renderAll() {
    this.renderStatus();
    this.renderConnect();
    this.renderChat();
    this.renderMembers();
    this.renderEvent();
    for (const [key, btn] of Object.entries(this.tabButtons)) {
      btn.classList.toggle('ui-btn--primary', key === this.tab);
    }
  }

  renderStatus() {
    const online = this.social.isOnline();
    const status = this.social.status;
    this.statusPill.className = `social-status social-status--${online ? 'online' : status === 'connecting' ? 'connecting' : status === 'error' ? 'error' : 'offline'}`;
    this.statusPill.textContent = online
      ? this.t('online', 'متصل')
      : status === 'connecting'
        ? this.t('connecting', 'در حال اتصال…')
        : status === 'error'
          ? this.t('error', 'خطا')
          : this.t('offline', 'آفلاین');
  }

  renderConnect() {
    const box = clear(this.connectBox);
    const online = this.social.isOnline();
    const prefs = this.social.prefs;
    if (online) {
      const name = this.social.snapshot().displayName || prefs.displayName;
      box.append(
        el('div', {
          className: 'social-online-row',
          children: [
            el('span', { className: 'social-online-dot' }),
            el('small', { text: `${this.t('connectedAs', 'متصل به جماعت به‌عنوان')} «${name}»${prefs.isChild ? ` · ${this.t('childAccount', 'حساب کودک')}` : ''}` }),
            button(this.t('disconnect', 'قطع اتصال'), { className: 'ui-btn social-disconnect', onClick: () => this.social.disconnect() }),
          ],
        }),
      );
      return;
    }

    const nameInput = el('input', {
      className: 'social-input',
      attrs: { type: 'text', maxlength: '16', placeholder: this.t('namePlaceholder', 'نام نمایشی (مثلاً: نگهبان نور)'), value: prefs.displayName || '', 'aria-label': this.t('nameLabel', 'نام نمایشی') },
    });
    const childToggle = el('input', { className: 'settings-toggle', attrs: { type: 'checkbox', 'aria-label': this.t('childLabel', 'حساب کودک') } });
    childToggle.checked = !!prefs.isChild;
    const urlInput = el('input', {
      className: 'social-input social-url',
      attrs: { type: 'text', value: this.social.defaultUrl(), 'aria-label': this.t('serverLabel', 'نشانی سرور'), dir: 'ltr' },
    });
    const connecting = this.social.status === 'connecting';
    const connectButton = button(this.t('connect', 'اتصال به جماعت'), {
      className: 'ui-btn ui-btn--primary',
      onClick: () => {
        this.social.connect({ displayName: nameInput.value, isChild: childToggle.checked, url: urlInput.value.trim() || undefined })
          .catch(() => {});
      },
    });
    connectButton.disabled = connecting;
    box.append(
      el('div', {
        className: 'social-form',
        children: [
          nameInput,
          el('label', { className: 'social-child', children: [childToggle, el('small', { text: this.t('childHint', 'حساب کودک: فقط پیام آماده') })] }),
          urlInput,
          connectButton,
        ],
      }),
      el('small', { className: 'social-offline-note', text: this.t('offlineNote', 'آفلاین هم می‌توانی بازی کنی؛ اتصال فقط برای گفتگو، کمک و رویداد هفتگی است.') }),
    );
  }

  renderChat() {
    const online = this.social.isOnline();
    const prefs = this.social.prefs;
    const log = clear(this.chatLog);
    if (!online) {
      log.append(el('p', { className: 'social-empty', text: this.t('chatOffline', 'برای گفتگو با جماعت، نخست وصل شو.') }));
    } else if (this.social.chat.length === 0) {
      log.append(el('p', { className: 'social-empty', text: this.t('chatEmpty', 'هنوز پیامی نیست؛ سلام کن! 👋') }));
    } else {
      for (const message of this.social.chat) log.append(this._messageNode(message));
      log.scrollTop = log.scrollHeight;
    }

    const composer = clear(this.chatComposer);
    if (!online) return;
    const presets = this.social.serverConfig?.quickChat?.length
      ? this.social.serverConfig.quickChat
      : (this.config.social.quickChat || []);
    const presetRow = el('div', { className: 'social-presets' });
    for (const preset of presets) {
      presetRow.append(button(preset.text, {
        className: 'ui-btn social-preset',
        onClick: () => this.social.sendPreset(preset.id),
      }));
    }
    composer.append(presetRow);
    if (!prefs.isChild) {
      const input = el('input', {
        className: 'social-input social-chat-input',
        attrs: { type: 'text', maxlength: String(this.social.serverConfig?.chat?.maxLength || 280), placeholder: this.t('chatPlaceholder', 'پیام به جماعت…') },
      });
      const send = () => {
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        this.social.sendChat(text);
      };
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') send();
        event.stopPropagation();
      });
      composer.append(el('div', {
        className: 'social-chat-row',
        children: [input, button(this.t('send', 'ارسال'), { className: 'ui-btn ui-btn--primary', onClick: send })],
      }));
    } else {
      composer.append(el('small', { className: 'social-child-note', text: this.t('childChatNote', 'حساب کودک فقط پیام آماده می‌فرستد 🙂') }));
    }
  }

  _messageNode(message) {
    const mine = message.from?.id === this.social.playerId;
    const node = el('div', { className: `social-msg${mine ? ' social-msg--mine' : ''}` });
    node.append(
      el('div', {
        className: 'social-msg__head',
        children: [
          el('b', { text: mine ? this.t('you', 'شما') : (message.from?.name || '؟') }),
          message.preset ? el('small', { className: 'social-msg__preset', text: this.t('presetTag', 'آماده') }) : null,
        ],
      }),
      el('p', { className: 'social-msg__text', text: message.text }),
    );
    if (!mine && this.social.isOnline()) {
      if (this._reportingFor === message.id) {
        const reasons = el('div', { className: 'social-report-row' });
        const reasonList = this.social.serverConfig?.reportReasons?.length
          ? this.social.serverConfig.reportReasons
          : (this.config.social.reportReasons || []);
        for (const reason of reasonList) {
          reasons.append(button(reason.text, {
            className: 'ui-btn social-reason',
            onClick: () => {
              this._reportingFor = null;
              this.social.reportMessage(message.id, reason.id);
              this.renderChat();
            },
          }));
        }
        reasons.append(button('×', { className: 'ui-icon-btn', title: 'انصراف', onClick: () => { this._reportingFor = null; this.renderChat(); } }));
        node.append(reasons);
      } else {
        node.append(button(this.t('report', '⚑ گزارش'), {
          className: 'ui-btn social-report-btn',
          onClick: () => { this._reportingFor = message.id; this.renderChat(); },
        }));
      }
    }
    return node;
  }

  renderMembers() {
    const pane = clear(this.membersTab);
    const online = this.social.isOnline();
    if (!online) {
      pane.append(el('p', { className: 'social-empty', text: this.t('membersOffline', 'برای دیدن جماعت و کمک متقابل، نخست وصل شو.') }));
      return;
    }
    // Roster.
    pane.append(el('h3', { className: 'social-sub', text: this.t('roster', 'اعضای جماعت') }));
    const roster = el('div', { className: 'social-roster' });
    if (this.social.members.length === 0) {
      roster.append(el('p', { className: 'social-empty', text: this.t('rosterEmpty', 'کسی اینجا نیست.') }));
    }
    for (const member of this.social.members) {
      const mine = member.id === this.social.playerId;
      roster.append(el('div', {
        className: `social-member${mine ? ' social-member--mine' : ''}`,
        children: [
          el('span', { className: `social-dot${member.online ? ' social-dot--on' : ''}` }),
          el('div', {
            className: 'social-member__body',
            children: [
              el('b', { text: `${member.name}${mine ? ` (${this.t('you', 'شما')})` : ''}` }),
              el('small', { text: `${this.t('cityLevel', 'سطح شهر')} ${formatFa(member.cityLevel || 1)} · ${this.t('points', 'امتیاز')} ${formatFa(member.points || 0)} · ${this.t('helps', 'کمک')} ${formatFa(member.helpsGiven || 0)}` }),
            ],
          }),
        ],
      }));
    }
    pane.append(roster);

    // My jobs → ask for help.
    pane.append(el('h3', { className: 'social-sub', text: this.t('myBuilds', 'ساخت‌های من — درخواست کمک') }));
    const myJobs = (this.game.queue?.jobs || []).filter((job) => job.status === 'active' && !job.hold && (job.kind === 'build' || job.kind === 'upgrade'));
    const mine = el('div', { className: 'social-help-list' });
    if (myJobs.length === 0) {
      mine.append(el('p', { className: 'social-empty', text: this.t('noActiveBuild', 'ساخت فعالی نداری.') }));
    }
    const myRequests = this.social.myOpenRequests();
    for (const job of myJobs) {
      const def = buildingData.buildings.find((entry) => entry.id === (job.type || job.defId));
      const open = myRequests.find((request) => request.jobId === job.id);
      const isServer = typeof job.id === 'string' && job.id.startsWith('srv-');
      const row = el('div', {
        className: 'social-help-row',
        children: [
          el('span', { className: 'queue-icon', text: def?.icon || '▣' }),
          el('div', {
            className: 'social-help-row__body',
            children: [
              el('b', { text: def?.name || job.type }),
              el('small', { text: open ? `${this.t('helpsReceived', 'کمک دریافتی')} ${formatFa(open.helps || 0)}` : this.t('noHelpYet', 'هنوز کمکی نرسیده') }),
            ],
          }),
        ],
      });
      if (!isServer) {
        row.append(el('small', { className: 'social-dim', text: this.t('localOnly', 'تک‌نفره') }));
      } else if (open) {
        row.append(button(this.t('cancelRequest', 'لغو درخواست'), {
          className: 'ui-btn', onClick: () => this.social.cancelHelp(open.id),
        }));
      } else {
        row.append(button(this.t('askHelp', 'درخواست کمک'), {
          className: 'ui-btn ui-btn--primary', onClick: () => this.social.requestHelp(job.id),
        }));
      }
      mine.append(row);
    }
    pane.append(mine);

    // Others' requests → give help.
    pane.append(el('h3', { className: 'social-sub', text: this.t('helpOthers', 'کمک به هم‌جماعتی‌ها') }));
    const others = el('div', { className: 'social-help-list' });
    const openForMe = this.social.openHelpForMe();
    if (openForMe.length === 0) {
      others.append(el('p', { className: 'social-empty', text: this.t('noHelpNeeded', 'کسی کمک نمی‌خواهد؛ بعداً سر بزن 🙂') }));
    }
    const cooling = Date.now() < this._giveCooldownUntil;
    const helpSeconds = this.social.serverConfig?.help?.seconds || this.config.social.help?.seconds || 60;
    for (const request of openForMe) {
      const member = this.social.members.find((entry) => entry.id === request.playerId);
      const def = buildingData.buildings.find((entry) => entry.id === request.defId);
      const alreadyHelped = (request.helpedBy || []).includes(this.social.playerId);
      const giveButton = button(this.t('giveHelp', 'کمک کن'), {
        className: 'ui-btn ui-btn--primary',
        onClick: () => {
          this.social.giveHelp(request.id).then((answer) => {
            if (answer?.ok) this._giveCooldownUntil = Date.now() + 30000;
          });
        },
      });
      giveButton.disabled = cooling || alreadyHelped;
      others.append(el('div', {
        className: 'social-help-row',
        children: [
          el('span', { className: 'queue-icon', text: def?.icon || '▣' }),
          el('div', {
            className: 'social-help-row__body',
            children: [
              el('b', { text: `${member?.name || '؟'} · ${def?.name || ''}` }),
              el('small', { text: `−${faDigits(helpSeconds)} ${this.t('seconds', 'ثانیه')} · ${this.t('helpsReceived', 'کمک دریافتی')} ${formatFa(request.helps || 0)}${alreadyHelped ? ` · ${this.t('helpedAlready', 'کمک کردی ✓')}` : ''}` }),
            ],
          }),
          giveButton,
        ],
      }));
    }
    pane.append(others);
  }

  renderEvent() {
    const pane = clear(this.eventTab);
    const online = this.social.isOnline();
    const event = this.social.event;
    if (!online || !event) {
      pane.append(el('p', { className: 'social-empty', text: this.t('eventOffline', 'برای رویداد هفتگی جماعت، نخست وصل شو.') }));
      return;
    }
    const pct = event.goal > 0 ? Math.min(100, Math.round((event.points / event.goal) * 100)) : 0;
    const bar = el('div', { className: 'social-event-bar' });
    bar.style.setProperty('--progress', `${pct}%`);
    const myPoints = this.social.leaderboard.find((entry) => entry.playerId === this.social.playerId)?.points || 0;
    pane.append(
      el('h3', { className: 'social-sub', text: `🎯 ${event.title || ''}` }),
      el('p', { className: 'social-event-desc', text: this.social.serverConfig?.event?.description || '' }),
      el('div', {
        className: 'social-event-progress',
        children: [
          bar,
          el('small', { text: `${formatFa(event.points)} / ${formatFa(event.goal)} · ${faDigits(pct)}٪ · ${this.t('myShare', 'سهم من')} ${formatFa(myPoints)}` }),
        ],
      }),
    );
    if (event.completed) {
      pane.append(el('p', { className: 'social-event-done', text: this.t('eventDone', '🎉 هدف هفتگی کامل شد! پاداش به هم‌سهم‌ها رسید.') }));
    } else {
      pane.append(el('h3', { className: 'social-sub', text: this.t('donateTitle', 'اهدا به کاروان') }));
      const weights = this.social.serverConfig?.event?.weights || {};
      for (const resource of ['rizq', 'nur', 'hekmat']) {
        const meta = this.game.economy?.data?.resources?.[resource] || { icon: '◆', name: resource };
        const balance = Math.floor(this.game.state.resources[resource] || 0);
        const select = el('select', {
          className: 'settings-select social-donate-select',
          attrs: { 'aria-label': `${this.t('donateAmount', 'مقدار اهدا')} ${meta.name}` },
          children: DONATE_AMOUNTS.map((amount) => el('option', { text: formatFa(amount), attrs: { value: String(amount) } })),
        });
        pane.append(el('div', {
          className: 'social-donate-row',
          children: [
            el('span', { className: 'queue-icon', text: meta.icon }),
            el('div', {
              className: 'social-help-row__body',
              children: [
                el('b', { text: `${meta.name} (${formatFa(balance)})` }),
                el('small', { text: `${this.t('weight', 'هر واحد')} = ${formatFa(weights[resource] || 1)} ${this.t('points', 'امتیاز')}` }),
              ],
            }),
            select,
            button(this.t('donate', 'اهدا'), {
              className: 'ui-btn ui-btn--primary',
              onClick: () => this.social.donate(resource, Number(select.value)),
            }),
          ],
        }));
      }
    }
    pane.append(el('h3', { className: 'social-sub', text: this.t('leaderboard', 'هم‌سهم‌های برتر (دوستانه)') }));
    const board = el('div', { className: 'social-board' });
    if (this.social.leaderboard.length === 0) {
      board.append(el('p', { className: 'social-empty', text: this.t('boardEmpty', 'هنوز کسی اهدا نکرده است.') }));
    }
    this.social.leaderboard.slice(0, 10).forEach((entry, index) => {
      const mine = entry.playerId === this.social.playerId;
      board.append(el('div', {
        className: `social-board-row${mine ? ' social-board-row--mine' : ''}`,
        children: [
          el('b', { text: `${faDigits(index + 1)}.` }),
          el('span', { text: `${entry.name}${mine ? ` (${this.t('you', 'شما')})` : ''}` }),
          el('b', { text: formatFa(entry.points) }),
        ],
      }));
    });
    pane.append(board);
    pane.append(el('small', { className: 'social-dim', text: this.t('friendlyNote', 'بدون غارت، بدون حمله، بدون از دست دادن منابع — فقط همکاری 🤝') }));
  }

  dispose() {
    this.close();
    for (const fn of this._unsubscribers) fn();
    this.root.remove();
  }
}
