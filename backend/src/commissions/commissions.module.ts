import { Module } from '@nestjs/common';
import { CommissionsService } from './commissions.service';
import { CommissionsController } from './commissions.controller';

@Module({
  providers: [CommissionsService],
  controllers: [CommissionsController],
  exports: [CommissionsService],
})
export class CommissionsModule {}
