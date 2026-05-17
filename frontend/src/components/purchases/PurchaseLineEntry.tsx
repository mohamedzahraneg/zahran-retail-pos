/**
 * PurchaseLineEntry — PR-PURCHASES-P1
 *
 * Carton-aware line entry for a single picked variant inside the
 * purchase-invoice. After the operator selects a variant via
 * PurchaseProductSearch, this component renders:
 *
 *   • product identity (name + color + size + stock-before-purchase)
 *   • mode toggle: قطعة / كرتونة
 *   • piece mode → quantity + unit_cost
 *   • carton mode → cartons × pieces_per_carton × carton_cost
 *   • computed: total pieces · unit piece cost · line total
 *   • add-to-invoice button (calls onConfirm with the backend payload)
 *
 * The math lives in `./cartonMath.ts` so it's testable in isolation.
 * Backend payload remains piece-level (`quantity` + `unit_cost`).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Boxes, Package, Plus, XCircle } from 'lucide-react';
import {
  computeLine,
  toBackendItem,
  type PurchaseUnit,
} from './cartonMath';
import type {
  CreatePurchaseItemPayload,
  PurchaseProductSearchRow,
} from '@/api/purchases.api';

const EGP = (n: number | string | null | undefined) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

export interface PurchaseLineEntryProps {
  row: PurchaseProductSearchRow;
  /** Default pieces_per_carton seed (UI hint). Defaults to 1. */
  defaultPiecesPerCarton?: number;
  onConfirm: (
    payload: CreatePurchaseItemPayload & {
      _ui: {
        display: string;
        mode: PurchaseUnit;
        cartons?: number;
        pieces_per_carton?: number;
        carton_cost?: number;
      };
    },
  ) => void;
  onCancel: () => void;
}

export function PurchaseLineEntry({
  row,
  defaultPiecesPerCarton = 1,
  onConfirm,
  onCancel,
}: PurchaseLineEntryProps) {
  const [mode, setMode] = useState<PurchaseUnit>('piece');
  const [quantity, setQuantity] = useState(1);
  const [unitCost, setUnitCost] = useState<number>(
    row.last_purchase_price ?? row.cost_price ?? 0,
  );
  const [cartons, setCartons] = useState(1);
  const [piecesPerCarton, setPiecesPerCarton] = useState(
    Math.max(1, defaultPiecesPerCarton),
  );
  const [cartonCost, setCartonCost] = useState(
    (row.last_purchase_price ?? row.cost_price ?? 0) *
      Math.max(1, defaultPiecesPerCarton),
  );
  const [discount, setDiscount] = useState(0);

  // Purchases UX fixes — Enter keyboard flow.
  //   1. Picking a product (parent search) lands us here → focus qty.
  //   2. Enter on qty   → focus price (unit_cost or carton_cost).
  //   3. Enter on price → trigger submit() (parent re-renders search).
  // Refs are also exposed so end-to-end tests can target each step.
  const quantityRef = useRef<HTMLInputElement | null>(null);
  const priceRef = useRef<HTMLInputElement | null>(null);
  // Auto-focus the qty input as soon as a row is selected. The mount
  // happens AFTER the search clears, so this is the natural next step.
  useEffect(() => {
    quantityRef.current?.focus();
    quantityRef.current?.select();
  }, [row.variant_id, mode]);

  // Switching mode: copy state across so the operator's other input
  // stays meaningful.  carton_cost = unit_cost × ppc when entering
  // carton mode; unit_cost = carton_cost / ppc when entering piece.
  useEffect(() => {
    if (mode === 'carton') {
      setCartonCost(unitCost * Math.max(1, piecesPerCarton));
    } else {
      setUnitCost(cartonCost / Math.max(1, piecesPerCarton));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const computed = useMemo(
    () =>
      computeLine({
        mode,
        quantity,
        cartons,
        pieces_per_carton: piecesPerCarton,
        unit_cost: unitCost,
        carton_cost: cartonCost,
        discount,
      }),
    [mode, quantity, cartons, piecesPerCarton, unitCost, cartonCost, discount],
  );

  const submit = () => {
    if (computed.total_pieces < 1) return;
    if (computed.unit_piece_cost <= 0) return;
    const backend = toBackendItem({
      variant_id: row.variant_id,
      mode,
      quantity,
      cartons,
      pieces_per_carton: piecesPerCarton,
      unit_cost: unitCost,
      carton_cost: cartonCost,
      discount,
    });
    const display = `${row.name_ar} — ${row.variant_sku}`;
    onConfirm({
      ...backend,
      _ui: {
        display,
        mode,
        cartons: mode === 'carton' ? cartons : undefined,
        pieces_per_carton:
          mode === 'carton' || piecesPerCarton > 1 ? piecesPerCarton : undefined,
        carton_cost: mode === 'carton' ? cartonCost : undefined,
      },
    });
  };

  return (
    <div
      data-testid="purchase-line-entry"
      className="rounded-xl border border-brand-200 bg-brand-50/40 p-3 space-y-3"
    >
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <div className="font-bold text-slate-800">
            {row.name_ar}
            {row.color ? <span className="text-slate-500"> · {row.color}</span> : null}
            {row.size ? <span className="text-slate-500"> · {row.size}</span> : null}
          </div>
          <div className="text-xs text-slate-500 mt-0.5 flex gap-2 flex-wrap">
            <span className="font-mono">{row.variant_sku}</span>
            {row.variant_barcode ? (
              <span className="font-mono">· {row.variant_barcode}</span>
            ) : null}
            <span>· المخزون قبل: {row.available_stock}</span>
            {row.last_purchase_price != null ? (
              <span>· آخر شراء: {EGP(row.last_purchase_price)}</span>
            ) : null}
          </div>
        </div>
        <button type="button" onClick={onCancel} className="icon-btn text-slate-400">
          <XCircle className="w-5 h-5" />
        </button>
      </div>

      <div
        className="inline-flex rounded-md border border-slate-200 overflow-hidden text-xs"
        role="tablist"
        data-testid="purchase-line-mode-toggle"
      >
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'piece'}
          onClick={() => setMode('piece')}
          className={`px-3 py-1.5 flex items-center gap-1 ${
            mode === 'piece' ? 'bg-brand-500 text-white' : 'bg-white text-slate-600'
          }`}
          data-testid="purchase-line-mode-piece"
        >
          <Package className="w-3.5 h-3.5" />
          قطعة
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'carton'}
          onClick={() => setMode('carton')}
          className={`px-3 py-1.5 flex items-center gap-1 ${
            mode === 'carton' ? 'bg-brand-500 text-white' : 'bg-white text-slate-600'
          }`}
          data-testid="purchase-line-mode-carton"
        >
          <Boxes className="w-3.5 h-3.5" />
          كرتونة
        </button>
      </div>

      {mode === 'piece' ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <div>
            <label className="label">الكمية (قطعة)</label>
            <input
              ref={quantityRef}
              type="number"
              min={1}
              className="input"
              value={quantity}
              onChange={(e) => setQuantity(Number(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  priceRef.current?.focus();
                  priceRef.current?.select();
                }
              }}
              data-testid="purchase-line-piece-qty"
            />
          </div>
          <div>
            <label className="label">سعر القطعة</label>
            <input
              ref={priceRef}
              type="number"
              min={0}
              step="0.01"
              className="input"
              value={unitCost}
              onChange={(e) => setUnitCost(Number(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submit();
                }
              }}
              data-testid="purchase-line-piece-cost"
            />
          </div>
          <div>
            <label className="label">خصم السطر (اختياري)</label>
            <input
              type="number"
              min={0}
              step="0.01"
              className="input"
              value={discount}
              onChange={(e) => setDiscount(Number(e.target.value))}
            />
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <div>
            <label className="label">عدد الكراتين</label>
            <input
              ref={quantityRef}
              type="number"
              min={1}
              className="input"
              value={cartons}
              onChange={(e) => setCartons(Number(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  priceRef.current?.focus();
                  priceRef.current?.select();
                }
              }}
              data-testid="purchase-line-cartons"
            />
          </div>
          <div>
            <label className="label">قطع/كرتونة</label>
            <input
              type="number"
              min={1}
              className="input"
              value={piecesPerCarton}
              onChange={(e) => setPiecesPerCarton(Number(e.target.value))}
              data-testid="purchase-line-ppc"
            />
          </div>
          <div>
            <label className="label">سعر الكرتونة</label>
            <input
              ref={priceRef}
              type="number"
              min={0}
              step="0.01"
              className="input"
              value={cartonCost}
              onChange={(e) => setCartonCost(Number(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submit();
                }
              }}
              data-testid="purchase-line-carton-cost"
            />
          </div>
          <div>
            <label className="label">خصم السطر (اختياري)</label>
            <input
              type="number"
              min={0}
              step="0.01"
              className="input"
              value={discount}
              onChange={(e) => setDiscount(Number(e.target.value))}
            />
          </div>
        </div>
      )}

      <div
        className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs"
        data-testid="purchase-line-computed"
      >
        <SummaryTile label="إجمالي القطع" value={String(computed.total_pieces)} />
        <SummaryTile
          label="تكلفة القطعة"
          value={EGP(computed.unit_piece_cost)}
        />
        {mode === 'carton' ? (
          <SummaryTile label="سعر الكرتونة" value={EGP(computed.carton_price)} />
        ) : (
          <SummaryTile
            label="تكلفة الكرتونة المحسوبة"
            value={EGP(computed.carton_price)}
          />
        )}
        <SummaryTile label="إجمالي السطر" value={EGP(computed.line_total)} highlight />
      </div>

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn-ghost text-xs">
          إلغاء
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={computed.total_pieces < 1 || computed.unit_piece_cost <= 0}
          className="btn-primary text-xs"
          data-testid="purchase-line-add"
        >
          <Plus className="w-3.5 h-3.5" /> إضافة للفاتورة
        </button>
      </div>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-md border p-2 ${
        highlight
          ? 'bg-brand-50 border-brand-200 text-brand-700'
          : 'bg-white border-slate-200 text-slate-700'
      }`}
    >
      <div className="text-[10px] text-slate-500 mb-0.5">{label}</div>
      <div className="font-bold">{value}</div>
    </div>
  );
}
