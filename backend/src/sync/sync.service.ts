import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PosService } from '../pos/pos.service';
import { ReturnsService } from '../returns/returns.service';
import { ReservationsService } from '../reservations/reservations.service';
import { CustomersService } from '../customers/customers.service';
import { CashDeskService } from '../cash-desk/cash-desk.service';
import {
  PushSyncDto,
  PullSyncDto,
  SyncOperationDto,
  SyncOperationResult,
} from './dto/sync.dto';

/**
 * Offline sync service.
 *
 * Clients (PWA on shaky wifi) enqueue operations locally in IndexedDB, then
 * post them to /sync/push in a batch when back online. We store each operation
 * in `offline_sync_queue` keyed by (client_id, offline_id) for idempotency —
 * replaying the same batch is safe.
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly ds: DataSource,
    @Optional() private readonly pos?: PosService,
    @Optional() private readonly returns?: ReturnsService,
    @Optional() private readonly reservations?: ReservationsService,
    @Optional() private readonly customers?: CustomersService,
    @Optional() private readonly cashDesk?: CashDeskService,
  ) {}

  async push(
    dto: PushSyncDto,
    userId: string,
  ): Promise<{
    client_id: string;
    processed: number;
    synced: number;
    duplicates: number;
    conflicts: number;
    failed: number;
    results: SyncOperationResult[];
  }> {
    const results: SyncOperationResult[] = [];
    let synced = 0;
    let duplicates = 0;
    let conflicts = 0;
    let failed = 0;

    for (const op of dto.operations) {
      // 1) Idempotency check — have we seen this (client_id, offline_id) before?
      const [existing] = await this.ds.query(
        `SELECT id, state, server_id, last_error, conflict_reason
         FROM offline_sync_queue
         WHERE client_id = $1 AND offline_id = $2`,
        [dto.client_id, op.offline_id],
      );

      if (existing && existing.state === 'synced') {
        duplicates += 1;
        results.push({
          offline_id: op.offline_id,
          entity: op.entity,
          state: 'duplicate',
          server_id: existing.server_id,
        });
        continue;
      }

      // 2) Upsert the queue row in 'pending' so we have an audit record
      await this.ds.query(
        `
        INSERT INTO offline_sync_queue
          (client_id, user_id, entity, operation, offline_id,
           payload, state, client_created_at, attempts)
        VALUES ($1,$2,$3::entity_type,$4,$5,$6,'pending',$7,1)
        ON CONFLICT (client_id, offline_id) DO UPDATE SET
          attempts = offline_sync_queue.attempts + 1,
          payload = EXCLUDED.payload,
          last_error = NULL
        `,
        [
          dto.client_id,
          userId,
          op.entity,
          op.operation,
          op.offline_id,
          JSON.stringify(op.payload),
          op.client_created_at,
        ],
      );

      // 3) Apply the operation
      try {
        const outcome = await this.applyOperation(op, userId);
        await this.ds.query(
          `UPDATE offline_sync_queue SET
             state = 'synced',
             server_id = $1,
             server_processed_at = NOW(),
             last_error = NULL,
             conflict_reason = NULL
           WHERE client_id = $2 AND offline_id = $3`,
          [outcome.server_id ?? null, dto.client_id, op.offline_id],
        );
        synced += 1;
        results.push({
          offline_id: op.offline_id,
          entity: op.entity,
          state: 'synced',
          server_id: outcome.server_id,
          result: outcome.result,
        });
      } catch (err: any) {
        const isConflict =
          err?.status === 409 ||
          err?.code === '23505' ||
          /duplicate|conflict/i.test(err?.message || '');
        const state: 'conflict' | 'failed' = isConflict ? 'conflict' : 'failed';
        const reason = err?.message || String(err);

        await this.ds.query(
          `UPDATE offline_sync_queue SET
             state = $1::sync_state,
             conflict_reason = $2,
             last_error = $2,
             server_processed_at = NOW()
           WHERE client_id = $3 AND offline_id = $4`,
          [state, reason, dto.client_id, op.offline_id],
        );

        if (state === 'conflict') {
          conflicts += 1;
          results.push({
            offline_id: op.offline_id,
            entity: op.entity,
            state: 'conflict',
            conflict_reason: reason,
          });
        } else {
          failed += 1;
          results.push({
            offline_id: op.offline_id,
            entity: op.entity,
            state: 'failed',
            error: reason,
          });
        }
        this.logger.warn(
          `Sync op ${op.entity}/${op.offline_id} failed: ${reason}`,
        );
      }
    }

    return {
      client_id: dto.client_id,
      processed: dto.operations.length,
      synced,
      duplicates,
      conflicts,
      failed,
      results,
    };
  }

  private async applyOperation(
    op: SyncOperationDto,
    userId: string,
  ): Promise<{ server_id?: string | null; result: any }> {
    switch (op.entity) {
      case 'invoice': {
        if (op.operation !== 'I')
          throw new BadRequestException('Only invoice creation is supported');
        if (!this.pos)
          throw new BadRequestException('POS module unavailable');
        const res = await this.pos.createInvoice(op.payload as any, userId);
        return { server_id: res.invoice_id, result: res };
      }
      case 'return': {
        if (op.operation !== 'I')
          throw new BadRequestException('Only return creation is supported');
        if (!this.returns)
          throw new BadRequestException('Returns module unavailable');
        const res = await this.returns.createReturn(op.payload as any, userId);
        return { server_id: (res as any)?.id ?? null, result: res };
      }
      case 'reservation': {
        if (!this.reservations)
          throw new BadRequestException('Reservations module unavailable');
        if (op.operation === 'I') {
          const res = await this.reservations.create(
            op.payload as any,
            userId,
          );
          return { server_id: (res as any)?.id ?? null, result: res };
        }
        throw new BadRequestException(
          `Unsupported reservation op: ${op.operation}`,
        );
      }
      case 'customer': {
        if (!this.customers)
          throw new BadRequestException('Customers module unavailable');
        if (op.operation === 'I') {
          const res = await this.customers.create(op.payload as any);
          return { server_id: (res as any)?.id ?? null, result: res };
        }
        if (op.operation === 'U') {
          const { id, ...rest } = op.payload;
          const res = await this.customers.update(id, rest);
          return { server_id: id, result: res };
        }
        throw new BadRequestException(
          `Unsupported customer op: ${op.operation}`,
        );
      }
      case 'cash_movement': {
        if (op.operation !== 'I')
          throw new BadRequestException('Only cash movement creation is supported');
        if (!this.cashDesk)
          throw new BadRequestException('Cash-desk module unavailable');
        const res = await (this.cashDesk as any).create(op.payload, userId);
        return { server_id: (res as any)?.id ?? null, result: res };
      }
      default:
        throw new BadRequestException(`Unknown entity: ${op.entity}`);
    }
  }

  /**
   * Pull server state changed since `since` timestamp — the client uses this
   * to refresh caches after reconnecting, showing what others created while
   * they were offline.
   */
  async pull(dto: PullSyncDto, userId: string) {
    const since = dto.since ? new Date(dto.since) : new Date(Date.now() - 3600_000);
    const entities = dto.entities?.length
      ? dto.entities
      : (['invoice', 'return', 'reservation', 'customer'] as const);

    const out: Record<string, any[]> = {};

    if (entities.includes('invoice')) {
      out.invoices = await this.ds.query(
        `SELECT id, doc_no, customer_id, grand_total, status, created_at
         FROM invoices
         WHERE updated_at >= $1
         ORDER BY updated_at DESC
         LIMIT 500`,
        [since],
      );
    }
    if (entities.includes('return')) {
      out.returns = await this.ds.query(
        `SELECT id, doc_no, original_invoice_id, total_refund, status, created_at
         FROM return_receipts
         WHERE created_at >= $1
         ORDER BY created_at DESC
         LIMIT 500`,
        [since],
      );
    }
    if (entities.includes('reservation')) {
      out.reservations = await this.ds.query(
        `SELECT id, reservation_no, customer_id, status, expires_at, created_at
         FROM reservations
         WHERE updated_at >= $1
         ORDER BY updated_at DESC
         LIMIT 500`,
        [since],
      );
    }
    if (entities.includes('customer')) {
      out.customers = await this.ds.query(
        `SELECT id, full_name, phone, updated_at
         FROM customers
         WHERE updated_at >= $1
         ORDER BY updated_at DESC
         LIMIT 500`,
        [since],
      );
    }

    return {
      since: since.toISOString(),
      server_time: new Date().toISOString(),
      user_id: userId,
      client_id: dto.client_id ?? null,
      data: out,
    };
  }

  /** Status summary for the client's device (how many pending/failed on server) */
  async status(clientId: string) {
    const [row] = await this.ds.query(
      `
      SELECT
        COUNT(*)::int                                       AS total,
        COUNT(*) FILTER (WHERE state = 'pending')::int      AS pending,
        COUNT(*) FILTER (WHERE state = 'synced')::int       AS synced,
        COUNT(*) FILTER (WHERE state = 'conflict')::int     AS conflicts,
        COUNT(*) FILTER (WHERE state = 'failed')::int       AS failed,
        MAX(server_processed_at)                            AS last_synced_at
      FROM offline_sync_queue
      WHERE client_id = $1
      `,
      [clientId],
    );
    return row;
  }
}
