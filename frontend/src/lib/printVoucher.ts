/**
 * Print a cash voucher (سند قبض / سند صرف) to an iframe so it doesn't
 * repaint the whole page. 80mm thermal-friendly layout. Works for both
 * customer payments (قبض) and supplier payments (صرف).
 */

export interface VoucherPayload {
  kind: 'receipt' | 'payment'; // قبض | صرف
  doc_no: string;
  date: string;
  party_name: string;
  amount: number;
  in_words?: string;
  method: string;
  cashbox_name?: string;
  reference?: string;
  notes?: string;
  shop_name?: string;
  shop_phone?: string;
  user_name?: string;
}

import { numberToArabicWords } from './numberToArabic';

const egp = (n: number) =>
  `${Number(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

export function printVoucher(v: VoucherPayload) {
  // Auto-fill in_words if the caller didn't provide one.
  if (!v.in_words) {
    v.in_words = numberToArabicWords(v.amount);
  }
  const title =
    v.kind === 'receipt' ? 'سند قبض' : 'سند صرف';
  const partyLabel = v.kind === 'receipt' ? 'استلمنا من' : 'دفعنا إلى';
  const methodLabels: Record<string, string> = {
    cash: 'نقدي',
    card: 'بطاقة',
    instapay: 'إنستاباي',
    bank_transfer: 'تحويل بنكي',
  };

  const html = `<!doctype html>
<html dir="rtl" lang="ar">
<head>
<meta charset="utf-8" />
<title>${title} ${v.doc_no}</title>
<style>
  * { box-sizing: border-box; }
  @page { size: 80mm auto; margin: 3mm; }
  body {
    font-family: 'Tajawal', 'Cairo', Tahoma, sans-serif;
    font-size: 11pt;
    margin: 0;
    padding: 6px;
    color: #111;
    direction: rtl;
  }
  .center { text-align: center; }
  .between { display: flex; justify-content: space-between; gap: 6px; }
  .bold { font-weight: 700; }
  .big { font-size: 14pt; }
  .xl { font-size: 18pt; font-weight: 900; }
  .muted { color: #666; font-size: 9pt; }
  .box {
    border: 1px dashed #222;
    padding: 6px;
    border-radius: 4px;
    margin: 8px 0;
  }
  hr { border: none; border-top: 1px dashed #444; margin: 6px 0; }
  .row { display: flex; justify-content: space-between; padding: 2px 0; }
  .row b { max-width: 60%; text-align: left; }
  .footer { text-align: center; margin-top: 10px; font-size: 9pt; }
  .stamp {
    margin-top: 16px;
    display: flex;
    justify-content: space-between;
    gap: 10px;
    font-size: 9pt;
  }
  .stamp > div {
    flex: 1;
    text-align: center;
    border-top: 1px solid #000;
    padding-top: 4px;
  }
</style>
</head>
<body>
  ${v.shop_name ? `<div class="center bold big">${escape(v.shop_name)}</div>` : ''}
  ${v.shop_phone ? `<div class="center muted">${escape(v.shop_phone)}</div>` : ''}
  <hr />
  <div class="center xl">${title}</div>
  <div class="between muted">
    <span>رقم السند: <b>${escape(v.doc_no)}</b></span>
    <span>${escape(v.date)}</span>
  </div>

  <div class="box">
    <div class="row"><span>${partyLabel}</span><b>${escape(v.party_name)}</b></div>
    <div class="row"><span>طريقة الدفع</span><b>${escape(methodLabels[v.method] || v.method)}</b></div>
    ${v.cashbox_name ? `<div class="row"><span>الخزنة</span><b>${escape(v.cashbox_name)}</b></div>` : ''}
    ${v.reference ? `<div class="row"><span>المرجع</span><b>${escape(v.reference)}</b></div>` : ''}
  </div>

  <div class="box center">
    <div class="muted">مبلغ وقدره</div>
    <div class="xl">${egp(v.amount)}</div>
    ${v.in_words ? `<div class="muted">${escape(v.in_words)}</div>` : ''}
  </div>

  ${v.notes ? `<div class="box"><b>ملاحظات:</b> ${escape(v.notes)}</div>` : ''}

  <div class="stamp">
    <div>${v.kind === 'receipt' ? 'توقيع العميل' : 'توقيع المورد'}</div>
    <div>${v.user_name ? escape(v.user_name) : 'الموظف'}</div>
  </div>

  <div class="footer muted">
    طُبع في ${new Date().toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' })}
  </div>
</body>
</html>`;

  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument!;
  doc.open();
  doc.write(html);
  doc.close();
  setTimeout(() => {
    iframe.contentWindow?.focus();
    iframe.contentWindow?.print();
    setTimeout(() => document.body.removeChild(iframe), 500);
  }, 150);
}

function escape(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
