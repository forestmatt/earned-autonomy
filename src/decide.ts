import { allMatch, anyActionMatches, actionMatches, type EvalContext } from "./conditions.js";
import { isReversible, resolveActionClass, supportedLevels, type ActionClass, type Config } from "./config.js";
import { checkEntitlement, type Subscription } from "./entitlements.js";
import { evaluateExperiments } from "./experiments.js";
import { describeFlagReason, evaluateFlag } from "./flags.js";
import { hashOf } from "./hash.js";
import { DEFAULT_CEILINGS, MODES, effectiveLevel, isLevel, verdictFor, snapDown } from "./levels.js";
import { promotionStatus, promotionThresholds } from "./promotion.js";
import { evaluateRule, type RuleEffect } from "./rules.js";
import type { TrustScope } from "./trust.js";
import type { ChainStep, DecideInput, Decision, Entity, Exposure, Level, Levels, NextStep } from "./types.js";

/** Dynamic state for this call. Trust is the one input that changes per subject. */
export interface DecideState {
  subscription?: Subscription;
  trust?: TrustScope;
  /** Whether the project requires signed approvals. Unsigned projects aren't offered promotion past Ask for money and irreversible actions. */
  signed?: boolean;
}

export interface DecideOptions {
  /** Current time in ms. Injected so the engine stays pure. */
  now: number;
  /** Decision id. Defaults to a hash of the inputs and time. */
  id?: string;
}

const DEFAULT_DELAY_SECONDS = 600;

function entity(value: string | Entity | undefined): Entity | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? { key: value } : value;
}

function validKey(e: Entity | undefined): e is Entity {
  return !!e && typeof e.key === "string" && e.key.length > 0;
}

const MESSAGES: Record<Level, (delay: number) => string> = {
  0: () => "Here's what I'd do. Over to you.",
  1: () => "Can I do this?",
  2: (d) => `Doing this in ${Math.max(1, Math.round(d / 60))} minutes unless you stop me.`,
  3: () => "Done. You can undo it.",
  4: () => "Done. It'll be in your summary.",
  5: () => "Done.",
};

interface Base {
  id: string;
  agent: string;
  subject: string;
  action: string;
  resource?: string;
  inputsHash: string;
  configVersion: string;
}

function finish(
  base: Base,
  parts: {
    decision: Decision["decision"];
    level: Level;
    binding: string;
    levels: Levels;
    message: string;
    chain: ChainStep[];
    next: NextStep;
    fallback?: boolean;
    exposures?: Exposure[];
    delaySeconds?: number;
  },
): Decision {
  const d: Decision = {
    id: base.id,
    decision: parts.decision,
    level: parts.level,
    mode: MODES[parts.level],
    binding: parts.binding,
    levels: parts.levels,
    message: parts.message,
    chain: parts.chain,
    next: parts.next,
    fallback: parts.fallback ?? false,
    exposures: parts.exposures ?? [],
    configVersion: base.configVersion,
    inputsHash: base.inputsHash,
    action: base.action,
    agent: base.agent,
    subject: base.subject,
  };
  if (base.resource !== undefined) d.resource = base.resource;
  if (parts.delaySeconds !== undefined) d.delaySeconds = parts.delaySeconds;
  return d;
}

const SAFE_LEVELS: Levels = { earned: 1, ceiling: 1, rollout: 1, experiment: 1 };

/**
 * The safe default. Never throw, never default to allow. Actions degrade to
 * ask with `fallback: true`.
 */
export function fallbackDecision(base: Base, reason: string, detail?: string): Decision {
  return finish(base, {
    decision: "ask",
    level: 1,
    binding: `error:${reason}`,
    levels: SAFE_LEVELS,
    message: "I can't check my permissions right now, so I'm asking first.",
    chain: [{ step: "health", result: "ask", id: `error:${reason}`, ...(detail ? { detail } : {}) }],
    next: "approve",
    fallback: true,
  });
}

/**
 * `can(agent, action, subject, context)`. The decision order from
 * docs/research/gold-standard.md as a pure function. Steps 2 to 8 can only
 * lower the outcome, never raise it.
 */
export function decide(input: DecideInput, config: Config, state: DecideState = {}, opts: DecideOptions): Decision {
  const agent = entity(input?.agent);
  const subject = entity(input?.subject);
  const resource = entity(input?.resource);
  const action = typeof input?.action === "string" ? input.action : "";
  const inputsHash = hashOf({ input: input ?? null, config: config?.version ?? null });
  const base: Base = {
    id: opts.id ?? `dec_${hashOf({ inputsHash, now: opts.now })}${hashOf(opts.now)}`,
    agent: agent?.key ?? "",
    subject: subject?.key ?? "",
    action,
    inputsHash,
    configVersion: config?.version ?? "none",
  };
  if (resource?.key) base.resource = resource.key;

  try {
    return run(input, config, state, opts, base, { agent, subject, resource });
  } catch (err) {
    return fallbackDecision(base, "internal", err instanceof Error ? err.message : String(err));
  }
}

function run(
  input: DecideInput,
  config: Config,
  state: DecideState,
  opts: DecideOptions,
  base: Base,
  ents: { agent?: Entity; subject?: Entity; resource?: Entity },
): Decision {
  // 1. Health.
  if (!config || typeof config !== "object" || !config.actions) return fallbackDecision(base, "no_config");
  if (!validKey(ents.agent)) return fallbackDecision(base, "invalid_context", "agent key missing");
  if (!validKey(ents.subject)) return fallbackDecision(base, "invalid_context", "subject key missing");
  if (!base.action) return fallbackDecision(base, "invalid_context", "action missing");
  const ac: ActionClass | undefined = resolveActionClass(config, base.action);
  if (!ac) return fallbackDecision(base, "unknown_action", base.action);
  if (state.trust && !isLevel(state.trust.earned)) return fallbackDecision(base, "invalid_trust");

  const chain: ChainStep[] = [{ step: "health", result: "pass", id: "health:ok", detail: `action class ${ac.key}` }];
  const attrs = input.context ?? {};
  const ctx: EvalContext = {
    ...input.kinds,
    agent: ents.agent,
    subject: ents.subject,
    action: { key: base.action, class: ac.key, risk: ac.risk },
    resource: ents.resource,
    context: { key: "context", ...attrs },
  };
  const env = { segments: config.segments, flags: config.flags };
  const now = opts.now;
  const earned: Level = state.trust?.earned ?? 1;
  let ceiling: Level = ac.ceiling ?? DEFAULT_CEILINGS[ac.risk];
  let ceilingId = ac.ceiling !== undefined ? `ceiling:action/${ac.key}` : `ceiling:risk/${ac.risk}`;
  let rollout: Level = 5;
  let rolloutId = "rollout:none";
  let experiment: Level = 5;
  let experimentId = "experiment:none";
  let forced: { id: string; message: string; next: NextStep } | null = null;
  const levelsNow = (): Levels => ({ earned, ceiling, rollout, experiment });
  const deny = (id: string, message: string, next: NextStep = "none"): Decision =>
    finish(base, { decision: "deny", level: 0, binding: id, levels: levelsNow(), message, chain, next });

  // 2. Policy forbid and kill switch.
  const killed = (config.killed ?? []).find((p) => actionMatches(p, base.action));
  if (killed) {
    chain.push({ step: "policy", result: "deny", id: "policy:kill_switch", detail: killed });
    return deny("policy:kill_switch", "That's switched off right now.");
  }
  for (const p of config.policies ?? []) {
    if (p.effect !== "forbid" || !anyActionMatches(p.actions, base.action) || !allMatch(p.when, ctx, env)) continue;
    const id = `policy:${p.id}`;
    chain.push({ step: "policy", result: "deny", id });
    return deny(id, p.message ?? "I'm not allowed to do that.");
  }
  chain.push({ step: "policy", result: "pass", id: "policy:none" });

  // 3. Entitlement.
  const ent = checkEntitlement({
    feature: ac.feature,
    risk: ac.risk,
    subscription: state.subscription,
    plans: config.plans ?? {},
    lapsedPolicy: config.lapsedPolicy,
    actionLapsed: ac.lapsed,
    now,
  });
  if (ent.result === "deny") {
    chain.push({ step: "entitlement", result: "deny", id: ent.id, detail: ent.detail });
    const msg = ent.state === "lapsed" ? "That stopped when the subscription ended." : "That needs a plan that includes it.";
    return deny(ent.id, msg, ent.upgrade ? "upgrade" : "none");
  }
  if (ent.ceiling < ceiling) {
    ceiling = ent.ceiling;
    ceilingId = ent.state === "lapsed" ? ent.id : `ceiling:plan/${state.subscription?.plan ?? "none"}`;
  }
  if (ent.result === "ask") {
    forced = { id: ent.id, message: "Your subscription has ended, so I'll check with you first.", next: "upgrade" };
  }
  chain.push({
    step: "entitlement",
    result: ent.result === "pass" ? "pass" : ent.result,
    id: ent.id,
    detail: ent.detail,
    level: ent.ceiling,
  });

  // 4. Forced ask.
  if (ac.alwaysAsk) {
    const reason = typeof ac.alwaysAsk === "string" ? ac.alwaysAsk : "always_ask";
    const id = `forced:${reason}`;
    chain.push({ step: "forced", result: "ask", id });
    forced ??= { id, message: "I always check with you before doing this.", next: "approve" };
  }

  const userCap = state.trust?.userCap;
  if (userCap !== undefined && userCap < ceiling) {
    ceiling = userCap;
    ceilingId = "ceiling:user";
  }

  // 5. Gate and rollout.
  if (ac.gate) {
    const flag = config.flags?.[ac.gate];
    const id = `rollout:${ac.gate}`;
    if (!flag) {
      rollout = 1;
      rolloutId = "error:gate_not_found";
      chain.push({ step: "rollout", result: "cap", id: rolloutId, level: 1, detail: ac.gate });
    } else {
      const r = evaluateFlag(flag, ctx, env);
      const detail = describeFlagReason(r.reason);
      if (r.reason.kind === "ERROR" || r.value === undefined) {
        rollout = 1;
        rolloutId = `error:gate/${ac.gate}`;
        chain.push({ step: "rollout", result: "cap", id: rolloutId, level: 1, detail });
      } else if (r.value === false) {
        chain.push({ step: "rollout", result: "deny", id, detail });
        return deny(id, "That isn't available yet.");
      } else if (isLevel(r.value)) {
        rollout = r.value;
        rolloutId = id;
        chain.push({ step: "rollout", result: r.value < 5 ? "cap" : "pass", id, level: r.value, detail });
      } else {
        // Any other truthy value opens the gate without capping.
        chain.push({ step: "rollout", result: "pass", id, detail });
      }
    }
  } else {
    chain.push({ step: "rollout", result: "skip", id: "rollout:none" });
  }

  // 6. Holdout and experiment arm.
  const exp = evaluateExperiments(config, ctx, base.action);
  experiment = exp.cap;
  if (exp.binding) experimentId = exp.binding;
  chain.push({
    step: "experiment",
    result: exp.cap < 5 ? "cap" : exp.exposures.length ? "pass" : "skip",
    id: exp.binding ?? (exp.exposures[0] ? `experiment:${exp.exposures[0].experiment}/${exp.exposures[0].arm}` : "experiment:none"),
    level: exp.cap,
  });

  // 7. Effective level.
  const levels = levelsNow();
  const eff = effectiveLevel(levels);
  const effId = {
    earned: `earned:L${earned}`,
    ceiling: ceilingId,
    rollout: rolloutId,
    experiment: experimentId,
  }[eff.binding];
  chain.push({ step: "effective", result: "pass", id: effId, level: eff.level });
  let level = eff.level;
  let binding = effId;

  // 8. Tripwires and re-check counters. They only lower the level or force an ask, for this call only.
  let tripped: RuleEffect | null = null;
  for (const rule of config.rules ?? []) {
    const hit = evaluateRule(
      rule,
      {
        action: base.action,
        risk: ac.risk,
        reversible: isReversible(ac),
        attrs,
        ctx,
        resource: base.resource,
        trust: state.trust,
        level,
      },
      now,
    );
    if (!hit) continue;
    if (hit.effect === "cap") {
      if (hit.level < level) {
        level = hit.level;
        binding = hit.id;
        tripped ??= hit;
      }
      chain.push({ step: "tripwire", result: "cap", id: hit.id, level: hit.level });
    } else {
      chain.push({ step: "tripwire", result: "ask", id: hit.id });
      if (!tripped || tripped.effect === "cap") tripped = hit;
    }
  }

  // 9. Snap to the levels this action supports, rounding down (layer 1 invariant 10).
  // The gate that set the level stays named. The chain records the snap.
  const supported = supportedLevels(ac);
  const snapped = snapDown(level, supported);
  if (snapped !== level) {
    chain.push({ step: "levels", result: "cap", id: `levels:${ac.key}`, level: snapped, detail: `L${level} isn't used by ${ac.key}` });
    level = snapped;
  }

  // 10. Level to outcome.
  let decision = verdictFor(level);
  let message = MESSAGES[level](ac.delaySeconds ?? DEFAULT_DELAY_SECONDS);
  let next: NextStep = decision === "ask" ? "approve" : level === 2 ? "wait" : "none";

  if (forced) {
    decision = "ask";
    level = Math.min(level, 1) as Level;
    binding = forced.id;
    message = forced.message;
    next = forced.next;
  } else if (tripped?.effect === "ask") {
    decision = "ask";
    level = Math.min(level, 1) as Level;
    binding = tripped.id;
    message = tripped.message;
    next = "approve";
  } else if (tripped?.effect === "cap") {
    decision = verdictFor(level);
    message = level === 2 ? `${tripped.message} ${MESSAGES[2](ac.delaySeconds ?? DEFAULT_DELAY_SECONDS)}` : tripped.message;
    next = decision === "ask" ? "approve" : level === 2 ? "wait" : "none";
  } else if (decision === "ask" && state.trust && eff.binding === "earned") {
    // Approval fatigue is a promotion trigger. If the evidence is there, offer.
    const thresholds = promotionThresholds(ac.risk, { risk: config.promotion?.[ac.risk], action: ac.promotion });
    const promo = promotionStatus(state.trust, thresholds, Math.min(ceiling, rollout, experiment) as Level, now, supported, state.signed);
    if (promo.eligible && promo.message) {
      next = "request_promotion";
      message = `${message} ${promo.message}`;
    }
  }
  chain.push({ step: "mode", result: "pass", id: `mode:${MODES[level]}`, level });

  return finish(base, {
    decision,
    level,
    binding,
    levels,
    message,
    chain,
    next,
    exposures: exp.exposures,
    ...(decision === "allow" && level === 2 ? { delaySeconds: ac.delaySeconds ?? DEFAULT_DELAY_SECONDS } : {}),
  });
}
