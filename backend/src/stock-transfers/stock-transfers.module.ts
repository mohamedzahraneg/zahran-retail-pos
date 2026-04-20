import { Module } from '@nestjs/common';
import { StockTransfersService } from './stock-transfers.service';
import { StockTransfersController } from './stock-transfers.controller';

@Module({
  providers: [StockTransfersService],
  controllers: [StockTransfersController],
  exports: [StockTransfersService],
})
export class StockTransfersModule {}
