import { EmployeesService } from './employees.service';

/**
 * Unit tests for the pure helpers added to EmployeesService for the
 * monthly-filtered Employee Profile (migrations 081–084). We pull the
 * private helpers via a subclass so we can exercise them without a
 * DataSource / NestJS module.
 */
class TestableEmployeesService extends EmployeesService {
  constructor() {
    super(null as any);
  }
  monthBoundsPublic(month?: string) {
    return (this as any).monthBounds(month);
  }
  dayBeforePublic(iso: string) {
    return (this as any).dayBefore(iso);
  }
}

describe('EmployeesService helpers — monthly filter', () => {
  const svc = new TestableEmployeesService();

  describe('monthBounds', () => {
    it('returns first + last day for a valid YYYY-MM', () => {
      const r = svc.monthBoundsPublic('2026-02');
      expect(r.from).toBe('2026-02-01');
      expect(r.to).toBe('2026-02-28');
      expect(r.label).toBe('2026-02');
    });

    it('handles a month with 31 days', () => {
      const r = svc.monthBoundsPublic('2026-01');
      expect(r.from).toBe('2026-01-01');
      expect(r.to).toBe('2026-01-31');
    });

    it('handles a leap-year February', () => {
      const r = svc.monthBoundsPublic('2024-02');
      expect(r.from).toBe('2024-02-01');
      expect(r.to).toBe('2024-02-29');
    });

    it('falls back to current month when input is absent or malformed', () => {
      for (const bad of [undefined, '', 'nonsense', '2026-13', '2026/04']) {
        const r = svc.monthBoundsPublic(bad as any);
        expect(r.label).toMatch(/^\d{4}-\d{2}$/);
        expect(r.from).toBe(`${r.label}-01`);
      }
    });

    it('flags is_current=true for the current Cairo month', () => {
      const nowCairo = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Africa/Cairo',
        year: 'numeric',
        month: '2-digit',
      }).formatToParts(new Date());
      const y = nowCairo.find((p) => p.type === 'year')!.value;
      const m = nowCairo.find((p) => p.type === 'month')!.value;
      const r = svc.monthBoundsPublic(`${y}-${m}`);
      expect(r.isCurrent).toBe(true);
    });

    it('flags is_current=false for a clearly past month', () => {
      const r = svc.monthBoundsPublic('2020-01');
      expect(r.isCurrent).toBe(false);
    });
  });

  describe('dayBefore', () => {
    it('returns the previous calendar day', () => {
      expect(svc.dayBeforePublic('2026-04-20')).toBe('2026-04-19');
      expect(svc.dayBeforePublic('2026-04-01')).toBe('2026-03-31');
      expect(svc.dayBeforePublic('2026-01-01')).toBe('2025-12-31');
    });

    it('handles leap-year Feb 29 + Mar 1 boundary', () => {
      expect(svc.dayBeforePublic('2024-03-01')).toBe('2024-02-29');
    });
  });
});
