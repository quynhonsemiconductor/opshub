import { Injectable } from '@nestjs/common';
import { InjectDrizzle, type DrizzleDB, type DbExecutor } from '@platform';
import type { ITransactionRunner } from '@quynhonsemiconductor/identity';

/**
 * opshub binding for the shared `ITransactionRunner` port — threads a single
 * drizzle transaction through the shared AuthService's multi-step writes
 * (session create + last-login stamp) so they commit or roll back atomically.
 */
@Injectable()
export class DrizzleTransactionRunner implements ITransactionRunner<DbExecutor> {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  transaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => fn(tx));
  }
}
