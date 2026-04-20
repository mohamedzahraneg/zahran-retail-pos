import { useEffect, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Barcode } from './Barcode';
import type { ReceiptTemplate } from '@/types/receipt-template';
import { DEFAULT_TEMPLATES } from '@/types/receipt-template';

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
    /** Content encoded into the QR code when qr_image_url is not set.
     *  Use a short URL (website, Google review, Instagram, etc.). */
    qr_url?: string;
    /** Uploaded QR image (data URL or external URL). If set, it is shown
     *  as-is and qr_url is ignored — useful for payment QRs from banks. */
    qr_image_url?: string;
    /** Caption below the QR, e.g. "تابعنا على إنستجرام" */
    qr_caption?: string;
    /** Multi-line terms & conditions (admin-editable) */
    terms?: string;
    /** Website / social handle shown in the footer block */
    website?: string;
    /** Admin-selected layout template (size/fonts/colors/sections). */
    active_template?: ReceiptTemplate | null;
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
  /** Admin-selected template; falls back to the built-in compact 80mm. */
  template?: ReceiptTemplate;
}

/**
 * Receipt — renders a receipt using an admin-configurable template
 * (paper size, fonts, colors, visible sections, logo position, …).
 * On mount, if autoPrint is true, it triggers window.print().
 */
export function Receipt({ data, autoPrint = false, onAfterPrint, template }: Props) {
  const printedRef = useRef(false);
  const tpl: ReceiptTemplate =
    template || data.shop?.active_template || DEFAULT_TEMPLATES[0];

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

  const totalPieces = lines.reduce(
    (s, l) => s + Number(l.quantity ?? l.qty ?? 0),
    0,
  );

  // CSS variables + inline width/padding let the template drive layout.
  const rootStyle: React.CSSProperties = {
    ['--rc-font' as any]: tpl.font_family,
    ['--rc-fs' as any]: `${tpl.font_size_base}px`,
    ['--rc-fs-title' as any]: `${tpl.font_size_title}px`,
    ['--rc-lh' as any]: String(tpl.line_height),
    ['--rc-text' as any]: tpl.color_text,
    ['--rc-muted' as any]: tpl.color_muted,
    ['--rc-primary' as any]: tpl.color_primary,
    ['--rc-accent' as any]: tpl.color_accent,
    ['--rc-divider' as any]: tpl.color_divider,
    ['--rc-logo-size' as any]: `${tpl.logo_size_mm}mm`,
    ['--rc-logo-align' as any]: tpl.logo_align,
    ['--rc-section-gap' as any]: `${tpl.section_gap_mm ?? 2}mm`,
    width: `${tpl.paper_width_mm}mm`,
    minHeight: tpl.paper_height_mm ? `${tpl.paper_height_mm}mm` : undefined,
    paddingTop: `${tpl.padding_mm + (tpl.margin_top_mm || 0)}mm`,
    paddingBottom: `${tpl.padding_mm + (tpl.margin_bottom_mm || 0)}mm`,
    paddingRight: `${tpl.padding_mm}mm`,
    paddingLeft: `${tpl.padding_mm}mm`,
    background: tpl.background_color || '#fff',
    border: tpl.border_width_mm
      ? `${tpl.border_width_mm}mm ${tpl.border_style || 'solid'} ${tpl.border_color || '#000'}`
      : undefined,
    borderRadius: tpl.border_radius_mm ? `${tpl.border_radius_mm}mm` : undefined,
  };
  const dividerChar = tpl.dashed_divider ? '─' : '━';
  const dividerLine = dividerChar.repeat(Math.max(20, Math.round(tpl.paper_width_mm / 2)));
  const doubleLine = (tpl.dashed_divider ? '═' : '━').repeat(Math.max(20, Math.round(tpl.paper_width_mm / 2)));

  return (
    <div className="receipt-print-root">
      <div className="receipt-80mm" style={rootStyle}>
        {/* Header */}
        <div className="receipt-header">
          {tpl.show_logo && shop.logo_url && (
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

        {tpl.show_header_note && shop.header_note && (
          <div className="receipt-header-note">{shop.header_note}</div>
        )}

        <div className="receipt-divider">{doubleLine}</div>

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
          {tpl.show_salesperson && inv.salesperson_name && (
            <div className="receipt-row">
              <span>البائع:</span>
              <span>{inv.salesperson_name}</span>
            </div>
          )}
          {tpl.show_warehouse && inv.warehouse_name && (
            <div className="receipt-row">
              <span>الفرع:</span>
              <span>{inv.warehouse_name}</span>
            </div>
          )}
          {tpl.show_customer && inv.customer_name && (
            <div className="receipt-row">
              <span>العميل:</span>
              <span>
                {inv.customer_name}
                {inv.customer_phone ? ` · ${inv.customer_phone}` : ''}
              </span>
            </div>
          )}
        </div>

        <div className="receipt-divider">{dividerLine}</div>

        {/* Items */}
        <table className="receipt-items">
          <thead>
            <tr>
              <th className="receipt-col-idx">#</th>
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
                  <td className="receipt-col-idx">{i + 1}</td>
                  <td className="receipt-col-name">
                    <div className="receipt-item-name">{name}</div>
                    {tpl.show_items_sku && sku && (
                      <div className="receipt-item-sku">{sku}</div>
                    )}
                    {tpl.show_items_variant && variantMeta && (
                      <div className="receipt-item-sku">{variantMeta}</div>
                    )}
                    {disc > 0 && (
                      <div className="receipt-item-disc">
                        خصم: {EGP(disc)}
                      </div>
                    )}
                    {tpl.show_salesperson &&
                      l.salesperson_name &&
                      l.salesperson_name !== inv.salesperson_name && (
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

        <div className="receipt-divider">{dividerLine}</div>

        {/* Totals */}
        <div className="receipt-totals">
          <div className="receipt-total-pieces">
            <strong>{lines.length} صنف · {totalPieces} قطعة</strong>
          </div>
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
          <div className={`receipt-row receipt-grand ${tpl.grand_total_boxed ? 'receipt-grand-boxed' : ''}`}>
            <span>الإجمالي:</span>
            <strong>{EGP(Number(inv.grand_total))} ج.م</strong>
          </div>
          {tpl.show_profit && Number(inv.gross_profit) > 0 && (
            <div className="receipt-row receipt-profit">
              <span>ربح الفاتورة:</span>
              <strong>{EGP(Number(inv.gross_profit))} ج.م</strong>
            </div>
          )}
        </div>

        <div className="receipt-divider">{dividerLine}</div>

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
        {tpl.show_loyalty &&
          (earnedPoints > 0 ||
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

        {tpl.show_notes && inv.notes && (
          <>
            <div className="receipt-divider">{dividerLine}</div>
            <div className="receipt-notes">
              <div className="receipt-notes-title">ملاحظات:</div>
              <div>{inv.notes}</div>
            </div>
          </>
        )}

        {tpl.show_terms && shop.terms && (
          <>
            <div className="receipt-divider">{dividerLine}</div>
            <div className="receipt-terms">
              <div className="receipt-terms-title">الشروط والأحكام</div>
              <div className="receipt-terms-body">{shop.terms}</div>
            </div>
          </>
        )}

        <div className="receipt-divider">{doubleLine}</div>

        {tpl.show_barcode && invoiceNo && (
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

        {tpl.show_qr && (shop.qr_image_url || shop.qr_url) && (
          <div className="receipt-qr">
            {shop.qr_image_url ? (
              <img
                src={shop.qr_image_url}
                alt="qr"
                className="receipt-qr-image"
              />
            ) : (
              <QRCodeSVG
                value={shop.qr_url!}
                size={96}
                level="M"
                includeMargin={false}
              />
            )}
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
          {tpl.show_print_stamp && (
            <div className="receipt-tiny">
              طُبعت: {new Date().toLocaleString('en-GB')}
            </div>
          )}
        </div>
      </div>

      <style>{`
        .receipt-80mm {
          font-family: var(--rc-font, 'Cairo', 'Courier New', monospace);
          font-size: var(--rc-fs, 11px);
          color: var(--rc-text, #000);
          line-height: var(--rc-lh, 1.35);
          direction: rtl;
          background: #fff;
          box-sizing: border-box;
        }
        .receipt-header {
          text-align: var(--rc-logo-align, center);
          margin-bottom: 4px;
        }
        .receipt-logo {
          max-width: calc(var(--rc-logo-size, 20mm) * 2);
          max-height: var(--rc-logo-size, 20mm);
          margin: 0 auto 4px;
          display: block;
          object-fit: contain;
        }
        .receipt-shop-name {
          font-weight: 900;
          font-size: var(--rc-fs-title, 14px);
          margin-bottom: 2px;
          color: var(--rc-primary, #000);
        }
        .receipt-line {
          font-size: calc(var(--rc-fs, 11px) - 1px);
          color: var(--rc-muted, #555);
        }
        .receipt-divider {
          text-align: center;
          font-size: 10px;
          letter-spacing: -1px;
          margin: 3px 0;
          color: var(--rc-divider, #000);
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
        .receipt-col-idx {
          text-align: center;
          width: 6%;
          font-weight: bold;
          color: var(--rc-muted, #555);
        }
        .receipt-total-pieces {
          text-align: center;
          font-size: calc(var(--rc-fs, 11px) + 1px);
          padding: 3px 0;
          margin: 2px 0;
          color: var(--rc-primary, #000);
          border-bottom: 1px dashed var(--rc-divider, #000);
        }
        .receipt-divider + * + .receipt-totals,
        .receipt-totals,
        .receipt-payments,
        .receipt-loyalty,
        .receipt-notes,
        .receipt-terms {
          margin-top: var(--rc-section-gap, 2mm);
        }
        .receipt-col-name {
          text-align: right;
          width: 40%;
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
          font-size: calc(var(--rc-fs, 11px) + 2px);
          font-weight: 900;
          border-top: 1px dashed var(--rc-divider, #000);
          padding-top: 3px;
          margin-top: 2px;
          color: var(--rc-accent, #be185d);
        }
        .receipt-grand-boxed {
          border: 2px solid var(--rc-accent, #be185d);
          border-radius: 4px;
          padding: 4px 6px !important;
          margin: 4px 0;
          background: color-mix(in srgb, var(--rc-accent, #be185d) 8%, transparent);
        }
        .receipt-profit {
          font-size: 10px;
          color: var(--rc-muted, #333);
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
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          margin: 6px auto 2px;
          text-align: center;
        }
        .receipt-qr svg,
        .receipt-qr-image { display: block; margin: 0 auto; }
        .receipt-qr-image {
          width: 28mm;
          height: 28mm;
          object-fit: contain;
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
            size: ${tpl.paper_width_mm}mm ${tpl.paper_height_mm ? `${tpl.paper_height_mm}mm` : 'auto'};
            margin: 0;
          }
          html, body {
            margin: 0 !important;
            padding: 0 !important;
            width: ${tpl.paper_width_mm}mm !important;
            min-height: 0 !important;
            height: auto !important;
            background: #fff !important;
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
          /* Hide everything on the page via visibility (preserves layout),
             then reveal the receipt subtree. This is safe whether the
             receipt is a direct child of body or nested inside #root. */
          body * {
            visibility: hidden !important;
          }
          .receipt-print-root,
          .receipt-print-root * {
            visibility: visible !important;
          }
          .receipt-print-root {
            position: absolute !important;
            top: 0 !important;
            left: 0 !important;
            right: 0 !important;
            width: ${tpl.paper_width_mm}mm !important;
            margin: 0 !important;
            padding: 0 !important;
            height: auto !important;
            max-height: none !important;
            overflow: visible !important;
          }
          .receipt-80mm {
            width: ${tpl.paper_width_mm}mm !important;
            min-height: 0 !important;
            height: auto !important;
            max-height: none !important;
            box-sizing: border-box;
            page-break-inside: auto;
            break-inside: auto;
            overflow: visible !important;
          }
          .receipt-80mm img,
          .receipt-80mm svg {
            page-break-inside: avoid;
            break-inside: avoid;
          }
        }
      `}</style>
    </div>
  );
}
