/**
 * Operational counters.
 *
 * Two properties are being defended here. The first is arithmetic: a percentile
 * read off a histogram is the number an operator makes a scaling decision from,
 * and one computed from the wrong bucket edge is wrong quietly. The second is
 * that every collection in this module stays bounded — these are fed by
 * unauthenticated requests, so anything that can be grown without limit by a
 * caller is a memory exhaustion primitive rather than a metric.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  percentileFrom,
  recordBandwidth,
  recordCountry,
  recordHttpResponse,
  recordJoinRejected,
  recordParticipantConnected,
  recordTokenIssued,
  recordWebhookEvent,
  snapshot,
} from '../dist/lib/metrics.js';

/** Bucket edges in lib/metrics.ts, plus the overflow slot. */
const EDGES = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

function bucketsFor(samples) {
  const buckets = new Array(EDGES.length + 1).fill(0);
  for (const value of samples) {
    const index = EDGES.findIndex((edge) => value <= edge);
    buckets[index === -1 ? EDGES.length : index] += 1;
  }
  return buckets;
}

test('percentiles interpolate inside the bucket they land in', () => {
  // Every sample falls in the 2ms–5ms bucket, so the median sits halfway across
  // it and higher quantiles move steadily toward its top edge.
  const buckets = bucketsFor(new Array(100).fill(3));
  assert.equal(percentileFrom(buckets, 0.5), 3.5);
  assert.equal(percentileFrom(buckets, 0.9), 4.7);
  assert.equal(percentileFrom(buckets, 0.95), 4.9);
});

test('percentiles pick out the slow tail rather than averaging it away', () => {
  // 90 fast requests and 10 very slow ones. The mean is 91ms, which describes
  // neither group; p95 has to land among the slow ones.
  const buckets = bucketsFor([...new Array(90).fill(1), ...new Array(10).fill(900)]);
  assert.ok(percentileFrom(buckets, 0.5) <= 1, 'p50 belongs to the fast group');
  assert.ok(percentileFrom(buckets, 0.95) > 500, 'p95 must land in the slow bucket');
});

test('a percentile above the top edge reports the edge, not a guess', () => {
  const buckets = bucketsFor([20_000]);
  assert.equal(percentileFrom(buckets, 0.99), 5000);
});

test('an empty histogram is zero rather than NaN', () => {
  assert.equal(percentileFrom(new Array(EDGES.length + 1).fill(0), 0.95), 0);
});

test('response times are summarised per route', () => {
  for (let i = 0; i < 20; i++) recordHttpResponse('/rooms/:roomId/join', 200, 30);
  recordHttpResponse('/rooms/:roomId/join', 500, 400);
  recordHttpResponse('/rooms', 201, 4);

  const { http } = snapshot();
  const join = http.routes.find((route) => route.route === '/rooms/:roomId/join');

  assert.equal(join.count, 21);
  assert.equal(join.statusClasses['2xx'], 20);
  assert.equal(join.statusClasses['5xx'], 1);
  // The single slow failure must show in p99 and not in p50.
  assert.ok(join.p50 < 50, `p50 was ${join.p50}`);
  assert.ok(join.p99 > 250, `p99 was ${join.p99}`);

  assert.equal(http.statusClasses['5xx'], 1);
  assert.equal(http.requests, 22);
  // Busiest first, so the top of the table is the route worth reading.
  assert.equal(http.routes[0].route, '/rooms/:roomId/join');
});

test('route keys cannot be grown without limit by a caller', () => {
  // A prober hitting a thousand distinct paths must not create a thousand keys.
  for (let i = 0; i < 1000; i++) recordHttpResponse(`/probe-${i}`, 404, 1);

  const { http } = snapshot();
  assert.ok(http.routes.length <= 65, `held ${http.routes.length} routes`);
  assert.ok(
    http.routes.some((route) => route.route === 'other'),
    'the overflow key should absorb the rest',
  );
});

test('countries are counted, and anything unresolved is ZZ', () => {
  recordCountry('DE', 'joined');
  recordCountry('DE', 'joined');
  recordCountry('DE', 'refused');
  recordCountry(null, 'joined');
  // Not a country code: it becomes ZZ rather than a new key.
  recordCountry('de', 'joined');
  recordCountry('LONG', 'refused');

  const byCode = Object.fromEntries(snapshot().countries.map((row) => [row.code, row]));

  assert.deepEqual(byCode.DE, { code: 'DE', joined: 2, refused: 1 });
  assert.equal(byCode.ZZ.joined, 2);
  assert.equal(byCode.ZZ.refused, 1);
  assert.equal(byCode.de, undefined);
});

test('the country map is bounded', () => {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const first of letters) {
    for (const second of letters) recordCountry(`${first}${second}`, 'joined');
  }

  assert.ok(snapshot().countries.length <= 300, 'more countries than the cap allows');
});

test('bandwidth accumulates and ignores nonsense', () => {
  const before = snapshot().bandwidth.bytesTotal;

  recordBandwidth(1_000_000, 4_000_000);
  recordBandwidth(500_000, 1_000_000);
  // A counter reset upstream, or a scrape that returned nothing usable.
  recordBandwidth(-5, 10);
  recordBandwidth(Number.NaN, 1_000);

  const { bandwidth } = snapshot();
  assert.equal(bandwidth.bytesIn - 0, 1_500_000);
  assert.equal(bandwidth.bytesOut, 5_000_010);
  assert.equal(bandwidth.bytesTotal, before + 6_500_010);
});

test('the join funnel compares tokens against participants that connected', () => {
  for (let i = 0; i < 10; i++) recordTokenIssued();
  for (let i = 0; i < 7; i++) recordParticipantConnected();

  const { funnel } = snapshot();
  assert.equal(funnel.tokensIssued, 10);
  assert.equal(funnel.participantsConnected, 7);
  assert.equal(funnel.connectRate, 70);
});

test('webhook event names are counted and bounded', () => {
  recordWebhookEvent('participant_joined');
  recordWebhookEvent('participant_joined');
  recordWebhookEvent('room_finished');
  for (let i = 0; i < 100; i++) recordWebhookEvent(`invented_${i}`);

  const { webhookEvents } = snapshot().totals;
  assert.equal(webhookEvents.participant_joined, 2);
  assert.equal(webhookEvents.room_finished, 1);
  assert.ok(Object.keys(webhookEvents).length <= 32);
});

test('no address reaches the snapshot below the offender threshold', () => {
  recordJoinRejected('bad_room_id', '203.0.113.9');
  recordJoinRejected('bad_room_id', '203.0.113.9');

  const serialised = JSON.stringify(snapshot());
  assert.ok(!serialised.includes('203.0.113.9'), 'an address leaked into the metrics snapshot');
});
