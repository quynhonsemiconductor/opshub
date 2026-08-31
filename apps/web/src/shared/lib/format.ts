/**
 * Display formatting for dates, numbers and absent values.
 *
 * WHY THESE ARE NOT INLINE
 * ------------------------
 * `new Date(x).toLocaleDateString()` appeared 25 times across nine pages, and it is wrong in three
 * ways that only show up in production:
 *
 *  1. IT THROWS NOTHING AND SHOWS "Invalid Date" for a null or an empty string. Several call sites
 *     pass a nullable API field straight in, so a record with no date renders that string in the
 *     middle of a table.
 *  2. IT IS LOCALE-DEPENDENT with no locale given, so `03/04` means March in one browser and April
 *     in another. For a leave window or a contract end date, that is not cosmetic.
 *  3. A `date` COLUMN IS NOT AN INSTANT. `workforce.leave_requests.start_date` is a calendar date and
 *     the API returns `YYYY-MM-DD`; `new Date('2026-03-04')` parses that as UTC midnight, which in
 *     any timezone behind UTC renders as the 3rd. The API-level code takes care to parse and read
 *     dates in the same frame (see `working-days.ts`); the SPA was undoing it on the way to the
 *     screen.
 *
 * So: an explicit locale, an em dash for absent values, and `formatDate` treats a bare `YYYY-MM-DD`
 * as the calendar date it is rather than as an instant.
 */

/** What an absent value looks like everywhere in the UI. */
export const EM_DASH = '—';

/**
 * The locale to format in.
 *
 * `en-GB` gives `4 Mar 2026` — unambiguous in a way `03/04/2026` is not, which matters for a product
 * used by people in several countries. Fixed rather than taken from the browser so that a screenshot
 * in a bug report means the same thing as the reporter's screen.
 */
const LOCALE = 'en-GB';

/** True for the `YYYY-MM-DD` a `date` column produces, as opposed to a full timestamp. */
function isCalendarDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * A date for display: `4 Mar 2026`.
 *
 * A bare `YYYY-MM-DD` is formatted from its PARTS, not through the timezone: parsing it as an instant
 * would shift it a day for anybody behind UTC, and a leave request that starts on the 4th must not
 * read as the 3rd because the reader is in Vancouver.
 */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return EM_DASH;

  if (typeof value === 'string' && isCalendarDate(value)) {
    const [year, month, day] = value.split('-').map(Number);
    // `Date.UTC` + a UTC-pinned format keeps the parse frame and the read frame the same.
    return new Intl.DateTimeFormat(LOCALE, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(year, month - 1, day)));
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return EM_DASH;
  return new Intl.DateTimeFormat(LOCALE, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

/**
 * Today, as the `YYYY-MM-DD` a `date` column takes.
 *
 * In the READER'S timezone, which is the right frame for a date they are about to state as a fact —
 * "terminated on", "signed on", "effective from". `toISOString()` would answer in UTC and hand somebody
 * in Vancouver yesterday's date as the default for a form they are filling in this morning.
 *
 * Six places built this expression by hand before it lived here, and one of them was already wrong.
 */
export function todayIso(): string {
  return isoDate(new Date());
}

/** A calendar date `days` from today, in the reader's timezone. Negative goes backwards. */
export function isoDaysFromNow(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return isoDate(date);
}

/**
 * A `YYYY-MM-DD` from a date input, as the ISO instant an API expects for a `timestamptz` field.
 *
 * MIDDAY, not midnight. Several APIs record a human event — a signature, an acknowledgement — as an
 * instant, while the person filling the form only knows the DAY. Midnight is the tempting conversion and
 * it is the one that goes wrong: `new Date('2026-08-11')` is midnight UTC, which reads back as the 10th
 * for anybody west of Greenwich, so a contract signed on the 11th shows as signed on the 10th. Local
 * midday survives being read in any timezone within twelve hours of the writer's.
 *
 * TODAY IS SENT AS NOW, not as midday. Midday today is in the PAST for anybody filling a form after lunch,
 * and several APIs refuse an instant that predates one they already hold: containing a non-conformance
 * detected at 14:35 was rejected with "containment cannot predate detection" every single time, because the
 * form sent midday. An event recorded as happening today happened at some point today, and now is the only
 * instant that is both truthful and never earlier than something else recorded earlier the same day.
 *
 * Returns an empty string for an empty input, so a caller can send `undefined` for "not stated".
 */
export function isoInstantFromDate(date: string): string {
  if (!date) return '';
  if (date === todayIso()) return new Date().toISOString();
  const instant = new Date(`${date}T12:00:00`);
  return Number.isNaN(instant.getTime()) ? '' : instant.toISOString();
}

function isoDate(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * A timestamp for display: `4 Mar 2026, 14:32`.
 *
 * In the reader's own timezone, deliberately — unlike a calendar date, an instant is a moment that
 * happened, and "when did this get approved" is a question about their clock.
 */
export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return EM_DASH;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return EM_DASH;
  return new Intl.DateTimeFormat(LOCALE, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/**
 * The clock time of an instant: `14:32`.
 *
 * WHY THIS IS NOT `toLocaleTimeString([], ...)`. The attendance widget used that, and `[]` means the
 * BROWSER's locale — so "Clocked in at" read `02:32 PM` on one machine and `14:32` on another, while
 * `formatDateTime` a few pixels away always said `14:32`. Two clocks in one view, disagreeing about how
 * to write the same minute.
 *
 * Same fixed locale as every other formatter here, for the same reason: a screenshot in a bug report
 * has to mean what the reporter's screen meant.
 */
export function formatTime(value: string | Date | null | undefined): string {
  if (!value) return EM_DASH;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return EM_DASH;
  return new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' }).format(date);
}

/**
 * How long until an instant, in words: `47m left`, `3h left`, `2d left`, `Expired`.
 *
 * WHY A SEPARATE FORMATTER FROM `formatDateTime`. Some deadlines are read as a MOMENT — "when was this
 * approved" — and some as a REMAINING BUDGET. A time-boxed privileged grant is the second: the question is
 * never "at what o'clock does this lapse", it is "how long do I still hold this". Printing the absolute
 * instant makes the reader do the subtraction, and they do it wrong across a timezone.
 *
 * PAST IS `Expired`, NOT A NEGATIVE. A grant whose window closed is not "-12h left"; it is gone, and the
 * word is what the reader needs. `activity-timeline.tsx` has the mirror of this for the past, kept separate
 * because that one is about how long ago something HAPPENED.
 *
 * Coarse on purpose: one unit, rounded down. "1h left" for anything from an hour to two minutes short of
 * the next is the honest precision for a decision about whether to renew.
 *
 * `now` IS A PARAMETER so this stays a pure function of its inputs. A caller rendering a list should pass
 * the moment its DATA was fetched — React Query's `dataUpdatedAt` — because the list is the server's view as
 * of then, and `Date.now()` inside a render body is what `react-hooks/purity` refuses.
 */
export function formatTimeUntil(
  value: string | Date | null | undefined,
  now: number = Date.now(),
): string {
  if (!value) return EM_DASH;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return EM_DASH;

  const ms = date.getTime() - now;
  if (ms <= 0) return 'Expired';

  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h left`;
  return `${Math.floor(hours / 24)}d left`;
}

/**
 * A `numeric` column for display.
 *
 * The driver hands `numeric` back as a STRING, so these arrive as `'2.50'` and formatting them with
 * `Number()` alone prints `2.5` in one column and `2` in the next. Trailing zeros are dropped and the
 * decimals capped, so half a day of leave reads `2.5` and a whole one reads `2`.
 */
export function formatDecimal(
  value: string | number | null | undefined,
  maximumFractionDigits = 2,
): string {
  if (value === null || value === undefined || value === '') return EM_DASH;
  const n = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(n)) return EM_DASH;
  return new Intl.NumberFormat(LOCALE, { maximumFractionDigits }).format(n);
}

/** Anything absent becomes the em dash; anything present is returned unchanged. */
export function orDash<T>(value: T | null | undefined): T | string {
  return value === null || value === undefined || value === '' ? EM_DASH : value;
}

/**
 * A length of time held in MINUTES, as it is said aloud: `8h 30m`, `8h`, `45m`.
 *
 * `DurationInput` stores minutes — the unit the API accepts — and every sentence ABOUT a duration
 * ("at least 4h") comes through here, so a field's hint, an error message and a table cell cannot
 * grow three spellings of the same length. An absent or negative length is `0m` rather than the em
 * dash: a duration of nothing is a real answer, unlike an absent timestamp.
 */
export function formatDuration(minutes: number): string {
  const total = Math.floor(Math.max(minutes, 0));
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

/**
 * Money held in CENTS, as the API stores it.
 *
 * Integer cents in the database and a formatted string at the edge — never a float in between, which
 * is the whole reason the column is an integer. The finops screen had its own `centsToDollars` with a
 * hard-coded `$`; the currency is a parameter here so a second currency does not need a second
 * function.
 *
 * Under the shared `en-GB` locale this prints `US$12.50` rather than `$12.50`, and that is the point:
 * a product used across countries should not leave a bare dollar sign to mean whichever dollar the
 * reader assumes. Same reasoning as the date format.
 */
export function formatMoney(cents: number | null | undefined, currency = 'USD'): string {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return EM_DASH;
  return new Intl.NumberFormat(LOCALE, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}
