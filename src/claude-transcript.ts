import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export interface ClaudeRuntimeMetadata {
  sessionId: string;
  model: string;
  source: string;
}

interface JsonlEvent {
  type?: unknown;
  sessionId?: unknown;
  message?: unknown;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

/**
 * Reads runtime metadata from a Claude Code session transcript (.jsonl).
 *
 * Unlike Codex transcripts, Claude Code transcripts do not record the API
 * provider, so only fields the transcript can prove are returned: the session
 * id and the model of the most recent assistant message.
 */
export async function readClaudeRuntimeMetadata(path: string): Promise<ClaudeRuntimeMetadata> {
  let sessionId: string | undefined;
  let model: string | undefined;
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let event: JsonlEvent;
      try {
        event = JSON.parse(line) as JsonlEvent;
      } catch {
        continue;
      }
      if (typeof event.sessionId === "string" && event.sessionId) sessionId = event.sessionId;
      if (event.type !== "assistant") continue;
      const message = object(event.message);
      if (typeof message?.model === "string" && message.model) model = message.model;
    }
  } finally {
    lines.close();
    input.destroy();
  }

  if (!sessionId || !model) {
    throw new Error(`Claude Code transcript does not contain required runtime metadata: ${path}`);
  }
  return { sessionId, model, source: path };
}
