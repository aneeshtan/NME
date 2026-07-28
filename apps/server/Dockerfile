# syntax=docker/dockerfile:1.7
# ─── build ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

# Copy manifests first so the dependency layer is cached independently of source.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

# `npm ci` installs exactly the lockfile — a build must never silently pick up a
# newer transitive dependency than the one that was reviewed.
RUN npm ci --workspace @nme/server --include-workspace-root

COPY apps/server ./apps/server
RUN npm run build --workspace @nme/server

# Drop dev dependencies from the tree that ships.
RUN npm prune --omit=dev --workspace @nme/server --include-workspace-root

# ─── runtime ─────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Cap the heap so a memory leak trips a container restart instead of invoking
# the host OOM killer, which would take neighbouring containers with it.
ENV NODE_OPTIONS="--max-old-space-size=256"

# The base image ships an unprivileged `node` user; a compromised process should
# never be able to write to its own code.
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/apps/server/dist ./dist
COPY --from=build --chown=root:root /app/apps/server/package.json ./package.json

USER node
EXPOSE 8080

# `dumb-init` is unnecessary: node is PID 1 here and the app installs its own
# SIGTERM handler, so shutdown is graceful without an init shim.
HEALTHCHECK --interval=20s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
