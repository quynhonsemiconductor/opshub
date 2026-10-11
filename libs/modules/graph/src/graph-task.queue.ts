import { Injectable } from '@nestjs/common';
import { InjectDrizzle, type DbExecutor, type DrizzleDB } from '@platform';
import { graphTaskOutbox } from '../../../../db/schema';
import { dedupeKeyFor, orderingKeyFor, type GraphTask } from './graph-task';

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
    return rows.length > 0;
  }
}
