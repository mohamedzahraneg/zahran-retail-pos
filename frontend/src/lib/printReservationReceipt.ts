/**
 * Thermal / A5 print of a reservation receipt ("إيصال حجز").
 * Mirrors the invoice receipt layout — shop header, customer,
 * salesperson + cashier, items table, totals, deposit paid and
 * remaining, plus a standard reservation terms-and-conditions block.
 *
 * Uses an off-screen iframe so the app's own stylesheet doesn't
 * interfere with the thermal page break and the browser's print
 * preview stays clean.
 */

const EGP = (n: number | string) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

function fmtDate(s?: string | null) {
  if (!s) return '';
  return new Date(s).toLocaleString('ar-EG', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

export function printReservationReceipt(res: any) {
  const shopName = 'زهران للأحذية والحقائب';
  const items = res.items || [];
  const deposit = Number(res.paid_amount || 0);
  const total = Number(res.total_amount || 0);
  const remaining = Number(res.remaining_amount || 0);

  const html = `
<!DOCTYPE html>
<html dir="rtl" lang="ar">
  <head>
    <meta charset="utf-8">
    <title>إيصال حجز ${res.reservation_no}</title>
    <style>
      @page { size: 80mm auto; margin: 4mm; }
      * { box-sizing: border-box; }
      body { font-family: 'Cairo', Arial, sans-serif; color: #111; margin: 0; padding: 0; font-size: 12px; }
      .shop { text-align: center; font-weight: 900; font-size: 16px; margin-bottom: 2px; }
      .doc { text-align: center; font-weight: 900; font-size: 14px; background: #000; color: #fff; padding: 3px 0; margin: 4px 0 6px; border-radius: 2px; }
      .meta { display: flex; justify-content: space-between; font-size: 11px; margin: 2px 0; }
      .row { display: flex; justify-content: space-between; margin: 2px 0; font-size: 11px; }
      table { width: 100%; border-collapse: collapse; margin-top: 6px; }
      th, td { padding: 3px 2px; font-size: 11px; text-align: right; }
      thead { border-top: 1px dashed #333; border-bottom: 1px dashed #333; }
      tbody tr { border-bottom: 1px dotted #ccc; }
      .total { border-top: 1px solid #000; margin-top: 4px; padding-top: 4px; }
      .grand { font-size: 14px; font-weight: 900; }
      .deposit { color: #065f46; font-weight: 700; }
      .remain { color: #b45309; font-weight: 700; }
      .terms { border-top: 1px dashed #333; padding-top: 6px; margin-top: 8px; font-size: 10px; line-height: 1.5; }
      .terms h4 { margin: 0 0 4px; font-size: 11px; }
      .terms ol { padding-right: 16px; margin: 0; }
      .foot { text-align: center; margin-top: 6px; font-size: 10px; color: #555; }
    </style>
  </head>
  <body>
    <div class="shop">${shopName}</div>
    <div class="doc">📌 إيصال حجز</div>

    <div class="row"><span>رقم الحجز</span><span style="font-family: monospace; font-weight: 700">${res.reservation_no || ''}</span></div>
    <div class="row"><span>تاريخ الحجز</span><span>${fmtDate(res.reserved_at)}</span></div>
    ${res.expires_at ? `<div class="row"><span>ينتهي في</span><span>${fmtDate(res.expires_at)}</span></div>` : ''}

    <div class="row"><span>العميل</span><span>${res.customer_name || 'عميل عابر'}</span></div>
    ${res.customer_phone ? `<div class="row"><span>هاتف</span><span dir="ltr" style="font-family: monospace">${res.customer_phone}</span></div>` : ''}
    ${res.salesperson_name ? `<div class="row"><span>البائع</span><span>${res.salesperson_name}</span></div>` : ''}
    ${res.cashier_name ? `<div class="row"><span>الكاشير</span><span>${res.cashier_name}</span></div>` : ''}

    <table>
      <thead>
        <tr>
          <th>الصنف</th>
          <th style="text-align:center">كمية</th>
          <th style="text-align:left">الإجمالي</th>
        </tr>
      </thead>
      <tbody>
        ${items
          .map((it: any) => {
            const subtitle = [it.color, it.size].filter(Boolean).join(' · ');
            return `<tr>
              <td>
                <div style="font-weight: 700">${it.product_name || ''}</div>
                ${subtitle ? `<div style="font-size: 10px; color: #555">${subtitle}</div>` : ''}
                <div style="font-size: 10px; color: #777; font-family: monospace">${it.sku || ''}</div>
              </td>
              <td style="text-align:center; font-family: monospace">${Number(it.quantity || 0)}</td>
              <td style="text-align:left; font-family: monospace">${EGP(it.line_total)}</td>
            </tr>`;
          })
          .join('')}
      </tbody>
    </table>

    <div class="total">
      <div class="row grand"><span>الإجمالي</span><span style="font-family: monospace">${EGP(total)}</span></div>
      <div class="row deposit"><span>العربون المدفوع</span><span style="font-family: monospace">${EGP(deposit)}</span></div>
      <div class="row remain"><span>المتبقي عند الاستلام</span><span style="font-family: monospace">${EGP(remaining)}</span></div>
      ${res.deposit_required_pct != null ? `<div class="row" style="font-size: 10px; color: #555"><span>نسبة العربون المطلوبة</span><span>${Number(res.deposit_required_pct).toFixed(0)}%</span></div>` : ''}
    </div>

    <div class="terms">
      <h4>شروط وأحكام الحجز</h4>
      <ol>
        <li>يُحتفظ بالأصناف المحجوزة حتى تاريخ انتهاء الحجز المذكور أعلاه.</li>
        <li>بعد انقضاء تاريخ الانتهاء دون استلام، يحق للمحل إلغاء الحجز وإعادة طرح الأصناف للبيع.</li>
        <li>العربون المدفوع غير قابل للاسترداد في حال إلغاء الحجز من قِبَل العميل.</li>
        <li>يجب إحضار هذا الإيصال عند الاستلام لاحتساب العربون من قيمة الفاتورة.</li>
        <li>في حالة استبدال المقاس أو اللون، يخضع الطلب لتوفّر الصنف وقت الاستلام.</li>
        <li>لا يُستكمل الاستلام إلا بعد تسوية قيمة "المتبقي عند الاستلام" بالكامل.</li>
      </ol>
    </div>

    <div class="foot">
      شكرًا لتعاملكم مع ${shopName}<br/>
      — طُبع في ${fmtDate(new Date().toISOString())} —
    </div>

    <script>
      window.addEventListener('load', function () {
        setTimeout(function () {
          window.focus();
          window.print();
        }, 150);
      });
    </script>
  </body>
</html>`;

  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = 'none';
  iframe.style.visibility = 'hidden';
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument || iframe.contentWindow?.document;
  if (doc) {
    doc.open();
    doc.write(html);
    doc.close();
  }
  // Remove after print dialog closes.
  setTimeout(() => {
    try {
      document.body.removeChild(iframe);
    } catch {
      /* ignore */
    }
  }, 60_000);
}
