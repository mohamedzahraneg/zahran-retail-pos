/**
 * Converts a numeric amount to Arabic words (e.g. "500.50" →
 * "خمسمائة جنيه وخمسون قرشاً فقط لا غير"). Handles numbers up to
 * billions — more than enough for any voucher.
 *
 * Grammar compromises for simplicity:
 *   - Masculine form throughout.
 *   - Dual form is approximated with "ان".
 *   - Tens/units ordering follows conventional Arabic accounting style.
 */

const ones: Record<number, string> = {
  0: '',
  1: 'واحد',
  2: 'اثنان',
  3: 'ثلاثة',
  4: 'أربعة',
  5: 'خمسة',
  6: 'ستة',
  7: 'سبعة',
  8: 'ثمانية',
  9: 'تسعة',
  10: 'عشرة',
  11: 'أحد عشر',
  12: 'اثنا عشر',
  13: 'ثلاثة عشر',
  14: 'أربعة عشر',
  15: 'خمسة عشر',
  16: 'ستة عشر',
  17: 'سبعة عشر',
  18: 'ثمانية عشر',
  19: 'تسعة عشر',
};

const tens: Record<number, string> = {
  20: 'عشرون',
  30: 'ثلاثون',
  40: 'أربعون',
  50: 'خمسون',
  60: 'ستون',
  70: 'سبعون',
  80: 'ثمانون',
  90: 'تسعون',
};

const hundreds: Record<number, string> = {
  100: 'مائة',
  200: 'مائتان',
  300: 'ثلاثمائة',
  400: 'أربعمائة',
  500: 'خمسمائة',
  600: 'ستمائة',
  700: 'سبعمائة',
  800: 'ثمانمائة',
  900: 'تسعمائة',
};

function below1000(n: number): string {
  if (n === 0) return '';
  if (n < 20) return ones[n];
  if (n < 100) {
    const t = Math.floor(n / 10) * 10;
    const u = n % 10;
    if (u === 0) return tens[t];
    return `${ones[u]} و${tens[t]}`;
  }
  const h = Math.floor(n / 100) * 100;
  const rest = n % 100;
  if (rest === 0) return hundreds[h];
  return `${hundreds[h]} و${below1000(rest)}`;
}

function scaled(n: number, singular: string, dual: string, plural: string) {
  if (n === 0) return '';
  if (n === 1) return singular;
  if (n === 2) return dual;
  if (n >= 3 && n <= 10) return `${below1000(n)} ${plural}`;
  return `${below1000(n)} ${singular}`;
}

function wholeToArabic(n: number): string {
  if (n === 0) return 'صفر';
  const parts: string[] = [];
  const billions = Math.floor(n / 1_000_000_000);
  n %= 1_000_000_000;
  const millions = Math.floor(n / 1_000_000);
  n %= 1_000_000;
  const thousands = Math.floor(n / 1_000);
  const rest = n % 1_000;

  if (billions)
    parts.push(scaled(billions, 'مليار', 'ملياران', 'مليارات'));
  if (millions)
    parts.push(scaled(millions, 'مليون', 'مليونان', 'ملايين'));
  if (thousands)
    parts.push(scaled(thousands, 'ألف', 'ألفان', 'آلاف'));
  if (rest) parts.push(below1000(rest));

  return parts.join(' و');
}

/**
 * Returns "… جنيه و… قرشاً فقط لا غير" for the given amount.
 */
export function numberToArabicWords(
  amount: number,
  opts: {
    currency?: string; // جنيه by default
    subCurrency?: string; // قرش
  } = {},
): string {
  const currency = opts.currency ?? 'جنيه';
  const subCurrency = opts.subCurrency ?? 'قرش';
  const sign = amount < 0 ? 'ناقص ' : '';
  const abs = Math.abs(amount);
  const whole = Math.floor(abs);
  const cents = Math.round((abs - whole) * 100);
  const wholeText = wholeToArabic(whole);
  let text = `${sign}${wholeText} ${currency}`;
  if (cents > 0) {
    const centsText = wholeToArabic(cents);
    text += ` و${centsText} ${subCurrency}`;
  }
  text += ' فقط لا غير.';
  return text;
}
