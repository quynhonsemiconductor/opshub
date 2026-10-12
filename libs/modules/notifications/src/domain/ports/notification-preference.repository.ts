import type {
  NotificationPreference,
  UpsertPreferenceInput,
} from '../notification-preference.types';

export const NOTIFICATION_PREFERENCE_REPOSITORY = Symbol('NOTIFICATION_PREFERENCE_REPOSITORY');

export interface INotificationPreferenceRepository {
  listForUser(userId: string): Promise<NotificationPreference[]>;
  findOne(userId: string, type: string): Promise<NotificationPreference | null>;
  /** Fetch specific-type + wildcard row in one query. Used by isEnabled(). */
  findForCheck(userId: string, type: string): Promise<NotificationPreference[]>;
  upsert(input: UpsertPreferenceInput): Promise<NotificationPreference>;
  delete(userId: string, type: string): Promise<void>;
}
