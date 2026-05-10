/**
 * PrintersTab — UI smoke tests for the Phase-1 printer settings page.
 *
 *   · empty state shown when no printers configured
 *   · "Add printer" opens the editor and saves a profile
 *   · defaults table reflects the saved profile
 *   · bridge-status chip reflects the probeBridge result
 *   · install-bridge CTA appears when bridge is offline
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { PrintersTab } from '../PrintersTab';
import { __resetPrinterStore_TEST_ONLY } from '@/lib/printers/store';
import * as bridgeModule from '@/lib/printers/bridge';

// Toast — silence so we don't depend on the live toaster.
vi.mock('react-hot-toast', () => ({
  default: {
    success: () => {},
    error: () => {},
    // toast(...) without method:
  },
}));

beforeEach(() => {
  __resetPrinterStore_TEST_ONLY();
  // Default the bridge probe to "offline" so tests are deterministic
  // unless they override.
  vi.spyOn(bridgeModule, 'probeBridge').mockResolvedValue({
    ok: false,
    reason: 'unreachable',
  });
});

afterEach(() => {
  __resetPrinterStore_TEST_ONLY();
  vi.restoreAllMocks();
});

describe('PrintersTab — empty state', () => {
  it('shows the empty-state message when no printers exist', async () => {
    render(<PrintersTab />);
    expect(await screen.findByTestId('printers-empty')).toBeInTheDocument();
  });

  it('renders the bridge status panel + offline CTA when probe fails', async () => {
    render(<PrintersTab />);
    const chip = await screen.findByTestId('bridge-status-chip');
    await waitFor(() =>
      expect(chip.getAttribute('data-bridge-status')).toBe('offline'),
    );
    expect(
      screen.getByTestId('bridge-install-cta'),
    ).toBeInTheDocument();
  });
});

describe('PrintersTab — bridge online', () => {
  it('shows "متصل" chip when probeBridge succeeds', async () => {
    vi.spyOn(bridgeModule, 'probeBridge').mockResolvedValue({
      ok: true,
      data: { ok: true, version: '0.1' },
    });
    render(<PrintersTab />);
    const chip = await screen.findByTestId('bridge-status-chip');
    await waitFor(() =>
      expect(chip.getAttribute('data-bridge-status')).toBe('online'),
    );
    expect(chip.textContent ?? '').toContain('متصل');
  });
});

describe('PrintersTab — add printer + set as invoice default', () => {
  it('add → save → defaults dropdown lists the new printer → set default', async () => {
    render(<PrintersTab />);
    fireEvent.click(await screen.findByTestId('printers-add'));
    // Editor modal opens.
    const modal = await screen.findByTestId('printer-editor-modal');
    fireEvent.change(within(modal).getByTestId('editor-name'), {
      target: { value: 'كاشير 1 — حراري' },
    });
    fireEvent.change(within(modal).getByTestId('editor-bt-name'), {
      target: { value: '3dea' },
    });
    fireEvent.click(within(modal).getByTestId('editor-save'));

    // Empty-state goes away; the printer row appears.
    await waitFor(() => {
      expect(screen.queryByTestId('printers-empty')).not.toBeInTheDocument();
    });
    expect(
      screen.getByText('كاشير 1 — حراري'),
    ).toBeInTheDocument();

    // Defaults select for "invoice" lists the new printer.
    const select = await screen.findByTestId('defaults-select-invoice');
    const opts = (select as HTMLSelectElement).options;
    const labels = Array.from(opts).map((o) => o.textContent ?? '');
    expect(labels.some((l) => l.includes('كاشير 1 — حراري'))).toBe(true);

    // Pick it.
    const printerOpt = Array.from(opts).find((o) =>
      (o.textContent ?? '').includes('كاشير 1 — حراري'),
    )!;
    fireEvent.change(select, { target: { value: printerOpt.value } });
    // The row should now show "افتراضي: فاتورة".
    await waitFor(() =>
      expect(
        screen.getByText(/افتراضي:.*فاتورة/),
      ).toBeInTheDocument(),
    );
  });
});

describe('PrintersTab — defaults select for each document type', () => {
  it('renders one defaults row per supported document type', async () => {
    render(<PrintersTab />);
    for (const dt of [
      'invoice',
      'return',
      'exchange',
      'expense',
      'shift_close',
      'general_report',
      'voucher',
      'reservation',
    ]) {
      expect(
        await screen.findByTestId(`defaults-row-${dt}`),
      ).toBeInTheDocument();
    }
  });
});
