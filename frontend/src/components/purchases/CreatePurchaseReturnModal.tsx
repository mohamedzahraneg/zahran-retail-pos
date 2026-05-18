/**
 * CreatePurchaseReturnModal.tsx — PR-P2.4A
 *
 * Modal launched from the per-row "مرتجع" button on the Purchases
 * page. Loads `GET /purchases/:id/returnable-items`, lets the
 * operator pick qty per line (capped at `returnable`), choose a
 * settlement type (4 modes), pick a cashbox + matching kind when
 * cash/bank refund is selected, and submit.
 *
 * Hard constraints enforced client-side (BE re-validates):
 *   · cash_refund  → cash cashbox  + refund_amount === total
 *   · bank_refund  → bank cashbox  + refund_amount === total
 *   · supplier_credit / no_settlement → no cashbox + no refund_amount
 *   · reason >= 3 chars
 *   · qty ≤ returnable per line
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { X, Undo2, AlertCircle } from 'lucide-react';
import {
  purchaseReturnsApi,
  PurchaseReturnSettlementType,
  ReturnableItem,
  ReturnableResponse,
} from '@/api/purchaseReturns.api';
import { cashDeskApi } from '@/api/cash-desk.api';

interface Props {
  purchaseId: string;
  onClose: () => void;
}

interface DraftLine {
  purchase_item_id: string;
  variant_id: string;
  quantity: number;
  unit_cost: number;
}

const SETTLEMENT_OPTIONS: Array<{
  value: PurchaseReturnSettlementType;
  label: string;
  hint: string;
}> = [
  {
    value: 'supplier_credit',
    label: 'رصيد دائن للمورد',
    hint: 'يخصم من رصيد المورد ولا يحرّك خزنة',
  },
  {
    value: 'cash_refund',
    label: 'استرداد نقدي',
    hint: 'يستلم نقدًا من المورد في خزنة نقدية',
  },
  {
    value: 'bank_refund',
    label: 'استرداد بنكي',
    hint: 'يستلم تحويلاً بنكيًا في خزنة بنك/محفظة',
  },
  {
    value: 'no_settlement',
    label: 'بدون تسوية',
    hint: 'يُعدّل المخزون فقط (لا قيد ولا خزنة)',
  },
];

const fmtMoney = (n: number) =>
  n.toLocaleString('en-EG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export function CreatePurchaseReturnModal({ purchaseId, onClose }: Props) {
  const qc = useQueryClient();
  const [lines, setLines] = useState<Record<string, DraftLine>>({});
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [settlementType, setSettlementType] =
    useState<PurchaseReturnSettlementType>('supplier_credit');
  const [cashboxId, setCashboxId] = useState<string>('');

  const returnableQ = useQuery({
    queryKey: ['returnable-items', purchaseId],
    queryFn: () => purchaseReturnsApi.returnableItems(purchaseId),
    enabled: !!purchaseId,
  });

  const cashboxesQ = useQuery({
    queryKey: ['cashboxes'],
    queryFn: () => cashDeskApi.cashboxes(),
    enabled:
      settlementType === 'cash_refund' || settlementType === 'bank_refund',
  });

  // Settlement-type guards: clear cashbox when switching to non-cash settlement.
  useEffect(() => {
    if (
      settlementType !== 'cash_refund'
      && settlementType !== 'bank_refund'
    ) {
      setCashboxId('');
    }
  }, [settlementType]);

  const totalAmount = useMemo(() => {
    let t = 0;
    for (const l of Object.values(lines)) {
      t += Number(l.quantity || 0) * Number(l.unit_cost || 0);
    }
    return +t.toFixed(2);
  }, [lines]);

  const filteredCashboxes = useMemo(() => {
    if (!cashboxesQ.data) return [];
    const list = cashboxesQ.data.filter((cb) => cb.is_active);
    if (settlementType === 'cash_refund') {
      return list.filter((cb) => cb.kind === 'cash');
    }
    if (settlementType === 'bank_refund') {
      return list.filter((cb) => cb.kind !== 'cash');
    }
    return list;
  }, [cashboxesQ.data, settlementType]);

  const createM = useMutation({
    mutationFn: () => {
      const items = Object.values(lines).filter((l) => l.quantity > 0);
      return purchaseReturnsApi.create({
        supplier_id: returnableQ.data!.purchase.supplier_id,
        warehouse_id: returnableQ.data!.purchase.warehouse_id,
        purchase_id: purchaseId,
        items: items.map((l) => ({
          variant_id: l.variant_id,
          purchase_item_id: l.purchase_item_id,
          quantity: l.quantity,
          unit_cost: l.unit_cost,
        })),
        reason: reason.trim(),
        notes: notes.trim() || undefined,
        settlement_type: settlementType,
        cashbox_id:
          settlementType === 'cash_refund'
          || settlementType === 'bank_refund'
            ? cashboxId
            : undefined,
        refund_amount:
          settlementType === 'cash_refund'
          || settlementType === 'bank_refund'
            ? totalAmount
            : undefined,
      });
    },
    onSuccess: () => {
      toast.success('تم إنشاء وترحيل المرتجع بنجاح');
      qc.invalidateQueries({ queryKey: ['purchase-returns'] });
      qc.invalidateQueries({ queryKey: ['returnable-items', purchaseId] });
      qc.invalidateQueries({ queryKey: ['purchases'] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل إنشاء المرتجع'),
  });

  // Validation
  const itemsWithQty = Object.values(lines).filter((l) => l.quantity > 0);
  const validationErrors: string[] = [];
  if (itemsWithQty.length === 0) validationErrors.push('اختر صنفًا واحدًا على الأقل');
  if (reason.trim().length < 3) validationErrors.push('اكتب سبب المرتجع (3 أحرف على الأقل)');
  if (totalAmount < 0.01) validationErrors.push('قيمة المرتجع يجب أن تكون أكبر من صفر');
  if (
    (settlementType === 'cash_refund' || settlementType === 'bank_refund')
    && !cashboxId
  ) {
    validationErrors.push('اختر خزنة مطابقة لنوع الاسترداد');
  }
  const canSubmit = validationErrors.length === 0 && !createM.isPending;

  const onLineChange = (item: ReturnableItem, qty: number) => {
    const returnable = Number(item.returnable);
    const safeQty = Math.max(0, Math.min(qty, returnable));
    setLines((prev) => {
      if (safeQty <= 0) {
        const next = { ...prev };
        delete next[item.purchase_item_id];
        return next;
      }
      return {
        ...prev,
        [item.purchase_item_id]: {
          purchase_item_id: item.purchase_item_id,
          variant_id: item.variant_id,
          quantity: safeQty,
          unit_cost: Number(item.unit_cost),
        },
      };
    });
  };

  return (
    <Modal title="إنشاء مرتجع مشتريات" onClose={onClose} wide>
      {returnableQ.isLoading && (
        <div className="py-8 text-center text-slate-500">جاري التحميل…</div>
      )}
      {returnableQ.isError && (
        <div className="p-3 bg-rose-50 text-rose-700 rounded-xl flex items-center gap-2 text-sm">
          <AlertCircle size={16} /> تعذّر تحميل بيانات الفاتورة. أعد المحاولة.
        </div>
      )}
      {returnableQ.data && (
        <ReturnableTable
          data={returnableQ.data}
          lines={lines}
          onChange={onLineChange}
        />
      )}

      <hr className="my-4" />

      <Field label="نوع التسوية">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {SETTLEMENT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              data-testid={`settlement-${opt.value}`}
              className={`p-3 rounded-xl border text-right transition ${
                settlementType === opt.value
                  ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-200'
                  : 'border-slate-200 bg-white hover:bg-slate-50'
              }`}
              onClick={() => setSettlementType(opt.value)}
            >
              <div className="font-bold text-sm">{opt.label}</div>
              <div className="text-xs text-slate-500 mt-0.5">{opt.hint}</div>
            </button>
          ))}
        </div>
      </Field>

      {(settlementType === 'cash_refund' || settlementType === 'bank_refund') && (
        <Field
          label={
            settlementType === 'cash_refund'
              ? 'الخزنة النقدية المستلمة'
              : 'الخزنة البنكية / المحفظة المستلمة'
          }
        >
          <select
            data-testid="cashbox-select"
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm bg-white"
            value={cashboxId}
            onChange={(e) => setCashboxId(e.target.value)}
          >
            <option value="">— اختر خزنة —</option>
            {filteredCashboxes.map((cb) => (
              <option key={cb.id} value={cb.id}>
                {cb.name_ar || cb.name}
              </option>
            ))}
          </select>
          {filteredCashboxes.length === 0 && cashboxesQ.isSuccess && (
            <div className="text-xs text-rose-600 mt-1">
              لا توجد خزنة فعّالة من النوع المطلوب
            </div>
          )}
        </Field>
      )}

      <Field label="سبب المرتجع">
        <textarea
          data-testid="reason-input"
          className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm bg-white"
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="مثال: بضاعة معيبة / غير مطابقة للمواصفات"
        />
      </Field>

      <Field label="ملاحظات (اختيارية)">
        <textarea
          className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm bg-white"
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </Field>

      <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl mt-2">
        <div className="text-sm text-slate-600">إجمالي قيمة المرتجع</div>
        <div className="font-black text-xl text-brand-700">
          {fmtMoney(totalAmount)} ج.م
        </div>
      </div>

      {validationErrors.length > 0 && (
        <ul className="text-xs text-rose-600 space-y-1 mt-2">
          {validationErrors.map((e, i) => (
            <li key={i}>• {e}</li>
          ))}
        </ul>
      )}

      <div className="flex justify-end gap-2 pt-3 border-t mt-4">
        <button
          className="px-4 py-2 rounded-xl bg-slate-100 text-slate-700 hover:bg-slate-200 text-sm font-bold"
          onClick={onClose}
        >
          إلغاء
        </button>
        <button
          data-testid="submit-purchase-return"
          disabled={!canSubmit}
          onClick={() => createM.mutate()}
          className="px-4 py-2 rounded-xl bg-brand-600 text-white hover:bg-brand-700 text-sm font-bold disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          <Undo2 size={16} />
          إنشاء وترحيل
        </button>
      </div>
    </Modal>
  );
}

function ReturnableTable({
  data,
  lines,
  onChange,
}: {
  data: ReturnableResponse;
  lines: Record<string, DraftLine>;
  onChange: (item: ReturnableItem, qty: number) => void;
}) {
  if (data.items.length === 0) {
    return (
      <div className="p-4 bg-slate-50 rounded-xl text-center text-slate-500 text-sm">
        لا توجد بنود قابلة للإرجاع.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto border rounded-xl">
      <table className="w-full text-sm">
        <thead className="bg-slate-50">
          <tr>
            <th className="p-2 text-right font-bold text-xs">الصنف</th>
            <th className="p-2 text-right font-bold text-xs">SKU</th>
            <th className="p-2 text-right font-bold text-xs">مستلَم</th>
            <th className="p-2 text-right font-bold text-xs">مرتجع سابقًا</th>
            <th className="p-2 text-right font-bold text-xs">القابل للإرجاع</th>
            <th className="p-2 text-right font-bold text-xs">سعر التكلفة</th>
            <th className="p-2 text-right font-bold text-xs">كمية المرتجع</th>
            <th className="p-2 text-right font-bold text-xs">قيمة السطر</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((it) => {
            const draft = lines[it.purchase_item_id];
            const qty = draft?.quantity ?? 0;
            const returnable = Number(it.returnable);
            const unitCost = Number(it.unit_cost);
            const lineTotal = qty * unitCost;
            const disabled = returnable <= 0;
            return (
              <tr key={it.purchase_item_id} className="border-t">
                <td className="p-2">
                  <div className="font-bold text-slate-800">
                    {it.product_name}
                  </div>
                  <div className="text-xs text-slate-500">
                    {[it.color_name, it.size_label].filter(Boolean).join(' / ')}
                  </div>
                </td>
                <td className="p-2 text-xs text-slate-600">{it.sku}</td>
                <td className="p-2 text-slate-700">{Number(it.received)}</td>
                <td className="p-2 text-slate-500">
                  {Number(it.already_returned)}
                </td>
                <td className="p-2 font-bold text-slate-800">{returnable}</td>
                <td className="p-2 text-slate-600">{fmtMoney(unitCost)}</td>
                <td className="p-2 w-28">
                  <input
                    type="number"
                    min={0}
                    max={returnable}
                    step="0.001"
                    disabled={disabled}
                    data-testid={`qty-${it.purchase_item_id}`}
                    className="w-24 rounded-lg border border-slate-200 px-2 py-1 text-sm disabled:bg-slate-100"
                    value={qty || ''}
                    onChange={(e) => onChange(it, Number(e.target.value))}
                  />
                </td>
                <td className="p-2 font-bold text-slate-700">
                  {fmtMoney(lineTotal)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Modal({
  title,
  onClose,
  wide,
  children,
}: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-start justify-center p-4 overflow-y-auto">
      <div
        className={`bg-white rounded-2xl shadow-2xl w-full ${wide ? 'max-w-5xl' : 'max-w-xl'} my-8`}
      >
        <div className="flex items-center justify-between p-4 border-b">
          <h3 className="text-lg font-bold">{title}</h3>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-slate-100"
          >
            <X size={18} />
          </button>
        </div>
        <div className="p-4 space-y-3">{children}</div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-bold text-slate-700 mb-1">
        {label}
      </label>
      {children}
    </div>
  );
}
