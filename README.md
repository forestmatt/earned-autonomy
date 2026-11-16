# earned-autonomy

An open decision engine for AI agents. It decides whether an agent may act for a user, should ask first, or must not, and it says why.

```
npm i earned-autonomy
```

Agents should earn the right to act, one user and one action at a time, and drop back to asking when something is new, big or strange. They should also stay inside the limits your product sets, such as feature rollouts, experiments and paid plans. This engine does all of that in one pure function.

- **Six levels of autonomy**, from L0 Suggest to L5 Autonomous, earned per agent, per user and per action. See [SPEC.md](SPEC.md).
- **One decision with a reason.** `decide()` returns `allow`, `ask` or `deny`, the level, a safe message for the user, and an ordered reason chain naming the gate that decided.
- **Flags, rollouts, experiments, holdouts and plan entitlements** are inputs to the same decision, including lapsed subscribers.
- **Learned trust.** Approvals earn promotion (offered, never silent), and undos and rejections demote. Tripwires drop one action back to Ask without losing the level.
- **Signed approvals**, so an agent can never claim a human said yes.
- **Pure TypeScript.** No I/O, no dependencies, deterministic. It never throws and never defaults to allow.

```ts
import { decide, recordOutcome, DEFAULT_PACK } from "earned-autonomy";

const d = decide(
  { agent: "inbox", subject: "sam", action: "email.send", context: { to: "new@client.com" } },
  config,                      // your actions, flags, experiments, plans and a rule pack
  { trust, subscription },     // Sam's earned trust and plan, from your storage
  { now: Date.now() },
);

d.decision; // "ask"
d.binding;  // "tripwire:novelty"
d.message;  // "This one's to a new recipient, so I'm checking first."
```

You store trust state and decisions yourself. If you'd rather not, [Throtl](https://throtl.ai) is the hosted version, with storage, an API, MCP server, dashboard, audit log and signed approvals built in.

## Licence

Apache-2.0. Copyright 2026 Matt Alcock.
