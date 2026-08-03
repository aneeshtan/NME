# Installing NME Talk on a VPS behind an existing panel

For a host where something else — CloudPanel, Plesk, or a hand-rolled nginx —
already owns ports 80 and 443. Caddy stays on localhost and serves plain HTTP;
the panel terminates TLS in front of it.

If nothing else is installed on the box, ignore this file and follow the
[Deployment section of the README](../README.md#deployment) instead. Standalone
mode is simpler and issues its own certificates.

Worked examples use the two hostnames this deployment ships with:

| Hostname          | Serves                        | Proxies to       |
| ----------------- | ----------------------------- | ---------------- |
| `nmetalk.com`     | the app, and `/api/*`         | `127.0.0.1:8080` |
| `sfu.nmetalk.com` | LiveKit signaling (WebSocket) | `127.0.0.1:7880` |

---

## 1. The part that catches everyone

**Media does not travel through your panel.** Audio and video go straight to the
LiveKit container on `7882/udp`, with `7881/tcp` as a fallback for networks that
block UDP. Only signaling — the WebSocket that negotiates the call — passes
through the reverse proxy.

So the panel handles two ordinary HTTP sites, and the firewall has to let two
extra ports through untouched. No reverse proxy can carry the media path; nginx
does not proxy UDP in any configuration you would want here.

If those two ports are closed, everything looks correct — the app loads, people
appear in the participant list — and nobody can see or hear anyone.

---

## 2. DNS

Both records must exist and resolve **before** you start the stack.

```
nmetalk.com.       A   <your-server-ip>
sfu.nmetalk.com.   A   <your-server-ip>
```

`nmetalk.com` is an apex domain, so it needs an `A` record — a `CNAME` at the
apex is invalid in DNS and most registrars will refuse it. If you also want
`www.nmetalk.com`, add it as a `CNAME` to the apex and set up a redirect in the
panel; do not point it at the app directly, or you end up with meeting links on
two origins and a CORS rejection on whichever one is not in `CORS_ORIGINS`.

Confirm before continuing:

```bash
dig +short nmetalk.com sfu.nmetalk.com
```

---

## 3. Firewall

```bash
sudo ufw allow 80/tcp        # panel: ACME + redirect
sudo ufw allow 443/tcp       # panel: TLS
sudo ufw allow 7882/udp      # media — the primary path
sudo ufw allow 7881/tcp      # media — fallback for UDP-blocked clients
sudo ufw enable
```

Many VPS providers have a second firewall in their control panel that is applied
before anything running on the host. Check it too — a cloud firewall silently
dropping `7882/udp` presents exactly as a broken call.

Do **not** open `7880`. Compose publishes it on `127.0.0.1` only, and it is
reached by the panel over loopback.

---

## 4. Host tuning

Run once, as root. It raises the UDP socket buffers pion needs and the file
handle limit LiveKit asks for; without it, calls degrade under load in a way
that looks like a bandwidth problem and is not one.

```bash
sudo bash infra/tune-host.sh
```

---

## 5. Clone and generate secrets

```bash
git clone <your-repo> nmetalk && cd nmetalk
cp .env.example .env
npm run keys      # prints LIVEKIT_API_SECRET and REDIS_PASSWORD
```

`npm run keys` only prints — paste both values into `.env` yourself. Never
commit `.env`.

---

## 6. `.env`

The defaults already carry the new domain. Confirm these, and add the three
lines in the second block:

```ini
APP_DOMAIN=nmetalk.com
LIVEKIT_DOMAIN=sfu.nmetalk.com
PUBLIC_APP_URL=https://nmetalk.com
PUBLIC_LIVEKIT_URL=wss://sfu.nmetalk.com
CORS_ORIGINS=https://nmetalk.com

# Behind a front proxy: keep Caddy on localhost so the panel keeps 80/443.
HTTP_BIND=127.0.0.1:8080
HTTPS_BIND=127.0.0.1:8443
CADDYFILE=./Caddyfile.cloudpanel

LIVEKIT_API_SECRET=<from npm run keys>
REDIS_PASSWORD=<from npm run keys>
```

Three things worth knowing:

- `CORS_ORIGINS` is matched exactly. No trailing slash, no `www`, and the scheme
  is part of it.
- `ACME_EMAIL` is unused in this mode — the panel owns certificates now — but
  leaving it set costs nothing and is what you want if you ever switch to
  standalone.
- `LIVEKIT_API_KEY=nme` is an identifier, not a secret, and it is duplicated as
  a literal in `infra/livekit.yaml` under `webhook.api_key`. If you change one,
  change both, or webhook deliveries fail signature verification and replayed
  join tokens stop being evicted.

---

## 7. Start the stack

Run from the repository root, and keep `--env-file .env` — Compose otherwise
resolves `.env` next to the compose file, in `infra/`, and every variable comes
up empty.

```bash
docker compose -f infra/docker-compose.yml --env-file .env up -d --build
docker compose -f infra/docker-compose.yml ps
```

Wait for `redis` and `server` to report healthy. Then check Caddy is answering
on loopback before you touch the panel:

```bash
curl -sI http://127.0.0.1:8080 | head -1          # HTTP/1.1 200 OK
curl -sS http://127.0.0.1:8080/api/health         # {"status":"ok"}
```

If that fails, the problem is in the stack and no amount of proxy configuration
will help.

---

## 8. The two proxy sites

### CloudPanel

**Site one — the app.**

1. Sites → **Add Site** → **Create Reverse Proxy**
2. Domain name: `nmetalk.com`
3. Reverse Proxy URL: `http://127.0.0.1:8080`
4. Create, then SSL/TLS → **New Let's Encrypt Certificate**

**Site two — the SFU.**

Same again, with domain `sfu.nmetalk.com` and URL `http://127.0.0.1:7880`.

Then open the vhost for `sfu.nmetalk.com` (Site Settings → **Vhost**) and
confirm the WebSocket upgrade is present in the `location /` block. CloudPanel
includes it in current versions, but verify rather than assume — without it the
connection is refused at the handshake and the app never gets past "Joining
meeting…".

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";

# A signaling socket stays open for the length of the meeting. The default
# 60s read timeout would cut every call after a minute of quiet.
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
```

### Plain nginx

```nginx
server {
    listen 443 ssl http2;
    server_name nmetalk.com;

    # ssl_certificate … managed by certbot

    # HSTS lives here. The Caddyfile behind this deliberately does not set it —
    # the layer terminating TLS owns that header, and two copies is a bug.
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 443 ssl http2;
    server_name sfu.nmetalk.com;

    location / {
        proxy_pass http://127.0.0.1:7880;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host       $host;
        proxy_set_header X-Real-IP  $remote_addr;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

`X-Forwarded-For` is not optional. The API rate-limits per client IP, and
without it every request in the system appears to arrive from the panel — one
address, one bucket, and the limiter stops meaning anything.

### `/.well-known/` must pass through

Panels intercept `/.well-known/acme-challenge/` for certificate renewal, which
is correct. Some intercept the whole `/.well-known/` prefix, which is not: it
makes the two app-association documents return the panel's 404, and every
meeting link then opens in the browser instead of the native app.

Verify after the certificate is issued — see the next section.

---

## 9. Verify

```bash
# App and API through the panel
curl -sS  https://nmetalk.com/api/health           # {"status":"ok"}
curl -sSI https://nmetalk.com | grep -i strict     # HSTS, exactly one line

# App association — must be application/json, not text/html
curl -sI https://nmetalk.com/.well-known/apple-app-site-association | grep -i content-type
curl -s  https://nmetalk.com/.well-known/assetlinks.json | python3 -m json.tool

# Signaling upgrade — expect HTTP 101, not 200 or 502
curl -sSI -o /dev/null -w '%{http_code}\n' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://sfu.nmetalk.com/rtc

# Media ports, from somewhere that is not the server
nc -vzu <your-server-ip> 7882
nc -vz  <your-server-ip> 7881
```

Then the only test that counts: open `https://nmetalk.com` on two devices on
**different networks** — one on Wi-Fi, one on cellular — and confirm you can see
and hear each other. Two tabs on the same machine exercise almost none of the
ICE path.

---

## 10. When it does not work

| Symptom                                             | Cause                                                                       |
| --------------------------------------------------- | --------------------------------------------------------------------------- |
| Everything empty, `:?` errors from Compose           | `--env-file .env` omitted, or run from `infra/` instead of the repo root      |
| Stuck on "Joining meeting…"                          | WebSocket upgrade missing on the `sfu.` vhost                                |
| Joins, then drops after ~60s                         | `proxy_read_timeout` left at the nginx default                               |
| Connects, participants listed, no audio or video     | `7882/udp` blocked — check the provider's firewall as well as `ufw`          |
| Calls work but always say "Connected via relay"      | UDP blocked, falling back to `7881/tcp`; same fix                            |
| Browser console shows a CORS rejection               | `CORS_ORIGINS` does not match the origin exactly (`www`, scheme, trailing `/`) |
| Meeting links open the browser, not the app          | `/.well-known/` intercepted by the panel, or the association files are unfilled |
| Rate limiting triggers for everyone at once          | `X-Forwarded-For` not set by the front proxy                                 |
| Duplicate `Strict-Transport-Security` header         | Set by both the panel and Caddy; `Caddyfile.cloudpanel` omits it, so check the panel |

Logs:

```bash
docker compose -f infra/docker-compose.yml logs -f caddy server livekit
```

---

## 11. Before the mobile builds

The association files in `apps/web/public/.well-known/` must match the shipping
apps or Universal Links and App Links fail verification. Meetings still work;
links just open in the browser.

- `apple-app-site-association` is configured for the native iOS identifier
  `WC955H63L3.com.ctrlaltl.nme`; deploy the current web build because the live
  endpoint may still have the former placeholder
- `assetlinks.json` → replace `REPLACE_WITH_SIGNING_CERT_SHA256` with the SHA-256
  fingerprint of the signing certificate

Both are served from the app domain, so they redeploy with the web build. See
[app-links.md](app-links.md) and [store-submission.md](store-submission.md).

The native iOS identifier is `com.ctrlaltl.nme`; Android remains
`com.nmetalk.app`. Both use the `nmetalk` URL scheme and point at
`nmetalk.com` by default. Configure an iOS staging deployment in
`apps/ios/Configuration/Shared.xcconfig`; Android continues to use `NME_HOST`.
