/**
 * The rules that decide whether a notification is helpful or infuriating are
 * all negative ones — when *not* to fire. Those are the ones worth pinning.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBackgroundNotice } from './useBackgroundNotice';

interface Constructed {
  title: string;
  options: NotificationOptions;
  close: () => void;
}

let constructed: Constructed[] = [];

function installNotification(permission: NotificationPermission) {
  class FakeNotification {
    static permission: NotificationPermission = permission;
    static requestPermission = vi.fn();
    onclick: (() => void) | null = null;
    close = vi.fn();
    tag: string;

    constructor(title: string, options: NotificationOptions = {}) {
      this.tag = options.tag ?? '';
      constructed.push({ title, options, close: this.close });
    }
  }
  vi.stubGlobal('Notification', FakeNotification);
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

beforeEach(() => {
  constructed = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useBackgroundNotice', () => {
  test('stays silent while the tab is visible', () => {
    // The single most important rule. The UI has already shown this on screen;
    // a notification for something the user is looking at is pure noise.
    installNotification('granted');
    setVisibility('visible');

    const { result } = renderHook(() => useBackgroundNotice());
    act(() => result.current.notify({ tag: 'nme-knock', title: 'Someone is waiting' }));

    expect(constructed).toHaveLength(0);
  });

  test('fires when the tab is hidden', () => {
    installNotification('granted');
    setVisibility('hidden');

    const { result } = renderHook(() => useBackgroundNotice());
    act(() => result.current.notify({ tag: 'nme-knock', title: 'Someone is waiting' }));

    expect(constructed).toHaveLength(1);
    expect(constructed[0]?.title).toBe('Someone is waiting');
  });

  test('stays silent without permission', () => {
    for (const permission of ['default', 'denied'] as const) {
      constructed = [];
      installNotification(permission);
      setVisibility('hidden');

      const { result } = renderHook(() => useBackgroundNotice());
      act(() => result.current.notify({ tag: 'nme-knock', title: 'Someone is waiting' }));

      expect(constructed, permission).toHaveLength(0);
    }
  });

  test('does not throw where Notification does not exist', () => {
    // Safari on iOS has historically shipped without it, and a meeting must not
    // fail because an optional courtesy is unavailable.
    vi.stubGlobal('Notification', undefined);
    setVisibility('hidden');

    const { result } = renderHook(() => useBackgroundNotice());
    expect(result.current.permission).toBe('unsupported');
    expect(() => result.current.notify({ tag: 'x', title: 'y' })).not.toThrow();
  });

  test('carries a tag so repeats replace rather than stack', () => {
    // Four people knocking is one situation, not four alarms.
    installNotification('granted');
    setVisibility('hidden');

    const { result } = renderHook(() => useBackgroundNotice());
    act(() => {
      result.current.notify({ tag: 'nme-knock', title: 'Ana is waiting' });
      result.current.notify({ tag: 'nme-knock', title: '2 people are waiting' });
    });

    expect(constructed.map((n) => n.options.tag)).toEqual(['nme-knock', 'nme-knock']);
  });

  test('omits the body when none is given', () => {
    // Chat notifications deliberately pass no body: a notification surfaces on
    // lock screens and shared displays, which is precisely where the message
    // was encrypted to not appear.
    installNotification('granted');
    setVisibility('hidden');

    const { result } = renderHook(() => useBackgroundNotice());
    act(() => result.current.notify({ tag: 'nme-chat', title: 'New message in the meeting' }));

    expect(constructed[0]?.options).not.toHaveProperty('body');
  });

  test('dismisses anything still showing when the meeting ends', () => {
    installNotification('granted');
    setVisibility('hidden');

    const { result, unmount } = renderHook(() => useBackgroundNotice());
    act(() => result.current.notify({ tag: 'nme-knock', title: 'Ana is waiting' }));
    unmount();

    expect(constructed[0]?.close).toHaveBeenCalled();
  });
});
