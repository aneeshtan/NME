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
import QuickCrypto from 'react-native-quick-crypto';

registerGlobals();

/**
 * `crypto.subtle` backed by native OpenSSL rather than a JavaScript
 * implementation.
 *
 * This matters beyond speed. A pure-JS AES-GCM runs on Hermes at a speed that
 * makes per-message encryption visible in the UI, and — more seriously — is
 * far harder to keep free of timing side channels than a library built for the
 * purpose.
 *
 * The cast is unavoidable: quick-crypto's `Subtle` accepts a wider set of
 * buffer types than the DOM's `SubtleCrypto` declares, so the shapes are
 * compatible at runtime but not assignable at the type level. It is done once,
 * here, rather than at each call site.
 */
if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: QuickCrypto as unknown as Crypto,
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
