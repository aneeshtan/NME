/**
 * MaxMind DB (MMDB) reader.
 *
 * Enough of the format to answer one question — "which country is this address
 * in" — and nothing more.
 *
 * Written here rather than pulled from npm for two reasons. The obvious one is
 * that the control plane has four dependencies, and each new one is a supply
 * chain reaching a process that holds the LiveKit API secret. The less obvious
 * one is that the format is small: a binary search tree of fixed-width records
 * followed by a tagged data section, both fully documented. What follows is
 * about 250 lines, all of it inspectable, in place of a package that would parse
 * the same bytes.
 *
 * Read-only by construction, and it never throws out of `lookup` — a corrupt or
 * hostile file yields `null`, because this runs on a request path where the
 * correct failure is "country unknown" rather than a 500.
 *
 * Format reference: https://maxmind.github.io/MaxMind-DB/
 */

/** Marks the start of the metadata block, searched for from the end of file. */
const METADATA_MARKER = Buffer.from([0xab, 0xcd, 0xef, ...Buffer.from('MaxMind.com', 'ascii')]);

/** The metadata block is never further than this from the end of the file. */
const METADATA_MAX_SIZE = 128 * 1024;

/** Zero bytes separating the search tree from the data section. */
const DATA_SEPARATOR_SIZE = 16;

export interface MmdbMetadata {
  /** Nodes in the search tree; also the boundary between node and data records. */
  nodeCount: number;
  /** Bits per record. 24, 28, or 32 in practice. */
  recordSize: number;
  /** 4 or 6. A v6 database holds v4 addresses in a subtree. */
  ipVersion: number;
  databaseType: string;
  /** Seconds since the epoch; how stale the data is. */
  buildEpoch: number;
}

export type MmdbValue =
  | string
  | number
  | boolean
  | bigint
  | Buffer
  | MmdbValue[]
  | { [key: string]: MmdbValue }
  | null;

/**
 * Parses a dotted-quad or colon-hex address into bytes.
 *
 * Returns 4 bytes for IPv4 and 16 for IPv6. A v4-mapped v6 address
 * (`::ffff:1.2.3.4`, which is how Node reports a v4 client on a dual-stack
 * socket) is reduced to its 4 bytes, because the v4 subtree is where the data
 * actually lives — relying on the `::ffff:0:0/96` alias node would work on
 * MaxMind's own files and fail on a database built without it.
 */
export function parseAddress(input: string): number[] | null {
  // An interface zone (`fe80::1%eth0`) and brackets are addressing detail that
  // says nothing about which network the address is on.
  const address = input.trim().replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  if (!address) return null;

  if (!address.includes(':')) return parseIPv4(address);

  const bytes = parseIPv6(address);
  if (!bytes) return null;

  // ::ffff:a.b.c.d — the first 80 bits zero, the next 16 set.
  const mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  return mapped ? bytes.slice(12) : bytes;
}

function parseIPv4(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;

  const bytes: number[] = [];
  for (const part of parts) {
    // Matched rather than parsed: `1e2` is accepted by Number, and a leading
    // zero means octal to some resolvers and decimal to others — an address
    // that two pieces of software disagree about is not one to look up.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

function parseIPv6(address: string): number[] | null {
  const halves = address.split('::');
  if (halves.length > 2) return null;

  const expand = (part: string): number[] | null => {
    if (part === '') return [];
    const bytes: number[] = [];
    const pieces = part.split(':');

    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i] ?? '';
      // A trailing dotted quad (`::ffff:1.2.3.4`) is legal and fills two groups.
      if (piece.includes('.')) {
        if (i !== pieces.length - 1) return null;
        const quad = parseIPv4(piece);
        if (!quad) return null;
        bytes.push(...quad);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      const value = Number.parseInt(piece, 16);
      bytes.push(value >> 8, value & 0xff);
    }
    return bytes;
  };

  const head = expand(halves[0] ?? '');
  const tail = halves.length === 2 ? expand(halves[1] ?? '') : [];
  if (!head || !tail) return null;

  if (halves.length === 1) return head.length === 16 ? head : null;

  const gap = 16 - head.length - tail.length;
  if (gap < 1) return null;
  return [...head, ...new Array<number>(gap).fill(0), ...tail];
}

/**
 * The tagged data section.
 *
 * Separate from the tree walk because the metadata block at the end of the file
 * is encoded the same way — the only difference being that its offsets are
 * absolute rather than relative to a data section.
 */
class Decoder {
  constructor(
    private readonly buffer: Buffer,
    private readonly sectionStart: number,
  ) {}

  private byte(at: number): number {
    const value = this.buffer[at];
    if (value === undefined) throw new Error('MMDB read past the end of the file');
    return value;
  }

  /**
   * Decodes one value, returning it with the offset just past it.
   *
   * The offset is returned rather than held on the instance so that following a
   * pointer cannot disturb the caller's position — pointers jump backwards into
   * shared data, which is the whole reason the format is compact.
   */
  decode(offset: number): [MmdbValue, number] {
    const control = this.byte(offset);
    offset += 1;

    let type = control >> 5;
    if (type === 0) {
      // Extended type: the type byte comes before any size extension bytes.
      type = 7 + this.byte(offset);
      offset += 1;
    }

    if (type === 1) {
      const width = (control >> 3) & 0x3;
      const bits = control & 0x7;
      let pointer: number;

      if (width === 0) {
        pointer = (bits << 8) | this.byte(offset);
        offset += 1;
      } else if (width === 1) {
        pointer = ((bits << 16) | this.read(offset, 2)) + 2048;
        offset += 2;
      } else if (width === 2) {
        pointer = ((bits << 24) | this.read(offset, 3)) + 526_336;
        offset += 3;
      } else {
        pointer = this.read(offset, 4);
        offset += 4;
      }

      return [this.decode(this.sectionStart + pointer)[0], offset];
    }

    let size = control & 0x1f;
    if (size === 29) {
      size = 29 + this.byte(offset);
      offset += 1;
    } else if (size === 30) {
      size = 285 + this.read(offset, 2);
      offset += 2;
    } else if (size === 31) {
      size = 65_821 + this.read(offset, 3);
      offset += 3;
    }

    switch (type) {
      case 2:
        return [this.buffer.toString('utf8', offset, offset + size), offset + size];
      case 3:
        return [this.buffer.readDoubleBE(offset), offset + 8];
      case 4:
        return [this.buffer.subarray(offset, offset + size), offset + size];
      case 5:
      case 6:
      case 9:
      case 10:
        return [this.readUnsigned(offset, size), offset + size];
      case 7: {
        const map: Record<string, MmdbValue> = {};
        for (let i = 0; i < size; i++) {
          const [key, afterKey] = this.decode(offset);
          const [value, afterValue] = this.decode(afterKey);
          if (typeof key === 'string') map[key] = value;
          offset = afterValue;
        }
        return [map, offset];
      }
      case 8: {
        // int32, stored in as few bytes as it fits, then sign-extended.
        let value = 0;
        for (let i = 0; i < size; i++) value = (value << 8) | this.byte(offset + i);
        if (size > 0 && size < 4) value = (value << (8 * (4 - size))) >> (8 * (4 - size));
        return [value | 0, offset + size];
      }
      case 11: {
        const items: MmdbValue[] = [];
        for (let i = 0; i < size; i++) {
          const [value, next] = this.decode(offset);
          items.push(value);
          offset = next;
        }
        return [items, offset];
      }
      case 14:
        return [size !== 0, offset];
      case 15:
        return [this.buffer.readFloatBE(offset), offset + 4];
      default:
        // 12 (cache container) and 13 (end marker) never appear in a record.
        throw new Error(`Unsupported MMDB data type: ${type}`);
    }
  }

  /** Big-endian unsigned integer of `size` bytes; a bigint past 48 bits. */
  private readUnsigned(offset: number, size: number): number | bigint {
    if (size === 0) return 0;
    if (size <= 6) return this.read(offset, size);

    let value = 0n;
    for (let i = 0; i < size; i++) value = (value << 8n) | BigInt(this.byte(offset + i));
    return value;
  }

  private read(offset: number, size: number): number {
    let value = 0;
    // Multiplication rather than a shift: `<<` is 32-bit in JavaScript and
    // would silently wrap on the six-byte case.
    for (let i = 0; i < size; i++) value = value * 256 + this.byte(offset + i);
    return value;
  }
}

export class MmdbReader {
  readonly metadata: MmdbMetadata;
  private readonly decoder: Decoder;
  private readonly dataSectionStart: number;
  /** Node reached after 96 zero bits; where v4 lookups begin in a v6 file. */
  private readonly ipv4StartNode: number;

  constructor(private readonly buffer: Buffer) {
    this.metadata = readMetadata(buffer);
    this.dataSectionStart =
      this.metadata.nodeCount * ((this.metadata.recordSize * 2) / 8) + DATA_SEPARATOR_SIZE;

    if (this.dataSectionStart > buffer.length) {
      throw new Error('MMDB search tree extends past the end of the file');
    }

    this.decoder = new Decoder(buffer, this.dataSectionStart);
    this.ipv4StartNode = this.findIPv4Start();
  }

  /** The record for an address, or `null` when the database has no entry. */
  lookup(address: string): MmdbValue {
    try {
      const bytes = parseAddress(address);
      if (!bytes) return null;
      if (bytes.length === 16 && this.metadata.ipVersion === 4) return null;

      const { nodeCount } = this.metadata;
      let node = bytes.length === 4 && this.metadata.ipVersion === 6 ? this.ipv4StartNode : 0;

      for (const byte of bytes) {
        for (let bit = 7; bit >= 0; bit--) {
          if (node >= nodeCount) break;
          node = this.readRecord(node, ((byte >> bit) & 1) as 0 | 1);
        }
      }

      // Exactly the node count is the format's explicit "no data" record.
      if (node <= nodeCount) return null;

      const offset = node - nodeCount - DATA_SEPARATOR_SIZE + this.dataSectionStart;
      if (offset >= this.buffer.length) return null;

      return this.decoder.decode(offset)[0];
    } catch {
      return null;
    }
  }

  /** Walks 96 zero bits from the root, which is where the v4 subtree hangs. */
  private findIPv4Start(): number {
    if (this.metadata.ipVersion !== 6) return 0;

    let node = 0;
    for (let i = 0; i < 96 && node < this.metadata.nodeCount; i++) {
      node = this.readRecord(node, 0);
    }
    return node;
  }

  /** One half of a node: either the next node, or a data-section pointer. */
  private readRecord(node: number, index: 0 | 1): number {
    const { recordSize } = this.metadata;
    const base = node * ((recordSize * 2) / 8);
    const at = (offset: number): number => {
      const value = this.buffer[base + offset];
      if (value === undefined) throw new Error('MMDB read past the end of the search tree');
      return value;
    };

    if (recordSize === 24) {
      const start = index * 3;
      return (at(start) << 16) | (at(start + 1) << 8) | at(start + 2);
    }

    if (recordSize === 28) {
      // The fourth byte is shared: its high nibble extends the left record and
      // its low nibble the right one.
      if (index === 0) {
        return ((at(3) & 0xf0) << 20) | (at(0) << 16) | (at(1) << 8) | at(2);
      }
      return ((at(3) & 0x0f) << 24) | (at(4) << 16) | (at(5) << 8) | at(6);
    }

    if (recordSize === 32) {
      const start = index * 4;
      // Assembled by multiplication rather than `<<`, which is signed 32-bit
      // and would turn a record past 2^31 into a negative number.
      return at(start) * 16_777_216 + (at(start + 1) << 16) + (at(start + 2) << 8) + at(start + 3);
    }

    throw new Error(`Unsupported MMDB record size: ${recordSize}`);
  }
}

function readMetadata(buffer: Buffer): MmdbMetadata {
  const earliest = Math.max(0, buffer.length - METADATA_MAX_SIZE);
  const start = buffer.lastIndexOf(METADATA_MARKER);

  if (start < earliest) throw new Error('Not an MMDB file: metadata marker not found');

  // The metadata block is itself a data-section map, but with absolute offsets,
  // so it decodes against a section start of zero.
  const decoded = new Decoder(buffer, 0).decode(start + METADATA_MARKER.length)[0];
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded) || Buffer.isBuffer(decoded)) {
    throw new Error('MMDB metadata is not a map');
  }

  const map = decoded as Record<string, MmdbValue>;
  const number = (key: string): number => {
    const value = map[key];
    return typeof value === 'number' ? value : 0;
  };

  const metadata: MmdbMetadata = {
    nodeCount: number('node_count'),
    recordSize: number('record_size'),
    ipVersion: number('ip_version'),
    databaseType: typeof map.database_type === 'string' ? map.database_type : 'unknown',
    buildEpoch: number('build_epoch'),
  };

  if (metadata.nodeCount === 0 || ![24, 28, 32].includes(metadata.recordSize)) {
    throw new Error('MMDB metadata is missing a usable node count or record size');
  }

  return metadata;
}
