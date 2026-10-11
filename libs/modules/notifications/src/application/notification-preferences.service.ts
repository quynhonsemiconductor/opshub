import { Inject, Injectable } from '@nestjs/common';
import {
  NOTIFICATION_PREFERENCE_REPOSITORY,
  type INotificationPreferenceRepository,
} from '../domain/ports/notification-preference.repository';
import type {
  NotificationPreference,
  UpsertPreferenceInput,
  NotificationChannel,
} from '../domain/notification-preference.types';

@Injectable()
export class NotificationPreferencesService {
  constructor(
    @Inject(NOTIFICATION_PREFERENCE_REPOSITORY)
    private readonly repo: INotificationPreferenceRepository,
  ) {}

  listPreferences(userId: string): Promise<NotificationPreference[]> {
    return this.repo.listForUser(userId);
  }

  upsert(input: UpsertPreferenceInput): Promise<NotificationPreference> {
    return this.repo.upsert(input);
  }

  /** Reset to default (delete the stored preference row). */
  reset(userId: string, type: string): Promise<void> {
    return this.repo.delete(userId, type);
  }

  /**
   * Check whether a given channel is enabled for this user + notification type.
   *
   * Resolution order:
   *   1. Specific type row (most specific)
   *   2. Wildcard '*' row
   *   3. Default: true (enabled)
   */
  async isEnabled(userId: string, type: string, channel: NotificationChannel): Promise<boolean> {
    const rows = await this.repo.findForCheck(userId, type);
    const specific = rows.find((r) => r.type === type);
    if (specific) return channel === 'in_app' ? specific.inApp : specific.email;

    const wildcard = rows.find((r) => r.type === '*');
    if (wildcard) return channel === 'in_app' ? wildcard.inApp : wildcard.email;

    return true; // default: all channels enabled
  }

  isInAppEnabled(userId: string, type: string): Promise<boolean> {
    return this.isEnabled(userId, type, 'in_app');
  }

  isEmailEnabled(userId: string, type: string): Promise<boolean> {
    return this.isEnabled(userId, type, 'email');
  }
}
