import { el, button, formatFa } from './dom.js';
import { EVENTS } from '../core/EventBus.js';

const QUALITY_OPTIONS = [
  ['low', 'پایین'],
  ['medium', 'متوسط'],
  ['high', 'بالا'],
];
const FONT_OPTIONS = [
  ['normal', 'معمولی'],
  ['large', 'درشت'],
  ['larger', 'درشت‌تر'],
];

function option(value, label) {
  return el('option', { text: label, attrs: { value } });
}

function settingRow(title, description, control) {
  return el('section', {
    className: 'settings-row',
    children: [
      el('div', { className: 'settings-row__copy', children: [el('b', { text: title }), el('small', { text: description })] }),
      control,
    ],
  });
}

/** Preferences panel. Values save immediately to GameState.meta.settings. */
export class SettingsPanel {
  constructor({ config, bus, metaSystem, parent = document.body, onReplay = null, onPause = null, onResume = null }) {
    this.config = config;
    this.bus = bus;
    this.metaSystem = metaSystem;
    this.onReplay = onReplay;
    this.onPause = onPause;
    this.onResume = onResume;
    this.open = false;

    this.card = el('div', { className: 'ui-modal__card settings-card' });
    this.root = el('div', {
      className: 'ui-modal settings-ui is-hidden',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'تنظیمات بازی', dir: 'rtl', lang: 'fa' },
      children: [el('div', { className: 'ui-modal__backdrop' }), this.card],
    });
    this.root.querySelector('.ui-modal__backdrop').addEventListener('click', () => this.close());

    this.languageSelect = el('select', {
      className: 'settings-select',
      attrs: { 'aria-label': 'زبان و منطقه' },
      children: [
        option('fa-IR', 'فارسی — ایران'),
        option('fa-AF', 'فارسی دری — افغانستان'),
      ],
    });
    this.languageSelect.addEventListener('change', () => this.metaSystem.setSetting('language', this.languageSelect.value));

    this.qualitySelect = el('select', {
      className: 'settings-select',
      attrs: { 'aria-label': 'کیفیت گرافیک' },
      children: QUALITY_OPTIONS.map(([value, label]) => option(value, label)),
    });
    this.qualitySelect.addEventListener('change', () => this.metaSystem.setSetting('qualityTier', this.qualitySelect.value));

    this.soundToggle = el('input', { className: 'settings-toggle', attrs: { type: 'checkbox', 'aria-label': 'صدای رابط و محیط' } });
    this.soundToggle.addEventListener('change', () => this.metaSystem.setSetting('soundEnabled', this.soundToggle.checked));

    this.recitationToggle = el('input', { className: 'settings-toggle', attrs: { type: 'checkbox', 'aria-label': 'پخش تلاوت قرآن' } });
    this.recitationToggle.addEventListener('change', () => this.metaSystem.setSetting('recitationEnabled', this.recitationToggle.checked));

    this.fontSelect = el('select', {
      className: 'settings-select',
      attrs: { 'aria-label': 'اندازهٔ نوشته‌ها' },
      children: FONT_OPTIONS.map(([value, label]) => option(value, label)),
    });
    this.fontSelect.addEventListener('change', () => this.metaSystem.setSetting('fontScale', this.fontSelect.value));

    this.contrastToggle = el('input', { className: 'settings-toggle', attrs: { type: 'checkbox', 'aria-label': 'کنتراست بالا' } });
    this.contrastToggle.addEventListener('change', () => this.metaSystem.setSetting('highContrast', this.contrastToggle.checked));

    this.motionToggle = el('input', { className: 'settings-toggle', attrs: { type: 'checkbox', 'aria-label': 'کاهش حرکت' } });
    this.motionToggle.addEventListener('change', () => this.metaSystem.setSetting('reduceMotion', this.motionToggle.checked));

    this.batteryToggle = el('input', { className: 'settings-toggle', attrs: { type: 'checkbox', 'aria-label': 'صرفه‌جویی باتری' } });
    this.batteryToggle.addEventListener('change', () => this.metaSystem.setSetting('batterySaver', this.batteryToggle.checked));

    this.performanceHint = el('p', { className: 'settings-performance', text: '' });
    const replayButton = button('نمایش دوبارهٔ راهنمای شروع', {
      className: 'ui-btn ui-btn--primary settings-replay',
      onClick: () => {
        this.close();
        this.onReplay?.();
      },
    });

    this.card.replaceChildren(
      el('header', {
        className: 'ui-modal__header',
        children: [el('h2', { className: 'ui-modal__title', text: 'تنظیمات' }), button('×', { className: 'ui-icon-btn', title: 'بستن', onClick: () => this.close() })],
      }),
      settingRow('زبان و منطقه', 'رابط در همهٔ حالت‌ها فارسی و راست‌چین می‌ماند.', this.languageSelect),
      settingRow('صدا و محیط', 'باد، آب، آواز کوتاه پرندگان و بازخوردهای ساخته‌شده با Web Audio؛ بدون موسیقی و فایل صوتی بیرونی.', this.soundToggle),
      settingRow('تلاوت قرآن', 'اختیاری و خاموش پیش‌فرض؛ فقط صوتی که در داده‌ها صریحاً مجوز و منبع دارد پخش می‌شود.', this.recitationToggle),
      settingRow('اندازهٔ نوشته‌ها', 'سه اندازه برای خوانایی بهتر در پنل‌ها و رابط.', this.fontSelect),
      settingRow('کنتراست بالا', 'مرزها، نوشته‌ها و کنترل‌ها با کنتراست تقویت‌شده نمایش داده می‌شوند.', this.contrastToggle),
      settingRow('کاهش حرکت', 'حرکت پس‌زمینه و جابه‌جایی‌های تزئینی کم می‌شود.', this.motionToggle),
      settingRow('کیفیت گرافیک', 'تغییر فوری وضوح، سایه و مه؛ کیفیت اولیهٔ ضد‌دندانه‌سازی پس از بارگذاری ثابت می‌ماند.', this.qualitySelect),
      settingRow('صرفه‌جویی باتری', '۳۰ فریم در ثانیه و خاموش‌کردن سایه‌ها؛ هر زمان قابل بازگشت است.', this.batteryToggle),
      this.performanceHint,
      el('p', { className: 'settings-policy', text: 'هیچ تبلیغی، شمارندهٔ بازگشت، زنجیرهٔ ورود یا پاداش روزانهٔ ورود در بازی وجود ندارد.' }),
      replayButton,
    );
    parent.append(this.root);

    this._onKey = (event) => {
      if (event.key === 'Escape') this.close();
    };
    this._unsubscribe = bus.on(EVENTS.SETTINGS_CHANGED, (settings) => this.renderSettings(settings));
    this.renderSettings(metaSystem.settings);
  }

  renderSettings(settings = this.metaSystem.settings) {
    this.languageSelect.value = settings.language || 'fa-IR';
    this.qualitySelect.value = settings.qualityTier || this.config.quality.tier;
    this.soundToggle.checked = Boolean(settings.soundEnabled);
    this.recitationToggle.checked = Boolean(settings.recitationEnabled);
    this.fontSelect.value = settings.fontScale || 'normal';
    this.contrastToggle.checked = Boolean(settings.highContrast);
    this.motionToggle.checked = Boolean(settings.reduceMotion);
    this.batteryToggle.checked = Boolean(settings.batterySaver);
    const tierName = QUALITY_OPTIONS.find(([key]) => key === settings.qualityTier)?.[1] || 'متوسط';
    const frameRate = settings.batterySaver ? 30 : (this.config.targets.fps || 60);
    this.performanceHint.textContent = settings.batterySaver
      ? `وضعیت اکنون: ${tierName} · حداکثر ${formatFa(frameRate)} فریم در ثانیه · سایه خاموش`
      : `وضعیت اکنون: ${tierName} · هدف ${formatFa(frameRate)} فریم در ثانیه · پروفایل گرافیک فعال`;
    document.documentElement.lang = settings.language || 'fa-IR';
    document.documentElement.dir = 'rtl';
  }

  show() {
    if (this.open) return;
    this.open = true;
    this.renderSettings();
    this.root.classList.remove('is-hidden');
    window.addEventListener('keydown', this._onKey);
    this.bus.emit(EVENTS.SETTINGS_OPENED, {});
    this.onPause?.();
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.root.classList.add('is-hidden');
    window.removeEventListener('keydown', this._onKey);
    this.onResume?.();
  }

  dispose() {
    this.close();
    this._unsubscribe?.();
    this.root.remove();
  }
}
