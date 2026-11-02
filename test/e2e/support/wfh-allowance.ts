import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { expect } from 'vitest';
import { apiRequest, unwrap, type Session } from './harness';

/** Offset of Asia/Ho_Chi_Minh from UTC, in milliseconds — the zone the WFH rules judge dates in. */
const _HO_CHI_MINH_OFFSET_MS = 7 * 3_600_000;

/** Today in Asia/Ho_Chi_Minh, as `YYYY-MM-DD`. */
function _todayInHoChiMinh(): string {
  return new Date(Date.now() + _HO_CHI_MINH_OFFSET_MS).toISOString().slice(0, 10);
}

interface JobRankRow {
  id: string;
  ordinal: number;
}

interface PositionAssignmentRow {
  effectiveFrom: string;
  effectiveTo: string | null;
}

/**
 * Finds the date a new assignment may start on without being dated before the one it replaces.
 *
 * Other suites move the shared fixtures between positions, sometimes with a far-future start date, and a
 * transfer dated before the open assignment is refused. So the new assignment starts today, or on the open
 * assignment's own start date when that is later.
 *
 * Args:
 *   app: The running test application.
 *   positionManager: A session allowed to read position history.
 *   employeeId: The employee about to be transferred.
 *
 * Returns:
 *   A `YYYY-MM-DD` date that is not before the employee's open assignment.
 */
async function _transferDateFor(
  app: NestFastifyApplication,
  positionManager: Session,
  employeeId: string,
): Promise<string> {
  const history = await apiRequest(
    app,
    positionManager,
    'GET',
    `/positions/employees/${employeeId}/history`,
  );
  expect(history.status).toBe(200);
  const openAssignment = unwrap<PositionAssignmentRow[]>(history.body).find(
    (assignment) => assignment.effectiveTo === null,
  );
  const today = _todayInHoChiMinh();
  return openAssignment && openAssignment.effectiveFrom > today
    ? openAssignment.effectiveFrom
    : today;
}

/**
 * Gives an employee a weekly work-from-home allowance by seating them in a position of a new rank.
 *
 * Creates, through the real API, a rank carrying `wfh_weekly_days = weeklyDays`, a position of that rank, and
 * an assignment of the employee to it — moving them out of whatever position they held. The ordinal and the
 * codes are unique per call, because ranks and positions are shared across the suites in one database.
 *
 * Args:
 *   app: The running test application.
 *   positionManager: A session holding `position.manage`, such as the HR fixture.
 *   employeeId: The employee to give the allowance to.
 *   weeklyDays: The `wfh_weekly_days` value of the new rank; 0 gives a rank with no allowance.
 *   uniqueTag: A short string that is unique across the run, used in the rank name and position code.
 *
 * Returns:
 *   The ids of the rank and the position it created.
 */
export async function giveWeeklyWfhAllowance(
  app: NestFastifyApplication,
  positionManager: Session,
  employeeId: string,
  weeklyDays: number,
  uniqueTag: string,
): Promise<{ rankId: string; positionId: string }> {
  const ranksResponse = await apiRequest(app, positionManager, 'GET', '/job-ranks');
  expect(ranksResponse.status).toBe(200);
  const highestOrdinal = Math.max(
    0,
    ...unwrap<JobRankRow[]>(ranksResponse.body).map((r) => r.ordinal),
  );

  const rankResponse = await apiRequest(app, positionManager, 'POST', '/job-ranks', {
    ordinal: highestOrdinal + 1,
    name: `E2E rank ${uniqueTag}`,
  });
  expect(rankResponse.status, JSON.stringify(rankResponse.body)).toBe(201);
  const { id: rankId } = unwrap<{ id: string }>(rankResponse.body);

  const benefitResponse = await apiRequest(
    app,
    positionManager,
    'PUT',
    `/job-ranks/${rankId}/benefits`,
    { benefits: [{ benefitCode: 'wfh_weekly_days', value: weeklyDays }] },
  );
  expect(benefitResponse.status, JSON.stringify(benefitResponse.body)).toBe(200);

  const positionResponse = await apiRequest(app, positionManager, 'POST', '/positions', {
    code: `E2E-WFH-${uniqueTag}`.toUpperCase(),
    title: 'E2E WFH engineer',
    department: `E2E-WFH-${uniqueTag}`,
    rankId,
    headcount: 1,
  });
  expect(positionResponse.status, JSON.stringify(positionResponse.body)).toBe(201);
  const { id: positionId } = unwrap<{ id: string }>(positionResponse.body);

  const assignment = await apiRequest(
    app,
    positionManager,
    'POST',
    `/positions/${positionId}/assignments`,
    { employeeId, effectiveFrom: await _transferDateFor(app, positionManager, employeeId) },
  );
  expect(assignment.status, JSON.stringify(assignment.body)).toBe(201);

  return { rankId, positionId };
}
