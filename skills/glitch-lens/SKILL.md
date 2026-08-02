---
name: glitch-lens
description: Verify which vendor family (GPT, Gemini, GLM, Qwen, kimi, Deepseek, Minimax, Seed) actually serves an LLM endpoint or this Hermes agent, using glitch-token fingerprint probes. Use when the user suspects model substitution, wants to audit an API provider or OpenAI-compatible endpoint, or asks what model they are really talking to.
version: 0.5.1
author: Animnia
license: MIT
metadata:
  hermes:
    tags: [security, llm, verification, fingerprint]
    category: security
---

# Glitch Lens

Glitch Lens probes a model with glitch tokens — strings that one vendor's models consistently fail to copy verbatim while every other vendor's models copy them fine. Two fresh copy failures on the same token confirm a vendor-family candidate.

**Epistemic boundary (always repeat this to the user):** fingerprints identify known vendor-family behavior only. They cannot verify a specific model version, and cannot prove a provider is honest or dishonest. An `unknown` result is inconclusive, not an exoneration.

## When to Use

- The user suspects an API provider, reseller, or proxy serves a different model than claimed.
- The user wants to audit the OpenAI-compatible endpoint their Hermes agent (or any tool) is configured against.
- The user asks "what model am I really talking to?"

## Quick Reference

All commands run through the `glitch-lens` CLI via `npx -y glitch-lens` (requires Node.js ≥ 20; no install needed). Never print API key values — the CLI reads keys from environment variables named on the command line.

| Task | Command |
|---|---|
| Scan an endpoint | `npx -y glitch-lens scan --protocol <openai\|openai-responses\|anthropic> --endpoint <url> --model <id> --key-env <ENV_NAME> --json` |
| Start delegated scan | `npx -y glitch-lens delegated-start --model <slug> [--provider <id>]` |
| Advance delegated scan | `npx -y glitch-lens delegated-advance --input <round.json>` |
| Show Hermes model/provider config | `hermes config show` |

## Procedure

### Channel 1 — Direct scan of an endpoint (preferred when a key is available)

1. Determine the endpoint, model id, and the name of the env var holding the API key. To audit the endpoint Hermes itself uses, run `hermes config show` and read the configured provider/model and any custom base URL.
2. Never echo or print the key value. If the variable is unset, the CLI exits with a clear `Environment variable <NAME> is not set` error — tell the user the variable name and ask them to export it.
3. Run the scan command from the table above and present the JSON result.

### Channel 2 — Delegated self-scan of this Hermes agent

Use when no API key is available, or the question is specifically "what model is serving this agent?". The agent executes blinded probe tasks against itself; the final report is labeled `experimental-context-contaminated` — say this when presenting it.

1. Run `hermes config show` and note the configured model id — use it as `--model` below and as `actualModel` in every result.
2. `npx -y glitch-lens delegated-start --model <model>` → returns `{ state, tasks }`. Tasks are blinded (no vendor labels) — do not try to infer vendors from tokens.
3. Execute each task in a **fresh, minimal session** so the answer is not contaminated by this conversation:
   ```bash
   hermes chat -q "<task.prompt verbatim>"
   ```
   Capture the reply as `modelOutput`. Fallback (faster, more contaminated): answer the probe prompt yourself in-context, verbatim, with no commentary.
4. Write `{"state": <state>, "results": [...]}` to a temp file and run `npx -y glitch-lens delegated-advance --input <file>`. Each result: `{ taskId, executionStatus: "completed", modelOutput, actualModel }`, or `{ taskId, executionStatus: "failed", error }`. Repeat until `done: true`.
5. Present `report`: `status`, `candidates`, `coverage`, `stopReason`, and the contamination label.

## Pitfalls

- Never alter, translate, or "fix" probe prompts or outputs; the scorer handles whitespace differences.
- A result without `actualModel` is discarded as `model_unverified`; execution failures are retried, never counted as copy failures.
- `status: "conflict"` means several vendor families confirmed — report them all, do not pick one.
- `status: "unknown"` is inconclusive — the fingerprint set is small; it does not prove the model is genuine.
- If `npx` fails, check Node.js ≥ 20 is installed; on restricted networks retry with a proxy.

## Verification

A completed scan produces `status: "match"` with `candidates[0].vendor` (the likely vendor family), plus per-token `evidence`. Cross-check that evidence outcomes are `copy_failed` (confirmed twice) and that inconclusive outcomes (`request_failed`, `execution_failed`, `model_unverified`) are not presented as copy failures.
