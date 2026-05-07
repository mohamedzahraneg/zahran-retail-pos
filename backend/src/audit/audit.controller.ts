import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuditService } from './audit.service';
import {
  FinancialMovementsTraceService,
  TraceQuery,
} from './financial-movements-trace.service';
import { Permissions } from '../common/decorators/roles.decorator';

@ApiBearerAuth()
@ApiTags('audit')
@Controller('audit')
@Permissions('audit.view')
export class AuditController {
  constructor(
    private readonly svc: AuditService,
    private readonly trace: FinancialMovementsTraceService,
  ) {}

  /**
   * GET /audit/financial-movements/trace
   *
   * Read-only cross-table trace of a single financial movement.
   * Resolves a source row (invoice / return / purchase / expense /
   * shift / customer_payment / supplier_payment / journal_entry) and
   * pulls every linked journal_entry, journal_line,
   * cashbox_transaction, and stock_movement, plus diagnostic flags.
   *
   * Strict guarantees:
   *   · GET only. SELECT-only queries underneath.
   *   · No mutations, no posting, no reconciliation, no repair.
   *   · No new tables, no migrations.
   *
   * Query params:
   *   · reference_type: invoice|return|purchase|expense|shift|
   *                     customer_payment|supplier_payment|journal_entry
   *   · reference_id:   UUID of the source row
   *   · q:              free-form document number (INV-…, RET-…, …)
   *   · idempotency_key: optional; surfaced for the FE to display
   *
   * If `reference_type`+`reference_id` is provided, that path is used.
   * Else if `q` is provided, the type is guessed from the prefix and
   * resolved by document number. If nothing resolves, a structured
   * empty result with `SOURCE_NOT_FOUND` flag is returned.
   */
  @Get('financial-movements/trace')
  traceFinancialMovement(
    @Query('reference_type') reference_type?: string,
    @Query('reference_id') reference_id?: string,
    @Query('q') q?: string,
    @Query('idempotency_key') idempotency_key?: string,
  ) {
    const query: TraceQuery = {
      reference_type,
      reference_id,
      q,
      idempotency_key,
    };
    return this.trace.trace(query);
  }

  @Get('activity')
  activity(
    @Query('user_id') user_id?: string,
    @Query('action') action?: string,
    @Query('entity') entity?: string,
    @Query('entity_id') entity_id?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.listActivity({
      user_id,
      action,
      entity,
      entity_id,
      from,
      to,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('changes')
  changes(
    @Query('table_name') table_name?: string,
    @Query('record_id') record_id?: string,
    @Query('operation') operation?: 'I' | 'U' | 'D',
    @Query('changed_by') changed_by?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.listChanges({
      table_name,
      record_id,
      operation,
      changed_by,
      from,
      to,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('stats')
  stats(@Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.stats({ from, to });
  }
}
