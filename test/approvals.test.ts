import { describe, expect, it } from "vitest";
import { MAX_APPROVAL_TTL_S, newSigningSecret, signApproval, verifyApproval, type ApprovalTarget } from "../src/approvals.js";

const NOW = 1_700_000_000_000;
const secret = "thr_sign_test_secret";
const decode = (part: string) => JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
const encode = (obj: unknown) => btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const target: ApprovalTarget = { kind: "outcome", decision: "dec_1", outcome: "approved" };

describe("signed approvals", () => {
  it("round-trips a token for the same target", async () => {
    const token = await signApproval(secret, target, "user_42", { now: NOW });
    expect(token.startsWith("tap1.")).toBe(true);
    const r = await verifyApproval(token, [secret], target, NOW + 1000);
    expect(r).toMatchObject({ ok: true, claims: { approver: "user_42", decision: "dec_1", outcome: "approved" } });
  });

  it("rejects a token signed with another secret", async () => {
    const token = await signApproval("thr_sign_other", target, "user_42", { now: NOW });
    expect(await verifyApproval(token, [secret], target, NOW)).toEqual({ ok: false, error: "bad_signature" });
  });

  it("accepts any of several secrets, for rotation", async () => {
    const token = await signApproval(secret, target, "u", { now: NOW });
    expect((await verifyApproval(token, ["thr_sign_new", secret], target, NOW)).ok).toBe(true);
  });

  it("rejects tampered claims", async () => {
    const token = await signApproval(secret, target, "user_42", { now: NOW });
    const [p, payload, sig] = token.split(".");
    const claims = decode(payload!);
    const forged = encode({ ...claims, decision: "dec_2" });
    expect(await verifyApproval(`${p}.${forged}.${sig}`, [secret], { ...target, decision: "dec_2" }, NOW)).toEqual({
      ok: false,
      error: "bad_signature",
    });
  });

  it("binds the token to one decision and one outcome", async () => {
    const token = await signApproval(secret, target, "u", { now: NOW });
    expect((await verifyApproval(token, [secret], { ...target, decision: "dec_2" }, NOW)).ok).toBe(false);
    expect(await verifyApproval(token, [secret], { ...target, outcome: "edited" }, NOW)).toEqual({ ok: false, error: "wrong_target" });
    const promo: ApprovalTarget = { kind: "promotion", agent: "a", subject: "s", action: "email.send" };
    expect(await verifyApproval(token, [secret], promo, NOW)).toEqual({ ok: false, error: "wrong_target" });
  });

  it("binds promotion tokens to the scope, including the resource", async () => {
    const promo: ApprovalTarget = { kind: "promotion", agent: "a", subject: "s", action: "email.send" };
    const token = await signApproval(secret, promo, "u", { now: NOW });
    expect((await verifyApproval(token, [secret], promo, NOW)).ok).toBe(true);
    expect((await verifyApproval(token, [secret], { ...promo, subject: "s2" }, NOW)).ok).toBe(false);
    expect((await verifyApproval(token, [secret], { ...promo, resource: "acct_1" }, NOW)).ok).toBe(false);
  });

  it("checks the approver when the caller names one", async () => {
    const token = await signApproval(secret, target, "user_42", { now: NOW });
    expect(await verifyApproval(token, [secret], { ...target, approver: "user_7" }, NOW)).toEqual({ ok: false, error: "wrong_approver" });
  });

  it("expires, allowing for clock skew", async () => {
    const token = await signApproval(secret, target, "u", { now: NOW, ttlSeconds: 60 });
    expect((await verifyApproval(token, [secret], target, NOW + 60_000 + 299_000)).ok).toBe(true);
    expect(await verifyApproval(token, [secret], target, NOW + 60_000 + 301_000)).toEqual({ ok: false, error: "expired" });
    expect(await verifyApproval(token, [secret], target, NOW - 301_000)).toEqual({ ok: false, error: "not_yet_valid" });
  });

  it("caps the lifetime at an hour", async () => {
    const token = await signApproval(secret, target, "u", { now: NOW, ttlSeconds: 86_400 });
    const claims = decode(token.split(".")[1]!);
    expect(claims.exp - claims.iat).toBe(MAX_APPROVAL_TTL_S);
  });

  it("never throws on junk", async () => {
    for (const junk of ["", "tap1", "tap1.a.b", "jwt.x.y", "tap1.!!.??", 42 as unknown as string]) {
      const r = await verifyApproval(junk, [secret], target, NOW);
      expect(r.ok).toBe(false);
    }
  });

  it("makes distinct secrets", () => {
    const a = newSigningSecret();
    expect(a).toMatch(/^thr_sign_[A-Za-z0-9_-]{43}$/);
    expect(newSigningSecret()).not.toBe(a);
  });
});
