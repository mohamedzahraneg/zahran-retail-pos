import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  ExpenseAllocationsService,
  CreatePeriodDto,
  UpdatePeriodDto,
  AddLineDto,
  UpdateLineDto,
  PreviewDto,
  PreviewMethod,
  PreviewTargetKind,
  SavePreviewDto,
} from './expense-allocations.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles, Permissions } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  JwtUser,
} from '../common/decorators/current-user.decorator';

/**
 * DTOs (class-validator) — declared here so the controller stays the
 * single source of truth for request shape + validation, while the
 * service-side interfaces remain framework-agnostic.
 */
class CreatePeriodDtoIn implements CreatePeriodDto {
  @IsDateString() period_start: string;
  @IsDateString() period_end: string;
  @IsOptional() @IsUUID() warehouse_id?: string;
  @IsOptional() @IsString() notes?: string;
}

class UpdatePeriodDtoIn implements UpdatePeriodDto {
  @IsOptional() @IsDateString() period_start?: string;
  @IsOptional() @IsDateString() period_end?: string;
  // Pass `null` explicitly to clear the scope back to company-wide.
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() warehouse_id?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() notes?: string | null;
}

class AddLineDtoIn implements AddLineDto {
  @IsOptional() @IsUUID() expense_id?: string;
  @IsOptional() @IsUUID() expense_category_id?: string;
  @IsNumber() @Min(0) source_amount: number;
  @IsOptional() @IsUUID() product_id?: string;
  @IsOptional() @IsUUID() product_category_id?: string;
  @IsOptional() @IsUUID() warehouse_id?: string;
  // PR-PHASE2-B2 accepts only `manual`.  The other methods are reserved
  // for a future PR that adds preview/compute endpoints.
  @IsOptional() @IsEnum(['manual']) allocation_method?: 'manual';
  @IsNumber() @Min(0) allocated_amount: number;
  @IsOptional() @IsString() notes?: string;
}

class UpdateLineDtoIn implements UpdateLineDto {
  @IsOptional() @IsNumber() @Min(0) source_amount?: number;
  @IsOptional() @IsNumber() @Min(0) allocated_amount?: number;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() product_id?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() product_category_id?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() warehouse_id?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() expense_id?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() expense_category_id?: string | null;
}

class ReverseDtoIn {
  // Non-empty reason is required to flip an approved period to reversed.
  @IsString() @MinLength(1) reason: string;
}

/**
 * PR-PHASE2-B3 preview DTO — read-only compute, no DB writes.
 *
 * Exactly one of `source.expense_id` / `source.expense_category_id` is
 * required.  The mutual-exclusion check lives in the service so both
 * "both supplied" and "neither supplied" produce the same Arabic 400
 * — class-validator can't easily express the XOR on nested objects.
 */
class PreviewSourceDtoIn {
  @IsOptional() @IsUUID() expense_id?: string;
  @IsOptional() @IsUUID() expense_category_id?: string;
}

class PreviewDtoIn implements PreviewDto {
  @IsObject()
  @ValidateNested()
  @Type(() => PreviewSourceDtoIn)
  source: PreviewSourceDtoIn;

  @IsEnum(['product', 'category', 'warehouse'])
  target_kind: PreviewTargetKind;

  @IsEnum(['by_revenue', 'by_units_sold', 'by_gross_profit'])
  method: PreviewMethod;
}

/**
 * PR-PHASE2-B4 v2 — save-preview DTO.  Same shape as PreviewDtoIn plus
 * an optional `replace_existing` flag.  Default behavior refuses to
 * overwrite existing lines; set the flag to true for the destructive
 * "clear and resave" path.
 *
 * v2 deliberately does NOT wire IdempotencyInterceptor — idempotency
 * comes from the "reject if lines exist" guard.
 */
class SavePreviewDtoIn implements SavePreviewDto {
  @IsObject()
  @ValidateNested()
  @Type(() => PreviewSourceDtoIn)
  source: PreviewSourceDtoIn;

  @IsEnum(['product', 'category', 'warehouse'])
  target_kind: PreviewTargetKind;

  @IsEnum(['by_revenue', 'by_units_sold', 'by_gross_profit'])
  method: PreviewMethod;

  @IsOptional() replace_existing?: boolean;
}

/**
 * Periods controller — PR-PHASE2-B1 (read) + PR-PHASE2-B2 (mutate).
 *
 * Permissions:
 *   * Class-level `expense_allocation.view` covers GET routes.
 *   * Mutation routes override with `expense_allocation.manage` so a
 *     viewer cannot accidentally create / approve / reverse periods.
 *
 * No FinancialEngine call.  No JE/CT/SM writes.  All mutations are
 * confined to `expense_allocation_periods` and `expense_allocation_lines`.
 */
@ApiBearerAuth()
@ApiTags('expense-allocations')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'manager', 'accountant')
@Permissions('expense_allocation.view')
@Controller('expense-allocations')
export class ExpenseAllocationsController {
  constructor(private readonly svc: ExpenseAllocationsService) {}

  // ─── Reads (view permission) ────────────────────────────────────

  @Get('periods')
  @ApiOperation({ summary: 'قائمة فترات توزيع المصاريف' })
  listPeriods(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: string,
    @Query('warehouse_id') warehouse_id?: string,
  ) {
    return this.svc.listPeriods({ from, to, status, warehouse_id });
  }

  @Get('periods/:id')
  @ApiOperation({ summary: 'فترة توزيع واحدة مع سطورها' })
  getPeriod(@Param('id') id: string) {
    return this.svc.getPeriod(id);
  }

  // ─── Periods (manage permission) ────────────────────────────────

  @Post('periods')
  @Permissions('expense_allocation.manage')
  @ApiOperation({ summary: 'إنشاء فترة توزيع جديدة (مسودة)' })
  createPeriod(@Body() dto: CreatePeriodDtoIn, @CurrentUser() user: JwtUser) {
    return this.svc.createPeriod(dto, user.userId);
  }

  @Patch('periods/:id')
  @Permissions('expense_allocation.manage')
  @ApiOperation({ summary: 'تعديل فترة توزيع (مسودة فقط)' })
  updatePeriod(@Param('id') id: string, @Body() dto: UpdatePeriodDtoIn) {
    return this.svc.updatePeriod(id, dto);
  }

  @Delete('periods/:id')
  @Permissions('expense_allocation.manage')
  @ApiOperation({ summary: 'حذف فترة توزيع (مسودة فقط)' })
  deletePeriod(@Param('id') id: string) {
    return this.svc.deletePeriod(id);
  }

  // ─── Lines (manage permission) ──────────────────────────────────

  @Post('periods/:id/lines')
  @Permissions('expense_allocation.manage')
  @ApiOperation({ summary: 'إضافة سطر توزيع يدوي (مسودة فقط)' })
  addLine(@Param('id') id: string, @Body() dto: AddLineDtoIn) {
    return this.svc.addLine(id, dto);
  }

  @Delete('periods/:id/lines')
  @Permissions('expense_allocation.manage')
  @ApiOperation({ summary: 'مسح كل سطور الفترة (مسودة فقط)' })
  clearLines(@Param('id') id: string) {
    return this.svc.clearLines(id);
  }

  @Patch('periods/:id/lines/:line_id')
  @Permissions('expense_allocation.manage')
  @ApiOperation({ summary: 'تعديل سطر توزيع يدوي (مسودة فقط)' })
  updateLine(
    @Param('id') id: string,
    @Param('line_id') lineId: string,
    @Body() dto: UpdateLineDtoIn,
  ) {
    return this.svc.updateLine(id, lineId, dto);
  }

  // PR-PHASE2-B5 — targeted per-line delete.  Sits between `clearLines`
  // (bulk) and `updateLine` (per-line edit).  Same draft-only + manage
  // FSM contract as the rest of the line surface.  Returns 404 when the
  // line either doesn't exist or belongs to a different period (no
  // information leak across periods).
  @Delete('periods/:id/lines/:line_id')
  @Permissions('expense_allocation.manage')
  @ApiOperation({ summary: 'حذف سطر توزيع واحد (مسودة فقط)' })
  deleteLine(
    @Param('id') id: string,
    @Param('line_id') lineId: string,
  ) {
    return this.svc.deleteLine(id, lineId);
  }

  // ─── FSM transitions (manage permission) ────────────────────────

  @Post('periods/:id/approve')
  @Permissions('expense_allocation.manage')
  @ApiOperation({ summary: 'اعتماد فترة توزيع (مسودة → معتمد)' })
  approvePeriod(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.svc.approvePeriod(id, user.userId);
  }

  @Post('periods/:id/reverse')
  @Permissions('expense_allocation.manage')
  @ApiOperation({ summary: 'عكس فترة توزيع (معتمد → معكوس)' })
  reversePeriod(
    @Param('id') id: string,
    @Body() dto: ReverseDtoIn,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.reversePeriod(id, user.userId, dto.reason);
  }

  // ─── Preview / compute (PR-PHASE2-B3, read-only) ────────────────

  /**
   * Compute a proposed allocation without writing anything.  Returned
   * lines are advisory; the operator decides whether and how to save.
   *
   * Permission is `expense_allocation.view` (not `.manage`) because no
   * mutation happens — anyone who can read allocation reports can
   * preview "what would I propose?" results.  Saving still requires
   * `.manage` via the existing B2 POST /lines (one manual line at a
   * time) or a future batch-save PR.
   *
   * Allowed on periods of any status (draft / approved / reversed),
   * mirroring the read-only intent.
   */
  @Post('periods/:id/preview')
  @Permissions('expense_allocation.view')
  @ApiOperation({ summary: 'معاينة توزيع المصاريف (بدون حفظ)' })
  preview(@Param('id') id: string, @Body() dto: PreviewDtoIn) {
    return this.svc.previewAllocation(id, dto);
  }

  // ─── Save preview (PR-PHASE2-B4 v2, draft-only write) ──────────

  /**
   * Materialise a preview computation into real `expense_allocation_lines`
   * rows.  Server recomputes the preview internally — clients do NOT
   * submit precomputed amounts.  Pre-existing lines reject the call
   * unless `replace_existing=true`, in which case they're cleared
   * first inside the same transaction.
   *
   * Permission: `expense_allocation.manage` (writes).  Draft-only.
   *
   * Idempotency: handled by the "reject if lines exist" guard — a
   * retry after a successful first save returns 400 with the message
   * `الفترة تحتوي على سطور بالفعل…` and the client treats that as
   * "save already happened".  No interceptor wiring needed.
   *
   * v2 deliberately omits @UseInterceptors(IdempotencyInterceptor)
   * because that interceptor depends on IdempotencyCacheService,
   * which is not a provider of ExpenseAllocationsModule — the v1
   * version crashed the Nest bootstrap in production for that reason.
   */
  @Post('periods/:id/save-preview')
  @Permissions('expense_allocation.manage')
  @ApiOperation({ summary: 'حفظ سطور المعاينة في فترة المسودة' })
  savePreview(@Param('id') id: string, @Body() dto: SavePreviewDtoIn) {
    return this.svc.saveAllocationPreview(id, dto);
  }
}
