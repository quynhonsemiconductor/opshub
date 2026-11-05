import type { components } from '@/shared/api/types';

/**
 * The list returns OCCUPANCY, not the bare role: `filled` and `vacancies` alongside the record.
 *
 * That is the shape the screen wants — "2 of 3 filled" is the question a headcount table exists to
 * answer — and it comes from the generated schema rather than being assembled here.
 */
export type Role = components['schemas']['RoleOccupancyResponseDto'];
/*
 * The NAMED read shape. `GET /roles/:id/assignments` returns `RoleAssignmentResponseDto` —
 * the same row plus `employeeName` — while the writes keep the plain one, because a caller who just
 * supplied an employee id does not need it resolved back.
 */
export type RoleAssignment = components['schemas']['RoleAssignmentResponseDto'];

/** A seniority rank with the benefits it carries. */
export type JobRank = components['schemas']['JobRankResponseDto'];
