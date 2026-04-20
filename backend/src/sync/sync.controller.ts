import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SyncService } from './sync.service';
import { PullSyncDto, PushSyncDto } from './dto/sync.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@ApiTags('sync')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('sync')
export class SyncController {
  constructor(private readonly service: SyncService) {}

  @Post('push')
  @ApiOperation({
    summary: 'Push a batch of offline operations from the client',
  })
  push(@Body() dto: PushSyncDto, @Req() req: any) {
    return this.service.push(dto, req.user.sub ?? req.user.id);
  }

  @Post('pull')
  @ApiOperation({ summary: 'Pull server-side changes since a given timestamp' })
  pull(@Body() dto: PullSyncDto, @Req() req: any) {
    return this.service.pull(dto, req.user.sub ?? req.user.id);
  }

  @Get('status')
  @ApiOperation({ summary: 'Sync status for a given client device' })
  status(@Query('client_id') clientId: string) {
    return this.service.status(clientId);
  }
}
