import { Module } from '@nestjs/common';
import { ProductGroupsController } from './product-groups.controller';
import { ProductGroupsService } from './product-groups.service';

/**
 * PR-P9.1a — Manual product-groups module.
 *
 * Pure CRUD + variant membership. No write surface on prices, stock,
 * accounting, cashbox, or supplier ledger. Selector-only by design.
 */
@Module({
  controllers: [ProductGroupsController],
  providers: [ProductGroupsService],
  exports: [ProductGroupsService],
})
export class ProductGroupsModule {}
