import type { ProbeResponse } from "./engine.js";

export type Protocol = "openai" | "openai-responses" | "anthropic";

export interface AdapterOptions {
  protocol: Protocol;
  endpoint: string;
  model: string;
  apiKey: string;
  timeoutMs?: number;
}

const prompt = (token: string) => `请原样复制 <target> 标签内的全部文本。\n不得解释、翻译、纠错、补充或省略，只输出标签内文本。\n\n<target>${token}</target>`;

function endpointUrl(base: string, protocol: Protocol): string {
  const url = new URL(base);
  const path = url.pathname.replace(/\/+$/, "");

  if (protocol === "openai") {
    if (!/\/chat\/completions$/.test(path)) {
      url.pathname = /\/v1$/.test(path) ? `${path}/chat/completions` : `${path}/v1/chat/completions`;
    }
  } else if (protocol === "openai-responses") {
    if (!/\/responses$/.test(path)) {
      url.pathname = /\/v1$/.test(path) ? `${path}/responses` : `${path}/v1/responses`;
    }
  } else if (!/\/messages$/.test(path)) {
    url.pathname = /\/v1$/.test(path) ? `${path}/messages` : `${path}/v1/messages`;
  }

  return url.toString();
}

export function createProbeRequester(options: AdapterOptions): (token: string) => Promise<ProbeResponse> {
  return async (token) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);

    try {
      const anthropic = options.protocol === "anthropic";
      const responsesApi = options.protocol === "openai-responses";
      const response = await fetch(endpointUrl(options.endpoint, options.protocol), {
        method: "POST",
        headers: anthropic
          ? {
              "content-type": "application/json",
              "x-api-key": options.apiKey,
              "anthropic-version": "2023-06-01",
            }
          : {
              "content-type": "application/json",
              authorization: `Bearer ${options.apiKey}`,
            },
        body: JSON.stringify(
          responsesApi
            ? { model: options.model, input: prompt(token), max_output_tokens: 256 }
            : {
                model: options.model,
                messages: [{ role: "user", content: prompt(token) }],
                max_tokens: 256,
                ...(anthropic ? {} : { temperature: 0 }),
              },
        ),
        signal: controller.signal,
      });

      if (!response.ok) {
        const details = (await response.text()).slice(0, 500);
        return { kind: "error", message: `HTTP ${response.status}${details ? `: ${details}` : ""}` };
      }

      const body = (await response.json()) as Record<string, unknown>;
      const content = anthropic ? anthropicContent(body) : responsesApi ? responsesContent(body) : openAiContent(body);
      return content === undefined
        ? { kind: "error", message: "Response did not contain assistant text" }
        : { kind: "success", content };
    } catch (error) {
      return {
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timeout);
    }
  };
}

function openAiContent(body: Record<string, unknown>): string | undefined {
  const choices = body.choices;
  if (!Array.isArray(choices)) return undefined;
  const first = choices[0];
  if (!first || typeof first !== "object") return undefined;
  const message = (first as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return undefined;
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" ? content : undefined;
}

function responsesContent(body: Record<string, unknown>): string | undefined {
  if (typeof body.output_text === "string") return body.output_text;
  if (!Array.isArray(body.output)) return undefined;
  return body.output
    .flatMap((item) => (item && typeof item === "object" && Array.isArray((item as Record<string, unknown>).content) ? (item as Record<string, unknown>).content as unknown[] : []))
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .filter((item) => item.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("");
}

function anthropicContent(body: Record<string, unknown>): string | undefined {
  const content = body.content;
  if (!Array.isArray(content)) return undefined;
  return content
    .filter((block): block is Record<string, unknown> => Boolean(block && typeof block === "object"))
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}
