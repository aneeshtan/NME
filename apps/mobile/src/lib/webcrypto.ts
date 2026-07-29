/**
 * The slice of WebCrypto that @nme/core actually uses, in pure JavaScript.
 *
 * Hermes ships no `crypto.subtle`, and the obvious fix — react-native-quick-crypto
 * — is unbuildable: its published nitrogen-generated C++ includes
 * `<NitroModules/PropNameIDCache.hpp>`, a header that exists in no released
 * version of react-native-nitro-modules. Every quick-crypto release from 1.0.19
 * to 1.1.6 has it, so there is no version pin that resolves it, and it takes
 * the whole iOS build down with ~36 errors that name a module map rather than
 * the cause.
 *
 * Dropping it removes a C++ toolchain, a codegen step, and an entire native
 * dependency from the build, in exchange for two audited zero-dependency
 * libraries. The payloads involved are chat messages capped at 16 KB, so
 * software AES is not on any path a person can perceive.
 *
 * The property that matters is not speed but *agreement*: a browser encrypts
 * with real WebCrypto and a phone decrypts with this, in the same meeting. Any
 * divergence shows up as chat that silently never arrives. `webcrypto.test.ts`
 * checks the two against each other rather than against themselves.
 *
 * Deliberately not a general WebCrypto polyfill. It implements the six
 * operations `@nme/core` performs and throws on everything else, so a future
 * caller reaching for something unimplemented fails loudly here instead of
 * subtly at runtime on a device.
 */
import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

/** AES-GCM authentication tag length, in bytes. WebCrypto's default is 128 bits. */
const TAG_BYTES = 16;

/**
 * Key material, standing in for `CryptoKey`.
 *
 * WebCrypto's CryptoKey is opaque and non-extractable; this is a plain object
 * holding bytes. Both stay inside this module and the core that calls it, and
 * neither is ever serialised — the room key's protection comes from never
 * leaving the device, not from the key handle being unreadable in memory.
 */
interface RawKey {
  readonly __nmeRawKey: Uint8Array;
  readonly usages: readonly KeyUsage[];
}

function isRawKey(value: unknown): value is RawKey {
  return typeof value === 'object' && value !== null && '__nmeRawKey' in value;
}

function toBytes(data: BufferSource): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(data);
}

/** Returns a fresh ArrayBuffer, never a view into a larger allocation. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function algorithmName(algorithm: AlgorithmIdentifier): string {
  return (typeof algorithm === 'string' ? algorithm : algorithm.name).toUpperCase();
}

const subtle = {
  async digest(algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> {
    if (algorithmName(algorithm) !== 'SHA-256') {
      throw new Error(`webcrypto shim: digest supports SHA-256 only, got ${algorithmName(algorithm)}`);
    }
    return toArrayBuffer(sha256(toBytes(data)));
  },

  async importKey(
    format: string,
    keyData: BufferSource,
    algorithm: AlgorithmIdentifier,
    _extractable: boolean,
    usages: KeyUsage[],
  ): Promise<CryptoKey> {
    if (format !== 'raw') {
      throw new Error(`webcrypto shim: importKey supports 'raw' only, got '${format}'`);
    }
    const name = algorithmName(algorithm);
    if (name !== 'HKDF' && name !== 'AES-GCM') {
      throw new Error(`webcrypto shim: importKey supports HKDF and AES-GCM only, got ${name}`);
    }
    // Copied, so a later mutation of the caller's buffer cannot change the key
    // underneath a derivation that has already been reasoned about.
    return { __nmeRawKey: Uint8Array.from(toBytes(keyData)), usages } as unknown as CryptoKey;
  },

  async deriveKey(
    algorithm: HkdfParams,
    baseKey: CryptoKey,
    derived: AesKeyGenParams,
    _extractable: boolean,
    usages: KeyUsage[],
  ): Promise<CryptoKey> {
    if (algorithmName(algorithm) !== 'HKDF') {
      throw new Error(`webcrypto shim: deriveKey supports HKDF only, got ${algorithmName(algorithm)}`);
    }
    if (algorithmName(algorithm.hash) !== 'SHA-256') {
      throw new Error('webcrypto shim: HKDF supports SHA-256 only');
    }
    if (algorithmName(derived) !== 'AES-GCM') {
      throw new Error('webcrypto shim: deriveKey can only produce AES-GCM keys');
    }
    if (!isRawKey(baseKey)) throw new Error('webcrypto shim: unrecognised key material');

    const length = (derived.length ?? 256) / 8;
    const bytes = hkdf(sha256, baseKey.__nmeRawKey, toBytes(algorithm.salt), toBytes(algorithm.info), length);
    return { __nmeRawKey: bytes, usages } as unknown as CryptoKey;
  },

  async encrypt(
    algorithm: AesGcmParams,
    key: CryptoKey,
    data: BufferSource,
  ): Promise<ArrayBuffer> {
    if (algorithmName(algorithm) !== 'AES-GCM') {
      throw new Error(`webcrypto shim: encrypt supports AES-GCM only, got ${algorithmName(algorithm)}`);
    }
    if (!isRawKey(key)) throw new Error('webcrypto shim: unrecognised key material');
    if (algorithm.additionalData) {
      throw new Error('webcrypto shim: additionalData is not implemented');
    }
    if (algorithm.tagLength !== undefined && algorithm.tagLength !== TAG_BYTES * 8) {
      throw new Error('webcrypto shim: only a 128-bit tag is implemented');
    }
    // noble appends the tag to the ciphertext, which is exactly what WebCrypto
    // returns — no repacking needed for the two to agree.
    return toArrayBuffer(gcm(key.__nmeRawKey, toBytes(algorithm.iv)).encrypt(toBytes(data)));
  },

  async decrypt(
    algorithm: AesGcmParams,
    key: CryptoKey,
    data: BufferSource,
  ): Promise<ArrayBuffer> {
    if (algorithmName(algorithm) !== 'AES-GCM') {
      throw new Error(`webcrypto shim: decrypt supports AES-GCM only, got ${algorithmName(algorithm)}`);
    }
    if (!isRawKey(key)) throw new Error('webcrypto shim: unrecognised key material');
    // noble throws on a bad tag, as WebCrypto rejects. `openMessage` treats any
    // failure as "not for us" and drops the message, which is the right
    // behaviour for both.
    return toArrayBuffer(gcm(key.__nmeRawKey, toBytes(algorithm.iv)).decrypt(toBytes(data)));
  },
};

/** The implemented surface, exported for the interop test. */
export const nobleSubtle = subtle as unknown as SubtleCrypto;
