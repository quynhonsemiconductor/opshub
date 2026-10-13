import { Module } from '@nestjs/common';
import { SseStreams } from './application/sse-streams.service';
import { NotificationsService } from './application/notifications.service';
import { NotificationRelayService } from './application/notification-relay.service';
import { EmailRelayService } from './application/email-relay.service';
import { NotificationPreferencesService } from './application/notification-preferences.service';
import { NotificationsController } from './interface/http/notifications.controller';
import { NotificationSseController } from './interface/http/notification-sse.controller';
import { NotificationPreferencesController } from './interface/http/notification-preferences.controller';
import { NotificationDrizzleRepository } from './infrastructure/persistence/notification.drizzle-repository';
import { NotificationPreferenceDrizzleRepository } from './infrastructure/persistence/notification-preference.drizzle-repository';
import { NOTIFICATION_REPOSITORY } from './domain/ports/notification.repository';
import { NOTIFICATION_PREFERENCE_REPOSITORY } from './domain/ports/notification-preference.repository';

@Module({
  controllers: [
    NotificationsController,
    NotificationSseController,
    NotificationPreferencesController,
  ],
  providers: [
    NotificationsService,
    SseStreams,
    NotificationRelayService,
    EmailRelayService,
    NotificationPreferencesService,
    { provide: NOTIFICATION_REPOSITORY, useClass: NotificationDrizzleRepository },
    {
      provide: NOTIFICATION_PREFERENCE_REPOSITORY,
      useClass: NotificationPreferenceDrizzleRepository,
    },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
