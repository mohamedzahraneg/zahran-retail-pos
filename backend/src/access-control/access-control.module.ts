import { Module, Global } from '@nestjs/common';
import { AccessControlController } from './access-control.controller';
import { AccessControlService } from './access-control.service';
import { AccessScopeService } from './access-scope.service';

/**
 * Global because every inventory / stock-transfer / inventory-count
 * service needs to ask the scope helper "which branches/warehouses
 * may this user see?" — exporting via @Global() keeps the wiring
 * boilerplate-free.
 */
@Global()
@Module({
  controllers: [AccessControlController],
  providers: [AccessControlService, AccessScopeService],
  exports: [AccessControlService, AccessScopeService],
})
export class AccessControlModule {}
