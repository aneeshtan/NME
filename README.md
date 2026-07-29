# NME

Minimal, fast, end-to-end encrypted group video meetings. No account, no install.

Create a meeting, share the link, done — the experience of Google Meet, on
infrastructure you own, built entirely from mature open-source software with no
paid services anywhere in the stack.

---

## Contents

- [Project site](https://aneeshtan.github.io/NME/)
- [Architecture](#architecture)
- [Why LiveKit](#why-livekit)
- [Encryption](#encryption)
- [Security](#security)
- [Performance](#performance)
- [Scaling](#scaling)
- [Deployment](#deployment)
- [Mobile apps](#mobile-apps)
- [Local development](#local-development)
- [Configuration](#configuration)
- [Operations](#operations)
- [Project layout](#project-layout)

---

## Architecture

```
                        ┌──────────────────────────────────┐
   Browser              │            Your server           │
  ┌────────┐            │                                  │
  │  SPA   │──── HTTPS ─┼─▶ Caddy ──▶ /api ──▶ Fastify     │
  │        │            │     │                  │         │
  │        │            │     │                  ▼         │
  │        │            │     │               Redis        │
  │        │            │     │                  ▲         │
  │        │──── WSS ───┼─────┴──▶ LiveKit ──────┘         │
  │        │  signaling │            │  (SFU)              │
  │        │            │            │                     │
  │        │◀═══════════┼════════════┘                     │
  └────────┘  DTLS-SRTP │   media: UDP 7882 / TCP 7881     │
   encrypted            │   (never passes through Caddy)   │
   frames               └──────────────────────────────────┘
```

Four processes, one of which is a cache:

| Component | Role |
| --- | --- |
| **Caddy** | TLS 1.3 termination, HTTP/3, static SPA, `/api` proxy, SFU signaling proxy |
| **Fastify control plane** | Creates rooms, mints join tokens, enforces rate limits. Fully stateless |
| **LiveKit** | The SFU. Forwards encrypted media; also serves its own signaling |
| **Redis** | LiveKit clustering, shared rate-limit counters, replay nonces. No persistence |

**There is no database.** Rooms are ephemeral objects inside LiveKit; display
names live in the visitor's `localStorage`. Nothing about a meeting or its
participants is written to disk anywhere.

### Why the signaling server is not hand-written

The brief suggested a WebSocket signaling server. LiveKit already *is* one — a
hardened, battle-tested implementation with session resumption, ICE restart, and
reconnect semantics. Re-implementing that would mean shipping several thousand
lines of less-tested state machine and crypto negotiation to replace something
already correct.

So the Fastify service is a **control plane**, not a signaling server: it issues
room IDs and short-lived JWTs, and gets out of the way. That is roughly 400 lines
instead of 4,000, and strictly more secure.

---

## Why LiveKit

All four candidates were considered against simplicity, performance, security,
scalability, and maintainability:

| Option | Assessment |
| --- | --- |
| **mediasoup** | A *library*, not a server. You write signaling, room state, simulcast layer selection, and reconnect logic yourself, and get **no E2EE**. Excellent primitives, wrong altitude for this brief. |
| **Jitsi Videobridge** | Requires JVM + Prosody + XMPP + Jicofo. Large memory footprint and a genuinely complex operational surface — the opposite of "extremely lightweight". |
| **ion-sfu** | Effectively unmaintained. Disqualified on "mature open-source". |
| **LiveKit CE** ✅ | Single Go binary, Apache-2.0, no paid tier required for anything used here. |

LiveKit ships, out of the box, everything this brief asks for and would otherwise
have to be built: **insertable-streams E2EE**, simulcast, SVC, dynacast, adaptive
stream, scoped JWT auth, and Redis-backed horizontal clustering.

The honest trade-off: LiveKit is Go, so the stack is not homogeneously
TypeScript, and you inherit its release cadence. Both are easily worth it against
writing an SFU.

---

## Encryption

### Two independent layers

**1. Transport (always on).** WebRTC mandates DTLS-SRTP. Every packet between a
browser and the SFU is encrypted and authenticated. This protects against
anyone on the network path — but *not* against the server, which holds the keys
for each hop and could decrypt, record, or modify media.

**2. End-to-end (always on).** Frames are encrypted in the sending browser with
AES-GCM via Insertable Streams (`RTCRtpScriptTransform`), inside a dedicated Web
Worker, and decrypted only in receiving browsers. **The SFU forwards ciphertext
it cannot read.**

### Key distribution without accounts

The hard part of E2EE is key exchange, and with no accounts there is no identity
to exchange keys against. The solution is the URL fragment:

```
https://nmetalk.com/r/k7de-2mqx-9hbt#k=OP1__YS8OjyRs774TT5tPqcDalftY0-MA5JkBsw1R3s
└──────────────── sent to the server ────────────────┘└──── never sent ─────┘
```

A fragment is **never transmitted in an HTTP request**. The 256-bit key is
generated by `crypto.getRandomValues()` in the creator's browser and travels only
inside the link.

The result: the server issues room IDs and join tokens but has no path to the
key. Compromising the server yields ciphertext. This is the same model as a
Signal group invite link, and it is the strongest arrangement achievable without
a user directory.

### What this does and does not protect

| | |
| --- | --- |
| ✅ | Audio, video, and screen content are unreadable by the server or its operator |
| ✅ | A compromised, seized, or subpoenaed SFU yields only ciphertext |
| ✅ | A malicious network operator sees nothing beyond DTLS |
| ❌ | **Metadata** — who joined, when, for how long, at what bitrate — is visible to the server |
| ❌ | **Anyone with the link can join.** The link *is* the credential |
| ❌ | Server-side recording and transcoding are impossible (by design) |

### No downgrade path

If a browser lacks Insertable Streams, **the app refuses to connect** rather than
falling back to transport-only encryption. A silent downgrade is worse than a
clear failure: participants would believe a call is private while the server can
read it.

Likewise, a link arriving without a key produces an explicit error. There is no
default key, no derived key, and no "encryption optional" mode anywhere in the
codebase.

---

## Security

Every decision below is implemented, not aspirational.

### Transport

- **TLS 1.3** via Caddy, with automatic Let's Encrypt issuance and renewal. TLS
  1.2 remains available because forcing a 1.3 floor locks out current mobile
  browsers for no real gain — the permitted 1.2 suites are all forward-secret AEAD.
- **HSTS**, `max-age=63072000; includeSubDomains; preload`.
- **HTTP/3** enabled, which measurably improves connection setup on lossy mobile links.
- **WSS** for signaling; **DTLS-SRTP** for media.

### Content Security Policy

```
default-src 'none'; script-src 'self'; worker-src 'self' blob:;
style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;
media-src 'self' blob: mediastream:;
connect-src 'self' https://sfu.… wss://sfu.…;
base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'
```

`default-src 'none'` means every resource type must be explicitly allowed, so
future additions fail closed. **No inline scripts, no `eval`, no CDN** — the
single most effective XSS mitigation available. `'unsafe-inline'` appears only
for *styles*, which carries none of the code-execution risk it does for scripts.

### Application

| Control | Implementation |
| --- | --- |
| **Meeting IDs** | 12 symbols from a 31-character unambiguous alphabet (~59.5 bits), drawn from `crypto.randomBytes` with **rejection sampling** so there is no modulo bias |
| **Join tokens** | LiveKit JWTs, **120-second TTL**, scoped to exactly one room |
| **Token grants** | `roomJoin`, `canPublish`, `canSubscribe`, `canPublishData` only. **No** `roomAdmin`, `roomList`, `roomCreate`, `recorder`, or `canUpdateOwnMetadata` — a leaked token cannot enumerate meetings, evict people, or start a recording |
| **Replay** | Every token carries a unique random identity registered as a nonce; LiveKit's signed `participant_joined` webhook burns it, and a second use is **evicted** |
| **Rate limiting** | Redis-backed so limits hold across replicas. 10/min room creation, 20/min joins, 100/min global, keyed on the proxy-verified client IP |
| **Input validation** | JSON Schema on every route with AJV **`coerceTypes: false`** and **`removeAdditional: false`** — Fastify's defaults would silently coerce `123` to `"123"` and strip unknown keys instead of rejecting them |
| **XSS** | React escaping, plus server-side normalisation that strips bidi overrides, zero-width characters, and control characters from display names — the vectors for *impersonation*, which escaping alone does not stop |
| **Prototype pollution** | `onProtoPoisoning: 'error'` |
| **CORS** | Explicit origin allowlist. Never reflected, never `*`, credentials disabled |
| **CSRF** | Structurally impossible — **no cookies, no sessions, no ambient authority** anywhere. An `Origin` check on state-changing requests is kept as defence in depth |
| **Cookies** | None are set. The most secure cookie configuration is no cookie |
| **Webhooks** | JWT-signed by LiveKit with a body hash; forged and tampered deliveries are rejected (covered by tests) |
| **Slowloris** | 15s request timeout, 30s connection timeout, 8 KB body limit |
| **Error handling** | Internal errors and stack traces stay in logs; clients get a generic message |
| **Logging** | Authorization headers, cookies, and display names are redacted at the logger |

### Container hardening

`no-new-privileges`, **read-only root filesystem** on the control plane, tmpfs
for `/tmp`, non-root user, per-service CPU and memory limits, and Redis not
published to the host.

### ICE and TURN

The client is given **no hard-coded STUN servers**. Public STUN would leak every
participant's IP address to a third party for no benefit — LiveKit supplies its
own ICE configuration over the authenticated signaling channel.

**Embedded TURN is deliberately disabled**, and the reasoning matters. TURN
relays media between peers that cannot reach each other directly. In an SFU
topology the far end is *your server*, which has a public IP — every client
reaches it outbound through any NAT, so the problem TURN solves does not arise.
UDP/3478 would add an open port and a credential system while covering
essentially nothing that ICE/UDP on 7882 does not.

The one genuine gap is a firewall permitting **only** port 443 — closed by the
optional relay fallback below.

### Relay fallback for restricted networks

Some corporate and hotel networks permit outbound traffic on 443 only. On those,
signaling succeeds (it is WebSocket-over-TLS on 443) but media cannot connect,
so a join fails after the page has loaded perfectly — a confusing failure mode.

The fallback is a **two-phase connect**:

1. **Direct first.** No relay credentials are requested or held. On a normal
   network no third party is contacted, and the join is as fast as ever.
2. **Relay only on failure.** If the media path does not establish within 8
   seconds, the client requests relay credentials and retries.

This ordering is the whole point. ICE gathers all candidate types in parallel,
so simply listing a TURN server in the config would have every participant
contact the relay on every call — even those who never need it. Withholding
credentials until a direct attempt has actually failed means **the relay only
ever sees the participants who genuinely require it.**

Security properties:

| | |
| --- | --- |
| ✅ | Media is encrypted twice over it: DTLS-SRTP, plus the app's own AES-GCM frame encryption. **The relay forwards ciphertext it cannot read** |
| ✅ | `turns:` (TLS) is enforced — the server **refuses to start** with a plain `turn:` URL |
| ✅ | Credentials are ephemeral HMAC (RFC 5766 REST scheme), unique per participant, and never embedded in the frontend bundle |
| ✅ | The relay attempt uses `iceTransportPolicy: 'relay'`, so the participant's real IP is hidden from other participants too |
| ✅ | Participants see a disclosure banner when their connection is relayed |
| ❌ | The relay operator can observe connection **metadata** (IP, timing, volume) for relayed participants — which is why it is fallback-only |

Three provisioning modes, in order of preference:

**1. Cloudflare Realtime** — no relay to operate. Credentials are minted per
participant through Cloudflare's API and expire on their own. Cloudflare
publishes TURNS on **port 443**, which is exactly what a 443-only firewall
permits. Create a TURN key in the Cloudflare dashboard, then set:

```bash
CLOUDFLARE_TURN_KEY_ID=...
CLOUDFLARE_TURN_API_TOKEN=...
```

The API token authenticates *the server* to Cloudflare and never reaches a
browser — only the short-lived credentials it returns do. Cloudflare's response
advertises plain `turn:` and `stun:` URLs alongside the TLS ones; the server
strips everything that is not `turns:` before it reaches the client, so ICE
cannot select an unencrypted relay path.

**2. Self-hosted coturn** — `TURN_URLS` + `TURN_AUTH_SECRET`, with
[`infra/turnserver.conf`](infra/turnserver.conf), which is annotated and
hardened (relay-to-private-IP denied, quotas, no CLI). Needs a host where **port
443 is free**; it cannot share the port with an existing nginx without SNI-level
stream routing.

**3. A hosted relay with fixed credentials** — `TURN_URLS` + `TURN_USERNAME` +
`TURN_CREDENTIAL`. Weakest, because static credentials never expire.

If the provider is unreachable, credential issuance degrades to "no relay
available" within 5 seconds rather than hanging the join.

Leaving `TURN_URLS` unset disables the whole path — the app behaves exactly as
it did before, and restricted-network users simply cannot join.

---

## Performance

Measured from the production build in this repository:

| Asset | Raw | gzip | brotli |
| --- | ---: | ---: | ---: |
| App entry | 13.4 KB | 5.3 KB | 4.6 KB |
| React | 192.5 KB | 60.1 KB | 52.0 KB |
| CSS | 21.8 KB | 5.1 KB | 4.4 KB |
| **Home page total** | **227.7 KB** | **70.5 KB** | **61.0 KB** |
| Meeting UI *(lazy)* | 19.6 KB | 6.6 KB | 5.8 KB |
| LiveKit client *(lazy)* | 528.2 KB | 137.3 KB | 114.7 KB |
| E2EE worker *(lazy)* | 94.4 KB | 29.1 KB | 25.7 KB |

The 137 KB LiveKit client is **never downloaded on the home page** — it loads
only when a `/r/:id` route is opened.

**Frontend**

- No router library (~40 lines instead of ~15 KB), no icon library, no component
  library, no state manager. Six runtime dependencies total across both apps.
- Route-level code splitting; `manualChunks` isolates React and LiveKit for
  long-term caching.
- Content-hashed assets served `immutable` for a year; `index.html` never cached.
- zstd and brotli compression via Caddy.

**Media**

- **Simulcast** — publishes 180p/360p/720p so the SFU forwards the layer each
  receiver can afford, without transcoding. One weak participant no longer
  degrades the call for everyone, and it remains fully E2EE-compatible because
  the SFU selects among *encrypted* layers rather than re-encoding.
- **Adaptive stream** — subscribes at the resolution actually displayed. A
  12-person grid renders ~180p tiles; pulling 720p each would waste ~10× the
  bandwidth and decode budget for pixels nobody sees.
- **Dynacast** — stops publishing layers nobody is subscribed to.
- **Opus DTX** — stops sending during silence, which is most of a meeting.
- Hardware encode/decode wherever the browser offers it; frame encryption runs
  in a **Web Worker**, never competing with rendering.

**Backend**

- Fastify with schema-compiled serialisation.
- 256 MB heap cap so a leak trips a container restart instead of the host OOM killer.
- Graceful shutdown drains in-flight requests, so a redeploy is invisible to
  people in meetings — their media never touches this process.

---

## Scaling

**Target: thousands of concurrent meetings, tens of thousands of participants.**

### Stateless control plane

The Fastify service holds no per-request state. Every replica can serve every
request; scale it with `docker compose up --scale server=N` behind Caddy, or
across machines behind any L7 load balancer. **No session affinity is needed.**

### Clustered SFU

LiveKit nodes share room state through Redis. Any node can serve any participant,
and LiveKit routes a joiner to the node already hosting their room. Add capacity
by starting more `livekit` containers pointed at the same Redis.

Rough per-node capacity, 4 vCPU, all participants publishing 720p simulcast:

| Meeting size | Meetings per node | Participants |
| ---: | ---: | ---: |
| 4 | ~120 | ~480 |
| 10 | ~45 | ~450 |
| 25 | ~15 | ~375 |

The SFU forwards packets without decoding them — **E2EE actually makes this
cheaper**, since transcoding is impossible by construction.

### Shared state

Redis carries rate-limit counters and replay nonces. Without it each replica
would enforce only its own fraction of the limit. The in-memory fallback exists
for single-node deployments and is bounded at 100k entries with amortised O(1)
insertion.

### Path to larger scale

1. **One box** (4 vCPU / 8 GB): a few hundred concurrent participants. This compose file, unmodified.
2. **Split media** — move LiveKit to dedicated nodes; media is bandwidth-bound and the control plane is not.
3. **Regional SFUs** — deploy per region; LiveKit supports multi-region routing so participants connect to their nearest node.
4. **Bottleneck order**: SFU bandwidth first, SFU CPU second. The control plane and Redis stay idle by comparison — a join is two Redis operations and one JWT signature.

---

## Deployment

### Prerequisites

- A Linux host with Docker and Docker Compose v2
- Two DNS records pointing at it, **created before first boot** or certificate
  issuance will fail:

```
nmetalk.com.   A   <your-server-ip>
sfu.nmetalk.com.    A   <your-server-ip>
```

- Open ports: **443/tcp**, **443/udp** (HTTP/3), **80/tcp** (ACME), **7882/udp**
  (media), **7881/tcp** (media fallback)

### Deploy

```bash
git clone <your-repo> nme && cd nme

cp .env.example .env
npm run keys          # prints LIVEKIT_API_SECRET and REDIS_PASSWORD
$EDITOR .env          # paste both in; adjust domains if not nmetalk.com

docker compose -f infra/docker-compose.yml --env-file .env up -d --build
docker compose -f infra/docker-compose.yml logs -f caddy   # watch certs issue
```

Open `https://nmetalk.com`. That is the whole deployment.

### Verify

```bash
curl -sS https://nmetalk.com/api/health          # {"status":"ok"}
curl -sSI https://nmetalk.com | grep -i strict   # HSTS present
docker compose -f infra/docker-compose.yml ps          # all healthy
```

### Hardened TURN (optional)

Only needed for networks that permit **nothing but port 443**. It requires
sharing Caddy's certificates into the LiveKit container:

1. Add a stub site block to `infra/Caddyfile` so Caddy obtains a certificate for
   `turn.nmetalk.com`.
2. Mount `caddy_data` read-only into the `livekit` service.
3. In `infra/livekit.yaml`:

```yaml
turn:
  enabled: true
  domain: turn.nmetalk.com
  tls_port: 5349
  cert_file: /certs/certificates/acme-v02.api.letsencrypt.org-directory/turn.nmetalk.com/turn.nmetalk.com.crt
  key_file:  /certs/certificates/acme-v02.api.letsencrypt.org-directory/turn.nmetalk.com/turn.nmetalk.com.key
```

The ACME directory path changes if Caddy falls back to ZeroSSL — verify it after
first issuance. This brittleness across renewals is precisely why it is not the
default.

---

## Mobile apps

Native iOS and Android clients live in `apps/mobile`. They are not a wrapper
around the website: there is no WebView anywhere in them. Media runs through
libwebrtc via LiveKit's React Native SDK, with the same camera and microphone
pipelines a fully native app would use.

### How encryption works off the web

The browser encrypts frames in a Web Worker using Insertable Streams. Neither
API exists on a phone, so the native clients use libwebrtc's built-in frame
cryptor instead — same AES-GCM, same derived key, different execution
environment.

The part that makes a phone and a browser able to hear each other is narrow
enough to state exactly. LiveKit's key providers accept either a string or raw
bytes, and the two are **not** equivalent:

| Input | Derivation |
|---|---|
| Raw bytes | HKDF-SHA256(key, salt `LKFrameEncryptionKey`, info `0^128`) |
| String | PBKDF2-SHA256(utf8, same salt, 100k iterations) — web only |

The native frame cryptor implements only the HKDF path; hand it a string and it
hashes the characters rather than running PBKDF2 over them. So both clients
pass **raw bytes** (`decodeRoomKey`), which puts them on the one shared
derivation. Passing a string on either side would produce a call that connects,
reports itself healthy, and shows nothing but frozen tiles — an authentication
failure is indistinguishable from a foreign key, so nothing is logged anywhere.

> **Unverified.** This follows from reading both implementations, and it is why
> the code is written the way it is. It has not been confirmed by a real call
> between a phone and a browser, because that needs two devices and a
> deployment. **Do that before publishing anything.** If tiles stay frozen
> across platforms while same-platform calls work, this is the first place to
> look.

### Links open the app

A meeting link opens the app rather than the browser via Universal Links on iOS
and App Links on Android. Both preserve the fragment, which is essential —
that is where the key is, and it is the reason the server never learns it.

This needs two documents served from the meeting domain; see
[docs/app-links.md](docs/app-links.md).

### Building

```bash
npm run prebuild -w @nme/mobile     # generate ios/ and android/
npm run ios -w @nme/mobile          # needs Xcode and CocoaPods
npm run android -w @nme/mobile      # needs a JDK and the Android SDK
```

`ios/` and `android/` are generated from `app.config.ts` and are gitignored —
edit the config, not the output. Point a build at another deployment with
`NME_HOST=meet.example.com`.

### Publishing

The privacy and support pages the stores require are published from `docs/`
via GitHub Pages, and the apps link to them directly. Editing them is editing
plain HTML in this repository.

[docs/store-submission.md](docs/store-submission.md) covers what actually
blocks a release: the user-generated-content guideline, export compliance, and
Google Play's 12-testers rule. Read it before building store assets — one of
those three has a three-week lead time and another is not yet implemented.

---

## Local development

```bash
npm install
cp .env.example .env && npm run keys   # paste the values in

npm run dev:server                     # :8080, needs LiveKit reachable
npm run dev:web                        # :5173, proxies /api to :8080
```

For a local SFU:

```bash
docker run --rm -p 7880:7880 -p 7882:7882/udp \
  -e "LIVEKIT_KEYS=nme: <your-secret>" \
  livekit/livekit-server:v1.13 --dev --bind 0.0.0.0
```

Then set `PUBLIC_LIVEKIT_URL=ws://localhost:7880` and
`CORS_ORIGINS=http://localhost:5173` in `.env`.

> **Note:** E2EE requires a secure context. `localhost` counts as secure, so
> development works — but any other hostname needs HTTPS.

```bash
npm test          # 48 tests across both workspaces
npm run typecheck # strict TypeScript, both workspaces
npm run build
```

---

## Configuration

Everything lives in `.env`; see `.env.example` for the annotated list. The values
that matter most:

| Variable | Default | Notes |
| --- | --- | --- |
| `LIVEKIT_API_SECRET` | — | **The** credential. Signs every join token. 32+ random bytes |
| `LIVEKIT_API_KEY` | `nme` | A public identifier, not a secret. Must match `webhook.api_key` in `infra/livekit.yaml` |
| `TRUST_PROXY` | `172.16.0.0/12` | **Never set to `true` in production** — clients could then spoof their IP and bypass rate limits |
| `TOKEN_TTL` | `120` | Join-token lifetime, seconds. Shorter is stronger |
| `MAX_PARTICIPANTS` | `25` | Must match `room.max_participants` in `infra/livekit.yaml` |
| `VIDEO_CODEC` | `vp8` | `vp9` gives ~30% better compression via SVC at higher client CPU cost |

Client config is served at runtime from `/api/config`, so **one built image works
for every deployment** — changing a hostname needs no rebuild.

---

## Load testing and capacity

The control plane is not the constraint and will not become one: measured at
**~15,000 req/s** and **~13,400 token signatures/s**. Media is the only part of
this stack that scales with participants, so the SFU is what to test and tune.

### Tune the host first

```bash
sudo ./infra/tune-host.sh          # UDP buffers and connection backlog
```

File handles are raised per-container via `ulimits` in the compose file, so no
host-level `ulimit` change is needed.

### Run a real load test

Install the LiveKit CLI, then — **from a different machine than the SFU**. Running
it on the same host measures your own CPU and NIC twice and produces numbers
that mean nothing.

```bash
# Start with one full room, matching MAX_PARTICIPANTS.
lk load-test \
  --url wss://sfu.nmetalk.com \
  --api-key nme --api-secret "$LIVEKIT_API_SECRET" \
  --room load-test --video-publishers 25 --subscribers 25

# Then push until it degrades.
lk load-test ... --video-publishers 150 --subscribers 150
```

### What to watch

Watch **bandwidth, not CPU**. Egress is the ceiling on almost every VPS: roughly
2 Mbps down per participant means a 6-person meeting is ~12 Mbps, and a hundred
of them is ~1.2 Gbps — more than a 1 Gbps NIC can carry, and likely more than a
monthly transfer allowance.

LiveKit exposes Prometheus metrics on `:6789` inside the compose network. It is
deliberately not published; scrape it from a sidecar or read it with
`docker compose exec`.

### Raising the ceilings

`LIVEKIT_CPUS` and `LIVEKIT_MEMORY` in `.env`. The memory cap matters more than
it looks: exceeding it does not slow the SFU down, it makes Docker kill the
container and **every meeting on the host drops at once**. Set
`LIVEKIT_MEMORY=0` to remove the cap once a load test has told you the real
number.

Beyond one machine, add SFU nodes against the same Redis — see
[Scaling](#scaling). The control plane is stateless and already horizontal.

## Operations

**Logs** — structured JSON via pino: `docker compose -f infra/docker-compose.yml logs -f server`

**Metrics** — LiveKit exposes Prometheus on `:6789` inside the compose network.
It is deliberately not published; scrape it from a sidecar.

**Health** — `/api/health`, also wired to the container `HEALTHCHECK`.

**Upgrades** — `docker compose ... up -d --build`. Graceful shutdown drains
in-flight requests; people already in meetings are unaffected, because their
media flows through LiveKit rather than the control plane.

**Rotating the API secret** — regenerate with `npm run keys`, update `.env`,
restart `server` and `livekit` together. Tokens issued under the old secret stop
working within `TOKEN_TTL` seconds.

---

## Project layout

```
packages/
  core/                    Protocol shared by every client
    src/
      e2ee.ts              Key generation, fragment transport, room-id hash
      messaging.ts         Encrypted data-channel envelope
      deeplink.ts          Link -> room key, for the native clients
      api.ts               Typed control-plane client
    (55 tests)
apps/
  server/                  Fastify control plane
    src/
      config.ts            Env parsing; fails fast on bad security config
      app.ts               Middleware stack: helmet, CORS, rate limit, CSRF
      lib/
        ids.ts             CSPRNG IDs with rejection sampling
        displayName.ts     Unicode normalisation and spoofing defence
        livekit.ts         Room creation and scoped token minting
        nonceStore.ts      Replay nonces (Redis or bounded in-memory)
      routes/              rooms, webhooks, health/config
    test/                  31 tests
  web/                     React + Vite SPA
    src/
      lib/
        e2ee.ts            Key generation, fragment transport
        router.ts          40-line router
        api.ts             Typed API client
      room/
        connect.ts         LiveKit setup, E2EE, media tuning
        useRoom.ts         Room lifecycle hook
      pages/               Home, Meeting (lazy)
  mobile/                  Expo + React Native, iOS and Android
    app.config.ts          Permissions, deep links, export declaration
    src/
      polyfills.ts         WebRTC and WebCrypto globals
      room/connect.ts      LiveKit setup with the native frame cryptor
      screens/             Home, PreJoin, Room
infra/
  docker-compose.yml       Full stack
  Caddyfile                TLS, CSP, security headers, proxying
  livekit.yaml             SFU configuration
```

---

## Licence

The application code here is yours to license as you wish. It depends only on
permissively licensed open-source software: LiveKit (Apache-2.0), Caddy
(Apache-2.0), Redis (BSD-3 / RSALv2), Fastify (MIT), React (MIT), Vite (MIT),
Tailwind (MIT). **No paid services, no proprietary components, no telemetry.**
