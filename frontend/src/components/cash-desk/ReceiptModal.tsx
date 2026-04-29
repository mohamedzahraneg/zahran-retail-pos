/**
 * ReceiptModal — PR-CASH-DESK-REORG-1
 * ────────────────────────────────────────────────────────────────────
 *
 * استلام مقبوضة من عميل. Lifted from `pages/CashDesk.tsx:902–1199`
 * verbatim and given an optional `prefilledCustomer` prop so the
 * Customers page can open it with a customer already selected (the
 * post-reorg entry point) while CashDesk's `embedded` mode could
 * still mount it without any pre-fill if needed in the future.
 *
 * The mutation contract (`cashDeskApi.receive` → `POST /cash-desk/customer-payments`)
 * and the rendered form are bit-for-bit identical to the original —
 * only the customer-search section is hidden + replaced by a
 * read-only header when `prefilledCustomer` is provided.
 *
 * Backend writes (per the PR-CASH-DESK-REORG-1 audit):
 *   - INSERT INTO customer_payments (+ optional allocations)
 *   - Trigger fn_customer_payment_apply: cashbox_transactions (cash
 *     payment_method only) + customers.current_balance + customer_ledger
 *   - posting.postInvoicePayment: balanced JE
 *     (DR cashbox GL · CR receivables 1121 OR deposits 212 if kind=deposit)
 *
 * data-testid:
 *   - `receipt-modal`            — outermost <Modal>
 *   - `receipt-modal-customer-search`  — search input
 *   - `receipt-modal-amount`     — amount input
 *   - `receipt-modal-submit`     — confirm button
 *   - `receipt-modal-cancel`     — cancel button
 */
import { useState, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Plus, X } from 'lucide-react';
import { cashDeskApi, type Cashbox, type PaymentMethod } from '@/api/cash-desk.api';
import { customersApi, type Customer } from '@/api/customers.api';
import { InvoiceHoverCard } from '@/components/InvoiceHoverCard';
import { Modal, Field } from './Modal';

const EGP = (n: number | string) =>
  `${Number(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

export interface ReceiptModalProps {
  cashboxes: Cashbox[];
  onClose: () => void;
  onSuccess: () => void;
  /**
   * PR-CASH-DESK-REORG-1 — when supplied, the modal opens with this
   * customer locked in. Used by the Customers page entry point so
   * the operator doesn't have to re-search for the customer they
   * just clicked on. CashDesk's previous embedded path can still
   * mount the modal without pre-fill (no behavioural change).
   */
  prefilledCustomer?: Customer | null;
}

export function ReceiptModal({
  cashboxes,
  onClose,
  onSuccess,
  prefilledCustomer = null,
}: ReceiptModalProps) {
  const [customer, setCustomer] = useState<Customer | null>(prefilledCustomer);
  const [customerQ, setCustomerQ] = useState('');
  const [cashboxId, setCashboxId] = useState(cashboxes[0]?.id || '');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [amount, setAmount] = useState('');
  const [kind, setKind] = useState<'settle_invoices' | 'deposit' | 'refund'>(
    'settle_invoices',
  );
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [allocations, setAllocations] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!cashboxId && cashboxes.length) setCashboxId(cashboxes[0].id);
  }, [cashboxes, cashboxId]);

  const { data: customerSearch = { data: [] } } = useQuery({
    queryKey: ['customers-search', customerQ],
    queryFn: () => customersApi.list({ q: customerQ, limit: 8 }),
    enabled: customerQ.length >= 2 && !prefilledCustomer,
  });

  const { data: unpaid = [] } = useQuery({
    queryKey: ['unpaid-invoices', customer?.id],
    queryFn: () => customersApi.unpaidInvoices(customer!.id),
    enabled: !!customer && kind === 'settle_invoices',
  });

  const mutation = useMutation({
    mutationFn: cashDeskApi.receive,
    onSuccess: () => {
      toast.success('تم تسجيل المقبوضة');
      onSuccess();
    },
  });

  const totalAllocated = Object.values(allocations).reduce((s, v) => s + v, 0);

  const submit = () => {
    if (!customer) return toast.error('اختر عميلاً');
    if (!cashboxId) return toast.error('اختر الخزينة');
    const amt = Number(amount);
    if (!amt || amt <= 0) return toast.error('أدخل مبلغاً صحيحاً');
    if (kind === 'settle_invoices' && Math.abs(totalAllocated - amt) > 0.01) {
      return toast.error('مجموع التخصيصات لا يساوي المبلغ');
    }
    mutation.mutate({
      customer_id: customer.id,
      cashbox_id: cashboxId,
      payment_method: method,
      amount: amt,
      kind,
      reference: reference || undefined,
      notes: notes || undefined,
      allocations:
        kind === 'settle_invoices'
          ? Object.entries(allocations)
              .filter(([, v]) => v > 0)
              .map(([invoice_id, amount]) => ({ invoice_id, amount }))
          : undefined,
    });
  };

  return (
    <div data-testid="receipt-modal">
      <Modal title="استلام مقبوضة من عميل" onClose={onClose} size="lg">
        <div className="space-y-4">
          {/* Customer — pre-filled (locked) when caller passed one. */}
          <Field label="العميل">
            {customer ? (
              <div className="flex items-center justify-between p-3 bg-brand-50 rounded-lg">
                <div>
                  <div className="font-bold">{customer.full_name}</div>
                  <div className="text-xs text-slate-600 font-mono">
                    {customer.code}
                  </div>
                  {typeof customer.current_balance !== 'undefined' && (
                    <div className="text-xs text-rose-600 font-bold mt-1">
                      مستحق: {EGP(customer.current_balance)}
                    </div>
                  )}
                </div>
                {/* Hide the "clear" affordance when the modal was opened
                    against a specific customer — the operator should
                    cancel the modal instead of switching customers
                    inline. */}
                {!prefilledCustomer && (
                  <button
                    onClick={() => setCustomer(null)}
                    className="text-rose-600"
                    aria-label="إلغاء اختيار العميل"
                  >
                    <X size={18} />
                  </button>
                )}
              </div>
            ) : (
              <>
                <input
                  autoFocus
                  className="input"
                  placeholder="ابحث بالاسم أو الرقم..."
                  value={customerQ}
                  onChange={(e) => setCustomerQ(e.target.value)}
                  data-testid="receipt-modal-customer-search"
                />
                {customerQ.length >= 2 && customerSearch.data.length > 0 && (
                  <div className="mt-2 border border-slate-200 rounded-lg max-h-48 overflow-y-auto">
                    {customerSearch.data.map((c: Customer) => (
                      <button
                        key={c.id}
                        className="w-full text-right px-3 py-2 hover:bg-slate-50 border-b border-slate-100 last:border-0"
                        onClick={() => {
                          setCustomer(c);
                          setCustomerQ('');
                        }}
                      >
                        <div className="font-bold">{c.full_name}</div>
                        <div className="text-xs text-slate-500">
                          {c.phone} · {c.code}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </Field>

          {/* Type */}
          <div className="grid grid-cols-3 gap-2">
            {(['settle_invoices', 'deposit', 'refund'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={`py-2 rounded-lg font-bold text-sm ${
                  kind === k
                    ? 'bg-brand-600 text-white'
                    : 'bg-slate-100 text-slate-600'
                }`}
              >
                {k === 'settle_invoices'
                  ? 'سداد فواتير'
                  : k === 'deposit'
                    ? 'عربون/مقدم'
                    : 'استرجاع'}
              </button>
            ))}
          </div>

          {/* Cashbox + method */}
          <div className="grid md:grid-cols-2 gap-3">
            <Field label="الخزينة">
              <select
                className="input"
                value={cashboxId}
                onChange={(e) => setCashboxId(e.target.value)}
              >
                {cashboxes.map((cb) => (
                  <option key={cb.id} value={cb.id}>
                    {cb.name} ({EGP(cb.current_balance)})
                  </option>
                ))}
              </select>
            </Field>

            <Field label="طريقة الدفع">
              <select
                className="input"
                value={method}
                onChange={(e) => setMethod(e.target.value as PaymentMethod)}
              >
                <option value="cash">نقدي</option>
                <option value="card">بطاقة</option>
                <option value="instapay">إنستا باي</option>
                <option value="bank_transfer">تحويل بنكي</option>
              </select>
            </Field>
          </div>

          <div className="grid md:grid-cols-2 gap-3">
            <Field label="المبلغ">
              <input
                type="number"
                step="0.01"
                className="input"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                data-testid="receipt-modal-amount"
              />
            </Field>
            <Field label="المرجع (اختياري)">
              <input
                className="input"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="رقم إيصال/تحويل"
              />
            </Field>
          </div>

          {/* Allocations */}
          {kind === 'settle_invoices' && customer && unpaid.length > 0 && (
            <div className="border border-slate-200 rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-bold">
                  توزيع على الفواتير المستحقة
                </div>
                <button
                  type="button"
                  className="text-xs text-brand-600 hover:underline"
                  onClick={() => {
                    let left = Number(amount) || 0;
                    const next: Record<string, number> = {};
                    for (const inv of unpaid) {
                      if (left <= 0) break;
                      const rem = Number(inv.remaining);
                      const take = Math.min(rem, left);
                      next[inv.id] = take;
                      left -= take;
                    }
                    setAllocations(next);
                  }}
                >
                  توزيع تلقائي (الأقدم أولاً)
                </button>
              </div>
              <div className="space-y-1 max-h-60 overflow-y-auto">
                {unpaid.map((inv) => (
                  <div
                    key={inv.id}
                    className="grid grid-cols-[1fr_100px_120px] gap-2 items-center text-sm"
                  >
                    <div>
                      <div className="font-mono font-bold text-xs">
                        <InvoiceHoverCard
                          invoiceId={inv.id}
                          label={inv.invoice_no}
                          className="font-mono font-bold text-xs text-slate-800 hover:text-indigo-700 hover:underline"
                        />
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {new Date(inv.completed_at).toLocaleDateString('en-US')}
                      </div>
                    </div>
                    <div className="text-xs text-rose-600 font-bold text-left">
                      متبقي {EGP(inv.remaining)}
                    </div>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      max={inv.remaining}
                      className="input text-sm"
                      placeholder="0.00"
                      value={allocations[inv.id] || ''}
                      onChange={(e) => {
                        const v = Number(e.target.value) || 0;
                        setAllocations({ ...allocations, [inv.id]: v });
                      }}
                    />
                  </div>
                ))}
              </div>
              <div className="mt-2 pt-2 border-t border-slate-100 flex justify-between text-sm">
                <span>إجمالي التخصيص</span>
                <span
                  className={`font-black ${
                    Math.abs(totalAllocated - Number(amount || 0)) < 0.01
                      ? 'text-emerald-600'
                      : 'text-rose-600'
                  }`}
                >
                  {EGP(totalAllocated)}
                </span>
              </div>
            </div>
          )}

          <Field label="ملاحظات">
            <textarea
              rows={2}
              className="input"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </Field>

          <div className="flex gap-2 pt-2">
            <button
              className="btn-primary flex-1"
              onClick={submit}
              disabled={mutation.isPending}
              data-testid="receipt-modal-submit"
            >
              <Plus size={18} /> حفظ المقبوضة
            </button>
            <button
              className="btn-secondary"
              onClick={onClose}
              data-testid="receipt-modal-cancel"
            >
              إلغاء
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
