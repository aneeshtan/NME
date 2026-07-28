/**
 * Platform-provided background blur.
 *
 * Chrome 114+ on ChromeOS, macOS and Windows can expose the camera's own blur
 * as a MediaStreamTrack constraint, performed by the OS or the camera hardware.
 * Where it exists this is free in every sense — no download, no CPU, no GPU, no
 * extra frame pipeline — so it is always tried before anything is loaded.
 *
 * Two important limits:
 *  - Coverage depends on hardware (Apple Silicon Portrait Effect, Windows
 *    Studio Effects). Nothing on Linux or Android.
 *  - On macOS and ChromeOS the capability is *read-only*: the page can observe
 *    whether the user turned blur on in Control Center, but cannot switch it
 *    on. Only Windows permits `applyConstraints`.
 */

export type NativeBlurSupport =
  /** No platform blur at all. */
  | { kind: 'none' }
  /** Present, but the page can only observe it (macOS, ChromeOS). */
  | { kind: 'readonly'; enabled: boolean }
  /** Present and controllable (Windows). */
  | { kind: 'controllable'; enabled: boolean };

/**
 * Inspects a live camera track. Capabilities are only meaningful on a real
 * camera track — a canvas-derived track never reports them.
 */
export function detectNativeBlur(track: MediaStreamTrack | undefined): NativeBlurSupport {
  if (!track || typeof track.getCapabilities !== 'function') return { kind: 'none' };

  try {
    const capabilities = track.getCapabilities() as MediaTrackCapabilities & {
      backgroundBlur?: boolean[];
    };
    const settings = track.getSettings() as MediaTrackSettings & { backgroundBlur?: boolean };

    const options = capabilities.backgroundBlur;
    if (!options || options.length === 0) return { kind: 'none' };

    const enabled = settings.backgroundBlur === true;

    // Two entries ([false, true]) mean both states are reachable, so the page
    // may toggle it. A single entry means the state is fixed by the platform.
    return options.length >= 2
      ? { kind: 'controllable', enabled }
      : { kind: 'readonly', enabled };
  } catch {
    return { kind: 'none' };
  }
}

/**
 * Asks the platform to toggle blur. Returns whether it took effect — a
 * rejection here is normal on platforms that expose the setting read-only.
 */
export async function setNativeBlur(
  track: MediaStreamTrack | undefined,
  enabled: boolean,
): Promise<boolean> {
  if (!track) return false;
  try {
    await track.applyConstraints({ backgroundBlur: enabled } as MediaTrackConstraints);
    const settings = track.getSettings() as MediaTrackSettings & { backgroundBlur?: boolean };
    return settings.backgroundBlur === enabled;
  } catch {
    return false;
  }
}

/**
 * WebGL is required for the fallback pipeline. Checked here rather than in the
 * processor module so that merely opening the settings panel does not fetch a
 * chunk — nothing blur-related loads until someone switches it on.
 */
export function isWebGLAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}
