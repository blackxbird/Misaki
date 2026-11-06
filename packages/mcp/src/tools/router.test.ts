import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WalletStore, getDefaultConfig, type Receipt, type SecretStore } from "@vapi-network/core";
import {
  RouterClientError,
  type AgentRouterUsage,
  type ChatResult,
} from "@vapi-network/core/router-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createVapiServer, type VapiServerOptions } from "../server.js";

const API_BASE = "https://console.example.test/";
const RESET_TIME = "2026-09-24T00:00:00.000Z";
const OWNER = "0x2222222222222222222222222222222222222222";
const SECRET_PREFIX = ["s", "k", "-"].join("");
const FORBIDDEN_FIELDS = new Set(["key", "apiKey", "secret"]);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("vAPI Router MCP tools", () => {
  it("registers only the four public Router tools with secret-safe schemas and descriptions", async () => {
    const { server } = await routerServer();
    const { tools } = await server.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual(
      expect.arrayContaining(["router.models", "router.usage", "router.chat", "router.buy"]),
    );
    expect(names).not.toContain("router.key");
    for (const name of ["router.models", "router.usage", "router.chat", "router.buy"]) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.description).toContain("OS secret store");
      expect(tool?.description).toContain("never returned");
      expectPublicValue(tool);
    }

    const buy = tools.find((tool) => tool.name === "router.buy");
    expect(buy?.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ["usd"],
      properties: {
        usd: { anyOf: [{ const: 1 }, { const: 5 }, { const: 20 }, { const: 50 }] },
      },
    });

    await server.close();
  });

  it("lists model ids through the guarded fetch and the same API base as auth", async () => {
    const listRouterModels = vi.fn<NonNullable<RouterOverrides["listRouterModels"]>>(async () => [
      { id: "open-model", key: `${SECRET_PREFIX}hidden-model-field` },
      { id: "reasoning-model", owned_by: "vapi", secret: "hidden" },
    ]);
    const { server, fetchImpl } = await routerServer({ listRouterModels });

    const result = await server.callTool({ name: "router.models", arguments: {} });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ models: ["open-model", "reasoning-model"] });
    expect(listRouterModels).toHaveBeenCalledWith({ apiBase: API_BASE, fetchImpl });
    expectPublicValue(result);
    await server.close();
  });

  it("merges usage with owner stake and resolves the session wallet or an explicit wallet", async () => {
    const routerUsage = vi.fn<NonNullable<RouterOverrides["routerUsage"]>>(async () => {
      const value = usage();
      return {
        ...value,
        key: `${SECRET_PREFIX}hidden-usage-field`,
        compute: { ...value.compute, secret: "hidden" },
      };
    });
    const ownerStake = vi.fn<NonNullable<RouterOverrides["ownerStake"]>>(async () => ({
      owner: OWNER,
      stake: "1250000000000000000",
      computeTodayUsd: 5,
      stakeUrl: "https://console.example.test/stake",
      apiKey: `${SECRET_PREFIX}hidden-stake-field`,
    }));
    const { server } = await routerServer({ routerUsage, ownerStake });

    const active = await server.callTool({ name: "router.usage", arguments: {} });
    const explicit = await server.callTool({
      name: "router.usage",
      arguments: { wallet: "work" },
    });

    expect(active.structuredContent).toEqual({
      ...usage(),
      stake: {
        owner: OWNER,
        stake: "1250000000000000000",
        computeTodayUsd: 5,
      },
    });
    expect(explicit.structuredContent).toEqual(active.structuredContent);
    expect(routerUsage.mock.calls.map(([deps]) => deps.wallet)).toEqual(["main", "work"]);
    expect(ownerStake.mock.calls.map(([deps]) => deps.wallet)).toEqual(["main", "work"]);
    for (const result of [active, explicit]) expectPublicValue(result);
    await server.close();
  });

  it("reads usage for an account created after the server started", async () => {
    const routerUsage = vi.fn<NonNullable<RouterOverrides["routerUsage"]>>(async () => usage());
    const { server, store, vaultSecrets } = await routerServer({ routerUsage });
    const terminal = await WalletStore.open(store.home, { secrets: vaultSecrets });
    await terminal.create("fresh", "");

    const result = await server.callTool({ name: "router.usage", arguments: { wallet: "fresh" } });

    expect(result.isError).not.toBe(true);
    expect(routerUsage.mock.calls.map(([deps]) => deps.wallet)).toEqual(["fresh"]);
    await server.close();
  });

  it("returns chat content, model and usage without core-only Router fields", async () => {
    const routerChat = vi.fn<NonNullable<RouterOverrides["routerChat"]>>(async () => chatResult());
    const { server } = await routerServer({ routerChat });

    const result = await server.callTool({
      name: "router.chat",
      arguments: {
        model: "open-model",
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi" },
        ],
        max_tokens: 200,
        wallet: "work",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      content: "Hello from the Router.",
      model: "resolved-model",
      usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 },
    });
    expect(routerChat).toHaveBeenCalledWith(expect.objectContaining({ wallet: "work" }), {
      model: "open-model",
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
      ],
      max_tokens: 200,
    });
    expectPublicValue(result);
    await server.close();
  });

  it("offers chat auto-refill context only for the account unlocked at session start", async () => {
    const routerChat = vi.fn<NonNullable<RouterOverrides["routerChat"]>>(async () => chatResult());
    const { server } = await routerServer({ routerChat });

    await server.callTool({
      name: "router.chat",
      arguments: { model: "open-model", messages: [{ role: "user", content: "active" }] },
    });
    await server.callTool({
      name: "router.chat",
      arguments: {
        model: "open-model",
        messages: [{ role: "user", content: "other" }],
        wallet: "work",
      },
    });

    const activeDeps = routerChat.mock.calls[0]?.[0];
    expect(activeDeps).toMatchObject({ wallet: "main", refill: expect.any(Object) });
    expect(
      typeof activeDeps?.refill?.caps === "function"
        ? await activeDeps.refill.caps()
        : activeDeps?.refill?.caps,
    ).toEqual({ perCallAtomic: "100000", perDayAtomic: "1000000" });
    expect(routerChat.mock.calls[1]?.[0]).toMatchObject({ wallet: "work" });
    expect(routerChat.mock.calls[1]?.[0]).not.toHaveProperty("refill");
    await server.close();
  });

  it.each([
    [
      "an extra tools field",
      { model: "m", messages: [{ role: "user", content: "hi" }], tools: [] },
    ],
    ["a tool message", { model: "m", messages: [{ role: "tool", content: "hi" }] }],
    [
      "max_tokens above 4096",
      { model: "m", messages: [{ role: "user", content: "hi" }], max_tokens: 4097 },
    ],
  ])("rejects %s before calling the Router", async (_case, input) => {
    const routerChat = vi.fn<NonNullable<RouterOverrides["routerChat"]>>(async () => chatResult());
    const { server } = await routerServer({ routerChat });

    const result = await server.callTool({ name: "router.chat", arguments: input });

    expect(result.isError).toBe(true);
    expect(routerChat).not.toHaveBeenCalled();
    expectPublicValue(result);
    await server.close();
  });

  it("returns budget exhaustion with its reset time as a normal tool error", async () => {
    const routerChat = vi.fn<NonNullable<RouterOverrides["routerChat"]>>(async () => {
      throw new RouterClientError(
        "budget_exhausted",
        `Today's Router allowance is used up. It resets at ${RESET_TIME}.`,
        429,
      );
    });
    const { server } = await routerServer({ routerChat });

    const result = await server.callTool({
      name: "router.chat",
      arguments: { model: "open-model", messages: [{ role: "user", content: "Hello" }] },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: `Today's Router allowance is used up. It resets at ${RESET_TIME}.`,
      },
    ]);
    expectPublicValue(result);
    await server.close();
  });

  it("tells an unlinked user how to link without throwing from the MCP call", async () => {
    const routerUsage = vi.fn<NonNullable<RouterOverrides["routerUsage"]>>(async () => {
      throw new RouterClientError("not_linked", "Not linked. Run vapi login.");
    });
    const { server } = await routerServer({ routerUsage });

    const result = await server.callTool({ name: "router.usage", arguments: {} });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Run vapi login");
    expectPublicValue(result);
    await server.close();
  });

  it.each([
    ["zero", "0", 1],
    ["insufficient", "4999999", 5],
  ] as const)(
    "refuses a Router balance purchase when the daily cap is %s without paying or fetching",
    async (_case, perDayAtomic, usd) => {
      const buyRouterBalance = vi.fn<NonNullable<RouterOverrides["buyRouterBalance"]>>();
      const { server, store, fetchImpl } = await routerServer({ buyRouterBalance });
      await store.setSpendCaps("main", { perCallAtomic: "50000000", perDayAtomic });

      const result = await server.callTool({ name: "router.buy", arguments: { usd } });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("vapi wallet caps main");
      expect(buyRouterBalance).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
      expectPublicValue(result);
      await server.close();
    },
  );

  it("reloads the wallet's daily cap before an MCP purchase", async () => {
    const buyRouterBalance = vi.fn<NonNullable<RouterOverrides["buyRouterBalance"]>>();
    const { server, store, fetchImpl, vaultSecrets } = await routerServer({ buyRouterBalance });
    await store.setSpendCaps("main", {
      perCallAtomic: "50000000",
      perDayAtomic: "50000000",
    });
    const writer = await WalletStore.open(store.home, { secrets: vaultSecrets });
    await writer.setSpendCaps("main", { perCallAtomic: "0", perDayAtomic: "0" });

    const result = await server.callTool({ name: "router.buy", arguments: { usd: 1 } });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("vapi wallet caps main");
    expect(buyRouterBalance).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    await server.close();
  });

  it.each([
    {
      label: "the charged quote rather than the requested tier",
      quote: { network: "eip155:5042", amountAtomic: "4750000" },
      evidence: { network: "eip155:8453" },
      amountUsd: 4.75,
      network: "eip155:5042",
    },
    {
      label: "settlement evidence when the quote is absent",
      quote: undefined,
      evidence: { network: "eip155:5042" },
      amountUsd: null,
      network: "eip155:5042",
    },
    {
      label: "unknown values when payment metadata is absent",
      quote: undefined,
      evidence: undefined,
      amountUsd: null,
      network: "unknown",
    },
  ])(
    "reports $label after a successful purchase",
    async ({ quote, evidence, amountUsd, network }) => {
      const receipt: Receipt = {
        id: "receipt-router-5",
        timestamp: "2026-09-23T12:00:00.000Z",
        resourceUrl: `${API_BASE}api/router/top-up/5`,
        quote,
        settlement: { outcome: "succeeded", evidence },
      };
      const buyRouterBalance = vi.fn<NonNullable<RouterOverrides["buyRouterBalance"]>>(
        async () => ({
          receipt,
          balance: null,
        }),
      );
      const { server, store } = await routerServer({ buyRouterBalance });
      await store.setSpendCaps("main", { perCallAtomic: "50000000", perDayAtomic: "50000000" });

      const result = await server.callTool({ name: "router.buy", arguments: { usd: 5 } });

      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.structuredContent).toEqual({
        receipt: { id: receipt.id, amountUsd, network },
        balance: null,
      });
      expect(buyRouterBalance).toHaveBeenCalledTimes(1);
      expectPublicValue(result);
      await server.close();
    },
  );

  it("buys through the injected core seam and returns only a public receipt summary", async () => {
    const buyRouterBalance = vi.fn<NonNullable<RouterOverrides["buyRouterBalance"]>>(async () => ({
      receipt: {
        id: "receipt-router-5",
        timestamp: "2026-09-23T12:00:00.000Z",
        resourceUrl: `${API_BASE}api/router/top-up/5`,
        source: "router.topup",
        quote: {
          network: "eip155:8453",
          amountAtomic: "5000000",
          key: `${SECRET_PREFIX}hidden-receipt-field`,
        },
        settlement: {
          outcome: "succeeded",
          transaction: "0xrouter-topup-transaction",
          token: `${SECRET_PREFIX}hidden-settlement-field`,
        },
        key: `${SECRET_PREFIX}hidden-receipt-field`,
      },
      balance: { purchasedUsd: 5, spentUsd: 0, remainingUsd: 5 },
      token: `${SECRET_PREFIX}hidden-result-field`,
    }));
    const { server, store, fetchImpl } = await routerServer({ buyRouterBalance });
    await store.setSpendCaps("work", {
      perCallAtomic: "50000000",
      perDayAtomic: "50000000",
    });

    const result = await server.callTool({
      name: "router.buy",
      arguments: { usd: 5, wallet: "work" },
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toEqual({
      receipt: {
        id: "receipt-router-5",
        amountUsd: 5,
        network: "eip155:8453",
        transaction: "0xrouter-topup-transaction",
      },
      balance: { purchasedUsd: 5, spentUsd: 0, remainingUsd: 5 },
    });
    expect(buyRouterBalance).toHaveBeenCalledWith(
      expect.objectContaining({
        wallet: "work",
        fetchImpl,
        caps: { perCallAtomic: "50000000", perDayAtomic: "50000000" },
      }),
      5,
    );
    expectPublicValue(result);
    await server.close();
  });

  it.each([{ usd: 2 }, { usd: 1, extra: true }])(
    "rejects a non-tier or extra router.buy field before payment",
    async (input) => {
      const buyRouterBalance = vi.fn<NonNullable<RouterOverrides["buyRouterBalance"]>>();
      const { server, store, fetchImpl } = await routerServer({ buyRouterBalance });
      await store.setSpendCaps("main", {
        perCallAtomic: "50000000",
        perDayAtomic: "50000000",
      });

      const result = await server.callTool({ name: "router.buy", arguments: input });

      expect(result.isError).toBe(true);
      expect(buyRouterBalance).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
      await server.close();
    },
  );
});

type RouterOverrides = NonNullable<VapiServerOptions["router"]>;

async function routerServer(overrides: RouterOverrides = {}) {
  const home = await mkdtemp(join(tmpdir(), "vapi-mcp-router-"));
  temporaryDirectories.push(home);
  const vaultSecrets = memoryStore();
  const store = await WalletStore.open(home, { secrets: vaultSecrets });
  const main = await store.create("main", "");
  await store.create("work", "");
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    throw new Error("The Router MCP tests use injected core functions and make no network call.");
  });
  const server = createVapiServer({
    account: main.account,
    config: getDefaultConfig({}),
    store,
    wallet: "main",
    env: {},
    secretStore: secretStoreStub(),
    fetchImpl,
    agentLink: { apiBase: API_BASE },
    router: {
      listRouterModels: overrides.listRouterModels ?? (async () => []),
      routerUsage: overrides.routerUsage ?? (async () => usage()),
      routerChat: overrides.routerChat ?? (async () => chatResult()),
      ownerStake:
        overrides.ownerStake ??
        (async () => ({
          owner: OWNER,
          stake: "0",
          computeTodayUsd: 0,
          stakeUrl: "https://console.example.test/stake",
        })),
      ...(overrides.buyRouterBalance === undefined
        ? {}
        : { buyRouterBalance: overrides.buyRouterBalance }),
    },
  });
  return { server, store, fetchImpl, vaultSecrets };
}

function memoryStore(): SecretStore {
  const entries = new Map<string, string>();
  return {
    available: true,
    platform: "darwin",
    description: "the macOS Keychain",
    get: async (name) => entries.get(name),
    has: async (name) => entries.has(name),
    set: async (name, value) => {
      entries.set(name, value);
    },
    remove: async (name) => entries.delete(name),
  };
}

function usage(): AgentRouterUsage {
  return {
    compute: {
      allowanceUsd: 2,
      spentTodayUsd: 0.75,
      remainingTodayUsd: 1.25,
      resetsAt: RESET_TIME,
      ownerLimitUsd: 5,
      ownerSpentUsd: 1.5,
    },
    balance: null,
  };
}

function chatResult(): ChatResult {
  const result: ChatResult & { key: string; apiKey: string; secret: string } = {
    content: "Hello from the Router.",
    toolCalls: [{ id: "hidden", name: "hidden", arguments: "{}" }],
    usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 },
    model: "resolved-model",
    keyUsed: "stake",
    key: `${SECRET_PREFIX}hidden-chat-field`,
    apiKey: `${SECRET_PREFIX}hidden-chat-field`,
    secret: `${SECRET_PREFIX}hidden-chat-field`,
  };
  return result;
}

function secretStoreStub(): SecretStore {
  return {
    available: true,
    platform: "darwin",
    description: "the macOS Keychain",
    get: vi.fn(async () => `${SECRET_PREFIX}must-not-cross-the-tool-boundary`),
    has: vi.fn(async () => true),
    set: vi.fn(async () => undefined),
    remove: vi.fn(async () => true),
  };
}

function expectPublicValue(value: unknown): void {
  const visit = (current: unknown): void => {
    if (typeof current === "string") {
      expect(current).not.toContain(SECRET_PREFIX);
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (typeof current !== "object" || current === null) return;
    for (const [name, child] of Object.entries(current)) {
      expect(FORBIDDEN_FIELDS).not.toContain(name);
      visit(child);
    }
  };
  visit(value);
}
