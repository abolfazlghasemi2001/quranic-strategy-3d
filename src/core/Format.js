const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

/** Latin digits -> Persian digits for concise, player-facing numeric labels. */
export function faDigits(value) {
  return String(value).replace(/[0-9]/g, (digit) => PERSIAN_DIGITS[Number(digit)]);
}

export function formatFa(value, digits = 0) {
  const fixed = Number(value).toFixed(digits);
  const [intPart, decPart] = fixed.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '٬');
  return faDigits(decPart ? `${grouped}٫${decPart}` : grouped);
}
