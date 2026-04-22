import { useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Shield,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Wallet,
  FileText,
  Receipt,
  CreditCard,
  Zap,
  Wrench,
  Database,
} from 'lucide-react';

import { accountsApi, CashboxAuditRow, InvoiceAuditRow } from '@/api/accounts.api';

const EGP = (n: number | string) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

/**
 * System-wide audit + one-click migration.
 *
 * The three layers that must agree:
 *   A) source docs (invoices / expenses / payments)
 *   B) cashbox_transactions + cashboxes.current_balance
 *   C) the journal (GL)
 *
 * This page surfaces every discrepancy and provides targeted fixes:
 *   - Recompute any cashbox balance from its transaction log
 *   - Post GL entries for legacy rows (backfill)
 *   - Hard rebuild: void all auto-entries, then re-run backfill
 */
export default function AccountsAudit() {
  const qc = useQueryClient();

  const { data: summary, refetch: refetchSummary } = useQuery({
    queryKey: ['audit-summary'],
    queryFn: () => accountsApi.auditSummary(),
    refetchInterval: 60_000,
  });
  const { data: migStatus, refetch: refetchMig } = useQuery({
    queryKey: ['migrations-status'],
    queryFn: () => accountsApi.migrationsStatus(),
  });
  const runMigrationsMut = useMutation({
    mutationFn: () => accountsApi.runMigrations(),
    onSuccess: (r) => {
      const parts: string[] = [];
      if (r.applied.length) parts.push(`تم تطبيق ${r.applied.length}`);
      if (r.failed.length) parts.push(`فشل ${r.failed.length}`);
      if (r.already.length) parts.push(`مُطبَّق مسبقاً ${r.already.length}`);
      if (r.failed.length > 0) {
        toast.error(
          `الهجرات: ${parts.join(' · ')}\nأول خطأ: ${r.failed[0].error}`,
          { duration: 10000 },
        );
      } else {
        toast.success(`الهجرات: ${parts.join(' · ')}`, { duration: 6000 });
      }
      refetchMig();
      refetchSummary();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل التشغيل'),
  });
  const { data: cashboxes = [] } = useQuery({
    queryKey: ['audit-cashboxes'],
    queryFn: () => accountsApi.auditCashboxes(),
  });
  const { data: invoices = [] } = useQuery({
    queryKey: ['audit-invoices'],
    queryFn: () => accountsApi.auditInvoices(30),
  });
  const { data: expenses = [] } = useQuery({
    queryKey: ['audit-expenses'],
    queryFn: () => accountsApi.auditExpenses(30),
  });
  const { data: payments } = useQuery({
    queryKey: ['audit-payments'],
    queryFn: () => accountsApi.auditPayments(30),
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['audit-summary'] });
    qc.invalidateQueries({ queryKey: ['audit-cashboxes'] });
    qc.invalidateQueries({ queryKey: ['audit-invoices'] });
    qc.invalidateQueries({ queryKey: ['audit-expenses'] });
    qc.invalidateQueries({ queryKey: ['audit-payments'] });
    qc.invalidateQueries({ queryKey: ['cashboxes'] });
    qc.invalidateQueries({ queryKey: ['journal'] });
    qc.invalidateQueries({ queryKey: ['trial-balance'] });
    qc.invalidateQueries({ queryKey: ['cashflow-today'] });
  };

  // Fix actions
  const recomputeOne = useMutation({
    mutationFn: (id: string) => accountsApi.recomputeCashbox(id),
    onSuccess: (r) => {
      toast.success(`تم الحساب الجديد: ${EGP(r.new_balance)}`);
      invalidateAll();
    },
  });
  const recomputeAll = useMutation({
    mutationFn: () => accountsApi.recomputeAllCashboxes(),
    onSuccess: (r) => {
      toast.success(`تم إعادة حساب ${r.updated} خزنة`);
      invalidateAll();
    },
  });
  const backfillMut = useMutation({
    mutationFn: () => accountsApi.backfill({}),
    onSuccess: (r: any) => {
      const line = Object.entries(r || {})
        .map(([k, v]: any) => `${k}: ${v.posted}/${v.found}`)
        .join(' · ');
      toast.success(`الترحيل: ${line}`);
      invalidateAll();
    },
  });
  const resetMut = useMutation({
    mutationFn: () => accountsApi.resetAutoEntries(),
    onSuccess: (r) => {
      toast.success(`تم إلغاء ${r.voided} قيد تلقائي`);
      invalidateAll();
    },
  });
  const forcePostMut = useMutation({
    mutationFn: () => accountsApi.forcePostExpenses(),
    onSuccess: (r) => {
      if (r.failed > 0) {
        const first = r.results.find((x) => x.status === 'failed');
        toast(
          `ترحيل المصروفات: ${r.posted} نجح · ${r.failed} فشل · ${r.skipped} تم تجاهله${
            first ? `\nأول سبب فشل: ${first.reason}` : ''
          }`,
          { icon: '⚠', duration: 10000 },
        );
      } else {
        toast.success(
          `تم ترحيل ${r.posted} مصروف إلى دفتر الأستاذ`,
          { duration: 6000 },
        );
      }
      invalidateAll();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الترحيل'),
  });

  const purgeMut = useMutation({
    mutationFn: () => accountsApi.purgeCancelled(),
    onSuccess: (r) => {
      toast.success(
        `تم حذف ${r.invoices_deleted} فاتورة ملغاة · ${r.journal_entries_deleted} قيد · ${r.cashbox_txns_deleted} حركة خزنة`,
        { duration: 6000 },
      );
      invalidateAll();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الحذف'),
  });

  const fullRebuild = async () => {
    if (
      !confirm(
        '⚠ إعادة بناء كاملة:\n\n١. حذف نهائي للفواتير الملغاة + قيودها\n٢. إلغاء كل القيود التلقائية الحالية\n٣. ترحيلها من جديد من المصادر الأصلية\n٤. إعادة حساب كل أرصدة الخزائن\n\nالفواتير النشطة والمصروفات لا تُحذف — فقط الملغاة. متابعة؟',
      )
    )
      return;
    try {
      await purgeMut.mutateAsync();
      await resetMut.mutateAsync();
      await backfillMut.mutateAsync();
      await recomputeAll.mutateAsync();
      await refetchSummary();
      toast.success('تمت إعادة البناء بنجاح ✓', { duration: 6000 });
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'فشل جزء من العملية');
    }
  };

  const cashboxesWithDrift = cashboxes.filter((c) => {
    const d = Math.abs(
      Number(c.stored_balance) - Number(c.computed_balance),
    );
    const g = Math.abs(
      Number(c.computed_balance) - Number(c.gl_balance),
    );
    return d > 0.01 || g > 0.01;
  });

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-black text-slate-800 flex items-center gap-2">
          <Shield className="text-brand-600" /> مراجعة وتدقيق الحسابات
        </h2>
        <p className="text-sm text-slate-500 mt-1">
          اكتشاف أي انحراف بين <b>الخزائن · المصادر · دفتر الأستاذ</b>،
          وأدوات لإصلاحه بضغطة زر
        </p>
      </div>

      {/* Migrations — highest priority if any are pending */}
      {migStatus && (
        <div
          className={`card p-4 border-2 ${
            migStatus.pending.length > 0
              ? 'border-rose-300 bg-rose-50'
              : 'border-emerald-200 bg-emerald-50/50'
          }`}
        >
          <div className="flex items-start gap-3">
            <Database
              size={20}
              className={
                migStatus.pending.length > 0
                  ? 'text-rose-600'
                  : 'text-emerald-600'
              }
            />
            <div className="flex-1">
              <div className="font-black text-slate-800">
                هجرات قاعدة البيانات
              </div>
              <div className="text-xs text-slate-600 mt-1">
                إجمالي الملفات: {migStatus.total_files} · مطبّق:{' '}
                {migStatus.applied.length} · <b>معلّق:{' '}
                {migStatus.pending.length}</b>
              </div>
              {migStatus.pending.length > 0 && (
                <>
                  <div className="mt-2 text-xs text-rose-700 font-bold">
                    ⚠ التالي معلّق ولا بد من تشغيله لتعمل الصفحات الجديدة:
                  </div>
                  <ul className="mt-1 text-xs text-slate-600 font-mono max-h-32 overflow-auto">
                    {migStatus.pending.map((p) => (
                      <li key={p}>• {p}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
            <button
              className={
                migStatus.pending.length > 0
                  ? 'btn-primary bg-rose-600 hover:bg-rose-700'
                  : 'btn-secondary'
              }
              disabled={runMigrationsMut.isPending}
              onClick={() => runMigrationsMut.mutate()}
            >
              {runMigrationsMut.isPending ? (
                <>
                  <RefreshCw size={14} className="animate-spin" /> جارٍ
                  التشغيل...
                </>
              ) : (
                <>
                  <Database size={14} /> تشغيل الهجرات الآن
                </>
              )}
            </button>
          </div>
          {runMigrationsMut.data && (
            <div className="mt-3 pt-3 border-t border-slate-200 text-xs space-y-1">
              {runMigrationsMut.data.applied.length > 0 && (
                <div className="text-emerald-700">
                  ✓ تم تطبيق: {runMigrationsMut.data.applied.join(', ')}
                </div>
              )}
              {runMigrationsMut.data.failed.length > 0 && (
                <div className="text-rose-700">
                  ✗ فشل:
                  {runMigrationsMut.data.failed.map((f) => (
                    <div key={f.file} className="mr-3">
                      <span className="font-mono">{f.file}</span>: {f.error}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Summary KPIs */}
      <div className="grid md:grid-cols-4 gap-3">
        <AuditKpi
          label="انحراف الخزائن"
          value={summary?.cashboxes.txn_mismatch ?? 0}
          total={summary?.cashboxes.total ?? 0}
          detail={`أكبر فرق: ${EGP(summary?.cashboxes.max_txn_drift || 0)}`}
          icon={<Wallet size={16} />}
          severity={summary?.cashboxes.txn_mismatch ? 'warning' : 'ok'}
        />
        <AuditKpi
          label="فواتير بدون قيد GL"
          value={summary?.invoices.missing_count ?? 0}
          detail={`قيمة: ${EGP(summary?.invoices.missing_value || 0)}`}
          icon={<FileText size={16} />}
          severity={summary?.invoices.missing_count ? 'critical' : 'ok'}
        />
        <AuditKpi
          label="مصروفات بدون قيد GL"
          value={summary?.expenses.missing_count ?? 0}
          detail={`قيمة: ${EGP(summary?.expenses.missing_value || 0)}`}
          icon={<Receipt size={16} />}
          severity={summary?.expenses.missing_count ? 'critical' : 'ok'}
        />
        <AuditKpi
          label="مدفوعات بدون قيد GL"
          value={summary?.payments.missing_count ?? 0}
          icon={<CreditCard size={16} />}
          severity={summary?.payments.missing_count ? 'critical' : 'ok'}
        />
      </div>

      {/* Main actions */}
      <div className="card p-4 border-2 border-indigo-200 bg-indigo-50/50">
        <div className="flex items-center gap-2 mb-3 font-black">
          <Wrench size={18} className="text-indigo-600" /> إجراءات الإصلاح
        </div>
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-3">
          <ActionCard
            title="١. ترحيل تلقائي للقديم"
            detail="يقرأ الفواتير والمصروفات والدفعات والورديات والمرتجعات والمشتريات من المصادر الأصلية وينشئ لها قيود GL (يتجاهل اللي موجود بالفعل)"
            color="emerald"
            onClick={() => backfillMut.mutate()}
            loading={backfillMut.isPending}
            icon={<Zap size={14} />}
            label="تشغيل الترحيل"
          />
          <ActionCard
            title="٢. إعادة حساب أرصدة الخزائن"
            detail="يأخذ مجموع الحركات (داخل − خارج) من cashbox_transactions ويكتبه في current_balance. يصلح أي خزنة رصيدها المخزّن مختلف عن الحقيقي"
            color="amber"
            onClick={() => recomputeAll.mutate()}
            loading={recomputeAll.isPending}
            icon={<RefreshCw size={14} />}
            label="إعادة الحساب"
          />
          <ActionCard
            title="٣. حذف الفواتير الملغاة"
            detail="يحذف نهائياً كل الفواتير التي حالتها cancelled + قيودها المحاسبية + حركات خزنتها. الفواتير النشطة لا تُمس. مفيد لتنظيف بيانات قديمة تشوّش الأرقام"
            color="amber"
            onClick={() => {
              if (
                confirm(
                  'هل أنت متأكد من حذف كل الفواتير الملغاة + قيودها نهائياً؟\n\nالفواتير النشطة والمصروفات والدفعات لن تُمس.',
                )
              )
                purgeMut.mutate();
            }}
            loading={purgeMut.isPending}
            icon={<Wrench size={14} />}
            label="تنظيف الملغاة"
          />
          <ActionCard
            title="٤. إعادة بناء كاملة ⚠"
            detail="ينفذ الخطوات ١+٢+٣ بالترتيب الصحيح: يحذف الملغاة → يعيد ترحيل الباقي → يعيد حساب الأرصدة. الحل الشامل لأي انحراف"
            color="rose"
            onClick={fullRebuild}
            loading={
              resetMut.isPending ||
              backfillMut.isPending ||
              recomputeAll.isPending ||
              purgeMut.isPending
            }
            icon={<Wrench size={14} />}
            label="إعادة بناء كامل"
          />
        </div>
      </div>

      {/* Cashboxes table */}
      <Section
        title="الخزائن"
        icon={<Wallet size={16} />}
        empty={cashboxes.length === 0 ? 'لا توجد خزائن' : null}
      >
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs font-bold text-slate-600">
            <tr>
              <th className="text-right px-3 py-2">الخزنة</th>
              <th className="text-right px-3 py-2">الرصيد المخزّن</th>
              <th className="text-right px-3 py-2">من الحركات</th>
              <th className="text-right px-3 py-2">من الـ GL</th>
              <th className="text-right px-3 py-2">الحالة</th>
              <th className="w-32"></th>
            </tr>
          </thead>
          <tbody>
            {cashboxes.map((c) => {
              const drift =
                Number(c.stored_balance) - Number(c.computed_balance);
              const glDrift =
                Number(c.computed_balance) - Number(c.gl_balance);
              const ok = Math.abs(drift) < 0.01 && Math.abs(glDrift) < 0.01;
              return (
                <tr
                  key={c.id}
                  className={`border-t border-slate-100 ${
                    ok ? '' : 'bg-amber-50/40'
                  }`}
                >
                  <td className="px-3 py-2">
                    <div className="font-bold">{c.name_ar}</div>
                    <div className="text-[10px] text-slate-400">
                      {c.kind} · {c.currency} ·{' '}
                      {c.gl_account_code
                        ? `GL ${c.gl_account_code}`
                        : 'بدون حساب GL'}
                    </div>
                  </td>
                  <td className="px-3 py-2 font-mono">
                    {EGP(c.stored_balance)}
                  </td>
                  <td className="px-3 py-2 font-mono">
                    {EGP(c.computed_balance)}
                    {Math.abs(drift) >= 0.01 && (
                      <div className="text-[10px] text-rose-600 font-bold">
                        فرق {drift > 0 ? '+' : ''}
                        {EGP(drift)}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono">
                    {EGP(c.gl_balance)}
                    {Math.abs(glDrift) >= 0.01 && (
                      <div className="text-[10px] text-rose-600 font-bold">
                        فرق {glDrift > 0 ? '+' : ''}
                        {EGP(glDrift)}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {ok ? (
                      <span className="chip bg-emerald-100 text-emerald-700">
                        <CheckCircle2 size={12} /> متطابق
                      </span>
                    ) : (
                      <span className="chip bg-amber-100 text-amber-700">
                        <AlertTriangle size={12} /> فيه فرق
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {!ok && (
                      <button
                        onClick={() => recomputeOne.mutate(c.id)}
                        className="btn-secondary text-xs py-1"
                        disabled={recomputeOne.isPending}
                      >
                        إعادة حساب
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {cashboxesWithDrift.length === 0 && (
          <div className="p-3 bg-emerald-50 border-t border-emerald-200 text-sm text-emerald-800 flex items-center gap-2">
            <CheckCircle2 size={14} /> جميع الخزائن متطابقة
          </div>
        )}
      </Section>

      {/* Invoices missing GL */}
      <Section
        title={`فواتير بدون قيد GL (${invoices.length})`}
        icon={<FileText size={16} />}
        empty={
          invoices.length === 0 ? 'كل الفواتير مُرحّلة للـ GL صحيحاً' : null
        }
      >
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs font-bold text-slate-600">
            <tr>
              <th className="text-right px-3 py-2">رقم الفاتورة</th>
              <th className="text-right px-3 py-2">التاريخ</th>
              <th className="text-right px-3 py-2">الحالة</th>
              <th className="text-right px-3 py-2">الإجمالي</th>
              <th className="text-right px-3 py-2">مُرحّل للمدين</th>
              <th className="text-right px-3 py-2">الفرق</th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((i: InvoiceAuditRow) => (
              <tr key={i.id} className="border-t border-slate-100">
                <td className="px-3 py-2 font-mono font-bold text-brand-700">
                  {i.invoice_no}
                </td>
                <td className="px-3 py-2 text-xs">
                  {new Date(
                    i.completed_at || i.created_at,
                  ).toLocaleDateString('en-GB')}
                </td>
                <td className="px-3 py-2 text-xs">{i.status}</td>
                <td className="px-3 py-2 font-mono">{EGP(i.grand_total)}</td>
                <td className="px-3 py-2 font-mono">{EGP(i.posted_debit)}</td>
                <td className="px-3 py-2 font-mono text-rose-700 font-bold">
                  {EGP(i.drift)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* Expenses missing GL */}
      {expenses.length > 0 && (
        <div className="flex items-center justify-end">
          <button
            className="btn-primary bg-emerald-600 hover:bg-emerald-700"
            onClick={() => {
              if (
                confirm(
                  `ترحيل قسري لـ ${expenses.length} مصروف إلى دفتر الأستاذ؟\n\nالنظام سيحاول ترحيل كل مصروف معتمد بدون GL، ويعرض أي فشل مع سببه.`,
                )
              ) {
                forcePostMut.mutate();
              }
            }}
            disabled={forcePostMut.isPending}
          >
            <Zap size={14} />{' '}
            {forcePostMut.isPending
              ? 'جارٍ الترحيل...'
              : `ترحيل كل المصروفات (${expenses.length})`}
          </button>
        </div>
      )}
      <Section
        title={`مصروفات بدون قيد (${expenses.length})`}
        icon={<Receipt size={16} />}
        empty={
          expenses.length === 0 ? 'كل المصروفات المعتمدة مُرحّلة' : null
        }
      >
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs font-bold text-slate-600">
            <tr>
              <th className="text-right px-3 py-2">رقم المصروف</th>
              <th className="text-right px-3 py-2">التاريخ</th>
              <th className="text-right px-3 py-2">المبلغ</th>
              <th className="text-right px-3 py-2">الحالة</th>
            </tr>
          </thead>
          <tbody>
            {expenses.map((e: any) => (
              <tr key={e.id} className="border-t border-slate-100">
                <td className="px-3 py-2 font-mono font-bold">
                  {e.expense_no}
                </td>
                <td className="px-3 py-2 text-xs">{e.expense_date}</td>
                <td className="px-3 py-2 font-mono">{EGP(e.amount)}</td>
                <td className="px-3 py-2 text-xs text-rose-600">
                  معتمد بدون قيد GL
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* Payments missing GL */}
      <Section
        title={`مقبوضات/مدفوعات بدون قيد (${
          (payments?.customer.length || 0) + (payments?.supplier.length || 0)
        })`}
        icon={<CreditCard size={16} />}
        empty={
          (payments?.customer.length || 0) +
            (payments?.supplier.length || 0) ===
          0
            ? 'كل الدفعات مُرحّلة'
            : null
        }
      >
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs font-bold text-slate-600">
            <tr>
              <th className="text-right px-3 py-2">النوع</th>
              <th className="text-right px-3 py-2">رقم السند</th>
              <th className="text-right px-3 py-2">التاريخ</th>
              <th className="text-right px-3 py-2">المبلغ</th>
            </tr>
          </thead>
          <tbody>
            {(payments?.customer || []).map((p: any) => (
              <tr key={`c-${p.id}`} className="border-t border-slate-100">
                <td className="px-3 py-2">
                  <span className="chip bg-emerald-100 text-emerald-700">
                    مقبوضة
                  </span>
                </td>
                <td className="px-3 py-2 font-mono font-bold">
                  {p.payment_no}
                </td>
                <td className="px-3 py-2 text-xs">
                  {new Date(p.created_at).toLocaleDateString('en-GB')}
                </td>
                <td className="px-3 py-2 font-mono">{EGP(p.amount)}</td>
              </tr>
            ))}
            {(payments?.supplier || []).map((p: any) => (
              <tr key={`s-${p.id}`} className="border-t border-slate-100">
                <td className="px-3 py-2">
                  <span className="chip bg-rose-100 text-rose-700">
                    مدفوعة
                  </span>
                </td>
                <td className="px-3 py-2 font-mono font-bold">
                  {p.payment_no}
                </td>
                <td className="px-3 py-2 text-xs">
                  {new Date(p.created_at).toLocaleDateString('en-GB')}
                </td>
                <td className="px-3 py-2 font-mono">{EGP(p.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </div>
  );
}

function AuditKpi({
  label,
  value,
  detail,
  icon,
  severity,
  total,
}: {
  label: string;
  value: number;
  detail?: string;
  icon: React.ReactNode;
  severity: 'ok' | 'warning' | 'critical';
  total?: number;
}) {
  const cls: Record<string, string> = {
    ok: 'bg-emerald-50 border-emerald-200 text-emerald-800',
    warning: 'bg-amber-50 border-amber-200 text-amber-800',
    critical: 'bg-rose-50 border-rose-200 text-rose-800',
  };
  return (
    <div className={`card p-3 border-2 ${cls[severity]}`}>
      <div className="flex items-center gap-1 text-xs font-bold opacity-80">
        {icon} {label}
      </div>
      <div className="font-black text-2xl mt-1">
        {value}
        {total !== undefined && (
          <span className="text-sm text-slate-500"> / {total}</span>
        )}
      </div>
      {detail && <div className="text-[10px] opacity-70 mt-0.5">{detail}</div>}
    </div>
  );
}

function ActionCard({
  title,
  detail,
  color,
  onClick,
  loading,
  icon,
  label,
}: {
  title: string;
  detail: string;
  color: 'emerald' | 'amber' | 'rose';
  onClick: () => void;
  loading: boolean;
  icon: React.ReactNode;
  label: string;
}) {
  const cls: Record<string, string> = {
    emerald: 'bg-emerald-600 hover:bg-emerald-700',
    amber: 'bg-amber-600 hover:bg-amber-700',
    rose: 'bg-rose-600 hover:bg-rose-700',
  };
  return (
    <div className="bg-white rounded-lg border border-slate-200 p-3">
      <div className="font-black text-sm mb-1">{title}</div>
      <div className="text-xs text-slate-600 mb-3 leading-relaxed">
        {detail}
      </div>
      <button
        className={`w-full py-2 rounded text-white font-bold text-sm flex items-center justify-center gap-1 disabled:opacity-50 ${cls[color]}`}
        onClick={onClick}
        disabled={loading}
      >
        {loading ? (
          <RefreshCw size={14} className="animate-spin" />
        ) : (
          icon
        )}{' '}
        {label}
      </button>
    </div>
  );
}

function Section({
  title,
  icon,
  empty,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  empty: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="card p-0 overflow-hidden border border-slate-200">
      <div className="p-3 border-b border-slate-100 flex items-center gap-2 text-sm font-bold text-slate-700">
        {icon} {title}
      </div>
      {empty ? (
        <div className="p-6 text-center text-emerald-700 bg-emerald-50 text-sm flex items-center justify-center gap-2">
          <CheckCircle2 size={14} /> {empty}
        </div>
      ) : (
        <div className="overflow-x-auto">{children}</div>
      )}
    </div>
  );
}
