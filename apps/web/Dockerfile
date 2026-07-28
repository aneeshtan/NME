# syntax=docker/dockerfile:1.7
# ─── build ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @nme/web --include-workspace-root

COPY apps/web ./apps/web
RUN npm run build --workspace @nme/web

# Source maps are built for local symbolication but must not ship — they hand an
# attacker a readable copy of the client, including the E2EE handling.
RUN find apps/web/dist -name '*.map' -delete

# ─── runtime ─────────────────────────────────────────────────────────────────
# Caddy serves the SPA and terminates TLS. It also proxies /api to the control
# plane, which is what keeps the browser's requests same-origin.
FROM caddy:2-alpine AS runtime

COPY --from=build /app/apps/web/dist /srv
COPY infra/Caddyfile /etc/caddy/Caddyfile

EXPOSE 80 443 443/udp
