import { describe, expect, test, vi } from 'vitest';
import { buildIcs, nextHalfHour, toDateTimeLocal } from './calendar';

const base = {
  title: 'Standup',
  start: new Date('2026-08-03T09:30:00Z'),
  durationMinutes: 30,
  meetingUrl: 'https://meet.example.com/r/k7de-2mqx-9hbt#k=' + 'A'.repeat(43),
};

function lines(ics: string): string[] {
  return ics.split('\r\n');
}

describe('buildIcs', () => {
  test('produces a well-formed calendar object', () => {
    const ics = buildIcs(base);
    expect(lines(ics)[0]).toBe('BEGIN:VCALENDAR');
    expect(lines(ics)).toContain('VERSION:2.0');
    expect(lines(ics)).toContain('END:VCALENDAR');
    expect(lines(ics)).toContain('BEGIN:VEVENT');
    expect(lines(ics)).toContain('END:VEVENT');
  });

  test('uses CRLF line endings throughout', () => {
    // RFC 5545 requires CRLF. Some parsers tolerate bare LF; Outlook does not.
    const ics = buildIcs(base);
    const bareLf = ics.split('\n').filter((line) => !line.endsWith('\r'));
    // Only the trailing empty string after the final CRLF may lack a \r.
    expect(bareLf).toEqual(['']);
  });

  test('start and end reflect the duration', () => {
    const ics = buildIcs(base);
    expect(lines(ics)).toContain('DTSTART:20260803T093000Z');
    expect(lines(ics)).toContain('DTEND:20260803T100000Z');
  });

  test('the meeting URL survives folding intact', () => {
    // The URL exceeds 75 octets so it is necessarily folded. What matters is
    // that a client unfolding it recovers the exact link — a corrupted key
    // means an invitation nobody can join.
    const ics = buildIcs(base);
    const unfolded = ics.replace(/\r\n /g, '');
    expect(unfolded).toContain(`URL:${base.meetingUrl}`);
    expect(unfolded).toContain('A'.repeat(43));
  });

  test('special characters in the title are escaped', () => {
    // Unescaped commas and semicolons terminate the property value and corrupt
    // every field after them.
    const ics = buildIcs({ ...base, title: 'Q3 planning; budget, scope' });
    expect(ics).toContain('SUMMARY:Q3 planning\\; budget\\, scope');
  });

  test('backslashes are escaped before other characters', () => {
    // Order matters: escaping backslash last would double-escape the ones
    // introduced for commas and semicolons.
    const ics = buildIcs({ ...base, title: 'a\\b,c' });
    expect(ics).toContain('SUMMARY:a\\\\b\\,c');
  });

  test('every line stays within 75 octets', () => {
    const ics = buildIcs({ ...base, title: 'x'.repeat(300) });
    for (const line of lines(ics)) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
  });

  test('folded continuation lines begin with a space', () => {
    const ics = buildIcs({ ...base, title: 'y'.repeat(200) });
    const folded = lines(ics).filter((line) => line.startsWith(' '));
    expect(folded.length).toBeGreaterThan(0);
  });

  test('folding never splits a multi-byte character', () => {
    // Naive folding by string length cuts UTF-8 sequences in half and corrupts
    // any non-ASCII title.
    const ics = buildIcs({ ...base, title: '会議'.repeat(60) });
    const unfolded = lines(ics)
      .map((line) => (line.startsWith(' ') ? line.slice(1) : `\n${line}`))
      .join('');
    expect(unfolded).toContain('会議'.repeat(60));
    expect(ics).not.toContain('�');
  });

  test('each event gets a unique identifier', () => {
    const uids = new Set(
      Array.from({ length: 50 }, () =>
        lines(buildIcs(base)).find((line) => line.startsWith('UID:')),
      ),
    );
    expect(uids.size).toBe(50);
  });

  test('a reminder alarm is included', () => {
    expect(lines(buildIcs(base))).toContain('BEGIN:VALARM');
  });
});

describe('time helpers', () => {
  test('nextHalfHour is always in the future, at every minute of the hour', () => {
    // The failure only appears at exactly half past, where rounding to :30
    // returns a time the clock has already passed. Checking one real "now"
    // catches it once an hour; sweeping every minute catches it always.
    vi.useFakeTimers();
    try {
      for (let minute = 0; minute < 60; minute++) {
        const now = new Date(2026, 7, 3, 10, minute, 37, 0);
        vi.setSystemTime(now);

        const next = nextHalfHour();
        expect(next.getTime(), `minute ${minute}`).toBeGreaterThan(now.getTime());
        expect([0, 30], `minute ${minute}`).toContain(next.getMinutes());
      }
    } finally {
      vi.useRealTimers();
    }
  });

  test('nextHalfHour lands on :00 or :30 in the future', () => {
    const next = nextHalfHour();
    expect([0, 30]).toContain(next.getMinutes());
    expect(next.getSeconds()).toBe(0);
    expect(next.getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  test('toDateTimeLocal emits the format a datetime-local input expects', () => {
    // Must be local time, not UTC — otherwise the picker shows the wrong hour.
    const formatted = toDateTimeLocal(new Date(2026, 7, 3, 9, 5));
    expect(formatted).toBe('2026-08-03T09:05');
  });
});
