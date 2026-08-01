/**
 * Process entry point: boot, then shut down cleanly.
 *
 * Graceful shutdown matters more than usual here — a rolling deploy that kills
 * connections abruptly forces every participant through an ICE restart. Draining
 * in-flight HTTP requests first keeps redeploys invisible to people in meetings,
 * whose media flows through LiveKit and never touches this process.
 */
import { buildApp } from './app.js';
import { config } from './config.js';
import { createNonceStore } from './lib/nonceStore.js';
import { createLobbyStore } from './lib/lobby.js';
import { createBlocklist } from './lib/blocklist.js';
import { Redis } from 'ioredis';

const nonces = createNonceStore(config.redis.url, config.redis.password);

// Lobby state must be shared across replicas: a knock can be created on one
// node and admitted from another, so an in-process map would strand joiners
// behind a host who never sees their request.
const lobbyRedis = config.redis.url
  ? new Redis(config.redis.url, {
      ...(config.redis.password ? { password: config.redis.password } : {}),
      connectTimeout: 3_000,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
    })
  : null;
const lobby = createLobbyStore(lobbyRedis);

// Shared across replicas for the same reason the lobby is: a block applied on
// one node has to hold on all of them.
const blocklist = createBlocklist(config.redis.url, config.redis.password);

const app = await buildApp(nonces, lobby, blocklist);

try {
  await app.listen({ host: config.http.host, port: config.http.port });
} catch (error) {
  app.log.fatal({ err: error }, 'failed to start');
  process.exit(1);
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');

  // Bound the drain so a stuck request cannot block the container forever;
  // orchestrators kill at 30s and an unclean exit loses the remaining logs.
  const forceExit = setTimeout(() => {
    app.log.error('graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  try {
    await app.close();
    await nonces.close();
    await lobby.close();
    await blocklist.close();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'error during shutdown');
    process.exit(1);
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void shutdown(signal));
}

// A promise rejection that reaches here means state is unknown. Log it and let
// the orchestrator restart us rather than continuing in a corrupt condition.
process.on('unhandledRejection', (reason) => {
  app.log.fatal({ err: reason }, 'unhandled rejection');
  void shutdown('unhandledRejection');
});
process.on('uncaughtException', (error) => {
  app.log.fatal({ err: error }, 'uncaught exception');
  void shutdown('uncaughtException');
});
