import { useEffect, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Barcode } from './Barcode';

export interface ReceiptData {
  invoice: {
    id: string;
    /** Canonical column from the DB (preferred) */
    invoice_no?: string;
    /** Legacy alias kept for backward compatibility */
    doc_no?: string;
    subtotal: number;
    invoice_discount?: number;
    /** If invoice_discount was applied as a percentage, its raw % value. */
    invoice_discount_type?: 'fixed' | 'percentage' | null;
    invoice_discount_value?: number;
    items_discount_total?: number;
    /** Legacy alias */
    discount_total?: number;
    /** Coupon applied on the invoice (EGP off) */
    coupon_discount?: number;
    coupon_code?: string | null;
    grand_total: number;
    cogs_total?: number;
    gross_profit?: number;
    paid_amount?: number;
    paid_total?: number;
    change_amount?: number;
    change_given?: number;
    tax_amount?: number;
    notes?: string;
    created_at: string;
    completed_at?: string;
    customer_name?: string | null;
    customer_phone?: string | null;
    customer_loyalty_points?: number | null;
    cashier_name?: string | null;
    cashier_username?: string | null;
    salesperson_name?: string | null;
    warehouse_name?: string | null;
    status?: string;
  };
  lines: Array<{
    id?: string;
    /** Canonical fields from invoice_items */
    product_name_snapshot?: string;
    sku_snapshot?: string;
    color_name_snapshot?: string | null;
    size_label_snapshot?: string | null;
    quantity?: number;
    discount_amount?: number;
    /** Legacy aliases */
    sku?: string;
    product_name_ar?: string;
    product_name_en?: string;
    qty?: number;
    discount?: number;
    unit_price: number;
    line_total: number;
    salesperson_name?: string | null;
  }>;
  payments: Array<{
    payment_method: 'cash' | 'card' | 'instapay' | 'bank_transfer';
    amount: number;
    reference?: string | null;
    reference_number?: string | null;
  }>;
  shop: {
    name?: string;
    address?: string;
    phone?: string;
    tax_id?: string;
    vat_number?: string;
    logo_url?: string;
    footer_note?: string;
    /** Text printed above the items — e.g. branch motto or offer banner */
    header_note?: string;
    /** Content encoded into the QR code at the bottom of the receipt.
     *  Use a short URL (website, Google review, Instagram, etc.). */
    qr_url?: string;
    /** Caption below the QR, e.g. "تابعنا على إنستجرام" */
    qr_caption?: string;
    /** Multi-line terms & conditions (admin-editable) */
    terms?: string;
    /** Website / social handle shown in the footer block */
    website?: string;
  };
  loyalty?: Array<{
    direction: 'in' | 'out';
    points: number;
    reason: string;
  }>;
}

const METHOD_LABELS: Record<string, string> = {
  cash: 'كاش',
  card: 'كارت',
  instapay: 'إنستاباي',
  bank_transfer: 'تحويل بنكي',
};

const EGP = (n: number) => `${Number(n).toFixed(2)}`;

const WEEKDAYS_AR = [
  'الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء',
  'الخميس', 'الجمعة', 'السبت',
];

function fmtDateTime(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = WEEKDAYS_AR[d.getDay()];
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return { day, date, time };
}

interface Props {
  data: ReceiptData;
  autoPrint?: boolean;
  onAfterPrint?: () => void;
}

/**
 * Receipt — renders an 80mm thermal-style receipt.
 * On mount, if autoPrint is true, it triggers window.print().
 */
export function Receipt({ data, autoPrint = false, onAfterPrint }: Props) {
  const printedRef = useRef(false);

  useEffect(() => {
    if (!autoPrint || printedRef.current) return;
    printedRef.current = true;
    const t = setTimeout(() => {
      window.print();
      onAfterPrint?.();
    }, 250);
    return () => clearTimeout(t);
  }, [autoPrint, onAfterPrint]);

  const { invoice: inv, lines, payments, shop, loyalty = [] } = data;

  const invoiceNo = inv.invoice_no || inv.doc_no || '';
  const invoiceDiscount = Number(inv.invoice_discount ?? inv.discount_total ?? 0);
  const itemsDiscount = Number(inv.items_discount_total ?? 0);
  const couponDiscount = Number(inv.coupon_discount ?? 0);
  const paidTotal = Number(inv.paid_amount ?? inv.paid_total ?? 0);
  const changeAmount = Number(inv.change_amount ?? inv.change_given ?? 0);
  const { day, date, time } = fmtDateTime(inv.completed_at || inv.created_at);

  const earnedPoints = loyalty
    .filter((t) => t.direction === 'in')
    .reduce((s, t) => s + Number(t.points), 0);
  const redeemedPoints = loyalty
    .filter((t) => t.direction === 'out')
    .reduce((s, t) => s + Number(t.points), 0);

  return (
    <div className="receipt-print-root">
      <div className="receipt-80mm">
        {/* Header */}
        <div className="receipt-header">
          {shop.logo_url && (
            <img
              src={shop.logo_url}
              alt="logo"
              className="receipt-logo"
            />
          )}
          <div className="receipt-shop-name">
            {shop.name || 'زهران — متجر الأحذية والحقائب'}
          </div>
          {shop.address && (
            <div className="receipt-line">{shop.address}</div>
          )}
          {shop.phone && (
            <div className="receipt-line">تليفون: {shop.phone}</div>
          )}
          {(shop.vat_number || shop.tax_id) && (
            <div className="receipt-line">
              الرقم الضريبي: {shop.vat_number || shop.tax_id}
            </div>
          )}
        </div>

        {shop.header_note && (
          <div className="receipt-header-note">{shop.header_note}</div>
        )}

        <div className="receipt-divider">════════════════════════════════</div>

        {/* Meta */}
        <div className="receipt-meta">
          <div className="receipt-row">
            <span>فاتورة:</span>
            <strong>{invoiceNo}</strong>
          </div>
          <div className="receipt-row">
            <span>اليوم:</span>
            <span>{day}</span>
          </div>
          <div className="receipt-row">
            <span>التاريخ:</span>
            <span>{date}</span>
          </div>
          <div className="receipt-row">
            <span>الوقت:</span>
            <span>{time}</span>
          </div>
          {inv.cashier_name && (
            <div className="receipt-row">
              <span>الكاشير:</span>
              <span>{inv.cashier_name}</span>
            </div>
          )}
          {inv.salesperson_name && (
            <div className="receipt-row">
              <span>البائع:</span>
              <span>{inv.salesperson_name}</span>
            </div>
          )}
          {inv.warehouse_name && (
            <div className="receipt-row">
              <span>الفرع:</span>
              <span>{inv.warehouse_name}</span>
            </div>
          )}
          {inv.customer_name && (
            <div className="receipt-row">
              <span>العميل:</span>
              <span>
                {inv.customer_name}
                {inv.customer_phone ? ` · ${inv.customer_phone}` : ''}
              </span>
            </div>
          )}
        </div>

        <div className="receipt-divider">--------------------------------</div>

        {/* Items */}
        <table className="receipt-items">
          <thead>
            <tr>
              <th className="receipt-col-name">الصنف</th>
              <th className="receipt-col-qty">كمية</th>
              <th className="receipt-col-price">سعر</th>
              <th className="receipt-col-total">إجمالي</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const name =
                l.product_name_snapshot ||
                l.product_name_ar ||
                l.sku_snapshot ||
                l.sku ||
                '—';
              const sku = l.sku_snapshot || l.sku;
              const qty = Number(l.quantity ?? l.qty ?? 0);
              const disc = Number(l.discount_amount ?? l.discount ?? 0);
              const variantMeta = [l.color_name_snapshot, l.size_label_snapshot]
                .filter(Boolean)
                .join(' · ');
              return (
                <tr key={l.id || i}>
                  <td className="receipt-col-name">
                    <div className="receipt-item-name">{name}</div>
                    {sku && <div className="receipt-item-sku">{sku}</div>}
                    {variantMeta && (
                      <div className="receipt-item-sku">{variantMeta}</div>
                    )}
                    {disc > 0 && (
                      <div className="receipt-item-disc">
                        خصم: {EGP(disc)}
                      </div>
                    )}
                    {l.salesperson_name && (
                      <div className="receipt-item-sku">
                        بائع: {l.salesperson_name}
                      </div>
                    )}
                  </td>
                  <td className="receipt-col-qty">{qty}</td>
                  <td className="receipt-col-price">
                    {EGP(Number(l.unit_price))}
                  </td>
                  <td className="receipt-col-total">
                    {EGP(Number(l.line_total))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="receipt-divider">--------------------------------</div>

        {/* Totals */}
        <div className="receipt-totals">
          <div className="receipt-row">
            <span>المجموع:</span>
            <span>{EGP(Number(inv.subtotal))} ج.م</span>
          </div>
          {itemsDiscount > 0 && (
            <div className="receipt-row">
              <span>خصم الأصناف:</span>
              <span>- {EGP(itemsDiscount)} ج.م</span>
            </div>
          )}
          {invoiceDiscount > 0 && (
            <div className="receipt-row">
              <span>
                خصم الفاتورة
                {inv.invoice_discount_type === 'percentage' &&
                  inv.invoice_discount_value != null && (
                    <> ({Number(inv.invoice_discount_value)}%)</>
                  )}
                :
              </span>
              <span>- {EGP(invoiceDiscount)} ج.م</span>
            </div>
          )}
          {couponDiscount > 0 && (
            <div className="receipt-row">
              <span>
                كوبون{inv.coupon_code ? ` (${inv.coupon_code})` : ''}:
              </span>
              <span>- {EGP(couponDiscount)} ج.م</span>
            </div>
          )}
          {Number(inv.tax_amount) > 0 && (
            <div className="receipt-row">
              <span>الضريبة:</span>
              <span>+ {EGP(Number(inv.tax_amount))} ج.م</span>
            </div>
          )}
          <div className="receipt-row receipt-grand">
            <span>الإجمالي:</span>
            <strong>{EGP(Number(inv.grand_total))} ج.م</strong>
          </div>
          {Number(inv.gross_profit) > 0 && (
            <div className="receipt-row receipt-profit">
              <span>ربح الفاتورة:</span>
              <strong>{EGP(Number(inv.gross_profit))} ج.م</strong>
            </div>
          )}
        </div>

        <div className="receipt-divider">--------------------------------</div>

        {/* Payments */}
        <div className="receipt-payments">
          {payments.map((p, i) => (
            <div key={i} className="receipt-row">
              <span>{METHOD_LABELS[p.payment_method] || p.payment_method}:</span>
              <span>{EGP(Number(p.amount))} ج.م</span>
            </div>
          ))}
          {paidTotal > 0 && (
            <div className="receipt-row">
              <span>إجمالي المدفوع:</span>
              <span>{EGP(paidTotal)} ج.م</span>
            </div>
          )}
          {changeAmount > 0 && (
            <div className="receipt-row">
              <span>الباقي:</span>
              <strong>{EGP(changeAmount)} ج.م</strong>
            </div>
          )}
        </div>

        {/* Loyalty */}
        {(earnedPoints > 0 ||
          redeemedPoints > 0 ||
          inv.customer_loyalty_points != null) && (
          <>
            <div className="receipt-divider">
              --------------------------------
            </div>
            <div className="receipt-loyalty">
              <div className="receipt-loyalty-title">★ نقاط الولاء ★</div>
              {redeemedPoints > 0 && (
                <div className="receipt-row">
                  <span>نقاط مُستبدلة:</span>
                  <span>{redeemedPoints}</span>
                </div>
              )}
              {earnedPoints > 0 && (
                <div className="receipt-row">
                  <span>نقاط مُكتسبة:</span>
                  <span>+ {earnedPoints}</span>
                </div>
              )}
              {inv.customer_loyalty_points != null && (
                <div className="receipt-row">
                  <span>رصيدك الحالي:</span>
                  <strong>{inv.customer_loyalty_points}</strong>
                </div>
              )}
            </div>
          </>
        )}

        {inv.notes && (
          <>
            <div className="receipt-divider">
              --------------------------------
            </div>
            <div className="receipt-notes">
              <div className="receipt-notes-title">ملاحظات:</div>
              <div>{inv.notes}</div>
            </div>
          </>
        )}

        {shop.terms && (
          <>
            <div className="receipt-divider">--------------------------------</div>
            <div className="receipt-terms">
              <div className="receipt-terms-title">الشروط والأحكام</div>
              <div className="receipt-terms-body">{shop.terms}</div>
            </div>
          </>
        )}

        <div className="receipt-divider">════════════════════════════════</div>

        {/* Barcode of invoice_no for easy return lookup */}
        {invoiceNo && (
          <div className="receipt-barcode">
            <Barcode
              value={invoiceNo}
              width={1.6}
              height={40}
              fontSize={12}
              margin={2}
            />
          </div>
        )}

        {shop.qr_url && (
          <div className="receipt-qr">
            <QRCodeSVG
              value={shop.qr_url}
              size={96}
              level="M"
              includeMargin={false}
            />
            {shop.qr_caption && (
              <div className="receipt-qr-caption">{shop.qr_caption}</div>
            )}
          </div>
        )}

        <div className="receipt-footer">
          <div className="receipt-thanks">
            {shop.footer_note || 'شكراً لتعاملكم معنا 💖'}
          </div>
          {shop.website && (
            <div className="receipt-website">{shop.website}</div>
          )}
          <div className="receipt-tiny">
            طُبعت: {new Date().toLocaleString('en-GB')}
          </div>
        </div>
      </div>

      <style>{`
        .receipt-80mm {
          width: 80mm;
          padding: 2mm 3mm;
          font-family: 'Courier New', 'Cairo', monospace;
          font-size: 11px;
          color: #000;
          line-height: 1.35;
          direction: rtl;
          background: #fff;
        }
        .receipt-header {
          text-align: center;
          margin-bottom: 4px;
        }
        .receipt-logo {
          max-width: 60mm;
          max-height: 20mm;
          margin: 0 auto 4px;
          display: block;
          object-fit: contain;
        }
        .receipt-shop-name {
          font-weight: 900;
          font-size: 14px;
          margin-bottom: 2px;
        }
        .receipt-line {
          font-size: 10px;
        }
        .receipt-divider {
          text-align: center;
          font-size: 10px;
          letter-spacing: -1px;
          margin: 3px 0;
        }
        .receipt-row {
          display: flex;
          justify-content: space-between;
          gap: 6px;
        }
        .receipt-items {
          width: 100%;
          border-collapse: collapse;
          font-size: 10.5px;
        }
        .receipt-items th,
        .receipt-items td {
          padding: 2px 1px;
          vertical-align: top;
        }
        .receipt-items th {
          font-weight: 900;
          text-align: center;
          border-bottom: 1px dashed #000;
        }
        .receipt-col-name {
          text-align: right;
          width: 45%;
        }
        .receipt-col-qty,
        .receipt-col-price,
        .receipt-col-total {
          text-align: center;
        }
        .receipt-col-total {
          text-align: left;
          font-weight: bold;
        }
        .receipt-item-name {
          font-weight: bold;
        }
        .receipt-item-sku,
        .receipt-item-disc {
          font-size: 9px;
          color: #444;
        }
        .receipt-totals,
        .receipt-payments,
        .receipt-loyalty,
        .receipt-notes {
          font-size: 11px;
        }
        .receipt-grand {
          font-size: 13px;
          font-weight: 900;
          border-top: 1px dashed #000;
          padding-top: 3px;
          margin-top: 2px;
        }
        .receipt-profit {
          font-size: 10px;
          color: #333;
          font-style: italic;
        }
        .receipt-loyalty-title {
          text-align: center;
          font-weight: bold;
          margin-bottom: 2px;
        }
        .receipt-notes-title {
          font-weight: bold;
        }
        .receipt-header-note {
          text-align: center;
          font-size: 10px;
          font-style: italic;
          color: #333;
          margin: 2px 0;
        }
        .receipt-terms {
          font-size: 9px;
          line-height: 1.3;
          color: #333;
          margin: 2px 0;
        }
        .receipt-terms-title {
          font-weight: bold;
          text-align: center;
          margin-bottom: 2px;
        }
        .receipt-terms-body {
          white-space: pre-line;
        }
        .receipt-barcode {
          text-align: center;
          margin: 6px 0 4px;
        }
        .receipt-barcode svg {
          max-width: 100%;
        }
        .receipt-qr {
          text-align: center;
          margin: 6px 0 2px;
        }
        .receipt-qr-caption {
          font-size: 9px;
          margin-top: 2px;
          color: #333;
        }
        .receipt-footer {
          text-align: center;
          margin-top: 4px;
          font-size: 10px;
        }
        .receipt-thanks {
          font-size: 12px;
          font-weight: bold;
          margin-bottom: 2px;
        }
        .receipt-website {
          font-size: 10px;
          color: #222;
          margin-bottom: 2px;
        }
        .receipt-tiny {
          font-size: 8px;
          margin-top: 2px;
          color: #555;
        }

        @media print {
          @page {
            size: 80mm auto;
            margin: 0;
          }
          body * {
            visibility: hidden !important;
          }
          .receipt-print-root,
          .receipt-print-root * {
            visibility: visible !important;
          }
          .receipt-print-root {
            position: absolute !important;
            top: 0;
            left: 0;
            width: 80mm;
          }
          .receipt-80mm {
            padding: 0 2mm;
          }
        }
      `}</style>
    </div>
  );
}
