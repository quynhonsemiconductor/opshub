import { describe, expect, it } from 'vitest';
import {
  indexMonth,
  isWorkday,
  monthKey,
  shiftMonth,
  summariseDay,
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
    { employeeId: 'b', date: '2026-10-22', status: 'approved' },
    { employeeId: 'c', date: '2026-10-22', status: 'pending' },
    { employeeId: 'a', date: '2026-10-23', status: 'approved' },
  ],
  pto: [],
  holidays: [{ date: '2026-10-20', name: 'Lễ' }],
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

describe('working days and holidays', () => {
  it('treats Monday to Friday as working days', () => {
    expect(isWorkday('2026-10-23')).toBe(true); // Fri
    expect(isWorkday('2026-10-24')).toBe(false); // Sat
    expect(isWorkday('2026-10-25')).toBe(false); // Sun
    expect(isWorkday('not-a-date')).toBe(false);
  });
  it('indexes the month public holidays by date', () => {
    expect(indexMonth(MONTH).holidays.get('2026-10-20')).toBe('Lễ');
    expect(indexMonth(MONTH).holidays.has('2026-10-21')).toBe(false);
  });
});

describe('summariseDay', () => {
  const index = indexMonth(MONTH);
  it('counts only APPROVED marks as WFH; a pending one is its own list, not the office', () => {
    const day = summariseDay('2026-10-22', PEOPLE, index);
    expect(day.wfh.map((p) => p.name)).toEqual(['Binh']);
    expect(day.pendingWfh.map((p) => p.name)).toEqual(['Chi']);
    expect(day.office.map((p) => p.name)).toEqual(['An']);
    expect(day.pto).toEqual([]);
  });
  it('puts everyone in the office on a day nobody asked about — the default', () => {
    const day = summariseDay('2026-10-26', PEOPLE, index);
    expect(day.wfh).toEqual([]);
    expect(day.pendingWfh).toEqual([]);
    expect(day.office).toHaveLength(3);
  });
  it('prefers an approved mark over a pending one for the same person and day', () => {
    const both = indexMonth({
      ...MONTH,
      wfh: [
        ...MONTH.wfh,
        { employeeId: 'b', date: '2026-10-23', status: 'pending' },
        { employeeId: 'b', date: '2026-10-23', status: 'approved' },
      ],
    });
    const day = summariseDay('2026-10-23', PEOPLE, both);
    expect(day.wfh.map((p) => p.name)).toEqual(['An', 'Binh']);
    expect(day.pendingWfh).toEqual([]);
  });
  it('copes with a month that has not loaded yet', () => {
    expect(summariseDay('2026-10-22', [], indexMonth(undefined))).toEqual({
      wfh: [],
      pendingWfh: [],
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
      { employeeId: 'b', date: '2026-10-22', portion: 'full_day' }, // also approved WFH that day
      { employeeId: 'c', date: '2026-10-23', portion: 'morning' },
    ],
  });
  it('takes somebody on leave all day out of the office and WFH lists', () => {
    const day = summariseDay('2026-10-22', PEOPLE, withLeave);
    expect(day.pto.map((p) => p.name)).toEqual(['An', 'Binh']);
    expect(day.wfh.map((p) => p.name)).toEqual([]);
    expect(day.office).toEqual([]);
    expect(day.pendingWfh.map((p) => p.name)).toEqual(['Chi']);
  });
  it('lets leave win over an approved WFH mark, because somebody on leave is not working from home', () => {
    const day = summariseDay('2026-10-22', PEOPLE, withLeave);
    expect(day.wfh.map((p) => p.id)).not.toContain('b');
  });
  it('keeps a half day of leave in the office or WFH list and says which half', () => {
    const day = summariseDay('2026-10-23', PEOPLE, withLeave);
    expect(day.pto).toEqual([]);
    expect(day.office.map((p) => p.name)).toContain('Chi');
    expect(day.partial.get('c')).toBe('morning');
    // An's approved WFH that day is unaffected.
    expect(day.wfh.map((p) => p.name)).toEqual(['An']);
  });
});
