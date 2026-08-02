# Glitch Lens

**Experimental glitch-token fingerprint scanner for LLM APIs.**
Identify which vendor family *actually* serves an endpoint, an agent session, or any OpenAI/Anthropic-compatible API.

[![npm version](https://img.shields.io/npm/v/glitch-lens)](https://www.npmjs.com/package/glitch-lens)
[![CI](https://github.com/Animnia/glitch-lens/actions/workflows/ci.yml/badge.svg)](https://github.com/Animnia/glitch-lens/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/glitch-lens)](https://github.com/Animnia/glitch-lens/blob/main/LICENSE)
[![Node.js ≥ 20](https://img.shields.io/node/v/glitch-lens)](https://nodejs.org)

Works inside your agent:
[pi](https://github.com/Animnia/glitch-lens#pi) ·
[Codex](https://github.com/Animnia/glitch-lens#codex) ·
[Claude Code](https://github.com/Animnia/glitch-lens#claude-code) ·
[Hermes](https://github.com/Animnia/glitch-lens#hermes-agent) ·
[CLI](https://github.com/Animnia/glitch-lens#cli-anywhere-else)

---

## Why

AI gateways, resellers, and proxies sometimes serve a different — cheaper — model than the one they advertise. Benchmarks are gameable, dashboards can be curated, and `model` fields are just strings anyone can write.

**Glitch tokens can't fake their way out.** A glitch token lives in one vendor's tokenizer but barely appeared in its training data, so that vendor's models mangle it when asked to copy it verbatim — while every other vendor's models copy it perfectly. The failure is a property of the weights, not of the API metadata.

Glitch Lens automates the test: it asks the target model to copy vendor-specific glitch tokens, judges the result, and tells you which vendor family the behavior matches.

## How it works

```
1. PROBE    Send a copy instruction with a vendor-specific glitch token:
            "请原样复制 <target> 标签内的全部文本。<target>开通天眼生意通银牌及以上会员</target>"

2. JUDGE    Compare whitespace-insensitively (NFC-normalized).
            Token reproduced → copy_success. Anything else → copy_failed.

3. CONFIRM  The same token must fail twice, in two fresh probes.
            Two failures → vendor-family candidate confirmed.
            Request errors are retried once and never counted as evidence.
```

The bundled fingerprint set ([`glitch_tokens.csv`](glitch_tokens.csv)) covers eight vendor families:

| Vendor family | Example glitch token |
|---|---|
| GPT | `给主人留下些什么吧` |
| Gemini | `StarSrvGroupBody` |
| GLM | `锅内倒入植物油烧热` |
| Qwen | `开通天眼生意通银牌及以上会员` |
| kimi | `百度百科内容由网友共同编辑` |
| Deepseek | `"EDMFunc"` |
| Minimax | `日以上更新していないブログに表示しています` |
| Seed/豆包 | `<think_never_used_51bce0c78…>` |

## What it can and cannot tell you

This tool is deliberately honest about its limits. **Repeat these when you report results.**

| A `match` **means** | A `match` does **not** mean |
|---|---|
| The behavior matches a known **vendor family** | A specific model version is verified |
| Strong circumstantial evidence of substitution | Proof that a provider is dishonest |
| Worth investigating further | Proof that a `unknown` result clears anyone — the fingerprint set is small and experimental |

The delegated channel (agent probes itself) is additionally labeled `experimental-context-contaminated`, because an agent answering probes inside its own conversation can be influenced by that context. Prefer direct scans whenever API access is available.

## Install

### pi

```bash
pi install npm:glitch-lens                      # npm channel
pi install git:github.com/Animnia/glitch-lens   # git channel
```

Registers four tools — `glitch_lens_scan`, `glitch_lens_self_scan`, `glitch_lens_delegated_start`, `glitch_lens_delegated_advance` — plus a `glitch-lens` skill that teaches the agent when and how to use them. `glitch_lens_self_scan` reuses pi's resolved provider auth; keys are never printed.

### Codex

```bash
codex plugin marketplace add Animnia/glitch-lens
codex plugin add glitch-lens@animnia
```

Installs the `glitch-lens` skill (invoke with `$glitch-lens`, or let it trigger implicitly). Adds a **delegated self-scan** flow for Codex: the runtime model/provider is read from the session transcript (`codex-runtime`), and probes execute in fresh `codex exec` sessions to minimize context contamination.

### Claude Code

```bash
claude plugin marketplace add Animnia/glitch-lens
claude plugin install glitch-lens@animnia
```

Installs the `glitch-lens` skill (invoke with `/glitch-lens`, or let it trigger implicitly). The runtime model is read from the session transcript via `claude-runtime`. (Claude Code transcripts don't record the API provider, so none is reported — Glitch Lens never claims metadata it can't prove.)

### Hermes Agent

```bash
hermes skills tap add Animnia/glitch-lens
hermes skills install Animnia/glitch-lens/glitch-lens
# or without adding the tap:
hermes skills install Animnia/glitch-lens/skills/glitch-lens
```

Installs the `glitch-lens` skill (`/glitch-lens`), passing Hermes' hub security scan. Audit the endpoint Hermes is configured against (`hermes config show`), or run a delegated self-scan with probes in fresh `hermes chat -q` sessions.

### CLI (anywhere else)

```bash
npx -y glitch-lens --help     # no install needed, Node.js ≥ 20
# or: npm install -g glitch-lens
```

## Usage

### Audit an endpoint

```bash
glitch-lens scan --protocol openai \
  --endpoint https://api.example.com/v1 \
  --model some-model --key-env EXAMPLE_API_KEY --json
```

The key is read from the environment variable you *name* — it is never accepted as an argument and never printed. Protocols: `openai`, `openai-responses`, `anthropic`.

```json
{
  "status": "match",
  "candidates": [{ "vendor": "GLM", "confirmedToken": "锅内倒入植物油烧热" }],
  "evidence": [
    { "vendor": "GLM", "token": "锅内倒入植物油烧热", "attempt": 1, "outcome": "copy_failed" },
    { "vendor": "GLM", "token": "锅内倒入植物油烧热", "attempt": 2, "outcome": "copy_failed" }
  ]
}
```

### Audit what an agent is *actually* running on

The delegated protocol is built for agent sessions — the harness issues blinded probe tasks (no vendor labels), the agent executes them against the model itself, and results are validated before scoring:

```bash
glitch-lens delegated-start --model <slug> [--provider <id>]   # → { state, tasks }
# …agent executes each task.prompt against the target model…
glitch-lens delegated-advance --input round.json               # → next round, or final report
```

Results are checked for execution status, model identity (`model_mismatch` / `model_unverified`), and provider drift before they count as evidence. Reports carry `channel: "delegated"` and the `experimental-context-contaminated` confidence class.

### Read agent runtime metadata

```bash
glitch-lens discover --agent codex                 # model/provider/endpoint/key-env from ~/.codex/config.toml
glitch-lens codex-runtime --transcript <session.jsonl>   # real runtime model+provider of a Codex session
glitch-lens claude-runtime --transcript <session.jsonl>  # real runtime model of a Claude Code session
```

### Interpreting results

| `status` | Meaning |
|---|---|
| `match` | Exactly one vendor candidate confirmed (two fresh copy failures on one token) |
| `conflict` | Several vendor families confirmed — report them all |
| `unknown` | No fingerprint confirmed — inconclusive, **not** an exoneration |

Evidence outcomes `request_failed`, `execution_failed`, `model_unverified`, `model_mismatch` mark **inconclusive** probes and are never counted as copy failures.

## Design principles

- **Evidence, not vibes.** Every conclusion is backed by recorded per-token evidence; two independent failures required; transient errors never count.
- **Honesty by construction.** Confidence labels travel with every report (`direct`, `direct-self`, `delegated` / `experimental-context-contaminated`). The tool refuses to report metadata it cannot prove.
- **Keys stay secret.** API keys are only ever read from environment variables named on the command line — never accepted inline, never printed.
- **One engine, every agent.** The same scan engine powers the CLI and all four agent integrations; each platform gets a native, idiomatic package.

## Repository layout

```
src/                 scan engine, protocol adapters, CLI, agent config/transcript readers, delegated protocol
extensions/          pi extension (registers the glitch_lens_* tools)
pi/skills/           pi skill
plugins/glitch-lens/         Codex plugin (.codex-plugin + skill)
plugins/glitch-lens-claude/  Claude Code plugin (.claude-plugin + skill)
skills/              Hermes skill (repo root doubles as a Hermes tap)
.agents/plugins/     Codex marketplace catalog
.claude-plugin/      Claude Code marketplace catalog
glitch_tokens.csv    bundled vendor fingerprint set
```

## Development

```bash
npm install
npm test            # vitest: engine, adapters, delegated protocol, CLI, all packaging
npm run typecheck   # src + extensions
npm run build       # CLI → dist/
```

## Contributing

Issues and PRs are welcome — especially new vendor-specific glitch tokens (CSV rows with `isSpecific=y` and a measured `error rate@5`), additional protocol adapters, and new agent-platform integrations.

## License

[MIT](LICENSE)
