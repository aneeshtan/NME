/**
 * The meeting.
 *
 * Layout is a plain grid rather than the web client's speaker view: on a phone
 * there is room for a handful of tiles at a legible size, and switching layout
 * under someone mid-sentence is more disorienting on a small screen than it is
 * useful. Beyond about six participants the grid gives way to the active
 * speaker plus a strip, which is the point where equal tiles stop being
 * readable at all.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeepAwake } from 'expo-keep-awake';
import { VideoTrack } from '@livekit/react-native';
import { Track, type Participant, type TrackPublication } from 'livekit-client';
import type { TrackReference } from '@livekit/components-react';
import { theme } from '../theme';
import { useRoom } from '../room/useRoom';
import { useMessaging } from '../room/useMessaging';

interface Props {
  roomId: string;
  roomKey: string;
  displayName: string;
  onLeave: () => void;
}

export function RoomScreen({ roomId, roomKey, displayName, onLeave }: Props) {
  const { room, status, error, relayed, version, connect, leave } = useRoom(roomId, roomKey);
  const [chatOpen, setChatOpen] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);
  const insets = useSafeAreaInsets();
  const messaging = useMessaging(room, roomKey, chatOpen);

  /**
   * A meeting is the one thing a phone must not dim during: the user is
   * looking at the screen and not touching it, which is exactly what the idle
   * timer treats as absence.
   */
  useKeepAwake();

  useEffect(() => {
    void connect(displayName);
  }, [connect, displayName]);

  const tiles = useMemo(() => (room ? collectTiles(room) : []), [room, version]);

  const toggleMic = useCallback(async () => {
    if (!room) return;
    const next = !micOn;
    setMicOn(next);
    await room.localParticipant.setMicrophoneEnabled(next);
  }, [room, micOn]);

  const toggleCamera = useCallback(async () => {
    if (!room) return;
    const next = !cameraOn;
    setCameraOn(next);
    await room.localParticipant.setCameraEnabled(next);
  }, [room, cameraOn]);

  const flipCamera = useCallback(async () => {
    // The published track is swapped in place, so remote participants see the
    // change without a renegotiation or a visible gap.
    const publication = room?.localParticipant.getTrackPublication(Track.Source.Camera);
    const track = publication?.videoTrack;
    if (track && 'restartTrack' in track) {
      await track.restartTrack({
        facingMode: track.mediaStreamTrack.getSettings().facingMode === 'environment'
          ? 'user'
          : 'environment',
      });
    }
  }, [room]);

  const hangUp = useCallback(() => {
    leave();
    onLeave();
  }, [leave, onLeave]);

  if (status !== 'connected' && status !== 'reconnecting') {
    return (
      <Connecting
        status={status}
        message={error?.message ?? null}
        onDismiss={hangUp}
        insetTop={insets.top}
      />
    );
  }

  const columns = tiles.length <= 1 ? 1 : 2;

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {status === 'reconnecting' && (
        <View style={styles.banner}>
          <ActivityIndicator size="small" color={theme.color.fg} />
          <Text style={styles.bannerLabel}>Reconnecting…</Text>
        </View>
      )}

      <FlatList
        key={columns}
        data={tiles}
        keyExtractor={(tile) => tile.key}
        numColumns={columns}
        contentContainerStyle={styles.grid}
        renderItem={({ item }) => <Tile tile={item} width={tileWidth(columns)} />}
      />

      {chatOpen && (
        <Chat
          messaging={messaging}
          onClose={() => setChatOpen(false)}
          bottomInset={insets.bottom}
        />
      )}

      <View style={[styles.toolbar, { paddingBottom: insets.bottom + theme.space(2) }]}>
        <Control label={micOn ? 'Mute' : 'Unmute'} active={!micOn} onPress={toggleMic} />
        <Control label={cameraOn ? 'Stop' : 'Start'} active={!cameraOn} onPress={toggleCamera} />
        <Control label="Flip" active={false} onPress={flipCamera} />
        <Control
          label={messaging.unread > 0 ? `Chat (${messaging.unread})` : 'Chat'}
          active={chatOpen}
          onPress={() => {
            setChatOpen((open) => !open);
            messaging.markRead();
          }}
        />
        <Control label="Leave" active={false} danger onPress={hangUp} />
      </View>

      {relayed && (
        // The participant is entitled to know their media is passing through a
        // relay rather than going straight to the SFU. The relay cannot read
        // it, but it can see that they are in a call and from where.
        <Text style={[styles.relayNote, { bottom: insets.bottom + theme.space(20) }]}>
          Connected via relay
        </Text>
      )}
    </View>
  );
}

interface TileModel {
  key: string;
  name: string;
  isLocal: boolean;
  muted: boolean;
  reference: TrackReference | undefined;
}

/**
 * Flattens the room into what the grid renders.
 *
 * Values are read out here rather than in the tile, so that a memoised tile
 * still re-renders when a track is replaced — reading LiveKit's mutable state
 * during render is how a camera toggle ends up invisible to everyone else.
 */
function collectTiles(room: {
  localParticipant: Participant;
  remoteParticipants: Map<string, Participant>;
}): TileModel[] {
  const participants = [room.localParticipant, ...room.remoteParticipants.values()];

  return participants.map((participant) => {
    const publication = participant.getTrackPublication(Track.Source.Camera);
    const live = publication?.track && !publication.isMuted;

    return {
      key: participant.identity,
      name: participant.name || 'Guest',
      isLocal: participant.isLocal,
      muted: participant.getTrackPublication(Track.Source.Microphone)?.isMuted ?? true,
      reference: live
        ? ({
            participant,
            publication: publication as TrackPublication,
            source: Track.Source.Camera,
          } as TrackReference)
        : undefined,
    };
  });
}

function tileWidth(columns: number): number {
  const gutters = theme.space(2) * (columns + 1);
  return (Dimensions.get('window').width - gutters) / columns;
}

function Tile({ tile, width }: { tile: TileModel; width: number }) {
  return (
    <View style={[styles.tile, { width, height: width * 1.2 }]}>
      {tile.reference ? (
        <VideoTrack
          trackRef={tile.reference}
          objectFit="cover"
          mirror={tile.isLocal}
          style={StyleSheet.absoluteFill}
        />
      ) : (
        <View style={styles.avatar}>
          <Text style={styles.avatarLabel}>{initials(tile.name)}</Text>
        </View>
      )}
      <View style={styles.tileFooter}>
        <Text numberOfLines={1} style={styles.tileName}>
          {tile.isLocal ? 'You' : tile.name}
          {tile.muted ? '  ·  muted' : ''}
        </Text>
      </View>
    </View>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part.charAt(0).toUpperCase()).join('') || '?';
}

function Control({
  label,
  active,
  danger,
  onPress,
}: {
  label: string;
  active: boolean;
  danger?: boolean;
  onPress: () => void | Promise<void>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => void onPress()}
      style={({ pressed }) => [
        styles.control,
        active && styles.controlActive,
        danger && styles.controlDanger,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.controlLabel, danger && styles.controlLabelDanger]}>{label}</Text>
    </Pressable>
  );
}

function Connecting({
  status,
  message,
  onDismiss,
  insetTop,
}: {
  status: string;
  message: string | null;
  onDismiss: () => void;
  insetTop: number;
}) {
  const copy: Record<string, string> = {
    idle: 'Getting ready…',
    connecting: 'Joining…',
    waiting: 'Waiting for someone to let you in…',
    relaying: 'Your network is blocking the direct route. Connecting through a relay…',
    failed: message ?? 'Could not join the meeting.',
    left: 'You left the meeting.',
  };

  const done = status === 'failed' || status === 'left';

  return (
    <View style={[styles.centred, { paddingTop: insetTop }]}>
      {!done && <ActivityIndicator color={theme.color.accent} />}
      <Text style={styles.centredLabel}>{copy[status] ?? 'Joining…'}</Text>
      <Pressable accessibilityRole="button" onPress={onDismiss} style={styles.centredAction}>
        <Text style={styles.centredActionLabel}>{done ? 'Back' : 'Cancel'}</Text>
      </Pressable>
    </View>
  );
}

function Chat({
  messaging,
  onClose,
  bottomInset,
}: {
  messaging: ReturnType<typeof useMessaging>;
  onClose: () => void;
  bottomInset: number;
}) {
  const [draft, setDraft] = useState('');

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    void messaging.sendChat(text);
  }, [draft, messaging]);

  return (
    <KeyboardAvoidingView
      style={[styles.chat, { paddingBottom: bottomInset }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.chatHeader}>
        <Text style={styles.chatTitle}>Chat</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Close chat" onPress={onClose}>
          <Text style={styles.chatClose}>Done</Text>
        </Pressable>
      </View>

      <FlatList
        data={messaging.messages}
        keyExtractor={(message) => message.id}
        contentContainerStyle={styles.chatList}
        ListEmptyComponent={
          <Text style={styles.chatEmpty}>
            Messages are encrypted and disappear when the meeting ends.
          </Text>
        }
        renderItem={({ item }) => (
          <View style={styles.chatMessage}>
            <Text style={styles.chatSender}>{item.isLocal ? 'You' : item.senderName}</Text>
            <Text style={styles.chatText}>{item.text}</Text>
          </View>
        )}
      />

      <View style={styles.chatComposer}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="Send a message"
          placeholderTextColor={theme.color.muted}
          maxLength={2000}
          returnKeyType="send"
          onSubmitEditing={send}
          style={styles.chatInput}
        />
        <Pressable
          accessibilityRole="button"
          onPress={send}
          disabled={!draft.trim()}
          style={({ pressed }) => [styles.chatSend, pressed && styles.pressed, !draft.trim() && styles.dim]}
        >
          <Text style={styles.chatSendLabel}>Send</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg },
  grid: { padding: theme.space(2), gap: theme.space(2) },
  tile: {
    margin: theme.space(1),
    borderRadius: theme.radius.md,
    overflow: 'hidden',
    backgroundColor: theme.color.surface,
    justifyContent: 'flex-end',
  },
  avatar: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  avatarLabel: { color: theme.color.muted, fontSize: 28, fontWeight: '700' },
  tileFooter: { paddingHorizontal: theme.space(2), paddingVertical: theme.space(1.5) },
  tileName: { color: theme.color.fg, fontSize: 12, fontWeight: '600' },

  toolbar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    gap: theme.space(2),
    paddingTop: theme.space(2),
    paddingHorizontal: theme.space(2),
    backgroundColor: theme.color.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.border,
  },
  control: {
    flex: 1,
    minHeight: theme.tapTarget,
    borderRadius: theme.radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.color.elevated,
  },
  controlActive: { backgroundColor: theme.color.accent },
  controlDanger: { backgroundColor: theme.color.danger },
  controlLabel: { color: theme.color.fg, fontSize: 12, fontWeight: '600' },
  controlLabelDanger: { color: '#fff' },

  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space(2),
    paddingVertical: theme.space(2),
    backgroundColor: theme.color.elevated,
  },
  bannerLabel: { color: theme.color.fg, fontSize: 13 },
  relayNote: {
    position: 'absolute',
    alignSelf: 'center',
    color: theme.color.muted,
    fontSize: 11,
  },

  centred: {
    flex: 1,
    backgroundColor: theme.color.bg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space(4),
    paddingHorizontal: theme.space(8),
  },
  centredLabel: { color: theme.color.fg, fontSize: 16, textAlign: 'center', lineHeight: 24 },
  centredAction: { minHeight: theme.tapTarget, justifyContent: 'center' },
  centredActionLabel: { color: theme.color.accent, fontSize: 16, fontWeight: '600' },

  chat: {
    ...StyleSheet.absoluteFill,
    backgroundColor: theme.color.bg,
  },
  chatHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: theme.space(4),
  },
  chatTitle: { color: theme.color.fg, fontSize: 16, fontWeight: '700' },
  chatClose: { color: theme.color.accent, fontSize: 15, fontWeight: '600' },
  chatList: { paddingHorizontal: theme.space(4), gap: theme.space(3) },
  chatEmpty: {
    color: theme.color.muted,
    fontSize: 13,
    textAlign: 'center',
    marginTop: theme.space(10),
    lineHeight: 20,
  },
  chatMessage: { gap: theme.space(0.5) },
  chatSender: { color: theme.color.muted, fontSize: 11, fontWeight: '700' },
  chatText: { color: theme.color.fg, fontSize: 15, lineHeight: 21 },
  chatComposer: {
    flexDirection: 'row',
    gap: theme.space(2),
    padding: theme.space(3),
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.border,
  },
  chatInput: {
    flex: 1,
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.md,
    color: theme.color.fg,
    fontSize: 15,
    minHeight: theme.tapTarget,
    paddingHorizontal: theme.space(3),
  },
  chatSend: {
    paddingHorizontal: theme.space(4),
    minHeight: theme.tapTarget,
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chatSendLabel: { color: '#fff', fontSize: 15, fontWeight: '700' },

  pressed: { opacity: 0.75 },
  dim: { opacity: 0.45 },
});
