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

export class ReportRangeDto {
  @IsDateString()
  from!: string;

  @IsDateString()
  to!: string;

  @IsOptional()
  @IsUUID()
  warehouse_id?: string;
}
