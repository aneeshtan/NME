# Capacity, load testing, and where the ceiling actually is

Two questions this answers: how many people fit in one meeting, and how many
meetings fit on one box. They have different answers and different bottlenecks.

**Nothing here is a measurement.** It is a model built from the configuration in
this repository, and its purpose is to tell you what to measure and roughly what
to expect. Replace every number below with your own the first time you run a
load test — the model's inputs (bitrate per layer, tiles rendered, subscriber
behaviour) are the parts most likely to be wrong for your deployment.

---

## Raising the participant cap

50 people in one room is refused until three numbers agree. Two are settings and
the third is a hard limit:

| Where | Default | Note |
| --- | ---: | --- |
| `.env` → `MAX_PARTICIPANTS` | 25 | server rejects the 26th joiner |
| `infra/livekit.yaml` → `room.max_participants` | 25 | SFU rejects independently |
| `apps/server/src/config.ts` | — | validator refuses anything above **100** |

Change the first two together. Leaving them mismatched produces the confusing
case where the control plane admits someone the SFU then turns away.

Crossing 25 also changes how clients publish — see [Room-size-aware
publishing](#room-size-aware-publishing) below.

---

## One big meeting

The cost of a meeting is quadratic. Every participant subscribes to every other,
so *n* people produce *n*(*n*−1) forwarded streams:

| Participants | Forwarded streams |
| ---: | ---: |
| 10 | 90 |
| 25 | 600 |
| 50 | 2,450 |

Four times the people is four times the load, not twice.

### Bandwidth

With everyone on camera, `adaptiveStream` subscribes each tile at the layer its
rendered size justifies, and the grid caps at nine tiles — so a participant
pulls nine small video streams plus audio for everyone, rather than 49 of each.

Taking ~120 kbps for a 180p layer and 24 kbps for Opus:

| | 25-person room | 50-person room |
| --- | ---: | ---: |
| Video subscribed per participant | 9 × 120 kbps ≈ 1.1 Mbps | 9 × 120 kbps ≈ 1.1 Mbps |
| Audio subscribed per participant | 24 × 24 kbps ≈ 0.6 Mbps | 49 × 24 kbps ≈ 1.2 Mbps |
| **Downlink per participant** | **~1.7 Mbps** | **~2.3 Mbps** |
| **SFU egress, whole room** | **~43 Mbps** | **~115 Mbps** |

The tile cap is what keeps that second column from being ~6 Mbps down per
person and ~300 Mbps of egress for a single meeting. Opus DTX means the audio
figures are worst-case; in practice most participants are silent and send
almost nothing.

### The real constraint is the receiver

Before any of the above troubles a server, it troubles a phone. Every rendered
tile is a live video decode, and a mid-range handset thermally throttles
somewhere well below 25 of them. This is why the grid is bounded at nine and why
that number is a client-side decision rather than a server setting.

Everyone past the ninth tile is still heard, still listed in the participants
panel, and still reachable by pinning them or switching to speaker view.

---

## Many meetings on one box

Here the answer is bandwidth, and it is not close.

Four vCPUs will forward packets for several hundred participants. A 1 Gbps NIC
will not carry them. At ~2 Mbps down per participant, egress alone caps you
around **400–500 concurrent participants** regardless of how much CPU you buy:

```
500 participants × 2 Mbps = 1 Gbps sustained
                          ≈ 450 GB per hour
```

Against a typical 20 TB monthly transfer allowance, that is roughly **44 hours
at full load** before overage. For most deployments the transfer bill arrives
long before the CPU graph gets interesting.

Order of failure, in practice:

1. **Egress bandwidth** — or the monthly transfer cap, whichever bites first
2. **SFU CPU** — packet forwarding and congestion control
3. **Control plane** — measured at ~15,000 req/s. It will not be the problem.
4. **Redis** — a join is two operations. Idle by comparison.

Scale past one box by adding LiveKit nodes against the same Redis; the control
plane is already stateless. See the Scaling section of the README.

---

## Room-size-aware publishing

When `MAX_PARTICIPANTS` exceeds 25, clients change how they publish
([connect.ts](../apps/web/src/room/connect.ts)):

| | ≤ 25 | > 25 |
| --- | --- | --- |
| Capture resolution | 720p | 540p |
| Top simulcast layer | 720p | 540p |
| Opus RED | on | off |

Both are trades, not free wins.

**Resolution.** This does not reduce what any subscriber receives — `dynacast`
already stops publishing and encoding layers nobody is watching, so in a large
grid the 720p layer was never being sent. What it saves is the capture pipeline:
the camera opens at fewer pixels and every downscale starts from fewer pixels.

**RED** duplicates each Opus packet into its successor, so an isolated loss
costs nothing. It also roughly doubles audio bitrate — and audio is the one
thing subscribed for *every* participant, including those past the tile cap.
Dropping it makes a lossy network audibly worse. If your users are mostly on
poor connections, set `MAX_PARTICIPANTS` to 25 and run more rooms, or edit the
threshold.

The threshold is deliberately above the default so an unmodified deployment
behaves exactly as it did before.

---

## Running a real load test

From a **different machine** than the SFU. On the same host you measure your own
CPU and NIC twice and the numbers mean nothing.

```bash
# One full room at the current cap.
lk load-test \
  --url wss://sfu.nmetalk.com \
  --api-key nme --api-secret "$LIVEKIT_API_SECRET" \
  --room stress --video-publishers 25 --subscribers 25

# A 50-person room — requires the cap raised in both places first.
lk load-test ... --room stress-50 --video-publishers 50 --subscribers 50

# Then push until it degrades.
lk load-test ... --video-publishers 150 --subscribers 150
```

Tune the host before the first run, or you will measure the kernel's default UDP
buffers rather than the SFU:

```bash
sudo ./infra/tune-host.sh
```

### What to watch

Bandwidth first, CPU second.

```bash
docker stats                                    # container CPU and memory
docker compose -f infra/docker-compose.yml exec livekit \
  wget -qO- localhost:6789/metrics | head -40   # LiveKit Prometheus metrics
```

The metrics port is deliberately not published — read it from inside the
network or scrape it with a sidecar.

Note the memory ceiling. `LIVEKIT_MEMORY` defaults to 4G, and exceeding it does
not slow the SFU down: Docker kills the container and **every meeting on the
host drops at once**. Once a load test tells you the real number, either raise
it with headroom or set `LIVEKIT_MEMORY=0` to remove the cap.

---

## What the client costs to load

Measured from the production build in this repository, gzip over the wire:

| | gzip |
| --- | ---: |
| Home page (React + entry + CSS) | 76 KB |
| Meeting UI *(lazy)* | 18 KB |
| LiveKit client *(lazy)* | 137 KB |
| E2EE worker *(lazy)* | 29 KB |

The LiveKit client is never fetched on the home page — only when a meeting route
opens.

Background blur was removed. It carried three TensorFlow.js chunks (~190 KB
gzip) plus a 332 KB model, all fetched on first use. It was correctly lazy, so
it cost nothing until someone enabled it — but nothing is still cheaper, and the
platform-native blur that some cameras expose covers the common case. The code
is in git history if it is wanted back.

### If you need it lighter still

- **Preact via `compat`** would remove roughly 45 KB gzip of the 76 KB home
  page. It is the single largest remaining win and also the riskiest change
  here; React 19 features and LiveKit's React surface both need verifying.
- **VP9** above ~30 publishers (`VIDEO_CODEC=vp9`), at the cost of encoder CPU
  on every client.
- **Lower `MAX_VIDEO_TILES`** in `Grid.tsx` from nine to six for deployments
  aimed at phones.

Do not spend effort on the control plane. At ~15,000 req/s it is not, and will
not become, the constraint.
