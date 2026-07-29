/**
 * The deployment this build talks to.
 *
 * Read from the compiled-in app config, never from an incoming link. See the
 * note on `configureApi` in @nme/core: a meeting link is attacker-supplied, and
 * the control plane decides who gets admitted.
 */
import Constants from 'expo-constants';
import { configureApi } from '@nme/core';

const origin = (Constants.expoConfig?.extra as { origin?: string } | undefined)?.origin;

if (!origin) {
  // Failing loudly at startup beats every request failing later with a URL
  // that reads as a relative path and cannot possibly resolve on a phone.
  throw new Error('Missing `extra.origin` in app config.');
}

export const ORIGIN = origin;

configureApi({ baseUrl: ORIGIN });
