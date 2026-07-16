import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readCodexRuntimeMetadata } from "./codex-transcript.js";

describe("readCodexRuntimeMetadata", () => {
  it("reads only runtime model and provider metadata from a Codex transcript", async () => {
    const directory = await mkdtemp(join(tmpdir(), "glitch-lens-transcript-"));
    const path = join(directory, "session.jsonl");
    await writeFile(path, [
      JSON.stringify({ type: "session_meta", payload: { id: "session-1", model_provider: "provider", base_instructions: { text: "secret conversation content" } } }),
      JSON.stringify({ type: "response_item", payload: { message: "do not retain me" } }),
      JSON.stringify({ type: "turn_context", payload: { model: "provider/model", cwd: "C:/repo" } }),
    ].join("\n"), "utf8");

    await expect(readCodexRuntimeMetadata(path)).resolves.toEqual({
      sessionId: "session-1",
      model: "provider/model",
      provider: "provider",
      source: path,
    });
  });

  it("uses the latest turn context model", async () => {
    const directory = await mkdtemp(join(tmpdir(), "glitch-lens-transcript-"));
    const path = join(directory, "session.jsonl");
    await writeFile(path, [
      JSON.stringify({ type: "session_meta", payload: { id: "session-1", model_provider: "provider" } }),
      JSON.stringify({ type: "turn_context", payload: { model: "provider/old" } }),
      JSON.stringify({ type: "turn_context", payload: { model: "provider/new" } }),
    ].join("\n"), "utf8");

    await expect(readCodexRuntimeMetadata(path)).resolves.toMatchObject({ model: "provider/new" });
  });

  it("fails safely when required private schema fields are absent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "glitch-lens-transcript-"));
    const path = join(directory, "session.jsonl");
    await writeFile(path, JSON.stringify({ type: "response_item", payload: { model: "untrusted" } }), "utf8");

    await expect(readCodexRuntimeMetadata(path)).rejects.toThrow("runtime metadata");
  });
});
