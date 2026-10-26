import { Module } from '@nestjs/common';
import { DoorTerminalHealthCron } from './application/door-terminal-health.cron';
import { DoorAlertsService } from './application/door-alerts.service';
import { DoorEventCleanupService } from './application/door-event-cleanup.service';
import { TERMINAL_REPOSITORY } from './domain/ports/terminal.repository';
import { TerminalDrizzleRepository } from './infrastructure/persistence/terminal.drizzle-repository';

/**
 * The door WORKER jobs: the Healthchecks dead-man's-switch and the event-retention purge.
 *
 * SPLIT FROM {@link DoorModule} ON PURPOSE. The jobs live in the worker, whose ScheduleModule is
 * the only thing that fires them — but importing the whole DoorModule into `worker.module` drags
 * in the API's controller graph (EmployeesModule and friends) and reorders the worker's module
 * evaluation so GraphModule's providers resolve undefined (UndefinedDependencyException on boot).
 * This module imports NOTHING from the door domain classes' module: just the repository port
 * binding the two jobs need, plus the jobs.
 */
@Module({
  providers: [
    DoorAlertsService,
    { provide: TERMINAL_REPOSITORY, useClass: TerminalDrizzleRepository },
    DoorTerminalHealthCron,
    DoorEventCleanupService,
  ],
  exports: [TERMINAL_REPOSITORY],
})
export class DoorJobsModule {}
