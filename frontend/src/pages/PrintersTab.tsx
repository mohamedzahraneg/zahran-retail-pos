/**
 * PrintersTab — admin UI for the Phase-1 direct-print system.
 *
 *   · CRUD for printer profiles (kept in localStorage, per device).
 *   · Defaults map: which printer to use for each document type.
 *   · Bridge status indicator (probes /health every few seconds).
 *   · Test print button — fires a no-op job through the router so
 *     the user sees the "bridge → success" or "bridge → fallback"
 *     path without producing real ink.
 *
 * No backend.  No API.  No DB.  Phase 2 (the Android Print Bridge)
 * consumes the same profiles via the bridge protocol — no UI change
 * is needed when the APK ships.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Printer as PrinterIcon,
  Plus,
  Trash2,
  Bluetooth,
  Wifi,
  Globe,
  Smartphone,
  CheckCircle2,
  XCircle,
  RefreshCw,
} from 'lucide-react';
import toast from 'react-hot-toast';
import {
  deletePrinter,
  getBridgeConfig,
  getDefaults,
  listPrinters,
  setBridgeConfig,
  setDefaultPrinter,
  upsertPrinter,
  DEFAULT_BRIDGE_URL,
} from '@/lib/printers/store';
import { probeBridge } from '@/lib/printers/bridge';
import { routePrintJob } from '@/lib/printers/router';
import type {
  ConnectionKind,
  DocumentType,
  PaperSize,
  Printer,
  PrinterType,
} from '@/lib/printers/types';

// ─── Static metadata (labels for the UI) ──────────────────────────

const DOC_TYPES: { key: DocumentType; label: string }[] = [
  { key: 'invoice', label: 'فاتورة' },
  { key: 'return', label: 'مرتجع' },
  { key: 'exchange', label: 'استبدال' },
  { key: 'expense', label: 'مصروف' },
  { key: 'shift_close', label: 'إغلاق الوردية' },
  { key: 'general_report', label: 'تقارير عامة' },
  { key: 'voucher', label: 'سند قبض/صرف' },
  { key: 'reservation', label: 'حجز' },
];

const PRINTER_TYPE_LABELS: Record<PrinterType, string> = {
  thermal_escpos: 'حراري ESC/POS (80/58 مم)',
  android_system: 'طابعة نظام Android (A4/A5)',
  network_ip: 'طابعة شبكة (IP)',
  browser: 'طباعة عبر المتصفح',
};

const PAPER_LABELS: Record<PaperSize, string> = {
  '80mm': '80 مم',
  '58mm': '58 مم',
  A4: 'A4',
  A5: 'A5',
};

const CONNECTION_LABELS: Record<ConnectionKind, string> = {
  bluetooth: 'Bluetooth',
  network: 'شبكة',
  system: 'نظام Android',
  browser: 'متصفح',
};

const CONNECTION_ICON: Record<
  ConnectionKind,
  typeof Bluetooth
> = {
  bluetooth: Bluetooth,
  network: Wifi,
  system: Smartphone,
  browser: Globe,
};

// ─── Helpers ──────────────────────────────────────────────────────

function blankPrinter(): Printer {
  return {
    printer_id:
      typeof crypto !== 'undefined' && (crypto as any).randomUUID
        ? (crypto as any).randomUUID()
        : 'p_' + Math.random().toString(16).slice(2, 10),
    name: '',
    type: 'thermal_escpos',
    paper: '80mm',
    connection: 'bluetooth',
    bluetooth_name: '',
    bluetooth_mac: '',
    ip_host: '',
    ip_port: 9100,
    enabled: true,
    created_at: new Date().toISOString(),
    last_error: null,
  };
}

// ─── Component ────────────────────────────────────────────────────

export function PrintersTab() {
  const [printers, setPrinters] = useState<Printer[]>(() => listPrinters());
  const [defaults, setDefaults] = useState(() => getDefaults());
  const [bridgeUrl, setBridgeUrl] = useState(
    () => getBridgeConfig().base_url,
  );
  const [bridgeStatus, setBridgeStatus] = useState<
    'unknown' | 'online' | 'offline'
  >('unknown');
  const [editing, setEditing] = useState<Printer | null>(null);

  // Refresh from storage (after CRUD).
  const reload = () => {
    setPrinters(listPrinters());
    setDefaults(getDefaults());
  };

  // Probe the bridge — initial + every 8s.  All failures map to
  // "offline" so the UI never shows a stale "online".
  const refreshBridge = async () => {
    setBridgeStatus('unknown');
    const r = await probeBridge();
    setBridgeStatus(r.ok ? 'online' : 'offline');
  };
  useEffect(() => {
    void refreshBridge();
    const t = setInterval(() => void refreshBridge(), 8000);
    return () => clearInterval(t);
  }, []);

  const handleSave = (p: Printer) => {
    if (!p.name.trim()) {
      toast.error('اسم الطابعة مطلوب');
      return;
    }
    upsertPrinter(p);
    setEditing(null);
    reload();
    toast.success('تم حفظ الطابعة');
  };

  const handleDelete = (p: Printer) => {
    if (!confirm(`حذف الطابعة "${p.name}"؟`)) return;
    deletePrinter(p.printer_id);
    reload();
    toast.success('تم الحذف');
  };

  const handleSetDefault = (
    documentType: DocumentType,
    printerId: string,
  ) => {
    setDefaultPrinter(documentType, printerId || null);
    setDefaults(getDefaults());
  };

  const handleSaveBridgeUrl = () => {
    const trimmed = bridgeUrl.trim() || DEFAULT_BRIDGE_URL;
    setBridgeConfig({ base_url: trimmed });
    setBridgeUrl(trimmed);
    toast.success('تم حفظ عنوان جسر الطباعة');
    void refreshBridge();
  };

  const handleTestPrint = async (p: Printer) => {
    const r = await routePrintJob({
      document_type: 'general_report',
      document_id: 'TEST-' + p.printer_id.slice(0, 8),
      copies: 1,
      buildPayload: () => ({
        kind: 'escpos_html',
        html: `<div style="text-align:center;font-family:Cairo;"><h2>اختبار طباعة</h2><p>${p.name}</p><p>${new Date().toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' })}</p></div>`,
        width_mm: 80,
      }),
      onBrowserFallback: () => {
        // Browser fallback for the test: mount a tiny iframe with
        // the same HTML.  We don't reuse the live print helpers
        // here because the test should never actually print on a
        // real document — this is a smoke check.
        const html = `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><style>@page{size:80mm auto;margin:5mm}body{font-family:Cairo,sans-serif;text-align:center;padding:8mm}</style></head><body><h2>اختبار طباعة</h2><p>${p.name}</p><p>${new Date().toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' })}</p></body></html>`;
        const f = document.createElement('iframe');
        f.style.position = 'fixed';
        f.style.right = '0';
        f.style.bottom = '0';
        f.style.width = '0';
        f.style.height = '0';
        f.style.border = '0';
        document.body.appendChild(f);
        const doc = f.contentDocument!;
        doc.open();
        doc.write(html);
        doc.close();
        setTimeout(() => {
          f.contentWindow?.focus();
          f.contentWindow?.print();
          setTimeout(() => f.remove(), 500);
        }, 150);
      },
      printerOverride: p,
    });
    if (r.route === 'bridge') {
      toast.success('تم إرسال الاختبار إلى جسر الطباعة');
    } else if (r.route === 'browser_fallback') {
      const reasons: Record<string, string> = {
        no_printer_configured: 'لم يتم تحديد طابعة',
        printer_disabled: 'الطابعة معطلة',
        browser_printer_explicit: 'تم اختيار طباعة عبر المتصفح',
        bridge_unreachable: 'تطبيق الطباعة غير متصل — تم استخدام المتصفح',
        bridge_error: 'فشل جسر الطباعة — تم استخدام المتصفح',
      };
      toast(reasons[r.reason] || 'استخدام طباعة المتصفح', { icon: 'ℹ️' });
    } else {
      toast.error('فشل الاختبار');
    }
    reload();
  };

  // ── Render ──────────────────────────────────────────────────────

  return (
    <div className="space-y-6" dir="rtl">
      {/* Bridge status panel */}
      <BridgeStatusPanel
        url={bridgeUrl}
        status={bridgeStatus}
        onUrlChange={setBridgeUrl}
        onSaveUrl={handleSaveBridgeUrl}
        onRefresh={refreshBridge}
      />

      {/* Printer list */}
      <div className="bg-white rounded-xl border border-slate-200">
        <div className="flex items-center justify-between p-3 border-b border-slate-200">
          <h3 className="font-bold text-slate-800 flex items-center gap-2">
            <PrinterIcon className="w-4 h-4" /> الطابعات
            <span className="text-xs text-slate-500">
              ({printers.length})
            </span>
          </h3>
          <button
            type="button"
            onClick={() => setEditing(blankPrinter())}
            className="text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 px-3 py-1.5 rounded-lg flex items-center gap-1.5"
            data-testid="printers-add"
          >
            <Plus className="w-4 h-4" /> إضافة طابعة
          </button>
        </div>

        {printers.length === 0 ? (
          <div
            className="p-8 text-center text-slate-500 text-sm"
            data-testid="printers-empty"
          >
            لا توجد طابعات مُضافة بعد. اضغط "إضافة طابعة" لإنشاء أول
            ملف تعريف.
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {printers.map((p) => (
              <PrinterRow
                key={p.printer_id}
                printer={p}
                isDefaultFor={Object.entries(defaults)
                  .filter(([, id]) => id === p.printer_id)
                  .map(([dt]) => dt as DocumentType)}
                onEdit={() => setEditing(p)}
                onDelete={() => handleDelete(p)}
                onTestPrint={() => handleTestPrint(p)}
              />
            ))}
          </ul>
        )}
      </div>

      {/* Defaults map */}
      <DefaultsTable
        printers={printers}
        defaults={defaults}
        onSetDefault={handleSetDefault}
      />

      {/* Editor modal */}
      {editing && (
        <PrinterEditor
          initial={editing}
          onCancel={() => setEditing(null)}
          onSave={handleSave}
        />
      )}
    </div>
  );
}

// ─── Bridge status panel ──────────────────────────────────────────

function BridgeStatusPanel(props: {
  url: string;
  status: 'unknown' | 'online' | 'offline';
  onUrlChange: (s: string) => void;
  onSaveUrl: () => void;
  onRefresh: () => void;
}) {
  const isOnline = props.status === 'online';
  const StatusIcon = isOnline ? CheckCircle2 : XCircle;
  const statusColor = isOnline
    ? 'text-emerald-600 bg-emerald-50 border-emerald-200'
    : 'text-rose-600 bg-rose-50 border-rose-200';
  const statusLabel =
    props.status === 'unknown'
      ? 'جارٍ الفحص…'
      : isOnline
        ? 'متصل'
        : 'غير متاح';
  return (
    <div
      className="bg-white rounded-xl border border-slate-200 p-4 space-y-3"
      data-testid="bridge-status-panel"
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="font-bold text-slate-800 flex items-center gap-2">
          <PrinterIcon className="w-4 h-4" /> جسر الطباعة (Print Bridge)
        </h3>
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold border ${statusColor}`}
            data-testid="bridge-status-chip"
            data-bridge-status={props.status}
          >
            <StatusIcon className="w-3.5 h-3.5" /> {statusLabel}
          </span>
          <button
            type="button"
            onClick={props.onRefresh}
            className="text-xs font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 px-2 py-1 rounded-lg flex items-center gap-1"
            data-testid="bridge-refresh"
          >
            <RefreshCw className="w-3 h-3" /> فحص
          </button>
        </div>
      </div>

      <div className="text-xs text-slate-600 leading-relaxed">
        جسر الطباعة هو تطبيق Android خفيف يستقبل أوامر الطباعة من
        السيستم ويُمررها مباشرةً للطابعة الحرارية عبر Bluetooth أو
        للطابعات A4/A5 عبر نظام Android. عند عدم توفّره، يستخدم
        السيستم تلقائياً نافذة الطباعة في المتصفح كحل بديل.
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-xs font-bold text-slate-700 whitespace-nowrap">
          عنوان الجسر:
        </label>
        <input
          type="text"
          value={props.url}
          onChange={(e) => props.onUrlChange(e.target.value)}
          dir="ltr"
          className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-xs font-mono flex-1 min-w-[240px]"
          data-testid="bridge-url-input"
        />
        <button
          type="button"
          onClick={props.onSaveUrl}
          className="text-xs font-bold text-white bg-slate-700 hover:bg-slate-800 px-3 py-1.5 rounded-lg"
          data-testid="bridge-url-save"
        >
          حفظ
        </button>
      </div>

      {!isOnline && props.status !== 'unknown' && (
        <div
          className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900 leading-relaxed"
          data-testid="bridge-install-cta"
        >
          <b>تطبيق جسر الطباعة غير مثبت أو لا يعمل حالياً.</b> الطباعة
          ستستخدم نافذة المتصفح حتى تثبيت التطبيق. (سيُتاح التحميل
          والتثبيت في المرحلة التالية من هذا التطوير.)
        </div>
      )}
    </div>
  );
}

// ─── Printer list row ────────────────────────────────────────────

function PrinterRow(props: {
  printer: Printer;
  isDefaultFor: DocumentType[];
  onEdit: () => void;
  onDelete: () => void;
  onTestPrint: () => void;
}) {
  const p = props.printer;
  const Icon = CONNECTION_ICON[p.connection];
  return (
    <li
      className="p-3 flex items-center justify-between gap-3 flex-wrap"
      data-testid={`printer-row-${p.printer_id}`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <Icon className="w-5 h-5 text-slate-500 shrink-0" />
        <div className="min-w-0">
          <div className="font-bold text-slate-800 truncate">{p.name}</div>
          <div className="text-[11px] text-slate-500 flex items-center gap-2 flex-wrap">
            <span>{PRINTER_TYPE_LABELS[p.type]}</span>
            <span>·</span>
            <span>{PAPER_LABELS[p.paper]}</span>
            <span>·</span>
            <span>{CONNECTION_LABELS[p.connection]}</span>
            {!p.enabled && (
              <>
                <span>·</span>
                <span className="text-rose-600 font-bold">معطلة</span>
              </>
            )}
          </div>
          {p.bluetooth_name && (
            <div className="text-[11px] text-slate-500 font-mono">
              BT: {p.bluetooth_name}
              {p.bluetooth_mac ? ` (${p.bluetooth_mac})` : ''}
            </div>
          )}
          {p.ip_host && (
            <div className="text-[11px] text-slate-500 font-mono">
              IP: {p.ip_host}:{p.ip_port ?? 9100}
            </div>
          )}
          {p.last_error && (
            <div className="text-[11px] text-rose-600">
              آخر خطأ: {p.last_error}
            </div>
          )}
          {props.isDefaultFor.length > 0 && (
            <div className="text-[11px] text-emerald-700 mt-1">
              افتراضي:{' '}
              {props.isDefaultFor
                .map(
                  (dt) =>
                    DOC_TYPES.find((d) => d.key === dt)?.label || dt,
                )
                .join('، ')}
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={props.onTestPrint}
          className="text-xs font-bold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 px-2.5 py-1 rounded-lg"
          data-testid={`printer-test-${p.printer_id}`}
        >
          اختبار طباعة
        </button>
        <button
          type="button"
          onClick={props.onEdit}
          className="text-xs font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 px-2.5 py-1 rounded-lg"
          data-testid={`printer-edit-${p.printer_id}`}
        >
          تعديل
        </button>
        <button
          type="button"
          onClick={props.onDelete}
          className="text-xs font-bold text-rose-700 bg-rose-50 hover:bg-rose-100 px-2 py-1 rounded-lg flex items-center gap-1"
          data-testid={`printer-delete-${p.printer_id}`}
        >
          <Trash2 className="w-3.5 h-3.5" /> حذف
        </button>
      </div>
    </li>
  );
}

// ─── Defaults table ──────────────────────────────────────────────

function DefaultsTable(props: {
  printers: Printer[];
  defaults: ReturnType<typeof getDefaults>;
  onSetDefault: (dt: DocumentType, printerId: string) => void;
}) {
  const enabledPrinters = useMemo(
    () => props.printers.filter((p) => p.enabled),
    [props.printers],
  );
  return (
    <div
      className="bg-white rounded-xl border border-slate-200"
      data-testid="defaults-table"
    >
      <div className="p-3 border-b border-slate-200">
        <h3 className="font-bold text-slate-800">
          الطابعة الافتراضية لكل نوع مستند
        </h3>
        <p className="text-[11px] text-slate-500 mt-1">
          عند عدم تحديد طابعة لنوع مستند، يستخدم السيستم نافذة طباعة
          المتصفح كما هو الحال اليوم.
        </p>
      </div>
      <div className="divide-y divide-slate-100">
        {DOC_TYPES.map((d) => {
          const cur = props.defaults[d.key] ?? '';
          return (
            <div
              key={d.key}
              className="flex items-center gap-3 p-3"
              data-testid={`defaults-row-${d.key}`}
            >
              <span className="font-bold text-slate-700 min-w-[140px]">
                {d.label}
              </span>
              <select
                value={cur}
                onChange={(e) => props.onSetDefault(d.key, e.target.value)}
                className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-sm flex-1"
                data-testid={`defaults-select-${d.key}`}
              >
                <option value="">— لا توجد طابعة افتراضية —</option>
                {enabledPrinters.map((p) => (
                  <option key={p.printer_id} value={p.printer_id}>
                    {p.name} ({PAPER_LABELS[p.paper]})
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Editor modal ────────────────────────────────────────────────

function PrinterEditor(props: {
  initial: Printer;
  onCancel: () => void;
  onSave: (p: Printer) => void;
}) {
  const [draft, setDraft] = useState<Printer>(props.initial);
  // Sensible paper-size default per type (admin can still override).
  useEffect(() => {
    if (draft.type === 'thermal_escpos' && !['80mm', '58mm'].includes(draft.paper)) {
      setDraft((d) => ({ ...d, paper: '80mm' }));
    } else if (
      draft.type === 'android_system' &&
      !['A4', 'A5'].includes(draft.paper)
    ) {
      setDraft((d) => ({ ...d, paper: 'A4' }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.type]);

  return (
    <div
      className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-[60] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      onClick={props.onCancel}
      dir="rtl"
      data-testid="printer-editor-modal"
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white border-b border-slate-100 px-6 py-4 flex items-center justify-between z-10">
          <h3 className="text-lg font-black text-slate-900">
            {draft.name ? 'تعديل الطابعة' : 'إضافة طابعة'}
          </h3>
          <button
            onClick={props.onCancel}
            className="text-slate-400 hover:text-slate-700"
            aria-label="إغلاق"
          >
            ✕
          </button>
        </div>

        <div className="p-6 space-y-4">
          <Field label="الاسم">
            <input
              type="text"
              value={draft.name}
              onChange={(e) =>
                setDraft({ ...draft, name: e.target.value })
              }
              className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm w-full"
              data-testid="editor-name"
              placeholder="مثال: كاشير 1 — حراري"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="النوع">
              <select
                value={draft.type}
                onChange={(e) =>
                  setDraft({ ...draft, type: e.target.value as PrinterType })
                }
                className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm w-full"
                data-testid="editor-type"
              >
                {(
                  Object.keys(PRINTER_TYPE_LABELS) as PrinterType[]
                ).map((k) => (
                  <option key={k} value={k}>
                    {PRINTER_TYPE_LABELS[k]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="الورق">
              <select
                value={draft.paper}
                onChange={(e) =>
                  setDraft({ ...draft, paper: e.target.value as PaperSize })
                }
                className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm w-full"
                data-testid="editor-paper"
              >
                {(Object.keys(PAPER_LABELS) as PaperSize[]).map((k) => (
                  <option key={k} value={k}>
                    {PAPER_LABELS[k]}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="الاتصال">
            <select
              value={draft.connection}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  connection: e.target.value as ConnectionKind,
                })
              }
              className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm w-full"
              data-testid="editor-connection"
            >
              {(
                Object.keys(CONNECTION_LABELS) as ConnectionKind[]
              ).map((k) => (
                <option key={k} value={k}>
                  {CONNECTION_LABELS[k]}
                </option>
              ))}
            </select>
          </Field>

          {draft.connection === 'bluetooth' && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="اسم Bluetooth">
                <input
                  type="text"
                  value={draft.bluetooth_name ?? ''}
                  onChange={(e) =>
                    setDraft({ ...draft, bluetooth_name: e.target.value })
                  }
                  dir="ltr"
                  className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono w-full"
                  placeholder="3dea"
                  data-testid="editor-bt-name"
                />
              </Field>
              <Field label="MAC (اختياري)">
                <input
                  type="text"
                  value={draft.bluetooth_mac ?? ''}
                  onChange={(e) =>
                    setDraft({ ...draft, bluetooth_mac: e.target.value })
                  }
                  dir="ltr"
                  className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono w-full"
                  placeholder="AA:BB:CC:DD:EE:FF"
                  data-testid="editor-bt-mac"
                />
              </Field>
            </div>
          )}

          {draft.connection === 'network' && (
            <div className="grid grid-cols-3 gap-3">
              <Field label="عنوان IP" className="col-span-2">
                <input
                  type="text"
                  value={draft.ip_host ?? ''}
                  onChange={(e) =>
                    setDraft({ ...draft, ip_host: e.target.value })
                  }
                  dir="ltr"
                  className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono w-full"
                  placeholder="192.168.1.50"
                  data-testid="editor-ip-host"
                />
              </Field>
              <Field label="المنفذ">
                <input
                  type="number"
                  value={draft.ip_port ?? 9100}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      ip_port: Number(e.target.value) || 9100,
                    })
                  }
                  className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono w-full"
                  data-testid="editor-ip-port"
                />
              </Field>
            </div>
          )}

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) =>
                setDraft({ ...draft, enabled: e.target.checked })
              }
              data-testid="editor-enabled"
            />
            <span>مفعّلة</span>
          </label>
        </div>

        <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-2">
          <button
            type="button"
            onClick={props.onCancel}
            className="text-sm font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 px-4 py-2 rounded-lg"
            data-testid="editor-cancel"
          >
            إلغاء
          </button>
          <button
            type="button"
            onClick={() => props.onSave(draft)}
            className="text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 px-4 py-2 rounded-lg"
            data-testid="editor-save"
          >
            حفظ
          </button>
        </div>
      </div>
    </div>
  );
}

function Field(props: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${props.className ?? ''}`}>
      <div className="text-xs font-bold text-slate-700 mb-1">
        {props.label}
      </div>
      {props.children}
    </label>
  );
}
