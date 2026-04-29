/**
 * PaymentAccountModal — PR-FIN-PAYACCT-4B
 * ───────────────────────────────────────────────────────────────────
 *
 * Create / edit modal for `payment_accounts`. Used by the dedicated
 * admin page at `/payment-accounts`. Reuses the shared `<Modal>` /
 * `<Field>` primitives and the `<PaymentProviderLogo>` for the
 * provider preview chip.
 *
 * Method-specific labels (per the user spec):
 *   - bank_transfer: IBAN / رقم الحساب / SWIFT-like fields go into `identifier`
 *   - instapay: رقم الهاتف / handle
 *   - wallet / vodafone_cash / orange_cash: رقم المحفظة
 *   - card_visa / card_mastercard / card_meeza: terminal ID
 *   - check: رقم دفتر الشيكات / البنك
 *
 * Validation:
 *   - method, display_name, gl_account_code are required
 *   - cashbox_id (when set) must match the method group on the BE side
 *     (the validator throws with an Arabic message that the modal
 *     surfaces in `react-hot-toast`).
 */
import { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  paymentsApi,
  type PaymentAccount,
  type PaymentMethodCode,
  type PaymentProvider,
  METHOD_LABEL_AR,
} from '@/api/payments.api';
import { type Cashbox } from '@/api/cash-desk.api';
import { Modal, Field } from '@/components/cash-desk/Modal';
import { PaymentProviderLogo } from '@/components/payments/PaymentProviderLogo';

/**
 * Methods the admin can create accounts for. Cash + non-cash (incl.
 * cheque/check). 'credit'/'other' are intentionally excluded — they
 * do not map to a physical account.
 */
const ADMIN_METHODS: PaymentMethodCode[] = [
  'cash',
  'card_visa',
  'card_mastercard',
  'card_meeza',
  'instapay',
  'vodafone_cash',
  'orange_cash',
  'wallet',
  'bank_transfer',
  'check',
];

/**
 * Method group → cashbox.kind expected by the backend validator.
 * Mirror of `METHOD_TO_CASHBOX_KIND` in
 * `backend/src/payments/payments.service.ts`.
 */
const METHOD_TO_CASHBOX_KIND: Record<PaymentMethodCode, Cashbox['kind'] | null> = {
  cash: 'cash',
  card_visa: 'bank',
  card_mastercard: 'bank',
  card_meeza: 'bank',
  bank_transfer: 'bank',
  instapay: 'ewallet',
  wallet: 'ewallet',
  vodafone_cash: 'ewallet',
  orange_cash: 'ewallet',
  check: 'check',
  credit: null,
  other: null,
};

const DEFAULT_GL_FOR_METHOD: Record<PaymentMethodCode, string> = {
  cash: '1111',
  card_visa: '1113',
  card_mastercard: '1113',
  card_meeza: '1113',
  bank_transfer: '1113',
  instapay: '1114',
  wallet: '1114',
  vodafone_cash: '1114',
  orange_cash: '1114',
  check: '1115',
  credit: '1121',
  other: '1111',
};

/** Method-specific identifier label + placeholder. */
function identifierLabelFor(method: PaymentMethodCode): {
  label: string;
  placeholder: string;
} {
  switch (method) {
    case 'instapay':
      return { label: 'رقم الهاتف / Handle', placeholder: '0100xxxxxxx أو user@instapay' };
    case 'wallet':
    case 'vodafone_cash':
    case 'orange_cash':
      return { label: 'رقم المحفظة', placeholder: '0100xxxxxxx' };
    case 'card_visa':
    case 'card_mastercard':
    case 'card_meeza':
      return { label: 'Terminal ID', placeholder: 'TERM-001' };
    case 'bank_transfer':
      return { label: 'IBAN / رقم الحساب', placeholder: 'EG…' };
    case 'check':
      return { label: 'رقم دفتر الشيكات / البنك', placeholder: 'NBE — دفتر #123' };
    case 'cash':
      return { label: 'المعرف (اختياري)', placeholder: '' };
    default:
      return { label: 'المعرف', placeholder: '' };
  }
}

export interface PaymentAccountModalProps {
  /** Whether the modal is mounted in create mode (no existing row). */
  mode: 'create' | 'edit';
  /** Provided in edit mode. */
  account?: PaymentAccount | null;
  /** Pre-selected method when opening the modal from a quick-action button. */
  prefilledMethod?: PaymentMethodCode | null;
  providers: PaymentProvider[];
  cashboxes: Cashbox[];
  onClose: () => void;
  onSuccess?: () => void;
}

export function PaymentAccountModal({
  mode,
  account = null,
  prefilledMethod = null,
  providers,
  cashboxes,
  onClose,
  onSuccess,
}: PaymentAccountModalProps) {
  const qc = useQueryClient();
  const initialMethod: PaymentMethodCode =
    account?.method ?? prefilledMethod ?? 'cash';

  const [method, setMethod] = useState<PaymentMethodCode>(initialMethod);
  const [providerKey, setProviderKey] = useState<string>(
    account?.provider_key ?? '',
  );
  const [displayName, setDisplayName] = useState<string>(
    account?.display_name ?? '',
  );
  const [identifier, setIdentifier] = useState<string>(account?.identifier ?? '');
  const [glAccountCode, setGlAccountCode] = useState<string>(
    account?.gl_account_code ?? DEFAULT_GL_FOR_METHOD[initialMethod],
  );
  const [cashboxId, setCashboxId] = useState<string | null>(account?.cashbox_id ?? null);
  const [isDefault, setIsDefault] = useState<boolean>(
    account?.is_default ?? false,
  );
  const [active, setActive] = useState<boolean>(account?.active ?? true);
  const [sortOrder, setSortOrder] = useState<number>(account?.sort_order ?? 0);

  // When method changes (and we are not in edit mode for an existing
  // method), update the GL code default + provider list. In edit mode
  // we leave operator-customised values alone.
  useEffect(() => {
    if (mode !== 'create') return;
    setGlAccountCode(DEFAULT_GL_FOR_METHOD[method]);
    setProviderKey('');
    setCashboxId(null);
  }, [method, mode]);

  const providersForMethod = providers.filter((p) => p.method === method);
  const expectedKind = METHOD_TO_CASHBOX_KIND[method];
  const cashboxesForMethod = cashboxes.filter(
    (cb) => expectedKind === null || cb.kind === expectedKind,
  );

  const labels = identifierLabelFor(method);

  // pick the provider for the logo preview
  const previewProvider = providers.find((p) => p.provider_key === providerKey);

  const createMutation = useMutation({
    mutationFn: () =>
      paymentsApi.createAccount({
        method,
        provider_key: providerKey || undefined,
        display_name: displayName.trim(),
        identifier: identifier.trim() || undefined,
        gl_account_code: glAccountCode.trim(),
        is_default: isDefault,
        active,
        sort_order: sortOrder,
      } as any),
    onSuccess: () => {
      toast.success('تم إنشاء حساب الدفع');
      qc.invalidateQueries({ queryKey: ['payment-accounts'] });
      qc.invalidateQueries({ queryKey: ['payment-accounts-balances'] });
      onSuccess?.();
      onClose();
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.message || err?.message || 'فشل إنشاء الحساب';
      toast.error(typeof msg === 'string' ? msg : 'فشل إنشاء الحساب');
    },
  });

  const updateMutation = useMutation({
    mutationFn: () => {
      if (!account) throw new Error('no account');
      return paymentsApi.updateAccount(account.id, {
        provider_key: providerKey || null,
        display_name: displayName.trim(),
        identifier: identifier.trim() || null,
        gl_account_code: glAccountCode.trim(),
        sort_order: sortOrder,
      } as any);
    },
    onSuccess: () => {
      toast.success('تم تحديث حساب الدفع');
      qc.invalidateQueries({ queryKey: ['payment-accounts'] });
      qc.invalidateQueries({ queryKey: ['payment-accounts-balances'] });
      onSuccess?.();
      onClose();
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.message || err?.message || 'فشل التحديث';
      toast.error(typeof msg === 'string' ? msg : 'فشل التحديث');
    },
  });

  function submit() {
    if (!displayName.trim()) {
      toast.error('اسم الحساب مطلوب');
      return;
    }
    if (!glAccountCode.trim()) {
      toast.error('كود حساب الأستاذ مطلوب');
      return;
    }
    if (mode === 'create') {
      createMutation.mutate();
    } else {
      updateMutation.mutate();
    }
  }

  const submitting = createMutation.isPending || updateMutation.isPending;

  return (
    <div data-testid="payment-account-modal">
      <Modal
        title={mode === 'create' ? 'إضافة حساب دفع جديد' : `تعديل: ${account?.display_name ?? ''}`}
        onClose={onClose}
        size="lg"
      >
        <div className="space-y-4">
          {/* Method picker (locked in edit mode) */}
          <Field label="طريقة الدفع">
            <select
              className="input"
              value={method}
              onChange={(e) => setMethod(e.target.value as PaymentMethodCode)}
              disabled={mode === 'edit'}
              data-testid="payment-account-modal-method"
            >
              {ADMIN_METHODS.map((m) => (
                <option key={m} value={m}>
                  {METHOD_LABEL_AR[m]}
                </option>
              ))}
            </select>
            {mode === 'edit' && (
              <p className="mt-1 text-[11px] text-slate-500">
                لا يمكن تغيير طريقة الدفع بعد الإنشاء.
              </p>
            )}
          </Field>

          <div className="grid md:grid-cols-2 gap-3">
            {/* Provider — limited to providers for this method */}
            <Field label="المزود">
              <select
                className="input"
                value={providerKey}
                onChange={(e) => setProviderKey(e.target.value)}
                data-testid="payment-account-modal-provider"
              >
                <option value="">— اختر مزود —</option>
                {providersForMethod.map((p) => (
                  <option key={p.provider_key} value={p.provider_key}>
                    {p.name_ar}
                  </option>
                ))}
              </select>
            </Field>

            {/* Display name */}
            <Field label="اسم الحساب (الذي يظهر للموظف)">
              <input
                className="input"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="مثال: InstaPay الفرع الرئيسي"
                data-testid="payment-account-modal-display-name"
              />
            </Field>
          </div>

          <div className="grid md:grid-cols-2 gap-3">
            {/* Identifier (method-specific label) */}
            <Field label={labels.label}>
              <input
                className="input"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder={labels.placeholder}
                data-testid="payment-account-modal-identifier"
              />
            </Field>

            {/* GL account code */}
            <Field label="حساب الأستاذ (GL)">
              <input
                className="input font-mono text-sm"
                value={glAccountCode}
                onChange={(e) => setGlAccountCode(e.target.value)}
                placeholder="1114"
                data-testid="payment-account-modal-gl-code"
              />
              <p className="mt-1 text-[11px] text-slate-500">
                الافتراضي لطريقة "{METHOD_LABEL_AR[method]}":{' '}
                <span className="font-mono">{DEFAULT_GL_FOR_METHOD[method]}</span>
              </p>
            </Field>
          </div>

          {/* Optional cashbox pin (filtered by kind) */}
          <Field label="الخزنة المرتبطة (اختياري)">
            <select
              className="input"
              value={cashboxId ?? ''}
              onChange={(e) => setCashboxId(e.target.value || null)}
              data-testid="payment-account-modal-cashbox"
            >
              <option value="">— بدون ربط —</option>
              {cashboxesForMethod.map((cb) => (
                <option key={cb.id} value={cb.id}>
                  {cb.name_ar} ({cb.kind})
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-slate-500">
              ربط الحساب بخزنة محددة يفصل أرصدته عن الحسابات الأخرى التي تستخدم نفس كود حساب الأستاذ.
            </p>
          </Field>

          {/* Settings row */}
          <div className="grid md:grid-cols-3 gap-3">
            <Field label="افتراضي للطريقة">
              <label className="flex items-center gap-2 mt-1">
                <input
                  type="checkbox"
                  checked={isDefault}
                  onChange={(e) => setIsDefault(e.target.checked)}
                  data-testid="payment-account-modal-is-default"
                />
                <span className="text-sm">حساب افتراضي للطريقة</span>
              </label>
            </Field>
            <Field label="الحالة">
              <label className="flex items-center gap-2 mt-1">
                <input
                  type="checkbox"
                  checked={active}
                  onChange={(e) => setActive(e.target.checked)}
                  data-testid="payment-account-modal-active"
                />
                <span className="text-sm">مفعل</span>
              </label>
            </Field>
            <Field label="ترتيب">
              <input
                type="number"
                className="input"
                value={sortOrder}
                onChange={(e) => setSortOrder(Number(e.target.value) || 0)}
                data-testid="payment-account-modal-sort-order"
              />
            </Field>
          </div>

          {/* Logo preview */}
          {(providerKey || account?.metadata) && (
            <div className="flex items-center gap-3 p-3 rounded-lg bg-slate-50 border border-slate-200">
              <PaymentProviderLogo
                logoDataUrl={(account?.metadata as any)?.logo_data_url}
                logoKey={previewProvider?.logo_key}
                method={method}
                name={displayName || previewProvider?.name_ar || METHOD_LABEL_AR[method]}
                size="md"
                decorative
              />
              <div className="flex-1 min-w-0">
                <div className="font-bold text-sm truncate">
                  {displayName || previewProvider?.name_ar || 'حساب جديد'}
                </div>
                <div className="text-[11px] text-slate-500 truncate">
                  {METHOD_LABEL_AR[method]}
                  {identifier ? ` · ${identifier}` : ''}
                </div>
              </div>
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <button
              className="btn-primary flex-1"
              onClick={submit}
              disabled={submitting}
              data-testid="payment-account-modal-submit"
            >
              {mode === 'create' ? 'حفظ الحساب' : 'حفظ التعديلات'}
            </button>
            <button
              className="btn-secondary"
              onClick={onClose}
              disabled={submitting}
              data-testid="payment-account-modal-cancel"
            >
              إلغاء
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
