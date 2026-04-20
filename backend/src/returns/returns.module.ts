import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReturnEntity } from './entities/return.entity';
import { ReturnsService } from './returns.service';
import { ReturnsController } from './returns.controller';
import { ReturnsAnalyticsService } from './returns-analytics.service';
import { ReturnsAnalyticsController } from './returns-analytics.controller';

@Module({
  imports: [TypeOrmModule.forFeature([ReturnEntity])],
  providers: [ReturnsService, ReturnsAnalyticsService],
  controllers: [ReturnsAnalyticsController, ReturnsController],
  exports: [ReturnsService, ReturnsAnalyticsService],
})
export class ReturnsModule {}
