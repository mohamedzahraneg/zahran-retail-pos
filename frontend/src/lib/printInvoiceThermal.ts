import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { posApi } from '@/api/pos.api';
import { Receipt, ReceiptData } from '@/components/Receipt';
import { routePrintJob } from '@/lib/printers/router';

/**
 * Fire-and-forget thermal print for an invoice.  Internally routes
 * through the printer router (Phase 1 of the direct-print system):
 *
 *   · No printer profile configured for `invoice` → falls back to
 *     today's iframe-print behaviour bit-for-bit.
 *   · Printer profile configured + bridge reachable → POSTs the job
 *     to the local Android Print Bridge (Phase 2).
 *   · Bridge unreachable / fails → falls back to the iframe path
 *     so the user still gets a printout.
 *
 * Public signature is unchanged — every existing caller of
 * `printInvoiceThermal(invoiceId)` works identically.
 *
 *   await printInvoiceThermal(invoiceId);
 */
export async function printInvoiceThermal(invoiceId: string): Promise<void> {
  const data = await posApi.receipt(invoiceId);

  const browserFallback = () =>
    new Promise<void>((resolve) => {
      // Host container placed off-screen; we mount React, let
      // Receipt.useEffect fire autoPrint → printReceiptIframe, then
      // unmount after the dialog closes.  This is the existing
      // behaviour that shipped before the printer router landed.
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
        // printReceiptIframe removes its own iframe; we remove our
        // render host on the next macrotask so React has time to
        // commit.
        setTimeout(() => {
          try {
            root.unmount();
          } catch {
            // ignore double-unmount
          }
          host.remove();
          resolve();
        }, 2000);
      };

      root.render(
        createElement(Receipt as any, {
          data: data as ReceiptData,
          autoPrint: true,
          onAfterPrint: cleanup,
        }),
      );
    });

  // Phase 1 wiring: every print attempt goes through the router.
  // When no profile is configured the router immediately invokes
  // `browserFallback`, preserving the old single-path behaviour.
  await routePrintJob({
    document_type: 'invoice',
    document_id: invoiceId,
    buildPayload: () => {
      // Phase 2 will replace this with a real ESC/POS-ready payload
      // (template-rendered HTML or pre-baked bytes).  For Phase 1 the
      // bridge is not yet running on any device, so this code path
      // is exercised only by tests.
      return {
        kind: 'escpos_html',
        html: '',
        width_mm: 80,
      };
    },
    onBrowserFallback: browserFallback,
  });
}
