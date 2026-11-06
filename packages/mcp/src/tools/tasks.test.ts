import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_SPEND_CAPS,
  TASKS_CLIENT_VERBS,
  WalletStore,
  getDefaultConfig,
  memorySecretStore,
  readSpendLedger,
} from "@vapi-network/core";
import { agentSecretAccounts } from "@vapi-network/core/agent-link";
import {
  freezeScopeTerms,
  canonicalJson,
  TasksPartiesNotBoundError,
  TasksClientError,
  createPendingTransactions,
  createTasksClient,
  missingTasksChain,
  safeTasksChainError,
  type TasksChain,
  type TasksClient,
  type TasksClientOptions,
} from "@vapi-network/core/tasks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createVapiServer, type VapiServerOptions } from "../server.js";
import { WalletSession } from "../wallet-session.js";

const PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as Hex;
const ID = "11111111-1111-4111-8111-111111111111";
const ESCROW = "22222222-2222-4222-8222-222222222222";
const TX = `0x${"ab".repeat(32)}` as `0x${string}`;
const API_BASE = "https://tasks.example";
const NOW = "2026-10-08T12:00:00.000Z";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeClock() {
  let time = Date.parse(NOW);
  const waiting: Array<{ at: number; resolve: () => void }> = [];
  let interval = deferred<undefined>();
  return {
    now: () => new Date(time),
    sleep: vi.fn(
      (ms: number) =>
        new Promise<void>((resolve) => {
          waiting.push({ at: time + ms, resolve });
          if (ms === 1000) interval.resolve(undefined);
        }),
    ),
    interval: () => interval.promise,
    advance(ms: number) {
      interval = deferred<undefined>();
      time += ms;
      for (const sleeper of waiting.splice(0)) {
        if (sleeper.at <= time) sleeper.resolve();
        else waiting.push(sleeper);
      }
    },
  };
}

async function watchServer(
  overrides: NonNullable<VapiServerOptions["tasks"]>,
  fetchImpl?: typeof fetch,
) {
  const home = await mkdtemp(join(tmpdir(), "vapi-mcp-watch-"));
  const secrets = memorySecretStore();
  await writeFile(
    join(home, "wallets.json"),
    JSON.stringify({
      version: 1,
      default: "main",
      wallets: { main: { createdAt: NOW, spendCaps: DEFAULT_SPEND_CAPS } },
    }),
  );
  const store = await WalletStore.open(home, { secrets, env: {} });
  await store.setLink("main", {
    apiBase: API_BASE,
    clientId: "agent_main",
    owner: privateKeyToAccount(PRIVATE_KEY).address,
    label: "main",
    scopes: ["tasks"],
    linkedAt: NOW,
  });
  await secrets.set(
    agentSecretAccounts("main").tokens,
    JSON.stringify({
      accessToken: "main-token",
      refreshToken: "refresh-token",
      expiresAt: Date.parse(NOW) + 86400000,
      scopes: ["tasks"],
    }),
  );
  const server = createVapiServer({
    account: privateKeyToAccount(PRIVATE_KEY),
    config: getDefaultConfig({}),
    store,
    env: { VAPI_HOME: home },
    wallet: "main",
    secretStore: secrets,
    fetchImpl:
      fetchImpl ??
      vi.fn(async () => {
        throw new Error("No network in watch tests.");
      }),
    agentLink: { apiBase: API_BASE },
    ledgerPath: join(home, "spend-ledger.json"),
    tasks: overrides,
  });
  cleanups.push(async () => {
    await server.close();
    await rm(home, { recursive: true, force: true });
  });
  return { server, store, secrets, home };
}

describe("V2 task fee interfaces", () => {
  it.each(["dispute", "counter-evidence"])("refuses %s fee approval through MCP", async (verb) => {
    const client = {
      getOrder: vi.fn(async () => ({
        workOrder: {
          version: "work-order-view-v1",
          id: ID,
          milestones: [
            {
              id: ESCROW,
              workOrderId: ID,
              amountBaseUnits: "100000000",
              escrowContract: "0x1111111111111111111111111111111111111111",
            },
          ],
        },
      })),
      deployment: vi.fn(async () => ({ configured: true, feeBp: 500 })),
    } as unknown as TasksClient;
    const chain = {
      ...missingTasksChain,
      available: true,
      disputeFee: vi.fn(async () => 20_000_000n),
      dispute: vi.fn(),
      counterEvidence: vi.fn(),
      resolveUnmatched: vi.fn(),
    };
    const { server, home, store } = await watchServer({ client, chain, now: () => new Date(NOW) });
    await store.setSpendCaps("main", { perCallAtomic: "100000000", perDayAtomic: "100000000" });
    await mkdir(join(home, "agents"));
    await writeFile(
      join(home, "agents", "strict.json"),
      JSON.stringify({
        version: 1,
        name: "strict",
        wallet: "main",
        model: "test",
        instructions: "Require approval",
        maxPerTaskUsd: 100,
        approveAboveUsd: 10,
        createdAt: NOW,
      }),
    );
    const result = await server.callTool({
      name: `tasks.${verb}`,
      arguments: { id: ID, evidenceHash: TX },
    });
    expect(result, JSON.stringify(result)).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        approval: true,
        disputeFee: { baseUnits: "20000000", usd: "20.00" },
      },
    });
    expect(chain.dispute).not.toHaveBeenCalled();
    expect(chain.counterEvidence).not.toHaveBeenCalled();
  });
});

describe("task chain indexing waits", () => {
  async function fundFixture(advanceToLocked: boolean) {
    let time = Date.parse(NOW);
    let broadcast = false;
    let postBroadcastReads = 0;
    const milestone = {
      id: ESCROW,
      workOrderId: ID,
      amountBaseUnits: "100000",
      state: "agreed",
      escrowState: "created" as "created" | "locked",
      resolution: null,
      escrowContract: "0x1111111111111111111111111111111111111111",
    };
    const getOrder = vi.fn(async () => {
      if (broadcast) postBroadcastReads++;
      return {
        workOrder: {
          version: "work-order-view-v1" as const,
          id: ID,
          role: "client",
          milestones: [milestone],
        },
      };
    });
    const client = {
      getOrder,
      deployment: vi.fn(async () => ({ configured: true, feeBp: 250 })),
    } as unknown as TasksClient;
    const result = {
      txHash: TX,
      operation: {},
      milestone: {
        id: ESCROW,
        workOrderId: ID,
        state: "agreed",
        escrowState: "created",
        resolution: null,
      },
    } as never;
    const chain = {
      ...missingTasksChain,
      available: true,
      fund: vi.fn(async () => {
        broadcast = true;
        return result;
      }),
    } satisfies TasksChain;
    const sleep = vi.fn(async (ms: number) => {
      time += ms;
      if (advanceToLocked) milestone.escrowState = "locked";
    });
    const fixture = await watchServer({ client, chain, sleep, now: () => new Date(time) });
    return { ...fixture, chain, getOrder, postBroadcastReads: () => postBroadcastReads, sleep };
  }

  it("waits by default for funding to appear in the indexed order", async () => {
    const fixture = await fundFixture(true);

    const result = await fixture.server.callTool({ name: "tasks.fund", arguments: { id: ID } });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      wait: { reached: true, polls: 2, elapsedMs: 3_000 },
    });
    expect(fixture.chain.fund).toHaveBeenCalledOnce();
    expect(fixture.postBroadcastReads()).toBe(2);
    expect(fixture.sleep).toHaveBeenCalledOnce();
  });

  it("skips every post-operation order read when wait is false", async () => {
    const fixture = await fundFixture(true);

    const result = await fixture.server.callTool({
      name: "tasks.fund",
      arguments: { id: ID, wait: false },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ wait: null });
    expect(fixture.chain.fund).toHaveBeenCalledOnce();
    expect(fixture.postBroadcastReads()).toBe(0);
    expect(fixture.sleep).not.toHaveBeenCalled();
  });

  it("returns a normal result after exactly 60 seconds when indexing does not advance", async () => {
    const fixture = await fundFixture(false);

    const result = await fixture.server.callTool({ name: "tasks.fund", arguments: { id: ID } });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      wait: { reached: false, elapsedMs: 60_000 },
    });
    expect(fixture.chain.fund).toHaveBeenCalledOnce();
    expect(fixture.sleep).toHaveBeenCalledTimes(20);
  });

  it("preserves a polling server code without repeating funding", async () => {
    const fixture = await fundFixture(false);
    fixture.getOrder.mockResolvedValueOnce(await fixture.getOrder());
    fixture.getOrder.mockRejectedValueOnce(
      new TasksClientError("http", "Indexer unavailable", 503, "indexer_down"),
    );
    const result = await fixture.server.callTool({ name: "tasks.fund", arguments: { id: ID } });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      code: "indexer_down",
      message: "Indexer unavailable",
    });
    expect(fixture.chain.fund).toHaveBeenCalledOnce();
    expect(fixture.sleep).not.toHaveBeenCalled();
  });

  it("does not poll after a poster signs because posters do not create escrow", async () => {
    const poster = privateKeyToAccount(PRIVATE_KEY);
    const provider = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const structuredTerms = {
      version: "work-milestone-terms-v1" as const,
      title: "Write a report",
      description: "Write a complete useful report.",
      deliverables: ["A report"],
      acceptanceCriteria: ["Complete"],
      revisionCount: 0,
      deadline: NOW,
      workDurationSeconds: 86_400,
      acceptanceWindowSeconds: 604_800,
      budget: {
        network: "eip155:8453" as const,
        asset: "eip155:8453/erc20:0x1111111111111111111111111111111111111111",
        amountBaseUnits: "100000",
      },
      escrow: {
        protocol: "escrow-v1" as const,
        contract: "0x2222222222222222222222222222222222222222",
      },
      evidenceRules: { acceptedInputs: ["text" as const], exactCommitRequired: false },
    };
    const brief = "The exact report.";
    const frozen = freezeScopeTerms(structuredTerms, brief);
    const signingPayload = {
      version: "work-scope-signature-v1",
      workOrderId: ID,
      trancheOrdinal: 1,
      scopeVersion: 1,
      termsHash: frozen.termsHash,
    } as const;
    const scope = {
      id: ESCROW,
      workOrderId: ID,
      version: 1,
      trancheOrdinal: 1,
      state: "proposed",
      proposedByRole: "provider",
      structuredTerms,
      brief,
      termsHash: frozen.termsHash,
      signingPayload,
      proposerAddress: provider.address,
      proposerSignature: await provider.signMessage({ message: canonicalJson(signingPayload) }),
    } as const;
    const milestone = {
      id: ESCROW,
      workOrderId: ID,
      ordinal: 1,
      termsHash: frozen.termsHash,
      escrowState: null,
    };
    const acceptance = {
      scope: { ...scope, state: "accepted" as const, milestoneId: ESCROW },
      milestone,
    };
    const getOrder = vi.fn(async () => ({
      workOrder: {
        version: "work-order-view-v1" as const,
        id: ID,
        role: "client",
        clientAddress: poster.address,
        acceptedProposalId: ESCROW,
        proposals: [{ id: ESCROW, providerAddress: provider.address }],
        milestones: [milestone],
      },
    }));
    const client = {
      getOrder,
      getScopes: vi.fn(async () => ({ scopes: [scope] })),
      signScope: vi.fn(async () => acceptance),
    } as unknown as TasksClient;
    vi.spyOn(WalletSession.prototype, "payment").mockResolvedValue({
      wallet: { name: "main" },
      account: poster,
    });
    vi.spyOn(WalletSession.prototype, "addressesFor").mockResolvedValue({
      wallet: { name: "main" },
      address: poster.address,
    });
    const sleep = vi.fn(async () => undefined);
    const { server } = await watchServer({ client, sleep, now: () => new Date(NOW) });

    const result = await server.callTool({
      name: "tasks.sign",
      arguments: { id: ID, counterparty: provider.address },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ escrowCreation: null, wait: null });
    expect(getOrder).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("bounded task watch", () => {
  it("polls until the window expires without polling at or beyond the deadline", async () => {
    const clock = fakeClock();
    const events = vi.fn(async () => ({ events: [], nextAfter: 3 }));
    const { server } = await watchServer({
      client: { events } as unknown as TasksClient,
      now: clock.now,
      sleep: clock.sleep,
    });
    const result = server.callTool({
      name: "tasks.watch",
      arguments: { id: ID, after: 3, waitSeconds: 2 },
    });
    await clock.interval();
    expect(events).toHaveBeenCalledTimes(1);
    clock.advance(1000);
    await clock.interval();
    expect(events).toHaveBeenCalledTimes(2);
    clock.advance(1000);
    expect(await result).toMatchObject({
      structuredContent: { events: [], nextCursor: 3, timedOut: true },
    });
    expect(clock.now().getTime() - Date.parse(NOW)).toBe(2000);
    expect(events).toHaveBeenCalledTimes(2);
    clock.advance(30000);
    await Promise.resolve();
    expect(events).toHaveBeenCalledTimes(2);
  });

  it("bounds a pending events request and aborts its transport", async () => {
    const clock = fakeClock();
    const started = deferred<AbortSignal>();
    const events = vi.fn<TasksClient["events"]>(async (_id, _query, request) => {
      started.resolve(request!.signal!);
      return await new Promise<never>(() => undefined);
    });
    const { server } = await watchServer({
      client: { events } as unknown as TasksClient,
      now: clock.now,
      sleep: clock.sleep,
    });
    const result = server.callTool({
      name: "tasks.watch",
      arguments: { id: ID, after: 7, waitSeconds: 25 },
    });
    const signal = await started.promise;
    clock.advance(25000);
    expect(await result).toMatchObject({
      structuredContent: { events: [], nextCursor: 7, timedOut: true },
    });
    expect(signal.aborted).toBe(true);
    expect(events).toHaveBeenCalledOnce();
  });

  it("bounds pending sign-in refresh and starts no poll after timeout", async () => {
    const clock = fakeClock();
    const started = deferred<AbortSignal>();
    const refresh = deferred<Response>();
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      started.resolve(init!.signal!);
      return await refresh.promise;
    });
    const events = vi.fn();
    const { server, secrets } = await watchServer(
      { client: { events } as unknown as TasksClient, now: clock.now, sleep: clock.sleep },
      fetchImpl,
    );
    await secrets.set(
      agentSecretAccounts("main").tokens,
      JSON.stringify({
        accessToken: "expired-token",
        refreshToken: "refresh-token",
        expiresAt: Date.parse(NOW),
        scopes: ["tasks"],
      }),
    );
    const result = server.callTool({ name: "tasks.watch", arguments: { id: ID, waitSeconds: 1 } });
    const signal = await started.promise;
    clock.advance(1000);
    expect(await result).toMatchObject({
      structuredContent: { events: [], nextCursor: 0, timedOut: true },
    });
    expect(signal.aborted).toBe(true);
    expect(events).not.toHaveBeenCalled();
    refresh.resolve(
      Response.json({
        access_token: "refreshed",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "next",
        scope: "tasks",
      }),
    );
    await Promise.resolve();
    expect(events).not.toHaveBeenCalled();
  });

  it("preserves the cursor when a late page is discarded", async () => {
    const clock = fakeClock();
    const events = vi.fn(async () => {
      clock.advance(2000);
      return {
        events: [{ sequence: 9, type: "task.paid", payload: { state: "paid" } }],
        nextAfter: 9,
      };
    });
    const { server } = await watchServer({
      client: { events } as unknown as TasksClient,
      now: clock.now,
      sleep: () => new Promise<void>(() => undefined),
    });
    const result = await server.callTool({
      name: "tasks.watch",
      arguments: { id: ID, after: 7, waitSeconds: 1 },
    });
    expect(result).toMatchObject({
      structuredContent: { events: [], nextCursor: 7, timedOut: true },
    });
  });

  it("returns immediately for a zero-second window", async () => {
    const clock = fakeClock();
    const events = vi.fn();
    const { server } = await watchServer({
      client: { events } as unknown as TasksClient,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(
      await server.callTool({
        name: "tasks.watch",
        arguments: { id: ID, after: 5, waitSeconds: 0 },
      }),
    ).toMatchObject({ structuredContent: { events: [], nextCursor: 5, timedOut: true } });
    expect(events).not.toHaveBeenCalled();
    expect(clock.sleep).not.toHaveBeenCalled();
  });
});

describe("task wallet and route boundaries", () => {
  it("shows a public task with an empty wallet store and no wallet selection", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-mcp-empty-wallets-"));
    const secrets = memorySecretStore();
    const store = await WalletStore.open(home, { secrets, env: {} });
    const client = {
      publicTask: vi.fn(async () => ({ id: ID, title: "Public task", receiptUrl: null })),
      getOrder: vi.fn(),
    } as unknown as TasksClient;
    const factory = vi.fn<(options: TasksClientOptions) => TasksClient>(() => client);
    const server = createVapiServer({
      account: privateKeyToAccount(PRIVATE_KEY),
      config: getDefaultConfig({}),
      store,
      env: { VAPI_HOME: home },
      secretStore: secrets,
      fetchImpl: vi.fn(async () => {
        throw new Error("public task read used injected client");
      }),
      agentLink: { apiBase: API_BASE },
      tasks: { client: factory },
    });
    cleanups.push(async () => {
      await server.close();
      await rm(home, { recursive: true, force: true });
    });

    const result = await server.callTool({ name: "tasks.show", arguments: { id: ID } });
    const status = await server.callTool({ name: "tasks.status", arguments: { id: ID } });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ task: { id: ID, title: "Public task" } });
    expect(status.isError, JSON.stringify(status)).not.toBe(true);
    expect(status.structuredContent).toMatchObject({ task: { id: ID, title: "Public task" } });
    expect(client.publicTask).toHaveBeenCalledTimes(2);
    expect(client.getOrder).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledTimes(2);
    for (const [options] of factory.mock.calls) expect(options).not.toHaveProperty("token");
  });

  it.each(["tool argument", "server option", "environment"] as const)(
    "rejects a missing wallet selected by %s without fetching the public task",
    async (selection) => {
      const home = await mkdtemp(join(tmpdir(), "vapi-mcp-missing-wallet-"));
      const secrets = memorySecretStore();
      const store = await WalletStore.open(home, { secrets, env: {} });
      const client = { publicTask: vi.fn(), getOrder: vi.fn() } as unknown as TasksClient;
      const factory = vi.fn<(options: TasksClientOptions) => TasksClient>(() => client);
      const server = createVapiServer({
        account: privateKeyToAccount(PRIVATE_KEY),
        config: getDefaultConfig({}),
        store,
        env: {
          VAPI_HOME: home,
          ...(selection === "environment" ? { VAPI_WALLET: "missing" } : {}),
        },
        ...(selection === "server option" ? { wallet: "missing" } : {}),
        secretStore: secrets,
        fetchImpl: vi.fn(async () => {
          throw new Error("missing wallet must fail before fetching");
        }),
        agentLink: { apiBase: API_BASE },
        tasks: { client: factory },
      });
      cleanups.push(async () => {
        await server.close();
        await rm(home, { recursive: true, force: true });
      });

      const result = await server.callTool({
        name: "tasks.show",
        arguments: { id: ID, ...(selection === "tool argument" ? { wallet: "missing" } : {}) },
      });
      const status = await server.callTool({
        name: "tasks.status",
        arguments: { id: ID, ...(selection === "tool argument" ? { wallet: "missing" } : {}) },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("No account named missing");
      expect(status.isError).toBe(true);
      expect(JSON.stringify(status)).toContain("No account named missing");
      expect(factory).not.toHaveBeenCalled();
      expect(client.publicTask).not.toHaveBeenCalled();
      expect(client.getOrder).not.toHaveBeenCalled();
    },
  );

  it("uses the public status card when the selected wallet is not linked", async () => {
    const payment = vi.spyOn(WalletSession.prototype, "payment");
    const client = {
      publicTask: vi.fn(async () => ({ id: ID, title: "Public task", receiptUrl: null })),
      chainState: vi.fn(),
      events: vi.fn(),
    } as unknown as TasksClient;
    const factory = vi.fn<(options: TasksClientOptions) => TasksClient>(() => client);
    const { server, store } = await watchServer({ client: factory, now: () => new Date(NOW) });
    await store.clearLink("main");

    const status = await server.callTool({ name: "tasks.status", arguments: { id: ID } });

    expect(status.isError, JSON.stringify(status)).not.toBe(true);
    expect(status.structuredContent).toMatchObject({ task: { id: ID, title: "Public task" } });
    expect(client.publicTask).toHaveBeenCalledOnce();
    expect(client.chainState).not.toHaveBeenCalled();
    expect(client.events).not.toHaveBeenCalled();
    for (const [options] of factory.mock.calls) expect(options).not.toHaveProperty("token");
    expect(payment).not.toHaveBeenCalled();
  });

  it("refuses scope signing without the human-confirmed counterparty before signing or persistence", async () => {
    const signer = privateKeyToAccount(PRIVATE_KEY);
    const signMessage = vi.fn(signer.signMessage);
    const payment = vi
      .spyOn(WalletSession.prototype, "payment")
      .mockResolvedValue({ wallet: { name: "main" }, account: { ...signer, signMessage } });
    const client = { getOrder: vi.fn() } as unknown as TasksClient;
    const { server, home } = await watchServer({ client });

    const result = await server.callTool({ name: "tasks.sign", arguments: { id: ID } });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      code: "counterparty_required",
      message:
        "Supply counterparty from tasks.show to confirm the task's money direction before signing.",
    });
    expect(payment).not.toHaveBeenCalled();
    expect(client.getOrder).not.toHaveBeenCalled();
    expect(signMessage).not.toHaveBeenCalled();
    await expect(
      readFile(join(home, "tasks", "scope-bindings.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves the missing local party-binding message through tasks.fund", async () => {
    const message =
      "The task parties are not bound on this machine. Sign the scope with `vapi task sign` on this machine first; an explicit --counterparty only confirms an existing binding.";
    const client = {
      getOrder: vi.fn(async () => ({
        workOrder: {
          version: "work-order-view-v1",
          id: ID,
          role: "client",
          milestones: [
            {
              id: ESCROW,
              workOrderId: ID,
              amountBaseUnits: "100000",
              state: "agreed",
              escrowState: "created",
              resolution: null,
              escrowContract: "0x1111111111111111111111111111111111111111",
            },
          ],
        },
      })),
      deployment: vi.fn(async () => ({ configured: true, feeBp: 250 })),
    } as unknown as TasksClient;
    const chain = {
      ...missingTasksChain,
      available: true,
      fund: vi.fn(async () => {
        throw new TasksPartiesNotBoundError();
      }),
    };
    const { server, home } = await watchServer({ client, chain, now: () => new Date(NOW) });

    const result = await server.callTool({ name: "tasks.fund", arguments: { id: ID } });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ code: "task_error", message });
    expect(chain.fund).toHaveBeenCalledOnce();
    await expect(
      readFile(join(home, "tasks", "scope-bindings.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports missing chain after signing a worker scope and preserves the acceptance", async () => {
    const structuredTerms = {
      version: "work-milestone-terms-v1" as const,
      title: "Write a report",
      description: "Write a complete useful report.",
      acceptanceCriteria: ["Report is complete"],
      workDurationSeconds: 86_400,
      acceptanceWindowSeconds: 604_800,
      budget: {
        network: "eip155:8453" as const,
        asset: "eip155:8453/erc20:0x1111111111111111111111111111111111111111",
        amountBaseUnits: "1000000",
      },
      escrow: {
        protocol: "escrow-v1" as const,
        contract: "0x2222222222222222222222222222222222222222",
      },
      evidenceRules: { acceptedInputs: ["text" as const], exactCommitRequired: false },
      deliverables: ["A written report"],
      revisionCount: 0,
      deadline: NOW,
    };
    const brief = "Write and deliver the agreed report.";
    const frozen = freezeScopeTerms(structuredTerms, brief);
    const payload = {
      version: "work-scope-signature-v1",
      workOrderId: ID,
      trancheOrdinal: 1,
      scopeVersion: 1,
      termsHash: frozen.termsHash,
    };
    const scope = {
      id: ESCROW,
      workOrderId: ID,
      version: 1,
      trancheOrdinal: 1,
      state: "proposed",
      proposedByRole: "client",
      structuredTerms,
      brief,
      termsHash: frozen.termsHash,
      signingPayload: payload,
      proposerAddress: privateKeyToAccount(`0x${"11".repeat(32)}`).address,
      proposerSignature: await privateKeyToAccount(`0x${"11".repeat(32)}`).signMessage({
        message: canonicalJson(payload),
      }),
    };
    const milestone = {
      id: ESCROW,
      workOrderId: ID,
      ordinal: 1,
      termsHash: frozen.termsHash,
      escrowState: null as null | "locked",
    };
    const acceptance = { scope: { ...scope, state: "accepted", milestoneId: ESCROW }, milestone };
    const signer = privateKeyToAccount(PRIVATE_KEY);
    const client = {
      getOrder: vi.fn(async () => ({
        workOrder: {
          id: ID,
          version: "work-order-view-v1",
          role: "provider",
          clientAddress: scope.proposerAddress,
          acceptedProposalId: ESCROW,
          proposals: [{ id: ESCROW, providerAddress: signer.address }],
          milestones: [milestone],
        },
      })),
      getScopes: vi.fn(async () => ({ scopes: [scope] })),
      signScope: vi.fn(async () => acceptance),
    } as unknown as TasksClient;
    const payment = vi
      .spyOn(WalletSession.prototype, "payment")
      .mockResolvedValue({ wallet: { name: "main" }, account: signer });
    vi.spyOn(WalletSession.prototype, "addressesFor").mockResolvedValue({
      wallet: { name: "main" },
      address: signer.address,
    });
    const { server } = await watchServer({
      client,
      chain: { ...missingTasksChain, signingAddress: signer.address },
      now: () => new Date(NOW),
      randomUUID: () => ID,
    });
    const result = await server.callTool({
      name: "tasks.sign",
      arguments: { id: ID, counterparty: scope.proposerAddress },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      code: "chain_unavailable",
      message: "An acting wallet is required for task chain operations.",
      acceptance: {
        ...acceptance,
        terms: {
          role: "provider",
          self: signer.address,
          direction: "you deliver work to the poster",
          counterparty: privateKeyToAccount(`0x${"11".repeat(32)}`).address,
          amountBaseUnits: "1000000",
          asset: structuredTerms.budget.asset,
          network: "eip155:8453",
          deadline: NOW,
          deliverables: ["A written report"],
          title: "Write a report",
        },
      },
    });
    expect(payment).toHaveBeenCalledWith("main");
    expect(client.signScope).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(PRIVATE_KEY);

    milestone.escrowState = "locked";
    const succeeded = await server.callTool({
      name: "tasks.sign",
      arguments: { id: ID, counterparty: scope.proposerAddress },
    });
    expect(succeeded.isError).toBeFalsy();
    expect(succeeded.structuredContent).toMatchObject({
      wait: null,
      terms: {
        amountBaseUnits: "1000000",
        asset: structuredTerms.budget.asset,
        network: "eip155:8453",
        deadline: NOW,
        deliverables: ["A written report"],
        title: "Write a report",
      },
    });
  });

  it("recovers accepted worker signing through the lazy wallet identity without a new scope signature", async () => {
    const signer = privateKeyToAccount(PRIVATE_KEY);
    const other = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const structuredTerms = {
      version: "work-milestone-terms-v1" as const,
      title: "Write a report",
      description: "Write a complete useful report.",
      deliverables: ["A report"],
      acceptanceCriteria: ["Complete"],
      revisionCount: 0,
      deadline: NOW,
      workDurationSeconds: 86400,
      acceptanceWindowSeconds: 604800,
      budget: {
        network: "eip155:8453" as const,
        asset: "eip155:8453/erc20:0x1111111111111111111111111111111111111111",
        amountBaseUnits: "1000000",
      },
      escrow: {
        protocol: "escrow-v1" as const,
        contract: "0x2222222222222222222222222222222222222222",
      },
      evidenceRules: { acceptedInputs: ["text" as const], exactCommitRequired: false },
    };
    const brief = "The exact report.";
    const frozen = freezeScopeTerms(structuredTerms, brief);
    const signingPayload = {
      version: "work-scope-signature-v1",
      workOrderId: ID,
      trancheOrdinal: 1,
      scopeVersion: 1,
      termsHash: frozen.termsHash,
    };
    const message = canonicalJson(signingPayload);
    const scope = {
      id: ESCROW,
      workOrderId: ID,
      version: 1,
      trancheOrdinal: 1,
      state: "accepted",
      proposedByRole: "client",
      structuredTerms,
      brief,
      termsHash: frozen.termsHash,
      signingPayload,
      milestoneId: ESCROW,
      acceptedAt: NOW,
      proposerAddress: other.address,
      proposerSignature: await other.signMessage({ message }),
      counterpartyAddress: signer.address,
      counterpartySignature: await signer.signMessage({ message }),
    };
    const milestone = {
      id: ESCROW,
      workOrderId: ID,
      ordinal: 1,
      termsHash: frozen.termsHash,
      termsFrozenAt: NOW,
      escrowState: null,
    };
    const signMessage = vi.fn(signer.signMessage);
    vi.spyOn(WalletSession.prototype, "payment").mockResolvedValue({
      wallet: { name: "main" },
      account: { ...signer, signMessage },
    });
    vi.spyOn(WalletSession.prototype, "addressesFor").mockResolvedValue({
      wallet: { name: "main" },
      address: signer.address,
    });
    const client = {
      getOrder: vi.fn(async () => ({
        workOrder: {
          id: ID,
          version: "work-order-view-v1",
          role: "provider",
          clientAddress: other.address,
          acceptedProposalId: ESCROW,
          proposals: [{ id: ESCROW, providerAddress: signer.address }],
          milestones: [milestone],
        },
      })),
      getScopes: vi.fn(async () => ({ scopes: [scope] })),
      signScope: vi.fn(),
      deployment: vi.fn(async () => ({ configured: false })),
    } as unknown as TasksClient;
    const { server, home } = await watchServer({ client, now: () => new Date(NOW) });
    const result = await server.callTool({
      name: "tasks.sign",
      arguments: { id: ID, counterparty: other.address },
    });
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      acceptance: { scope: { state: "accepted" }, terms: { counterparty: other.address } },
    });
    expect(await readFile(join(home, "tasks", "scope-bindings.json"), "utf8")).toContain(
      signer.address,
    );
    expect(client.signScope).not.toHaveBeenCalled();
    expect(signMessage).not.toHaveBeenCalled();
  });

  it("signs proposals and submissions using the selected wallet without returning secrets", async () => {
    const signer = privateKeyToAccount(PRIVATE_KEY);
    const signMessage = vi.fn(signer.signMessage);
    const payment = vi
      .spyOn(WalletSession.prototype, "payment")
      .mockResolvedValue({ wallet: { name: "work" }, account: { ...signer, signMessage } });
    const proposal = vi.fn(async () => ({ proposal: { id: ESCROW } }));
    const submission = vi.fn(async () => ({ submission: { id: ESCROW } }));
    const createOrder = vi.fn(async () => ({ workOrder: { id: ID } }));
    const configureWebhook = vi.fn(async () => ({
      webhookUrl: "https://example.test/hook",
      secret: "webhook-secret",
    }));
    const deployment = {
      configured: true,
      feeBp: 250,
      network: "eip155:8453",
      usdc: "0x1111111111111111111111111111111111111111",
      escrowContract: "0x2222222222222222222222222222222222222222",
    };
    const client = {
      getOrder: vi.fn(async () => ({
        workOrder: {
          id: ID,
          title: "Write a report",
          description: "Write a complete useful report.",
        },
      })),
      deployment: vi.fn(async () => deployment),
      propose: proposal,
      submit: submission,
      createOrder,
      configureWebhook,
      sendMessage: vi.fn(async () => {
        throw new TasksClientError("http", "Denied", 403, "insufficient_scope");
      }),
      chainState: vi.fn(async () => ({ workOrderId: ID, milestones: [], observedAt: NOW })),
      events: vi.fn(async () => ({ events: [], nextAfter: 0 })),
      publicTask: vi.fn(async () => ({
        id: ID,
        title: "Write a report",
        briefFull: "Write a complete useful report.",
        durationSeconds: 3600,
        amount: { gross: "100000" },
      })),
    } as unknown as TasksClient;
    let clock = Date.parse(NOW);
    let advanceDuringClientSetup = false;
    const factory = vi.fn<(options: TasksClientOptions) => TasksClient>(() => {
      if (advanceDuringClientSetup) {
        clock += 5 * 60 * 1_000;
        advanceDuringClientSetup = false;
      }
      return client;
    });
    const { server, store, secrets } = await watchServer({
      client: factory,
      now: () => new Date(clock),
    });
    await store.create("work", "");
    await store.setLink("work", {
      apiBase: API_BASE,
      clientId: "agent_work",
      owner: signer.address,
      label: "work",
      scopes: ["tasks"],
      linkedAt: NOW,
    });
    await secrets.set(
      agentSecretAccounts("work").tokens,
      JSON.stringify({
        accessToken: "work-token",
        refreshable: false,
        expiresAt: Date.parse(NOW) + 86400000,
        scopes: ["tasks"],
      }),
    );
    const proposed = await server.callTool({
      name: "tasks.propose",
      arguments: {
        id: ID,
        wallet: "work",
        priceUsd: "0.10",
        duration: "10m",
        note: "A complete proposal note.",
      },
    });
    const submitted = await server.callTool({
      name: "tasks.submit",
      arguments: { id: ID, wallet: "work", proofUrls: ["https://example.test/proof"] },
    });
    advanceDuringClientSetup = true;
    const posted = await server.callTool({
      name: "tasks.post",
      arguments: {
        wallet: "work",
        title: "Build an API",
        brief: "Build a complete useful API.",
        amountUsd: "12.50",
        deadline: "10m",
        intake: "submissions",
        maxAwards: 3,
        webhookUrl: "https://example.test/hook",
      },
    });
    const insufficient = await server.callTool({
      name: "tasks.message",
      arguments: { id: ID, wallet: "work", text: "Hello" },
    });
    const factoriesBeforeStatus = factory.mock.calls.length;
    const status = await server.callTool({
      name: "tasks.status",
      arguments: { id: ID, wallet: "work" },
    });
    expect(proposed.isError, JSON.stringify(proposed)).not.toBe(true);
    expect(submitted.isError, JSON.stringify(submitted)).not.toBe(true);
    expect(posted.isError, JSON.stringify(posted)).not.toBe(true);
    expect(status.isError, JSON.stringify(status)).not.toBe(true);
    expect(status.structuredContent).toMatchObject({
      task: { id: ID },
      chainState: { workOrderId: ID },
      events: [],
      nextAfter: 0,
    });
    expect(factory.mock.calls).toHaveLength(factoriesBeforeStatus + 1);
    expect(factory.mock.lastCall?.[0]).toMatchObject({ token: "work-token" });
    expect(client.chainState).toHaveBeenCalledWith(ID);
    expect(client.events).toHaveBeenCalledWith(ID, { wait: 0 });
    expect(createOrder).toHaveBeenCalledWith(
      {
        title: "Build an API",
        description: "Build a complete useful API.",
        policyFamily: "general-digital",
        market: {
          intake: "submissions",
          maxAwards: 3,
          audience: "anyone",
          proofKinds: ["url", "file"],
          budget: { network: "eip155:8453", asset: "USDC", amountBaseUnits: "12500000" },
          deadlineAt: "2026-10-08T12:10:00.000Z",
        },
      },
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(configureWebhook).toHaveBeenCalledWith(ID, { url: "https://example.test/hook" });
    expect(JSON.parse(insufficient.content[0]!.text)).toEqual({
      code: "insufficient_scope",
      message: "This sign-in lacks Tasks access. Call auth.link again.",
    });
    expect(payment.mock.calls).toEqual([["work"], ["work"]]);
    expect(signMessage).toHaveBeenCalledTimes(2);
    for (const [input] of signMessage.mock.calls) expect(typeof input.message).toBe("string");
    for (const [input] of factory.mock.calls) expect(input.token).toBe("work-token");
    for (const result of [proposed, submitted]) {
      expect(JSON.stringify(result)).not.toContain(PRIVATE_KEY);
      expect(JSON.stringify(result)).not.toContain("work-token");
    }
  });

  it("rejects a wallet linked to a different API origin before querying task data", async () => {
    const client = { sendMessage: vi.fn(), publicTask: vi.fn() } as unknown as TasksClient;
    const factory = vi.fn<(options: TasksClientOptions) => TasksClient>(() => client);
    const { server, store } = await watchServer({ client: factory, now: () => new Date(NOW) });
    await store.setLink("main", {
      apiBase: "https://other.example",
      clientId: "other",
      owner: privateKeyToAccount(PRIVATE_KEY).address,
      label: "main",
      scopes: ["tasks"],
      linkedAt: NOW,
    });
    const result = await server.callTool({
      name: "tasks.message",
      arguments: { id: ID, text: "Hello" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      code: "not_signed_in",
      message:
        "The acting wallet is linked to a different server. Call auth.link for the acting wallet.",
    });
    expect(factory).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();

    const show = await server.callTool({ name: "tasks.show", arguments: { id: ID } });
    expect(show.isError).toBe(true);
    expect(JSON.parse(show.content[0]!.text)).toEqual({
      code: "not_signed_in",
      message:
        "The acting wallet is linked to a different server. Call auth.link for the acting wallet.",
    });
    expect(factory).not.toHaveBeenCalled();
    expect(client.publicTask).not.toHaveBeenCalled();
  });

  it.each(["search", "status"] as const)(
    "maps a pending %s route to its availability error",
    async (verb) => {
      const absent = vi.fn(async () => {
        throw new TasksClientError("http", "Route missing", 404);
      });
      const client = { board: absent, chainState: absent } as unknown as TasksClient;
      const { server } = await watchServer({ client, now: () => new Date(NOW) });
      const result = await server.callTool({
        name: `tasks.${verb}`,
        arguments: verb === "search" ? {} : { id: ID },
      });
      expect(JSON.parse(result.content[0]!.text)).toEqual({
        code: "not_available",
        message:
          verb === "status"
            ? "GET /v1/work-orders/:id/chain-state is not available on this server."
            : "search is not available on this server yet.",
      });
      expect(result.isError).toBe(true);
    },
  );

  it("uses signed chain state and participant events for status", async () => {
    const payment = vi.spyOn(WalletSession.prototype, "payment");
    const chainState = { workOrderId: ID, milestones: [], observedAt: NOW };
    const events = [
      { sequence: 3, type: "task.paid", at: NOW, actor: "poster", payload: {} },
      { sequence: 1, type: "task.posted", at: NOW, actor: "poster", payload: {} },
    ];
    const client = {
      chainState: vi.fn(async () => chainState),
      events: vi.fn(async () => ({ events, nextAfter: 3 })),
      publicTask: vi.fn(),
    } as unknown as TasksClient;
    const factory = vi.fn<(options: TasksClientOptions) => TasksClient>(() => client);
    const { server } = await watchServer({ client: factory, now: () => new Date(NOW) });
    const status = await server.callTool({ name: "tasks.status", arguments: { id: ID } });
    expect(status.structuredContent).toEqual({
      task: { id: ID },
      chainState,
      events: [events[1], events[0]],
      nextAfter: 3,
    });
    expect(factory.mock.calls[0]?.[0]).toMatchObject({ token: "main-token" });
    expect(client.chainState).toHaveBeenCalledWith(ID);
    expect(client.events).toHaveBeenCalledWith(ID, { wait: 0 });
    expect(client.publicTask).not.toHaveBeenCalled();
    expect(payment).not.toHaveBeenCalled();
  });

  it("reads both signed status routes with the bearer token", async () => {
    const payment = vi.spyOn(WalletSession.prototype, "payment");
    const chainState = { workOrderId: ID, milestones: [], observedAt: NOW };
    const events = [
      { sequence: 4, type: "task.paid", at: NOW, actor: "poster", payload: {} },
      { sequence: 2, type: "task.funded", at: NOW, actor: "poster", payload: {} },
    ];
    const requests: Request[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url === `${API_BASE}/v1/work-orders/${ID}/chain-state`)
        return Response.json(chainState);
      if (request.url === `${API_BASE}/v1/work-orders/${ID}/events?wait=0`)
        return Response.json({ events, nextAfter: 4 });
      return Response.json({ code: "unexpected_route" }, { status: 404 });
    });
    const { server } = await watchServer({ now: () => new Date(NOW) }, fetchImpl as typeof fetch);

    const status = await server.callTool({ name: "tasks.status", arguments: { id: ID } });

    expect(status.structuredContent).toEqual({
      task: { id: ID },
      chainState,
      events: [events[1], events[0]],
      nextAfter: 4,
    });
    expect(requests.map(({ method, url }) => [method, url])).toEqual([
      ["GET", `${API_BASE}/v1/work-orders/${ID}/chain-state`],
      ["GET", `${API_BASE}/v1/work-orders/${ID}/events?wait=0`],
    ]);
    for (const request of requests)
      expect(request.headers.get("authorization")).toBe("Bearer main-token");
    expect(payment).not.toHaveBeenCalled();
  });

  it("keeps signed status when participant events are unavailable", async () => {
    const chainState = { workOrderId: ID, milestones: [], observedAt: NOW };
    const client = {
      chainState: vi.fn(async () => chainState),
      events: vi.fn(async () => {
        throw new TasksClientError("http", "Not a participant", 404, "task_not_found");
      }),
    } as unknown as TasksClient;
    const { server } = await watchServer({ client, now: () => new Date(NOW) });

    const status = await server.callTool({ name: "tasks.status", arguments: { id: ID } });

    expect(status.structuredContent).toEqual({
      task: { id: ID },
      chainState,
      events: null,
      nextAfter: null,
    });
  });

  it("preserves a signed status server error code", async () => {
    const client = {
      chainState: vi.fn(async () => {
        throw new TasksClientError(
          "http",
          "The request signature is invalid.",
          400,
          "invalid_signature",
        );
      }),
    } as unknown as TasksClient;
    const { server } = await watchServer({ client, now: () => new Date(NOW) });

    const status = await server.callTool({ name: "tasks.status", arguments: { id: ID } });

    expect(status.isError).toBe(true);
    expect(JSON.parse(status.content[0]!.text)).toEqual({
      code: "invalid_signature",
      message: "The request signature is invalid.",
    });
  });
});

describe("task MCP tools", () => {
  it.each([
    ["preserves an invited provider address exactly", "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01"],
    ["omits the invited provider address when vendor is omitted", undefined],
  ] as const)("%s in the posted work order", async (_label, vendor) => {
    const requests: Request[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url === `${API_BASE}/api/tasks/readiness`)
        return Response.json({
          configured: true,
          feeBp: 250,
          chainId: 8453,
          network: "eip155:8453",
          explorerUrl: "https://basescan.org",
          escrowContract: "0x1111111111111111111111111111111111111111",
          feeRouter: "0x2222222222222222222222222222222222222222",
          usdc: "0x3333333333333333333333333333333333333333",
          capabilities: { erc3009Funding: true, vapiVerify: true },
          eip3009Domain: {
            name: "USDC",
            version: "2",
            chainId: 8453,
            verifyingContract: "0x3333333333333333333333333333333333333333",
          },
          maxEscrowAmountBaseUnits: "500000000",
          defaults: { workDurationSeconds: 86400 },
          verifyReviewPriceBaseUnits: null,
        });
      if (request.url === `${API_BASE}/v1/work-orders` && request.method === "POST")
        return Response.json({
          workOrder: {
            version: "work-order-view-v1",
            id: ID,
            state: "open",
            title: "Build an API",
            description: "Build a complete and carefully documented API integration.",
            policyFamily: "general-digital",
            listingDeliveryTimeSeconds: null,
            clientAddress: privateKeyToAccount(PRIVATE_KEY).address,
            invitedProviderAddress: vendor ?? null,
            acceptedProposalId: null,
            threadId: null,
            role: "client",
            canFinalize: false,
            proposals: [],
            milestones: [],
            events: [],
            review: null,
            publishedAt: NOW,
            completedAt: null,
            createdAt: NOW,
            updatedAt: NOW,
          },
        });
      return Response.json({ code: "unexpected_route" }, { status: 404 });
    });
    const { server } = await watchServer(
      { now: () => new Date(NOW), randomUUID: () => ID },
      fetchImpl,
    );

    const result = await server.callTool({
      name: "tasks.post",
      arguments: {
        title: "Build an API",
        brief: "Build a complete and carefully documented API integration.",
        amountUsd: "12.50",
        deadline: "1d",
        ...(vendor === undefined ? {} : { vendor }),
      },
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const posts = requests.filter(
      ({ method, url }) => method === "POST" && url === `${API_BASE}/v1/work-orders`,
    );
    expect(posts).toHaveLength(1);
    const body = JSON.parse(await posts[0]!.text()) as Record<string, unknown>;
    if (vendor === undefined) expect(body).not.toHaveProperty("invitedProviderAddress");
    else expect(body.invitedProviderAddress).toBe(vendor);
  });

  it("rejects an invalid invited provider address before making a request", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("Invalid task input must not reach the network.");
    });
    const { server } = await watchServer({ now: () => new Date(NOW) }, fetchImpl);

    const result = await server.callTool({
      name: "tasks.post",
      arguments: {
        title: "Build an API",
        brief: "Build a complete and carefully documented API integration.",
        amountUsd: "12.50",
        deadline: "1d",
        vendor: "not-an-address",
      },
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).code).toBe("invalid_input");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("retains funding when persisted exposure predates lazy wallet initialization failure", async () => {
    const client = {
      getOrder: vi.fn(async () => ({
        workOrder: {
          version: "work-order-view-v1",
          id: ID,
          role: "client",
          milestones: [
            {
              id: ESCROW,
              workOrderId: ID,
              amountBaseUnits: "100000",
              state: "agreed",
              escrowState: "created",
              resolution: null,
              escrowContract: "0x1111111111111111111111111111111111111111",
            },
          ],
        },
      })),
      deployment: vi.fn(async () => ({
        configured: true,
        network: "eip155:8453",
        escrowContract: "0x2222222222222222222222222222222222222222",
        usdc: "0x3333333333333333333333333333333333333333",
        feeBp: 250,
      })),
    } as unknown as TasksClient;
    const payment = vi
      .spyOn(WalletSession.prototype, "payment")
      .mockRejectedValue(new Error("vault unavailable"));
    const { server, home } = await watchServer({
      client,
      randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      now: () => new Date(NOW),
    });
    await createPendingTransactions(home).markExposure(ESCROW);

    const result = await server.callTool({ name: "tasks.fund", arguments: { id: ID } });

    expect(result.isError).toBe(true);
    expect(payment).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(join(home, "spend-ledger.json"), "utf8"))).toMatchObject({
      date: "2026-10-08",
      spentAtomic: "100000",
      reservations: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          amountAtomic: "100000",
          kind: "escrow-funding",
        },
      ],
    });
  });

  it("registers the complete documented task surface in canonical order with safe schemas", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("No network in task tests.");
    });
    const client = Object.fromEntries(
      Object.keys(createTasksClient({ baseUrl: API_BASE, fetch: fetchImpl })).map((name) => [
        name,
        vi.fn(),
      ]),
    ) as unknown as TasksClient;
    const chain = {
      ...missingTasksChain,
      available: true,
      fund: vi.fn(),
      deliver: vi.fn(),
      release: vi.fn(),
      refund: vi.fn(),
      dispute: vi.fn(),
      disputeFee: vi.fn(),
      counterEvidence: vi.fn(),
      resolveUnmatched: vi.fn(),
      createEscrow: vi.fn(),
      signScopeMessage: vi.fn(),
    } satisfies TasksChain;
    const server = createVapiServer({
      account: privateKeyToAccount(PRIVATE_KEY),
      config: getDefaultConfig({}),
      fetchImpl,
      env: {},
      tasks: { client, chain, now: () => new Date("2026-10-08T12:00:00Z") },
    });
    const readme = await readFile(new URL("../../../../README.md", import.meta.url), "utf8");

    try {
      const allTools = (await server.listTools()).tools;
      expect(allTools.some(({ description }) => description?.startsWith("Moves money"))).toBe(
        false,
      );
      const tools = allTools.filter(({ name }) => name.startsWith("tasks."));
      expect(tools.map(({ name }) => name)).toEqual(
        TASKS_CLIENT_VERBS.map((verb) => `tasks.${verb}`),
      );

      for (const tool of tools) {
        const verb = tool.name.slice("tasks.".length);
        expect(readme).toContain(`\`${tool.name}\``);
        if (
          [
            "fund",
            "release",
            "refund",
            "dispute",
            "counter-evidence",
            "resolve-unmatched",
          ].includes(verb)
        ) {
          expect(tool.description).toMatch(/^Executes the user's own /u);
          expect(tool.description).toContain("nothing is custodial");
        } else {
          expect(tool.description).toContain("Does not move money");
        }
        expect(tool.inputSchema).toMatchObject({ additionalProperties: false });
        expect(tool.outputSchema).toBeUndefined();
        expect(tool.description).not.toMatch(
          /Lane|plan 032|\b[BC][1-8]\b|vendor|client|gig|job|freelance|—/u,
        );
      }

      const byVerb = Object.fromEntries(tools.map((tool) => [tool.name.slice(6), tool]));
      expect(byVerb.show?.inputSchema).toMatchObject({
        required: ["id"],
        properties: { id: { format: "uuid" }, wallet: { type: "string" } },
      });
      expect(byVerb.status?.inputSchema).toMatchObject({
        required: ["id"],
        properties: { id: { format: "uuid" }, wallet: { type: "string" } },
      });
      expect(byVerb.search?.inputSchema).toMatchObject({
        properties: {
          open: { type: "boolean" },
          limit: { type: "integer" },
        },
      });
      expect(byVerb.deliver?.inputSchema).toMatchObject({
        properties: { files: { minItems: 1, maxItems: 20 } },
      });
      expect(byVerb.sign?.description).toContain(
        "the human confirms the money direction via counterparty",
      );
      expect(byVerb.sign?.description).toMatch(/^Signs the user's own task scope locally/u);
      expect(byVerb.sign?.description).toContain("Does not move money");
      expect(byVerb.sign?.inputSchema).toMatchObject({
        properties: {
          counterparty: {
            description:
              "Checksummed 0x address of the other party, taken from tasks.show (the poster's clientAddress when you are the worker; the accepted proposal's providerAddress when you are the poster). The human must supply it; it is compared with the signed scope and stored as local consent. Without it tasks.sign refuses and no local party binding is created, so tasks.fund/deliver/release cannot run from this machine.",
          },
        },
      });
      expect(byVerb.watch?.inputSchema).toMatchObject({
        properties: {
          after: { default: 0, type: "integer" },
          waitSeconds: { default: 25, type: "integer", minimum: 0, maximum: 25 },
        },
      });
      expect(JSON.stringify(byVerb.watch?.inputSchema)).not.toContain("autoRelease");
      expect(JSON.stringify(byVerb.fund?.inputSchema)).not.toMatch(/yes|approve|confirm/u);
      for (const verb of ["sign", "fund", "deliver", "release"]) {
        expect(byVerb[verb]?.inputSchema).toMatchObject({
          properties: {
            wait: {
              type: "boolean",
              default: true,
              description:
                "Wait up to 60 seconds for vAPI to index the chain result before returning.",
            },
          },
        });
        expect(JSON.stringify(byVerb[verb]?.inputSchema)).not.toMatch(/timeout/i);
      }
      for (const verb of ["refund", "dispute", "counter-evidence", "resolve-unmatched"]) {
        expect(
          (byVerb[verb]?.inputSchema as { properties?: Record<string, unknown> } | undefined)
            ?.properties,
        ).not.toHaveProperty("wait");
      }

      const idVerbs = TASKS_CLIENT_VERBS.filter((verb) => verb !== "search" && verb !== "post");
      for (const verb of idVerbs) {
        const result = await server.callTool({
          name: `tasks.${verb}`,
          arguments: { id: "not-a-uuid" },
        });
        expect(result.isError, `${verb} must reject a malformed id`).toBe(true);
        expect(JSON.parse(result.content[0]!.text).code).toBe("invalid_input");
      }

      const invalidCalls = [
        ["tasks.search", { minUsd: "-1" }],
        ["tasks.search", { minUsd: "1.0000001" }],
        ["tasks.search", { limit: 0 }],
        [
          "tasks.post",
          {
            title: "Valid title",
            brief: "A sufficiently long brief",
            amountUsd: "1",
            deadline: "9m",
          },
        ],
        [
          "tasks.post",
          {
            title: "Valid title",
            brief: "A sufficiently long brief",
            amountUsd: "1",
            deadline: "10m",
            webhookUrl: "http://example.com/hook",
          },
        ],
        ["tasks.deliver", { id: "11111111-1111-4111-8111-111111111111", files: [], note: "ok" }],
        [
          "tasks.deliver",
          {
            id: "11111111-1111-4111-8111-111111111111",
            files: Array.from({ length: 21 }, (_, index) => `/tmp/${index}`),
            note: "ok",
          },
        ],
        ["tasks.dispute", { id: "11111111-1111-4111-8111-111111111111", evidenceHash: "0x1234" }],
        ["tasks.watch", { id: "11111111-1111-4111-8111-111111111111", waitSeconds: 26 }],
        ["tasks.fund", { id: "11111111-1111-4111-8111-111111111111", yes: true }],
        ["tasks.fund", { id: ID, approve: true }],
        ["tasks.dispute", { id: ID, evidenceHash: TX, yes: true }],
        ["tasks.counter-evidence", { id: ID, evidenceHash: TX, approve: true }],
        ["tasks.resolve-unmatched", { id: ID, counterparty: "0x1234" }],
        ["tasks.sign", { id: ID, counterparty: "0x1234" }],
        ["tasks.fund", { id: ID, confirm: true }],
        ["tasks.watch", { id: ID, autoRelease: true }],
        ["tasks.thread", { id: ID, after: 0 }],
        [
          "tasks.post",
          { title: "A task", brief: "A sufficiently long brief", amountUsd: "0", deadline: "10m" },
        ],
        ["tasks.propose", { id: ID, priceUsd: "1", duration: "9m", note: "Terms" }],
        ["tasks.submit", { id: ID, proofUrls: ["http://example.test/proof"] }],
      ] as const;
      for (const [name, arguments_] of invalidCalls) {
        const result = await server.callTool({ name, arguments: arguments_ });
        expect(result.isError, `${name} must reject ${JSON.stringify(arguments_)}`).toBe(true);
        expect(JSON.parse(result.content[0]!.text).code).toBe("invalid_input");
      }
      for (const method of Object.values(client)) expect(method).not.toHaveBeenCalled();
      for (const method of Object.values(chain))
        if (typeof method === "function") expect(method).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();

      const home = await mkdtemp(join(tmpdir(), "vapi-mcp-tasks-"));
      const ledgerPath = join(home, "spend-ledger.json");
      const secrets = memorySecretStore();
      await writeFile(
        join(home, "wallets.json"),
        `${JSON.stringify({
          version: 1,
          default: "main",
          wallets: {
            main: { createdAt: "2026-10-08T00:00:00.000Z", spendCaps: DEFAULT_SPEND_CAPS },
          },
        })}\n`,
      );
      const store = await WalletStore.open(home, { secrets, env: {} });
      await store.setLink("main", {
        apiBase: API_BASE,
        clientId: "agent_main",
        owner: privateKeyToAccount(PRIVATE_KEY).address,
        label: "main",
        scopes: ["tasks"],
        linkedAt: "2026-10-08T00:00:00.000Z",
      });
      await secrets.set(
        agentSecretAccounts("main").tokens,
        JSON.stringify({
          accessToken: "main-token",
          refreshToken: "main-refresh",
          expiresAt: Date.parse("2026-10-09T00:00:00.000Z"),
          scopes: ["tasks"],
        }),
      );

      const calls: string[] = [];
      let indexedTime = Date.parse("2026-10-08T12:00:00.000Z");
      let fundingBroadcast = false;
      let postFundingReads = 0;
      const moneyOrder = {
        workOrder: {
          version: "work-order-view-v1",
          id: ID,
          role: "client",
          milestones: [
            {
              id: ESCROW,
              workOrderId: ID,
              amountBaseUnits: "100000",
              state: "agreed",
              escrowState: "created",
              resolution: null,
              escrowContract: "0x1111111111111111111111111111111111111111",
            },
          ],
        },
      };
      const event = (sequence: number, state: string) => ({
        sequence,
        type: `task.${state}`,
        at: "2026-10-08T12:00:00.000Z",
        actor: "worker",
        payload: { state },
      });
      const getOrder = vi.fn(async () => {
        if (fundingBroadcast && postFundingReads++ > 0)
          moneyOrder.workOrder.milestones[0]!.escrowState = "locked";
        return moneyOrder;
      });
      const fakeClient = {
        getOrder,
        deployment: vi.fn(async () => ({
          configured: true,
          network: "eip155:8453",
          escrowContract: "0x2222222222222222222222222222222222222222",
          usdc: "0x3333333333333333333333333333333333333333",
          feeBp: 250,
        })),
        uploadFile: vi.fn(async () => ({
          file: {
            id: "33333333-3333-4333-8333-333333333333",
            fileName: "delivery.txt",
            sha256: "ef".repeat(32),
            sizeBytes: 13,
          },
        })),
        sendMessage: vi.fn(async () => {
          throw new TasksClientError("http", "denied", 401);
        }),
        events: vi
          .fn()
          .mockResolvedValueOnce({
            events: [event(4, "funded"), event(2, "open"), event(4, "funded")],
            nextAfter: 3,
          })
          .mockResolvedValue({ events: [], nextAfter: 4 }),
      } as unknown as TasksClient;
      const chainResult = {
        txHash: TX,
        operation: {},
        milestone: { id: ESCROW, workOrderId: ID },
      } as never;
      const fakeChain = {
        available: true,
        createEscrow: vi.fn(async () => chainResult),
        fund: vi.fn(async () => {
          const ledger = await readSpendLedger(ledgerPath, new Date(NOW));
          expect(ledger.spentAtomic).toBe("100000");
          expect(JSON.parse(await readFile(ledgerPath, "utf8")).reservations).toHaveLength(1);
          fundingBroadcast = true;
          return chainResult;
        }),
        deliver: vi.fn(async () => chainResult),
        release: vi.fn(async () => chainResult),
        refund: vi.fn(async () => chainResult),
        dispute: vi.fn(async () => chainResult),
        disputeFee: vi.fn(async () => 20_000_000n),
        counterEvidence: vi.fn(async () => chainResult),
        resolveUnmatched: vi.fn(async () => chainResult),
        signScopeMessage: vi.fn(async (message: string) => {
          expect(typeof message).toBe("string");
          return `0x${"cd".repeat(65)}` as `0x${string}`;
        }),
      } satisfies TasksChain;
      let sequence = 0;
      const behaviorServer = createVapiServer({
        account: privateKeyToAccount(PRIVATE_KEY),
        config: getDefaultConfig({}),
        store,
        wallet: "main",
        env: {},
        secretStore: secrets,
        agentLink: { apiBase: API_BASE },
        fetchImpl: () => Promise.reject(new Error("injected task client must handle requests")),
        ledgerPath,
        tasks: {
          client: (options) => {
            calls.push(options.token ?? "public");
            return fakeClient;
          },
          chain: fakeChain,
          randomUUID: () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++sequence).padStart(12, "0")}`,
          now: () => new Date(indexedTime),
          sleep: async (ms) => {
            if (ms !== 3_000) return await new Promise<void>(() => undefined);
            indexedTime += ms;
          },
        },
      });
      try {
        const watched = await behaviorServer.callTool({
          name: "tasks.watch",
          arguments: { id: ID, after: 1, waitSeconds: 1, until: "funded" },
        });
        expect(watched).toMatchObject({
          structuredContent: {
            events: [{ sequence: 2 }, { sequence: 4 }],
            nextCursor: 4,
            reached: "funded",
            timedOut: false,
          },
        });
        expect(fakeClient.events).toHaveBeenCalledWith(
          ID,
          { after: 1, wait: 0 },
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        expect(fakeChain.release).not.toHaveBeenCalled();

        const funded = await behaviorServer.callTool({ name: "tasks.fund", arguments: { id: ID } });
        expect(funded.isError).not.toBe(true);
        expect(funded.structuredContent).toMatchObject({
          wait: { reached: true, polls: 2, elapsedMs: 3000 },
        });
        expect(fakeChain.fund).toHaveBeenCalledOnce();
        expect(calls).toContain("main-token");
        const timedOutRelease = await behaviorServer.callTool({
          name: "tasks.release",
          arguments: { id: ID },
        });
        expect(timedOutRelease.isError).not.toBe(true);
        expect(timedOutRelease.structuredContent).toMatchObject({
          wait: { reached: false, elapsedMs: 60_000 },
        });
        const rawTransaction = `0x${"12".repeat(96)}`;
        const authorizationSignature = `0x${"34".repeat(65)}`;
        const source = Object.assign(
          new Error(`RPC 503 included ${rawTransaction} and ${authorizationSignature}`),
          {
            name: "HttpRequestError",
            shortMessage: `RPC request failed with status 503: ${rawTransaction} ${authorizationSignature}`,
            details: { rawTransaction, authorizationSignature },
            cause: { status: 503, rawTransaction, authorizationSignature },
          },
        );
        fakeChain.release.mockRejectedValueOnce(safeTasksChainError(source, false, true));
        const failedRelease = await behaviorServer.callTool({
          name: "tasks.release",
          arguments: { id: ID, wait: false },
        });
        const serializedFailure = JSON.stringify(failedRelease);
        expect(failedRelease).toMatchObject({ isError: true });
        expect(serializedFailure).toContain("HttpRequestError");
        expect(serializedFailure).not.toContain(rawTransaction);
        expect(serializedFailure).not.toContain(authorizationSignature);
        expect(serializedFailure).not.toContain("details");
        expect(serializedFailure).not.toContain("cause");
        const unauthorized = await behaviorServer.callTool({
          name: "tasks.message",
          arguments: { id: ID, text: "hello" },
        });
        expect(unauthorized).toMatchObject({ isError: true });
        expect(JSON.stringify(unauthorized)).toContain(
          "message needs sign-in. Call auth.link for the acting wallet.",
        );
        const ledgerBeforeRefusal = await readFile(ledgerPath);
        await mkdir(join(home, "agents"));
        await writeFile(
          join(home, "agents", "strict.json"),
          JSON.stringify({
            version: 1,
            name: "strict",
            wallet: "main",
            model: "router/test",
            instructions: "Stay within the task cap.",
            maxPerTaskUsd: 0.05,
            approveAboveUsd: 0.05,
            createdAt: "2026-10-08T00:00:00.000Z",
          }),
        );
        const refused = await behaviorServer.callTool({
          name: "tasks.fund",
          arguments: { id: ID },
        });
        expect(refused).toMatchObject({
          isError: true,
          structuredContent: {
            ok: false,
            reason: "policy.perTask",
            policySource: "agent-profile",
            policyDecision: "policy.perTask",
            money: { gross: { baseUnits: "100000" } },
          },
        });
        expect(await readFile(ledgerPath)).toEqual(ledgerBeforeRefusal);
        expect(fakeChain.fund).toHaveBeenCalledOnce();
        await writeFile(
          join(home, "agents", "strict.json"),
          JSON.stringify({
            version: 1,
            name: "strict",
            wallet: "main",
            model: "router/test",
            instructions: "Require approval.",
            maxPerTaskUsd: 1,
            approveAboveUsd: 0.05,
            createdAt: "2026-10-08T00:00:00.000Z",
          }),
        );
        const approval = await behaviorServer.callTool({
          name: "tasks.fund",
          arguments: { id: ID },
        });
        expect(approval).toMatchObject({
          isError: true,
          structuredContent: {
            ok: false,
            approval: true,
            policySource: "agent-profile",
            policyDecision: "approval",
            money: { gross: { baseUnits: "100000" } },
          },
        });
        expect(await readFile(ledgerPath)).toEqual(ledgerBeforeRefusal);
        expect(fakeChain.fund).toHaveBeenCalledOnce();

        await writeFile(
          join(home, "agents", "strict.json"),
          JSON.stringify({
            version: 1,
            name: "strict",
            wallet: "main",
            model: "router/test",
            instructions: "Use the daily cap.",
            maxPerTaskUsd: 1,
            approveAboveUsd: 1,
            createdAt: "2026-10-08T00:00:00.000Z",
          }),
        );
        await store.setSpendCaps("main", { perCallAtomic: "1000000", perDayAtomic: "99999" });
        const perDay = await behaviorServer.callTool({
          name: "tasks.fund",
          arguments: { id: ID },
        });
        expect(perDay).toMatchObject({
          isError: true,
          structuredContent: {
            ok: false,
            reason: "policy.perDay",
            policySource: "agent-profile",
            policyDecision: "policy.perDay",
            money: { gross: { baseUnits: "100000" } },
          },
        });
        expect(await readFile(ledgerPath)).toEqual(ledgerBeforeRefusal);
        expect(fakeChain.fund).toHaveBeenCalledOnce();
        await store.setSpendCaps("main", DEFAULT_SPEND_CAPS);

        for (const verb of ["release", "refund"] as const) {
          const settled = await behaviorServer.callTool({
            name: `tasks.${verb}`,
            arguments: { id: ID, ...(verb === "release" ? { wait: false } : {}) },
          });
          expect(settled).toMatchObject({
            structuredContent: {
              money: {
                gross: { baseUnits: "100000" },
                fee: { baseUnits: "2500" },
                net: { baseUnits: "97500" },
              },
              result: { txHash: TX },
            },
          });
        }
        await store.setSpendCaps("main", {
          perCallAtomic: "1000000000",
          perDayAtomic: "1000000000",
        });
        await writeFile(
          join(home, "agents", "strict.json"),
          JSON.stringify({
            version: 1,
            name: "strict",
            wallet: "main",
            model: "router/test",
            instructions: "Permit verified fees",
            maxPerTaskUsd: 100,
            approveAboveUsd: 100,
            createdAt: NOW,
          }),
        );
        const disputed = await behaviorServer.callTool({
          name: "tasks.dispute",
          arguments: { id: ID, evidenceHash: TX },
        });
        expect(disputed).toMatchObject({
          structuredContent: {
            money: { gross: { baseUnits: "20000000" } },
            disputeFee: { baseUnits: "20000000", usd: "20.00" },
            result: { txHash: TX },
          },
        });
        expect(JSON.stringify(disputed)).not.toContain("disputeFeeNote");

        const deliveryFile = join(home, "delivery.txt");
        await writeFile(deliveryFile, "finished work");
        const readsBeforeDelivery = getOrder.mock.calls.length;
        const delivered = await behaviorServer.callTool({
          name: "tasks.deliver",
          arguments: { id: ID, files: [deliveryFile], note: "Complete", wait: false },
        });
        expect(delivered).toMatchObject({
          structuredContent: { ok: true, result: { txHash: TX }, wait: null },
        });
        expect(fakeClient.getOrder).toHaveBeenCalledTimes(readsBeforeDelivery + 1);
        expect(JSON.stringify(delivered)).toMatch(/0x[0-9a-f]{64}/u);

        const noChainServer = createVapiServer({
          account: privateKeyToAccount(PRIVATE_KEY),
          config: getDefaultConfig({}),
          store,
          wallet: "main",
          env: {},
          secretStore: secrets,
          agentLink: { apiBase: API_BASE },
          fetchImpl: () => Promise.reject(new Error("delivery used injected client")),
          ledgerPath: join(home, "missing-chain-ledger.json"),
          tasks: {
            client: fakeClient,
            chain: missingTasksChain,
            now: () => new Date("2026-10-08T12:00:00Z"),
          },
        });
        try {
          const missingFund = await noChainServer.callTool({
            name: "tasks.fund",
            arguments: { id: ID },
          });
          expect(missingFund).toMatchObject({ isError: true });
          expect(JSON.parse(missingFund.content[0]!.text)).toEqual({
            code: "chain_unavailable",
            message: "An acting wallet is required for task chain operations.",
          });
          await expect(readFile(join(home, "missing-chain-ledger.json"))).rejects.toMatchObject({
            code: "ENOENT",
          });
          const noChain = await noChainServer.callTool({
            name: "tasks.deliver",
            arguments: { id: ID, files: [deliveryFile], note: "Complete" },
          });
          expect(noChain).toMatchObject({ isError: true });
          expect(JSON.stringify(noChain)).toContain("chain_unavailable");
          expect(JSON.stringify(noChain)).toContain(
            "An acting wallet is required for task chain operations.",
          );
          expect(JSON.stringify(noChain)).toMatch(/manifestHash.*0x[0-9a-f]{64}/u);
        } finally {
          await noChainServer.close();
        }

        const publicClient = {
          publicTask: vi.fn(async () => ({ id: ID, receiptUrl: null })),
        } as unknown as TasksClient;
        const publicServer = createVapiServer({
          account: privateKeyToAccount(PRIVATE_KEY),
          config: getDefaultConfig({}),
          agentLink: { apiBase: API_BASE },
          fetchImpl: () => Promise.reject(new Error("public task read used injected client")),
          tasks: { client: publicClient },
        });
        try {
          await publicServer.callTool({ name: "tasks.status", arguments: { id: ID } });
          await publicServer.callTool({ name: "tasks.show", arguments: { id: ID } });
          expect(publicClient.publicTask).toHaveBeenCalledTimes(2);
          const missingBearer = await publicServer.callTool({
            name: "tasks.message",
            arguments: { id: ID, text: "hello" },
          });
          expect(missingBearer).toMatchObject({ isError: true });
          expect(JSON.stringify(missingBearer)).toContain(
            "Sign-in is needed for the acting wallet. Call auth.link.",
          );
        } finally {
          await publicServer.close();
        }

        const unavailableClient = {
          events: vi.fn(async () => {
            throw new TasksClientError("http", "missing route", 404);
          }),
        } as unknown as TasksClient;
        const unavailableServer = createVapiServer({
          account: privateKeyToAccount(PRIVATE_KEY),
          config: getDefaultConfig({}),
          store,
          wallet: "main",
          env: {},
          secretStore: secrets,
          agentLink: { apiBase: API_BASE },
          fetchImpl: () => Promise.reject(new Error("unavailable task used injected client")),
          tasks: {
            client: unavailableClient,
            now: () => new Date(NOW),
            sleep: () => new Promise<void>(() => undefined),
          },
        });
        try {
          const unavailable = await unavailableServer.callTool({
            name: "tasks.watch",
            arguments: { id: ID, waitSeconds: 1 },
          });
          expect(unavailable).toMatchObject({ isError: true });
          expect(JSON.stringify(unavailable)).toContain(
            "watch is not available on this server yet.",
          );
        } finally {
          await unavailableServer.close();
        }
      } finally {
        await behaviorServer.close();
        await rm(home, { recursive: true, force: true });
      }
    } finally {
      await server.close();
    }
  });
});
