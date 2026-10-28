/**
 * One working day of attendance, derived — never stored.
 *
 * The rules (owner decisions 2026-10-28): Mon–Fri, 08:00–17:00 Asia/Ho_Chi_Minh, lunch 12:00–13:00,
 * so a full day is 8 h. Every non-office day is a manager-approved request (leave, wfh, or an
 * attendance justification); everything else is read off the door swipes.
 *
 * PURE ON PURPOSE. Every input is a calendar date or a local-Ho_Chi_Minh `HH:MM` string, never an
 * instant, so the whole ladder — precedence, the worked formula, the flags — is testable over odd
 * combinations without a database or a clock, and the exhaustive table in `attendance-day.spec.ts`
 * is the spec, not a sample.
 */

/** Work starts. A late flag is measured from here (13:00 when the morning is leave). */
export const DAY_START = '08:00';
/** Work ends. An early flag is measured from here (12:00 when the afternoon is leave). */
export const DAY_END = '17:00';
/** Lunch, excluded from the worked span when the swipes straddle it. */
export const LUNCH_START = '12:00';
export const LUNCH_END = '13:00';
/** A full working day, in minutes. */
export const FULL_DAY_MINUTES = 480;
/** Half a working day, in minutes — what half-day leave leaves to work. */
export const HALF_DAY_MINUTES = 240;

export type AttendanceStatus = 'holiday' | 'leave' | 'wfh' | 'office' | 'absent';

/** What a manager can be asked to sign off to repair a day. */
export type JustificationKind = 'late' | 'early' | 'forgot_card' | 'missing_checkout';

/** The unresolved problems of a day, in the order a reader meets them. */
export type DayFlag = 'late' | 'early' | 'missing_checkout' | 'absent' | 'unsynced';

/** Which half of the day approved leave takes, if any. */
export type LeavePortion = 'full_day' | 'morning' | 'afternoon';

export interface AttendanceDayInputs {
  date: string;
  /**
   * The day's swipes carried no device clock, so their times are the server's receive times —
   * honest, but not what the terminal read. An informational flag: the minutes stand, the
   * asterisk travels with them.
   */
  unsynced?: boolean;
  /** A public holiday. Wins over everything — nobody is expected in. */
  holiday: boolean;
  /** Approved leave covering this date, and which part of the day it takes. */
  leave: LeavePortion | null;
  /** An approved WFH request covering this date. */
  wfh: boolean;
  /** An approved justification covering this date, whatever it justifies. */
  justified: boolean;
  /** First allow swipe of the day on any reader, local time `HH:MM`; null when there was none. */
  firstIn: string | null;
  /** Last allow swipe of the day, local `HH:MM`; null when fewer than two swipes. */
  lastOut: string | null;
  /** How many allow swipes the day has — one is the `missing_checkout` case. */
  swipeCount: number;
}

export interface AttendanceDay {
  date: string;
  status: AttendanceStatus;
  /** Minutes credited for the day: 0 for holiday and leave, 480 for WFH and justified days, else the swipe span. */
  workedMinutes: number;
  /** How far past the day's start the first swipe was, once late. Null when not late. */
  lateMinutes: number | null;
  /** How far before the day's end the last swipe was, once early. Null when not early. */
  earlyMinutes: number | null;
  /** The day's unresolved problems. An approved justification clears all of them. */
  flags: DayFlag[];
}

/** `HH:MM` as minutes since local midnight. */
export function minutesOf(time: string): number {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

/** The overlap of `[aStart, aEnd]` and `[bStart, bEnd]`, in minutes; 0 when they do not touch. */
function overlapMinutes(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/**
 * The ladder, exactly as the rules state it: holiday > approved full-day leave > approved WFH >
 * office swipes > absent. Half-day leave does not remove the person from the office ladder — they
 * work the other half, with the thresholds moved.
 */
export function computeAttendanceDay(input: AttendanceDayInputs): AttendanceDay {
  if (input.holiday) {
    return {
      date: input.date,
      status: 'holiday',
      workedMinutes: 0,
      lateMinutes: null,
      earlyMinutes: null,
      flags: [],
    };
  }
  if (input.leave === 'full_day') {
    // Leave hours belong to the leave module; attendance credits 0 and expects nobody.
    return {
      date: input.date,
      status: 'leave',
      workedMinutes: 0,
      lateMinutes: null,
      earlyMinutes: null,
      flags: [],
    };
  }
  if (input.wfh) {
    // WFH is approved home work: a full day, no swipes expected, nothing to flag.
    return {
      date: input.date,
      status: 'wfh',
      workedMinutes: FULL_DAY_MINUTES,
      lateMinutes: null,
      earlyMinutes: null,
      flags: [],
    };
  }

  // An office day (whole, or the working half of a half-day-leave day).
  const cap = input.leave === null ? FULL_DAY_MINUTES : HALF_DAY_MINUTES;
  // Half-day leave moves the threshold of the half that is worked: morning off — arrive after
  // lunch; afternoon off — leave before it.
  const startThreshold = minutesOf(input.leave === 'morning' ? LUNCH_END : DAY_START);
  const endThreshold = minutesOf(input.leave === 'afternoon' ? LUNCH_START : DAY_END);

  if (input.swipeCount === 0) {
    // No swipes, no request: "vắng không phép". A justified day is the one a `forgot_card` covers.
    const noSwipeFlags: DayFlag[] = input.justified ? [] : ['absent'];
    if (input.unsynced) noSwipeFlags.push('unsynced');
    return {
      date: input.date,
      status: input.justified ? 'office' : 'absent',
      workedMinutes: input.justified ? cap : 0,
      lateMinutes: null,
      earlyMinutes: null,
      flags: noSwipeFlags,
    };
  }

  if (input.swipeCount === 1 || input.lastOut === null) {
    // Exactly one swipe: we know they came but not when they left — the `missing_checkout` case.
    // Worked stays 0 until a second swipe or an approved justification says otherwise: crediting a
    // span nobody measured is how a day becomes 8 h by default.
    const late = input.firstIn !== null && minutesOf(input.firstIn) > startThreshold;
    const flags: DayFlag[] = input.justified ? [] : ['missing_checkout'];
    if (input.unsynced) flags.push('unsynced');
    return {
      date: input.date,
      status: 'office',
      workedMinutes: input.justified ? cap : 0,
      lateMinutes: late ? minutesOf(input.firstIn!) - startThreshold : null,
      earlyMinutes: null,
      flags,
    };
  }

  const firstIn = minutesOf(input.firstIn ?? DAY_START);
  const lastOut = minutesOf(input.lastOut ?? DAY_END);
  // The span between the swipes, minus whatever of lunch it straddles. Capped at the day's length:
  // extra time is what overtime requests are for, not what attendance quietly credits.
  const span = Math.max(
    0,
    lastOut -
      firstIn -
      overlapMinutes(firstIn, lastOut, minutesOf(LUNCH_START), minutesOf(LUNCH_END)),
  );
  // An approved justification credits the full worked part of the day and clears every flag —
  // "the manager accepted the explanation"; anything else is measured time, never assumed.
  const workedMinutes = input.justified ? cap : Math.min(cap, span);
  const lateMinutes = firstIn > startThreshold ? firstIn - startThreshold : null;
  const earlyMinutes = lastOut < endThreshold ? endThreshold - lastOut : null;

  const flags: DayFlag[] = [];
  if (lateMinutes !== null) flags.push('late');
  if (earlyMinutes !== null) flags.push('early');
  // Kept even when justified: a justification explains the person, not the terminal's clock.
  if (input.unsynced) flags.push('unsynced');

  return {
    date: input.date,
    status: 'office',
    workedMinutes,
    lateMinutes,
    earlyMinutes,
    flags: input.justified ? (input.unsynced ? ['unsynced'] : []) : flags,
  };
}
