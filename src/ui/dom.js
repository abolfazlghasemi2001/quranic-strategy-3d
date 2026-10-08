/** Tiny DOM helpers for the UI layer (no framework, no external dependency). */
import { faDigits, formatFa } from '../core/Format.js';

export { faDigits, formatFa };

export function el(tag, options = {}) {
  const { className, text, html, attrs, children, parent, style } = options;
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  if (html != null) node.innerHTML = html;
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === false || value == null) continue;
      if (key === 'dataset') {
        for (const [dataKey, dataValue] of Object.entries(value)) node.dataset[dataKey] = dataValue;
      } else {
        node.setAttribute(key, value === true ? '' : String(value));
      }
    }
  }
  if (style) for (const [key, value] of Object.entries(style)) node.style.setProperty(key, value);
  if (children) for (const child of children) if (child) node.append(child);
  if (parent) parent.append(node);
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Buttons that behave the same for mouse, touch and keyboard. */
export function button(label, { className = 'ui-btn', onClick, title, dataset, icon } = {}) {
  const node = el('button', {
    className,
    attrs: { type: 'button', title: title || label, 'aria-label': title || label, dataset },
  });
  if (icon) node.append(el('span', { className: 'ui-btn__icon', text: icon }));
  node.append(el('span', { className: 'ui-btn__label', text: label }));
  if (onClick) {
    node.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick(node, event);
    });
  }
  return node;
}
