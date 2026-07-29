/**
 * Platform globals, installed before anything else runs.
 *
 * React Native's JavaScript engine is not a browser. Two things the rest of
 * this app takes for granted are simply absent, and both are load-bearing:
 *
 *   WebRTC   — `RTCPeerConnection` and friends, provided by LiveKit's fork of
 *              react-native-webrtc, which is also what supplies the native
 *              frame cryptor that makes E2EE possible off the web.
 *   WebCrypto — Hermes ships no `crypto.subtle`, so the chat envelope in
 *              @nme/core would throw on the first message.
 *
 * Imported for side effects from `index.js`, ahead of React, because a module
 * that reaches for `crypto` at import time would otherwise lose the race.
 */
import { registerGlobals } from '@livekit/react-native';
import { getRandomValues } from 'expo-crypto';
import { nobleSubtle } from './lib/webcrypto';

registerGlobals();

/**
 * `crypto`, assembled from a pure-JavaScript `subtle` and the platform CSPRNG.
 *
 * The obvious choice here was react-native-quick-crypto, backed by native
 * OpenSSL. It cannot be built: its published nitrogen-generated C++ includes a
 * NitroModules header that no released version of that package provides, and
 * every quick-crypto release carries it. See `lib/webcrypto.ts`.
 *
 * Randomness deliberately does *not* come from JavaScript. Every room key and
 * every AES-GCM nonce in this app is drawn from `getRandomValues`, and a weak
 * source would undo the encryption far more completely than any weakness in
 * the cipher — so it comes from the operating system, through expo-crypto.
 */
if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      subtle: nobleSubtle,
      getRandomValues: (array: ArrayBufferView | null) =>
        array === null ? array : getRandomValues(array as Uint8Array),
    } as unknown as Crypto,
    configurable: true,
    writable: true,
  });
}

/**
 * `TextEncoder`/`TextDecoder` are present on current Hermes builds but were not
 * always, and @nme/core encodes every chat message with them. Cheap to assert
 * rather than discover in the field.
 */
if (typeof globalThis.TextEncoder === 'undefined') {
  throw new Error('TextEncoder is missing; this Hermes build is too old for NME.');
}
