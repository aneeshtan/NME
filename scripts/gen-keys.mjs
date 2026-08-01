#!/usr/bin/env node
/**
 * Generates the credentials required by .env.
 * All values come from the OS CSPRNG (crypto.randomBytes), never Math.random.
 */
import { randomBytes } from 'node:crypto';

// base64url avoids `+`, `/`, and `=`, which otherwise need quoting in .env,
// docker-compose interpolation, and shell exports.
const apiSecret = randomBytes(32).toString('base64url');
const redisPassword = randomBytes(24).toString('base64url');
// Optional: only needed if the health dashboard is wanted.
const adminToken = randomBytes(32).toString('base64url');

process.stdout.write(
  [
    '# Paste these into .env, replacing the blank values.',
    '# LIVEKIT_API_KEY stays as `nme` — it is a public identifier, not a secret.',
    `LIVEKIT_API_SECRET=${apiSecret}`,
    `REDIS_PASSWORD=${redisPassword}`,
    '',
    '# Optional — unlocks /health. Leave unset and the endpoint returns 404.',
    `ADMIN_TOKEN=${adminToken}`,
    '',
  ].join('\n'),
);
