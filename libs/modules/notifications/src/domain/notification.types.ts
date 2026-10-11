export interface Notification {
  id: string;
  recipientId: string;
  actorId: string | null;
  type: string;
  title: string;
  body: string | null;
  resourceType: string | null;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  isRead: boolean;
  readAt: Date | null;
  createdAt: Date;
  sourceEventId: string | null;
}

export interface CreateNotificationInput {
  recipientId: string;
  actorId?: string;
  type: string;
  title: string;
  body?: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  sourceEventId?: string;
}

export interface NotificationListFilters {
  isRead?: boolean;
  limit: number;
  cursor?: string; // base64(createdAt ISO)
}

export interface NotificationListResult {
  items: Notification[];
  nextCursor: string | null;
}
