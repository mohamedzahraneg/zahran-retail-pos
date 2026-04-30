/**
 * PaymentAccountLogoManager — PR-FIN-PAYACCT-4D-UX-FIX-5
 * ───────────────────────────────────────────────────────────────────
 *
 * Restores per-payment-account logo/image management inside Settings →
 * "حسابات التحصيل". The treasury-unification work
 * (PR-FIN-PAYACCT-4D / PR-FIN-PAYACCT-4D-UX-FIX-4) reduced the tab to
 * a redirect card + quick-action deep-links and accidentally orphaned
 * the existing `LogoPicker` component (no consumers remained on
 * `main`). This component re-wires LogoPicker behind a per-row
 * "تغيير الصورة" modal, using the existing safe upload+sanitize flow.
 *
 * Strict reuse — does not introduce a parallel logo pipeline:
 *   • LogoPicker (drag-drop, raster-only PNG/JPG/WebP/GIF, 80KB cap,
 *     defense-in-depth data-URL-prefix re-validation).
 *   • PaymentProviderLogo (sink sanitizer: raster data URLs +
 *     Vite-bundled `/assets/...` only — rejects http(s), javascript:,
 *     data:image/svg+xml, data:text/html, blob:, protocol-relative).
 *   • paymentsApi.updateAccount(id, { metadata }) — same endpoint the
 *     unified treasury page uses.
 *
 * Backend metadata semantics: the PATCH replaces metadata wholesale
 * (see backend/src/payments/payments.service.ts → update()). To
 * preserve other keys (provider_key, identifier, gl_account_code,
 * cashbox_id are NOT in metadata; metadata is a free-form jsonb), we
 * spread the previous metadata and either set or delete `logo_data_url`
 * before sending. Other ad-hoc metadata keys remain intact.
 *
 * Cache invalidation on success: both `payment-accounts` (this view)
 * and `payment-accounts-balances` (the unified treasury page) are
 * invalidated so the change reflects everywhere without a reload.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  paymentsApi,
  type PaymentAccount,
  type PaymentProvider,
  type ProviderGroup,
  GROUP_LABEL_AR,
  METHOD_LABEL_AR,
  groupAccountsByProviderGroup,
} from '@/api/payments.api';
import { LogoPicker, type LogoPickerValue } from '@/components/payments/LogoPicker';
import { PaymentProviderLogo } from '@/components/payments/PaymentProviderLogo';

const GROUP_ORDER: ProviderGroup[] = ['cash', 'instapay', 'wallet', 'card', 'bank'];

function readLogoDataUrl(account: PaymentAccount): string | null {
  const raw = (account.metadata as Record<string, unknown> | null | undefined)?.logo_data_url;
  return typeof raw === 'string' && raw.trim() ? raw : null;
}

export function PaymentAccountLogoManager() {
  const qc = useQueryClient();
  const accountsQ = useQuery({
    queryKey: ['payment-accounts'],
    queryFn: () => paymentsApi.listAccounts(),
  });
  const providersQ = useQuery({
    queryKey: ['payment-providers'],
    queryFn: () => paymentsApi.listProviders(),
  });

  const [editing, setEditing] = useState<PaymentAccount | null>(null);

  const accounts = accountsQ.data ?? [];
  const providers = providersQ.data ?? [];
  const grouped = useMemo(
    () =>
      accounts.length && providers.length
        ? groupAccountsByProviderGroup(accounts, providers)
        : null,
    [accounts, providers],
  );

  const findProvider = (account: PaymentAccount): PaymentProvider | null =>
    providers.find((p) => p.provider_key === account.provider_key) ??
    providers.find((p) => p.method === account.method) ??
    null;

  const update = useMutation({
    mutationFn: async ({ id, metadata }: { id: string; metadata: Record<string, unknown> }) =>
      paymentsApi.updateAccount(id, { metadata }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payment-accounts'] });
      qc.invalidateQueries({ queryKey: ['payment-accounts-balances'] });
      toast.success('تم حفظ التغيير');
    },
    onError: (e: any) => toast.error(e?.response?.data?.message || 'فشل الحفظ'),
  });

  const handleRemove = (account: PaymentAccount) => {
    if (
      !window.confirm(
        `إزالة الصورة المخصصة لحساب "${account.display_name}"؟`,
      )
    )
      return;
    const next: Record<string, unknown> = { ...(account.metadata ?? {}) };
    delete next.logo_data_url;
    update.mutate({ id: account.id, metadata: next });
  };

  const isLoading = accountsQ.isLoading || providersQ.isLoading;

  return (
    <div
      className="rounded-2xl border border-slate-200 bg-white p-5"
      data-testid="payment-accounts-tab-logo-manager"
    >
      <div className="mb-4">
        <h3 className="font-bold text-slate-900">صور وشعارات وسائل الدفع</h3>
        <p className="text-xs text-slate-500 mt-1">
          ارفع شعاراً مخصصاً لكل حساب دفع. الصور تُحفظ محلياً (data URL)
          داخل بيانات الحساب وتظهر في كل أماكن العرض ومع نسخ الفواتير
          بدون الحاجة لإنترنت.
        </p>
      </div>

      {isLoading && (
        <div data-testid="logo-manager-loading" className="text-sm text-slate-500 py-4">
          جارِ التحميل...
        </div>
      )}

      {!isLoading && accounts.length === 0 && (
        <div data-testid="logo-manager-empty" className="text-sm text-slate-500 py-4">
          لا توجد حسابات دفع بعد. أضف حساباً من الإجراءات السريعة بالأعلى ثم
          عُد لإدارة الصور.
        </div>
      )}

      {!isLoading && grouped && accounts.length > 0 && (
        <div className="space-y-4">
          {GROUP_ORDER.map((group) => {
            const rows = grouped[group];
            if (!rows.length) return null;
            return (
              <div key={group} data-testid={`logo-manager-group-${group}`}>
                <div className="text-xs font-bold text-slate-600 mb-2">
                  {GROUP_LABEL_AR[group]}
                </div>
                <div className="space-y-2">
                  {rows.map((acc) => {
                    const provider = findProvider(acc);
                    const customLogo = readLogoDataUrl(acc);
                    return (
                      <div
                        key={acc.id}
                        data-testid={`logo-manager-row-${acc.id}`}
                        className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
                      >
                        <PaymentProviderLogo
                          logoDataUrl={customLogo}
                          logoKey={provider?.logo_key}
                          method={acc.method}
                          name={acc.display_name}
                          size="md"
                        />
                        <div className="flex-1 min-w-0">
                          <div
                            className="font-bold text-sm text-slate-800 truncate"
                            data-testid={`logo-manager-name-${acc.id}`}
                          >
                            {acc.display_name}
                          </div>
                          <div className="text-[11px] text-slate-500 truncate">
                            {METHOD_LABEL_AR[acc.method]}
                            {provider?.name_ar ? ` · ${provider.name_ar}` : ''}
                            {acc.identifier ? ` · ${acc.identifier}` : ''}
                            {!acc.active && ' · معطل'}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setEditing(acc)}
                          className="text-xs bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 rounded-lg px-3 py-1.5 font-semibold"
                          data-testid={`logo-manager-edit-${acc.id}`}
                        >
                          تغيير الصورة
                        </button>
                        {customLogo && (
                          <button
                            type="button"
                            onClick={() => handleRemove(acc)}
                            disabled={update.isPending}
                            className="text-xs text-rose-600 hover:bg-rose-50 rounded-lg px-3 py-1.5 font-semibold disabled:opacity-50"
                            data-testid={`logo-manager-remove-${acc.id}`}
                          >
                            إزالة الصورة
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <LogoEditModal
          account={editing}
          provider={findProvider(editing)}
          saving={update.isPending}
          onClose={() => setEditing(null)}
          onSave={(dataUrl) => {
            const next: Record<string, unknown> = {
              ...(editing.metadata ?? {}),
            };
            if (dataUrl) {
              next.logo_data_url = dataUrl;
            } else {
              delete next.logo_data_url;
            }
            update.mutate(
              { id: editing.id, metadata: next },
              { onSuccess: () => setEditing(null) },
            );
          }}
        />
      )}
    </div>
  );
}

function LogoEditModal({
  account,
  provider,
  saving,
  onClose,
  onSave,
}: {
  account: PaymentAccount;
  provider: PaymentProvider | null;
  saving: boolean;
  onClose: () => void;
  onSave: (dataUrl: string | null) => void;
}) {
  const initial = readLogoDataUrl(account);
  const [value, setValue] = useState<LogoPickerValue>({ dataUrl: initial });
  const dirty = (value.dataUrl ?? null) !== initial;

  return (
    <div
      className="fixed inset-0 bg-slate-900/50 z-50 flex items-center justify-center p-4"
      data-testid="logo-manager-modal"
    >
      <div className="bg-white rounded-2xl w-full max-w-md shadow-xl">
        <div className="flex items-center justify-between p-4 border-b border-slate-200">
          <h3
            className="font-bold text-slate-900"
            data-testid="logo-manager-modal-title"
          >
            تغيير صورة "{account.display_name}"
          </h3>
          <button
            onClick={onClose}
            disabled={saving}
            className="p-1 hover:bg-slate-100 rounded text-slate-500 disabled:opacity-50"
            aria-label="إغلاق"
          >
            ✕
          </button>
        </div>
        <div className="p-4 space-y-3">
          <LogoPicker
            value={value}
            onChange={setValue}
            fallbackLogoKey={provider?.logo_key ?? null}
            fallbackMethod={account.method}
            fallbackName={account.display_name}
          />
        </div>
        <div className="flex gap-2 p-4 border-t border-slate-200">
          <button
            onClick={onClose}
            disabled={saving}
            className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
            data-testid="logo-manager-modal-cancel"
          >
            إلغاء
          </button>
          <button
            onClick={() => onSave(value.dataUrl ?? null)}
            disabled={saving || !dirty}
            className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
            data-testid="logo-manager-modal-save"
          >
            {saving ? 'جاري الحفظ...' : 'حفظ'}
          </button>
        </div>
      </div>
    </div>
  );
}
