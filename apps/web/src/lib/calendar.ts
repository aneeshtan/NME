/**
 * iCalendar (.ics) generation.
 *
 * A downloaded file rather than a "add to Google Calendar" deep link, because
 * the meeting URL contains the room's encryption key: a deep link would hand
 * that key to a calendar provider before the user has decided anything. A local
 * file keeps the choice — and the moment of realising there is a choice — with
 * the person making it. The UI states the consequence plainly.
 *
 * RFC 5545 is fussy in ways that break silently: CRLF line endings, escaping in
 * text values, and folding at 75 octets. Outlook in particular rejects files
 * that Apple Calendar tolerates, so the rules are followed exactly.
 */

export interface CalendarEvent {
  title: string;
  /** Local wall-clock start; converted to UTC for the file. */
  start: Date;
  durationMinutes: number;
  meetingUrl: string;
}

/** RFC 5545 UTC timestamp: 20260728T143000Z */
function toUtcStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Escapes a TEXT value. Backslash must be replaced first, or the escapes
 * inserted for the other characters would themselves be escaped.
 */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Folds a line to 75 octets, continuing with a leading space.
 *
 * Measured in UTF-8 bytes, not characters: a naive split by string length can
 * cut a multi-byte character in half and corrupt the file for any non-ASCII
 * meeting title.
 */
function foldLine(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;

  const parts: string[] = [];
  let start = 0;
  const decoder = new TextDecoder();

  while (start < bytes.length) {
    // 74 on continuation lines to leave room for the leading space.
    const limit = parts.length === 0 ? 75 : 74;
    let end = Math.min(start + limit, bytes.length);

    // Walk back off a continuation byte so a code point is never split.
    while (end > start && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;

    parts.push(decoder.decode(bytes.subarray(start, end)));
    start = end;
  }

  return parts.map((part, index) => (index === 0 ? part : ` ${part}`)).join('\r\n');
}

export function buildIcs(event: CalendarEvent): string {
  const end = new Date(event.start.getTime() + event.durationMinutes * 60_000);
  const uid = `${crypto.randomUUID()}@nme`;

  const description = [
    `Join the meeting: ${event.meetingUrl}`,
    '',
    'This link contains the meeting encryption key. Anyone who can read this',
    'invitation can join the call.',
  ].join('\n');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//NME//Meeting//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${toUtcStamp(new Date())}`,
    `DTSTART:${toUtcStamp(event.start)}`,
    `DTEND:${toUtcStamp(end)}`,
    `SUMMARY:${escapeText(event.title)}`,
    `DESCRIPTION:${escapeText(description)}`,
    `URL:${escapeText(event.meetingUrl)}`,
    // A relative alarm is what most people expect from a meeting invite.
    'BEGIN:VALARM',
    'TRIGGER:-PT10M',
    'ACTION:DISPLAY',
    'DESCRIPTION:Meeting starts in 10 minutes',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];

  // RFC 5545 requires CRLF; some parsers accept LF, Outlook does not.
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

/** Triggers a download of the event as an .ics file. */
export function downloadIcs(event: CalendarEvent): void {
  const blob = new Blob([buildIcs(event)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${event.title.replace(/[^\w\s-]/g, '').trim() || 'meeting'}.ics`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  // Revoking immediately can cancel the download in some browsers.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Next half-hour boundary — the most likely intended start time.
 *
 * The comparison is `>=`, not `>`. At exactly half past, `>` would round to the
 * same :30 the clock has already reached and hand back a time in the past,
 * pre-filling the dialog with a start that has already elapsed. The bug only
 * appears during the thirtieth minute of an hour, which is precisely why it is
 * worth pinning down rather than eyeballing.
 */
export function nextHalfHour(): Date {
  const date = new Date();
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() >= 30 ? 60 : 30);
  return date;
}

/** Formats a Date for a `datetime-local` input, which expects local time. */
export function toDateTimeLocal(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}
