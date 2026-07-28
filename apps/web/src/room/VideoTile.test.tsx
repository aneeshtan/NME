/**
 * Regression test for the memoisation contract.
 *
 * VideoTile is memoised, and LiveKit mutates Participant/TrackPublication
 * objects in place — their references never change. If the tile read that
 * mutable state during render instead of receiving values as props, `memo`
 * would compare identical props and skip the re-render, and a participant
 * enabling their camera mid-meeting would never appear.
 *
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Track } from 'livekit-client';
import { VideoTile } from './VideoTile';

/**
 * Minimal stand-in for a LiveKit track: only attach/detach are exercised, so
 * the rest of the surface is asserted away rather than stubbed.
 */
type FakeTrack = Track & {
  attach: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
};

function fakeTrack(): FakeTrack {
  return { attach: vi.fn(), detach: vi.fn() } as unknown as FakeTrack;
}

const baseProps = {
  isLocal: false,
  isSpeaking: false,
  name: 'Alice',
  videoTrack: undefined,
  videoMuted: true,
  audioTrack: undefined,
  audioMuted: true,
};

afterEach(() => {
  // Testing Library only auto-cleans when vitest globals are enabled, which
  // they are not here — without this, DOM from one test leaks into the next.
  cleanup();
  vi.restoreAllMocks();
});

describe('VideoTile re-render behaviour', () => {
  test('enabling a camera mid-meeting swaps the avatar for a video element', () => {
    const { container, rerender } = render(<VideoTile {...baseProps} />);

    // Camera off: avatar placeholder, no <video>.
    expect(container.querySelector('video')).toBeNull();

    // The participant turns their camera on. Only the track and muted flag
    // change — in the real app the Participant object is the same reference.
    rerender(<VideoTile {...baseProps} videoTrack={fakeTrack()} videoMuted={false} />);

    expect(container.querySelector('video')).not.toBeNull();
  });

  test('muting a camera mid-meeting removes the video element', () => {
    const track = fakeTrack();
    const { container, rerender } = render(
      <VideoTile {...baseProps} videoTrack={track} videoMuted={false} />,
    );
    expect(container.querySelector('video')).not.toBeNull();

    rerender(<VideoTile {...baseProps} videoTrack={track} videoMuted={true} />);
    expect(container.querySelector('video')).toBeNull();
  });

  test('the track is attached when live and detached on teardown', () => {
    const track = fakeTrack();
    const { unmount } = render(
      <VideoTile {...baseProps} videoTrack={track} videoMuted={false} />,
    );

    expect(track.attach).toHaveBeenCalledTimes(1);

    // Detaching on cleanup is what prevents the decoder leak that shows up as
    // steadily climbing memory across a long meeting.
    unmount();
    expect(track.detach).toHaveBeenCalledTimes(1);
  });

  test('a republished track is re-attached rather than left stale', () => {
    const first = fakeTrack();
    const { rerender } = render(
      <VideoTile {...baseProps} videoTrack={first} videoMuted={false} />,
    );

    const second = fakeTrack();
    rerender(<VideoTile {...baseProps} videoTrack={second} videoMuted={false} />);

    expect(first.detach).toHaveBeenCalledTimes(1);
    expect(second.attach).toHaveBeenCalledTimes(1);
  });

  test('remote audio is attached', () => {
    const remoteAudio = fakeTrack();
    render(<VideoTile {...baseProps} audioTrack={remoteAudio} audioMuted={false} />);
    expect(remoteAudio.attach).toHaveBeenCalled();
  });

  test('local audio is never played back', () => {
    // Playing back your own microphone creates an echo loop.
    const localAudio = fakeTrack();
    render(<VideoTile {...baseProps} isLocal audioTrack={localAudio} audioMuted={false} />);
    expect(localAudio.attach).not.toHaveBeenCalled();
  });

  test('a name change is reflected without a remount', () => {
    const { rerender } = render(<VideoTile {...baseProps} />);
    expect(screen.getByText('Alice')).toBeTruthy();

    rerender(<VideoTile {...baseProps} name="Alice Smith" />);
    expect(screen.getByText('Alice Smith')).toBeTruthy();
  });
});
