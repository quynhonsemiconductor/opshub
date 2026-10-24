import { describe, expect, it } from 'vitest';
import {
  indexMonth,
  isEditable,
  isWorkday,
  monthKey,
  shiftMonth,
  summariseDay,
  withMark,
  type WioMonth,
} from './wio-calendar-model';

const PEOPLE = [
  { id: 'a', name: 'An', department: 'IT' },
  { id: 'b', name: 'Binh', department: null },
  { id: 'c', name: 'Chi', department: 'HR' },
];
const MONTH: WioMonth = {
  month: '2026-10',
  people: PEOPLE,
  wfh: [
    { employeeId: 'b', date: '2026-10-22' },
    { employeeId: 'c', date: '2026-10-22' },
    { employeeId: 'a', date: '2026-10-23' },
  ],
  pto: [],
};

describe('month navigation', () => {
  it('keys a month as YYYY-MM from a zero-based month', () => {
    expect(monthKey({ y: 2026, m: 9 })).toBe('2026-10');
    expect(monthKey({ y: 2026, m: 0 })).toBe('2026-01');
  });
  it('rolls the year in both directions', () => {
    expect(shiftMonth({ y: 2026, m: 11 }, 1)).toEqual({ y: 2027, m: 0 });
    expect(shiftMonth({ y: 2026, m: 0 }, -1)).toEqual({ y: 2025, m: 11 });
  });
});

describe('who can mark what', () => {
  it('treats Monday to Friday as working days', () => {
    expect(isWorkday('2026-10-23')).toBe(true); // Fri
    expect(isWorkday('2026-10-24')).toBe(false); // Sat
    expect(isWorkday('2026-10-25')).toBe(false); // Sun
    expect(isWorkday('not-a-date')).toBe(false);
  });
  it('allows today and later working days only', () => {
    expect(isEditable('2026-10-21', '2026-10-21')).toBe(true);
    expect(isEditable('2026-10-20', '2026-10-21')).toBe(false); // past
    expect(isEditable('2026-10-24', '2026-10-21')).toBe(false); // weekend
  });
});

describe('summariseDay', () => {
  const index = indexMonth(MONTH);
  it('lists marked people as WFH and everyone else as in the office', () => {
    const day = summariseDay('2026-10-22', PEOPLE, index);
    expect(day.wfh.map((p) => p.name)).toEqual(['Binh', 'Chi']);
    expect(day.office.map((p) => p.name)).toEqual(['An']);
    expect(day.pto).toEqual([]);
  });
  it('puts everyone in the office on a day nobody marked — the default', () => {
    const day = summariseDay('2026-10-26', PEOPLE, index);
    expect(day.wfh).toEqual([]);
    expect(day.office).toHaveLength(3);
  });
  it('copes with a month that has not loaded yet', () => {
    expect(summariseDay('2026-10-22', [], indexMonth(undefined))).toEqual({
      wfh: [],
      office: [],
      pto: [],
      partial: new Map(),
    });
  });
});

describe('summariseDay with leave', () => {
  const withLeave = indexMonth({
    ...MONTH,
    pto: [
      { employeeId: 'a', date: '2026-10-22', portion: 'full_day' },
      { employeeId: 'b', date: '2026-10-22', portion: 'full_day' }, // also ticked WFH that day
      { employeeId: 'c', date: '2026-10-23', portion: 'morning' },
    ],
  });
  it('takes somebody on leave all day out of the office and WFH lists', () => {
    const day = summariseDay('2026-10-22', PEOPLE, withLeave);
    expect(day.pto.map((p) => p.name)).toEqual(['An', 'Binh']);
    expect(day.wfh.map((p) => p.name)).toEqual(['Chi']);
    expect(day.office).toEqual([]);
  });
  it('lets leave win over a WFH tick, because somebody on leave is not working from home', () => {
    const day = summariseDay('2026-10-22', PEOPLE, withLeave);
    expect(day.wfh.map((p) => p.id)).not.toContain('b');
  });
  it('keeps a half day of leave in the office or WFH list and says which half', () => {
    const day = summariseDay('2026-10-23', PEOPLE, withLeave);
    expect(day.pto).toEqual([]);
    expect(day.office.map((p) => p.name)).toContain('Chi');
    expect(day.partial.get('c')).toBe('morning');
    // An's own WFH tick that day is unaffected.
    expect(day.wfh.map((p) => p.name)).toEqual(['An']);
  });
});

describe('withMark', () => {
  it('adds a mark, and a second add does not duplicate it', () => {
    const once = withMark(MONTH, '2026-10-26', 'a', true);
    const twice = withMark(once, '2026-10-26', 'a', true);
    expect(twice.wfh.filter((m) => m.date === '2026-10-26')).toHaveLength(1);
  });
  it('clears only that person on that day', () => {
    const cleared = withMark(MONTH, '2026-10-22', 'b', false);
    expect(cleared.wfh).toContainEqual({ employeeId: 'c', date: '2026-10-22' });
    expect(cleared.wfh).not.toContainEqual({ employeeId: 'b', date: '2026-10-22' });
    expect(cleared.wfh).toHaveLength(2);
  });
  it('does not mutate the month it was given', () => {
    const before = JSON.stringify(MONTH);
    withMark(MONTH, '2026-10-22', 'b', false);
    expect(JSON.stringify(MONTH)).toBe(before);
  });
});
