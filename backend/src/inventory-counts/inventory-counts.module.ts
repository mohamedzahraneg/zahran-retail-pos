import { Module } from '@nestjs/common';
import { InventoryCountsService } from './inventory-counts.service';
import { InventoryCountsController } from './inventory-counts.controller';

@Module({
  providers: [InventoryCountsService],
  controllers: [InventoryCountsController],
  exports: [InventoryCountsService],
})
export class InventoryCountsModule {}
