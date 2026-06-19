# Engineering lessons (pitfalls to avoid)

The hard-won, reusable engineering lessons behind this boilerplate, with where each one lives in the code.
These are the traps that cost real time to discover — treat them as load-bearing, not optional polish.

## Prompt / caching
- **Warm-base KV caching** is the performance model: a frozen byte-stable base + a volatile tail. Never
  re-render the base; never bake volatile state. → `docs/WARM_BASE_CACHING.md`, `docs/PROMPT_LAYERING.md`.
- **Absolute timestamps** in history/tail (a relative stamp rewrites old lines and kills cache reuse).
- **Tools render at the front** of the prompt → a changed tool set is a cold re-prefill. Freeze the game
  catalog; keep mode tool lists stable.

## Serving (`scripts/serveModel.ts`, `docs/MODEL_SERVING.md`)
- `-np 1` single slot; lane isolation via separate llama-server PROCESSES, not id_slot (pinning breaks
  prefix caching).
- Bound reasoning server-side below `max_tokens` or you get EMPTY answers.
- DRY sampler for verbatim loops; temperature-before-penalties sampler order for Qwen "endless generation".

## The loop / behavior
- **One control-flow primitive** (call → tools → repeat → final). Tool failures are strings, never throws,
  so the model adapts mid-loop.
- **Overwrite-tool guards**: cap "last-write-wins" tools per turn so a loop can't burn the step budget.
- **Text-tool recovery** (`recoverTypedToolCalls`): looser sampling improves voice but degrades tool
  FORMAT, so parse leaked text-form calls and route them to the real handlers, then strip the text. Keep it
  a SCOPED whitelist, never a general inline executor.
- **One message per turn**; tool-use + `<think>` stay private; a re-say guard (lexical + optional embed)
  nudges off restating. Persist the agent's turn BEFORE delivering (ordering/race fix).

## Concurrency
- A **priority queue + Postgres advisory lock** per lane: forced (a person/game waiting) preempts idle;
  cooperative yield at tool boundaries so an unbounded reflect never starves responsiveness.

## Architecture stance
- **The heartbeat is the agent's clock**, not a code scheduler of its behavior: it surfaces what's new +
  the agent's own focus and lets it choose engage/pass. Cadence is plumbing; the choice is the agent's.
- **Local-only, no hosted API.** Free but slowish inference; don't burn passes casually, but the old "every
  call costs money" rule is gone.
- **The identity store is the irreplaceable part** — back it up, rehearse migrations on a clone.

## The non-negotiable
- **The agency invariant** (`CLAUDE.md` Principle 0). The whole thesis: the agent's behavior is its own
  mutable state, not constants the code picks. It extends all the way to self-image + opinions.
