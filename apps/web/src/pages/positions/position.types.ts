import type { components } from '@/shared/api/types';

/**
 * The list returns OCCUPANCY, not the bare position: `filled` and `vacancies` alongside the record.
 *
 * That is the shape the screen wants — "2 of 3 filled" is the question a headcount table exists to
 * answer — and it comes from the generated schema rather than being assembled here.
 */
export type Position = components['schemas']['PositionOccupancyResponseDto'];
/*
 * The NAMED read shape. `GET /positions/:id/assignments` returns `PositionAssignmentResponseDto` —
 * the same row plus `employeeName` — while the writes keep the plain one, because a caller who just
 * supplied an employee id does not need it resolved back.
 */
export type PositionAssignment = components['schemas']['PositionAssignmentResponseDto'];

/** A seniority rank with the benefits it carries. */
export type JobRank = components['schemas']['JobRankResponseDto'];
