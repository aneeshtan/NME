/**
 * The address the request actually came from.
 *
 * ── The problem ──────────────────────────────────────────────────────────────
 *
 * Fastify's `request.ip` walks `X-Forwarded-For` from the right, trusting hops
 * that match `TRUST_PROXY`, and stops at the first one it does not trust. That
 * is the correct algorithm, and it produces the wrong answer as soon as
 * Cloudflare is in front of the deployment.
 *
 * The header arriving at this process looks like:
 *
 *     X-Forwarded-For: <real client>, <cloudflare edge>
 *
 * Cloudflare sets the first value; Caddy appends the peer it sees, which is
 * Cloudflare. `TRUST_PROXY` defaults to `172.16.0.0/12` — the Docker bridge —
 * and **no Cloudflare range is inside it** (their edge lives in 172.64.0.0/13,
 * 162.158.0.0/15, 104.16.0.0/13 and others). So the walk stops on the
 * Cloudflare edge, and every request appears to come from Cloudflare.
 *
 * That is not cosmetic. It means one rate-limit bucket shared by everyone
 * behind a given point of presence, an offender list of Cloudflare addresses,
 * and a block button that would refuse a Cloudflare edge — which is to say, a
 * large share of legitimate users.
 *
 * ── The fix, and why it is opt-in ────────────────────────────────────────────
 *
 * `CF-Connecting-IP` carries the real client address, and Cloudflare sets it on
 * every request. It is also just a header: anything that can reach the origin
 * directly can send one and claim to be whoever it likes, which would turn the
 * blocklist and the rate limiter into things an attacker can walk straight past.
 *
 * So it is honoured only when **both** hold:
 *
 *   1. `TRUST_CLOUDFLARE` is set. Off by default, because a deployment that is
 *      not behind Cloudflare must never read this header at all.
 *   2. The peer the request actually arrived from is a published Cloudflare
 *      address. This is the part that makes forgery uninteresting — somebody
 *      hitting the origin directly is not coming from a Cloudflare range, so
 *      their header is ignored.
 *
 * Point 2 is defence in depth rather than the whole defence: an origin behind
 * Cloudflare should also refuse connections from anywhere else at the firewall,
 * which is the documented arrangement. Two independent checks, because the
 * consequence of getting this wrong is silent evasion of every limit here.
 */
import { config } from '../config.js';
import { parseAddress } from './mmdb.js';

/**
 * Cloudflare's published edge ranges.
 *
 * Static rather than fetched: a control plane that reaches out to a third party
 * at boot to decide who to trust has made that third party's availability a
 * dependency of its own, and made the trust decision harder to audit. The list
 * changes rarely — check https://www.cloudflare.com/ips/ if a legitimate client
 * ever shows up as a Cloudflare address on the dashboard.
 */
const CLOUDFLARE_RANGES = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
] as const;

interface Network {
  bytes: number[];
  bits: number;
}

const networks: Network[] = CLOUDFLARE_RANGES.map((range) => {
  const [address, prefix] = range.split('/');
  const bytes = parseAddress(address ?? '');
  if (!bytes) throw new Error(`Malformed Cloudflare range: ${range}`);
  return { bytes, bits: Number(prefix) };
});

/** Whether an address falls inside a CIDR, comparing whole bytes then bits. */
function contains(network: Network, address: number[]): boolean {
  if (network.bytes.length !== address.length) return false;

  const wholeBytes = Math.floor(network.bits / 8);
  for (let i = 0; i < wholeBytes; i++) {
    if (network.bytes[i] !== address[i]) return false;
  }

  const remainder = network.bits % 8;
  if (remainder === 0) return true;

  const mask = 0xff << (8 - remainder);
  return ((network.bytes[wholeBytes] ?? 0) & mask) === ((address[wholeBytes] ?? 0) & mask);
}

export function isCloudflareAddress(ip: string): boolean {
  const bytes = parseAddress(ip);
  if (!bytes) return false;
  return networks.some((network) => contains(network, bytes));
}

/**
 * Resolves the client address from the peer and Cloudflare's header.
 *
 * Pure, and separate from Fastify, so the trust rules can be tested directly —
 * this decides who gets rate limited and who can be blocked, which is not logic
 * to leave only exercised through an HTTP stack.
 */
export function resolveClientIp(
  peer: string,
  cfConnectingIp: string | undefined,
  trustCloudflare: boolean,
): string {
  if (!trustCloudflare || !cfConnectingIp) return peer;
  if (!isCloudflareAddress(peer)) return peer;

  // Re-serialised from parsed bytes rather than passed through: this string
  // becomes a rate-limit key, a blocklist entry, and a geolocation lookup, and
  // none of those should ever see an unvalidated header value.
  const bytes = parseAddress(cfConnectingIp);
  if (!bytes) return peer;

  return bytes.length === 4
    ? bytes.join('.')
    : bytes
        .reduce<string[]>((groups, byte, index) => {
          const hex = byte.toString(16).padStart(2, '0');
          if (index % 2 === 0) groups.push(hex);
          else groups[groups.length - 1] += hex;
          return groups;
        }, [])
        .join(':');
}

/**
 * The client address for a request.
 *
 * Everything that treats an address as an identity goes through here — rate
 * limiting, blocking, the offender list, country counts, and the log line. One
 * function so those five can never disagree about who is calling, which is the
 * kind of divergence that produces a block that does not block.
 */
export function clientIp(request: { ip: string; headers: Record<string, unknown> }): string {
  const header = request.headers['cf-connecting-ip'];
  return resolveClientIp(
    request.ip,
    typeof header === 'string' ? header : undefined,
    config.http.trustCloudflare,
  );
}
