import { Injectable } from '@nestjs/common';
import { like } from 'drizzle-orm';
import {
  ConflictException,
  ErrorCodes,
  InjectDrizzle,
  type DbExecutor,
  type DrizzleDB,
} from '@platform';
import { notifyOutbox } from '@platform';
import { graphSyncState, graphTaskOutbox } from '../../../../db/schema';
import {
  GRAPH_HEARTBEAT_PREFIX,
  HEARTBEAT_FRESH_MS,
  dedupeKeyFor,
  orderingKeyFor,
  type GraphTask,
} from './graph-task';

/**
 * The API's side of Graph: write a task row, never call Graph.
 *
 * Pass the caller's transaction as `tx`, so the task exists if and only if the business change
 * committed. Without one the row is written on its own, which is right for a request whose only effect
 * is the task (the shadow-IT scan trigger).
 *
 * Needs no Graph credential and imports no Graph client — this is what the API process is allowed to
 * know about Graph.
 */
@Injectable()
export class GraphTaskQueue {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  /** Resolves to whether a NEW row was written (false when an equal task was already pending). */
  async enqueue(task: GraphTask, tx?: DbExecutor): Promise<boolean> {
    const rows = await (tx ?? this.db)
      .insert(graphTaskOutbox)
      .values({
        kind: task.kind,
        payload: task.payload,
        orderingKey: orderingKeyFor(task),
        dedupeKey: dedupeKeyFor(task),
      })
      .onConflictDoNothing()
      .returning({ id: graphTaskOutbox.id });
    if (rows.length === 0) return false;
    await notifyOutbox(tx ?? this.db, 'graph');
    return true;
  }

  /**
   * Whether ANY worker replica with Graph enabled is up right now (an `enabled` heartbeat, fresh).
   * For endpoints that would otherwise answer 202 for a scan nobody can run.
   */
  async isGraphAvailable(now: Date = new Date()): Promise<boolean> {
    const rows = await this.db
      .select({ cursor: graphSyncState.cursor, updatedAt: graphSyncState.updatedAt })
      .from(graphSyncState)
      .where(like(graphSyncState.name, `${GRAPH_HEARTBEAT_PREFIX}%`));
    return rows.some(
      (row) =>
        row.cursor === 'enabled' && now.getTime() - row.updatedAt.getTime() < HEARTBEAT_FRESH_MS,
    );
  }

  /** 409 GRAPH_DISABLED unless a worker with Graph is up: the UI must not promise a scan that never runs. */
  async requireGraphAvailable(): Promise<void> {
    if (!(await this.isGraphAvailable())) {
      throw new ConflictException(
        ErrorCodes.GRAPH_DISABLED,
        'Microsoft Graph is not enabled on the worker, so this cannot run. It is turned on by ' +
          'configuring the Graph worker app (docs/graph-worker-app.md).',
      );
    }
  }
}
