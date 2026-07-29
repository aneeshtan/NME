import { describe, expect, test } from 'vitest';
import { isValidRoomId, parseMeetingInput } from './room';

describe('isValidRoomId', () => {
  test('accepts the canonical shape', () => {
    expect(isValidRoomId('k7de-2mqx-9hbt')).toBe(true);
  });

  test('rejects excluded and out-of-alphabet characters', () => {
    for (const value of [
      'k7de-2mqx-9hbi', // i is excluded
      'k7de-2mqx-9hb1', // 1 is excluded
      'k7de-2mqx-9hbl', // l is excluded
      'k7de-2mqx-9hb0', // 0 is excluded
      'K7DE-2MQX-9HBT', // uppercase
      'k7de2mqx9hbt',
      'k7de-2mqx',
      '',
    ]) {
      expect(isValidRoomId(value), value).toBe(false);
    }
  });
});

describe('parseMeetingInput', () => {
  test('accepts a bare canonical code', () => {
    expect(parseMeetingInput('k7de-2mqx-9hbt')).toEqual({ roomId: 'k7de-2mqx-9hbt', key: null });
  });

  test('accepts a code typed without hyphens or in uppercase', () => {
    expect(parseMeetingInput('K7DE2MQX9HBT')?.roomId).toBe('k7de-2mqx-9hbt');
    expect(parseMeetingInput('  k7de 2mqx 9hbt  ')?.roomId).toBe('k7de-2mqx-9hbt');
  });

  test('extracts the id and key from a full meeting URL', () => {
    const key = 'A'.repeat(43);
    const result = parseMeetingInput(`https://meet.example.com/r/k7de-2mqx-9hbt#k=${key}`);
    expect(result).toEqual({ roomId: 'k7de-2mqx-9hbt', key });
  });

  test('a URL without a key reports the key as missing rather than inventing one', () => {
    const result = parseMeetingInput('https://meet.example.com/r/k7de-2mqx-9hbt');
    expect(result).toEqual({ roomId: 'k7de-2mqx-9hbt', key: null });
  });

  test('rejects malformed input', () => {
    for (const value of ['', '   ', 'hello', 'https://meet.example.com/', 'https://x.com/r/bad']) {
      expect(parseMeetingInput(value), value).toBeNull();
    }
  });

  test('a foreign host in the pasted link does not change the room id', () => {
    // Only the path matters; we always join on our own origin.
    const result = parseMeetingInput('https://evil.example/r/k7de-2mqx-9hbt#k=' + 'A'.repeat(43));
    expect(result?.roomId).toBe('k7de-2mqx-9hbt');
  });
});
