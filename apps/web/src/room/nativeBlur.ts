/**
 * Platform-provided background blur.
 *
 * Chrome 114+ on ChromeOS, macOS and Windows can expose the camera's own blur
 * as a MediaStreamTrack constraint, performed by the OS or the camera hardware.
 * Where it exists this is free in every sense — no download, no CPU, no GPU, no
 * extra frame pipeline.
 *
 * Worth stating why this is a bandwidth feature and not a vanity one: a blurred
 * background carries far less high-frequency detail, so it encodes to fewer bits
 * for the same perceived quality — commonly 10-20% off a talking-head stream.
 * The GPU pipeline this once fell back to cost a 520 KB download and ran a
 * segmentation model on every frame, which is a poor trade for that. The
 * platform path costs nothing and keeps the saving.
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
