import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export interface CodexRuntimeMetadata {
  sessionId: string;
  model: string;
  provider: string;
  source: string;
}

interface JsonlEvent {
  type?: unknown;
  payload?: unknown;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

export async function readCodexRuntimeMetadata(path: string): Promise<CodexRuntimeMetadata> {
  let sessionId: string | undefined;
  let provider: string | undefined;
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
      if (event.type !== "session_meta" && event.type !== "turn_context") continue;
      const payload = object(event.payload);
      if (!payload) continue;
      if (event.type === "session_meta") {
        if (typeof payload.id === "string") sessionId = payload.id;
        if (typeof payload.model_provider === "string") provider = payload.model_provider;
      } else if (typeof payload.model === "string") {
        model = payload.model;
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }

  if (!sessionId || !provider || !model) {
    throw new Error(`Codex transcript does not contain required runtime metadata: ${path}`);
  }
  return { sessionId, model, provider, source: path };
}
