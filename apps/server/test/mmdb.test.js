/**
 * MMDB reader.
 *
 * The reader parses a binary format written by someone else, which is exactly
 * the kind of code that is either right or silently wrong — a lookup against a
 * mis-decoded tree returns a plausible country rather than an error. These tests
 * build databases byte by byte so the expected answer is known by construction,
 * and cover all three record widths because the 28-bit case splits a byte into
 * nibbles and is the one most likely to be wrong.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MmdbReader, parseAddress } from '../dist/lib/mmdb.js';

// ── A minimal MMDB writer, for fixtures ──────────────────────────────────────

function control(type, size) {
  if (size > 28) throw new Error('fixture values are all small');
  return type >= 8
    ? Buffer.from([size, type - 7])
    : Buffer.from([(type << 5) | size]);
}

function encodeString(value) {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([control(2, bytes.length), bytes]);
}

function encodeUint(value, type = 6) {
  const bytes = [];
  let remaining = value;
  while (remaining > 0) {
    bytes.unshift(remaining % 256);
    remaining = Math.floor(remaining / 256);
  }
  return Buffer.concat([control(type, bytes.length), Buffer.from(bytes)]);
}

function encodeMap(entries) {
  const parts = [control(7, entries.length)];
  for (const [key, value] of entries) parts.push(encodeString(key), value);
  return Buffer.concat(parts);
}

function encodeArray(values) {
  return Buffer.concat([control(11, values.length), ...values]);
}

/** A four-byte pointer, which is the only width the fixtures need. */
function encodePointer(offset) {
  const header = Buffer.from([(1 << 5) | (3 << 3)]);
  const target = Buffer.alloc(4);
  target.writeUInt32BE(offset);
  return Buffer.concat([header, target]);
}

function writeRecord(buffer, node, index, value, recordSize) {
  const base = node * ((recordSize * 2) / 8);

  if (recordSize === 24) {
    const at = base + index * 3;
    buffer[at] = (value >> 16) & 0xff;
    buffer[at + 1] = (value >> 8) & 0xff;
    buffer[at + 2] = value & 0xff;
    return;
  }

  if (recordSize === 28) {
    if (index === 0) {
      buffer[base] = (value >> 16) & 0xff;
      buffer[base + 1] = (value >> 8) & 0xff;
      buffer[base + 2] = value & 0xff;
      buffer[base + 3] = (buffer[base + 3] & 0x0f) | ((value >> 24) << 4);
    } else {
      buffer[base + 3] = (buffer[base + 3] & 0xf0) | ((value >> 24) & 0x0f);
      buffer[base + 4] = (value >> 16) & 0xff;
      buffer[base + 5] = (value >> 8) & 0xff;
      buffer[base + 6] = value & 0xff;
    }
    return;
  }

  buffer.writeUInt32BE(value, base + index * 4);
}

/**
 * Builds a database from `prefixes`, each `{ bits, country }` where `bits` is a
 * string of '0'/'1' read from the most significant bit of the address.
 */
function buildDatabase({ recordSize = 24, ipVersion = 4, prefixes }) {
  // ── Trie ──
  const nodes = [[null, null]];

  for (const { bits, country } of prefixes) {
    let node = 0;
    for (let i = 0; i < bits.length; i++) {
      const index = Number(bits[i]);
      const last = i === bits.length - 1;

      if (last) {
        nodes[node][index] = { country };
        break;
      }

      if (typeof nodes[node][index] !== 'number') {
        nodes.push([null, null]);
        nodes[node][index] = nodes.length - 1;
      }
      node = nodes[node][index];
    }
  }

  // ── Data section ──
  //
  // Each country's name is written once and referenced through a pointer, so
  // the fixtures exercise pointer decoding rather than only inline values.
  const countries = [...new Set(prefixes.map((entry) => entry.country))];
  const chunks = [];
  const stringOffsets = new Map();
  let length = 0;

  for (const country of countries) {
    stringOffsets.set(country, length);
    const encoded = encodeString(country);
    chunks.push(encoded);
    length += encoded.length;
  }

  const recordOffsets = new Map();
  for (const country of countries) {
    recordOffsets.set(country, length);
    const encoded = encodeMap([
      ['country', encodeMap([['iso_code', encodePointer(stringOffsets.get(country))]])],
    ]);
    chunks.push(encoded);
    length += encoded.length;
  }

  const dataSection = Buffer.concat(chunks);

  // ── Serialise ──
  const nodeCount = nodes.length;
  const nodeSize = (recordSize * 2) / 8;
  const tree = Buffer.alloc(nodeCount * nodeSize);

  nodes.forEach((node, index) => {
    node.forEach((record, side) => {
      // The format's "no data here" value is exactly the node count.
      let value = nodeCount;
      if (typeof record === 'number') value = record;
      else if (record) value = nodeCount + 16 + recordOffsets.get(record.country);
      writeRecord(tree, index, side, value, recordSize);
    });
  });

  const metadata = Buffer.concat([
    Buffer.from([0xab, 0xcd, 0xef]),
    Buffer.from('MaxMind.com', 'ascii'),
    encodeMap([
      ['binary_format_major_version', encodeUint(2, 5)],
      ['binary_format_minor_version', encodeUint(0, 5)],
      ['build_epoch', encodeUint(1_700_000_000)],
      ['database_type', encodeString('Test-Country')],
      ['description', encodeMap([['en', encodeString('fixture')]])],
      ['ip_version', encodeUint(ipVersion, 5)],
      ['languages', encodeArray([encodeString('en')])],
      ['node_count', encodeUint(nodeCount)],
      ['record_size', encodeUint(recordSize, 5)],
    ]),
  ]);

  return Buffer.concat([tree, Buffer.alloc(16), dataSection, metadata]);
}

/** The first `count` bits of an IPv4 address, most significant first. */
function bitsOf(address, count) {
  return address
    .split('.')
    .map((octet) => Number(octet).toString(2).padStart(8, '0'))
    .join('')
    .slice(0, count);
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('parses addresses of both families', () => {
  assert.deepEqual(parseAddress('8.8.8.8'), [8, 8, 8, 8]);
  assert.deepEqual(parseAddress('255.0.0.1'), [255, 0, 0, 1]);
  assert.equal(parseAddress('::1')?.length, 16);
  assert.deepEqual(parseAddress('::1')?.slice(-2), [0, 1]);
  assert.deepEqual(parseAddress('2001:db8::1')?.slice(0, 4), [0x20, 0x01, 0x0d, 0xb8]);

  // A v4-mapped v6 address is reduced to four bytes, because that is where the
  // v4 data lives in the tree.
  assert.deepEqual(parseAddress('::ffff:8.8.8.8'), [8, 8, 8, 8]);

  // Surrounding syntax that says nothing about the network.
  assert.deepEqual(parseAddress(' 8.8.8.8 '), [8, 8, 8, 8]);
  assert.deepEqual(parseAddress('[2001:db8::1]')?.length, 16);
  assert.deepEqual(parseAddress('fe80::1%eth0')?.length, 16);
});

test('rejects anything that is not an address', () => {
  for (const input of ['', 'localhost', '8.8.8', '8.8.8.8.8', '256.0.0.1', '01.2.3.4', '1e2.0.0.1', '2001:db8::1::2', 'gggg::1', '--']) {
    assert.equal(parseAddress(input), null, `${input} should not parse`);
  }
});

for (const recordSize of [24, 28, 32]) {
  test(`finds the right country with ${recordSize}-bit records`, () => {
    const database = buildDatabase({
      recordSize,
      prefixes: [
        { bits: bitsOf('8.0.0.0', 8), country: 'US' },
        { bits: bitsOf('1.1.1.0', 24), country: 'AU' },
        { bits: bitsOf('195.201.0.0', 16), country: 'DE' },
        // Adjacent to the one above, to catch an off-by-one in the bit walk.
        { bits: bitsOf('195.202.0.0', 16), country: 'FR' },
      ],
    });

    const reader = new MmdbReader(database);
    assert.equal(reader.metadata.recordSize, recordSize);
    assert.equal(reader.metadata.databaseType, 'Test-Country');
    assert.equal(reader.metadata.buildEpoch, 1_700_000_000);

    const country = (ip) => reader.lookup(ip)?.country?.iso_code ?? null;

    assert.equal(country('8.8.8.8'), 'US');
    assert.equal(country('8.0.0.0'), 'US');
    assert.equal(country('8.255.255.255'), 'US');
    assert.equal(country('1.1.1.1'), 'AU');
    assert.equal(country('195.201.1.1'), 'DE');
    assert.equal(country('195.202.1.1'), 'FR');

    // Outside every prefix: absent, not the nearest neighbour.
    assert.equal(country('9.0.0.1'), null);
    assert.equal(country('1.1.2.1'), null);
    assert.equal(country('195.203.0.1'), null);
  });
}

test('a v4 lookup in a v6 database walks the v4 subtree', () => {
  // 96 zero bits, then the v4 prefix: how a v6 database stores v4 addresses.
  const database = buildDatabase({
    ipVersion: 6,
    prefixes: [{ bits: '0'.repeat(96) + bitsOf('8.0.0.0', 8), country: 'US' }],
  });

  const reader = new MmdbReader(database);
  assert.equal(reader.lookup('8.8.8.8')?.country?.iso_code, 'US');
  assert.equal(reader.lookup('::ffff:8.8.8.8')?.country?.iso_code, 'US');
  assert.equal(reader.lookup('9.9.9.9'), null);
});

test('a v6 lookup in a v4 database is not attempted', () => {
  const database = buildDatabase({ prefixes: [{ bits: bitsOf('8.0.0.0', 8), country: 'US' }] });
  assert.equal(new MmdbReader(database).lookup('2001:db8::1'), null);
});

test('a corrupt file fails to open rather than answering wrongly', () => {
  assert.throws(() => new MmdbReader(Buffer.alloc(1024)), /Not an MMDB file/);
});

test('lookups on a truncated file return null instead of throwing', () => {
  const database = buildDatabase({ prefixes: [{ bits: bitsOf('8.0.0.0', 8), country: 'US' }] });

  // Keep the metadata (so it opens) but destroy the tree it describes.
  const marker = database.lastIndexOf(Buffer.from('MaxMind.com', 'ascii'));
  const damaged = Buffer.concat([Buffer.alloc(4), database.subarray(marker - 3)]);

  const reader = new MmdbReader(damaged);
  assert.equal(reader.lookup('8.8.8.8'), null);
  assert.equal(reader.lookup('1.2.3.4'), null);
});
