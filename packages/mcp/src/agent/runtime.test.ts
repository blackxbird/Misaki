import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BASE_MAINNET_CAIP2,
  withSwarmLock,
  writeSwarm,
  type AgentProfile,
  type SwarmFile,
  type WalletStore,
} from "@vapi-network/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  listRunRecords,
  readRunRecord,
  redactRunText,
  redactRunValue,
  refreshRunRecord,
  runLogPath,
  runRecordPath,
  runRecordSchema,
  runResultPath,
  runsDirectory,
  RuntimeError,
  startDetachedRun,
  startDetachedSwarmRun,
  stopRun,
  summarizeRunRecord,
  writeRunRecord,
  type RunRecord,
  type Runtime,
  type RuntimeHandle,
  type RuntimeMember,
  type RuntimeRun,
  type RuntimeStatus,
} from "./runtime.js";

const STARTED_AT = "2026-09-30T10:00:00.000Z";
const ENDED_AT = "2026-09-30T10:05:00.000Z";
const PHRASE = "test test test test test test test test test test test junk";
const PRIVATE_KEY = `0x${"12".repeat(32)}`;
const API_KEY = "private-api-key-that-must-stay-secret";
const TOKEN = "private-access-token-that-must-stay-secret";
const DEVICE_CODE = "private-device-code-that-must-stay-secret";
const ROUTER_KEY = "private-router-key-that-must-stay-secret";
const PASSPHRASE = "private-passphrase-that-must-stay-secret";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("run registry", () => {
  it("round-trips strict records atomically with private permissions and no runtime secrets", async () => {
    const home = await temporaryHome();
    const runtime = new FakeRuntime();
    const record = sampleRecord(runId(1));

    expect(runRecordSchema.parse(record)).toEqual(record);
    expect(runRecordSchema.safeParse({ ...record, extra: true }).success).toBe(false);
    expect(
      runRecordSchema.safeParse({ ...record, member: { ...record.member, extra: true } }).success,
    ).toBe(false);
    expect(
      runRecordSchema.safeParse({ ...record, run: { ...record.run, token: TOKEN } }).success,
    ).toBe(false);
    expect(
      runRecordSchema.safeParse({ ...record, handle: { ...record.handle, apiKey: API_KEY } })
        .success,
    ).toBe(false);

    await writeRunRecord(home, record);
    const serialized = await readFile(runRecordPath(home, record.runId), "utf8");

    await expect(readRunRecord(home, record.runId)).resolves.toEqual(record);
    expect((await stat(runsDirectory(home))).mode & 0o777).toBe(0o700);
    expect((await stat(runRecordPath(home, record.runId))).mode & 0o777).toBe(0o600);
    expect(await readdir(runsDirectory(home))).toEqual([`${record.runId}.json`]);
    expect(serialized).not.toContain(PHRASE);
    expect(serialized).not.toContain(PRIVATE_KEY);
    expect(serialized).not.toMatch(/\b(?:[a-z]+\s+){11}[a-z]+\b/u);
    expect(serialized).not.toMatch(/0x[0-9a-f]{64}/iu);
    for (const secret of Object.values(runtime.environment))
      expect(serialized).not.toContain(secret);

    await writeFile(runResultPath(home, record.runId), JSON.stringify({ answer: "done" }));
    await writeFile(runLogPath(home, record.runId), "safe log");
    await writeFile(join(runsDirectory(home), `${runId(2)}.json`), "not json");
    await expect(listRunRecords(home)).resolves.toEqual([record]);
    expect((await readdir(runsDirectory(home))).filter((file) => file.endsWith(".tmp"))).toEqual(
      [],
    );
  });

  it("rejects invalid run ids before constructing any registry path", () => {
    for (const pathFor of [runRecordPath, runLogPath, runResultPath]) {
      expect(() => pathFor("/tmp/vapi-test", "../escape")).toThrow(
        expect.objectContaining({ name: "RuntimeError", code: "invalid_run_id" }),
      );
    }
  });

  it("refreshes a finished run and records its end, exit code, and result path", async () => {
    const home = await temporaryHome();
    const runtime = new FakeRuntime();
    const record = sampleRecord(runId(3));
    await writeRunRecord(home, record);
    runtime.statuses.set(record.runId, {
      state: "finished",
      result: { answer: "done" },
      exitCode: 0,
    });

    const refreshed = await refreshRunRecord(home, record, runtime, () => new Date(ENDED_AT));

    expect(refreshed).toMatchObject({
      state: "finished",
      endedAt: ENDED_AT,
      exitCode: 0,
      resultPath: runResultPath(home, record.runId),
    });
    await expect(readRunRecord(home, record.runId)).resolves.toEqual(refreshed);

    runtime.status = vi.fn().mockRejectedValue(new Error("status unavailable"));
    await expect(refreshRunRecord(home, sampleRecord(runId(4)), runtime)).resolves.toEqual(
      sampleRecord(runId(4)),
    );
  });

  it("refuses a running member and allows terminal member records", async () => {
    const busyHome = await temporaryHome();
    const busyRuntime = new FakeRuntime();
    const busy = sampleRecord(runId(10));
    await writeRunRecord(busyHome, busy);

    await expect(
      startDetachedRun({
        home: busyHome,
        runtime: busyRuntime,
        member: busy.member,
        run: sampleRun(runId(11)),
      }),
    ).rejects.toMatchObject({ code: "member_busy" });
    expect(busyRuntime.starts).toEqual([]);

    for (const [index, state] of ["finished", "failed", "stopped", "unknown"].entries()) {
      const home = await temporaryHome();
      const runtime = new FakeRuntime();
      const previous = { ...sampleRecord(runId(20 + index)), state } as RunRecord;
      await writeRunRecord(home, previous);
      const next = await startDetachedRun({
        home,
        runtime,
        member: previous.member,
        run: sampleRun(runId(30 + index)),
      });

      expect(next.state).toBe("running");
      expect(runtime.starts).toHaveLength(1);
    }
  });

  it("refuses a second concurrent start for the same member", async () => {
    const home = await temporaryHome();
    const runtime = new FakeRuntime();
    const originalStart = runtime.start.bind(runtime);
    runtime.start = async (member, run) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return await originalStart(member, run);
    };
    const member = sampleRecord(runId(60)).member;

    const outcomes = await Promise.allSettled([
      startDetachedRun({ home, runtime, member, run: sampleRun(runId(61)) }),
      startDetachedRun({ home, runtime, member, run: sampleRun(runId(62)) }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
      reason: { code: "member_busy" },
    });
    expect(runtime.starts).toHaveLength(1);
    expect(await listRunRecords(home)).toHaveLength(1);
  });

  it("persists a starting reservation before launching the worker", async () => {
    const home = await temporaryHome();
    const runtime = new FakeRuntime();
    const originalStart = runtime.start.bind(runtime);
    const id = runId(59);
    let reservation: RunRecord | undefined;
    runtime.start = async (member, run) => {
      reservation = await readRunRecord(home, id);
      return await originalStart(member, run);
    };

    await startDetachedRun({
      home,
      runtime,
      member: sampleRecord(id).member,
      run: sampleRun(id),
    });

    expect(reservation).toMatchObject({ runId: id, state: "starting" });
  });

  it("persists the adapter launch reference before start returns", async () => {
    const home = await temporaryHome();
    const runtime = new FakeRuntime();
    const id = runId(57);
    let launchedReservation: RunRecord | undefined;
    runtime.start = async (
      member,
      run,
      persistLaunch?: (handle: RuntimeHandle) => Promise<void>,
    ) => {
      const handle: RuntimeHandle = {
        runId: run.runId,
        kind: runtime.kind,
        member,
        startedAt: STARTED_AT,
        ref: "pid-4242",
      };
      expect(persistLaunch).toBeTypeOf("function");
      await persistLaunch!(handle);
      launchedReservation = await readRunRecord(home, id);
      return handle;
    };

    await startDetachedRun({
      home,
      runtime,
      member: sampleRecord(id).member,
      run: sampleRun(id),
    });

    expect(launchedReservation).toMatchObject({
      state: "starting",
      handle: { ref: "pid-4242" },
    });
  });

  it("reconciles and stops a crash-after-reservation record with a launch reference", async () => {
    const home = await temporaryHome();
    const runtime = new FakeRuntime();
    const starting = {
      ...sampleRecord(runId(56)),
      state: "starting",
    } as RunRecord;
    await writeRunRecord(home, starting);
    runtime.statuses.set(starting.runId, {
      state: "unknown",
      detail: "status could not prove that the worker exited",
    });

    const stopped = await stopRun({
      home,
      runtime,
      record: starting,
      now: () => new Date(ENDED_AT),
    });

    expect(runtime.stops).toEqual([starting.handle]);
    expect(stopped).toMatchObject({ state: "stopped", endedAt: ENDED_AT });
  });

  it("adds an actionable fix to an unreconciled stale starting record", async () => {
    const home = await temporaryHome();
    const runtime = new FakeRuntime();
    const starting = {
      ...sampleRecord(runId(55)),
      state: "starting",
      handle: { ...sampleRecord(runId(55)).handle, ref: "" },
    } as RunRecord;
    await writeRunRecord(home, starting);

    const refreshed = await refreshRunRecord(
      home,
      starting,
      runtime,
      () => new Date("2026-09-30T10:06:00.000Z"),
    );

    expect(refreshed).toMatchObject({
      state: "starting",
      detail: `Launch reference is still unavailable. Confirm the worker is stopped, then run vapi swarm stop team ${starting.runId} --confirm-worker-stopped.`,
    });
    await expect(readRunRecord(home, starting.runId)).resolves.toEqual(refreshed);
  });

  it("stops a launched worker when its running record cannot be persisted", async () => {
    const home = await temporaryHome();
    const runtime = new FakeRuntime();
    const originalStart = runtime.start.bind(runtime);
    const id = runId(58);
    runtime.start = async (member, run) => {
      const handle = await originalStart(member, run);
      await rm(runsDirectory(home), { recursive: true, force: true });
      await writeFile(runsDirectory(home), "not a directory");
      return handle;
    };

    await expect(
      startDetachedRun({
        home,
        runtime,
        member: sampleRecord(id).member,
        run: sampleRun(id),
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(runtime.stops).toEqual([
      expect.objectContaining({
        runId: id,
        member: expect.objectContaining({ account: "team-lead-1" }),
      }),
    ]);
  });

  it("hands the runtime the exact task and stores only a scrubbed copy", async () => {
    const home = await temporaryHome();
    const runtime = new FakeRuntime();
    const member = sampleRecord(runId(63)).member;
    const task = `improve accessibility and summarize tokenomics; key ${PRIVATE_KEY} ${PHRASE} ${ROUTER_KEY} false`;

    const record = await startDetachedRun({
      home,
      runtime,
      member,
      run: { ...sampleRun(runId(63)), task },
      env: { VAPI_ROUTER_KEY: ROUTER_KEY, TOKENIZERS_PARALLELISM: "false" },
    });

    expect(runtime.starts[0]!.run.task).toBe(task);
    expect(record.run.task).toBe(
      "improve accessibility and summarize tokenomics; key [redacted private key] [redacted recovery phrase] [redacted] false",
    );
    await expect(readRunRecord(home, record.runId)).resolves.toEqual(record);
  });

  it("redacts credentials without rewriting ordinary words or result fields", () => {
    const env = {
      TOKENIZERS_PARALLELISM: "false",
      VAPI_API_KEY: API_KEY,
      VAPI_ROUTER_KEY: ROUTER_KEY,
    };
    const result = {
      runId: runId(64),
      answer: `Improve accessibility, summarize tokenomics, refresh docs: false. ${API_KEY} Bearer abc.def`,
      stoppedBecause: { type: "stopped", reason: "router_budget", detail: `key ${ROUTER_KEY}` },
      paidUsd: 0,
    };

    expect(redactRunValue(result, env)).toEqual({
      ...result,
      answer:
        "Improve accessibility, summarize tokenomics, refresh docs: false. [redacted] Bearer [redacted]",
      stoppedBecause: { type: "stopped", reason: "router_budget", detail: "key [redacted]" },
    });
    expect(redactRunText(`private_key_name device_code_hint ${PRIVATE_KEY}`)).toBe(
      "private_key_name device_code_hint [redacted private key]",
    );
  });

  it("persists sanitized detail when a cleanup failure leaves a run running", async () => {
    const home = await temporaryHome();
    const runtime = new FakeRuntime();
    const record = sampleRecord(runId(65));
    await writeRunRecord(home, record);
    runtime.statuses.set(record.runId, {
      state: "running",
      detail: `finished; sandbox destroy failed near ${PRIVATE_KEY}`,
    });

    const refreshed = await refreshRunRecord(home, record, runtime);

    expect(refreshed).toMatchObject({
      state: "running",
      detail: "finished; sandbox destroy failed near [redacted private key]",
    });
    expect(summarizeRunRecord(refreshed)).toMatchObject({
      state: "running",
      detail: "finished; sandbox destroy failed near [redacted private key]",
    });
    await expect(readRunRecord(home, record.runId)).resolves.toEqual(refreshed);
  });

  it.each([
    `Use this recovery phrase ${PHRASE}`,
    `${PHRASE} before continuing with the task`,
    `Use this recovery phrase ${PHRASE} before continuing with the task`,
  ])("redacts a recovery phrase inside prose: %s", (text) => {
    const redacted = redactRunText(text);

    expect(redacted).toContain("[redacted recovery phrase]");
    expect(redacted).not.toContain(PHRASE);
  });

  it.each([
    { state: "running" as const, fails: false },
    { state: "unknown" as const, fails: false },
    { state: "running" as const, fails: true },
    { state: "unknown" as const, fails: true },
  ])(
    "stops an unknown worker only after adapter confirmation ($state, fails=$fails)",
    async ({ state, fails }) => {
      const home = await temporaryHome();
      const runtime = new FakeRuntime();
      const record = { ...sampleRecord(runId(59)), state };
      await writeRunRecord(home, record);
      runtime.statuses.set(record.runId, { state: "unknown", detail: "sandbox gone" });
      const stop = vi.spyOn(runtime, "stop").mockImplementation(async () => {
        expect((await readRunRecord(home, record.runId))?.state).toBe("unknown");
        if (fails) throw new Error("stop failed");
      });
      const operation = stopRun({ home, runtime, record, now: () => new Date(ENDED_AT) });
      if (fails) {
        await expect(operation).rejects.toThrow("stop failed");
        expect((await readRunRecord(home, record.runId))?.state).toBe("unknown");
      } else {
        await expect(operation).resolves.toMatchObject({ state: "stopped", endedAt: ENDED_AT });
        expect((await readRunRecord(home, record.runId))?.state).toBe("stopped");
      }
      expect(stop).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledWith(record.handle);
    },
  );

  it("stops only the registry handle and never stops a terminal record", async () => {
    const home = await temporaryHome();
    const runtime = new FakeRuntime();
    const stored = sampleRecord(runId(40));
    await writeRunRecord(home, stored);
    const callerRecord = {
      ...stored,
      handle: { ...stored.handle, ref: "caller-supplied-pid" },
    };

    const stopped = await stopRun({
      home,
      runtime,
      record: callerRecord,
      now: () => new Date(ENDED_AT),
    });

    expect(runtime.stops).toEqual([stored.handle]);
    expect(stopped).toMatchObject({ state: "stopped", endedAt: ENDED_AT });
    expect((await readRunRecord(home, stored.runId))?.state).toBe("stopped");

    runtime.stops.length = 0;
    await expect(stopRun({ home, runtime, record: stopped })).resolves.toEqual(stopped);
    expect(runtime.stops).toEqual([]);
  });

  it("summarizes a record without task text or adapter references", () => {
    const record = sampleRecord(runId(50));
    const summary = summarizeRunRecord(record);

    expect(summary).toEqual({
      member: "team-lead-1",
      role: "lead",
      swarm: "team",
      runId: record.runId,
      kind: "local",
      mode: "agent",
      state: "running",
      startedAt: STARTED_AT,
    });
    expect(JSON.stringify(summary)).not.toContain(record.run.task);
    expect(JSON.stringify(summary)).not.toContain(record.handle.ref);
  });
});

describe("detached swarm orchestration", () => {
  it("starts the selected lead without waiting for or taking the held swarm lock", async () => {
    const fixture = await detachedSwarmFixture();
    const runtime = new FakeRuntime();
    let result: Awaited<ReturnType<typeof startDetachedSwarmRun>> | undefined;

    await withSwarmLock(fixture.home, "team", async () => {
      result = await startDetachedSwarmRun(
        {
          name: "team",
          task: "Lead the detached work",
          mode: "lead",
          budgetUsd: "0.50",
          drawUsd: "1.25",
        },
        {
          ...fixture.deps,
          runtime,
          newRunId: () => runId(60),
        },
      );
    });

    expect(result).toMatchObject({
      detached: true,
      runId: runId(60),
      mode: "lead",
      kind: "local",
      runs: [{ member: "team-lead-1", role: "lead", mode: "lead", state: "running" }],
      skipped: [{ member: "team-writer-1", role: "writer", reason: "not_linked" }],
    });
    expect(runtime.starts).toEqual([
      {
        member: {
          swarm: "team",
          account: "team-lead-1",
          profile: "team-lead-1",
          role: "lead",
        },
        run: {
          runId: runId(60),
          task: "Lead the detached work",
          mode: "lead",
          budgetUsd: "0.50",
          drawUsd: "1.25",
        },
      },
    ]);
  });

  it("starts eligible members with parent ids, floors default budgets, and skips busy and ineligible members", async () => {
    const fixture = await detachedSwarmFixture();
    const runtime = new FakeRuntime();
    const busy = sampleRecord(runId(70), "team-helper-1", "helper");
    await writeRunRecord(fixture.home, busy);
    let next = 80;

    const result = await startDetachedSwarmRun(
      { name: "team", task: "Work independently", mode: "each", drawUsd: "9.99" },
      {
        ...fixture.deps,
        runtime,
        newRunId: () => runId(next++),
      },
    );

    expect(result).toMatchObject({
      runId: runId(80),
      mode: "each",
      runs: [
        {
          member: "team-lead-1",
          runId: runId(81),
          mode: "agent",
          parentRunId: runId(80),
        },
      ],
    });
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { member: "team-writer-1", role: "writer", reason: "not_linked" },
        { member: "team-helper-1", role: "helper", reason: "member_busy" },
        { member: "team-zero-1", role: "analyst", reason: "no_budget" },
      ]),
    );
    expect(runtime.starts).toEqual([
      {
        member: {
          swarm: "team",
          account: "team-lead-1",
          profile: "team-lead-1",
          role: "lead",
        },
        run: {
          runId: runId(81),
          task: "Work independently",
          mode: "agent",
          budgetUsd: "1.23",
          parentRunId: runId(80),
        },
      },
    ]);
  });
});

describe("detached each-mode start failures", () => {
  it("on railway, stops every member this run already started, then names the failure", async () => {
    const fixture = await detachedSwarmFixture();
    const runtime = new FailingRuntime("railway", 2);
    let next = 90;

    const failure = (await startDetachedSwarmRun(
      { name: "team", task: "Work independently", mode: "each", budgetUsd: "0.50" },
      { ...fixture.deps, runtime, newRunId: () => runId(next++) },
    ).catch((error: unknown) => error)) as Error;

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain("team-helper-1");
    expect(failure.message).toContain("sandbox create failed: quota exceeded");
    expect(failure.message).toContain("Stopped team-lead-1");
    expect(runtime.starts.map(({ member }) => member.account)).toEqual([
      "team-lead-1",
      "team-helper-1",
    ]);
    expect(runtime.stops.map(({ runId: stopped }) => stopped)).toEqual([runId(91)]);
    await expect(readRunRecord(fixture.home, runId(91))).resolves.toMatchObject({
      state: "stopped",
      endedAt: STARTED_AT,
    });
    await expect(readRunRecord(fixture.home, runId(92))).resolves.toBeUndefined();
  });

  it("on railway, names a run it could not stop with the command that stops it", async () => {
    const fixture = await detachedSwarmFixture();
    const runtime = new FailingRuntime("railway", 2);
    runtime.stopError = new Error("railway sandbox destroy pid-1 failed (exit 1): timed out");
    let next = 100;

    const failure = (await startDetachedSwarmRun(
      { name: "team", task: "Work independently", mode: "each", budgetUsd: "0.50" },
      { ...fixture.deps, runtime, newRunId: () => runId(next++) },
    ).catch((error: unknown) => error)) as Error;

    expect(failure.message).toContain("team-helper-1");
    expect(failure.message).toContain("sandbox create failed: quota exceeded");
    expect(failure.message).toContain(`Could not stop team-lead-1 (run ${runId(101)})`);
    expect(failure.message).toContain("timed out");
    expect(failure.message).toContain(`vapi swarm stop team ${runId(101)}`);
    expect(failure.message).not.toContain("Stopped team-lead-1");
    await expect(readRunRecord(fixture.home, runId(101))).resolves.toMatchObject({
      state: "running",
    });
  });

  it("on railway, rethrows the first member's failure as thrown when nothing was started", async () => {
    const fixture = await detachedSwarmFixture();
    const runtime = new FailingRuntime("railway", 1);
    runtime.startError = new RuntimeError(
      "runtime_unavailable",
      "The railway CLI is not installed or not on PATH.",
    );

    const failure = await startDetachedSwarmRun(
      { name: "team", task: "Work independently", mode: "each", budgetUsd: "0.50" },
      { ...fixture.deps, runtime, newRunId: () => runId(120) },
    ).catch((error: unknown) => error);

    expect(failure).toBe(runtime.startError);
    expect(runtime.stops).toEqual([]);
  });

  it("on railway, keeps the failure's class and code after stopping the started members", async () => {
    const fixture = await detachedSwarmFixture();
    const runtime = new FailingRuntime("railway", 2);
    runtime.startError = new RuntimeError("runtime_unavailable", "railway went away");
    let next = 130;

    const failure = (await startDetachedSwarmRun(
      { name: "team", task: "Work independently", mode: "each", budgetUsd: "0.50" },
      { ...fixture.deps, runtime, newRunId: () => runId(next++) },
    ).catch((error: unknown) => error)) as RuntimeError;

    expect(failure).toBeInstanceOf(RuntimeError);
    expect(failure.code).toBe("runtime_unavailable");
    expect(failure.message).toContain(
      "Starting team-helper-1 on railway failed: railway went away",
    );
    expect(failure.message).toContain("Stopped team-lead-1");
  });

  it("on the local runtime, keeps today's behaviour: the error as thrown, nothing stopped", async () => {
    const fixture = await detachedSwarmFixture();
    const runtime = new FailingRuntime("local", 2);
    let next = 110;

    const failure = (await startDetachedSwarmRun(
      { name: "team", task: "Work independently", mode: "each", budgetUsd: "0.50" },
      { ...fixture.deps, runtime, newRunId: () => runId(next++) },
    ).catch((error: unknown) => error)) as Error;

    expect(failure).toBe(runtime.startError);
    expect(runtime.stops).toEqual([]);
    await expect(readRunRecord(fixture.home, runId(111))).resolves.toMatchObject({
      state: "running",
    });
  });
});

/** A runtime whose start number `failAt` throws; stop can be made to throw too. */
class FailingRuntime implements Runtime {
  readonly starts: Array<{ member: RuntimeMember; run: RuntimeRun }> = [];
  readonly stops: RuntimeHandle[] = [];
  startError: Error = new Error("sandbox create failed: quota exceeded");
  stopError: Error | undefined;

  constructor(
    readonly kind: "local" | "railway",
    private readonly failAt: number,
  ) {}

  async start(member: RuntimeMember, run: RuntimeRun): Promise<RuntimeHandle> {
    this.starts.push({ member: structuredClone(member), run: structuredClone(run) });
    if (this.starts.length === this.failAt) throw this.startError;
    return {
      runId: run.runId,
      kind: this.kind,
      member: structuredClone(member),
      startedAt: STARTED_AT,
      ref: `pid-${this.starts.length}`,
    };
  }

  async stop(handle: RuntimeHandle): Promise<void> {
    this.stops.push(structuredClone(handle));
    if (this.stopError !== undefined) throw this.stopError;
  }

  async status(): Promise<RuntimeStatus> {
    return { state: "running" };
  }
}

class FakeRuntime implements Runtime {
  readonly kind = "local" as const;
  readonly starts: Array<{ member: RuntimeMember; run: RuntimeRun }> = [];
  readonly stops: RuntimeHandle[] = [];
  readonly statuses = new Map<string, RuntimeStatus>();
  readonly environment = {
    PHRASE,
    PRIVATE_KEY,
    API_KEY,
    TOKEN,
    DEVICE_CODE,
    ROUTER_KEY,
    PASSPHRASE,
  };

  async start(member: RuntimeMember, run: RuntimeRun): Promise<RuntimeHandle> {
    this.starts.push({ member: structuredClone(member), run: structuredClone(run) });
    return {
      runId: run.runId,
      kind: this.kind,
      member: structuredClone(member),
      startedAt: STARTED_AT,
      ref: `pid-${this.starts.length}`,
    };
  }

  async stop(handle: RuntimeHandle): Promise<void> {
    this.stops.push(structuredClone(handle));
  }

  async status(handle: RuntimeHandle): Promise<RuntimeStatus> {
    return this.statuses.get(handle.runId) ?? { state: "running" };
  }
}

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "vapi-runtime-"));
  temporaryDirectories.push(home);
  return home;
}

function runId(value: number): string {
  return `run_${value.toString(16).padStart(24, "0")}`;
}

function sampleRun(id: string): RuntimeRun {
  return { runId: id, task: "A safe task", mode: "agent", budgetUsd: "1.00" };
}

function sampleRecord(id: string, account = "team-lead-1", role = "lead"): RunRecord {
  const member = { swarm: "team", account, profile: account, role };
  return {
    v: 1,
    runId: id,
    kind: "local",
    member,
    run: sampleRun(id),
    handle: { runId: id, kind: "local", member, startedAt: STARTED_AT, ref: "pid-123" },
    startedAt: STARTED_AT,
    state: "running",
  };
}

async function detachedSwarmFixture(): Promise<{
  home: string;
  deps: {
    home: string;
    store: WalletStore;
    readProfile: (account: string) => Promise<AgentProfile | undefined>;
    now: () => Date;
  };
}> {
  const home = await temporaryHome();
  const members: SwarmFile["members"] = [
    swarmMember("team-lead-1", "lead"),
    swarmMember("team-helper-1", "helper"),
    swarmMember("team-writer-1", "writer"),
    swarmMember("team-zero-1", "analyst"),
  ];
  await writeSwarm(home, {
    v: 1,
    name: "team",
    device: "test-device",
    network: BASE_MAINNET_CAIP2,
    createdAt: STARTED_AT,
    treasury: {
      account: "team-treasury",
      steps: { creating: false, created: false, capped: false, linked: false },
    },
    members,
    policy: {
      strategy: "targets",
      treasuryCaps: { perCallAtomic: "5000000", perDayAtomic: "20000000" },
    },
  });
  const caps = new Map<string, string>([
    ["team-lead-1", "1234567"],
    ["team-helper-1", "2500000"],
    ["team-zero-1", "9999"],
  ]);
  const store = {
    home,
    entry(account: string) {
      const perDayAtomic = caps.get(account);
      if (perDayAtomic === undefined) return undefined;
      return {
        createdAt: STARTED_AT,
        spendCaps: { perCallAtomic: perDayAtomic, perDayAtomic },
        link: {},
      };
    },
  } as unknown as WalletStore;
  return {
    home,
    deps: {
      home,
      store,
      readProfile: async (account) => profile(account),
      now: () => new Date(STARTED_AT),
    },
  };
}

function swarmMember(account: string, role: string): SwarmFile["members"][number] {
  return {
    account,
    role,
    weight: 1,
    targetAtomic: "1000000",
    ceilingAtomic: "5000000",
    steps: { creating: false, created: false, capped: false, linked: false, profiled: true },
  };
}

function profile(account: string): AgentProfile {
  return {
    version: 1,
    name: account,
    wallet: account,
    model: "openai/gpt-5-mini",
    instructions: "Work safely.",
    verifiedOnly: true,
    approveAboveUsd: 0.5,
    maxPerTaskUsd: 100,
    autoReleaseBelowUsd: 25,
    maxSteps: 12,
    paused: false,
    grants: account.endsWith("lead-1") ? ["read", "delegate", "allocate"] : ["read"],
    createdAt: STARTED_AT,
    tools: ["call.search", "call.inspect", "call.pay"],
  };
}
