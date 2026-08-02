---
name: glitch-lens
description: Identify which vendor family (GPT, Gemini, GLM, Qwen, kimi, Deepseek, Minimax, Seed) actually serves an LLM endpoint or the current pi model, using glitch-token fingerprint probes. Use when the user suspects model substitution, wants to audit an API provider, or asks what model they are really talking to.
license: MIT
metadata:
  homepage: https://github.com/Animnia/glitch-lens
---

# Glitch Lens

Glitch Lens probes a model with glitch tokens — strings that one vendor's models consistently fail to copy verbatim while everyone else copies them fine. Two fresh copy failures on the same token confirm a vendor-family candidate.

**Epistemic boundary (always repeat this to the user):** fingerprints identify known vendor-family behavior only. They cannot verify a specific model version, and cannot prove a provider is honest or dishonest.

## Choose a channel

1. **Current pi model** → `glitch_lens_self_scan` (no parameters needed). Uses pi's resolved provider auth; never prints key material. Works for `openai-completions`, `openai-responses`, and `anthropic-messages` providers.
2. **Arbitrary endpoint** → `glitch_lens_scan` with `protocol`, `endpoint`, `model`, `keyEnv` (the *name* of the env var holding the key — never the key itself).
3. **Anything else** (unsupported wire API such as google/bedrock, no key access) → delegated channel below.

## Read a result

- `status: "match"` — one vendor candidate confirmed; report `candidates[0].vendor` as the likely vendor family.
- `status: "conflict"` — several vendor families confirmed; say so plainly, do not pick one.
- `status: "unknown"` — no fingerprint confirmed. This does **not** prove the model is what it claims; the fingerprint set is small.
- Evidence outcomes `request_failed` / `execution_failed` / `model_unverified` mean the probe is inconclusive for that token — never present them as copy failures.

## Delegated channel (fallback)

The agent executes probe prompts against the target model itself; the report is labeled `experimental-context-contaminated` — say this when presenting results.

1. Call `glitch_lens_delegated_start` with `targetModel` (and `targetProvider` if known). Returns `{ state, tasks }`.
2. For each task: send `task.prompt` to the target model **verbatim, as the only user message, in a fresh context with no system prompt additions** (e.g. a sub-agent or `pi -p "<prompt>" --no-skills`). Record the raw reply as `modelOutput`. Set `actualModel`/`actualProvider` from the runtime that produced it (pi: `ctx.model` id/provider) — a result without `actualModel` is discarded as `model_unverified`.
3. Call `glitch_lens_delegated_advance` with the previous `state` and the `results` array. Repeat until `done: true`, then present `report`.
4. Never alter, translate, or "fix" probe prompts or outputs; whitespace differences are handled by the scorer.

## CLI equivalent

The same engine ships as a CLI (`npx glitch-lens …`): `scan`, `discover --agent codex`, `codex-runtime`, `delegated-start`, `delegated-advance`. Prefer the pi tools inside pi; use the CLI in scripts.
