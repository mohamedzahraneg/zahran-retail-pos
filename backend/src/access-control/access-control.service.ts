/**
 * access-control.service.ts — PR-USER-BRANCH-WAREHOUSE-ACCESS
 *
 * Write path for the per-user branch + warehouse access tables.
 * Strictly admin / manager territory: rebuilds the user's allowed
 * surface from the supplied payload inside a transaction.
 *
 * Read path is in AccessScopeService (sibling).
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  AccessLevel,
  ACCESS_LEVELS,
  AccessScopeService,
} from './access-scope.service';

export interface BranchAccessEntry {
  branch_id: string;
  access_level: AccessLevel;
}
export interface WarehouseAccessEntry {
  warehouse_id: string;
  access_level: AccessLevel;
}

export interface UpdateUserAccessPayload {
  branch_access?: BranchAccessEntry[];
  warehouse_access?: WarehouseAccessEntry[];
  default_branch_id?: string | null;
  default_warehouse_id?: string | null;
}

@Injectable()
export class AccessControlService {
  constructor(
    private readonly ds: DataSource,
    private readonly scope: AccessScopeService,
  ) {}

  /**
   * Replace the user's branch + warehouse access lists with the
   * supplied payload. Only the keys present in `payload` are touched:
   *
   *   · `branch_access` missing → branches table left alone.
   *   · `branch_access = []`    → all branch rows removed.
   *   · `warehouse_access` ditto.
   *   · `default_branch_id` / `default_warehouse_id` — when supplied,
   *      we flip the `is_default` flag for that one row and clear it
   *      on the others (preserving the partial-unique invariant).
   *      Passing `null` clears the default entirely.
   */
  async updateUserAccess(
    userId: string,
    payload: UpdateUserAccessPayload,
    currentUserId: string,
  ) {
    await this.assertUserExists(userId);

    return this.ds.transaction(async (tx) => {
      if (Array.isArray(payload.branch_access)) {
        this.validateEntries(payload.branch_access, 'branch');
        await tx.query(
          `DELETE FROM user_branch_access WHERE user_id = $1::uuid`,
          [userId],
        );
        for (const e of payload.branch_access) {
          await tx.query(
            `INSERT INTO user_branch_access
               (user_id, branch_id, access_level, is_default, created_by)
             VALUES ($1::uuid, $2::uuid, $3, FALSE, $4::uuid)`,
            [userId, e.branch_id, e.access_level, currentUserId],
          );
        }
      }

      if (Array.isArray(payload.warehouse_access)) {
        this.validateEntries(payload.warehouse_access, 'warehouse');
        await tx.query(
          `DELETE FROM user_warehouse_access WHERE user_id = $1::uuid`,
          [userId],
        );
        for (const e of payload.warehouse_access) {
          await tx.query(
            `INSERT INTO user_warehouse_access
               (user_id, warehouse_id, access_level, is_default, created_by)
             VALUES ($1::uuid, $2::uuid, $3, FALSE, $4::uuid)`,
            [userId, e.warehouse_id, e.access_level, currentUserId],
          );
        }
      }

      // Default flags. We always wipe + set in a single transaction so
      // the partial-unique index never sees a transient two-default
      // state. Passing `null` clears the default.
      if (payload.default_branch_id !== undefined) {
        await tx.query(
          `UPDATE user_branch_access SET is_default = FALSE
            WHERE user_id = $1::uuid AND is_default = TRUE`,
          [userId],
        );
        if (payload.default_branch_id !== null) {
          const res = await tx.query(
            `UPDATE user_branch_access SET is_default = TRUE
              WHERE user_id = $1::uuid AND branch_id = $2::uuid
              RETURNING branch_id`,
            [userId, payload.default_branch_id],
          );
          if (!res?.length) {
            throw new ConflictException(
              `الفرع الافتراضي ليس ضمن قائمة الفروع المسموحة للمستخدم`,
            );
          }
        }
      }
      if (payload.default_warehouse_id !== undefined) {
        await tx.query(
          `UPDATE user_warehouse_access SET is_default = FALSE
            WHERE user_id = $1::uuid AND is_default = TRUE`,
          [userId],
        );
        if (payload.default_warehouse_id !== null) {
          const res = await tx.query(
            `UPDATE user_warehouse_access SET is_default = TRUE
              WHERE user_id = $1::uuid AND warehouse_id = $2::uuid
              RETURNING warehouse_id`,
            [userId, payload.default_warehouse_id],
          );
          if (!res?.length) {
            throw new ConflictException(
              `المخزن الافتراضي ليس ضمن قائمة المخازن المسموحة للمستخدم`,
            );
          }
        }
      }

      return this.scope.getUserAccessSummary(userId);
    });
  }

  // ─── helpers ─────────────────────────────────────────────────────
  private validateEntries(
    entries: Array<{ access_level: AccessLevel }>,
    kind: 'branch' | 'warehouse',
  ) {
    const seen = new Set<string>();
    for (const e of entries) {
      if (!ACCESS_LEVELS.includes(e.access_level)) {
        throw new BadRequestException(
          `مستوى الوصول غير صالح: ${e.access_level}`,
        );
      }
      const key =
        kind === 'branch'
          ? (e as any).branch_id
          : (e as any).warehouse_id;
      if (!key) {
        throw new BadRequestException(
          kind === 'branch' ? 'branch_id مطلوب' : 'warehouse_id مطلوب',
        );
      }
      if (seen.has(key)) {
        throw new BadRequestException(
          `صف مكرر للمستوى ${kind === 'branch' ? 'الفرع' : 'المخزن'}: ${key}`,
        );
      }
      seen.add(key);
    }
  }

  private async assertUserExists(userId: string) {
    const [u] = await this.ds.query(
      `SELECT id FROM users WHERE id = $1::uuid`,
      [userId],
    );
    if (!u) throw new NotFoundException(`المستخدم غير موجود`);
  }
}
