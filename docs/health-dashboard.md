# Health dashboard

Answers three questions: **is the server being overused**, **is it being
attacked**, and **what is it costing**. It cannot answer "what happened in
meeting X", and that is enforced by what gets collected rather than by who is
allowed to look.

## Turning it on

```ini
# .env — `npm run keys` now emits one
ADMIN_TOKEN=<32+ random bytes>
```

Then visit `https://nmetalk.com/health` and paste the token.

Two panels need something beyond the token, and both stay switched off — saying
so on the page — until they get it:

| Panel | Needs | Default |
| --- | --- | --- |
| Bandwidth, media quality | `LIVEKIT_METRICS_URL` reaching LiveKit's Prometheus port | Already set in compose (`http://livekit:6789/metrics`) |
| Where connections come from | `GEOIP_DB` pointing at a country database | Off — see [Countries](#countries) |

While `ADMIN_TOKEN` is unset, both `/api/admin/stats` and the page it feeds
return **404**, not 401. An endpoint that announces its own existence to an
unauthenticated caller is an invitation to guess at it. For the same reason a
wrong token also gets 404, so the two cases are indistinguishable from outside.

The token lives in `sessionStorage`, so closing the tab discards it.

## Is this against the privacy promise?

**No, as built — and the boundary is worth understanding, because three obvious
additions would cross it.**

What the policy already says: *"the server does see that a meeting happened,
roughly when, and the network addresses that connected to it"* and *"Metadata is
visible to the server."* Counting things the server already observes discloses
nothing new. What would break the promise is **retaining them in a form that can
be queried about a particular meeting**.

### Three things deliberately absent

**Per-meeting rows.** The policy says rooms are held in memory and discarded
shortly after a meeting ends, and that there is no database. A table of past
meetings is a durable record of who met when — precisely the artefact the product
claims not to keep. Everything here is a counter or a histogram bucket.

**Room identifiers, anywhere.** This is the subtle one, and it is the reason the
boundary sits where it does rather than one step further out. **A room id is a
hash of the encryption key.** Anyone holding a meeting link can compute it. So a
log of room ids and timestamps would let a person with an old link prove that a
specific meeting happened, when, for how long, and how many people attended —
without the operator intending to reveal anything. Aggregate counters cannot be
interrogated that way by anyone, including the operator.

**Addresses of anyone who simply used the service.** A record of who connected is
the artefact this design avoids everywhere else.

Display names are filtered out of logs and never reach the metrics at all.

### Where countries sit relative to that line

Inside it, and the reasoning is worth stating because "geolocation" sounds like
it should be outside.

An address is turned into a two-letter code and discarded in the same function
call. What remains is `+1` on a counter shared by everyone who connected from
that country in that hour. **"Four people joined from Germany today" cannot be
narrowed to a person, a meeting, or an address**, and — unlike a log — it does
not become more revealing as it accumulates. That is the same property the other
counters have, which is why it belongs with them.

What would cross the line is a country attached to anything else: a country per
meeting, a country per address, or a time precise enough to correlate with one.
None of those exist, and the lookup returns a code precisely so that no caller
is in a position to build them.

It is also **off by default and not bundled**. A geolocation database ships with
nobody unless its operator goes and gets one, because "every deployment now does
geolocation" is not a decision to make on someone else's behalf through a
default.

### The one exception: sources that were refused

Blocking is impossible without holding the address of the thing being blocked, so
an address that generates repeated *rejections* is retained. The policy already
says an address is "recorded in operational logs used for rate limiting and abuse
handling", and this is that.

The distinction that keeps it honest: **this is a list of who was turned away, not
a list of who joined a meeting.** An address appears only after five refusals in
six hours, the list is capped at 100 entries, and it ages out. Ordinary users
generate almost none, because they arrive by link rather than by guessing.

Blocks expire — 24 hours by default, 30 days maximum. A permanent list would
quietly become the durable record everything else here avoids, and addresses get
reassigned to other people.

### If you ever want per-meeting detail

You would be changing the product, not the dashboard, and the privacy page would
have to change with it. That is a legitimate decision to make deliberately; it is
not a legitimate thing to add quietly because a graph would be nicer.

## What it shows

| Panel | Use |
| --- | --- |
| **Right now** — meetings, participants, media in/out, event-loop lag, CPU, memory, uptime | Live load |
| **Bandwidth** — day totals, hourly history, a month at this rate | What it costs |
| **Media quality** — packet loss, retransmits, RTT, jitter, tracks, transports | Whether calls are actually good |
| **Joins that connected** — tokens issued vs. participants that arrived | The invisible failure |
| **Where connections come from** — counts per country | The shape of the traffic, and of an attack |
| **API responsiveness** — p50/p95/p99 per route, 4xx/5xx | Whether this process is degrading |
| **Resources** — container memory against its limit, heap, host load | How close the kill threshold is |
| **Dependencies** — Redis, SFU metrics, country database, webhooks | What is silently not working |
| **Sources being refused** | Addresses to consider blocking, with a one-click block |
| **Blocked** | Current blocks, with expiry and an unblock button |
| **Last 24 hours** — meetings created, joins, peak participants, rejected joins | Capacity trend |
| **Rejections by reason** — `bad_room_id`, `bad_name`, `room_full` | The abuse signal |
| **Meeting length** — histogram and average | Whether usage matches expectations |
| **Meetings per hour** | Where the peaks are |

`bad_room_id` climbing steadily is what a scripted attempt against the server
looks like: someone walking through room identifiers hoping to find a live one.
Ordinary users generate almost none, because they arrive by link.

**Event-loop lag is the resource number to watch on this process.** Memory and
CPU can both look healthy while the loop is blocked and every request is queued
behind something synchronous. Sustained lag above roughly 100ms means this
process is the bottleneck — which, given the control plane measures ~15k req/s,
would itself be worth investigating rather than scaling around.

### The four numbers worth learning

**Outbound bandwidth** is the bill, and it grows with the *square* of meeting
size: every participant receives a copy of every other participant's streams.
[capacity.md](capacity.md) works the arithmetic through — at scale, egress runs
out long before CPU does. The "at this rate, a month" figure is the last day
×&nbsp;30 and nothing cleverer; it assumes today was typical.

**Connect rate** is tokens issued versus participants LiveKit actually saw. This
is the only failure the control plane cannot otherwise observe: the token is
minted, the room exists, every counter says success — and the media connection
never establishes, leaving somebody looking at a call that will not start. Below
about 90% sustained points at ICE: blocked UDP, an untraversable NAT, or a relay
that is not configured. Slight overshoot above 100% is normal, because a
participant who reconnects after a network change joins twice on one token.

**Packet loss** above roughly 2% is where people describe calls as choppy, and
it is usually the far end's network. What implicates *this server* is loss
rising together with CPU or the connection count — that is the SFU out of
headroom rather than one person on bad Wi-Fi. The transport breakdown next to it
matters for the same reason: a rising TCP share means networks are blocking UDP,
and those calls work but are measurably worse.

**Container memory against its limit** is the most likely hard failure in the
stack, and it is a config value rather than a limit of the software. Exceeding
it does not degrade anything — Docker kills the process. The same is true of the
much larger cap on the LiveKit container, where it would drop every meeting on
the host at once. Both live in `infra/docker-compose.yml`.

### If you are behind Cloudflare, read this first

Everything keyed on an address — countries, the offender list, blocking, and the
rate limiter — is wrong on a Cloudflare-fronted deployment until one flag is set.

`X-Forwarded-For` arrives as `<real client>, <cloudflare edge>`. Fastify walks it
from the right and stops at the first hop it does not trust, and `TRUST_PROXY`
defaults to the Docker bridge — `172.16.0.0/12`. **No Cloudflare range is inside
that.** Their edge lives in `172.64.0.0/13`, `162.158.0.0/15`, `104.16.0.0/13`
and others, so the walk stops on Cloudflare and every request looks like it came
from there.

The visible symptoms: every country reads as wherever the point of presence is,
the offender list fills with Cloudflare addresses, and — the one that bites
without anyone connecting it to Cloudflare — **all users behind a given point of
presence share one rate-limit bucket**, so the per-minute ceilings are reached by
aggregate traffic rather than by any individual.

```ini
# .env
TRUST_CLOUDFLARE=true
```

That reads `CF-Connecting-IP`, but only when the request genuinely arrived from a
published Cloudflare range — a header from anywhere else is ignored, so somebody
who finds the origin address cannot claim to be another user and evade a block.

**Close the origin as well.** The range check is defence in depth, not the whole
defence: an origin reachable directly is an origin whose Cloudflare protections
can be skipped entirely. Allow inbound 443 only from
[Cloudflare's ranges](https://www.cloudflare.com/ips/), and leave the media ports
(7881/tcp, 7882/udp) open to everyone — media does not and cannot go through
Cloudflare's proxy.

To check which of the two applies to you: `dig +short <your domain>`. Addresses
in Cloudflare's ranges mean the proxy is on.

### Countries

Off unless a database is configured. Nothing is bundled and nothing is
downloaded at build time — see [the note above](#where-countries-sit-relative-to-that-line)
on why that is deliberate rather than an omission.

```sh
npm run geoip          # → ./data/country.mmdb, ~8 MB
```

That fetches DB-IP's lite file, which is CC BY 4.0 and needs **no account and no
licence key**. MaxMind's GeoLite2 Country works identically if you already have
an account; both are MMDB, and the reader takes either.

Then, for Docker:

```ini
# .env — the host path. The container path is fixed at /data/country.mmdb.
GEOIP_DB_FILE=/srv/nme/data/country.mmdb
```

or, running the server directly:

```ini
GEOIP_DB=/srv/nme/data/country.mmdb
```

Restart the server. A missing or corrupt file is not fatal: it is logged once,
the panel says the database failed to load, and everything else carries on.

Re-run it every few months. Allocations move between countries, and a stale file
gets quietly less accurate rather than failing. `ZZ` on the dashboard is anything
unresolved — a private address, or a range the database has no entry for.

The reader is [`lib/mmdb.ts`](../apps/server/src/lib/mmdb.ts), about 250 lines,
written here rather than taken from npm: the control plane has four dependencies
and each one is a supply chain reaching a process that holds the LiveKit API
secret. The format is a documented binary trie, which is a smaller thing to own
than a package that parses it.

## Blocking

The rate limiter already throttles automatically. Blocking is the layer above it:
refusing a source outright, which is the difference between slowing an abuser down
and stopping them.

A blocked address gets a bare 403 with no explanation — telling it why would tell
it what to change. The check runs before anything else does work, so a blocked
source costs a map lookup. Webhooks are exempt: they arrive from LiveKit over the
compose network with their own signature, and blocking that address would take the
SFU's replay detection down with it.

Blocks are stored in Redis where it is configured, because a block applied on one
replica has to hold on all of them, with an in-process fallback for single-node
deployments — the same arrangement as the lobby and the nonce store.

## Where the numbers come from

Live counts are asked of LiveKit at request time rather than tracked as server
state — the SFU already knows, and a second source of truth would drift whenever
a room was reaped without the control plane noticing.

Cumulative counts are in-memory counters in `apps/server/src/lib/metrics.ts`,
kept as a rolling 24 hours of hourly buckets so the oldest ages out rather than
accumulating. Nothing is written to disk, which keeps the "there is no database"
claim literally true. **A restart resets them.**

Meeting durations come from LiveKit's `room_finished` webhook, and only the
length is kept — added to a histogram bucket, never stored as a row.
`participant_joined` is where the connected half of the join funnel comes from,
which means **webhooks not arriving silently disables both that number and
replay eviction**. The Dependencies panel shows delivery counts for exactly that
reason: zero while meetings are running is the symptom.

Bandwidth and media quality come from LiveKit's Prometheus endpoint, scraped
every 15 seconds by `apps/server/src/lib/sfu.ts`. Media never passes through the
control plane, so its own network counters would describe a few kilobytes of
JSON and say nothing about what the host is shifting. Prometheus counters are
cumulative, so a throughput figure needs two readings a known interval apart —
which is why the scrape runs on a timer rather than when the page is open, and
why the hourly history begins when the control plane starts rather than when
LiveKit did.

Response times are counted into fixed buckets over a rolling ten-minute window,
keyed on the matched route *pattern* rather than the URL — a URL contains the
room id, which is a hash of the encryption key and must not be retained. p95
from buckets is accurate to within a bucket width, which is far finer than any
decision made from it. Ten minutes rather than since-restart because this is the
panel read *during* an incident, and a p95 averaged over three days of uptime
cannot show that the last few minutes are bad.

Host and container figures come from `os` and the cgroup files. All three layers
are shown because they answer different questions: the process numbers say
whether this service is leaking, the container numbers say how close it is to
the limit Docker kills it at, and the host numbers describe the whole box —
which on this stack is mostly LiveKit.

## What this is not

Not a monitoring system. There is no alerting, no retention beyond a day, and
nothing survives a restart. If you reach the point of wanting history and alerts,
LiveKit already exposes Prometheus metrics on `:6789` inside the compose network
— scrape those with something built for the job rather than growing this into it.
The dashboard reads that same endpoint, so a Prometheus of your own is additive
rather than a replacement.

See also [capacity.md](capacity.md) for what the numbers should look like and
where the ceilings are.
