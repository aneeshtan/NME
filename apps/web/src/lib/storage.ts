/**
 * Local preferences.
 *
 * Only the display name and device toggles are persisted, and only in this
 * browser — there is no profile on the server to correlate. Every access is
 * guarded because `localStorage` throws in private-browsing modes and when a
 * site is blocked from storing data; a failure here must never block a join.
 */

const NAME_KEY = 'nme.displayName';
const PREFS_KEY = 'nme.devicePrefs';

/** Mirrors the server's cap so the input cannot collect what would be rejected. */
export const DISPLAY_NAME_MAX_LENGTH = 32;

export function loadDisplayName(): string {
  try {
    const stored = localStorage.getItem(NAME_KEY);
    if (!stored) return '';
    // Storage is user-writable via devtools, so re-clamp rather than trust it.
    return Array.from(stored.trim()).slice(0, DISPLAY_NAME_MAX_LENGTH).join('');
  } catch {
    return '';
  }
}

export function saveDisplayName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // Storage unavailable — the user simply retypes their name next time.
  }
}

export interface DevicePrefs {
  micEnabled: boolean;
  cameraEnabled: boolean;
}

const DEFAULT_PREFS: DevicePrefs = { micEnabled: true, cameraEnabled: true };

export function loadDevicePrefs(): DevicePrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_PREFS;
    const record = parsed as Record<string, unknown>;
    return {
      micEnabled:
        typeof record.micEnabled === 'boolean' ? record.micEnabled : DEFAULT_PREFS.micEnabled,
      cameraEnabled:
        typeof record.cameraEnabled === 'boolean'
          ? record.cameraEnabled
          : DEFAULT_PREFS.cameraEnabled,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function saveDevicePrefs(prefs: DevicePrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Non-fatal.
  }
}
