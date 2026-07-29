/**
 * The only thing this app keeps between launches.
 *
 * A display name, so nobody types theirs before every meeting, and the host
 * key for meetings created on this device, so a creator is not made to knock at
 * their own door.
 *
 * Room keys are deliberately absent. Storing them would turn a stolen or
 * forensically imaged phone into a key to every past meeting, in an app whose
 * entire claim is that conversations leave no readable trace. They live in
 * memory for the duration of a call and nowhere else.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const NAME_KEY = 'nme.displayName';
const HOST_KEY_PREFIX = 'nme.hostKey.';

export async function loadDisplayName(): Promise<string> {
  try {
    return (await AsyncStorage.getItem(NAME_KEY)) ?? '';
  } catch {
    // Storage being unavailable is not worth failing a join over.
    return '';
  }
}

export async function saveDisplayName(name: string): Promise<void> {
  try {
    await AsyncStorage.setItem(NAME_KEY, name.slice(0, 60));
  } catch {
    // Ignored; the name simply will not be remembered next time.
  }
}

export async function loadHostKey(roomId: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(HOST_KEY_PREFIX + roomId);
  } catch {
    return null;
  }
}

export async function saveHostKey(roomId: string, hostKey: string): Promise<void> {
  try {
    await AsyncStorage.setItem(HOST_KEY_PREFIX + roomId, hostKey);
  } catch {
    // Ignored; the creator will knock like everyone else.
  }
}
