import { describe, expect, it } from "vitest";
import { scan, type Fingerprint, type ProbeResponse } from "./engine.js";

const fingerprints: Fingerprint[] = [
  { token: "alpha", vendor: "Vendor A" },
  { token: "alpha-two", vendor: "Vendor A" },
  { token: "beta", vendor: "Vendor B" },
];

function responder(responses: Record<string, string[]>): (token: string) => Promise<ProbeResponse> {
  const calls = new Map<string, number>();
  return async (token) => {
    const index = calls.get(token) ?? 0;
    calls.set(token, index + 1);
    const values = responses[token] ?? [token];
    return { kind: "success", content: values[Math.min(index, values.length - 1)] ?? token };
  };
}

describe("scan", () => {
  it("confirms a vendor after the same probe fails to copy twice", async () => {
    const result = await scan({
      fingerprints,
      requestProbe: responder({ alpha: ["unrelated", "still unrelated"] }),
    });

    expect(result.status).toBe("match");
    expect(result.candidates.map((candidate) => candidate.vendor)).toEqual(["Vendor A"]);
    expect(result.candidates[0]?.confirmedToken).toBe("alpha");
  });

  it("marks a probe unstable and continues to the next probe", async () => {
    const result = await scan({
      fingerprints,
      requestProbe: responder({
        alpha: ["unrelated", "alpha"],
        "alpha-two": ["wrong", "wrong again"],
      }),
    });

    expect(result.candidates[0]?.confirmedToken).toBe("alpha-two");
    expect(result.evidence.filter((item) => item.token === "alpha").map((item) => item.outcome)).toEqual([
      "copy_failed",
      "copy_success",
    ]);
  });

  it("reports conflicting evidence when multiple vendors are confirmed", async () => {
    const result = await scan({
      fingerprints,
      requestProbe: responder({
        alpha: ["wrong", "wrong"],
        beta: ["wrong", "wrong"],
      }),
    });

    expect(result.status).toBe("conflict");
    expect(result.candidates.map((candidate) => candidate.vendor)).toEqual(["Vendor A", "Vendor B"]);
  });

  it("retries transient request failures without treating them as fingerprint hits", async () => {
    let calls = 0;
    const result = await scan({
      fingerprints: [{ token: "alpha", vendor: "Vendor A" }],
      requestProbe: async () => {
        calls += 1;
        return calls === 1 ? { kind: "error", message: "HTTP 429" } : { kind: "success", content: "alpha" };
      },
    });

    expect(calls).toBe(2);
    expect(result.status).toBe("unknown");
    expect(result.candidates).toEqual([]);
    expect(result.evidence[0]?.outcome).toBe("copy_success");
  });

  it("records a request failure after retries are exhausted", async () => {
    let calls = 0;
    const result = await scan({
      fingerprints: [{ token: "alpha", vendor: "Vendor A" }],
      requestProbe: async () => {
        calls += 1;
        return { kind: "error", message: "HTTP 429" };
      },
    });

    expect(calls).toBe(2);
    expect(result.status).toBe("unknown");
    expect(result.evidence[0]?.outcome).toBe("request_failed");
  });

  it("ignores Unicode whitespace when checking whether a token was copied", async () => {
    const result = await scan({
      fingerprints: [{ token: "abcde", vendor: "Vendor A" }],
      requestProbe: responder({ abcde: ["abc\n de"] }),
    });

    expect(result.status).toBe("unknown");
    expect(result.evidence[0]?.outcome).toBe("copy_success");
  });
});
