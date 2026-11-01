# @throtl/core

The Throtl decision engine. Pure TypeScript, no I/O, no dependencies. The API Worker, the SDK (local evaluation) and the MCP server all run this same code.

```ts
import { decide, recordOutcome, DEFAULT_PACK } from "@throtl/core";

const d = decide(
  { agent: "inbox", subject: "user_123", action: "email.send", context: { to: "new@client.com" } },
  config,                      // snapshot from GET /v1/config
  { subscription, trust },     // this subject's plan state and trust scope
  { now: Date.now() },
);
d.decision; // "allow" | "ask" | "deny"
d.binding;  // "tripwire:novelty"
d.chain;    // every step of the decision order
```

| Module | What it does |
|---|---|
| `decide.ts` | The decision order from `docs/research/gold-standard.md`. Never throws, never defaults to allow |
| `hash.ts` | Published bucketing (double FNV-1a 32, 10,000 buckets) with test vectors |
| `flags.ts` | Typed flags with rules, rollouts and prerequisites. A gate is a `Flag<Level \| false>` |
| `experiments.ts` | Arms with `autonomyCap`, layers, global holdouts, exposures |
| `entitlements.ts` | Plans, ceilings per risk class, subscription lifecycle, the lapsed-subscriber policy |
| `rules.ts` | Layer 2 rule types (novelty, magnitude, irreversible, drift, confidence, untrusted input, re-check, dormancy) |
| `promotion.ts` | Outcomes, promotion offers, demotion, decay, manual caps |
| `packs.ts` | Rule packs (Default, Fintech, Coding agent, Comms) |

Run the tests from the repo root with `npm test`.
