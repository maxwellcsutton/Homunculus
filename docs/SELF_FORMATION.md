# Forming memories, opinions, and self-image

The point of this project: the agent should become someone through playing and talking, not reset each
session. Four self-managed stores accumulate from experience. All start EMPTY; nothing in the code writes
to them — only the agent's own tools do (the agency invariant).

| store      | what it is                                   | tools                                              | where it surfaces |
|------------|----------------------------------------------|----------------------------------------------------|-------------------|
| memory     | anything worth keeping (facts, lessons)      | `remember`, `forget`, `recall`                     | baked base + diff |
| self-image | standing sense of who it is / is becoming    | `revise_self_image`                                | tail (`selfTail`) |
| opinions   | discrete views on strategies/game/user/self  | `form_opinion`, `revise_opinion`, `drop_opinion`   | tail              |
| priorities | attention weighting + felt state             | `reweigh_focus`, `tend_self`                       | tail + heartbeat  |

## The formation loop (made explicit)

The pattern is simple to state: log each decision + its outcome, feed them back, and let the model "reflect
on what happened last time → change its approach." Many game agents do this implicitly; here it's first-class:

```
something happens in the game
   → the game pushes it: POST /api/experience  ("you lost to the troll's fire breath")
   → the agent perceives it on the next heartbeat delta
   → on a game/reflect pass it decides what it means:
        form_opinion(subject="the troll", stance="its fire breath punishes melee — bait it then close",
                     confidence=0.6, basis="lost twice opening with melee")
        remember(...)              # the durable fact
        revise_self_image(...)     # if the experience shifted who it thinks it is
```

Opinions carry a `confidence` (its own 0–1 sense) and a `basis` (the experience). `revise_opinion` lets a
view deepen or flip as evidence accumulates; `drop_opinion` retires one it no longer holds (kept in
history). The reflect pass (`src/loop/heartbeat.ts` `runReflect`) surfaces self-image + opinions so the
agent can tend them deliberately.

## Why these are state, not code
A naive build would compute an opinion ("lost 3× → mark strategy bad") or map a mood to an action. That
hard-codes the judgment that is the entire point. Here the code only SURFACES experiences and the agent's
own stores back to it; the agent supplies every interpretation. If you find yourself writing a rule that
forms or acts on an opinion/self-image/mood for the agent, stop — that's the invariant violation
(`CLAUDE.md`). Record any deliberate exception in `DECISIONS.md`.
