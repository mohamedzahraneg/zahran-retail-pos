import { useEffect, useState } from 'react';
import { Info, X as XIcon } from 'lucide-react';
import clsx from 'clsx';

/**
 * Safety banner shown at the top of every allocation page.  Reminds
 * the operator that the expense-allocation surface is a management
 * accounting overlay — it does NOT post journal entries, move cash,
 * touch inventory, or modify invoices/expenses.
 *
 * Dismissable per browser session (sessionStorage); reappears on
 * next session so it stays a recurring reminder.  Use the same key
 * everywhere so dismissal is global across the four pages.
 */
const STORAGE_KEY = 'zahran.allocBanner.dismissed';

export function AllocationBanner({ className }: { className?: string }) {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const v = window.sessionStorage.getItem(STORAGE_KEY);
      if (v === '1') setHidden(true);
    } catch {
      /* sessionStorage may be unavailable; default to showing the banner */
    }
  }, []);

  if (hidden) return null;

  const dismiss = () => {
    setHidden(true);
    try {
      window.sessionStorage.setItem(STORAGE_KEY, '1');
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      role="note"
      aria-label="ملاحظة محاسبة إدارية"
      className={clsx(
        'flex items-start gap-3 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900',
        className,
      )}
    >
      <Info className="h-5 w-5 shrink-0 text-sky-600" aria-hidden />
      <div className="flex-1 leading-relaxed">
        <strong className="font-semibold">محاسبة إدارية فقط.</strong>{' '}
        هذه الأداة تقوم بتوزيع المصاريف التشغيلية على المنتجات والفئات والمخازن{' '}
        <strong>لأغراض التقارير فقط</strong>. لا تؤثر على القيود المحاسبية ولا
        على المخزون ولا على الفواتير ولا على المصاريف الأصلية.
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="إخفاء الإشعار"
        className="rounded p-1 text-sky-700 hover:bg-sky-100"
      >
        <XIcon className="h-4 w-4" />
      </button>
    </div>
  );
}
