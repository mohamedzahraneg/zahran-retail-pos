import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Length,
  Min,
} from 'class-validator';
import { PartialType } from '@nestjs/swagger';

export class CreateExpenseCategoryDto {
  @IsString()
  @Length(1, 40)
  code!: string;

  @IsString()
  @Length(1, 120)
  name_ar!: string;

  @IsOptional()
  @IsString()
  @Length(0, 120)
  name_en?: string;

  @IsOptional()
  @IsBoolean()
  is_fixed?: boolean;

  @IsOptional()
  @IsBoolean()
  allocate_to_cogs?: boolean;

  /**
   * COA leaf id — required for any category that will be used by the
   * Daily Expenses screen (PR-1 strict mode rejects unmapped
   * categories). Optional here so legacy seeders that don't carry the
   * GL mapping yet stay valid; the strict mode is enforced at the
   * Daily-Expense create path, not at category create.
   */
  @IsOptional()
  @IsUUID()
  account_id?: string;
}

export class UpdateExpenseCategoryDto extends PartialType(
  CreateExpenseCategoryDto,
) {
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class CreateExpenseDto {
  @IsUUID()
  warehouse_id!: string;

  @IsOptional()
  @IsUUID()
  cashbox_id?: string;

  @IsUUID()
  category_id!: string;

  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsOptional()
  @IsString()
  @IsIn(['cash', 'card', 'transfer', 'wallet', 'mixed'])
  payment_method?: 'cash' | 'card' | 'transfer' | 'wallet' | 'mixed';

  @IsOptional()
  @IsDateString()
  expense_date?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  receipt_url?: string;

  @IsOptional()
  @IsString()
  @Length(0, 150)
  vendor_name?: string;

  /**
   * Explicit employee link (migration 060). When supplied, the expense
   * is tagged to this user regardless of category ↔ employee_no match.
   * The Daily Expenses screen always sends this; the legacy Cashboxes
   * form leaves it blank and keeps the old auto-match behaviour.
   */
  @IsOptional()
  @IsUUID()
  employee_user_id?: string;

  /** Mark the expense as a recoverable advance to be settled by the employee. */
  @IsOptional()
  is_advance?: boolean;

  /**
   * Open shift the expense was recorded under (PR-2 Daily Expenses
   * series). Optional — when absent, the service auto-resolves it
   * from the user's open shift (or, if a cashbox is supplied without
   * a shift, from the cashbox's currently-open shift).
   */
  @IsOptional()
  @IsUUID()
  shift_id?: string;

  /**
   * Migration 113 — link this expense back to the approved
   * employee_requests row (kind='advance_request') it disburses. Lets
   * the request inbox show "processed → expense #N" without any
   * trigger-based dual-write. Only meaningful when is_advance=true.
   * The DB enforces FK existence; the service additionally guards
   * that the referenced request is approved + same employee.
   */
  @IsOptional()
  @IsNumber()
  source_employee_request_id?: number;
}

export class UpdateExpenseDto extends PartialType(CreateExpenseDto) {}

/**
 * Payload for `POST /accounting/expenses/daily` — the Daily Expenses
 * screen. Same shape as CreateExpenseDto but employee_user_id is
 * required (the feature's contract: every daily expense must be tied
 * to a responsible employee).
 */
export class CreateDailyExpenseDto {
  // Optional: daily expenses aren't tied to a specific warehouse. If the
  // frontend bundle wasn't built with VITE_DEFAULT_WAREHOUSE_ID the server
  // falls back to the first active warehouse (see createDailyExpense).
  @IsOptional()
  @IsUUID()
  warehouse_id?: string;

  @IsOptional()
  @IsUUID()
  cashbox_id?: string;

  @IsUUID()
  category_id!: string;

  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsOptional()
  @IsString()
  @IsIn(['cash', 'card', 'transfer', 'wallet', 'mixed'])
  payment_method?: 'cash' | 'card' | 'transfer' | 'wallet' | 'mixed';

  @IsOptional()
  @IsDateString()
  expense_date?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  receipt_url?: string;

  @IsOptional()
  @IsString()
  @Length(0, 150)
  vendor_name?: string;

  @IsUUID()
  employee_user_id!: string;

  /**
   * PR-15 — explicit shift linkage from the source selector.
   * When supplied:
   *   - shift must be in 'open' or 'pending_close' status
   *   - cashbox_id (if also supplied) must match the shift's cashbox
   *   - if cashbox_id is omitted it's derived from the shift
   * When omitted, the existing auto-resolve from the user's open shift
   * (accounting.service.ts:131-148) still applies.
   */
  @IsOptional()
  @IsUUID()
  shift_id?: string;

  /** Mark as employee advance (DR 1123 / CR cash) instead of an
   *  operating expense. Already accepted via the legacy
   *  `(dto as any).is_advance` path; declared here in PR-15 to make
   *  the API contract explicit. */
  @IsOptional()
  is_advance?: boolean;

  /**
   * Migration 113 — link this disbursement back to the approved
   * employee_requests row that prompted it. See CreateExpenseDto for
   * the full contract. Only meaningful when is_advance=true.
   */
  @IsOptional()
  @IsNumber()
  source_employee_request_id?: number;
}

export class ListExpensesDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsUUID()
  category_id?: string;

  @IsOptional()
  @IsUUID()
  warehouse_id?: string;

  @IsOptional()
  @IsIn(['approved', 'pending', 'all'])
  status?: 'approved' | 'pending' | 'all';

  /** PR-3: filter by responsible employee. */
  @IsOptional()
  @IsUUID()
  employee_user_id?: string;

  /** PR-3: filter by cashbox. */
  @IsOptional()
  @IsUUID()
  cashbox_id?: string;

  /** PR-3: filter by shift. */
  @IsOptional()
  @IsUUID()
  shift_id?: string;

  /** PR-12: filter the register by edit-request state.
   *    none      — no edit requests in history
   *    pending   — has at least one pending request
   *    approved  — has at least one approved (i.e. was edited)
   *    rejected  — has at least one rejected request
   *    any       — has any edit request (pending OR decided) */
  @IsOptional()
  @IsIn(['none', 'pending', 'approved', 'rejected', 'any'])
  edit_status?: 'none' | 'pending' | 'approved' | 'rejected' | 'any';

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  limit?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  offset?: number;
}

/**
 * Edit-request DTOs (migration 094) — see accounting.service.ts for the
 * full workflow rationale. The whitelist of editable fields lives on
 * the service (`EDITABLE_FIELDS`); anything outside it is dropped.
 */
export class ExpenseEditValuesDto {
  @IsOptional()
  @IsUUID()
  category_id?: string;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  amount?: number;

  @IsOptional()
  @IsUUID()
  cashbox_id?: string;

  @IsOptional()
  @IsDateString()
  expense_date?: string;

  @IsOptional()
  @IsUUID()
  employee_user_id?: string;

  @IsOptional()
  @IsString()
  @IsIn(['cash', 'card', 'transfer', 'wallet', 'mixed'])
  payment_method?: 'cash' | 'card' | 'transfer' | 'wallet' | 'mixed';

  @IsOptional()
  @IsString()
  description?: string;
}

export class CreateExpenseEditRequestDto {
  /** Required justification — minimum 5 chars (also enforced at the
   *  DB level via CHECK constraint on expense_edit_requests.reason). */
  @IsString()
  @Length(5, 1000)
  reason!: string;

  @IsOptional()
  new_values?: ExpenseEditValuesDto;
}

export class ReportRangeDto {
  @IsDateString()
  from!: string;

  @IsDateString()
  to!: string;

  @IsOptional()
  @IsUUID()
  warehouse_id?: string;
}
