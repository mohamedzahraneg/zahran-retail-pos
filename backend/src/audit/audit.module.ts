import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { FinancialMovementsTraceService } from './financial-movements-trace.service';
import { FinancialMovementsListService } from './financial-movements-list.service';
import { AuditController } from './audit.controller';

@Module({
  providers: [
    AuditService,
    FinancialMovementsTraceService,
    FinancialMovementsListService,
  ],
  controllers: [AuditController],
  exports: [AuditService],
})
export class AuditModule {}
