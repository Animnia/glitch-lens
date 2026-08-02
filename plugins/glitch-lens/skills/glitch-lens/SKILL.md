---
name: glitch-lens
description: Verify which vendor family (GPT, Gemini, GLM, Qwen, kimi, Deepseek, Minimax, Seed) actually serves an LLM endpoint or this Codex session, using glitch-token fingerprint probes. Use when the user suspects model substitution, wants to audit an API provider or their Codex configuration, or asks what model they are really talking to.
license: MIT
metadata:
  homepage: https://github.com/Animnia/glitch-lens
---

# Glitch Lens

Glitch Lens probes a model with glitch tokens — strings that one vendor's models consistently fail to copy verbatim while every other vendor's models copy them fine. Two fresh copy failures on the same token confirm a vendor-family candidate.

**Epistemic boundary (always repeat this to the user):** fingerprints identify known vendor-family behavior only. They cannot verify a specific model version, and cannot prove a provider is honest or dishonest. An `unknown` result is inconclusive, not an exoneration.

All commands run through the `glitch-lens` CLI via `npx -y glitch-lens` (requires Node.js ≥ 20; no install needed). Never print API key values — the CLI reads keys from environment variables named on the command line.

## Choose a channel

- **"Is the model serving this Codex session really X?"** → Delegated self-scan (section A). Highest relevance, lower confidence (`experimental-context-contaminated`).
- **"Is my configured Codex endpoint honest?"** → Direct scan of the discovered endpoint (section B). Higher confidence, but tests the endpoint, not this session.
- **"Audit this arbitrary API endpoint."** → Direct scan with explicit parameters (section C).

## A. Delegated self-scan of this Codex session

The agent executes blinded probe tasks against the target model itself; the final report is labeled `experimental-context-contaminated` — say this when presenting it.

1. **Runtime metadata.** Find the newest session transcript and read the real runtime model/provider:
   ```bash
   TRANSCRIPT=$(ls -t ~/.codex/sessions/*/*/*/rollout-*.jsonl | head -1)
   npx -y glitch-lens codex-runtime --transcript "$TRANSCRIPT"
   ```
   Use its `model` and `provider` as `--model` / `--provider` below and as `actualModel` / `actualProvider` in every result.
2. **Start.** `npx -y glitch-lens delegated-start --model <model> --provider <provider>` → returns `{ state, tasks }`. Tasks are blinded (no vendor labels) — do not try to infer vendors from tokens.
3. **Execute each task.** Preferred: run the probe in a **fresh Codex session** so the answer is not contaminated by this conversation:
   ```bash
   codex exec "<task.prompt verbatim>"
   ```
   Capture the final agent message as `modelOutput`. Re-run step 1's metadata read on the **new** transcript created by that exec call if you need per-task `actualModel`. Fallback (faster, more contaminated): answer the probe prompt yourself in-context, verbatim, with no commentary.
4. **Advance.** Write `{"state": <state>, "results": [...]}` to a temp file and run:
   ```bash
   npx -y glitch-lens delegated-advance --input /tmp/glitch-round.json
   ```
   Each result: `{ taskId, executionStatus: "completed", modelOutput, actualModel, actualProvider }`, or `{ taskId, executionStatus: "failed", error }`. Repeat until `done: true`.
5. **Present `report`.** Include `status`, `candidates`, `coverage`, `stopReason`, and the contamination label.

Rules: never alter, translate, or "fix" probe prompts or outputs; a result without `actualModel` is discarded as `model_unverified`; execution failures are retried, never counted as copy failures.

## B. Direct scan of the configured Codex endpoint

```bash
npx -y glitch-lens discover --agent codex --json
```
This prints the configured `protocol`, `endpoint`, `model`, and `keyEnv` (the env var *name*, never a secret). If that env var is set in your shell, run:
```bash
npx -y glitch-lens scan --protocol <protocol> --endpoint <endpoint> --model <model> --key-env <keyEnv> --json
```
If the env var is not set, tell the user its name and ask them to export it — do not ask for the key value.

## C. Direct scan of an arbitrary endpoint

```bash
npx -y glitch-lens scan --protocol <openai|openai-responses|anthropic> \
  --endpoint <base-url> --model <model-id> --key-env <ENV_VAR_NAME> --json
```

## Read a result

- `status: "match"` — one vendor candidate confirmed; report `candidates[0].vendor` as the likely vendor family.
- `status: "conflict"` — several vendor families confirmed; say so plainly, do not pick one.
- `status: "unknown"` — no fingerprint confirmed; inconclusive, **not** proof the model is genuine.
- Evidence outcomes `request_failed` / `execution_failed` / `model_unverified` / `model_mismatch` mark inconclusive probes — never present them as copy failures.
