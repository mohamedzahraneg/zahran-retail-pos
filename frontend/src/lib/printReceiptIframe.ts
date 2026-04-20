/**
 * Print a receipt DOM node via a hidden iframe.
 *
 * Thermal printers (like the Xprinter XP-307B) need a very specific page
 * stream — @page size + width in mm, no margins, no ancestor overflow.
 * Running window.print() on the host page can't guarantee that because:
 *   - the POS / invoice pages set fixed viewport heights;
 *   - modals cap max-height at 90vh with overflow-auto;
 *   - React's #root / AppLayout introduce flex containers that clip.
 *
 * An iframe bypasses every one of those. We clone the receipt markup plus
 * the inline <style> block that Receipt.tsx already emits, write it into
 * the iframe's `document`, wait for images to load, then call
 * contentWindow.print().
 */
export function printReceiptIframe(root: HTMLElement, widthMm: number) {
  // Snapshot the receipt subtree + any <style> children that live next to
  // it (Receipt.tsx renders its CSS inline in a <style> tag).
  const html = root.outerHTML;
  const stylesNode = root.querySelector('style');
  const styleCss = stylesNode ? stylesNode.innerHTML : '';

  // Collect every <link rel="stylesheet"> from the host so fonts / icons
  // stay visually consistent.
  const linkCss = Array.from(
    document.querySelectorAll('link[rel="stylesheet"]'),
  )
    .map((l) => l.outerHTML)
    .join('\n');

  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  iframe.setAttribute('aria-hidden', 'true');
  document.body.appendChild(iframe);

  const cleanup = () => {
    // Small delay so the browser finishes streaming before we yank the DOM.
    setTimeout(() => {
      iframe.remove();
    }, 500);
  };

  const doc = iframe.contentDocument!;
  doc.open();
  doc.write(`<!DOCTYPE html>
    <html dir="rtl" lang="ar">
      <head>
        <meta charset="utf-8" />
        ${linkCss}
        <style>
          @page {
            size: ${widthMm}mm auto;
            margin: 0;
          }
          html, body {
            margin: 0;
            padding: 0;
            background: #fff;
            width: ${widthMm}mm;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          body { font-family: Cairo, 'Courier New', sans-serif; }
          ${styleCss}
          /* Neutralise ancestor-level rules that don't make sense here. */
          .receipt-80mm { margin: 0 auto; }
          /* Belt-and-suspenders: force logo + header dead-centre on paper
             regardless of the template's logo_align setting. The thermal
             driver was printing the logo drifted to the edge before. */
          .receipt-header {
            display: flex !important;
            flex-direction: column !important;
            align-items: center !important;
            text-align: center !important;
            width: 100% !important;
          }
          .receipt-logo {
            display: block !important;
            margin-left: auto !important;
            margin-right: auto !important;
          }
        </style>
      </head>
      <body>
        ${html}
      </body>
    </html>`);
  doc.close();

  // Wait for images (logo, QR upload) to finish loading before printing.
  const afterImages = async () => {
    const imgs = Array.from(doc.images);
    await Promise.all(
      imgs.map(
        (img) =>
          new Promise<void>((resolve) => {
            if (img.complete) return resolve();
            img.addEventListener('load', () => resolve(), { once: true });
            img.addEventListener('error', () => resolve(), { once: true });
          }),
      ),
    );
  };

  const triggerPrint = async () => {
    try {
      await afterImages();
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } finally {
      cleanup();
    }
  };

  // Some browsers fire load synchronously after doc.close(); others need
  // the next tick. requestAnimationFrame covers both cases.
  requestAnimationFrame(() => {
    triggerPrint();
  });
}
