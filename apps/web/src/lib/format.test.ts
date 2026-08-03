/**
 * Dashboard formatting.
 *
 * The unit decisions are the point. Bytes are quoted in the units a host bills
 * in, and an absent value has to look different from a zero — an operator
 * reading "0%" packet loss when the truth is "not measured" would draw exactly
 * the wrong conclusion.
 */
import { describe, expect, it } from 'vitest';
import {
  countryName,
  formatAgo,
  formatBytes,
  formatCounts,
  formatDuration,
  formatMb,
  formatMs,
  formatPercent,
} from './format';

describe('formatBytes', () => {
  it('uses the powers of 1000 a transfer allowance is quoted in', () => {
    // The whole reason this is not 1024: a provider's "1 TB" is this many bytes,
    // and showing TiB would disagree with the invoice by about 10%.
    expect(formatBytes(1_000_000_000_000)).toBe('1 TB');
    expect(formatBytes(1_000_000_000)).toBe('1 GB');
    expect(formatBytes(1_500_000_000)).toBe('1.5 GB');
    expect(formatBytes(1000)).toBe('1 kB');
  });

  it('drops the decimal once it stops being information', () => {
    expect(formatBytes(99_400_000_000)).toBe('99.4 GB');
    expect(formatBytes(847_300_000_000)).toBe('847 GB');
  });

  it('holds the unit until the next one is warranted', () => {
    expect(formatBytes(999_000_000_000)).toBe('999 GB');
    expect(formatBytes(999_999_999_999)).toBe('1 TB');
  });

  it('treats nothing, and nonsense, as zero rather than NaN', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
  });
});

describe('absent values', () => {
  it('never renders as zero', () => {
    // Packet loss of null means "not measured"; 0 means "measured, none lost".
    expect(formatPercent(null)).toBe('—');
    expect(formatPercent(undefined)).toBe('—');
    expect(formatPercent(0)).toBe('0%');
    expect(formatMs(null)).toBe('—');
    expect(formatMs(0)).toBe('0 ms');
  });

  it('says never rather than guessing at a missing timestamp', () => {
    expect(formatAgo(null)).toBe('never');
  });
});

describe('formatAgo', () => {
  const now = 1_800_000_000_000;

  it('reports seconds, then minutes', () => {
    expect(formatAgo(now - 12_000, now)).toBe('12s ago');
    expect(formatAgo(now - 59_000, now)).toBe('59s ago');
    expect(formatAgo(now - 600_000, now)).toBe('10m ago');
  });

  it('clamps clock skew instead of reporting the future', () => {
    // The server's clock against the browser's; a few seconds either way is
    // normal and "-3s ago" is not a thing to show anyone.
    expect(formatAgo(now + 3_000, now)).toBe('0s ago');
  });
});

describe('formatDuration and formatMb', () => {
  it('steps up units as the magnitude grows', () => {
    expect(formatDuration(90)).toBe('2m');
    expect(formatDuration(7_200)).toBe('2h');
    expect(formatDuration(172_800)).toBe('2d');
    expect(formatMb(512)).toBe('512 MB');
    expect(formatMb(2_048)).toBe('2 GB');
  });
});

describe('formatCounts', () => {
  it('lists what is present and omits what is not', () => {
    expect(formatCounts({ audio: 5, video: 4 })).toBe('audio 5 · video 4');
    // A zero here means a transport nobody is using; listing it is noise.
    expect(formatCounts({ udp: 7, tcp: 0 })).toBe('udp 7');
    expect(formatCounts({})).toBe('');
  });
});

describe('countryName', () => {
  it('names countries and the server marker for an unresolved address', () => {
    expect(countryName('DE')).toBe('Germany');
    expect(countryName('AU')).toBe('Australia');
    expect(countryName('ZZ')).toBe('Unresolved');
  });

  it('falls back to the code rather than throwing on a bad one', () => {
    // The code originates in a database file this app did not write.
    expect(countryName('QQ')).toBe('QQ');
    expect(countryName('')).toBe('');
  });
});
