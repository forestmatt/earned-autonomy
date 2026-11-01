import type { Entity } from "./types.js";

export type Operator =
  | "eq"
  | "neq"
  | "in"
  | "notIn"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "exists"
  | "missing"
  | "startsWith"
  | "endsWith"
  | "contains"
  | "segment"
  | "notSegment";

/**
 * A targeting condition on one context kind. `attr: "key"` targets the
 * entity key. For `segment`, `values` holds segment keys.
 */
export interface Condition {
  kind: string;
  attr: string;
  op: Operator;
  values?: unknown[];
}

export interface Segment {
  key: string;
  /** Explicit members, as `kind:key`, for example `subject:user_1`. */
  included?: string[];
  excluded?: string[];
  /** All conditions must match. */
  rules?: Condition[];
}

/** The evaluation context, keyed by kind. */
export type EvalContext = Record<string, Entity | undefined>;

export interface MatchEnv {
  segments?: Record<string, Segment>;
}

function first(values: unknown[] | undefined): unknown {
  return values?.[0];
}

function readAttr(entity: Entity | undefined, attr: string): unknown {
  if (!entity) return undefined;
  if (attr === "key") return entity.key;
  let value: unknown = entity;
  for (const part of attr.split(".")) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function compare(a: unknown, b: unknown): number | null {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

export function segmentMatches(
  segment: Segment,
  ctx: EvalContext,
  env: MatchEnv,
  depth = 0,
): boolean {
  const ids = Object.entries(ctx)
    .filter(([, e]) => e)
    .map(([kind, e]) => `${kind}:${e!.key}`);
  if (segment.excluded?.some((id) => ids.includes(id))) return false;
  if (segment.included?.some((id) => ids.includes(id))) return true;
  if (!segment.rules || segment.rules.length === 0) return false;
  return segment.rules.every((c) => conditionMatches(c, ctx, env, depth + 1));
}

export function conditionMatches(
  condition: Condition,
  ctx: EvalContext,
  env: MatchEnv = {},
  depth = 0,
): boolean {
  if (condition.op === "segment" || condition.op === "notSegment") {
    if (depth > 8) return false;
    const hit = (condition.values ?? []).some((key) => {
      const seg = env.segments?.[String(key)];
      return seg ? segmentMatches(seg, ctx, env, depth) : false;
    });
    return condition.op === "segment" ? hit : !hit;
  }

  const value = readAttr(ctx[condition.kind], condition.attr);
  const values = condition.values ?? [];
  const list = Array.isArray(value) ? value : [value];

  switch (condition.op) {
    case "exists":
      return value !== undefined && value !== null;
    case "missing":
      return value === undefined || value === null;
    case "eq":
      return list.some((v) => v === first(values));
    case "neq":
      return !list.some((v) => v === first(values));
    case "in":
      return list.some((v) => values.includes(v));
    case "notIn":
      return !list.some((v) => values.includes(v));
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const c = compare(value, first(values));
      if (c === null) return false;
      if (condition.op === "gt") return c > 0;
      if (condition.op === "gte") return c >= 0;
      if (condition.op === "lt") return c < 0;
      return c <= 0;
    }
    case "startsWith":
      return typeof value === "string" && values.some((v) => typeof v === "string" && value.startsWith(v));
    case "endsWith":
      return typeof value === "string" && values.some((v) => typeof v === "string" && value.endsWith(v));
    case "contains":
      return typeof value === "string" && values.some((v) => typeof v === "string" && value.includes(v));
    default:
      return false;
  }
}

export function allMatch(conditions: Condition[] | undefined, ctx: EvalContext, env: MatchEnv = {}): boolean {
  return (conditions ?? []).every((c) => conditionMatches(c, ctx, env));
}

/**
 * Action pattern match. `email.send` matches itself, `email.*` matches
 * `email.send` and `email.send.bulk`, and `*` matches everything.
 */
export function actionMatches(pattern: string, action: string): boolean {
  if (pattern === "*" || pattern === action) return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return action === prefix || action.startsWith(`${prefix}.`);
  }
  return false;
}

export function anyActionMatches(patterns: string[] | undefined, action: string): boolean {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((p) => actionMatches(p, action));
}
