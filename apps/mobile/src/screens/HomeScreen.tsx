/**
 * Start a meeting, or open a link someone sent.
 *
 * The paste field exists because links do not always arrive as links. They get
 * forwarded into apps that strip the anchor tag, quoted in an email, or read
 * aloud and typed. Accepting a pasted string covers all of that, and the parser
 * takes the key out of whatever form it arrives in.
 */
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ApiError,
  buildShortMeetingUrl,
  createRoomWithLobby,
  deriveRoomId,
  generateRoomKey,
  readRoomKeyFromLink,
} from '@nme/core';
import { theme } from '../theme';
import { ORIGIN } from '../lib/config';
import { PRIVACY_URL, SUPPORT_URL } from '../lib/support';
import { saveHostKey } from '../lib/storage';

interface Props {
  onOpenKey: (roomKey: string) => void;
}

export function HomeScreen({ onOpenKey }: Props) {
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const insets = useSafeAreaInsets();

  const startMeeting = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      /**
       * The key is generated here and never sent anywhere. The server is told
       * only the room id, which is its hash — so it can hold a room open for
       * people to join without ever being able to listen to it.
       */
      const roomKey = generateRoomKey();
      const roomId = await deriveRoomId(roomKey);
      const { hostKey } = await createRoomWithLobby(true, roomId);

      if (hostKey) await saveHostKey(roomId, hostKey);
      onOpenKey(roomKey);
    } catch (error) {
      Alert.alert(
        'Could not start the meeting',
        error instanceof ApiError ? error.message : 'Please check your connection and try again.',
      );
    } finally {
      setBusy(false);
    }
  }, [busy, onOpenKey]);

  const openPasted = useCallback(() => {
    const roomKey = readRoomKeyFromLink(pasted);
    if (!roomKey) {
      Alert.alert(
        'That link is not complete',
        'A meeting link ends in a long code after a # — that part holds the encryption key, and without it there is no way to join.',
      );
      return;
    }
    onOpenKey(roomKey);
  }, [pasted, onOpenKey]);

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + theme.space(10), paddingBottom: insets.bottom + theme.space(6) },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.wordmark}>NME Talk</Text>
        <Text style={styles.tagline}>
          Encrypted meetings. The server relays your call without being able to see or hear it.
        </Text>

        <Pressable
          accessibilityRole="button"
          onPress={startMeeting}
          disabled={busy}
          style={({ pressed }) => [styles.primary, pressed && styles.pressed, busy && styles.dim]}
        >
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryLabel}>New meeting</Text>
          )}
        </Pressable>

        <View style={styles.divider}>
          <View style={styles.rule} />
          <Text style={styles.dividerLabel}>or</Text>
          <View style={styles.rule} />
        </View>

        <TextInput
          value={pasted}
          onChangeText={setPasted}
          placeholder="Paste a meeting link"
          placeholderTextColor={theme.color.muted}
          autoCapitalize="none"
          autoCorrect={false}
          // A link is not a password, but it is the only secret in this app,
          // so it should not be offered to the keyboard's learning dictionary.
          autoComplete="off"
          spellCheck={false}
          returnKeyType="go"
          onSubmitEditing={openPasted}
          style={styles.input}
        />

        <Pressable
          accessibilityRole="button"
          onPress={openPasted}
          disabled={!pasted.trim()}
          style={({ pressed }) => [
            styles.secondary,
            pressed && styles.pressed,
            !pasted.trim() && styles.dim,
          ]}
        >
          <Text style={styles.secondaryLabel}>Join</Text>
        </Pressable>

        <Text style={styles.footnote}>
          Anyone with the link can join, so treat it as the secret it is. Nothing is recorded, and
          messages disappear when the meeting ends.
        </Text>

        {/*
          Reachable from inside the app, not only from the store listing.
          Guideline 1.2 asks for published contact information, and a support
          address a user can only find by leaving the app does not meet it.
        */}
        <View style={styles.links}>
          <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(PRIVACY_URL)}>
            <Text style={styles.link}>Privacy</Text>
          </Pressable>
          <Text style={styles.linkSeparator}>·</Text>
          <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(SUPPORT_URL)}>
            <Text style={styles.link}>Support</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** Offered after a meeting is created, so the link can reach the other people. */
export async function shareMeeting(roomKey: string): Promise<void> {
  const url = buildShortMeetingUrl(ORIGIN, roomKey);
  await Share.share(
    Platform.OS === 'ios'
      ? { url, message: `Join my encrypted meeting:\n${url}` }
      : { message: `Join my encrypted meeting:\n${url}` },
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg },
  content: { paddingHorizontal: theme.space(6), gap: theme.space(4) },
  wordmark: {
    color: theme.color.fg,
    fontSize: 40,
    fontWeight: '800',
    // Tracking was 6, set when the wordmark was three letters. At eight
    // characters that much spacing overruns a 375pt screen and wraps mid-word.
    letterSpacing: 2,
    textAlign: 'center',
  },
  tagline: {
    color: theme.color.muted,
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    marginBottom: theme.space(4),
  },
  primary: {
    backgroundColor: theme.color.accent,
    borderRadius: theme.radius.md,
    minHeight: theme.tapTarget + 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryLabel: { color: '#fff', fontSize: 17, fontWeight: '700' },
  secondary: {
    backgroundColor: theme.color.elevated,
    borderColor: theme.color.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.radius.md,
    minHeight: theme.tapTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryLabel: { color: theme.color.fg, fontSize: 16, fontWeight: '600' },
  pressed: { opacity: 0.75 },
  dim: { opacity: 0.45 },
  divider: { flexDirection: 'row', alignItems: 'center', gap: theme.space(3) },
  rule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: theme.color.border },
  dividerLabel: { color: theme.color.muted, fontSize: 13 },
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
  footnote: {
    color: theme.color.muted,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: theme.space(6),
  },
  links: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: theme.space(2),
    marginTop: theme.space(2),
  },
  link: { color: theme.color.muted, fontSize: 12, textDecorationLine: 'underline' },
  linkSeparator: { color: theme.color.muted, fontSize: 12 },
});
