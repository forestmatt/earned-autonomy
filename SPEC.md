# Earned Autonomy: agent autonomy levels (draft v0.2)

This is a draft. The reference implementation is this package (`earned-autonomy` on npm). Comments and issues are welcome.

The spec has two layers, after SAE. SAE defines the driving levels, and each manufacturer decides where its car may use them.

- **Layer 1, the standard.** Small, fixed and the same everywhere, so "L3" means the same thing in every app. This is what we publish as the open spec (working name OAAL, CC BY 4.0).
- **Layer 2, rules.** Typed, configured per app, and shipped as rule packs. The standard defines the rule interface, and each app supplies its context and thresholds.

---

# Layer 1. The standard

## The six levels

One question separates them. **When does the human find out?**

| Level | Name | The human finds out | The agent says |
|---|---|---|---|
| L0 | Suggest | Before, and does it themselves | "Here's what I'd do." |
| L1 | Ask | Before, and approves each one | "Can I do this?" |
| L2 | Heads up | Before, with time to stop it | "Doing this in 10 minutes unless you stop me." |
| L3 | Act and tell | Straight after, with undo | "Done. Undo?" |
| L4 | Act and summarise | Later, in a summary | "This week I did 14 of these." |
| L5 | Autonomous | Only on audit or exception, and can always stop it | (silent) |

Denied is not a level. If a flag is off, a plan doesn't include the action, or policy forbids it, the gate is closed before autonomy is considered.

A decision has three answers, `allow`, `ask` and `deny`. L0 and L1 map to ask, L2 to allow with a delay, and L3 and above to allow.

## The invariants

1. **The six levels** and what the human sees at each, as above.
2. **A level is scoped, never global.** It belongs to an agent, a subject (the user or account it acts for) and an action class (for example `email.send`), optionally narrowed to one resource. An agent can be L4 for filing receipts and L1 for paying invoices for the same person on the same day.
3. **The decision order is fixed.** Deny wins. Rules can only lower the outcome, never raise it. `effective = min(earned, ceiling, rollout, experiment)`.
4. **Promotion is offered and accepted**, one supported level at a time, and never silent. The human's yes is the promotion, and it is logged.
5. **Safety is a floor.** No approval history offsets a recent undo. One undo or rejection at L3 or above drops the level by one and resets the evidence.
6. **The approver is bound.** Only the subject, or a delegate the subject named, can answer an ask or accept a promotion. An agent can never approve its own request, including via another agent.
7. **L5 can always be stopped.**
8. **The outcome vocabulary** is `approved`, `edited`, `rejected`, `undone`, `ignored` and `expired`. Silence (`ignored`) counts as consent only at L2, where the heads-up window defines it. `expired` never counts.
9. **Every decision carries a reason chain** naming the binding rule.
10. **Unsupported levels round down.** Each action class declares the levels it supports (layer 2). If the decision lands on a level the action doesn't support, it drops to the next supported level below, never above.

## The decision order

| Step | If it fails | Binding reason |
|---|---|---|
| 1. Health (config present, context valid) | Ask for actions, with `fallback: true` | `error:*` |
| 2. Policy forbid and kill switch | deny | `policy:<id>` |
| 3. Entitlement (plan includes the action, or the lapsed policy applies) | deny, or ask to upgrade | `entitlement:<feature>` |
| 4. Forced ask (class marked always ask, tool requires interaction) | ask | `forced:<reason>` |
| 5. Gate and rollout | deny or level cap | `rollout:<gate>` |
| 6. Holdout and experiment arm | level cap | `experiment:<exp>/<arm>` |
| 7. `effective = min(earned, ceiling, rollout, experiment)` | | the lowest is named |
| 8. Rules (tripwires and re-check counters) | ask or cap, for this call only | `tripwire:<kind>` |
| 9. Snap to the action's supported levels, rounding down | | the gate that set the level stays named, and the chain notes `levels:<action>` |
| 10. Level to outcome | | `mode:<name>` |

On a tie at step 7 the builder-set limit is named before the earned level (ceiling, then rollout, then experiment, then earned), because it explains more.

Evaluation never throws and never defaults to allow. Every outage degrades to ask.

## The four inputs

- **earned** is what the track record supports. A new scope starts at L1.
- **ceiling** is the most the builder allows. The lowest of the action class ceiling (or the default for its risk class), the subject's plan, and any cap the human set by hand ("always ask me about this").
- **rollout** is what the gate allows for this cohort right now.
- **experiment** is what the assigned arm or holdout allows.

This one line is why one service has to own flags, subscriptions, experiments and autonomy together.

## The rule interface

A rule reads the decision context (the action, its attributes, its risk class, the subject's trust scope) and returns nothing, **ask** (for this call only) or **cap** at a lower level. A rule can never raise a level, change the earned level, or turn a deny into anything else. The earned level stays where it was after a tripwire, so "this one's to a new payee, so I'm checking first" costs the agent nothing.

## Bucketing

Rollouts, experiments and holdouts use the same published hash so every SDK agrees.

```
h1 = fnv1a32(utf8(salt + ":" + key))
h2 = fnv1a32(utf8(lowercase_hex(h1)))
bucket = h2 mod 10000
```

Experiment traffic uses the salt `<salt>:traffic` so ramping traffic never reshuffles arms. Test vectors are in `packages/core/test/hash.test.ts`.

---

# Layer 2. Rules

Each app maps its own context onto the levels. These are the rule types, the defaults in the Default pack, and the other packs.

## Rule types

| Rule | Effect | What it looks at |
|---|---|---|
| Novelty | ask | A value never seen while earning (recipient, payee, repo, path, command). User-marked trusted resources skip it |
| Magnitude | ask | An amount above a fixed limit, or above the range seen while earning |
| Irreversible | cap | An action that can't be undone, above a set level (Default caps at L2) |
| Drift | ask | The model, prompt or tool schema changed since the level was earned |
| Confidence | ask | The agent reports low confidence |
| Untrusted input | ask | The action was shaped by content the agent can't vouch for (a web page, an inbound email, tool output) |
| Re-check | ask | PSD2 style. After N allowed actions without a human check |
| Dormancy | ask | A long gap since the last action in this scope |

Rules not yet built as types: grant durations (once, session, until, standing), attention weighting beyond rushed approvals, and the MCP annotation mapping.

## Promotion

The agent becomes eligible for the next level when the evidence clears a bar for that action class.

- Enough approvals at the current level. An approval given in under 2 seconds counts half.
- Approved unchanged often enough. An edit counts as half a rejection.
- No rejection or undo in the most recent outcomes.
- Enough time at the current level, so a single burst can't earn trust.

Being eligible doesn't change the level. The agent offers, in its own words: "You've approved the last 12 of these. Want me to just do them and tell you after?" Approval fatigue is the trigger, so when the evidence is there the agent must offer rather than keep asking.

Defaults by risk class, in the Default pack. These are only defaults. Every application can override them per risk class and per action class.

| Risk class | Approvals | Unchanged rate | Minimum time at level |
|---|---|---|---|
| Reversible, self only | 5 | 90% | 1 hour |
| Reversible, others see it | 10 | 90% | 24 hours |
| Hard to reverse | 20 | 95% | 3 days |
| Irreversible or money | 30 | 98% | 7 days |
| Regulated | Manual only | n/a | n/a |

## Demotion and decay

- One undo or rejection at L3 or above drops the level by one for that scope (layer 1 invariant 5).
- Two tripwire asks that the human rejects drop the level by one.
- Trust decays. After 30 days without activity the level drops by one per period, never below L1.
- The human can always cap a scope by hand.

## Supported levels per action class

Not every level makes sense for every action. A 10-minute heads up suits a payment or an expense run, where a window to cancel is natural. It doesn't suit an email, which people either want to approve or want sent with an undo. So each action class lists the levels it supports, and the decision snaps down to the nearest one (layer 1 invariant 10).

```ts
"email.send":     { risk: "hard_to_reverse", levels: [0, 1, 3, 4] }  // ask, or send and tell
"expense.submit": { risk: "irreversible",    levels: [0, 1, 2] }     // ask, or heads up
```

Defaults by risk class, which builders can override per action:

| Risk class | Supported levels | Why |
|---|---|---|
| Reversible, self only | L0 to L5 | Anything goes |
| Reversible, others see it | L0 to L5 | Heads up works for meetings and posts |
| Hard to reverse | L0, L1, L3, L4 | Ask, or act with an undo window. A delay adds nothing |
| Irreversible or money | L0, L1, L2 | Heads up is a scheduled action you can cancel |
| Regulated | L0, L1 | Always a human |

Promotion goes to the next supported level, so `email.send` moves from Ask straight to Act and tell.

**Config check.** When a plan ceiling, rollout cap or experiment arm lands on a level an action doesn't support, Throttle warns the builder when they save the config. For example, "Free caps email.send at L2, which email.send doesn't use, so Free users will stay at L1. Did you mean L3?"

## Default ceilings by risk class

| Risk class | Example | Default ceiling |
|---|---|---|
| Reversible, self only | Draft a doc, tag an email | L5 |
| Reversible, others see it | Send a Slack message, accept a meeting | L4 |
| Hard to reverse | Send an email, post publicly, merge a PR | L3 |
| Irreversible or money | Pay, delete, sign, trade | L2 |
| Regulated | Advice, credit, health decisions | L1 |

A plan can lower these per risk class, for example a free plan capped at L1 for anything others can see.

## Lapsed subscribers

"Used to pay" is a declared state, not a silent loss. The policy sets an outcome per risk class (deny, ask, or cap at a level) for features the lapsed plan included. The Default pack asks for reversible self-only work and denies the rest. Earned trust is frozen, not lost, and comes back on resubscription.

## Rule packs

| Pack | What it adds to the Default rules |
|---|---|
| Default | Irreversible capped at L2, drift, confidence below 0.7, untrusted input, dormancy after 14 days |
| Fintech | New payee asks, amounts above the usual range ask, a re-check every 5 payments |
| Coding agent | New repo, path or command asks |
| Comms | New recipient or channel asks, bulk sends above the usual size ask |

## Everything is an event

Every decision, offer, promotion, demotion, tripwire, approval, edit, rejection and undo is logged with the full reason chain. This is where the analytics come from (approval rate by level, time saved, undo rate by model version, revenue from L3 and above, and how experiments shift autonomy).

---

## The API shape

```ts
const d = await throttle.can({
  agent: "inbox-agent",
  subject: "user_123",
  action: "email.send",
  context: { to: "new@client.com", model: "claude-sonnet-5-5" },
});

d.decision   // "allow" | "ask" | "deny"
d.level      // 1  (for this call)
d.mode       // "ask"
d.binding    // "tripwire:novelty"
d.levels     // { earned: 3, ceiling: 3, rollout: 5, experiment: 5 }
d.message    // "This one involves a new recipient, so I'm checking first."
d.next       // "approve" | "upgrade" | "request_promotion" | "wait" | "none"

await throttle.record(d.id, "approved");   // or edited, rejected, undone, ignored, expired
```

Agents can call the same thing over MCP, including `request_promotion`, so they can ask for autonomy themselves.
