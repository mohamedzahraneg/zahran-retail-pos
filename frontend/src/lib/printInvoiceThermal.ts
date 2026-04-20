import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { posApi } from '@/api/pos.api';
import { Receipt, ReceiptData } from '@/components/Receipt';

/**
 * Fire-and-forget thermal print for an invoice. Fetches the receipt payload,
 * mounts the <Receipt> component off-screen, and lets it self-trigger the
 * hidden-iframe print at the template's paper_width_mm (default 80mm).
 *
 * Use this for one-click "reprint thermal" buttons — the user doesn't see the
 * rendering pass, just the browser's print dialog.
 *
 *   await printInvoiceThermal(invoiceId);
 */
export async function printInvoiceThermal(invoiceId: string): Promise<void> {
  const data = await posApi.receipt(invoiceId);

  // Host container placed off-screen; we mount React, let Receipt.useEffect
  // fire autoPrint → printReceiptIframe, then unmount after the dialog closes.
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.position = 'fixed';
  host.style.left = '-10000px';
  host.style.top = '0';
  host.style.opacity = '0';
  host.style.pointerEvents = 'none';
  document.body.appendChild(host);

  const root = createRoot(host);

  const cleanup = () => {
    // printReceiptIframe removes its own iframe; we remove our render host
    // on the next macrotask so React has time to commit.
    setTimeout(() => {
      try {
        root.unmount();
      } catch {
        // ignore double-unmount
      }
      host.remove();
    }, 2000);
  };

  root.render(
    createElement(Receipt as any, {
      data: data as ReceiptData,
      autoPrint: true,
      onAfterPrint: cleanup,
    }),
  );
}
