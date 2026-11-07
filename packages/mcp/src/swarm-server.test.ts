import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BASE_MAINNET_CAIP2,
  __setAtomicFileTestHooks,
  WalletStore,
  createAccount,
  getDefaultConfig,
  readSwarm,
  readMovement,
  setupSwarm,
  usdToAtomic,
  writeJsonAtomic,
  type ChatRequest,
  type ChatResult,
  type MovementTransfer,
  type DeviceLinkStart,
  type SecretStore,
  type SwarmCapitalDeps,
  type TransferResult,
} from "@vapi-network/core";
import type { RouterClientDeps } from "@vapi-network/core/router-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  listRunRecords,
  startDetachedRun,
  writeRunRecord,
  type Runtime,
  type RuntimeStatus,
} from "./agent/runtime.js";

const mocks = vi.hoisted(() => ({
  callService: vi.fn(),
  sweepAboveCeiling: vi.fn(),
}));

vi.mock("@vapi-network/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vapi-network/core")>();
  return { ...actual, sweepAboveCeiling: mocks.sweepAboveCeiling };
});

vi.mock("./tools/call.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tools/call.js")>();
  return { ...actual, callService: mocks.callService };
});

import { createVapiServer } from "./server.js";

const PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as Hex;
const PHRASE = "test test test test test test test test test test test junk";
const API_BASE = "https://api.vapinetwork.ai";
const NOW = Date.parse("2026-09-29T10:00:00.000Z");
const OWNER = "0x1111111111111111111111111111111111111111" as const;
const ROUTER_KEY = "private-router-key-for-swarm-server-tests";
const temporaryDirectories: string[] = [];

beforeEach(() => {
  mocks.callService.mockReset();
  mocks.sweepAboveCeiling.mockReset();
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("MCP swarm lifecycle", () => {
  it.each(["swarm.fund", "swarm.rebalance", "swarm.leave", "call.pay ceiling hook"] as const)(
    "guards legacy dissolution legs through the actual %s entry point",
    async (tool) => {
      const transfer = vi.fn<MovementTransfer>(async (args) => ({
        status: "unknown",
        from: args.from,
        to: OWNER,
        toName: args.to,
        toKind: "account",
        amountUsd: String(args.amountUsd),
        amountAtomic: usdToAtomic(args.amountUsd).toString(),
        network: BASE_MAINNET_CAIP2,
        txHash: null,
        nonce: (args.nonce ?? args.resume)!,
        replayed: false,
      }));
      const fetchImpl = vi.fn<typeof fetch>(async () => {
        throw new Error("No outbound request is permitted");
      });
      const fixture = await runnableSwarmFixture({
        replies: [],
        fetchImpl,
        swarm: { transfer, balanceReader: async () => 1_000_000n },
      });
      try {
        const initial = await fixture.server.callTool({
          name: "swarm.dissolve",
          arguments: { name: "team" },
        });
        expect(initial.isError, JSON.stringify(initial)).not.toBe(true);
        const id = (initial.structuredContent as { movements: Array<{ movementId: string }> })
          .movements[0]!.movementId;
        const path = join(fixture.home, "movements", `${id}.json`);
        const legacy = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
        delete legacy.dissolution;
        await writeFile(path, JSON.stringify(legacy));
        await writeJsonAtomic(
          join(fixture.home, "runs", "run_0123456789abcdef01234567.railway.json"),
          {
            v: 1,
            swarm: "team",
            account: fixture.swarm.members[0]!.account,
            sandboxId: "sbx_guard",
          },
        );
        transfer.mockClear();
        fetchImpl.mockClear();
        if (tool === "call.pay ceiling hook") {
          const actual =
            await vi.importActual<typeof import("@vapi-network/core")>("@vapi-network/core");
          mocks.sweepAboveCeiling.mockImplementation(actual.sweepAboveCeiling);
          mocks.callService.mockResolvedValue({ status: 200, body: {}, payment: null });
          await fixture.server.callTool({
            name: "call.pay",
            arguments: {
              url: "https://example.com/free",
              wallet: fixture.swarm.members[0]!.account,
            },
          });
          const call = mocks.callService.mock.calls[0]?.[0] as {
            ceilingSweep: { run(signal: AbortSignal): Promise<unknown> };
          };
          expect(call.ceilingSweep).toBeDefined();
          await expect(call.ceilingSweep.run(new AbortController().signal)).resolves.toMatchObject({
            status: "skipped",
            reason: "unfinished_movement",
          });
        } else {
          const result = await fixture.server.callTool({
            name: tool,
            arguments: {
              name: "team",
              ...(tool === "swarm.fund"
                ? { amountUsd: 1, from: "main" }
                : tool === "swarm.leave"
                  ? { member: fixture.swarm.members[0]!.account }
                  : {}),
            },
          });
          expect(result.isError).toBe(true);
          expect(result.content[0]?.text).toContain("vapi swarm stop team --all");
        }
        expect(transfer).not.toHaveBeenCalled();
        expect(fetchImpl).not.toHaveBeenCalled();
        expect((await readMovement(fixture.home, id)).legs[0]?.status).toBe("unknown");
      } finally {
        await fixture.server.close();
      }
    },
  );

  it("serializes a Railway reservation after the eligibility check with dissolution", async () => {
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const checked = deferred();
    const sweep = deferred();
    const launchReached = deferred();
    const allowLaunchLock = deferred();
    let exporting = false;
    let launchPending = false;
    const transfer = vi.fn<MovementTransfer>(async (args) => {
      expect(exporting, "no sweep may run with an exported key").toBe(false);
      return {
        status: "sent",
        from: args.from,
        to: OWNER,
        toName: args.to,
        toKind: "owner",
        amountUsd: String(args.amountUsd),
        amountAtomic: usdToAtomic(args.amountUsd).toString(),
        network: BASE_MAINNET_CAIP2,
        txHash: `0x${"34".repeat(32)}`,
        nonce: (args.nonce ?? args.resume)!,
        replayed: false,
      };
    });
    const fixture = await runnableSwarmFixture({
      replies: [],
      swarm: {
        transfer,
        balanceReader: async () => {
          checked.resolve();
          await sweep.promise;
          return 1_000_000n;
        },
      },
    });
    const runtime: Runtime = {
      kind: "railway",
      stop: vi.fn(),
      status: async () => ({ state: "running" }),
      start: async (member, run) => {
        exporting = true;
        launchReached.resolve();
        return {
          runId: run.runId,
          kind: "railway",
          member,
          startedAt: new Date(NOW).toISOString(),
          ref: "sbx_race",
        };
      },
    };
    __setAtomicFileTestHooks({
      beforeLockAttempt: async (path) => {
        if (launchPending && path === join(fixture.home, "swarms", ".team.lock")) {
          launchReached.resolve();
          await allowLaunchLock.promise;
        }
      },
    });
    try {
      const dissolving = fixture.server.callTool({
        name: "swarm.dissolve",
        arguments: { name: "team" },
      });
      await checked.promise;
      launchPending = true;
      const launching = startDetachedRun({
        home: fixture.home,
        runtime,
        member: { swarm: "team", account: fixture.swarm.members[0]!.account, profile: "lead" },
        run: { runId: "run_0123456789abcdef01234567", task: "Work", mode: "agent" },
      });
      const launchOutcome = launching.then(
        () => "started",
        () => "refused",
      );
      await launchReached.promise;
      sweep.resolve();
      const dissolved = await dissolving;
      allowLaunchLock.resolve();
      expect(await launchOutcome).toBe("refused");
      expect(dissolved.isError, JSON.stringify(dissolved)).not.toBe(true);
      expect(dissolved.structuredContent).toMatchObject({ status: "dissolved" });
      expect(exporting).toBe(false);
      expect(transfer).toHaveBeenCalled();
      expect(await listRunRecords(fixture.home)).toEqual([]);
    } finally {
      sweep.resolve();
      allowLaunchLock.resolve();
      __setAtomicFileTestHooks(undefined);
      await fixture.server.close();
    }
  });

  it.each(["starting", "running", "unknown"] as const)(
    "refuses dissolution with a tracked %s Railway run before moving money",
    async (state) => {
      const transfer = vi.fn<MovementTransfer>(async (args) => ({
        status: "sent",
        from: args.from,
        to: OWNER,
        toName: args.to,
        toKind: "account",
        amountUsd: String(args.amountUsd),
        amountAtomic: usdToAtomic(args.amountUsd).toString(),
        network: BASE_MAINNET_CAIP2,
        txHash: `0x${"34".repeat(32)}`,
        nonce: (args.nonce ?? args.resume)!,
        replayed: false,
      }));
      const balanceReader = vi.fn(async () => 1_000_000n);
      const fixture = await runnableSwarmFixture({
        replies: [],
        swarm: { transfer, balanceReader },
      });
      const runId = "run_0123456789abcdef01234567";
      const member = { swarm: "team", account: fixture.swarm.members[0]!.account, profile: "lead" };
      await writeRunRecord(fixture.home, {
        v: 1,
        runId,
        kind: "railway",
        member,
        run: { runId, task: "Work", mode: "agent" },
        handle: {
          runId,
          kind: "railway",
          member,
          startedAt: new Date(NOW).toISOString(),
          ref: "sbx_1",
        },
        startedAt: new Date(NOW).toISOString(),
        state,
      });

      const result = await fixture.server.callTool({
        name: "swarm.dissolve",
        arguments: { name: "team" },
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("vapi swarm stop team --all");
      expect(result.content[0]?.text).toContain("sbx_1");
      expect(transfer).not.toHaveBeenCalled();
      expect(balanceReader).not.toHaveBeenCalled();
      expect(await movementFiles(fixture.home)).toEqual([]);
      await expect(readSwarm(fixture.home, "team")).resolves.toBeDefined();
      await fixture.server.close();
    },
  );

  it.each([
    { state: "finished" as const, sidecar: false, refused: false },
    { state: "finished" as const, sidecar: true, refused: true },
    { state: "unknown" as const, sidecar: false, refused: true },
  ])(
    "reconciles a Railway run to $state with sidecar=$sidecar before dissolution",
    async ({ state, sidecar, refused }) => {
      const status = vi.fn<Runtime["status"]>(async () => ({ state }));
      const runtime: Runtime = { kind: "railway", start: vi.fn(), stop: vi.fn(), status };
      const transfer = vi.fn<MovementTransfer>();
      const fixture = await runnableSwarmFixture({
        replies: [],
        runtime,
        swarm: { transfer, balanceReader: async () => 0n },
      });
      const runId = "run_0123456789abcdef01234567";
      const member = { swarm: "team", account: fixture.swarm.members[0]!.account, profile: "lead" };
      await writeRunRecord(fixture.home, {
        v: 1,
        runId,
        kind: "railway",
        member,
        state: "running",
        run: { runId, task: "Work", mode: "agent" },
        handle: {
          runId,
          kind: "railway",
          member,
          startedAt: new Date(NOW).toISOString(),
          ref: "sbx_1",
        },
        startedAt: new Date(NOW).toISOString(),
      });
      if (sidecar)
        await writeJsonAtomic(join(fixture.home, "runs", `${runId}.railway.json`), {
          v: 1,
          swarm: "team",
          sandboxId: "sbx_1",
        });

      const result = await fixture.server.callTool({
        name: "swarm.dissolve",
        arguments: { name: "team" },
      });

      expect(status).toHaveBeenCalledOnce();
      expect((await listRunRecords(fixture.home))[0]?.state).toBe(state);
      if (refused) {
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("vapi swarm stop team --all");
        await expect(readSwarm(fixture.home, "team")).resolves.toBeDefined();
      } else {
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ status: "dissolved" });
      }
      expect(transfer).not.toHaveBeenCalled();
      await fixture.server.close();
    },
  );

  it("runs swarm.setup with fundUsd twice but creates one funding movement", async () => {
    let movementId = 0;
    let nonce = 0;
    const transfer = vi.fn<MovementTransfer>(async (args): Promise<TransferResult> => ({
      status: "sent",
      from: args.from,
      to: "0x2222222222222222222222222222222222222222",
      toName: args.to,
      toKind: "account",
      amountUsd: String(args.amountUsd),
      amountAtomic: usdToAtomic(args.amountUsd).toString(),
      network: BASE_MAINNET_CAIP2,
      txHash: `0x${"34".repeat(32)}`,
      nonce: (args.nonce ?? args.resume)!,
      replayed: args.resume !== undefined,
    }));
    const fixture = await serverFixture({
      transfer,
      balanceReader: async () => 0n,
      randomId: () => `mv_mcp_setup_${String(++movementId).padStart(8, "0")}`,
      randomNonce: () => `0x${(++nonce).toString(16).padStart(64, "0")}` as Hex,
    });
    const input = {
      name: "team",
      agents: 1,
      strategy: "even" as const,
      fundUsd: "5.00",
      from: "main",
    };

    const first = await fixture.server.callTool({ name: "swarm.setup", arguments: input });
    const second = await fixture.server.callTool({ name: "swarm.setup", arguments: input });

    expect(first.isError).not.toBe(true);
    expect(second.isError).not.toBe(true);
    expect(transfer.mock.calls.filter(([args]) => args.from === "main")).toHaveLength(1);
    const movementNames = (await readdir(join(fixture.home, "movements"))).filter((name) =>
      name.endsWith(".json"),
    );
    const movements = await Promise.all(
      movementNames.map(async (name) => await readMovement(fixture.home, name.slice(0, -5))),
    );
    expect(movements.filter((movement) => movement.reason === "send")).toHaveLength(1);

    await fixture.server.close();
  });

  it("refuses a foreign account name without changing its caps or ceiling", async () => {
    const fixture = await serverFixture();
    await createAccount({
      store: fixture.store,
      name: "team-lead-1",
      caps: { perCallUsd: "0.01", perDayUsd: "0.1" },
    });
    await fixture.store.setCeiling("team-lead-1", 123_000n);
    const before = JSON.stringify(fixture.store.entry("team-lead-1"));

    const result = await fixture.server.callTool({
      name: "swarm.setup",
      arguments: { name: "team", agents: 1 },
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      code: "account_name_taken",
    });
    expect(JSON.stringify(fixture.store.entry("team-lead-1"))).toBe(before);

    await fixture.server.close();
  });

  it("keeps user-lowered caps and ceiling and returns only public next steps", async () => {
    const fixture = await serverFixture();
    await fixture.server.callTool({
      name: "swarm.setup",
      arguments: { name: "team", agents: 1 },
    });
    await fixture.store.setSpendCaps("team-lead-1", {
      perCallAtomic: "10000",
      perDayAtomic: "100000",
    });
    await fixture.store.setCeiling("team-lead-1", 1_000_000n);

    const result = await fixture.server.callTool({
      name: "swarm.setup",
      arguments: { name: "team", agents: 1 },
    });

    expect(result.isError).not.toBe(true);
    expect(fixture.store.entry("team-lead-1")).toMatchObject({
      spendCaps: { perCallAtomic: "10000", perDayAtomic: "100000" },
      ceilingAtomic: "1000000",
    });
    expect(result.structuredContent).toMatchObject({
      next: expect.arrayContaining([
        {
          kind: "caps",
          account: "team-lead-1",
          command: "vapi accounts caps team-lead-1 --per-call 0.1 --per-day 1",
        },
        {
          kind: "caps",
          account: "team-lead-1",
          command: "vapi accounts caps team-lead-1 --ceiling 10",
        },
      ]),
    });

    const next = (result.structuredContent?.next ?? []) as Array<Record<string, unknown>>;
    const links = next.filter((step) => step.kind === "link");
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(Object.keys(link).sort()).toEqual(
        ["account", "expiresInSeconds", "kind", "userCode", "verificationUri"].sort(),
      );
    }
    expect(allKeys(result.structuredContent)).not.toEqual(
      expect.arrayContaining([
        "deviceCode",
        "accessToken",
        "refreshToken",
        "privateKey",
        "recoveryPhrase",
        "passphrase",
        "verificationUriComplete",
        "completions",
      ]),
    );

    await fixture.server.close();
  });

  it("passes a swarm parent resolver to the MCP pay-hook ceiling sweep", async () => {
    const fixture = await serverFixture();
    mocks.callService.mockResolvedValue({ status: 200, body: { ok: true }, payment: null });
    mocks.sweepAboveCeiling.mockResolvedValue({ status: "skipped", reason: "ceiling_off" });

    await fixture.server.callTool({
      name: "call.pay",
      arguments: { url: "https://example.com/free" },
    });

    const call = mocks.callService.mock.calls[0]?.[0] as {
      ceilingSweep?: { run(signal: AbortSignal): Promise<unknown> };
    };
    expect(call.ceilingSweep).toBeDefined();
    await call.ceilingSweep!.run(new AbortController().signal);
    expect(mocks.sweepAboveCeiling).toHaveBeenCalledWith(
      expect.objectContaining({ resolveParent: expect.any(Function) }),
    );

    await fixture.server.close();
  });
});

describe("MCP swarm runs", () => {
  it("refuses direct allocation and delegation without creating a movement", async () => {
    const transfer = vi.fn<MovementTransfer>();
    const fixture = await serverFixture({ transfer });

    const allocation = await fixture.server.callTool({
      name: "swarm.allocate",
      arguments: { amountUsd: "0.50", reason: "outside a run" },
    });
    const delegation = await fixture.server.callTool({
      name: "swarm.delegate",
      arguments: { member: "team-helper-1", task: "Help", budgetUsd: "0.50" },
    });

    expect(allocation.isError).toBe(true);
    expect(delegation.isError).toBe(true);
    expect(allocation.content[0]?.text).toContain("swarm.allocate only works inside a swarm run.");
    expect(delegation.content[0]?.text).toContain("swarm.delegate only works inside a swarm run.");
    expect(await movementFiles(fixture.home)).toEqual([]);
    expect(transfer).not.toHaveBeenCalled();

    await fixture.server.close();
  });

  it("returns the structured result when a lead finishes immediately", async () => {
    const fixture = await runnableSwarmFixture({ replies: [textReply("Lead finished.")] });

    const result = await fixture.server.callTool({
      name: "swarm.run",
      arguments: { name: "team", task: "Finish now" },
    });

    expect(result.isError).not.toBe(true);
    expect(Object.keys(result.structuredContent ?? {}).sort()).toEqual(
      ["runId", "mode", "members", "drawUsedUsd", "drawLimitUsd", "net"].sort(),
    );
    expect(result.structuredContent).toMatchObject({
      mode: "lead",
      members: [
        {
          member: "team-lead-1",
          answer: "Lead finished.",
          status: "finished",
        },
      ],
      drawUsedUsd: 0,
      drawLimitUsd: 2,
      net: [{ member: "team-lead-1" }],
    });
    expect(fixture.routerChat).toHaveBeenCalledOnce();

    await fixture.server.close();
  });

  it("starts a detached lead without entering the model loop or moving capital", async () => {
    const fake = runtimeFixture();
    const fixture = await runnableSwarmFixture({ replies: [], runtime: fake.runtime });

    const result = await fixture.server.callTool({
      name: "swarm.run",
      arguments: {
        name: "team",
        task: "Prepare a background report",
        detach: true,
        budgetUsd: "0.50",
        drawUsd: "1.25",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      detached: true,
      mode: "lead",
      kind: "local",
      runs: [
        {
          member: "team-lead-1",
          role: "lead",
          mode: "lead",
          state: "running",
        },
      ],
      skipped: [],
    });
    expect(fake.start).toHaveBeenCalledOnce();
    expect(fake.start).toHaveBeenCalledWith(
      expect.objectContaining({ swarm: "team", account: "team-lead-1" }),
      expect.objectContaining({
        task: "Prepare a background report",
        mode: "lead",
        budgetUsd: "0.50",
        drawUsd: "1.25",
      }),
      expect.any(Function),
    );
    expect(await listRunRecords(fixture.home, { swarm: "team" })).toHaveLength(1);
    expect(fixture.routerChat).not.toHaveBeenCalled();
    expect(await movementFiles(fixture.home)).toEqual([]);

    await fixture.server.close();
  });

  it("starts one detached run for each eligible member", async () => {
    const fake = runtimeFixture();
    const fixture = await runnableSwarmFixture({
      roles: ["lead", "helper"],
      replies: [],
      runtime: fake.runtime,
    });

    const result = await fixture.server.callTool({
      name: "swarm.run",
      arguments: {
        name: "team",
        task: "Compare the same question",
        mode: "each",
        budgetUsd: "0.50",
        detach: true,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      detached: true,
      mode: "each",
      kind: "local",
      runs: [
        { member: "team-lead-1", mode: "agent", state: "running" },
        { member: "team-helper-1", mode: "agent", state: "running" },
      ],
      skipped: [],
    });
    expect(fake.start).toHaveBeenCalledTimes(2);
    expect(await listRunRecords(fixture.home, { swarm: "team" })).toHaveLength(2);
    expect(fixture.routerChat).not.toHaveBeenCalled();
    expect(await movementFiles(fixture.home)).toEqual([]);

    await fixture.server.close();
  });

  it("refuses a detached run when the MCP server has no runtime", async () => {
    const fixture = await runnableSwarmFixture({ replies: [] });

    const result = await fixture.server.callTool({
      name: "swarm.run",
      arguments: { name: "team", task: "Run later", detach: true },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("detached runs are not available in this MCP server");
    expect(await listRunRecords(fixture.home, { swarm: "team" })).toEqual([]);
    expect(fixture.routerChat).not.toHaveBeenCalled();

    await fixture.server.close();
  });

  it("refuses a detached run on a non-local runtime and never starts it", async () => {
    const start = vi.fn<Runtime["start"]>(async () => {
      throw new Error("A remote runtime must never start over MCP.");
    });
    const railway: Runtime = {
      kind: "railway",
      start,
      stop: async () => undefined,
      status: async () => ({ state: "unknown" }),
    };
    const fixture = await runnableSwarmFixture({ replies: [], runtime: railway });

    const result = await fixture.server.callTool({
      name: "swarm.run",
      arguments: { name: "team", task: "Run remotely", mode: "each", detach: true },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      "Only the local runtime is available over MCP; run remote members from the CLI.",
    );
    expect(start).not.toHaveBeenCalled();
    expect(await listRunRecords(fixture.home, { swarm: "team" })).toEqual([]);
    expect(fixture.routerChat).not.toHaveBeenCalled();

    await fixture.server.close();
  });

  it("lists detached runs with refreshed status without returning task text or secrets", async () => {
    const fake = runtimeFixture();
    const fixture = await runnableSwarmFixture({ replies: [], runtime: fake.runtime });
    const task = "private task text that must stay out of swarm.runs";
    const started = await fixture.server.callTool({
      name: "swarm.run",
      arguments: { name: "team", task, detach: true },
    });
    const runId = (started.structuredContent as { runId: string }).runId;
    fake.states.set(runId, {
      state: "finished",
      exitCode: 0,
      result: { answer: "private-router-key-for-result" },
    });

    const result = await fixture.server.callTool({
      name: "swarm.runs",
      arguments: { name: "team" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      swarm: "team",
      runs: [{ runId, member: "team-lead-1", state: "finished", exitCode: 0 }],
    });
    const serialized = JSON.stringify(result.structuredContent);
    expect(serialized).not.toContain(task);
    expect(serialized).not.toContain("private-router-key-for-result");
    expect(fake.status).toHaveBeenCalledOnce();
    expect((await listRunRecords(fixture.home, { swarm: "team" }))[0]?.state).toBe("finished");

    await fixture.server.close();
  });

  it("passes member and parent run metadata to Router refills", async () => {
    const fixture = await runnableSwarmFixture({ replies: [textReply("Member finished.")] });

    const result = await fixture.server.callTool({
      name: "swarm.run",
      arguments: { name: "team", task: "Finish independently", mode: "each" },
    });

    expect(result.isError).not.toBe(true);
    const output = result.structuredContent as {
      runId: string;
      members: Array<{ member: string; runId: string }>;
    };
    const routerDeps = fixture.routerChat.mock.calls[0]![0] as RouterClientDeps;
    expect(routerDeps.refill?.run).toEqual({
      id: output.members[0]!.runId,
      swarm: "team",
      member: output.members[0]!.member,
      parentRunId: output.runId,
    });

    await fixture.server.close();
  });

  it("declines an above-threshold listing without attempting payment", async () => {
    const fixture = await runnableSwarmFixture({
      replies: [
        toolReply("search", "call_search", { query: "premium", network: null }),
        toolReply("pay", "call_pay", { ref: "premium", body: null, max_usd: 0.75 }),
        textReply("Continued without paying."),
      ],
      fetchImpl: listingAndBalanceFetch(),
    });
    await fixture.store.setSpendCaps("team-lead-1", {
      perCallAtomic: "1000000",
      perDayAtomic: "2000000",
    });

    const result = await fixture.server.callTool({
      name: "swarm.run",
      arguments: { name: "team", task: "Check the premium listing", budgetUsd: "1.00" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      members: [
        {
          member: "team-lead-1",
          answer: "Continued without paying.",
          spentUsd: 0,
          status: "finished",
        },
      ],
    });
    expect(JSON.stringify(fixture.chatRequests)).toContain("Payment was not approved");
    expect(mocks.callService).not.toHaveBeenCalled();

    await fixture.server.close();
  });

  it("reloads caps lowered while an MCP swarm run is active before its next Call", async () => {
    let home = "";
    const fixture = await runnableSwarmFixture({
      replies: [
        toolReply("search", "call_search", { query: "standard", network: null }),
        toolReply("pay", "call_pay", { ref: "premium", body: null, max_usd: 0.1 }),
        textReply("Payment attempted under current caps."),
      ],
      fetchImpl: listingAndBalanceFetch("0.10"),
      beforeReply: async (index) => {
        if (index !== 1) return;
        const writer = await WalletStore.open(home);
        await writer.setSpendCaps("team-lead-1", {
          perCallAtomic: "10000",
          perDayAtomic: "10000",
        });
      },
    });
    home = fixture.home;
    await fixture.store.setSpendCaps("team-lead-1", {
      perCallAtomic: "100000",
      perDayAtomic: "1000000",
    });
    mocks.callService.mockResolvedValue({ status: 200, body: { ok: true }, payment: null });

    const result = await fixture.server.callTool({
      name: "swarm.run",
      arguments: { name: "team", task: "Pay after caps change", budgetUsd: "0.10" },
    });

    expect(result.isError).not.toBe(true);
    expect(mocks.callService).toHaveBeenCalledWith(
      expect.objectContaining({
        spendCaps: { perCallAtomic: "10000", perDayAtomic: "10000" },
      }),
    );

    await fixture.server.close();
  });

  it("declines an above-threshold lead treasury draw without transferring", async () => {
    const transfer = vi.fn<MovementTransfer>();
    const fixture = await runnableSwarmFixture({
      replies: [
        toolReply("allocate", "swarm_allocate", {
          amount_usd: "0.75",
          reason: "Complete the task",
        }),
        toolReply("finish", "finish", { answer: "Continued without allocating." }),
      ],
      swarm: {
        balanceReader: async ({ account }) => (account === "team-treasury" ? 5_000_000n : 0n),
        transfer,
      },
    });

    const result = await fixture.server.callTool({
      name: "swarm.run",
      arguments: { name: "team", task: "Request treasury budget", drawUsd: "0.75" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      members: [
        {
          member: "team-lead-1",
          answer: "Continued without allocating.",
          spentUsd: 0,
          status: "finished",
        },
      ],
      drawUsedUsd: 0,
    });
    expect(JSON.stringify(fixture.chatRequests)).toContain("Payment was not approved");
    expect(await movementFiles(fixture.home)).toEqual([]);
    expect(transfer).not.toHaveBeenCalled();

    await fixture.server.close();
  });

  it("returns a no_lead error when lead mode has no lead member", async () => {
    const fixture = await runnableSwarmFixture({
      roles: ["helper"],
      replies: [textReply("unused")],
    });

    const result = await fixture.server.callTool({
      name: "swarm.run",
      arguments: { name: "team", task: "Find a lead" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("no_lead");
    expect(fixture.routerChat).not.toHaveBeenCalled();

    await fixture.server.close();
  });
});

async function serverFixture(
  swarm?: Pick<SwarmCapitalDeps, "balanceReader" | "transfer" | "randomId" | "randomNonce">,
  overrides: {
    fetchImpl?: typeof fetch;
    routerChat?: typeof import("@vapi-network/core/router-client").routerChat;
    runtime?: Runtime;
  } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "vapi-mcp-swarm-"));
  temporaryDirectories.push(home);
  const values = new Map<string, string>();
  const secrets: SecretStore = {
    available: true,
    platform: "darwin",
    description: "test store",
    get: async (name) => values.get(name),
    has: async (name) => values.has(name),
    set: async (name, value) => {
      values.set(name, value);
    },
    remove: async (name) => values.delete(name),
  };
  const store = await WalletStore.open(home, { secrets, env: {}, now: () => new Date(NOW) });
  await store.create("main", "", { phrase: PHRASE });
  const server = createVapiServer({
    account: privateKeyToAccount(PRIVATE_KEY),
    config: getDefaultConfig(),
    store,
    secretStore: secrets,
    env: {},
    fetchImpl:
      overrides.fetchImpl ??
      (() => Promise.reject(new Error("The swarm server test makes no network call."))),
    agentLink: { apiBase: API_BASE },
    ...(overrides.routerChat === undefined ? {} : { router: { routerChat: overrides.routerChat } }),
    ...(overrides.runtime === undefined ? {} : { runtime: overrides.runtime }),
    accounts: {
      hostname: "Test Host",
      now: () => NOW,
      startDeviceLink: async (args) => start(args.label),
      pollDeviceLink: async () => await new Promise<never>(() => undefined),
    },
    ...(swarm === undefined ? {} : { swarm }),
  });
  return { home, store, server, secrets };
}

async function runnableSwarmFixture(options: {
  roles?: string[];
  replies: ChatResult[];
  fetchImpl?: typeof fetch;
  swarm?: Pick<SwarmCapitalDeps, "balanceReader" | "transfer" | "randomId" | "randomNonce">;
  runtime?: Runtime;
  beforeReply?: (index: number) => Promise<void>;
}) {
  const chatRequests: ChatRequest[] = [];
  const replies = [...options.replies];
  let replyIndex = 0;
  const routerChat = vi.fn(async (_deps, request: ChatRequest) => {
    chatRequests.push(structuredClone(request));
    await options.beforeReply?.(replyIndex);
    replyIndex += 1;
    const reply = replies.shift();
    if (reply === undefined) throw new Error("The fake Router chat has no reply left.");
    return reply;
  });
  const fixture = await serverFixture(options.swarm, {
    fetchImpl: options.fetchImpl ?? balanceFetch(),
    routerChat,
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
  });
  await setupSwarm({
    home: fixture.home,
    store: fixture.store,
    secrets: fixture.secrets,
    apiBase: API_BASE,
    name: "team",
    roles: options.roles ?? ["lead"],
    strategy: "even",
    surface: "cli",
    env: {},
    hostname: "Test Host",
    now: () => new Date(NOW),
    startDeviceLink: async (args) => ({ ...start(args.label), autoApproved: true }),
    pollDeviceLink: async () => ({
      owner: OWNER,
      routerKey: ROUTER_KEY,
      routerBaseUrl: "https://router.vapinetwork.ai",
      tokens: {
        accessToken: "private-access-token",
        refreshToken: "private-refresh-token",
        expiresAt: NOW + 3_600_000,
        scopes: ["mcp:call", "router.use"],
      },
    }),
  });
  const swarm = await readSwarm(fixture.home, "team");
  return { ...fixture, swarm, routerChat, chatRequests };
}

function start(label: string): DeviceLinkStart {
  return {
    clientId: `agent_${label}`,
    deviceCode: `private-device-code-${label}`,
    userCode: "BCDF-GHJK",
    verificationUri: `${API_BASE}/link`,
    verificationUriComplete: `${API_BASE}/link?code=BCDF-GHJK`,
    expiresIn: 600,
    interval: 5,
    autoApproved: false,
  };
}

function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allKeys);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...allKeys(child)]);
}

function textReply(content: string): ChatResult {
  return { content, toolCalls: [], model: "router/test", keyUsed: "stake" };
}

function toolReply(id: string, name: string, args: Record<string, unknown>): ChatResult {
  return {
    content: null,
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
    model: "router/test",
    keyUsed: "stake",
  };
}

function balanceFetch(): typeof fetch {
  return vi.fn<typeof fetch>(async (input, init) => {
    const body = await requestBody(input, init);
    const request = JSON.parse(body) as { id: number; method: string };
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result: request.method === "eth_call" ? `0x${"0".repeat(64)}` : "0x0",
    });
  });
}

function listingAndBalanceFetch(priceUsd = "0.75"): typeof fetch {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/api/call/discovery") {
      return Response.json({
        protocol: "vapi.marketplace.discovery/1",
        items: [
          {
            ref: "premium",
            kind: "api",
            provenance: "self_listed",
            verification: "verified",
            execution: { mode: "direct" },
            card: {
              title: "Premium listing",
              summary: "An expensive test listing.",
              badges: [],
              facts: [{ label: "Price", value: `$${priceUsd}` }],
            },
            action: { type: "invoke_api", href: "/call/premium" },
          },
        ],
        nextCursor: null,
        unavailableKinds: [],
        rankingVersion: "marketplace-ranking-v1",
      });
    }
    if (url.pathname === "/api/call/services") {
      return Response.json({
        services: [
          {
            id: "premium",
            name: "Premium listing",
            description: "An expensive test listing.",
            category: "data",
            tier: "verified",
            verification: "verified",
            verified: true,
            wrapped: false,
            price: `$${priceUsd}`,
            networks: [BASE_MAINNET_CAIP2],
            endpoints: [
              {
                name: "call",
                method: "POST",
                url: "https://premium.example/call",
                price: `$${priceUsd}`,
                description: "Run the premium listing.",
              },
            ],
          },
        ],
      });
    }
    const body = await requestBody(input, init);
    const request = JSON.parse(body) as { id: number; method: string };
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result: request.method === "eth_call" ? `0x${"0".repeat(64)}` : "0x0",
    });
  });
}

async function requestBody(input: URL | RequestInfo, init?: RequestInit): Promise<string> {
  if (init?.body !== undefined) return String(init.body);
  return input instanceof Request ? await input.clone().text() : "";
}

async function movementFiles(home: string): Promise<string[]> {
  try {
    return (await readdir(join(home, "movements"))).filter((file) => file.endsWith(".json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function runtimeFixture(): {
  runtime: Runtime;
  start: ReturnType<typeof vi.fn<Runtime["start"]>>;
  status: ReturnType<typeof vi.fn<Runtime["status"]>>;
  states: Map<string, RuntimeStatus>;
} {
  const states = new Map<string, RuntimeStatus>();
  const start = vi.fn<Runtime["start"]>(async (member, run) => ({
    runId: run.runId,
    kind: "local",
    member,
    startedAt: new Date(NOW).toISOString(),
    ref: `pid:${run.runId}`,
  }));
  const stop = vi.fn<Runtime["stop"]>(async () => undefined);
  const status = vi.fn<Runtime["status"]>(async (handle) =>
    Promise.resolve(states.get(handle.runId) ?? { state: "running" }),
  );
  return { runtime: { kind: "local", start, stop, status }, start, status, states };
}
