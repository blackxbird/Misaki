import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  createRunId,
  FileLockedError,
  isRunId,
  readSwarm,
  RUN_ID_PATTERN,
  validateRecoveryPhrase,
  WALLET_NAME_PATTERN,
  withFileLock,
  writeJsonAtomic,
  type AgentProfile,
  type WalletStore,
} from "@vapi-network/core";
import { z } from "zod";

import {
  assessSwarmMembers,
  memberBudgetAtomic,
  selectLead,
  SwarmRunError,
  type SwarmRunResult,
} from "./swarm-run.js";
import type { RunAgentResult } from "./run.js";

export type RuntimeKind = "local" | "railway";

export type RuntimeMember = {
  swarm?: string;
  account: string;
  profile: string;
  role?: string;
};

export type RuntimeRun = {
  runId: string;
  task: string;
  mode: "agent" | "lead";
  budgetUsd?: string;
  drawUsd?: string;
  parentRunId?: string;
};

export type RuntimeHandle = {
  runId: string;
  kind: RuntimeKind;
  member: RuntimeMember;
  startedAt: string;
  /** Adapter-specific process or sandbox reference. It must never contain a secret. */
  ref: string;
  /** Original creation scope, when returned by Railway; never today's linked scope. */
  railwayScope?: { projectId?: string; environmentId?: string };
};

export type RuntimeStatus = {
  state: "running" | "finished" | "failed" | "stopped" | "unknown";
  /** Adapters may return unknown parsed result-file content. */
  result?: RunAgentResult | SwarmRunResult | unknown;
  exitCode?: number;
  detail?: string;
};

export interface Runtime {
  kind: RuntimeKind;
  /** An adapter-owned unresolved start that must block another member worker. */
  busy?(member: RuntimeMember): Promise<{ runId: string; detail: string } | undefined>;
  start(
    member: RuntimeMember,
    run: RuntimeRun,
    /** Persist this reference before the adapter continues a multi-step launch. */
    persistLaunch?: (handle: RuntimeHandle) => Promise<void>,
  ): Promise<RuntimeHandle>;
  /** Recover an adapter-owned reference after the launcher crashed before saving it. */
  recover?(record: RunRecord): Promise<RuntimeHandle | undefined>;
  /** Retire this exact adapter-owned start after the owner confirms its worker is gone. */
  retireUnreconciledStart?(record: RunRecord): Promise<void>;
  stop(handle: RuntimeHandle, options?: { requireSuccessfulExit: true }): Promise<void>;
  status(handle: RuntimeHandle): Promise<RuntimeStatus>;
}

export type RunState = RuntimeStatus["state"] | "starting" | "orphaned" | "forgotten";

export class RuntimeError extends Error {
  readonly name = "RuntimeError";

  constructor(
    readonly code: "member_busy" | "runtime_unavailable" | "run_not_found" | "invalid_run_id",
    message: string,
  ) {
    super(message);
  }
}

export type RunRecord = {
  v: 1;
  runId: string;
  kind: RuntimeKind;
  member: RuntimeMember;
  run: RuntimeRun;
  handle: RuntimeHandle;
  startedAt: string;
  endedAt?: string;
  state: RunState;
  exitCode?: number;
  resultPath?: string;
  detail?: string;
  forgottenAt?: string;
  confirmedBy?: "cli";
};

/** A normal adapter launch should have produced a durable reference well before this bound. */
export const STARTING_RECONCILIATION_TIMEOUT_MS = 5 * 60 * 1_000;

const runIdSchema = z.string().regex(RUN_ID_PATTERN);
const runtimeKindSchema = z.enum(["local", "railway"]);
const runtimeMemberSchema: z.ZodType<RuntimeMember> = z.strictObject({
  swarm: z.string().optional(),
  account: z.string(),
  profile: z.string(),
  role: z.string().optional(),
});
const runtimeRunSchema: z.ZodType<RuntimeRun> = z.strictObject({
  runId: runIdSchema,
  task: z.string(),
  mode: z.enum(["agent", "lead"]),
  budgetUsd: z.string().optional(),
  drawUsd: z.string().optional(),
  parentRunId: runIdSchema.optional(),
});
const runtimeHandleSchema: z.ZodType<RuntimeHandle> = z.strictObject({
  runId: runIdSchema,
  kind: runtimeKindSchema,
  member: runtimeMemberSchema,
  startedAt: z.iso.datetime(),
  ref: z.string(),
  railwayScope: z
    .strictObject({
      projectId: z.string().min(1).optional(),
      environmentId: z.string().min(1).optional(),
    })
    .optional(),
});

export const runRecordSchema: z.ZodType<RunRecord> = z
  .strictObject({
    v: z.literal(1),
    runId: runIdSchema,
    kind: runtimeKindSchema,
    member: runtimeMemberSchema,
    run: runtimeRunSchema,
    handle: runtimeHandleSchema,
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime().optional(),
    state: z.enum([
      "starting",
      "running",
      "finished",
      "failed",
      "stopped",
      "unknown",
      "orphaned",
      "forgotten",
    ]),
    exitCode: z.number().int().optional(),
    resultPath: z.string().optional(),
    detail: z.string().optional(),
    forgottenAt: z.iso.datetime().optional(),
    confirmedBy: z.literal("cli").optional(),
  })
  .refine(
    (record) =>
      record.state !== "forgotten" ||
      (record.forgottenAt !== undefined && record.confirmedBy === "cli"),
    {
      message: "A forgotten run requires a timestamp and explicit CLI confirmation.",
    },
  );

export function runsDirectory(home: string): string {
  return join(home, "runs");
}

export function runRecordPath(home: string, runId: string): string {
  assertRunId(runId);
  return join(runsDirectory(home), `${runId}.json`);
}

export function runLogPath(home: string, runId: string): string {
  assertRunId(runId);
  return join(runsDirectory(home), `${runId}.log`);
}

export function runResultPath(home: string, runId: string): string {
  assertRunId(runId);
  return join(runsDirectory(home), `${runId}.result.json`);
}

export async function writeRunRecord(home: string, record: RunRecord): Promise<void> {
  const path = runRecordPath(home, record.runId);
  const parsed = runRecordSchema.parse(record);
  await mkdir(runsDirectory(home), { recursive: true, mode: 0o700 });
  await writeJsonAtomic(path, parsed, { mode: 0o600 });
}

export async function readRunRecord(home: string, runId: string): Promise<RunRecord | undefined> {
  const path = runRecordPath(home, runId);
  try {
    return runRecordSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

export async function listRunRecords(
  home: string,
  filter: { swarm?: string; account?: string } = {},
): Promise<RunRecord[]> {
  let files: string[];
  try {
    files = await readdir(runsDirectory(home));
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }

  const records: RunRecord[] = [];
  for (const file of files) {
    const match = /^(run_[0-9a-f]{24})\.json$/u.exec(file);
    if (match === null) continue;
    try {
      const record = runRecordSchema.parse(
        JSON.parse(await readFile(join(runsDirectory(home), file), "utf8")),
      );
      if (record.runId !== match[1]) continue;
      if (filter.swarm !== undefined && record.member.swarm !== filter.swarm) continue;
      if (filter.account !== undefined && record.member.account !== filter.account) continue;
      records.push(record);
    } catch {
      // A partial, stale, or manually edited record must not break registry listing.
    }
  }
  records.sort(
    (left, right) =>
      left.startedAt.localeCompare(right.startedAt) || left.runId.localeCompare(right.runId),
  );
  return records;
}

export async function refreshRunRecord(
  home: string,
  record: RunRecord,
  runtime?: Runtime,
  now: () => Date = () => new Date(),
): Promise<RunRecord> {
  const candidate = await requireRunRecord(home, record.runId);
  return await withMemberRunLock(
    home,
    candidate.member.account,
    async () => await refreshRunRecordLocked(home, candidate, runtime, now),
  );
}

/** The caller already holds this record's member lock (start, stop or refresh). */
async function refreshRunRecordLocked(
  home: string,
  observed: RunRecord,
  runtime?: Runtime,
  now: () => Date = () => new Date(),
): Promise<RunRecord> {
  const record = await requireRunRecord(home, observed.runId);
  if (record.member.account !== observed.member.account) {
    throw new RuntimeError(
      "runtime_unavailable",
      `Run ${record.runId} changed members while waiting for its lock.`,
    );
  }
  if (
    (record.state !== "starting" && record.state !== "running") ||
    runtime?.kind !== record.kind
  ) {
    return record;
  }

  let current = record;
  if (current.state === "starting" && current.handle.ref === "") {
    let recovered: RuntimeHandle | undefined;
    try {
      recovered = await runtime.recover?.(current);
    } catch {
      // A stale record gets an actionable, fail-closed message below.
    }
    if (recovered !== undefined) {
      assertRecoveredHandle(current, recovered);
      current = { ...current, handle: recovered, startedAt: recovered.startedAt };
      await writeRunRecord(home, current);
    } else if (
      now().getTime() - Date.parse(current.startedAt) >=
      STARTING_RECONCILIATION_TIMEOUT_MS
    ) {
      const detail = startingRecoveryDetail(current);
      if (current.detail !== detail) {
        current = { ...current, detail };
        await writeRunRecord(home, current);
      }
      return current;
    } else {
      return current;
    }
  }

  let status: RuntimeStatus;
  try {
    status = await runtime.status(current.handle);
  } catch {
    return current;
  }
  const state: RunState =
    current.state === "starting" && status.state === "unknown" ? "starting" : status.state;
  const statusDetail =
    status.detail === undefined ? undefined : redactRunText(status.detail, process.env);
  const detail =
    current.state === "starting" && status.state === "unknown"
      ? `${statusDetail ?? "Worker status is unknown"}. ${startingStopInstruction(current)}`
      : statusDetail;
  if (state === current.state && detail === current.detail) return current;

  const updated: RunRecord = {
    ...current,
    state,
    ...(state === "starting" || state === "running" ? {} : { endedAt: now().toISOString() }),
    ...(status.exitCode === undefined ? {} : { exitCode: status.exitCode }),
    ...(status.result === undefined ? {} : { resultPath: runResultPath(home, record.runId) }),
    ...(detail === undefined ? {} : { detail }),
  };
  await writeRunRecord(home, updated);
  return updated;
}

function assertRecoveredHandle(record: RunRecord, handle: RuntimeHandle): void {
  runtimeHandleSchema.parse(handle);
  if (
    handle.runId !== record.runId ||
    handle.kind !== record.kind ||
    handle.member.account !== record.member.account ||
    handle.member.swarm !== record.member.swarm
  ) {
    throw new Error(`Runtime ${record.kind} returned a mismatched handle for ${record.runId}.`);
  }
}

function startingRecoveryDetail(record: RunRecord): string {
  return `Launch reference is still unavailable. ${unreconciledStartInstruction(record)}`;
}

function startingStopInstruction(record: RunRecord): string {
  return record.member.swarm === undefined
    ? `Confirm the worker for ${record.runId} is stopped before removing the run record.`
    : `Run vapi swarm stop ${record.member.swarm} ${record.runId}.`;
}

function unreconciledStartInstruction(record: RunRecord): string {
  return record.member.swarm === undefined
    ? `Confirm the worker for ${record.runId} is stopped before removing the run record.`
    : `Confirm the worker is stopped, then run vapi swarm stop ${record.member.swarm} ${record.runId} --confirm-worker-stopped.`;
}

export async function startDetachedRun(args: {
  home: string;
  runtime: Runtime;
  member: RuntimeMember;
  run: RuntimeRun;
  now?: () => Date;
  /** Environment whose secret-named values are scrubbed from the stored task. */
  env?: NodeJS.ProcessEnv;
}): Promise<RunRecord> {
  assertRunId(args.run.runId);
  runtimeMemberSchema.parse(args.member);
  runtimeRunSchema.parse(args.run);
  if (!WALLET_NAME_PATTERN.test(args.member.account)) {
    throw new Error(`Invalid runtime member account: ${args.member.account}.`);
  }
  await mkdir(runsDirectory(args.home), { recursive: true, mode: 0o700 });
  const lockPath = memberRunLockPath(args.home, args.member.account);
  const busyMessage = `Member ${args.member.account} is already starting a run.`;
  try {
    return await withFileLock(
      lockPath,
      async () => {
        const records = await listRunRecords(args.home, { account: args.member.account });
        for (const record of records) {
          const refreshed = await refreshRunRecordLocked(args.home, record, args.runtime, args.now);
          if (refreshed.state === "starting" || refreshed.state === "running") {
            throw new RuntimeError(
              "member_busy",
              `Member ${args.member.account} already has ${refreshed.state} run ${refreshed.runId}.${refreshed.detail === undefined ? "" : ` ${refreshed.detail}`}`,
            );
          }
        }

        const adapterBusy = await args.runtime.busy?.(args.member);
        if (adapterBusy !== undefined) {
          throw new RuntimeError(
            "member_busy",
            `Member ${args.member.account} is busy with unresolved run ${adapterBusy.runId}: ${adapterBusy.detail}`,
          );
        }

        // The runtime receives the task exactly as given, so a detached run does what an attached
        // run would; only the stored copy is scrubbed.
        const startedAt = (args.now?.() ?? new Date()).toISOString();
        let reservation: RunRecord = {
          v: 1,
          runId: args.run.runId,
          kind: args.runtime.kind,
          member: args.member,
          run: { ...args.run, task: redactRunText(args.run.task, args.env ?? process.env) },
          handle: {
            runId: args.run.runId,
            kind: args.runtime.kind,
            member: args.member,
            startedAt,
            ref: "",
          },
          startedAt,
          state: "starting",
        };
        await writeRunRecord(args.home, reservation);
        let handle: RuntimeHandle;
        try {
          handle = await args.runtime.start(args.member, args.run, async (launched) => {
            assertRecoveredHandle(reservation, launched);
            reservation = {
              ...reservation,
              handle: launched,
              startedAt: launched.startedAt,
            };
            await writeRunRecord(args.home, reservation);
          });
        } catch (error) {
          await rm(runRecordPath(args.home, args.run.runId), { force: true }).catch(
            () => undefined,
          );
          throw error;
        }
        const record: RunRecord = {
          ...reservation,
          handle,
          startedAt: handle.startedAt,
          state: "running",
        };
        try {
          await writeRunRecord(args.home, record);
        } catch (error) {
          const stopped = await args.runtime.stop(handle).then(
            () => true,
            () => false,
          );
          if (stopped) {
            await rm(runRecordPath(args.home, args.run.runId), { force: true }).catch(
              () => undefined,
            );
          }
          throw error;
        }
        return record;
      },
      { timeoutMs: 5_000, lockedMessage: busyMessage },
    );
  } catch (error) {
    if (error instanceof FileLockedError) throw new RuntimeError("member_busy", busyMessage);
    throw error;
  }
}

const SECRET_ENVIRONMENT_NAME =
  /(?:^|_)(?:KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|PHRASE|DEVICE_CODE)$/iu;
const MINIMUM_ENVIRONMENT_SECRET_LENGTH = 8;

/**
 * Scrubs credentials from text that a detached run stores (registry task, result file, log).
 * It removes the values of secret-named environment variables and structurally recognisable
 * secrets (private keys, vAPI API keys, bearer tokens, recovery phrases), and nothing else, so
 * ordinary words and result fields stay intact.
 */
export function redactRunText(value: string, env: NodeJS.ProcessEnv = {}): string {
  let redacted = value;
  for (const [name, secret] of Object.entries(env)) {
    if (
      secret !== undefined &&
      secret.length >= MINIMUM_ENVIRONMENT_SECRET_LENGTH &&
      SECRET_ENVIRONMENT_NAME.test(name)
    ) {
      redacted = redacted.replaceAll(secret, "[redacted]");
    }
  }
  return redactRecoveryPhrases(
    redacted
      .replace(/\b0x[0-9a-fA-F]{64}\b/gu, "[redacted private key]")
      .replace(/\bvapi_sk_[A-Za-z0-9_-]{16,128}\b/gu, "[redacted API key]")
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [redacted]"),
  );
}

/** Checks every overlapping 24-word and 12-word window, longest first. */
function redactRecoveryPhrases(value: string): string {
  const words = [...value.matchAll(/\b[a-z]+\b/giu)];
  const matches: Array<{ start: number; end: number }> = [];
  for (const length of [24, 12]) {
    for (let start = 0; start + length <= words.length; start += 1) {
      const window = words.slice(start, start + length);
      const candidate = window.map((word) => word[0]).join(" ");
      try {
        validateRecoveryPhrase(candidate);
        const from = window[0]!.index!;
        const last = window.at(-1)!;
        const to = last.index! + last[0].length;
        if (!matches.some((match) => from < match.end && to > match.start)) {
          matches.push({ start: from, end: to });
        }
      } catch {
        // This word window is ordinary prose.
      }
    }
  }
  return matches
    .sort((left, right) => right.start - left.start)
    .reduce(
      (text, match) =>
        `${text.slice(0, match.start)}[redacted recovery phrase]${text.slice(match.end)}`,
      value,
    );
}

/** Applies {@link redactRunText} to every string value; object keys and other values are kept. */
export function redactRunValue<T>(value: T, env: NodeJS.ProcessEnv = {}): T {
  if (typeof value === "string") return redactRunText(value, env) as T;
  if (Array.isArray(value)) return value.map((item) => redactRunValue(item, env)) as T;
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactRunValue(item, env)]),
  ) as T;
}

export async function stopRun(args: {
  home: string;
  runtime: Runtime;
  record: RunRecord;
  now?: () => Date;
  confirmWorkerStopped?: boolean;
}): Promise<RunRecord> {
  const candidate = await readRunRecord(args.home, args.record.runId);
  if (candidate === undefined) {
    throw new RuntimeError("run_not_found", `Run ${args.record.runId} was not found.`);
  }
  if (!WALLET_NAME_PATTERN.test(candidate.member.account)) {
    throw new RuntimeError(
      "runtime_unavailable",
      `Run ${candidate.runId} has an invalid member account.`,
    );
  }
  const busyMessage = `Member ${candidate.member.account} is changing run state.`;
  try {
    return await withFileLock(
      memberRunLockPath(args.home, candidate.member.account),
      async () => {
        const stored = await readRunRecord(args.home, args.record.runId);
        if (stored === undefined) {
          throw new RuntimeError("run_not_found", `Run ${args.record.runId} was not found.`);
        }
        if (stored.member.account !== candidate.member.account) {
          throw new RuntimeError(
            "runtime_unavailable",
            `Run ${stored.runId} changed members while waiting for its lock.`,
          );
        }
        const current = await refreshRunRecordLocked(args.home, stored, args.runtime, args.now);
        if (
          current.state !== "starting" &&
          current.state !== "running" &&
          current.state !== "unknown"
        )
          return current;
        if (args.runtime.kind !== current.kind) {
          throw new RuntimeError(
            "runtime_unavailable",
            `Runtime ${current.kind} is unavailable for run ${current.runId}.`,
          );
        }

        if (current.handle.ref === "") {
          if (
            args.confirmWorkerStopped !== true ||
            current.state !== "starting" ||
            current.detail !== startingRecoveryDetail(current)
          ) {
            throw new RuntimeError(
              "runtime_unavailable",
              `Run ${current.runId} has no recoverable launch reference. ${unreconciledStartInstruction(current)}`,
            );
          }
          await args.runtime.retireUnreconciledStart?.(current);
        } else {
          if (current.kind === "railway" && current.state === "unknown") {
            await args.runtime.stop(current.handle, { requireSuccessfulExit: true });
          } else {
            await args.runtime.stop(current.handle);
          }
        }
        const stopped: RunRecord = {
          ...current,
          state: "stopped",
          endedAt: (args.now?.() ?? new Date()).toISOString(),
        };
        await writeRunRecord(args.home, stopped);
        return stopped;
      },
      { timeoutMs: 5_000, lockedMessage: busyMessage },
    );
  } catch (error) {
    if (error instanceof FileLockedError) throw new RuntimeError("member_busy", busyMessage);
    throw error;
  }
}

function memberRunLockPath(home: string, account: string): string {
  return join(runsDirectory(home), `.member-${account}.lock`);
}

/** Serialize lifecycle observations and mutations for one member, across CLI and MCP. */
export async function withMemberRunLock<T>(
  home: string,
  account: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (!WALLET_NAME_PATTERN.test(account))
    throw new RuntimeError("runtime_unavailable", `Invalid runtime member account: ${account}.`);
  const busyMessage = `Member ${account} is changing run state.`;
  try {
    return await withFileLock(memberRunLockPath(home, account), operation, {
      timeoutMs: 5_000,
      lockedMessage: busyMessage,
    });
  } catch (error) {
    if (error instanceof FileLockedError) throw new RuntimeError("member_busy", busyMessage);
    throw error;
  }
}

async function requireRunRecord(home: string, runId: string): Promise<RunRecord> {
  const record = await readRunRecord(home, runId);
  if (record === undefined) throw new RuntimeError("run_not_found", `Run ${runId} was not found.`);
  return record;
}

export type DetachedRunSummary = {
  member: string;
  role?: string;
  swarm?: string;
  runId: string;
  kind: RuntimeKind;
  mode: "agent" | "lead";
  state: RunState;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  parentRunId?: string;
  detail?: string;
  forgottenAt?: string;
  confirmedBy?: "cli";
};

export type DetachedSwarmRunResult = {
  detached: true;
  runId: string;
  mode: "lead" | "each";
  kind: RuntimeKind;
  runs: DetachedRunSummary[];
  skipped: Array<{ member: string; role: string; reason: string }>;
};

export function summarizeRunRecord(record: RunRecord): DetachedRunSummary {
  return {
    member: record.member.account,
    ...(record.member.role === undefined ? {} : { role: record.member.role }),
    ...(record.member.swarm === undefined ? {} : { swarm: record.member.swarm }),
    runId: record.runId,
    kind: record.kind,
    mode: record.run.mode,
    state: record.state,
    startedAt: record.startedAt,
    ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
    ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
    ...(record.run.parentRunId === undefined ? {} : { parentRunId: record.run.parentRunId }),
    ...(record.detail === undefined ? {} : { detail: record.detail }),
    ...(record.forgottenAt === undefined ? {} : { forgottenAt: record.forgottenAt }),
    ...(record.confirmedBy === undefined ? {} : { confirmedBy: record.confirmedBy }),
  };
}

export async function startDetachedSwarmRun(
  input: {
    name: string;
    task: string;
    mode: "lead" | "each";
    lead?: string;
    budgetUsd?: string;
    drawUsd?: string;
  },
  deps: {
    home: string;
    store: WalletStore;
    runtime: Runtime;
    readProfile?: (account: string) => Promise<AgentProfile | undefined>;
    newRunId?: () => string;
    now?: () => Date;
    ledgerPath?: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<DetachedSwarmRunResult> {
  const swarm = await readSwarm(deps.home, input.name);
  const assessments = await assessSwarmMembers(swarm, deps);
  const nextRunId = deps.newRunId ?? createRunId;
  const topLevelRunId = checkedRunId(nextRunId());
  const skipped: Array<{ member: string; role: string; reason: string }> = assessments
    .filter(
      (assessment): assessment is Extract<(typeof assessments)[number], { eligible: false }> =>
        !assessment.eligible,
    )
    .map((assessment) => ({
      member: assessment.account,
      role: assessment.role,
      reason: assessment.reason,
    }));

  if (input.mode === "lead") {
    const target = selectLead(input, assessments);
    const record = await startDetachedRun({
      home: deps.home,
      runtime: deps.runtime,
      member: {
        swarm: swarm.name,
        account: target.account,
        profile: target.account,
        role: target.role,
      },
      run: {
        runId: topLevelRunId,
        task: input.task,
        mode: "lead",
        ...(input.budgetUsd === undefined ? {} : { budgetUsd: input.budgetUsd }),
        ...(input.drawUsd === undefined ? {} : { drawUsd: input.drawUsd }),
      },
      now: deps.now,
      ...(deps.env === undefined ? {} : { env: deps.env }),
    });
    return {
      detached: true,
      runId: topLevelRunId,
      mode: input.mode,
      kind: deps.runtime.kind,
      runs: [summarizeRunRecord(record)],
      skipped,
    };
  }

  const eligible = assessments.filter(
    (assessment): assessment is Extract<(typeof assessments)[number], { eligible: true }> =>
      assessment.eligible,
  );
  if (eligible.length === 0) {
    throw new SwarmRunError(
      "no_eligible_members",
      `Swarm ${swarm.name} has no linked, active members with readable profiles.`,
    );
  }

  const runs: DetachedRunSummary[] = [];
  const started: RunRecord[] = [];
  for (const { target } of eligible) {
    let budgetUsd = input.budgetUsd;
    if (budgetUsd === undefined) {
      const available = await memberBudgetAtomic(target.account, undefined, deps);
      budgetUsd = flooredAtomicUsd(available);
      if (budgetUsd === undefined) {
        skipped.push({ member: target.account, role: target.role, reason: "no_budget" });
        continue;
      }
    }

    const memberRunId = checkedRunId(nextRunId());
    try {
      const record = await startDetachedRun({
        home: deps.home,
        runtime: deps.runtime,
        member: {
          swarm: swarm.name,
          account: target.account,
          profile: target.account,
          role: target.role,
        },
        run: {
          runId: memberRunId,
          task: input.task,
          mode: "agent",
          budgetUsd,
          parentRunId: topLevelRunId,
        },
        now: deps.now,
        ...(deps.env === undefined ? {} : { env: deps.env }),
      });
      runs.push(summarizeRunRecord(record));
      started.push(record);
    } catch (error) {
      if (error instanceof RuntimeError && error.code === "member_busy") {
        skipped.push({ member: target.account, role: target.role, reason: "member_busy" });
        continue;
      }
      // All or nothing on a remote runtime: no member key stays in a sandbox
      // of a half-started run. With nothing started yet, the error goes out as thrown.
      if (deps.runtime.kind === "railway" && started.length > 0) {
        throw await rollBackStartedRuns({
          home: deps.home,
          runtime: deps.runtime,
          swarm: swarm.name,
          failedMember: target.account,
          error,
          started,
          ...(deps.now === undefined ? {} : { now: deps.now }),
          ...(deps.env === undefined ? {} : { env: deps.env }),
        });
      }
      throw error;
    }
  }

  return {
    detached: true,
    runId: topLevelRunId,
    mode: input.mode,
    kind: deps.runtime.kind,
    runs,
    skipped,
  };
}

/**
 * Stops every run a failed each-mode start already started, each stop on its
 * own, and returns the error to throw: the failing member and its cause, the
 * members stopped, and for each stop that failed its run id and the command.
 * The start's own error object is returned with that message, so its class
 * and `code` still reach the caller.
 */
async function rollBackStartedRuns(args: {
  home: string;
  runtime: Runtime;
  swarm: string;
  failedMember: string;
  error: unknown;
  started: readonly RunRecord[];
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}): Promise<Error> {
  const stopped: string[] = [];
  const failures: string[] = [];
  for (const record of args.started) {
    try {
      await stopRun({
        home: args.home,
        runtime: args.runtime,
        record,
        ...(args.now === undefined ? {} : { now: args.now }),
      });
      stopped.push(record.member.account);
    } catch (stopError) {
      failures.push(
        `Could not stop ${record.member.account} (run ${record.runId}): ${messageOf(stopError)}\nStop it with: vapi swarm stop ${args.swarm} ${record.runId}`,
      );
    }
  }
  const lines = [
    `Starting ${args.failedMember} on ${args.runtime.kind} failed: ${messageOf(args.error)}`,
    ...(stopped.length === 0
      ? []
      : [`Stopped ${stopped.join(", ")}, which this run had already started.`]),
    ...failures,
  ];
  const message = redactRunText(lines.join("\n"), args.env ?? {});
  if (!(args.error instanceof Error)) return new Error(message);
  args.error.message = message;
  return args.error;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertRunId(runId: string): void {
  if (!isRunId(runId)) {
    throw new RuntimeError("invalid_run_id", `Invalid run id: ${runId}.`);
  }
}

function checkedRunId(runId: string): string {
  assertRunId(runId);
  return runId;
}

function flooredAtomicUsd(value: bigint): string | undefined {
  const cents = value / 10_000n;
  if (cents === 0n) return undefined;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
