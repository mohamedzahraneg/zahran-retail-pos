/**
 * Row4ProfitTables — PR-FIN-2
 *
 * Five tables shown side-by-side in the dashboard image (RTL):
 *   1. أرباح وسائل الدفع
 *   2. أرباح الورديات
 *   3. أرباح الأقسام  (uses categories per Q3 fallback)
 *   4. أرباح الموردين
 *   5. أرباح العملاء
 *
 * All tables read-only, sorted by gross profit desc with name tiebreak.
 */
import type { FinanceDashboard } from '@/api/finance.api';
import { DashboardSection } from './shared/DashboardSection';
import { fmtEGP, fmtPct, fmtNumber, fmtDate } from './shared/utils';

export function Row4ProfitTables({ data }: { data: FinanceDashboard }) {
  return (
    <div
      className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3"
      dir="rtl"
      data-testid="dashboard-row-4"
    >
      <ProfitByPaymentMethodTable rows={data.profit_by_payment_method} />
      <ProfitByShiftTable rows={data.profit_by_shift} />
      <ProfitByDepartmentTable rows={data.profit_by_department} />
      <ProfitBySupplierTable rows={data.profit_by_supplier} />
      <ProfitByCustomerTable rows={data.profit_by_customer} />
    </div>
  );
}

function ProfitByPaymentMethodTable({
  rows,
}: {
  rows: FinanceDashboard['profit_by_payment_method'];
}) {
  // Append a totals row for parity with the image.
  const totalSales = rows.reduce((acc, r) => acc + Number(r.sales), 0);
  const totalFees = rows.reduce((acc, r) => acc + Number(r.fees_or_costs), 0);
  const totalNet = rows.reduce((acc, r) => acc + Number(r.net_collection), 0);
  return (
    <DashboardSection
      title="أرباح وسائل الدفع"
      testId="table-profit-by-payment-method"
      viewAllHref={null}
    >
      <TableScroll>
        <thead className="bg-slate-50 dark:bg-slate-800">
          <tr>
            <Th>وسيلة الدفع</Th>
            <Th>المبيعات</Th>
            <Th>رسوم/تكاليف</Th>
            <Th>صافي التحصيل</Th>
            <Th>هامش الربح</Th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <EmptyRow cols={5} />
          ) : (
            rows.map((r) => (
              <tr
                key={r.method_key}
                className="border-t border-slate-100 dark:border-slate-800"
              >
                <Td>{r.label_ar}</Td>
                <Td className="font-mono tabular-nums">{fmtEGP(r.sales)}</Td>
                <Td className="font-mono tabular-nums">
                  {fmtEGP(r.fees_or_costs)}
                </Td>
                <Td className="font-mono tabular-nums">
                  {fmtEGP(r.net_collection)}
                </Td>
                <Td className="font-mono tabular-nums">
                  {fmtPct(r.margin_pct)}
                </Td>
              </tr>
            ))
          )}
          {rows.length > 0 && (
            <tr className="border-t border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/60 font-bold">
              <Td>الإجمالي</Td>
              <Td className="font-mono tabular-nums">{fmtEGP(totalSales)}</Td>
              <Td className="font-mono tabular-nums">{fmtEGP(totalFees)}</Td>
              <Td className="font-mono tabular-nums">{fmtEGP(totalNet)}</Td>
              <Td>—</Td>
            </tr>
          )}
        </tbody>
      </TableScroll>
    </DashboardSection>
  );
}

function ProfitByShiftTable({
  rows,
}: {
  rows: FinanceDashboard['profit_by_shift'];
}) {
  return (
    <DashboardSection
      title="أرباح الورديات"
      testId="table-profit-by-shift"
      viewAllHref={null}
    >
      <TableScroll>
        <thead className="bg-slate-50 dark:bg-slate-800">
          <tr>
            <Th>الوردية</Th>
            <Th>المبيعات</Th>
            <Th>صافي الحركة</Th>
            <Th>مجمل الربح</Th>
            <Th>هامش الربح</Th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <EmptyRow cols={5} />
          ) : (
            rows.map((r) => (
              <tr
                key={r.shift_id}
                className="border-t border-slate-100 dark:border-slate-800"
              >
                <Td className="font-mono tabular-nums">{fmtDate(r.opened_at)}</Td>
                <Td className="font-mono tabular-nums">{fmtEGP(r.sales)}</Td>
                <Td className="font-mono tabular-nums">{fmtEGP(r.cash_net)}</Td>
                <Td className="font-mono tabular-nums text-emerald-700 dark:text-emerald-400 font-bold">
                  {fmtEGP(r.gross_profit)}
                </Td>
                <Td className="font-mono tabular-nums">{fmtPct(r.margin_pct)}</Td>
              </tr>
            ))
          )}
        </tbody>
      </TableScroll>
    </DashboardSection>
  );
}

function ProfitByDepartmentTable({
  rows,
}: {
  rows: FinanceDashboard['profit_by_department'];
}) {
  return (
    <DashboardSection
      title="أرباح الأقسام"
      subtitle="يعتمد على مجموعات الأصناف حاليًا"
      testId="table-profit-by-department"
      viewAllHref={null}
    >
      <TableScroll>
        <thead className="bg-slate-50 dark:bg-slate-800">
          <tr>
            <Th>القسم</Th>
            <Th>المبيعات</Th>
            <Th>مجمل الربح</Th>
            <Th>هامش الربح</Th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <EmptyRow cols={4} />
          ) : (
            rows.map((r) => (
              <tr
                key={r.department_id ?? r.name_ar}
                className="border-t border-slate-100 dark:border-slate-800"
              >
                <Td>{r.name_ar}</Td>
                <Td className="font-mono tabular-nums">{fmtEGP(r.sales)}</Td>
                <Td className="font-mono tabular-nums text-emerald-700 dark:text-emerald-400 font-bold">
                  {fmtEGP(r.gross_profit)}
                </Td>
                <Td className="font-mono tabular-nums">{fmtPct(r.margin_pct)}</Td>
              </tr>
            ))
          )}
        </tbody>
      </TableScroll>
    </DashboardSection>
  );
}

function ProfitBySupplierTable({
  rows,
}: {
  rows: FinanceDashboard['profit_by_supplier'];
}) {
  return (
    <DashboardSection
      title="أرباح الموردين"
      testId="table-profit-by-supplier"
      viewAllHref={null}
    >
      <TableScroll>
        <thead className="bg-slate-50 dark:bg-slate-800">
          <tr>
            <Th>المورد</Th>
            <Th>المبيعات الناتجة</Th>
            <Th>تكلفة</Th>
            <Th>مجمل الربح</Th>
            <Th>هامش الربح</Th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <EmptyRow cols={5} />
          ) : (
            rows.map((r) => (
              <tr
                key={r.supplier_id}
                className="border-t border-slate-100 dark:border-slate-800"
              >
                <Td>{r.name_ar}</Td>
                <Td className="font-mono tabular-nums">{fmtEGP(r.sales)}</Td>
                <Td className="font-mono tabular-nums">{fmtEGP(r.cost)}</Td>
                <Td className="font-mono tabular-nums text-emerald-700 dark:text-emerald-400 font-bold">
                  {fmtEGP(r.gross_profit)}
                </Td>
                <Td className="font-mono tabular-nums">{fmtPct(r.margin_pct)}</Td>
              </tr>
            ))
          )}
        </tbody>
      </TableScroll>
    </DashboardSection>
  );
}

function ProfitByCustomerTable({
  rows,
}: {
  rows: FinanceDashboard['profit_by_customer'];
}) {
  return (
    <DashboardSection
      title="أرباح العملاء"
      testId="table-profit-by-customer"
      viewAllHref={null}
    >
      <TableScroll>
        <thead className="bg-slate-50 dark:bg-slate-800">
          <tr>
            <Th>العميل</Th>
            <Th>إجمالي البيع</Th>
            <Th>مجمل الربح</Th>
            <Th>هامش الربح</Th>
            <Th>عدد الفواتير</Th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <EmptyRow cols={5} />
          ) : (
            rows.map((r) => (
              <tr
                key={r.customer_id}
                className="border-t border-slate-100 dark:border-slate-800"
              >
                <Td>{r.name_ar}</Td>
                <Td className="font-mono tabular-nums">{fmtEGP(r.sales)}</Td>
                <Td className="font-mono tabular-nums text-emerald-700 dark:text-emerald-400 font-bold">
                  {fmtEGP(r.gross_profit)}
                </Td>
                <Td className="font-mono tabular-nums">{fmtPct(r.margin_pct)}</Td>
                <Td className="font-mono tabular-nums">
                  {fmtNumber(r.invoices_count)}
                </Td>
              </tr>
            ))
          )}
        </tbody>
      </TableScroll>
    </DashboardSection>
  );
}

// ─── Tiny table primitives ─────────────────────────────────────────
function TableScroll({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto -mx-4 -my-4 max-h-72">
      <table className="min-w-full text-xs">{children}</table>
    </div>
  );
}
function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="text-right px-3 py-2 text-[10px] font-bold text-slate-500 dark:text-slate-400 whitespace-nowrap">
      {children}
    </th>
  );
}
function Td({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <td className={`px-3 py-2 text-[11px] text-slate-700 dark:text-slate-200 ${className}`}>
      {children}
    </td>
  );
}
function EmptyRow({ cols }: { cols: number }) {
  return (
    <tr>
      <td colSpan={cols} className="text-center py-6 text-slate-400 dark:text-slate-500 text-[11px]">
        لا توجد بيانات
      </td>
    </tr>
  );
}
