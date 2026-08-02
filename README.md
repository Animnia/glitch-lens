# Glitch Lens

Experimental glitch-token fingerprint scanner for LLM APIs.

Glitch Lens probes a model with **glitch tokens** — strings that one vendor's models consistently fail to copy verbatim while every other vendor's models copy them fine. Two fresh copy failures on the same token confirm a vendor-family candidate. The bundled fingerprint set (`glitch_tokens.csv`) covers GPT, Gemini, GLM, Qwen, kimi, Deepseek, Minimax, and Seed/豆包.

> **What this can and cannot tell you.** A `match` identifies known *vendor-family* behavior only. It cannot verify a specific model version, and it cannot prove a provider is honest or dishonest. An `unknown` result does not clear a provider — the fingerprint set is small and experimental.

## Install

### As a pi package (tools + skill)

```bash
pi install npm:glitch-lens@0.2.1        # npm 渠道
# 或
pi install git:github.com/Animnia/glitch-lens@v0.2.1   # git 渠道
```

This registers four tools (`glitch_lens_scan`, `glitch_lens_self_scan`, `glitch_lens_delegated_start`, `glitch_lens_delegated_advance`) and a `glitch-lens` skill that teaches the agent when and how to use them.

### As a CLI

```bash
npm install -g glitch-lens   # or: npx glitch-lens ...
```

## Usage inside pi

- **Audit the current pi model:** ask "is the model serving this session really what it claims to be?" — the agent calls `glitch_lens_self_scan`, which reuses pi's resolved provider auth (keys are never printed).
- **Audit an arbitrary endpoint:** the agent calls `glitch_lens_scan` with `protocol` (`openai` | `openai-responses` | `anthropic`), `endpoint`, `model`, and `keyEnv` — the *name* of the environment variable holding the API key, never the key itself.
- **Unsupported wire APIs** (google, bedrock, …): the agent falls back to the delegated channel, executing blinded probe tasks against the target model itself. Reports from this channel are labeled `experimental-context-contaminated`.

## CLI usage

```bash
# Direct scan of an OpenAI-compatible endpoint
glitch-lens scan --protocol openai --endpoint https://api.example.com/v1 \
  --model some-model --key-env EXAMPLE_API_KEY [--json]

# Discover the model/provider a Codex CLI install is configured with
glitch-lens discover --agent codex [--json]

# Read runtime model/provider metadata from a Codex session transcript
glitch-lens codex-runtime --transcript ~/.codex/sessions/.../rollout.jsonl

# Delegated scan protocol (agent-executed probes)
glitch-lens delegated-start --model <slug> [--provider <id>] [--concurrency 4]
glitch-lens delegated-advance [--input round.json]   # or pipe {state, results} on stdin
```

## Reading a result

| status | meaning |
|---|---|
| `match` | Exactly one vendor candidate confirmed (two fresh copy failures on the same token). |
| `conflict` | More than one vendor family confirmed. |
| `unknown` | No fingerprint confirmed — inconclusive, **not** an exoneration. |

Evidence outcomes such as `request_failed`, `execution_failed`, or `model_unverified` mark inconclusive probes and are never counted as copy failures. Copy comparison is whitespace-insensitive and Unicode-NFC-normalized, per the judgment rules in `test_rules.md`.

## Development

```bash
npm install
npm run build       # compile CLI to dist/
npm test            # vitest (engine, adapters via local HTTP, delegated protocol, pi tools)
npm run typecheck   # src + extensions
```

The pi extension (`extensions/index.ts`) imports the TypeScript sources under `src/` directly — pi loads extensions through jiti, so no build step is needed at package install time. The CLI (`dist/cli.js`) is the only artifact that requires `npm run build`.

## Repository layout

```
src/            engine, protocol adapters, CLI, Codex config/transcript readers, delegated state machine
extensions/     pi extension (registers the glitch_lens_* tools)
skills/         pi skill (usage guidance for the agent)
glitch_tokens.csv   bundled vendor fingerprint set
```

## License

MIT
