import { createServer, type RequestListener } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import type { DiscoveredCodexConfig } from "./codex.js";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function fixtureCsv(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "glitch-lens-"));
  const path = join(directory, "fingerprints.csv");
  await writeFile(path, "glitch token,model series,error rate@5,isSpecific\nalpha,Vendor A,100,y\n", "utf8");
  return path;
}

async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to start test server");
  return `http://127.0.0.1:${address.port}`;
}

describe("CLI", () => {
  it("reads Claude Code runtime metadata via the claude-runtime command", async () => {
    const directory = await mkdtemp(join(tmpdir(), "glitch-lens-claude-cli-"));
    const transcript = join(directory, "session.jsonl");
    await writeFile(transcript, [
      JSON.stringify({ type: "user", sessionId: "session-9", message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "assistant", sessionId: "session-9", message: { model: "claude-opus-4-6", role: "assistant", content: [] } }),
    ].join("\n"), "utf8");
    const output: string[] = [];
    const code = await runCli(["claude-runtime", "--transcript", transcript], {
      env: {}, stdout: (text: string) => output.push(text), stderr: () => undefined,
    });

    expect(code).toBe(0);
    expect(JSON.parse(output.join(""))).toMatchObject({ sessionId: "session-9", model: "claude-opus-4-6" });
  });

  it("prints discovered Codex configuration without exposing a secret value", async () => {
    const output: string[] = [];
    const discovered: DiscoveredCodexConfig = {
      source: "C:/Users/test/.codex/config.toml",
      scope: "user-base",
      model: "proxy-model",
      provider: "proxy",
      protocol: "openai",
      endpoint: "https://proxy.example.com/v1",
      keyEnv: "PROXY_API_KEY",
      wireApi: "chat",
    };
    const code = await runCli(["discover", "--agent", "codex", "--json"], {
      env: { PROXY_API_KEY: "must-not-leak" },
      stdout: (text: string) => output.push(text),
      stderr: () => undefined,
      discoverCodex: async () => discovered,
    });

    expect(code).toBe(0);
    expect(output.join("")).toContain("PROXY_API_KEY");
    expect(output.join("")).not.toContain("must-not-leak");
    expect(JSON.parse(output.join(""))).toEqual(discovered);
  });

  it("starts and advances a delegated probe through JSON input", async () => {
    const fingerprints = await fixtureCsv();
    const startedOutput: string[] = [];
    const startCode = await runCli(
      ["delegated-start", "--model", "provider/model", "--provider", "provider", "--fingerprints", fingerprints, "--concurrency", "1"],
      { env: {}, stdout: (text: string) => startedOutput.push(text), stderr: () => undefined },
    );
    const started = JSON.parse(startedOutput.join(""));
    expect(startCode).toBe(0);
    expect(started.tasks).toHaveLength(1);

    const input = JSON.stringify({
      state: started.state,
      results: [{
        taskId: started.tasks[0].taskId,
        executionStatus: "completed",
        modelOutput: "wrong",
        actualModel: "provider/model",
        actualProvider: "provider",
      }],
    });
    const advancedOutput: string[] = [];
    const advanceCode = await runCli(["delegated-advance"], {
      env: {},
      stdin: async () => input,
      stdout: (text: string) => advancedOutput.push(text),
      stderr: () => undefined,
    });

    expect(advanceCode).toBe(0);
    expect(JSON.parse(advancedOutput.join(""))).toMatchObject({ done: false, tasks: [{ targetModel: "provider/model" }] });
  });

  it("accepts delegated advance input from a file", async () => {
    const fingerprints = await fixtureCsv();
    const startedOutput: string[] = [];
    await runCli(["delegated-start", "--model", "provider/model", "--fingerprints", fingerprints, "--concurrency", "1"], {
      env: {}, stdout: (text: string) => startedOutput.push(text), stderr: () => undefined,
    });
    const started = JSON.parse(startedOutput.join(""));
    const directory = await mkdtemp(join(tmpdir(), "glitch-lens-input-"));
    const inputPath = join(directory, "advance.json");
    await writeFile(inputPath, JSON.stringify({
      state: started.state,
      results: [{ taskId: started.tasks[0].taskId, executionStatus: "completed", modelOutput: "alpha", actualModel: "provider/model" }],
    }), "utf8");
    const output: string[] = [];
    const code = await runCli(["delegated-advance", "--input", inputPath], {
      env: {}, stdin: async () => { throw new Error("stdin should not be read"); }, stdout: (text: string) => output.push(text), stderr: () => undefined,
    });

    expect(code).toBe(0);
    expect(JSON.parse(output.join(""))).toMatchObject({ done: true, report: { status: "unknown" } });
  });

  it("scans an OpenAI-compatible endpoint and emits JSON", async () => {
    const bodies: unknown[] = [];
    const endpoint = await listen((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        bodies.push(JSON.parse(body));
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ choices: [{ message: { content: "wrong" } }] }));
      });
    });
    const output: string[] = [];
    const code = await runCli(
      ["scan", "--protocol", "openai", "--endpoint", endpoint, "--model", "test-model", "--key-env", "TEST_KEY", "--fingerprints", await fixtureCsv(), "--json"],
      { env: { TEST_KEY: "secret" }, stdout: (text: string) => output.push(text), stderr: () => undefined },
    );

    expect(code).toBe(0);
    expect(JSON.parse(output.join(""))).toMatchObject({ status: "match", candidates: [{ vendor: "Vendor A" }] });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ model: "test-model", messages: [{ role: "user" }] });
  });

  it("uses the OpenAI Responses API request and response shape", async () => {
    const bodies: unknown[] = [];
    const requestPaths: Array<string | undefined> = [];
    const endpoint = await listen((request, response) => {
      requestPaths.push(request.url);
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        bodies.push(JSON.parse(body));
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "alpha" }] }] }));
      });
    });
    const code = await runCli(
      ["scan", "--protocol", "openai-responses", "--endpoint", `${endpoint}/v1`, "--model", "test-model", "--key-env", "TEST_KEY", "--fingerprints", await fixtureCsv(), "--json"],
      { env: { TEST_KEY: "secret" }, stdout: () => undefined, stderr: () => undefined },
    );

    expect(code).toBe(0);
    expect(requestPaths).toEqual(["/v1/responses"]);
    expect(bodies[0]).toMatchObject({ model: "test-model", input: expect.stringContaining("alpha"), max_output_tokens: 256 });
  });

  it("treats an empty Anthropic-compatible content response as a copy failure", async () => {
    let calls = 0;
    const endpoint = await listen((_request, response) => {
      calls += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ content: [] }));
    });
    const output: string[] = [];
    const code = await runCli(
      ["scan", "--protocol", "anthropic", "--endpoint", endpoint, "--model", "test-model", "--key-env", "TEST_KEY", "--fingerprints", await fixtureCsv(), "--json"],
      { env: { TEST_KEY: "secret" }, stdout: (text: string) => output.push(text), stderr: () => undefined },
    );

    expect(code).toBe(0);
    expect(calls).toBe(2);
    expect(JSON.parse(output.join(""))).toMatchObject({
      status: "match",
      evidence: [{ outcome: "copy_failed" }, { outcome: "copy_failed" }],
    });
  });

  it("uses the Anthropic-compatible messages request shape", async () => {
    const bodies: unknown[] = [];
    const endpoint = await listen((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        bodies.push(JSON.parse(body));
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ content: [{ type: "text", text: "alpha" }] }));
      });
    });
    const code = await runCli(
      ["scan", "--protocol", "anthropic", "--endpoint", endpoint, "--model", "test-model", "--key-env", "TEST_KEY", "--fingerprints", await fixtureCsv(), "--json"],
      { env: { TEST_KEY: "secret" }, stdout: () => undefined, stderr: () => undefined },
    );

    expect(code).toBe(0);
    expect(bodies[0]).toMatchObject({ model: "test-model", messages: [{ role: "user" }] });
  });
});
