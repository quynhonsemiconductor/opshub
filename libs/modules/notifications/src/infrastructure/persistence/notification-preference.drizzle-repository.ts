import { Injectable } from '@nestjs/common';
import { InjectDrizzle, type DrizzleDB } from '@platform';
import { eq, and, inArray } from 'drizzle-orm';
import { notificationPreferences } from '../../../../../../db/schema';
import type { INotificationPreferenceRepository } from '../../domain/ports/notification-preference.repository';
import type {
  NotificationPreference,
  UpsertPreferenceInput,
} from '../../domain/notification-preference.types';

@Injectable()
export class NotificationPreferenceDrizzleRepository implements INotificationPreferenceRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  async listForUser(userId: string): Promise<NotificationPreference[]> {
    return this.db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, userId))
      .then((rows) => rows.map((row) => this.map(row)));
  }

  async findOne(userId: string, type: string): Promise<NotificationPreference | null> {
    const [row] = await this.db
      .select()
      .from(notificationPreferences)
      .where(
        and(eq(notificationPreferences.userId, userId), eq(notificationPreferences.type, type)),
      )
      .limit(1);
    return row ? this.map(row) : null;
  }

  async findForCheck(userId: string, type: string): Promise<NotificationPreference[]> {
    return this.db
      .select()
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.userId, userId),
          inArray(notificationPreferences.type, [type, '*']),
        ),
      )
      .then((rows) => rows.map((row) => this.map(row)));
  }

  async upsert(input: UpsertPreferenceInput): Promise<NotificationPreference> {
    const [row] = await this.db
      .insert(notificationPreferences)
      .values({
        userId: input.userId,
        type: input.type,
        inApp: input.inApp ?? true,
        email: input.email ?? true,
      })
      .onConflictDoUpdate({
        target: [notificationPreferences.userId, notificationPreferences.type],
        set: {
          ...(input.inApp !== undefined && { inApp: input.inApp }),
          ...(input.email !== undefined && { email: input.email }),
          updatedAt: new Date(),
        },
      })
      .returning();
    return this.map(row);
  }

  async delete(userId: string, type: string): Promise<void> {
    await this.db
      .delete(notificationPreferences)
      .where(
        and(eq(notificationPreferences.userId, userId), eq(notificationPreferences.type, type)),
      );
  }

  private map(row: typeof notificationPreferences.$inferSelect): NotificationPreference {
    return {
      id: row.id,
      userId: row.userId,
      type: row.type,
      inApp: row.inApp,
      email: row.email,
      updatedAt: row.updatedAt,
    };
  }
}
