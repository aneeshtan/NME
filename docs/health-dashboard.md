# Health dashboard

Answers two questions: **is the server being overused**, and **is it being
attacked**. It cannot answer "what happened in meeting X", and that is enforced
by what gets collected rather than by who is allowed to look.

## Turning it on

```ini
# .env — `npm run keys` now emits one
ADMIN_TOKEN=<32+ random bytes>
```

Then visit `https://nmetalk.com/health` and paste the token.

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

**IP addresses.** They already appear in request logs for rate limiting, which
the policy discloses and which rotate. Surfacing them in a dashboard would turn a
rotating operational log into a browsable record of who connected.

Display names are filtered out of logs and never reach the metrics at all.

### If you ever want per-meeting detail

You would be changing the product, not the dashboard, and the privacy page would
have to change with it. That is a legitimate decision to make deliberately; it is
not a legitimate thing to add quietly because a graph would be nicer.

## What it shows

| Panel | Use |
| --- | --- |
| **Right now** — active meetings, participants, memory, uptime | Live load |
| **Last 24 hours** — meetings created, joins, peak participants, rejected joins | Capacity trend |
| **Rejections by reason** — `bad_room_id`, `bad_name`, `room_full` | The abuse signal |
| **Meeting length** — histogram and average | Whether usage matches expectations |
| **Meetings per hour** | Where the peaks are |

`bad_room_id` climbing steadily is what a scripted attempt against the server
looks like: someone walking through room identifiers hoping to find a live one.
Ordinary users generate almost none, because they arrive by link.

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

## What this is not

Not a monitoring system. There is no alerting, no retention beyond a day, and
nothing survives a restart. If you reach the point of wanting history and alerts,
LiveKit already exposes Prometheus metrics on `:6789` inside the compose network
— scrape those with something built for the job rather than growing this into it.

See also [capacity.md](capacity.md) for what the numbers should look like and
where the ceilings are.
