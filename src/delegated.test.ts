import { describe, expect, it } from "vitest";
import { advanceDelegatedRun, startDelegatedRun, type DelegatedTaskResult } from "./delegated.js";
import type { Fingerprint } from "./engine.js";

const fingerprints: Fingerprint[] = [
  { vendor: "Vendor A", token: "alpha" },
  { vendor: "Vendor A", token: "alpha-two" },
  { vendor: "Vendor B", token: "beta" },
];

function completed(taskId: string, modelOutput: string, actualModel = "provider/model"): DelegatedTaskResult {
  return { taskId, executionStatus: "completed", modelOutput, actualModel, actualProvider: "provider" };
}

describe("delegated probe protocol", () => {
  it("starts blinded tasks without vendor labels", () => {
    const round = startDelegatedRun({ fingerprints, targetModel: "provider/model", targetProvider: "provider", concurrency: 2, now: 1_000 });

    expect(round.tasks).toHaveLength(2);
    expect(round.tasks.every((task) => !JSON.stringify(task).includes("Vendor"))).toBe(true);
    expect(round.tasks.every((task) => task.prompt.includes("<target>"))).toBe(true);
    expect(round.state.tasksIssued).toBe(2);
  });

  it("requires two fresh failures before confirming a candidate", () => {
    const first = startDelegatedRun({ fingerprints: [{ vendor: "Vendor A", token: "alpha" }], targetModel: "provider/model", targetProvider: "provider", now: 1_000 });
    const confirmation = advanceDelegatedRun(first.state, [completed(first.tasks[0]!.taskId, "wrong")], { now: 2_000 });

    expect(confirmation.done).toBe(false);
    expect(confirmation.tasks).toHaveLength(1);
    expect(confirmation.tasks[0]!.taskId).not.toBe(first.tasks[0]!.taskId);

    const final = advanceDelegatedRun(confirmation.state, [completed(confirmation.tasks[0]!.taskId, "still wrong")], { now: 3_000 });
    expect(final.done).toBe(true);
    expect(final.report).toMatchObject({ status: "match", candidates: [{ vendor: "Vendor A", confirmedToken: "alpha" }] });
  });

  it("continues to the next token when confirmation succeeds", () => {
    const first = startDelegatedRun({ fingerprints: fingerprints.filter((item) => item.vendor === "Vendor A"), targetModel: "provider/model", targetProvider: "provider", concurrency: 1, now: 1_000 });
    const confirmation = advanceDelegatedRun(first.state, [completed(first.tasks[0]!.taskId, "wrong")], { now: 2_000 });
    const next = advanceDelegatedRun(confirmation.state, [completed(confirmation.tasks[0]!.taskId, "alpha")], { now: 3_000 });

    expect(next.tasks).toHaveLength(1);
    expect(next.tasks[0]!.prompt).toContain("alpha-two");
    expect(next.state.evidence.map((item) => item.outcome)).toEqual(["copy_failed", "copy_success"]);
  });

  it("retries execution failure once and never treats it as a copy failure", () => {
    const first = startDelegatedRun({ fingerprints: [{ vendor: "Vendor A", token: "alpha" }], targetModel: "provider/model", targetProvider: "provider", now: 1_000 });
    const retry = advanceDelegatedRun(first.state, [{ taskId: first.tasks[0]!.taskId, executionStatus: "failed", error: "timeout" }], { now: 2_000 });

    expect(retry.tasks).toHaveLength(1);
    const final = advanceDelegatedRun(retry.state, [{ taskId: retry.tasks[0]!.taskId, executionStatus: "failed", error: "timeout" }], { now: 3_000 });
    expect(final.done).toBe(true);
    expect(final.report).toMatchObject({ status: "unknown", coverage: { inconclusiveVendors: 1 } });
    expect(final.state.evidence.every((item) => item.outcome === "execution_failed")).toBe(true);
  });

  it("rejects a model mismatch and preserves completed empty output as a copy failure", () => {
    const first = startDelegatedRun({ fingerprints: [{ vendor: "Vendor A", token: "alpha" }], targetModel: "provider/model", targetProvider: "provider", now: 1_000 });
    const retry = advanceDelegatedRun(first.state, [completed(first.tasks[0]!.taskId, "", "other/model")], { now: 2_000 });
    expect(retry.state.evidence[0]?.outcome).toBe("model_mismatch");

    const confirmation = advanceDelegatedRun(retry.state, [completed(retry.tasks[0]!.taskId, "")], { now: 3_000 });
    expect(confirmation.state.evidence.at(-1)?.outcome).toBe("copy_failed");
    expect(confirmation.tasks).toHaveLength(1);
  });

  it("stops at the task or time budget and reports coverage", () => {
    const first = startDelegatedRun({ fingerprints, targetModel: "provider/model", targetProvider: "provider", concurrency: 2, maxTasks: 2, maxDurationMs: 1_000, now: 1_000 });
    const final = advanceDelegatedRun(first.state, first.tasks.map((task) => completed(task.taskId, "wrong")), { now: 2_001 });

    expect(final.done).toBe(true);
    expect(final.tasks).toEqual([]);
    expect(final.report?.stopReason).toBe("time_limit");
    expect(final.report?.coverage.totalVendors).toBe(2);
  });
});
