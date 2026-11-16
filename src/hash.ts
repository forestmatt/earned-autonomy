/**
 * Stable hashing for bucketing. Published as part of the spec so every SDK
 * (TypeScript, Python, edge) puts the same subject in the same bucket.
 *
 * Algorithm (v1):
 *   h1 = fnv1a32(utf8(salt + ":" + key))
 *   h2 = fnv1a32(utf8(hex(h1)))      // second pass spreads sequential keys
 *   bucket = h2 mod 10000            // 0..9999, so 0.01% resolution
 *
 * Test vectors are in packages/core/test/hash.test.ts.
 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export const BUCKETS = 10_000;

/** UTF-8 bytes of a string, without relying on TextEncoder. Lone surrogates become U+FFFD. */
export function utf8(input: string): number[] {
  const out: number[] = [];
  for (const ch of input) {
    let cp = ch.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return out;
}

/** 32-bit FNV-1a over the UTF-8 bytes of `input`. Returns an unsigned integer. */
export function fnv1a32(input: string): number {
  let hash = FNV_OFFSET;
  for (const byte of utf8(input)) {
    hash ^= byte;
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/** Bucket in [0, 10000) for a key under a salt. */
export function bucket(salt: string, key: string): number {
  const first = fnv1a32(`${salt}:${key}`);
  return fnv1a32(first.toString(16)) % BUCKETS;
}

/** True when `key` falls inside the first `percent` (0 to 100) of buckets for `salt`. */
export function inPercent(salt: string, key: string, percent: number): boolean {
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  return bucket(salt, key) < Math.round(percent * 100);
}

/** Deterministic JSON with sorted keys, for hashing inputs. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** Short stable hash of any JSON value, as 8 hex characters. */
export function hashOf(value: unknown): string {
  return fnv1a32(canonicalJson(value)).toString(16).padStart(8, "0");
}
