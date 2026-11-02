/**
 * Signed approvals. A human approval only counts when the builder's backend vouches for it.
 *
 * The builder's server holds a per-project signing secret and mints a short-lived token for the
 * logged-in user who pressed "approve". The agent never sees the secret, so it can't forge one.
 * Throtl checks the token against what is being approved (one decision and outcome, or one
 * promotion scope) and rejects unsigned human approvals once the project has a secret.
 *
 * Format: `tap1.<base64url(JSON claims)>.<base64url(HMAC-SHA256(secret, "tap1." + payload))>`.
 * WebCrypto only, so it runs in Workers, Node 20+, Deno, Bun and browsers alike.
 */

export const APPROVAL_TOKEN_PREFIX = "tap1";
/** Longest lifetime we accept. Approvals are minted at the moment a human clicks, so keep them short. */
export const MAX_APPROVAL_TTL_S = 3600;
/** Allowed clock skew between the builder's server and ours. */
export const APPROVAL_SKEW_S = 300;

/** What a token can approve. Each one names exactly one thing, so it can't be replayed elsewhere. */
export type ApprovalTarget =
  | { kind: "outcome"; decision: string; outcome: "approved" | "edited" }
  | { kind: "promotion"; agent: string; subject: string; action: string; resource?: string };

export type ApprovalClaims = ApprovalTarget & {
  /** The human who approved, as the builder knows them (an opaque id, never an email). */
  approver: string;
  /** Issued at, unix seconds. */
  iat: number;
  /** Expires at, unix seconds. */
  exp: number;
};

export type ApprovalError =
  | "malformed"
  | "bad_signature"
  | "expired"
  | "not_yet_valid"
  | "ttl_too_long"
  | "wrong_target"
  | "wrong_approver";

export type VerifyResult = { ok: true; claims: ApprovalClaims } | { ok: false; error: ApprovalError };

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c: string) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Mint an approval token. Call this on your server, after your own auth has identified the user.
 * Never ship the secret to a browser, a mobile app or the agent.
 */
export async function signApproval(
  secret: string,
  target: ApprovalTarget,
  approver: string,
  opts: { now?: number; ttlSeconds?: number } = {},
): Promise<string> {
  const iat = Math.floor((opts.now ?? Date.now()) / 1000);
  const ttl = Math.min(opts.ttlSeconds ?? 600, MAX_APPROVAL_TTL_S);
  const claims: ApprovalClaims = { ...target, approver, iat, exp: iat + ttl };
  const payload = b64url(enc.encode(JSON.stringify(claims)));
  const sig = await hmac(secret, `${APPROVAL_TOKEN_PREFIX}.${payload}`);
  return `${APPROVAL_TOKEN_PREFIX}.${payload}.${b64url(sig)}`;
}

function sameTarget(c: ApprovalClaims, t: ApprovalTarget): boolean {
  if (c.kind !== t.kind) return false;
  if (t.kind === "outcome") return c.kind === "outcome" && c.decision === t.decision && c.outcome === t.outcome;
  return (
    c.kind === "promotion" &&
    c.agent === t.agent &&
    c.subject === t.subject &&
    c.action === t.action &&
    (c.resource ?? undefined) === (t.resource ?? undefined)
  );
}

/**
 * Check a token against the thing being approved. Tries each secret in turn, so a rotated-out
 * secret can keep working for a grace period. Never throws.
 */
export async function verifyApproval(
  token: string,
  secrets: readonly string[],
  expected: ApprovalTarget & { approver?: string },
  now: number = Date.now(),
): Promise<VerifyResult> {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3 || parts[0] !== APPROVAL_TOKEN_PREFIX) return { ok: false, error: "malformed" };
  const [, payload, sigPart] = parts as [string, string, string];
  const sig = fromB64url(sigPart);
  const raw = fromB64url(payload);
  if (!sig || !raw) return { ok: false, error: "malformed" };

  let signed = false;
  for (const secret of secrets) {
    if (secret && equal(await hmac(secret, `${APPROVAL_TOKEN_PREFIX}.${payload}`), sig)) {
      signed = true;
      break;
    }
  }
  if (!signed) return { ok: false, error: "bad_signature" };

  let claims: ApprovalClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(raw)) as ApprovalClaims;
  } catch {
    return { ok: false, error: "malformed" };
  }
  if (
    !claims ||
    typeof claims.approver !== "string" ||
    !claims.approver ||
    typeof claims.iat !== "number" ||
    typeof claims.exp !== "number"
  ) {
    return { ok: false, error: "malformed" };
  }

  const t = Math.floor(now / 1000);
  if (claims.iat > t + APPROVAL_SKEW_S) return { ok: false, error: "not_yet_valid" };
  if (claims.exp < t - APPROVAL_SKEW_S) return { ok: false, error: "expired" };
  if (claims.exp - claims.iat > MAX_APPROVAL_TTL_S) return { ok: false, error: "ttl_too_long" };
  if (!sameTarget(claims, expected)) return { ok: false, error: "wrong_target" };
  if (expected.approver !== undefined && expected.approver !== claims.approver) return { ok: false, error: "wrong_approver" };
  return { ok: true, claims };
}

/** A fresh signing secret, `thr_sign_` plus 32 random bytes. */
export function newSigningSecret(): string {
  return `thr_sign_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}
