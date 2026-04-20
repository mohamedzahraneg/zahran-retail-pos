import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { WhatsAppProvider } from './providers/whatsapp.provider';
import { SmsProvider } from './providers/sms.provider';

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, WhatsAppProvider, SmsProvider],
  exports: [NotificationsService],
})
export class NotificationsModule {}
