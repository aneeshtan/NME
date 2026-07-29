/**
 * Screens and the routing between them.
 *
 * Three screens, visited in one order, so this is a `useState` rather than a
 * navigation library. React Navigation would add three native dependencies and
 * a stack the user can never go back through, to model a sequence that fits in
 * a discriminated union.
 */
import { useCallback, useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import * as Linking from 'expo-linking';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { deriveRoomId, readRoomKeyFromLink } from '@nme/core';

import './src/lib/config';
import { HomeScreen } from './src/screens/HomeScreen';
import { PreJoinScreen } from './src/screens/PreJoinScreen';
import { RoomScreen } from './src/screens/RoomScreen';

type Screen =
  | { name: 'home' }
  | { name: 'prejoin'; roomId: string; roomKey: string }
  | { name: 'room'; roomId: string; roomKey: string; displayName: string };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'home' });

  /**
   * The URL that launched the app, and any that arrive while it is running.
   *
   * This is the whole reason the app is worth installing: a meeting link in a
   * calendar or a chat opens here instead of in a browser tab. The fragment
   * survives the trip on both platforms — iOS hands over `webpageURL` intact
   * and Android keeps it on the intent `Uri` — which matters because the
   * fragment is where the key is.
   */
  const url = Linking.useURL();

  const openKey = useCallback(async (roomKey: string) => {
    // The room id is a hash of the key, so the link needs to carry only one of
    // them and the server still never learns the other.
    setScreen({ name: 'prejoin', roomId: await deriveRoomId(roomKey), roomKey });
  }, []);

  useEffect(() => {
    if (!url) return;
    const roomKey = readRoomKeyFromLink(url);
    // A link without a usable key is ignored rather than surfaced as an error:
    // it is most often the bare homepage URL, and opening the app is already
    // the right response to that.
    if (roomKey) void openKey(roomKey);
  }, [url, openKey]);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {screen.name === 'home' && <HomeScreen onOpenKey={openKey} />}

      {screen.name === 'prejoin' && (
        <PreJoinScreen
          roomKey={screen.roomKey}
          onJoin={(displayName) =>
            setScreen({
              name: 'room',
              roomId: screen.roomId,
              roomKey: screen.roomKey,
              displayName,
            })
          }
          onCancel={() => setScreen({ name: 'home' })}
        />
      )}

      {screen.name === 'room' && (
        <RoomScreen
          roomId={screen.roomId}
          roomKey={screen.roomKey}
          displayName={screen.displayName}
          onLeave={() => setScreen({ name: 'home' })}
        />
      )}
    </SafeAreaProvider>
  );
}
