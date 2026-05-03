/**
 * DashboardHeader.rtl.test.tsx — PR-FIN-DASHBOARD-RTL-HEADER
 *
 * Pins the RTL DOM-order contract on the finance-dashboard header.
 * The previous implementation used `order-2 lg:order-1` /
 * `order-1 lg:order-2` which silently inverted the layout on the
 * `lg:` breakpoint, dropping the title to the LEFT side of the
 * page in RTL — exactly the bug the user reported. The fix is to
 * reorder the JSX naturally (title block first, actions second) and
 * remove the `order-*` classes; in an RTL flex row with
 * `justify-between`, the first DOM child sits on the right.
 *
 * These specs lock the contract by asserting:
 *   ✓ title block precedes the actions block in DOM order
 *   ✓ no leftover `order-*` Tailwind classes on either child
 *   ✓ all three action buttons (تحديث / طباعة / تصدير Excel) render
 *   ✓ the title block contains the Arabic title + subtitle + the
 *     decorative BarChart icon
 *
 * Anyone re-introducing an `order-*` swap (or moving the title block
 * after the actions in JSX) fails CI.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DashboardHeader } from '../DashboardHeader';

function renderHeader() {
  return render(
    <div dir="rtl">
      <DashboardHeader
        onRefresh={vi.fn()}
        onPrint={vi.fn()}
        onExport={vi.fn()}
        isFetching={false}
      />
    </div>,
  );
}

describe('<DashboardHeader /> RTL — PR-FIN-DASHBOARD-RTL-HEADER', () => {
  it('renders the title block BEFORE the actions block in DOM order', () => {
    renderHeader();
    const header = screen.getByTestId('finance-dashboard-header');
    const titleBlock = screen.getByTestId('dashboard-header-title-block');
    const actionsBlock = screen.getByTestId('dashboard-header-actions');
    // Both must be direct children of the header flex row.
    expect(header.contains(titleBlock)).toBe(true);
    expect(header.contains(actionsBlock)).toBe(true);
    // Natural DOM order: title first, actions second. In RTL flex
    // with justify-between, this puts the title on the RIGHT and
    // the actions on the LEFT.
    const children = Array.from(header.children);
    expect(children.indexOf(titleBlock)).toBeLessThan(
      children.indexOf(actionsBlock),
    );
  });

  it('header children carry NO leftover Tailwind `order-*` classes (mobile or lg)', () => {
    renderHeader();
    const titleBlock = screen.getByTestId('dashboard-header-title-block');
    const actionsBlock = screen.getByTestId('dashboard-header-actions');
    for (const el of [titleBlock, actionsBlock]) {
      const cls = el.className;
      // Forbid any `order-N` (mobile) or `lg:order-N` / `md:order-N`
      // / `sm:order-N` / `xl:order-N` (responsive) — those re-introduce
      // the bug.
      expect(cls).not.toMatch(/(?:^|\s)order-\d/);
      expect(cls).not.toMatch(/(?:^|\s)(?:sm|md|lg|xl|2xl):order-\d/);
    }
  });

  it('title block contains "لوحة الحسابات والمالية" + subtitle + BarChart icon', () => {
    renderHeader();
    const titleBlock = screen.getByTestId('dashboard-header-title-block');
    expect(titleBlock.textContent).toMatch(/لوحة الحسابات والمالية/);
    expect(titleBlock.textContent).toMatch(/نظرة شاملة على الوضع المالي لحظيًا/);
    // The decorative icon is an inline lucide SVG inside the title block.
    expect(titleBlock.querySelector('svg')).not.toBeNull();
  });

  it('actions block renders the three action buttons (تحديث / طباعة / تصدير Excel)', () => {
    renderHeader();
    const actionsBlock = screen.getByTestId('dashboard-header-actions');
    expect(actionsBlock.contains(screen.getByTestId('dashboard-action-refresh'))).toBe(true);
    expect(actionsBlock.contains(screen.getByTestId('dashboard-action-print'))).toBe(true);
    expect(actionsBlock.contains(screen.getByTestId('dashboard-action-excel'))).toBe(true);
    expect(screen.getByTestId('dashboard-action-refresh').textContent).toMatch(/تحديث/);
    expect(screen.getByTestId('dashboard-action-print').textContent).toMatch(/طباعة/);
    expect(screen.getByTestId('dashboard-action-excel').textContent).toMatch(/تصدير Excel/);
  });

  it('header itself uses `flex justify-between` (the layout primitive RTL relies on)', () => {
    renderHeader();
    const header = screen.getByTestId('finance-dashboard-header');
    expect(header.className).toMatch(/\bflex\b/);
    expect(header.className).toMatch(/\bjustify-between\b/);
  });
});
