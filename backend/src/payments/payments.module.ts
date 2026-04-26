import { Global, Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

// PR-PAY-1 — Made @Global so AccountingPostingService and PosService
// can @Optional()-inject PaymentsService without each consuming
// module having to import PaymentsModule explicitly. This mirrors
// ChartOfAccountsModule, which is also global for the same reason.
@Global()
@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
