import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { createProbeRequester, type Protocol } from "../src/adapters.js";
import { scan } from "../src/engine.js";
import { loadFingerprints } from "../src/fingerprints.js";
import {
  advanceDelegatedRun,
  startDelegatedRun,
  type DelegatedRunState,
  type DelegatedTaskResult,
} from "../src/delegated.js";

const PROTOCOLS = ["openai", "openai-responses", "anthropic"] as const;

const HONESTY_NOTE =
  "Glitch-token fingerprints identify known vendor-family behavior only; they cannot verify a specific model version or prove provider honesty.";

function defaultFingerprintsPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "glitch_tokens.csv");
}

function fingerprintsPath(param: string | undefined): string {
  return param?.replace(/^@/, "") || defaultFingerprintsPath();
}

function protocolForApi(api: string): Protocol | undefined {
  switch (api) {
    case "openai-completions":
      return "openai";
    case "openai-responses":
    case "azure-openai-responses":
    case "openai-codex-responses":
      return "openai-responses";
    case "anthropic-messages":
      return "anthropic";
    default:
      return undefined;
  }
}

function jsonResult(value: unknown): { content: Array<{ type: "text"; text: string }>; details: unknown } {
  return { content: [{ type: "text", text: `${JSON.stringify(value, null, 2)}\n` }], details: value };
}

interface ScanParams {
  protocol: Protocol;
  endpoint: string;
  model: string;
  keyEnv: string;
  fingerprints?: string;
  timeoutMs?: number;
}

interface SelfScanParams {
  fingerprints?: string;
  timeoutMs?: number;
}

interface DelegatedStartParams {
  targetModel: string;
  targetProvider?: string;
  concurrency?: number;
  maxTasks?: number;
  fingerprints?: string;
}

interface DelegatedAdvanceParams {
  state: DelegatedRunState;
  results: Array<{
    taskId: string;
    executionStatus: "completed" | "failed";
    modelOutput?: string;
    actualModel?: string;
    actualProvider?: string;
    error?: string;
  }>;
}

async function runScan(params: ScanParams) {
  const apiKey = process.env[params.keyEnv];
  if (!apiKey) throw new Error(`Environment variable ${params.keyEnv} is not set`);
  const result = await scan({
    fingerprints: await loadFingerprints(fingerprintsPath(params.fingerprints)),
    requestProbe: createProbeRequester({
      protocol: params.protocol,
      endpoint: params.endpoint,
      model: params.model,
      apiKey,
      ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
    }),
  });
  return jsonResult({ channel: "direct", ...result, note: HONESTY_NOTE });
}

async function runSelfScan(params: SelfScanParams, ctx: ExtensionContext) {
  const model = ctx.model;
  if (!model) throw new Error("No active model in this session");
  const protocol = protocolForApi(model.api);
  if (!protocol) {
    throw new Error(
      `The active model uses the "${model.api}" API, which glitch-lens cannot probe directly ` +
        "(supported: openai-completions, openai-responses, anthropic-messages). " +
        "Use glitch_lens_delegated_start instead.",
    );
  }
  const auth = await ctx.modelRegistry.getProviderAuth(model.provider);
  const apiKey = auth?.auth.apiKey;
  if (!apiKey) {
    throw new Error(
      `No API key could be resolved for provider "${model.provider}". Configure provider auth in pi, ` +
        "scan an explicit endpoint with glitch_lens_scan, or use glitch_lens_delegated_start.",
    );
  }
  const endpoint = auth.auth.baseUrl ?? model.baseUrl;
  const result = await scan({
    fingerprints: await loadFingerprints(fingerprintsPath(params.fingerprints)),
    requestProbe: createProbeRequester({
      protocol,
      endpoint,
      model: model.id,
      apiKey,
      ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
    }),
  });
  return jsonResult({
    channel: "direct-self",
    target: {
      provider: model.provider,
      model: model.id,
      api: model.api,
      endpoint,
      keySource: auth?.source ?? "provider auth",
    },
    ...result,
    note: HONESTY_NOTE,
  });
}

async function runDelegatedStart(params: DelegatedStartParams) {
  const round = startDelegatedRun({
    fingerprints: await loadFingerprints(fingerprintsPath(params.fingerprints)),
    targetModel: params.targetModel,
    ...(params.targetProvider ? { targetProvider: params.targetProvider } : {}),
    ...(params.concurrency ? { concurrency: params.concurrency } : {}),
    ...(params.maxTasks ? { maxTasks: params.maxTasks } : {}),
  });
  return jsonResult(round);
}

async function runDelegatedAdvance(params: DelegatedAdvanceParams) {
  const results: DelegatedTaskResult[] = params.results.map((result) => {
    if (result.executionStatus === "failed") {
      return { taskId: result.taskId, executionStatus: "failed", error: result.error ?? "unknown error" };
    }
    if (typeof result.modelOutput !== "string") {
      throw new Error(`Task ${result.taskId}: completed results must include modelOutput`);
    }
    return {
      taskId: result.taskId,
      executionStatus: "completed",
      modelOutput: result.modelOutput,
      ...(result.actualModel ? { actualModel: result.actualModel } : {}),
      ...(result.actualProvider ? { actualProvider: result.actualProvider } : {}),
    };
  });
  return jsonResult(advanceDelegatedRun(params.state, results));
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "glitch_lens_scan",
    label: "Glitch Lens Scan",
    description:
      "Probe an LLM API endpoint with glitch-token fingerprints to identify which vendor family (GPT, Gemini, GLM, Qwen, kimi, Deepseek, Minimax, Seed) actually serves it. The API key is read from the environment variable named by keyEnv and is never printed.",
    promptSnippet: "Identify the vendor family behind an LLM API endpoint via glitch-token probes",
    promptGuidelines: [
      "Use glitch_lens_scan when the user wants to audit or verify which vendor family actually serves an LLM API endpoint.",
      "Never print or exfiltrate API key values when using glitch_lens_scan; pass the environment variable name via keyEnv.",
    ],
    parameters: Type.Object({
      protocol: StringEnum(PROTOCOLS),
      endpoint: Type.String({ description: "API base URL, e.g. https://api.example.com/v1" }),
      model: Type.String({ description: "Model id to probe" }),
      keyEnv: Type.String({ description: "Name of the environment variable holding the API key" }),
      fingerprints: Type.Optional(Type.String({ description: "Fingerprint CSV path; defaults to the bundled glitch_tokens.csv" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Per-request timeout in milliseconds (default 60000)" })),
    }),
    async execute(_toolCallId, params: ScanParams) {
      return runScan(params);
    },
  });

  pi.registerTool({
    name: "glitch_lens_self_scan",
    label: "Glitch Lens Self Scan",
    description:
      "Probe the model currently serving this pi session with glitch-token fingerprints, using pi's resolved provider auth. Identifies the vendor family actually answering. Supports openai-completions, openai-responses, and anthropic-messages providers.",
    promptSnippet: "Identify the vendor family actually serving the current pi model",
    promptGuidelines: [
      "Use glitch_lens_self_scan when the user asks whether the current pi model is really what it claims to be, or suspects model substitution.",
    ],
    parameters: Type.Object({
      fingerprints: Type.Optional(Type.String({ description: "Fingerprint CSV path; defaults to the bundled glitch_tokens.csv" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Per-request timeout in milliseconds (default 60000)" })),
    }),
    async execute(_toolCallId, params: SelfScanParams, _signal, _onUpdate, ctx) {
      return runSelfScan(params, ctx);
    },
  });

  pi.registerTool({
    name: "glitch_lens_delegated_start",
    label: "Glitch Lens Delegated Start",
    description:
      "Start a blinded delegated glitch-token scan. Returns probe tasks for the caller to execute against the target model itself. Use when the target API cannot be probed directly (unsupported wire API, no key access). Lower confidence: results are context-contaminated.",
    promptSnippet: "Start a delegated glitch-token scan executed by the agent itself",
    promptGuidelines: [
      "Use glitch_lens_delegated_start only when direct probing is impossible; its report is labeled experimental-context-contaminated.",
    ],
    parameters: Type.Object({
      targetModel: Type.String({ description: "Model slug under test, e.g. the current pi model id" }),
      targetProvider: Type.Optional(Type.String({ description: "Expected provider id, when known" })),
      concurrency: Type.Optional(Type.Number({ minimum: 1, maximum: 8, description: "Parallel probe tasks (default 4)" })),
      maxTasks: Type.Optional(Type.Number({ description: "Task budget, capped at 24" })),
      fingerprints: Type.Optional(Type.String({ description: "Fingerprint CSV path; defaults to the bundled glitch_tokens.csv" })),
    }),
    async execute(_toolCallId, params: DelegatedStartParams) {
      return runDelegatedStart(params);
    },
  });

  pi.registerTool({
    name: "glitch_lens_delegated_advance",
    label: "Glitch Lens Delegated Advance",
    description:
      "Feed executed probe results back into a delegated glitch-token scan. Pass the state from the previous round plus one result per executed task. Returns the next tasks, or a final report when done.",
    parameters: Type.Object({
      state: Type.Any({ description: "The DelegatedRunState from the previous round" }),
      results: Type.Array(
        Type.Object({
          taskId: Type.String(),
          executionStatus: StringEnum(["completed", "failed"] as const),
          modelOutput: Type.Optional(Type.String({ description: "The model's verbatim output; required when executionStatus is completed" })),
          actualModel: Type.Optional(Type.String({ description: "Model id that actually produced the output, when known" })),
          actualProvider: Type.Optional(Type.String({ description: "Provider that actually produced the output, when known" })),
          error: Type.Optional(Type.String({ description: "Failure detail when executionStatus is failed" })),
        }),
      ),
    }),
    async execute(_toolCallId, params: DelegatedAdvanceParams) {
      return runDelegatedAdvance(params);
    },
  });
}
