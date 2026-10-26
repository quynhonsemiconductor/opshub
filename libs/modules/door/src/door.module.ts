import { Module } from '@nestjs/common';
import { AuditModule } from '@modules/audit';
import { EmployeesModule } from '@modules/identity';
import { DoorService } from './application/door.service';
import { DoorAlertsService } from './application/door-alerts.service';
import { TERMINAL_REPOSITORY } from './domain/ports/terminal.repository';
import { CARD_REPOSITORY } from './domain/ports/card.repository';
import { TerminalDrizzleRepository } from './infrastructure/persistence/terminal.drizzle-repository';
import { CardDrizzleRepository } from './infrastructure/persistence/card.drizzle-repository';
import { DoorController } from './interface/http/door.controller';
import { DoorTerminalController } from './interface/http/door-terminal.controller';
import { TerminalAuthGuard } from './interface/http/terminal-auth.guard';

/**
 * The door: terminals, cards, and (in the terminal-routes PR) the `/v1/door/terminal/*` routes the
 * ESP32 calls. Imports `EmployeesModule` for `assertExist` — a card belongs to a real employee,
 * validated at enrolment, with no cross-schema FK.
 */
@Module({
  imports: [AuditModule, EmployeesModule],
  controllers: [DoorController, DoorTerminalController],
  providers: [
    DoorService,
    DoorAlertsService,
    TerminalAuthGuard,
    { provide: TERMINAL_REPOSITORY, useClass: TerminalDrizzleRepository },
    { provide: CARD_REPOSITORY, useClass: CardDrizzleRepository },
  ],
  exports: [DoorService],
})
export class DoorModule {}
