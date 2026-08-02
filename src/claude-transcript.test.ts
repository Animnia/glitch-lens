import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readClaudeRuntimeMetadata } from "./claude-transcript.js";

async function fixture(lines: unknown[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "glitch-lens-claude-"));
  const path = join(directory, "session.jsonl");
  await writeFile(path, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n"), "utf8");
  return path;
}

describe("readClaudeRuntimeMetadata", () => {
  it("reads the session id and the latest assistant model from a Claude Code transcript", async () => {
    const path = await fixture([
      { type: "summary", summary: "chat", leafUuid: "u0" },
      { type: "user", sessionId: "session-1", message: { role: "user", content: "hi" }, uuid: "u1" },
      { type: "assistant", sessionId: "session-1", message: { model: "claude-sonnet-4-5", role: "assistant", content: [] }, uuid: "u2" },
    ]);

    await expect(readClaudeRuntimeMetadata(path)).resolves.toEqual({
      sessionId: "session-1",
      model: "claude-sonnet-4-5",
      source: path,
    });
  });

  it("uses the model from the most recent assistant message", async () => {
    const path = await fixture([
      { type: "assistant", sessionId: "s", message: { model: "claude-old" } },
      { type: "user", sessionId: "s", message: { role: "user", content: "switch model" } },
      { type: "assistant", sessionId: "s", message: { model: "claude-new" } },
    ]);

    await expect(readClaudeRuntimeMetadata(path)).resolves.toMatchObject({ model: "claude-new" });
  });

  it("skips unparseable lines and sidechain noise without failing", async () => {
    const path = await fixture([
      "not json at all",
      { type: "progress", sessionId: "s", data: {} },
      { type: "assistant", sessionId: "s", isSidechain: true, message: { model: "claude-haiku" } },
    ]);

    await expect(readClaudeRuntimeMetadata(path)).resolves.toMatchObject({ sessionId: "s", model: "claude-haiku" });
  });

  it("fails safely when no assistant model is present", async () => {
    const path = await fixture([
      { type: "user", sessionId: "s", message: { role: "user", content: "hi" } },
    ]);

    await expect(readClaudeRuntimeMetadata(path)).rejects.toThrow("runtime metadata");
  });
});
