#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { createProbeRequester, type Protocol } from "./adapters.js";
import { scan, type ScanResult } from "./engine.js";
import { loadFingerprints } from "./fingerprints.js";
import { discoverCodexConfig, type DiscoveredCodexConfig } from "./codex.js";
import { advanceDelegatedRun, startDelegatedRun, type DelegatedRunState, type DelegatedTaskResult } from "./delegated.js";
import { readCodexRuntimeMetadata } from "./codex-transcript.js";
import { readClaudeRuntimeMetadata } from "./claude-transcript.js";

interface CliIo {
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  stdin?: () => Promise<string>;
  discoverCodex?: () => Promise<DiscoveredCodexConfig>;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface ScanArguments {
  protocol: Protocol;
  endpoint: string;
  model: string;
  keyEnv: string;
  fingerprints: string;
  json: boolean;
  timeoutMs: number;
}

function parseScanArguments(args: string[]): ScanArguments {
  const values = new Map<string, string>();
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (!argument?.startsWith("--")) throw new Error(`Unknown argument: ${argument ?? ""}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    values.set(argument, value);
    index += 1;
  }

  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`Missing required option ${name}`);
    return value;
  };
  const protocol = required("--protocol");
  if (protocol !== "openai" && protocol !== "openai-responses" && protocol !== "anthropic") {
    throw new Error("--protocol must be openai, openai-responses, or anthropic");
  }
  const timeoutMs = Number(values.get("--timeout-ms") ?? "60000");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be a positive number");

  return {
    protocol,
    endpoint: required("--endpoint"),
    model: required("--model"),
    keyEnv: required("--key-env"),
    fingerprints: values.get("--fingerprints") ?? resolve(packageRoot, "glitch_tokens.csv"),
    json,
    timeoutMs,
  };
}

function textReport(result: ScanResult): string {
  const lines = ["Glitch Lens experimental fingerprint scan", ""];
  if (result.status === "match") {
    lines.push(`Candidate vendor: ${result.candidates[0]?.vendor ?? "unknown"}`);
  } else if (result.status === "conflict") {
    lines.push(`Conflicting vendor fingerprints: ${result.candidates.map((item) => item.vendor).join(", ")}`);
  } else {
    lines.push("No confirmed vendor fingerprint was found.");
  }
  lines.push("", "This identifies known vendor-family behavior only; it cannot verify a specific model or provider honesty.");
  return `${lines.join("\n")}\n`;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export async function runCli(args: string[], io: CliIo): Promise<number> {
  try {
    const [command, ...commandArgs] = args;
    if (command === "codex-runtime") {
      const transcript = option(commandArgs, "--transcript");
      if (!transcript) throw new Error("Usage: glitch-lens codex-runtime --transcript <session.jsonl>");
      io.stdout(`${JSON.stringify(await readCodexRuntimeMetadata(transcript), null, 2)}\n`);
      return 0;
    }
    if (command === "claude-runtime") {
      const transcript = option(commandArgs, "--transcript");
      if (!transcript) throw new Error("Usage: glitch-lens claude-runtime --transcript <session.jsonl>");
      io.stdout(`${JSON.stringify(await readClaudeRuntimeMetadata(transcript), null, 2)}\n`);
      return 0;
    }
    if (command === "delegated-start") {
      const targetModel = option(commandArgs, "--model");
      if (!targetModel) throw new Error("Usage: glitch-lens delegated-start --model <slug> [--provider <id>] [--concurrency 4]");
      const fingerprintsPath = option(commandArgs, "--fingerprints") ?? resolve(packageRoot, "glitch_tokens.csv");
      const round = startDelegatedRun({
        fingerprints: await loadFingerprints(fingerprintsPath),
        targetModel,
        ...(option(commandArgs, "--provider") ? { targetProvider: option(commandArgs, "--provider")! } : {}),
        concurrency: positiveInteger(option(commandArgs, "--concurrency"), 4, "--concurrency"),
        maxTasks: positiveInteger(option(commandArgs, "--max-tasks"), 24, "--max-tasks"),
        maxDurationMs: positiveInteger(option(commandArgs, "--max-duration-ms"), 15 * 60_000, "--max-duration-ms"),
      });
      io.stdout(`${JSON.stringify(round, null, 2)}\n`);
      return 0;
    }
    if (command === "delegated-advance") {
      const inputPath = option(commandArgs, "--input");
      const source = inputPath ? await readFile(inputPath, "utf8") : await (io.stdin ?? readStdin)();
      const envelope = JSON.parse(source) as { state?: DelegatedRunState; results?: DelegatedTaskResult[] };
      if (!envelope.state || !Array.isArray(envelope.results)) throw new Error("Delegated input must contain state and results");
      io.stdout(`${JSON.stringify(advanceDelegatedRun(envelope.state, envelope.results), null, 2)}\n`);
      return 0;
    }
    if (command === "discover") {
      if (!commandArgs.includes("--agent") || !commandArgs.includes("codex")) {
        throw new Error("Usage: glitch-lens discover --agent codex [--json]");
      }
      const discovered = await (io.discoverCodex ?? discoverCodexConfig)();
      io.stdout(commandArgs.includes("--json") ? `${JSON.stringify(discovered, null, 2)}\n` : `${discovered.model} via ${discovered.provider} at ${discovered.endpoint} (key: ${discovered.keyEnv})\n`);
      return 0;
    }
    if (command !== "scan") throw new Error("Usage: glitch-lens scan --protocol <openai|openai-responses|anthropic> --endpoint <url> --model <id> --key-env <name> [--json]");
    const options = parseScanArguments(commandArgs);
    const apiKey = io.env[options.keyEnv];
    if (!apiKey) throw new Error(`Environment variable ${options.keyEnv} is not set`);

    const result = await scan({
      fingerprints: await loadFingerprints(options.fingerprints),
      requestProbe: createProbeRequester({
        protocol: options.protocol,
        endpoint: options.endpoint,
        model: options.model,
        apiKey,
        timeoutMs: options.timeoutMs,
      }),
    });
    io.stdout(options.json ? `${JSON.stringify(result, null, 2)}\n` : textReport(result));
    return 0;
  } catch (error) {
    io.stderr(`glitch-lens: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

const isEntryPoint = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isEntryPoint) {
  process.exitCode = await runCli(process.argv.slice(2), {
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
