import { describe, expect, it } from 'vitest';
import {
  computeAttendanceDay,
  type AttendanceDayInputs,
  type AttendanceDay,
} from './attendance-day';

/**
 * The exhaustive table for the day computation — the ladder (holiday > full-day leave > WFH >
 * swipes > absent), the worked formula (span minus lunch overlap, capped; extra is overtime's),
 * the half-day threshold shifts, and what an approved justification repairs.
 *
 * Rows are written as whole days rather than one axis at a time, because the rules are about
 * combinations: "one swipe", "late after a morning of leave", "justified but on holiday" —
 * axis-per-test would re-derive the interactions instead of pinning them.
 */
const day = (over: Partial<AttendanceDayInputs>): AttendanceDayInputs => ({
  date: '2026-10-21', // a Wednesday
  holiday: false,
  leave: null,
  wfh: false,
  justified: false,
  firstIn: null,
  lastOut: null,
  swipeCount: 0,
  ...over,
});

const result = (over: Partial<AttendanceDay>): AttendanceDay => ({
  date: '2026-10-21',
  status: 'office',
  workedMinutes: 0,
  lateMinutes: null,
  earlyMinutes: null,
  flags: [],
  ...over,
});

describe('the ladder', () => {
  it.each([
    [
      'holiday beats everything, including approved WFH and a full swipe day',
      day({
        holiday: true,
        wfh: true,
        leave: 'full_day',
        justified: true,
        firstIn: '07:30',
        lastOut: '18:30',
        swipeCount: 8,
      }),
      result({ status: 'holiday', workedMinutes: 0 }),
    ],
    [
      'full-day leave beats approved WFH',
      day({ leave: 'full_day', wfh: true }),
      result({ status: 'leave', workedMinutes: 0 }),
    ],
    [
      'full-day leave beats swipes',
      day({ leave: 'full_day', firstIn: '08:00', lastOut: '17:00', swipeCount: 2 }),
      result({ status: 'leave', workedMinutes: 0 }),
    ],
    [
      'approved WFH is a full day, no swipes needed',
      day({ wfh: true }),
      result({ status: 'wfh', workedMinutes: 480 }),
    ],
    [
      'approved WFH beats swipes and flags',
      day({ wfh: true, firstIn: '10:00', lastOut: '15:00', swipeCount: 2 }),
      result({ status: 'wfh', workedMinutes: 480 }),
    ],
    [
      'a plain full office day',
      day({ firstIn: '08:00', lastOut: '17:00', swipeCount: 2 }),
      result({ status: 'office', workedMinutes: 480 }),
    ],
    [
      'no swipes and no request is absent — "vắng không phép"',
      day({}),
      result({ status: 'absent', workedMinutes: 0, flags: ['absent'] }),
    ],
  ])('%s', (_name, input, expected) => {
    expect(computeAttendanceDay(input)).toEqual(expected);
  });
});

describe('the worked formula', () => {
  it.each([
    [
      'a span straddling lunch loses exactly the lunch hour',
      day({ firstIn: '08:00', lastOut: '17:00', swipeCount: 2 }),
      480,
    ],
    [
      'a span inside the morning does not lose lunch',
      day({ firstIn: '08:00', lastOut: '12:00', swipeCount: 2 }),
      240,
    ],
    [
      'a span inside the afternoon does not lose lunch',
      day({ firstIn: '13:00', lastOut: '17:00', swipeCount: 2 }),
      240,
    ],
    [
      'arriving during lunch loses the rest of it',
      day({ firstIn: '12:30', lastOut: '17:00', swipeCount: 2 }),
      240,
    ],
    [
      'leaving during lunch loses the start of it',
      day({ firstIn: '08:00', lastOut: '12:30', swipeCount: 2 }),
      240,
    ],
    [
      "a long day is capped at 8h — extra time is overtime's to authorize",
      day({ firstIn: '07:00', lastOut: '19:00', swipeCount: 2 }),
      480,
    ],
    [
      'a short day is the span minus lunch',
      day({ firstIn: '08:00', lastOut: '15:00', swipeCount: 2 }),
      360,
    ],
  ])('%s', (_name, input, workedMinutes) => {
    expect(computeAttendanceDay(input).workedMinutes).toBe(workedMinutes);
  });
});

describe('late and early', () => {
  it.each([
    [
      'on time, leaves on time: no flags',
      day({ firstIn: '08:00', lastOut: '17:00', swipeCount: 2 }),
      result({ workedMinutes: 480 }),
    ],
    [
      'late by 30 minutes',
      day({ firstIn: '08:30', lastOut: '17:00', swipeCount: 2 }),
      result({ workedMinutes: 450, lateMinutes: 30, flags: ['late'] }),
    ],
    [
      'early by 60 minutes',
      day({ firstIn: '08:00', lastOut: '16:00', swipeCount: 2 }),
      result({ workedMinutes: 420, earlyMinutes: 60, flags: ['early'] }),
    ],
    [
      'late and early on the same day',
      day({ firstIn: '09:00', lastOut: '15:00', swipeCount: 2 }),
      result({ workedMinutes: 300, lateMinutes: 60, earlyMinutes: 120, flags: ['late', 'early'] }),
    ],
  ])('%s', (_name, input, expected) => {
    expect(computeAttendanceDay(input)).toEqual(expected);
  });
});

describe('exactly one swipe', () => {
  it.each([
    [
      'is missing_checkout, and credits nothing until measured or justified',
      day({ firstIn: '08:00', swipeCount: 1 }),
      result({ workedMinutes: 0, flags: ['missing_checkout'] }),
    ],
    [
      'still reports how late the one swipe was',
      day({ firstIn: '09:15', swipeCount: 1 }),
      result({ workedMinutes: 0, lateMinutes: 75, flags: ['missing_checkout'] }),
    ],
    [
      'an approved justification credits the day and clears the flag',
      day({ firstIn: '08:00', swipeCount: 1, justified: true }),
      result({ workedMinutes: 480 }),
    ],
  ])('%s', (_name, input, expected) => {
    expect(computeAttendanceDay(input)).toEqual(expected);
  });
});

describe('half-day leave shifts the thresholds', () => {
  it.each([
    [
      'morning off: 13:00 is on time, 12:30 is late',
      day({ leave: 'morning', firstIn: '13:00', lastOut: '17:00', swipeCount: 2 }),
      result({ workedMinutes: 240 }),
    ],
    [
      'morning off and arriving at 12:30 — still lunch, so on time',
      day({ leave: 'morning', firstIn: '12:30', lastOut: '17:00', swipeCount: 2 }),
      result({ workedMinutes: 240 }),
    ],
    [
      'afternoon off: leaving at 12:00 is on time, 11:00 is early',
      day({ leave: 'afternoon', firstIn: '08:00', lastOut: '11:00', swipeCount: 2 }),
      result({ workedMinutes: 180, earlyMinutes: 60, flags: ['early'] }),
    ],
    [
      'afternoon off and leaving at 12:00',
      day({ leave: 'afternoon', firstIn: '08:00', lastOut: '12:00', swipeCount: 2 }),
      result({ workedMinutes: 240 }),
    ],
    [
      'afternoon off: a day that ran into the afternoon is capped at the half, no flag',
      day({ leave: 'afternoon', firstIn: '08:00', lastOut: '15:00', swipeCount: 2 }),
      result({ workedMinutes: 240 }),
    ],
    [
      'morning off, no swipes in the afternoon: absent',
      day({ leave: 'morning' }),
      result({ status: 'absent', workedMinutes: 0, flags: ['absent'] }),
    ],
    [
      'morning off, one swipe, justified: the half is credited',
      day({ leave: 'morning', firstIn: '13:00', swipeCount: 1, justified: true }),
      result({ workedMinutes: 240 }),
    ],
  ])('%s', (_name, input, expected) => {
    expect(computeAttendanceDay(input)).toEqual(expected);
  });
});

describe('unsynced terminal times', () => {
  it.each([
    [
      'a spanned day built on fallback times keeps its minutes and says so',
      day({ firstIn: '08:00', lastOut: '17:00', swipeCount: 2, unsynced: true }),
      result({ workedMinutes: 480, flags: ['unsynced'] }),
    ],
    [
      'the flag survives a justification — a justification explains the person, not the clock',
      day({ firstIn: '08:00', lastOut: '17:00', swipeCount: 2, unsynced: true, justified: true }),
      result({ workedMinutes: 480, lateMinutes: null, earlyMinutes: null, flags: ['unsynced'] }),
    ],
    [
      'a single unsynced swipe reports both problems',
      day({ firstIn: '08:00', swipeCount: 1, unsynced: true }),
      result({ workedMinutes: 0, flags: ['missing_checkout', 'unsynced'] }),
    ],
  ])('%s', (_name, input, expected) => {
    expect(computeAttendanceDay(input)).toEqual(expected);
  });
});

describe('an approved justification', () => {
  it.each([
    [
      'credits a full absent day — the forgot_card case',
      day({ justified: true }),
      result({ status: 'office', workedMinutes: 480 }),
    ],
    [
      'clears late and early flags but keeps reporting the times',
      day({ firstIn: '09:00', lastOut: '15:00', swipeCount: 2, justified: true }),
      result({ workedMinutes: 480, lateMinutes: 60, earlyMinutes: 120 }),
    ],
    [
      'does not outrank the ladder: a holiday stays a holiday',
      day({ holiday: true, justified: true }),
      result({ status: 'holiday', workedMinutes: 0 }),
    ],
    [
      'does not outrank full-day leave',
      day({ leave: 'full_day', justified: true }),
      result({ status: 'leave', workedMinutes: 0 }),
    ],
    [
      'does not outrank approved WFH',
      day({ wfh: true, justified: true }),
      result({ status: 'wfh', workedMinutes: 480 }),
    ],
  ])('%s', (_name, input, expected) => {
    expect(computeAttendanceDay(input)).toEqual(expected);
  });
});
