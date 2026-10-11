import { Module } from '@nestjs/common';
import { GraphTaskQueue } from './graph-task.queue';

/** The API's whole view of Graph: a queue it can write to. No client, no credential. */
@Module({ providers: [GraphTaskQueue], exports: [GraphTaskQueue] })
export class GraphTasksModule {}
