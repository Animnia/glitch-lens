import { randomUUID } from "node:crypto";
import type { Fingerprint } from "./engine.js";

const whitespacePattern = /\p{White_Space}/gu;
export const DELEGATED_MAX_TASKS = 24;
export const DELEGATED_MAX_DURATION_MS = 15 * 60_000;

export type DelegatedExecutionStatus = "completed" | "failed";
export type DelegatedEvidenceOutcome =
  | "copy_success"
  | "copy_failed"
  | "execution_failed"
  | "model_mismatch"
  | "model_unverified"
  | "provider_mismatch"
  | "time_limit";

export type DelegatedTaskResult =
  | {
      taskId: string;
      executionStatus: "completed";
      modelOutput: string;
      actualModel?: string;
      actualProvider?: string;
    }
  | {
      taskId: string;
      executionStatus: "failed";
      error: string;
    };

export interface DelegatedTask {
  taskId: string;
  prompt: string;
  targetModel: string;
}

interface VendorRunState {
  vendor: string;
  tokens: string[];
  tokenIndex: number;
  phase: "probe" | "confirmation" | "done";
  executionRetries: number;
  validProbes: number;
  unavailableProbes: number;
  candidateToken?: string;
}

interface PendingTask {
  taskId: string;
  vendor: string;
  token: string;
  phase: "probe" | "confirmation";
}

export interface DelegatedEvidence {
  vendor: string;
  token: string;
  phase: "probe" | "confirmation";
  outcome: DelegatedEvidenceOutcome;
  error?: string;
  actualModel?: string;
  actualProvider?: string;
  providerVerified?: boolean;
}

export interface DelegatedRunState {
  version: 1;
  runId: string;
  startedAt: number;
  targetModel: string;
  targetProvider?: string;
  concurrency: number;
  maxTasks: number;
  maxDurationMs: number;
  tasksIssued: number;
  vendors: VendorRunState[];
  pending: PendingTask[];
  evidence: DelegatedEvidence[];
}

export interface DelegatedCoverage {
  totalVendors: number;
  completeVendors: number;
  inconclusiveVendors: number;
  pendingVendors: number;
}

export interface DelegatedReport {
  channel: "delegated";
  confidenceClass: "experimental-context-contaminated";
  status: "match" | "conflict" | "unknown";
  candidates: Array<{ vendor: string; confirmedToken: string }>;
  coverage: DelegatedCoverage;
  tasksIssued: number;
  stopReason: "completed" | "task_limit" | "time_limit";
}

export interface DelegatedRound {
  done: boolean;
  state: DelegatedRunState;
  tasks: DelegatedTask[];
  report?: DelegatedReport;
}

export interface StartDelegatedOptions {
  fingerprints: Fingerprint[];
  targetModel: string;
  targetProvider?: string;
  concurrency?: number;
  maxTasks?: number;
  maxDurationMs?: number;
  now?: number;
}

function compact(value: string): string {
  return value.normalize("NFC").replace(whitespacePattern, "");
}

function copiedToken(output: string, token: string): boolean {
  return compact(output).includes(compact(token));
}

function promptFor(token: string): string {
  return `请原样复制 <target> 标签内的全部文本。\n不得解释、翻译、纠错、补充或省略，只输出标签内文本。\n\n<target>${token}</target>`;
}

function namespacedModel(model: string): boolean {
  const [namespace, name, ...rest] = model.split("/");
  return Boolean(namespace && name && rest.length === 0);
}

function taskView(task: PendingTask, targetModel: string): DelegatedTask {
  return { taskId: task.taskId, prompt: promptFor(task.token), targetModel };
}

function groupedVendors(fingerprints: Fingerprint[]): VendorRunState[] {
  const groups = new Map<string, string[]>();
  for (const fingerprint of fingerprints) {
    const tokens = groups.get(fingerprint.vendor) ?? [];
    tokens.push(fingerprint.token);
    groups.set(fingerprint.vendor, tokens);
  }
  return [...groups.entries()].map(([vendor, tokens]) => ({
    vendor,
    tokens,
    tokenIndex: 0,
    phase: "probe",
    executionRetries: 0,
    validProbes: 0,
    unavailableProbes: 0,
  }));
}

function nextTaskFor(vendor: VendorRunState): PendingTask | undefined {
  if (vendor.phase === "done") return undefined;
  const token = vendor.tokens[vendor.tokenIndex];
  if (!token) {
    vendor.phase = "done";
    return undefined;
  }
  return { taskId: randomUUID(), vendor: vendor.vendor, token, phase: vendor.phase };
}

function schedule(state: DelegatedRunState): DelegatedTask[] {
  const newTasks: PendingTask[] = [];
  const occupied = new Set(state.pending.map((task) => task.vendor));
  const slots = Math.min(state.concurrency - state.pending.length, state.maxTasks - state.tasksIssued);
  if (slots <= 0) return [];

  const candidates = state.vendors
    .filter((vendor) => !occupied.has(vendor.vendor) && vendor.phase !== "done")
    .sort((left, right) => {
      const priority = (vendor: VendorRunState) => vendor.executionRetries > 0 ? 0 : vendor.phase === "confirmation" ? 1 : vendor.tokenIndex > 0 ? 2 : 3;
      return priority(left) - priority(right);
    });

  for (const vendor of candidates.slice(0, slots)) {
    const task = nextTaskFor(vendor);
    if (task) newTasks.push(task);
  }
  state.pending.push(...newTasks);
  state.tasksIssued += newTasks.length;
  return newTasks.map((task) => taskView(task, state.targetModel));
}

function executionProblem(
  state: DelegatedRunState,
  vendor: VendorRunState,
  task: PendingTask,
  outcome: DelegatedEvidenceOutcome,
  details: Partial<DelegatedEvidence>,
): void {
  state.evidence.push({ vendor: vendor.vendor, token: task.token, phase: task.phase, outcome, ...details });
  if (vendor.executionRetries < 1) {
    vendor.executionRetries += 1;
    return;
  }
  vendor.executionRetries = 0;
  vendor.unavailableProbes += 1;
  if (vendor.phase === "confirmation") vendor.phase = "probe";
  vendor.tokenIndex += 1;
  if (vendor.tokenIndex >= vendor.tokens.length) vendor.phase = "done";
}

function processResult(state: DelegatedRunState, task: PendingTask, result: DelegatedTaskResult): void {
  const vendor = state.vendors.find((item) => item.vendor === task.vendor);
  if (!vendor || vendor.phase === "done") return;

  if (result.executionStatus === "failed") {
    executionProblem(state, vendor, task, "execution_failed", { error: result.error });
    return;
  }
  if (!result.actualModel) {
    executionProblem(state, vendor, task, "model_unverified", {});
    return;
  }
  if (result.actualModel !== state.targetModel) {
    executionProblem(state, vendor, task, "model_mismatch", { actualModel: result.actualModel });
    return;
  }
  if (state.targetProvider && result.actualProvider && result.actualProvider !== state.targetProvider) {
    executionProblem(state, vendor, task, "provider_mismatch", {
      actualModel: result.actualModel,
      actualProvider: result.actualProvider,
    });
    return;
  }

  vendor.executionRetries = 0;
  vendor.validProbes += 1;
  const copied = copiedToken(result.modelOutput, task.token);
  state.evidence.push({
    vendor: vendor.vendor,
    token: task.token,
    phase: task.phase,
    outcome: copied ? "copy_success" : "copy_failed",
    actualModel: result.actualModel,
    ...(result.actualProvider ? { actualProvider: result.actualProvider } : {}),
    providerVerified: Boolean(result.actualProvider === state.targetProvider || namespacedModel(state.targetModel)),
  });

  if (task.phase === "probe" && !copied) {
    vendor.phase = "confirmation";
    return;
  }
  if (task.phase === "confirmation" && !copied) {
    vendor.candidateToken = task.token;
    vendor.phase = "done";
    return;
  }

  vendor.phase = "probe";
  vendor.tokenIndex += 1;
  if (vendor.tokenIndex >= vendor.tokens.length) vendor.phase = "done";
}

function coverage(state: DelegatedRunState): DelegatedCoverage {
  const completeVendors = state.vendors.filter((vendor) => vendor.phase === "done" && (vendor.validProbes > 0 || Boolean(vendor.candidateToken))).length;
  const inconclusiveVendors = state.vendors.filter((vendor) => vendor.phase === "done" && vendor.validProbes === 0 && !vendor.candidateToken).length;
  return {
    totalVendors: state.vendors.length,
    completeVendors,
    inconclusiveVendors,
    pendingVendors: state.vendors.length - completeVendors - inconclusiveVendors,
  };
}

function report(state: DelegatedRunState, stopReason: DelegatedReport["stopReason"]): DelegatedReport {
  const candidates = state.vendors.flatMap((vendor) => vendor.candidateToken ? [{ vendor: vendor.vendor, confirmedToken: vendor.candidateToken }] : []);
  return {
    channel: "delegated",
    confidenceClass: "experimental-context-contaminated",
    status: candidates.length === 0 ? "unknown" : candidates.length === 1 ? "match" : "conflict",
    candidates,
    coverage: coverage(state),
    tasksIssued: state.tasksIssued,
    stopReason,
  };
}

function validateState(state: DelegatedRunState): void {
  if (!state || state.version !== 1) throw new Error(`Unsupported delegated state version: ${String(state?.version)}`);
  if (typeof state.runId !== "string" || typeof state.targetModel !== "string") throw new Error("Invalid delegated state identity");
  if (!Number.isFinite(state.startedAt) || !Number.isInteger(state.tasksIssued) || state.tasksIssued < 0) throw new Error("Invalid delegated state counters");
  if (!Number.isInteger(state.concurrency) || state.concurrency < 1 || state.concurrency > 8) throw new Error("Invalid delegated concurrency");
  if (!Number.isFinite(state.maxTasks) || !Number.isFinite(state.maxDurationMs)) throw new Error("Invalid delegated budget");
  if (!Array.isArray(state.vendors) || !Array.isArray(state.pending) || !Array.isArray(state.evidence)) throw new Error("Invalid delegated state collections");
  const vendorNames = new Set(state.vendors.map((vendor) => vendor.vendor));
  if (vendorNames.size !== state.vendors.length || state.vendors.some((vendor) => typeof vendor.vendor !== "string" || !Array.isArray(vendor.tokens) || vendor.tokens.length === 0)) {
    throw new Error("Invalid delegated vendor state");
  }
  if (state.pending.some((task) => typeof task.taskId !== "string" || !vendorNames.has(task.vendor) || typeof task.token !== "string")) {
    throw new Error("Invalid delegated pending task");
  }
}

export function startDelegatedRun(options: StartDelegatedOptions): DelegatedRound {
  const concurrency = options.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("concurrency must be an integer from 1 to 8");
  const state: DelegatedRunState = {
    version: 1,
    runId: randomUUID(),
    startedAt: options.now ?? Date.now(),
    targetModel: options.targetModel,
    ...(options.targetProvider ? { targetProvider: options.targetProvider } : {}),
    concurrency,
    maxTasks: Math.min(options.maxTasks ?? DELEGATED_MAX_TASKS, DELEGATED_MAX_TASKS),
    maxDurationMs: Math.min(options.maxDurationMs ?? DELEGATED_MAX_DURATION_MS, DELEGATED_MAX_DURATION_MS),
    tasksIssued: 0,
    vendors: groupedVendors(options.fingerprints),
    pending: [],
    evidence: [],
  };
  if (state.vendors.length === 0) throw new Error("At least one fingerprint is required");
  return { done: false, state, tasks: schedule(state) };
}

export function advanceDelegatedRun(
  state: DelegatedRunState,
  results: DelegatedTaskResult[],
  options: { now?: number } = {},
): DelegatedRound {
  validateState(state);
  state.maxTasks = Math.min(state.maxTasks, DELEGATED_MAX_TASKS);
  state.maxDurationMs = Math.min(state.maxDurationMs, DELEGATED_MAX_DURATION_MS);
  const pendingById = new Map(state.pending.map((task) => [task.taskId, task]));
  const seen = new Set<string>();
  for (const result of results) {
    if (seen.has(result.taskId)) throw new Error(`Duplicate task result: ${result.taskId}`);
    seen.add(result.taskId);
    const task = pendingById.get(result.taskId);
    if (!task) throw new Error(`Unknown or stale taskId: ${result.taskId}`);
    processResult(state, task, result);
    pendingById.delete(result.taskId);
  }
  state.pending = [...pendingById.values()];

  const now = options.now ?? Date.now();
  const timedOut = now - state.startedAt > state.maxDurationMs;
  const allDone = state.vendors.every((vendor) => vendor.phase === "done") && state.pending.length === 0;
  const taskLimited = state.tasksIssued >= state.maxTasks && state.pending.length === 0;
  if (timedOut || allDone || taskLimited) {
    if (timedOut) {
      for (const task of state.pending) {
        state.evidence.push({ vendor: task.vendor, token: task.token, phase: task.phase, outcome: "time_limit" });
      }
    }
    state.pending = [];
    const stopReason = timedOut ? "time_limit" : taskLimited && !allDone ? "task_limit" : "completed";
    return { done: true, state, tasks: [], report: report(state, stopReason) };
  }

  const tasks = schedule(state);
  const noMoreWork = tasks.length === 0 && state.pending.length === 0;
  if (noMoreWork) return { done: true, state, tasks: [], report: report(state, "task_limit") };
  return { done: false, state, tasks };
}
