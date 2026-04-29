/**
 * SupplierPayModal — PR-CASH-DESK-REORG-1
 * ────────────────────────────────────────────────────────────────────
 *
 * دفعة لمورد. Lifted from `pages/CashDesk.tsx:1201–1370` verbatim and
 * given an optional `prefilledSupplier` prop so the Suppliers page
 * can open it with a supplier already selected (the post-reorg entry
 * point).
 *
 * The mutation contract (`cashDeskApi.pay` → `POST /cash-desk/supplier-payments`)
 * and the rendered form are bit-for-bit identical to the original —
 * only the supplier-search section is hidden + replaced by a
 * read-only header when `prefilledSupplier` is provided.
 *
 * Backend writes (per the PR-CASH-DESK-REORG-1 audit):
 *   - INSERT INTO supplier_payments (+ optional allocations)
 *   - Trigger fn_supplier_payment_apply: cashbox_transactions (cash
 *     payment_method only) + suppliers.current_balance + supplier_ledger
 *   - posting.postSupplierPayment: balanced JE
 *     (DR payables 211 · CR cashbox GL)
 */
import { useState, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ArrowUpCircle, X } from 'lucide-react';
import { cashDeskApi, type Cashbox, type PaymentMethod } from '@/api/cash-desk.api';
import { suppliersApi, type Supplier } from '@/api/suppliers.api';
import {
  paymentsApi,
  METHOD_LABEL_AR,
  type PaymentAccount,
} from '@/api/payments.api';
import {
  PaymentAccountPicker,
  autoSelectAccountForMethod,
  visibleMethodsFor,
} from '@/components/payments/PaymentAccountPicker';
import { Modal, Field } from './Modal';

const EGP = (n: number | string) =>
  `${Number(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

export interface SupplierPayModalProps {
  cashboxes: Cashbox[];
  onClose: () => void;
  onSuccess: () => void;
  /**
   * PR-CASH-DESK-REORG-1 — when supplied, the modal opens with this
   * supplier locked in. Used by the Suppliers page entry point so
   * the operator doesn't have to re-search.
   */
  prefilledSupplier?: Supplier | null;
}

export function SupplierPayModal({
  cashboxes,
  onClose,
  onSuccess,
  prefilledSupplier = null,
}: SupplierPayModalProps) {
  const [supplier, setSupplier] = useState<Supplier | null>(prefilledSupplier);
  const [supplierQ, setSupplierQ] = useState('');
  const [cashboxId, setCashboxId] = useState(cashboxes[0]?.id || '');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [paymentAccountId, setPaymentAccountId] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (!cashboxId && cashboxes.length) setCashboxId(cashboxes[0].id);
  }, [cashboxes, cashboxId]);

  const { data: supplierSearch = [] } = useQuery({
    queryKey: ['suppliers-search', supplierQ],
    queryFn: () => suppliersApi.list(supplierQ),
    enabled: supplierQ.length >= 2 && !prefilledSupplier,
  });

  // PR-FIN-PAYACCT-4C — payment-account catalog (mirror of ReceiptModal).
  const { data: providers = [] } = useQuery({
    queryKey: ['payment-providers'],
    queryFn: () => paymentsApi.listProviders(),
    staleTime: 5 * 60 * 1000,
  });
  const { data: accounts = [] } = useQuery({
    queryKey: ['payment-accounts', 'all'],
    queryFn: () => paymentsApi.listAccounts(),
    staleTime: 60 * 1000,
  });
  const visibleMethods = visibleMethodsFor(accounts);
  const accountsForMethod = (accounts as PaymentAccount[]).filter(
    (a) => a.method === method && a.active,
  );
  const isCash = method === 'cash';
  const blockedNoAccount = !isCash && accountsForMethod.length === 0;
  const needsManualPick =
    !isCash && accountsForMethod.length > 1 && !paymentAccountId;

  // Auto-select default/sole account when method changes.
  useEffect(() => {
    const auto = autoSelectAccountForMethod(method, accounts);
    setPaymentAccountId(auto.id);
  }, [method, accounts]);

  const mutation = useMutation({
    mutationFn: cashDeskApi.pay,
    onSuccess: () => {
      toast.success('تم تسجيل الدفعة');
      onSuccess();
    },
  });

  const submit = () => {
    if (!supplier) return toast.error('اختر المورد');
    if (!cashboxId) return toast.error('اختر الخزينة');
    const amt = Number(amount);
    if (!amt || amt <= 0) return toast.error('أدخل مبلغاً صحيحاً');
    if (!isCash && accountsForMethod.length > 0 && !paymentAccountId) {
      return toast.error('اختر حساب الدفع قبل المتابعة');
    }
    mutation.mutate({
      supplier_id: supplier.id,
      cashbox_id: cashboxId,
      payment_method: method,
      amount: amt,
      reference: reference || undefined,
      notes: notes || undefined,
      payment_account_id: isCash ? null : paymentAccountId,
    });
  };

  return (
    <div data-testid="supplier-pay-modal">
      <Modal title="دفعة لمورد" onClose={onClose}>
        <div className="space-y-4">
          <Field label="المورد">
            {supplier ? (
              <div className="flex items-center justify-between p-3 bg-brand-50 rounded-lg">
                <div>
                  <div className="font-bold">{supplier.name}</div>
                  <div className="text-xs text-slate-600 font-mono">
                    {supplier.code}
                  </div>
                </div>
                {!prefilledSupplier && (
                  <button
                    onClick={() => setSupplier(null)}
                    className="text-rose-600"
                    aria-label="إلغاء اختيار المورد"
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
                  placeholder="ابحث باسم المورد..."
                  value={supplierQ}
                  onChange={(e) => setSupplierQ(e.target.value)}
                  data-testid="supplier-pay-modal-supplier-search"
                />
                {supplierQ.length >= 2 && supplierSearch.length > 0 && (
                  <div className="mt-2 border border-slate-200 rounded-lg max-h-48 overflow-y-auto">
                    {supplierSearch.map((s) => (
                      <button
                        key={s.id}
                        className="w-full text-right px-3 py-2 hover:bg-slate-50 border-b border-slate-100 last:border-0"
                        onClick={() => {
                          setSupplier(s);
                          setSupplierQ('');
                        }}
                      >
                        <div className="font-bold">{s.name}</div>
                        <div className="text-xs text-slate-500">
                          {s.phone || '—'} · {s.code}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </Field>

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
                data-testid="supplier-pay-modal-method"
              >
                {visibleMethods.map((m) => (
                  <option key={m} value={m}>
                    {METHOD_LABEL_AR[m]}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {/* PR-FIN-PAYACCT-4C — Payment account picker for non-cash methods. */}
          {!isCash && (
            <PaymentAccountPicker
              method={method}
              providers={providers}
              accounts={accountsForMethod}
              selected={paymentAccountId}
              variant="light"
              blocked={blockedNoAccount}
              needsManualPick={needsManualPick}
              onSelect={(id) => setPaymentAccountId(id)}
              label="حساب الدفع"
            />
          )}

          <div className="grid md:grid-cols-2 gap-3">
            <Field label="المبلغ">
              <input
                type="number"
                step="0.01"
                className="input"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                data-testid="supplier-pay-modal-amount"
              />
            </Field>
            <Field label="المرجع (اختياري)">
              <input
                className="input"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="رقم إيصال"
              />
            </Field>
          </div>

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
              data-testid="supplier-pay-modal-submit"
            >
              <ArrowUpCircle size={18} /> حفظ الدفعة
            </button>
            <button
              className="btn-secondary"
              onClick={onClose}
              data-testid="supplier-pay-modal-cancel"
            >
              إلغاء
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
