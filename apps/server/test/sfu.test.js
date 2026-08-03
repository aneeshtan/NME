/**
 * SFU metrics scraping.
 *
 * The parser reads a sibling container's debug endpoint, which is the sort of
 * input that is trusted right up until a LiveKit upgrade changes it. Two
 * properties matter: a malformed or unexpected line must be dropped rather than
 * throw, and rates must be derived from two readings correctly — including the
 * case where LiveKit restarted between them and its counters went back to zero,
 * which naively subtracts to a large negative number.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { parsePrometheusText, resetSfu, scrapeSfu, sfuSnapshot } from '../dist/lib/sfu.js';

/** A cut-down version of what LiveKit actually exposes on :6789. */
function exposition({
  bytesIn,
  bytesOut,
  retransmit = 0,
  lost = 0,
  participants = 0,
  packetsIn = 1000,
}) {
  return `# HELP livekit_packet_bytes Number of bytes
# TYPE livekit_packet_bytes counter
livekit_packet_bytes{direction="incoming",transmission="initial",country=""} ${bytesIn}
livekit_packet_bytes{direction="outgoing",transmission="initial",country=""} ${bytesOut - retransmit}
livekit_packet_bytes{direction="outgoing",transmission="retransmit",country=""} ${retransmit}
# TYPE livekit_packet_total counter
livekit_packet_total{direction="incoming",transmission="initial",country=""} ${packetsIn}
livekit_packet_total{direction="outgoing",transmission="initial",country=""} 4000
# TYPE livekit_packet_loss_total counter
livekit_packet_loss_total{direction="incoming",source="remote",type="video",country=""} ${lost}
# TYPE livekit_nack_total counter
livekit_nack_total{direction="incoming",country=""} 12
livekit_pli_total{direction="incoming",country=""} 3
# TYPE livekit_rtt_ms histogram
livekit_rtt_ms_sum{direction="incoming",source="remote",type="video",country=""} 900
livekit_rtt_ms_count{direction="incoming",source="remote",type="video",country=""} 30
livekit_jitter_us_sum{direction="incoming",source="remote",type="video",country=""} 60000
livekit_jitter_us_count{direction="incoming",source="remote",type="video",country=""} 30
# TYPE livekit_room_total gauge
livekit_room_total{node_id="ND_1",node_type="SERVER"} 2
livekit_participant_total{node_id="ND_1",node_type="SERVER"} ${participants}
livekit_track_published_total{node_id="ND_1",node_type="SERVER",kind="audio"} 5
livekit_track_published_total{node_id="ND_1",node_type="SERVER",kind="video"} 4
livekit_track_subscribed_total{node_id="ND_1",node_type="SERVER",kind="audio"} 20
livekit_connection_total{kind="udp"} 7
livekit_connection_total{kind="tcp"} 1
livekit_participant_join_total{state="success"} 40
livekit_participant_join_total{state="failed"} 2
`;
}

/** Serves fixed bodies in order, one per request. */
async function serving(bodies) {
  let index = 0;
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end(bodies[Math.min(index++, bodies.length - 1)]);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}/metrics`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('parses names, labels, and values', () => {
  const samples = parsePrometheusText(`# a comment
livekit_room_total{node_id="ND_1",node_type="SERVER"} 2
livekit_forward_latency 1.5
livekit_bucket{le="+Inf"} 9 1700000000000
`);

  assert.equal(samples.length, 3);
  assert.deepEqual(samples[0].labels, { node_id: 'ND_1', node_type: 'SERVER' });
  assert.equal(samples[0].value, 2);
  // No labels at all.
  assert.deepEqual(samples[1], { name: 'livekit_forward_latency', labels: {}, value: 1.5 });
  // A trailing timestamp is not part of the value.
  assert.equal(samples[2].value, 9);
});

test('survives label values containing the delimiters', () => {
  const samples = parsePrometheusText('m{a="x,y",b="he said \\"hi\\"",c="}"} 3\n');

  assert.equal(samples.length, 1);
  assert.equal(samples[0].value, 3);
  assert.equal(samples[0].labels.a, 'x,y');
  assert.equal(samples[0].labels.b, 'he said "hi"');
});

test('drops unparseable lines rather than throwing', () => {
  const samples = parsePrometheusText(`
garbage
m_without_value
m_nan NaN
m_broken{a="b" 5
m_good 7
`);

  assert.deepEqual(
    samples.map((sample) => sample.name),
    ['m_good'],
  );
});

test('an unreachable endpoint is a state, not a failure', async () => {
  resetSfu();
  // Port 1 on loopback: nothing listens there, and the connection is refused
  // immediately rather than hanging.
  const snapshot = await scrapeSfu('http://127.0.0.1:1/metrics', 500);

  assert.equal(snapshot.reachable, false);
  assert.ok(snapshot.error, 'the reason should be shown to an operator');
  assert.equal(snapshot.throughput.inMbps, 0);
});

test('throughput needs two readings, and the first one produces none', async () => {
  resetSfu();
  const server = await serving([
    exposition({ bytesIn: 1_000_000, bytesOut: 4_000_000, participants: 3 }),
    exposition({
      bytesIn: 2_000_000,
      bytesOut: 12_000_000,
      retransmit: 600_000,
      lost: 50,
      participants: 4,
    }),
  ]);

  try {
    const first = await scrapeSfu(server.url);
    assert.equal(first.reachable, true);
    assert.equal(first.hasCounters, true);
    // A single cumulative reading says nothing about a rate.
    assert.equal(first.throughput.inMbps, 0);
    assert.equal(first.transferred.bytesOut, 0);
    assert.equal(first.live.participants, 3);
    assert.deepEqual(first.live.connections, { udp: 7, tcp: 1 });
    assert.deepEqual(first.live.tracksPublished, { audio: 5, video: 4 });

    const second = await scrapeSfu(server.url);
    // Only the difference is counted as transferred, never the counter itself —
    // and it is counted even though these two scrapes were milliseconds apart.
    assert.equal(second.transferred.bytesIn, 1_000_000);
    assert.equal(second.transferred.bytesOut, 8_000_000);
    assert.equal(second.live.participants, 4);
    assert.equal(sfuSnapshot().live.participants, 4);
  } finally {
    await server.close();
  }
});

test('rates and quality are derived over the measured window', async () => {
  resetSfu();
  const server = await serving([
    exposition({ bytesIn: 1_000_000, bytesOut: 4_000_000 }),
    exposition({
      bytesIn: 2_000_000,
      bytesOut: 12_000_000,
      retransmit: 600_000,
      lost: 50,
      packetsIn: 2_000,
    }),
  ]);

  try {
    await scrapeSfu(server.url);
    // Long enough that the scrape interval is a window worth dividing by; a
    // sub-second gap deliberately produces no new rate.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const snapshot = await scrapeSfu(server.url);

    assert.equal(snapshot.throughput.windowSeconds, 1);
    // 8 MB out over ~1.1s, in megabits: roughly 58 Mb/s.
    assert.ok(
      snapshot.throughput.outMbps > 40 && snapshot.throughput.outMbps < 70,
      `outMbps was ${snapshot.throughput.outMbps}`,
    );
    assert.equal(snapshot.quality.retransmitPercent, 7.5); // 600k of 8M
    assert.equal(snapshot.quality.rttMs, 30); // 900ms over 30 samples
    assert.equal(snapshot.quality.jitterMs, 2); // 60000us over 30 samples
    // 50 lost against the 1000 that arrived in the same window.
    assert.equal(snapshot.quality.packetLossPercent, 4.76);
  } finally {
    await server.close();
  }
});

test('a restart of LiveKit does not produce a negative rate', async () => {
  resetSfu();
  const server = await serving([
    exposition({ bytesIn: 900_000_000, bytesOut: 5_000_000_000 }),
    // Counters back to almost nothing: the SFU restarted between scrapes.
    exposition({ bytesIn: 1_000, bytesOut: 2_000 }),
  ]);

  try {
    await scrapeSfu(server.url);
    const after = await scrapeSfu(server.url);

    assert.equal(after.transferred.bytesIn, 0);
    assert.equal(after.transferred.bytesOut, 0);
    assert.ok(after.throughput.inMbps >= 0, 'throughput must never go negative');
    assert.ok(after.throughput.outMbps >= 0, 'throughput must never go negative');
  } finally {
    await server.close();
  }
});

test('a LiveKit exposing no byte counters is reported as such', async () => {
  resetSfu();
  const server = await serving(['livekit_room_total{node_id="ND_1"} 1\n']);

  try {
    const snapshot = await scrapeSfu(server.url);
    assert.equal(snapshot.reachable, true);
    // Distinct from zero bandwidth: nothing was measured, rather than nothing
    // flowed.
    assert.equal(snapshot.hasCounters, false);
    assert.equal(snapshot.live.rooms, 1);
  } finally {
    await server.close();
  }
});
