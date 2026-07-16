import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverCodexConfig } from "./codex.js";

async function codexHome(config: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "glitch-lens-codex-"));
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "config.toml"), config, "utf8");
  return home;
}

describe("discoverCodexConfig", () => {
  it("discovers a custom OpenAI-compatible provider without reading its secret", async () => {
    const home = await codexHome(`
model = "proxy-model"
model_provider = "proxy"

[model_providers.proxy]
base_url = "https://proxy.example.com/v1"
env_key = "PROXY_API_KEY"
wire_api = "chat"
`);

    await expect(discoverCodexConfig({ codexHome: home })).resolves.toEqual({
      source: join(home, "config.toml"),
      scope: "user-base",
      model: "proxy-model",
      provider: "proxy",
      protocol: "openai",
      endpoint: "https://proxy.example.com/v1",
      keyEnv: "PROXY_API_KEY",
      wireApi: "chat",
    });
  });

  it("discovers the built-in OpenAI provider base URL override", async () => {
    const home = await codexHome(`
model = "gpt-compatible"
openai_base_url = "https://router.example.com/v1"
`);

    await expect(discoverCodexConfig({ codexHome: home })).resolves.toMatchObject({
      model: "gpt-compatible",
      provider: "openai",
      protocol: "openai-responses",
      endpoint: "https://router.example.com/v1",
      keyEnv: "OPENAI_API_KEY",
    });
  });

  it("returns an actionable error when the selected custom provider is incomplete", async () => {
    const home = await codexHome(`
model = "proxy-model"
model_provider = "proxy"

[model_providers.proxy]
base_url = "https://proxy.example.com/v1"
`);

    await expect(discoverCodexConfig({ codexHome: home })).rejects.toThrow("env_key");
  });
});
