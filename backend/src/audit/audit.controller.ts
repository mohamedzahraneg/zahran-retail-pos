import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuditService } from './audit.service';
import { Permissions } from '../common/decorators/roles.decorator';

@ApiBearerAuth()
@ApiTags('audit')
@Controller('audit')
@Permissions('audit.view')
export class AuditController {
  constructor(private readonly svc: AuditService) {}

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
