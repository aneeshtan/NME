/**
 * The screen before the meeting.
 *
 * It exists to answer three questions while it is still cheap to fix the
 * answers: is my camera pointing at me, is this the right meeting, and what
 * name will people see. The preview stream is local — it is never published,
 * and it is stopped before the room is joined so the camera is handed cleanly
 * to LiveKit rather than being held by two owners at once.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RTCView, mediaDevices, type MediaStream } from '@livekit/react-native-webrtc';
import { safetyNumber } from '@nme/core';
import { theme } from '../theme';
import { loadDisplayName, saveDisplayName } from '../lib/storage';
import { shareMeeting } from './HomeScreen';

interface Props {
  roomKey: string;
  onJoin: (displayName: string) => void;
  onCancel: () => void;
}

export function PreJoinScreen({ roomKey, onJoin, onCancel }: Props) {
  const [name, setName] = useState('');
  const [nameLoaded, setNameLoaded] = useState(false);
  const [cameraOn, setCameraOn] = useState(true);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [fingerprint, setFingerprint] = useState('');
  const [denied, setDenied] = useState(false);
  const insets = useSafeAreaInsets();

  // Held in a ref as well as state so cleanup can stop it without depending on
  // a render having happened first.
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    void loadDisplayName().then((stored) => {
      setName(stored);
      setNameLoaded(true);
    });
    void safetyNumber(roomKey).then(setFingerprint);
  }, [roomKey]);

  // Preview, torn down whenever the camera is switched off — leaving it running
  // behind a black tile would keep the OS recording indicator lit, which reads
  // as the app spying rather than as a UI state.
  useEffect(() => {
    let cancelled = false;

    const stop = () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setStream(null);
    };

    if (!cameraOn) {
      stop();
      return;
    }

    void (async () => {
      try {
        const preview = await mediaDevices.getUserMedia({
          video: { facingMode: 'user' },
          audio: false,
        });
        if (cancelled) {
          preview.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = preview;
        setStream(preview);
        setDenied(false);
      } catch {
        // Permission refused, or another app holds the camera. The join button
        // stays available: a meeting with no video is still a meeting.
        setDenied(true);
      }
    })();

    return () => {
      cancelled = true;
      stop();
    };
  }, [cameraOn]);

  const join = useCallback(() => {
    const trimmed = name.trim() || 'Guest';
    void saveDisplayName(trimmed);
    // Release the preview before LiveKit asks for the camera. On Android a
    // second `getUserMedia` against a camera this process already holds can
    // fail outright.
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    onJoin(trimmed);
  }, [name, onJoin]);

  return (
    <KeyboardAvoidingView
      style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.preview}>
        {stream ? (
          <RTCView
            streamURL={stream.toURL()}
            objectFit="cover"
            // Mirrored, because a preview that is not mirrored looks wrong to
            // everyone who has ever used a mirror.
            mirror
            style={StyleSheet.absoluteFill}
          />
        ) : (
          <View style={styles.previewOff}>
            <Text style={styles.previewOffLabel}>
              {denied ? 'No camera access' : 'Camera off'}
            </Text>
          </View>
        )}
      </View>

      <View style={styles.panel}>
        {nameLoaded ? (
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Your name"
            placeholderTextColor={theme.color.muted}
            maxLength={60}
            autoCapitalize="words"
            returnKeyType="join"
            onSubmitEditing={join}
            style={styles.input}
          />
        ) : (
          <View style={[styles.input, styles.inputLoading]}>
            <ActivityIndicator color={theme.color.muted} />
          </View>
        )}

        <View style={styles.toggles}>
          <Toggle
            label={cameraOn ? 'Camera on' : 'Camera off'}
            active={cameraOn}
            onPress={() => setCameraOn((on) => !on)}
          />
          <Toggle label="Share link" active={false} onPress={() => void shareMeeting(roomKey)} />
        </View>

        {/*
          The safety number proves which room the key opens, not who is in it.
          Two people reading it aloud can tell a genuine invitation from a
          convincing lookalike — the one attack the server cannot mount but a
          forged link can.
        */}
        {fingerprint ? (
          <Text style={styles.fingerprint} accessibilityLabel={`Safety number ${fingerprint}`}>
            {fingerprint}
          </Text>
        ) : null}

        <Pressable
          accessibilityRole="button"
          onPress={join}
          style={({ pressed }) => [styles.join, pressed && styles.pressed]}
        >
          <Text style={styles.joinLabel}>Join meeting</Text>
        </Pressable>

        <Pressable accessibilityRole="button" onPress={onCancel} style={styles.cancel}>
          <Text style={styles.cancelLabel}>Cancel</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function Toggle({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: active }}
      onPress={onPress}
      style={({ pressed }) => [styles.toggle, active && styles.toggleActive, pressed && styles.pressed]}
    >
      <Text style={[styles.toggleLabel, active && styles.toggleLabelActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg },
  preview: {
    flex: 1,
    margin: theme.space(4),
    borderRadius: theme.radius.lg,
    overflow: 'hidden',
    backgroundColor: theme.color.surface,
  },
  previewOff: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  previewOffLabel: { color: theme.color.muted, fontSize: 15 },
  panel: { paddingHorizontal: theme.space(4), paddingBottom: theme.space(4), gap: theme.space(3) },
  input: {
    backgroundColor: theme.color.surface,
    borderColor: theme.color.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.radius.md,
    color: theme.color.fg,
    fontSize: 16,
    minHeight: theme.tapTarget,
    paddingHorizontal: theme.space(4),
  },
  inputLoading: { alignItems: 'center', justifyContent: 'center' },
  toggles: { flexDirection: 'row', gap: theme.space(3) },
  toggle: {
    flex: 1,
    minHeight: theme.tapTarget,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border,
    backgroundColor: theme.color.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toggleActive: { backgroundColor: theme.color.elevated, borderColor: theme.color.accent },
  toggleLabel: { color: theme.color.muted, fontSize: 14, fontWeight: '600' },
  toggleLabelActive: { color: theme.color.fg },
  fingerprint: {
    color: theme.color.muted,
    fontSize: 13,
    letterSpacing: 2,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  join: {
    backgroundColor: theme.color.accent,
    borderRadius: theme.radius.md,
    minHeight: theme.tapTarget + 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  joinLabel: { color: '#fff', fontSize: 17, fontWeight: '700' },
  cancel: { minHeight: theme.tapTarget, alignItems: 'center', justifyContent: 'center' },
  cancelLabel: { color: theme.color.muted, fontSize: 15 },
  pressed: { opacity: 0.75 },
});
