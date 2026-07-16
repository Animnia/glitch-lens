import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "@iarna/toml";
import type { Protocol } from "./adapters.js";

interface ProviderConfig {
  base_url?: unknown;
  env_key?: unknown;
  wire_api?: unknown;
}

interface CodexToml {
  model?: unknown;
  model_provider?: unknown;
  openai_base_url?: unknown;
  model_providers?: Record<string, ProviderConfig>;
}

export interface CodexDiscoveryOptions {
  codexHome?: string;
}

export interface DiscoveredCodexConfig {
  source: string;
  scope: "user-base";
  model: string;
  provider: string;
  protocol: Protocol;
  endpoint: string;
  keyEnv: string;
  wireApi?: string;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Codex config is missing ${field}`);
  }
  return value;
}

export async function discoverCodexConfig(options: CodexDiscoveryOptions = {}): Promise<DiscoveredCodexConfig> {
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const source = join(codexHome, "config.toml");
  let config: CodexToml;

  try {
    config = parse(await readFile(source, "utf8")) as CodexToml;
  } catch (error) {
    throw new Error(`Unable to read Codex config at ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const model = requiredString(config.model, "model");
  const provider = typeof config.model_provider === "string" ? config.model_provider : "openai";

  if (provider === "openai") {
    return {
      source,
      scope: "user-base",
      model,
      provider,
      protocol: "openai-responses",
      endpoint: typeof config.openai_base_url === "string" ? config.openai_base_url : "https://api.openai.com/v1",
      keyEnv: "OPENAI_API_KEY",
    };
  }

  const providerConfig = config.model_providers?.[provider];
  if (!providerConfig) throw new Error(`Codex config does not define model_providers.${provider}`);
  const wireApi = typeof providerConfig.wire_api === "string" ? providerConfig.wire_api : "responses";
  if (wireApi !== "chat" && wireApi !== "responses") {
    throw new Error(`Codex provider ${provider} uses unsupported wire_api=${wireApi}`);
  }

  return {
    source,
    scope: "user-base",
    model,
    provider,
    protocol: wireApi === "responses" ? "openai-responses" : "openai",
    endpoint: requiredString(providerConfig.base_url, `model_providers.${provider}.base_url`),
    keyEnv: requiredString(providerConfig.env_key, `model_providers.${provider}.env_key`),
    ...(wireApi ? { wireApi } : {}),
  };
}
