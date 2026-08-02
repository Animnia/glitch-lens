import { createServer, type RequestListener } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import extension from "./index.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to start test server");
  return `http://127.0.0.1:${address.port}`;
}

async function fixtureCsv(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "glitch-lens-ext-"));
  const path = join(directory, "fingerprints.csv");
  await writeFile(
    path,
    "glitch token,model series,error rate@5,isSpecific\nalpha,Vendor A,100,y\nalpha-two,Vendor A,100,y\n",
    "utf8",
  );
  return path;
}

function registerTools(): Map<string, any> {
  const tools = new Map<string, any>();
  const pi = {
    registerTool: (definition: any) => tools.set(definition.name, definition),
    registerCommand: () => undefined,
    on: () => undefined,
  };
  extension(pi as any);
  return tools;
}

function fakeCtx(overrides: Record<string, unknown>): any {
  return {
    model: { id: "test-model", provider: "test-provider", api: "openai-completions", baseUrl: "http://unused" },
    modelRegistry: { getProviderAuth: async () => undefined },
    ...overrides,
  };
}

describe("pi extension", () => {
  it("registers the four glitch-lens tools", () => {
    const tools = registerTools();
    expect([...tools.keys()].sort()).toEqual([
      "glitch_lens_delegated_advance",
      "glitch_lens_delegated_start",
      "glitch_lens_scan",
      "glitch_lens_self_scan",
    ]);
  });

  it("scans an OpenAI-compatible endpoint through the scan tool", async () => {
    vi.stubEnv("GLITCH_LENS_TEST_KEY", "secret");
    let calls = 0;
    const endpoint = await listen((_request, response) => {
      calls += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: "wrong" } }] }));
    });
    const tools = registerTools();
    const result = await tools.get("glitch_lens_scan").execute("t1", {
      protocol: "openai",
      endpoint,
      model: "test-model",
      keyEnv: "GLITCH_LENS_TEST_KEY",
      fingerprints: await fixtureCsv(),
    }, undefined, undefined, fakeCtx({}));

    expect(calls).toBeGreaterThan(0);
    expect(result.details).toMatchObject({ status: "match", candidates: [{ vendor: "Vendor A", confirmedToken: "alpha" }] });
    expect(result.content[0].text).not.toContain("secret");
  });

  it("fails clearly when the scan key environment variable is missing", async () => {
    const tools = registerTools();
    await expect(
      tools.get("glitch_lens_scan").execute("t1", {
        protocol: "openai",
        endpoint: "http://127.0.0.1:1",
        model: "m",
        keyEnv: "GLITCH_LENS_DEFINITELY_MISSING",
      }, undefined, undefined, fakeCtx({})),
    ).rejects.toThrow("GLITCH_LENS_DEFINITELY_MISSING");
  });

  it("self-scans the active pi model using resolved provider auth", async () => {
    const endpoint = await listen((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: "unrelated" } }] }));
    });
    const tools = registerTools();
    const ctx = fakeCtx({
      model: { id: "claimed-model", provider: "proxy", api: "openai-completions", baseUrl: "http://unused" },
      modelRegistry: {
        getProviderAuth: async () => ({ auth: { apiKey: "resolved-secret", baseUrl: endpoint }, source: "PROXY_API_KEY" }),
      },
    });
    const result = await tools.get("glitch_lens_self_scan").execute("t1", { fingerprints: await fixtureCsv() }, undefined, undefined, ctx);

    expect(result.details).toMatchObject({
      channel: "direct-self",
      status: "match",
      target: { provider: "proxy", model: "claimed-model", endpoint, keySource: "PROXY_API_KEY" },
    });
    expect(result.content[0].text).not.toContain("resolved-secret");
  });

  it("rejects self-scan for unsupported wire APIs and points at delegation", async () => {
    const tools = registerTools();
    const ctx = fakeCtx({ model: { id: "gemini-ish", provider: "google", api: "google-generative-ai", baseUrl: "http://unused" } });
    await expect(
      tools.get("glitch_lens_self_scan").execute("t1", {}, undefined, undefined, ctx),
    ).rejects.toThrow("glitch_lens_delegated_start");
  });

  it("runs a delegated round trip to a match report", async () => {
    const tools = registerTools();
    const fingerprints = await fixtureCsv();
    const started = await tools.get("glitch_lens_delegated_start").execute("t1", {
      targetModel: "provider/model",
      targetProvider: "provider",
      concurrency: 1,
      fingerprints,
    }, undefined, undefined, fakeCtx({}));

    expect(started.details.done).toBe(false);
    expect(started.details.tasks).toHaveLength(1);
    expect(JSON.stringify(started.details.tasks)).not.toContain("Vendor");

    const advance = (state: unknown, results: unknown) =>
      tools.get("glitch_lens_delegated_advance").execute("t1", { state, results }, undefined, undefined, fakeCtx({}));

    const probe = started.details.tasks[0];
    const confirmation = await advance(started.details.state, [{
      taskId: probe.taskId,
      executionStatus: "completed",
      modelOutput: "wrong",
      actualModel: "provider/model",
      actualProvider: "provider",
    }]);
    expect(confirmation.details.done).toBe(false);

    const final = await advance(confirmation.details.state, [{
      taskId: confirmation.details.tasks[0].taskId,
      executionStatus: "completed",
      modelOutput: "still wrong",
      actualModel: "provider/model",
      actualProvider: "provider",
    }]);
    expect(final.details.done).toBe(true);
    expect(final.details.report).toMatchObject({
      channel: "delegated",
      confidenceClass: "experimental-context-contaminated",
      status: "match",
      candidates: [{ vendor: "Vendor A", confirmedToken: "alpha" }],
    });
  });

  it("rejects completed delegated results without modelOutput", async () => {
    const tools = registerTools();
    const started = await tools.get("glitch_lens_delegated_start").execute("t1", {
      targetModel: "provider/model",
      fingerprints: await fixtureCsv(),
    }, undefined, undefined, fakeCtx({}));
    await expect(
      tools.get("glitch_lens_delegated_advance").execute("t1", {
        state: started.details.state,
        results: [{ taskId: started.details.tasks[0].taskId, executionStatus: "completed" }],
      }, undefined, undefined, fakeCtx({})),
    ).rejects.toThrow("modelOutput");
  });
});
