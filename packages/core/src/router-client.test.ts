import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  AGENT_LINK_REVOKED_MESSAGE,
  agentSecretAccounts,
  saveAgentLink,
  type AgentTokens,
} from "./agent-link.js";
import { readAuditLog } from "./audit.js";
import { DEFAULT_SPEND_CAPS, getDefaultConfig } from "./config.js";
import { NETWORKS } from "./networks.js";
import { readReceipts } from "./receipts.js";
import { createRunBudget, type RunBudget } from "./run-budget.js";
import {
  DEFAULT_ROUTER_BASE_URL,
  ROUTER_KEY_REVOKED_MESSAGE,
  RouterClientError,
  buyRouterBalance,
  listRouterModels,
  ownerStake,
  rotateRouterKey,
  routerChat,
  routerCredentials,
  routerUsage,
  type RouterClientDeps,
} from "./router-client.js";
import type { SecretStore } from "./secret-store.js";
import { SpendCapExceededError } from "./spend-cap-exceeded.js";
import { readSpendLedger } from "./spend-policy.js";
import { BASE_MAINNET_CAIP2 } from "./x402-networks.js";
import { WalletStore, type AgentLink } from "./wallet-store.js";
import { purchaseTransport } from "../../../test-fixtures/router-purchase.js";

const API_BASE = "https://console.example";
const ROUTER_BASE = "https://router.example/gateway/";
const ACCESS_TOKEN = "test-agent-access-token";
const ROUTER_KEY = "sk-test-router-key";
const BALANCE_KEY = "sk-test-router-balance-key";
const OWNER = "0x1111111111111111111111111111111111111111" as const;
const RESET_AT = "2026-09-24T00:00:00.000Z";
const NOW = new Date("2026-09-23T10:00:00.000Z");
const PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as Hex;
const PAY_TO = getAddress("0x2222222222222222222222222222222222222222");

const directories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

type MemorySecretStore = SecretStore & {
  entries: Record<string, string>;
  setCalls: Array<[string, string]>;
};

function memorySecretStore(
  initial: Record<string, string> = {},
  available = true,
): MemorySecretStore {
  const entries = { ...initial };
  const setCalls: Array<[string, string]> = [];
  return {
    available,
    platform: available ? "darwin" : "win32",
    description: available ? "the test keychain" : "no OS secret store",
    entries,
    setCalls,
    get: async (name) => entries[name],
    has: async (name) => entries[name] !== undefined,
    set: async (name, value) => {
      setCalls.push([name, value]);
      entries[name] = value;
    },
    remove: async (name) => {
      if (entries[name] === undefined) return false;
      delete entries[name];
      return true;
    },
  };
}

function agentLink(overrides: Partial<AgentLink> = {}): AgentLink {
  return {
    apiBase: API_BASE,
    clientId: `agent_${OWNER.toLowerCase()}`,
    owner: OWNER,
    label: "researcher",
    scopes: ["mcp:call", "router.use"],
    linkedAt: "2026-09-23T10:00:00.000Z",
    routerBaseUrl: ROUTER_BASE,
    ...overrides,
  };
}

function tokens(): AgentTokens {
  return {
    accessToken: ACCESS_TOKEN,
    refreshToken: "test-agent-refresh-token",
    expiresAt: Number.MAX_SAFE_INTEGER,
    scopes: ["mcp:call", "router.use"],
  };
}

async function walletStore(
  link: AgentLink | undefined,
  routerRefill?: { belowUsd: number; tierUsd: 1 | 5 | 20 | 50 },
): Promise<WalletStore> {
  const home = await mkdtemp(join(tmpdir(), "vapi-router-client-"));
  directories.push(home);
  await writeFile(
    join(home, "wallets.json"),
    `${JSON.stringify(
      {
        version: 1,
        default: "main",
        wallets: {
          main: {
            createdAt: "2026-09-23T09:00:00.000Z",
            spendCaps: DEFAULT_SPEND_CAPS,
            ...(link === undefined ? {} : { link }),
            ...(routerRefill === undefined ? {} : { routerRefill }),
          },
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return await WalletStore.open(home);
}

async function linkedDeps(
  fetchImpl: typeof fetch,
  options: {
    link?: AgentLink;
    key?: string;
    balanceKey?: string;
    available?: boolean;
    routerRefill?: { belowUsd: number; tierUsd: 1 | 5 | 20 | 50 };
  } = {},
): Promise<RouterClientDeps & { secrets: MemorySecretStore }> {
  const wallets = await walletStore(options.link ?? agentLink(), options.routerRefill);
  const accounts = agentSecretAccounts("main");
  const secrets = memorySecretStore(
    {
      [accounts.tokens]: JSON.stringify(tokens()),
      ...(options.key === undefined && !Object.hasOwn(options, "key")
        ? { [accounts.routerStake]: ROUTER_KEY }
        : options.key === undefined
          ? {}
          : { [accounts.routerStake]: options.key }),
      ...(options.balanceKey === undefined ? {} : { [accounts.routerBalance]: options.balanceKey }),
    },
    options.available,
  );
  return { secrets, wallets, wallet: "main", fetchImpl };
}

function topupRequired(tierUsd: 1 | 5 | 20 | 50 = 5): Response {
  return new Response(
    JSON.stringify({
      x402Version: 2,
      resource: {
        url: `${API_BASE}/api/router/top-up/${tierUsd}`,
        description: `Prepaid vAPI Router balance, $${tierUsd}.`,
        mimeType: "application/json",
      },
      accepts: [
        {
          scheme: "exact",
          network: BASE_MAINNET_CAIP2,
          amount: String(tierUsd * 1_000_000),
          asset: NETWORKS[BASE_MAINNET_CAIP2].usdc,
          payTo: PAY_TO,
          maxTimeoutSeconds: 60,
          extra: { name: "USD Coin", version: "2" },
        },
      ],
    }),
    { status: 402, headers: { "content-type": "application/json" } },
  );
}

function topupAccepted(tierUsd: 1 | 5 | 20 | 50 = 5): Response {
  return Response.json(
    { status: "accepted", usd: tierUsd, owner: OWNER },
    {
      headers: {
        "payment-response": Buffer.from(
          JSON.stringify({ success: true, transaction: `0x${"33".repeat(32)}` }),
          "utf8",
        ).toString("base64"),
      },
    },
  );
}

function refillOptions(
  wallets: WalletStore,
  caps = { perCallAtomic: "20000000", perDayAtomic: "20000000" },
) {
  const config = getDefaultConfig();
  config.allowPrivateNetwork = true;
  return {
    account: privateKeyToAccount(PRIVATE_KEY),
    config,
    caps,
    paths: {
      ledgerPath: join(wallets.home, "spend-ledger.json"),
      receiptsPath: join(wallets.home, "receipts.jsonl"),
    },
    now: NOW,
  };
}

function usageResponse() {
  return {
    compute: {
      allowanceUsd: 2,
      spentTodayUsd: 0.75,
      remainingTodayUsd: 1.25,
      resetsAt: RESET_AT,
      ownerLimitUsd: 5,
      ownerSpentUsd: 1.5,
    },
    balance: { purchasedUsd: 10, spentUsd: 4, remainingUsd: 6 },
  };
}

describe("routerChat", () => {
  it.each(["console", "credentials", "chat-http", "chat-budget", "chat-key"] as const)(
    "retains the FIRST settled refill across later %s failure and recovers without paying again",
    async (failure) => {
      let paid = 0;
      let failLater = true;
      const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
        if (url.host === "router.example") {
          if (headers.get("authorization") === `Bearer ${ROUTER_KEY}`)
            return new Response("Budget has been exceeded", { status: 429 });
          expect(headers.get("authorization")).toBe(`Bearer ${BALANCE_KEY}`);
          if (failLater && failure.startsWith("chat-"))
            return new Response(
              failure === "chat-budget" ? "Budget has been exceeded" : "unavailable",
              {
                status: failure === "chat-budget" ? 429 : failure === "chat-key" ? 401 : 503,
              },
            );
          return Response.json({ choices: [{ message: { content: "chat recovered" } }] });
        }
        if (url.pathname === "/api/router/top-up/1") {
          if (!headers.has("payment-signature")) return topupRequired(1);
          paid++;
          return topupAccepted(1);
        }
        if (paid > 0 && failLater && failure === "console")
          throw new Error("private-console-error-must-not-leak");
        if (url.pathname === "/api/agents/self/router-balance-key")
          return Response.json({ router_key: BALANCE_KEY, router_base_url: ROUTER_BASE });
        if (url.pathname === "/api/agents/self/router")
          return Response.json({
            ...usageResponse(),
            balance: { purchasedUsd: paid, spentUsd: 0, remainingUsd: paid },
          });
        throw new Error(`Unexpected test URL ${url}`);
      });
      const deps = await linkedDeps(fetchImpl, { routerRefill: { belowUsd: 1, tierUsd: 1 } });
      const balanceAccount = agentSecretAccounts("main").routerBalance;
      expect(deps.secrets.entries[balanceAccount]).toBeUndefined();
      const originalGet = deps.secrets.get;
      deps.secrets.get = async (name) => {
        if (
          failure === "credentials" &&
          failLater &&
          name === balanceAccount &&
          deps.secrets.entries[name]
        )
          throw new Error("private-keystore-error-must-not-leak");
        return await originalGet(name);
      };
      const options = { ...deps, refill: refillOptions(deps.wallets) };
      const error = await routerChat(options, { model: "model", messages: [] }).catch(
        (error: unknown) => error,
      );
      expect(error).toBeInstanceOf(RouterClientError);
      expect(error).toMatchObject({
        code: "refill_pending",
        refill: { receipt: { outcome: "paid", settlement: { outcome: "succeeded" } } },
      });
      expect((error as Error).message).toContain("Payment settled");
      expect((error as Error).message).not.toMatch(/buy|top-up/i);
      expect(JSON.stringify(error)).not.toContain("private-");
      if (failure === "console") {
        expect((error as Error).message).toContain("key is not yet available");
        expect((error as Error).message).toContain("next request");
        expect(error).toMatchObject({
          refill: {
            balance: null,
            warnings: [{ code: "router_key_unavailable" }, { code: "balance_unavailable" }],
          },
        });
      }
      expect(paid).toBe(1);
      failLater = false;
      await expect(routerChat(deps, { model: "model", messages: [] })).resolves.toMatchObject({
        content: "chat recovered",
        keyUsed: "balance",
      });
      expect(deps.secrets.entries[balanceAccount]).toBe(BALANCE_KEY);
      expect(paid).toBe(1);
    },
  );

  it("continues chat and returns the paid refill warning when post-payment usage is unavailable", async () => {
    let chats = 0;
    let usageCalls = 0;
    let paid = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
      if (url.host === "router.example") {
        if (++chats === 1) return new Response("Budget has been exceeded", { status: 429 });
        expect(headers.get("authorization")).toBe(`Bearer ${BALANCE_KEY}`);
        return Response.json({ choices: [{ message: { content: "paid chat continues" } }] });
      }
      if (url.pathname === "/api/agents/self/router") {
        if (++usageCalls > 1) return new Response("unavailable", { status: 503 });
        return Response.json({
          ...usageResponse(),
          balance: { purchasedUsd: 0, spentUsd: 0, remainingUsd: 0 },
        });
      }
      if (url.pathname === "/api/router/top-up/1") {
        if (!headers.has("payment-signature")) return topupRequired(1);
        paid++;
        return topupAccepted(1);
      }
      throw new Error(`Unexpected test URL ${url}`);
    });
    const deps = await linkedDeps(fetchImpl, {
      balanceKey: BALANCE_KEY,
      routerRefill: { belowUsd: 1, tierUsd: 1 },
    });
    const result = await routerChat(
      { ...deps, refill: refillOptions(deps.wallets) },
      { model: "model", messages: [] },
    );
    expect(result).toMatchObject({
      content: "paid chat continues",
      keyUsed: "balance",
      refill: {
        receipt: { outcome: "paid" },
        balance: null,
        warnings: [{ code: "balance_unavailable" }],
      },
    });
    expect(paid).toBe(1);
  });

  it("sends the stake key only to the Router and passes tool fields through", async () => {
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      return Response.json({
        model: "provider/model-version",
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"city":"Utrecht"}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      });
    });
    const deps = await linkedDeps(fetchImpl);
    const tool = { type: "function", function: { name: "get_weather" } };
    const toolChoice = { type: "function", function: { name: "get_weather" } };
    const messages = [
      { role: "user" as const, content: "Weather?" },
      {
        role: "assistant" as const,
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function" as const,
            function: { name: "get_weather", arguments: '{"city":"Utrecht"}' },
          },
        ],
      },
      { role: "tool" as const, content: "Sunny", tool_call_id: "call_1" },
    ];

    const result = await routerChat(deps, {
      model: "provider/model",
      messages,
      max_tokens: 200,
      temperature: 0.2,
      tools: [tool],
      tool_choice: toolChoice,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.host).toBe("router.example");
    expect(calls[0]!.url.pathname).toBe("/gateway/v1/chat/completions");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.redirect).toBe("error");
    expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe(`Bearer ${ROUTER_KEY}`);
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      model: "provider/model",
      messages,
      max_tokens: 200,
      temperature: 0.2,
      tools: [tool],
      tool_choice: toolChoice,
    });
    expect(result).toEqual({
      content: null,
      toolCalls: [{ id: "call_1", name: "get_weather", arguments: '{"city":"Utrecht"}' }],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      model: "provider/model-version",
      keyUsed: "stake",
    });
    expect(
      calls
        .filter(({ url }) => url.host === "console.example")
        .some(
          ({ init }) => new Headers(init?.headers).get("authorization") === `Bearer ${ROUTER_KEY}`,
        ),
    ).toBe(false);
  });

  it("refuses redirects so the authorization header cannot cross hosts", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.redirect).toBe("error");
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    });

    await expect(
      routerChat(await linkedDeps(fetchImpl), { model: "provider/model", messages: [] }),
    ).resolves.toMatchObject({ content: "ok", keyUsed: "stake" });
  });

  it("reads the Router base URL and key from one link generation", async () => {
    const calls: Array<{ url: URL; authorization: string | null }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      calls.push({
        url: new URL(String(input)),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    });
    const deps = await linkedDeps(fetchImpl);
    const oldEntry = deps.wallets.entry("main")!;
    const newKey = "sk-test-new-owner-key";
    const newLink = agentLink({
      owner: "0x2222222222222222222222222222222222222222",
      linkedAt: "2026-09-23T11:00:00.000Z",
      routerBaseUrl: "https://new-owner-router.example",
    });
    let activeLink = oldEntry.link!;
    let linkReads = 0;
    vi.spyOn(deps.wallets, "entry").mockImplementation((name) => {
      if (name !== "main") return undefined;
      const entry = { ...oldEntry, link: activeLink };
      if (linkReads++ === 0) {
        activeLink = newLink;
        deps.secrets.entries[agentSecretAccounts("main").routerStake] = newKey;
      }
      return entry;
    });

    await expect(
      routerChat(deps, { model: "provider/model", messages: [] }),
    ).resolves.toMatchObject({ content: "ok" });

    expect(calls).toEqual([
      {
        url: new URL("https://new-owner-router.example/v1/chat/completions"),
        authorization: `Bearer ${newKey}`,
      },
    ]);
  });

  it.each([false, true])(
    "returns rate_limited without fallback or refill (refill %s)",
    async (refill) => {
      const calls: Array<{ url: URL; authorization: string | null }> = [];
      const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(String(input));
        calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
        if (url.host === "router.example")
          return new Response("rate limited", { status: 429, headers: { "retry-after": "30" } });
        if (url.pathname === "/api/agents/self/router") return Response.json(usageResponse());
        throw new Error(`Unexpected test URL ${url.origin}${url.pathname}`);
      });

      const deps = await linkedDeps(fetchImpl, {
        balanceKey: BALANCE_KEY,
        ...(refill ? { routerRefill: { belowUsd: 10, tierUsd: 1 } } : {}),
      });
      await expect(
        routerChat(
          { ...deps, ...(refill ? { refill: refillOptions(deps.wallets) } : {}) },
          { model: "provider/model", messages: [] },
        ),
      ).rejects.toMatchObject({
        name: "RouterClientError",
        code: "rate_limited",
        status: 429,
        message: "The vAPI Router is rate limited. Retry after 30 seconds.",
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.authorization).toBe(`Bearer ${ROUTER_KEY}`);
      expect(
        calls.some(
          ({ url, authorization }) =>
            url.host === "console.example" && authorization === `Bearer ${ROUTER_KEY}`,
        ),
      ).toBe(false);
    },
  );

  it("falls back to the stored balance key after the stake allowance is exhausted", async () => {
    const routerAuthorizations: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
      if (url.host === "router.example") {
        routerAuthorizations.push(headers.get("authorization") ?? "");
        if (routerAuthorizations.length === 1)
          return new Response("Budget has been exceeded", { status: 429 });
        return Response.json({ choices: [{ message: { content: "balance answer" } }] });
      }
      if (url.pathname === "/api/agents/self/router") {
        expect(headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
        expect(headers.get("authorization")).not.toContain(BALANCE_KEY);
        return Response.json(usageResponse());
      }
      throw new Error(`Unexpected test URL ${url.origin}${url.pathname}`);
    });

    await expect(
      routerChat(await linkedDeps(fetchImpl, { balanceKey: BALANCE_KEY }), {
        model: "provider/model",
        messages: [],
      }),
    ).resolves.toMatchObject({ content: "balance answer", keyUsed: "balance" });
    expect(routerAuthorizations).toEqual([`Bearer ${ROUTER_KEY}`, `Bearer ${BALANCE_KEY}`]);
  });

  it.each([
    { remainingUsd: 1, expectedTopups: 2 },
    { remainingUsd: 6, expectedTopups: 0 },
  ])(
    "auto-refills only below the configured floor (remaining $remainingUsd)",
    async ({ remainingUsd, expectedTopups }) => {
      let routerCalls = 0;
      let usageCalls = 0;
      const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
        if (url.host === "router.example") {
          routerCalls += 1;
          if (routerCalls === 1) return new Response("Budget has been exceeded", { status: 429 });
          expect(headers.get("authorization")).toBe(`Bearer ${BALANCE_KEY}`);
          return Response.json({ choices: [{ message: { content: "from balance" } }] });
        }
        if (url.pathname === "/api/agents/self/router") {
          usageCalls += 1;
          return Response.json({
            ...usageResponse(),
            balance: {
              purchasedUsd: 10 + (usageCalls > 1 ? 1 : 0),
              spentUsd: 10 - remainingUsd,
              remainingUsd: remainingUsd + (usageCalls > 1 ? 1 : 0),
            },
          });
        }
        if (url.pathname === "/api/router/top-up/1") {
          return headers.has("payment-signature") ? topupAccepted(1) : topupRequired(1);
        }
        throw new Error(`Unexpected test URL ${url.origin}${url.pathname}`);
      });
      const deps = await linkedDeps(fetchImpl, {
        balanceKey: BALANCE_KEY,
        routerRefill: { belowUsd: 5, tierUsd: 1 },
      });

      await expect(
        routerChat(
          { ...deps, refill: refillOptions(deps.wallets) },
          { model: "provider/model", messages: [] },
        ),
      ).resolves.toMatchObject({ content: "from balance", keyUsed: "balance" });

      const topupCalls = fetchImpl.mock.calls.filter(([input]) =>
        String(input instanceof Request ? input.url : input).includes("/api/router/top-up/1"),
      );
      expect(topupCalls).toHaveLength(expectedTopups);
    },
  );

  it("audits a spend-cap-declined refill and still uses the remaining balance", async () => {
    let routerCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
      if (url.host === "router.example") {
        routerCalls += 1;
        if (routerCalls === 1) return new Response("Budget has been exceeded", { status: 429 });
        expect(headers.get("authorization")).toBe(`Bearer ${BALANCE_KEY}`);
        return Response.json({ choices: [{ message: { content: "still available" } }] });
      }
      if (url.pathname === "/api/agents/self/router") {
        return Response.json({
          ...usageResponse(),
          balance: { purchasedUsd: 10, spentUsd: 9, remainingUsd: 1 },
        });
      }
      if (url.pathname === "/api/router/top-up/1") return topupRequired(1);
      throw new Error(`Unexpected test URL ${url.origin}${url.pathname}`);
    });
    const deps = await linkedDeps(fetchImpl, {
      balanceKey: BALANCE_KEY,
      routerRefill: { belowUsd: 5, tierUsd: 1 },
    });

    await expect(
      routerChat(
        {
          ...deps,
          refill: refillOptions(deps.wallets, {
            perCallAtomic: "500000",
            perDayAtomic: "500000",
          }),
        },
        { model: "provider/model", messages: [] },
      ),
    ).resolves.toMatchObject({ content: "still available", keyUsed: "balance" });

    await expect(readAuditLog(deps.wallets.home)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "router.refill.declined",
          wallet: "main",
          detail: "SpendCapExceededError: per_call",
        }),
      ]),
    );
    expect(
      fetchImpl.mock.calls.filter(([input]) =>
        String(input instanceof Request ? input.url : input).includes("/api/router/top-up/1"),
      ),
    ).toHaveLength(1);
  });

  it("audits and rethrows a run-budget-declined refill across bundle boundaries", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.host === "router.example")
        return new Response("Budget has been exceeded", { status: 429 });
      if (url.pathname === "/api/agents/self/router") {
        return Response.json({
          ...usageResponse(),
          balance: { purchasedUsd: 10, spentUsd: 9, remainingUsd: 1 },
        });
      }
      if (url.pathname === "/api/router/top-up/1") return topupRequired(1);
      throw new Error(`Unexpected test URL ${url.origin}${url.pathname}`);
    });
    const deps = await linkedDeps(fetchImpl, {
      balanceKey: BALANCE_KEY,
      routerRefill: { belowUsd: 5, tierUsd: 1 },
    });
    const foreignBudgetError = Object.assign(new Error("Run budget exceeded."), {
      name: "RunBudgetError",
      code: "run_budget_exceeded",
    });
    const runBudget: RunBudget = {
      id: "run_test",
      limitAtomic: 999_999n,
      spentAtomic: () => 0n,
      reservedAtomic: () => 0n,
      reserve() {
        throw foreignBudgetError;
      },
      release() {},
    };

    await expect(
      routerChat(
        {
          ...deps,
          refill: { ...refillOptions(deps.wallets), runBudget },
        },
        { model: "provider/model", messages: [] },
      ),
    ).rejects.toMatchObject({
      name: "SpendCapExceededError",
      code: "spend_cap_exceeded",
      cap: "run_budget",
      cause: foreignBudgetError,
    });

    expect(runBudget.spentAtomic()).toBe(0n);
    await expect(readAuditLog(deps.wallets.home)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "router.refill.declined",
          wallet: "main",
          detail: "SpendCapExceededError: run_budget",
        }),
      ]),
    );
  });

  it("stops a refill at the run budget without retrying or keeping a wallet reservation", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.host === "router.example")
        return new Response("Budget has been exceeded", { status: 429 });
      if (url.pathname === "/api/agents/self/router") {
        return Response.json({
          ...usageResponse(),
          balance: { purchasedUsd: 10, spentUsd: 9, remainingUsd: 1 },
        });
      }
      if (url.pathname === "/api/router/top-up/1") return topupRequired(1);
      throw new Error(`Unexpected test URL ${url.origin}${url.pathname}`);
    });
    const deps = await linkedDeps(fetchImpl, {
      balanceKey: BALANCE_KEY,
      routerRefill: { belowUsd: 5, tierUsd: 1 },
    });
    const runBudget = createRunBudget({ id: "run_refill", limitAtomic: 999_999n });
    const refill = { ...refillOptions(deps.wallets), runBudget };

    const error = await routerChat(
      { ...deps, refill },
      { model: "provider/model", messages: [] },
    ).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(SpendCapExceededError);
    expect(error).toMatchObject({
      cap: "run_budget",
      amountUsd: "1",
      limitUsd: "0.999999",
      spentUsd: "0",
      command: "--budget 1",
      retryable: false,
    });
    expect(runBudget.spentAtomic()).toBe(0n);
    await expect(readSpendLedger(refill.paths.ledgerPath, NOW, "main")).resolves.toMatchObject({
      spentAtomic: "0",
    });
    expect(
      fetchImpl.mock.calls.filter(([input]) =>
        String(input instanceof Request ? input.url : input).includes("/api/router/top-up/1"),
      ),
    ).toHaveLength(1);
    expect(
      fetchImpl.mock.calls.filter(([input]) =>
        String(input instanceof Request ? input.url : input).includes("router.example"),
      ),
    ).toHaveLength(1);
  });

  it("writes the run descriptor on an automatic refill receipt", async () => {
    let routerCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.host === "router.example") {
        routerCalls += 1;
        if (routerCalls === 1) return new Response("Budget has been exceeded", { status: 429 });
        return Response.json({ choices: [{ message: { content: "from balance" } }] });
      }
      if (url.pathname === "/api/agents/self/router") {
        return Response.json({
          ...usageResponse(),
          balance: { purchasedUsd: 10, spentUsd: 9, remainingUsd: 1 },
        });
      }
      if (url.pathname === "/api/router/top-up/1") {
        return request.headers.has("payment-signature") ? topupAccepted(1) : topupRequired(1);
      }
      throw new Error(`Unexpected test URL ${url.origin}${url.pathname}`);
    });
    const deps = await linkedDeps(fetchImpl, {
      balanceKey: BALANCE_KEY,
      routerRefill: { belowUsd: 5, tierUsd: 1 },
    });
    const run = {
      id: "run_000102030405060708090a0b",
      swarm: "research",
      member: "research-lead-1",
    };

    await expect(
      routerChat(
        { ...deps, refill: { ...refillOptions(deps.wallets), run } },
        { model: "provider/model", messages: [] },
      ),
    ).resolves.toMatchObject({ content: "from balance", keyUsed: "balance" });

    await expect(readReceipts(join(deps.wallets.home, "receipts.jsonl"))).resolves.toMatchObject([
      { source: "router.topup", run },
    ]);
  });

  it("keeps stake, balance, and access credentials out of errors, audits, and receipts", async () => {
    let routerCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.host === "router.example") {
        routerCalls += 1;
        return new Response(routerCalls === 1 ? `ExceededBudget ${ROUTER_KEY}` : BALANCE_KEY, {
          status: routerCalls === 1 ? 429 : 401,
        });
      }
      if (url.pathname === "/api/agents/self/router") {
        return Response.json({
          ...usageResponse(),
          balance: { purchasedUsd: 10, spentUsd: 9, remainingUsd: 1 },
        });
      }
      if (url.pathname === "/api/router/top-up/1") {
        return new Response(JSON.stringify({ x402Version: ACCESS_TOKEN }), {
          status: 402,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected test URL ${url.origin}${url.pathname}`);
    });
    const deps = await linkedDeps(fetchImpl, {
      balanceKey: BALANCE_KEY,
      routerRefill: { belowUsd: 5, tierUsd: 1 },
    });

    const thrown = await routerChat(
      { ...deps, refill: refillOptions(deps.wallets) },
      { model: "provider/model", messages: [] },
    ).then(
      () => new Error("Expected the rejected balance key to fail."),
      (error: unknown) => error as Error,
    );
    const audit = await readFile(join(deps.wallets.home, "audit.log"), "utf8");
    const receipts = await readFile(join(deps.wallets.home, "receipts.jsonl"), "utf8");
    const exposed = `${thrown.message}\n${audit}\n${receipts}`;
    expect(exposed).not.toContain(ROUTER_KEY);
    expect(exposed).not.toContain(BALANCE_KEY);
    expect(exposed).not.toContain(ACCESS_TOKEN);
  });

  it("maps an ExceededBudget response with another status to budget_exhausted", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.host === "router.example") {
        return new Response('{"error":"ExceededBudget"}', { status: 400 });
      }
      return Response.json(usageResponse());
    });

    await expect(
      routerChat(await linkedDeps(fetchImpl), { model: "provider/model", messages: [] }),
    ).rejects.toMatchObject({ code: "budget_exhausted", status: 400 });
  });

  it("maps a revoked key response to no_router_key", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/agents/self/router") return Response.json(usageResponse());
      return new Response("revoked", { status: 401 });
    });

    await expect(
      routerChat(await linkedDeps(fetchImpl), { model: "provider/model", messages: [] }),
    ).rejects.toMatchObject({
      code: "no_router_key",
      status: 401,
      message: ROUTER_KEY_REVOKED_MESSAGE,
    });
  });

  it("maps a revoked agent link before reporting the Router key as rejected", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.host === "router.example") return new Response("revoked", { status: 401 });
      if (url.pathname === "/api/agents/self/router") return new Response(null, { status: 401 });
      if (url.pathname === "/oauth/token") {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      throw new Error(`Unexpected test URL ${url.origin}${url.pathname}`);
    });

    await expect(
      routerChat(await linkedDeps(fetchImpl), { model: "provider/model", messages: [] }),
    ).rejects.toMatchObject({
      code: "not_linked",
      message: AGENT_LINK_REVOKED_MESSAGE,
    });
  });

  it("rejects an unlinked wallet", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const wallets = await walletStore(undefined);
    const secrets = memorySecretStore();

    await expect(
      routerChat(
        { secrets, wallets, wallet: "main", fetchImpl },
        { model: "provider/model", messages: [] },
      ),
    ).rejects.toMatchObject({
      code: "not_linked",
      message: "Not linked. Run vapi login.",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a missing Router key", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      routerChat(await linkedDeps(fetchImpl, { key: undefined }), {
        model: "provider/model",
        messages: [],
      }),
    ).rejects.toMatchObject({
      code: "no_router_key",
      message: "No Router key is stored for this wallet. Run vapi router key --rotate.",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a non-https Router base before sending a request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const deps = await linkedDeps(fetchImpl, {
      link: agentLink({ routerBaseUrl: "http://router.example" }),
    });

    await expect(routerChat(deps, { model: "provider/model", messages: [] })).rejects.toMatchObject(
      { code: "http" },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not include the Router key or response body in an error", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(`upstream failure ${ROUTER_KEY}`, { status: 503 }),
    );

    let thrown: unknown;
    try {
      await routerChat(await linkedDeps(fetchImpl), {
        model: "provider/model",
        messages: [],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RouterClientError);
    expect(thrown).toMatchObject({ code: "http", status: 503 });
    expect((thrown as Error).message).toBe("vAPI Router returned HTTP 503.");
    expect((thrown as Error).message).not.toContain(ROUTER_KEY);
  });
});

describe("buyRouterBalance", () => {
  it("refuses a Router top-up after the remote allowance expires", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const deps = await linkedDeps(fetchImpl);
    const allowanceExpiresAt = new Date("2026-09-24T00:00:00.000Z");

    await expect(
      buyRouterBalance(
        {
          ...deps,
          ...refillOptions(deps.wallets),
          now: new Date("2026-09-24T00:00:01.000Z"),
          allowanceExpiresAt,
        },
        1,
      ),
    ).rejects.toThrow(`Remote allowance expired at ${allowanceExpiresAt.toISOString()}`);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps a revoked agent link when the console rejects a balance purchase", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/api/router/top-up/1") {
        return new Response("revoked", { status: 401 });
      }
      if (url.pathname === "/api/agents/self/router") {
        return new Response(null, { status: 401 });
      }
      if (url.pathname === "/oauth/token") {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      throw new Error(`Unexpected test URL ${url.origin}${url.pathname}`);
    });
    const deps = await linkedDeps(fetchImpl);

    await expect(
      buyRouterBalance({ ...deps, ...refillOptions(deps.wallets) }, 1),
    ).rejects.toMatchObject({
      code: "not_linked",
      message: AGENT_LINK_REVOKED_MESSAGE,
    });
  });

  it("never combines an access token with a different link generation's API base", async () => {
    const mixedRequests: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      mixedRequests.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
      });
      throw new Error("A mixed-generation request must not be sent.");
    });
    const deps = await linkedDeps(fetchImpl);
    const oldEntry = deps.wallets.entry("main")!;
    const newAccessToken = "test-new-owner-access-token";
    const newLink = agentLink({
      apiBase: "https://new-console.example",
      owner: "0x2222222222222222222222222222222222222222",
      linkedAt: "2026-09-23T11:00:00.000Z",
    });
    let activeLink = oldEntry.link!;
    let linkReads = 0;
    vi.spyOn(deps.wallets, "entry").mockImplementation((name) => {
      if (name !== "main") return undefined;
      const entry = { ...oldEntry, link: activeLink };
      if (linkReads++ === 0) {
        activeLink = newLink;
        deps.secrets.entries[agentSecretAccounts("main").tokens] = JSON.stringify({
          ...tokens(),
          accessToken: newAccessToken,
        });
      }
      return entry;
    });

    await expect(
      buyRouterBalance({ ...deps, ...refillOptions(deps.wallets) }, 1),
    ).rejects.toMatchObject({
      code: "http",
      message: expect.stringMatching(/link changed/iu),
    });
    expect(mixedRequests).toEqual([]);
  });

  it("pays with the agent bearer, mints one balance key, stores it, and returns usage", async () => {
    const calls: Array<{ url: URL; authorization: string | null; hasPayment: boolean }> = [];
    let mintCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
      calls.push({
        url,
        authorization: headers.get("authorization"),
        hasPayment: headers.has("payment-signature"),
      });
      if (url.pathname === "/api/router/top-up/5") {
        return headers.has("payment-signature") ? topupAccepted() : topupRequired();
      }
      if (url.pathname === "/api/agents/self/router-balance-key") {
        mintCalls += 1;
        return Response.json({ router_key: BALANCE_KEY, router_base_url: ROUTER_BASE });
      }
      if (url.pathname === "/api/agents/self/router") return Response.json(usageResponse());
      throw new Error(`Unexpected test URL ${url.origin}${url.pathname}`);
    });
    const deps = await linkedDeps(fetchImpl);
    const buyDeps = { ...deps, ...refillOptions(deps.wallets) };

    const first = await buyRouterBalance(buyDeps, 5);
    const second = await buyRouterBalance(buyDeps, 5);

    expect(first.receipt).toMatchObject({
      outcome: "paid",
      source: "router.topup",
      quote: { network: BASE_MAINNET_CAIP2, amountAtomic: "5000000" },
    });
    expect(first.balance).toEqual(usageResponse().balance);
    expect(second.balance).toEqual(usageResponse().balance);
    expect(mintCalls).toBe(1);
    expect(deps.secrets.entries[agentSecretAccounts("main").routerBalance]).toBe(BALANCE_KEY);
    expect(calls.filter(({ url }) => url.pathname === "/api/router/top-up/5")).toHaveLength(4);
    expect(
      calls
        .filter(({ url }) => url.host === "console.example")
        .every(({ authorization }) => authorization === `Bearer ${ACCESS_TOKEN}`),
    ).toBe(true);
    expect(
      calls.some(
        ({ url, authorization }) =>
          url.host === "console.example" && authorization === `Bearer ${BALANCE_KEY}`,
      ),
    ).toBe(false);
    expect(calls.filter(({ hasPayment }) => hasPayment)).toHaveLength(2);
  });

  it("keeps a mismatched Router base key out of the secret store after payment", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      const url = new URL(request.url);
      if (url.pathname === "/api/router/top-up/1") {
        return request.headers.has("payment-signature") ? topupAccepted(1) : topupRequired(1);
      }
      if (url.pathname === "/api/agents/self/router-balance-key") {
        return Response.json({
          router_key: BALANCE_KEY,
          router_base_url: "https://other-router.example",
        });
      }
      if (url.pathname === "/api/agents/self/router") return Response.json(usageResponse());
      throw new Error(`Unexpected test URL ${url.origin}${url.pathname}`);
    });
    const deps = await linkedDeps(fetchImpl);

    await expect(
      buyRouterBalance({ ...deps, ...refillOptions(deps.wallets) }, 1),
    ).resolves.toMatchObject({
      receipt: { outcome: "paid" },
      warnings: [{ code: "router_key_unavailable" }],
    });
    expect(deps.secrets.entries[agentSecretAccounts("main").routerBalance]).toBeUndefined();
    expect(await readFile(join(deps.wallets.home, "receipts.jsonl"), "utf8")).toContain(
      '"outcome":"paid"',
    );
  });

  it("refreshes a rejected token while fetching the balance key after payment", async () => {
    let balanceKeyCalls = 0;
    const refreshedAccessToken = "test-refreshed-access-token";
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/api/router/top-up/1") {
        return request.headers.has("payment-signature") ? topupAccepted(1) : topupRequired(1);
      }
      if (url.pathname === "/api/agents/self/router-balance-key") {
        balanceKeyCalls += 1;
        if (balanceKeyCalls === 1) return new Response("expired", { status: 401 });
        expect(request.headers.get("authorization")).toBe(`Bearer ${refreshedAccessToken}`);
        return Response.json({ router_key: BALANCE_KEY, router_base_url: ROUTER_BASE });
      }
      if (url.pathname === "/oauth/token") {
        return Response.json({
          access_token: refreshedAccessToken,
          refresh_token: "test-refreshed-refresh-token",
          expires_in: 3600,
          scope: "mcp:call router.use",
        });
      }
      if (url.pathname === "/api/agents/self/router") return Response.json(usageResponse());
      throw new Error(`Unexpected test URL ${url.origin}${url.pathname}`);
    });
    const deps = await linkedDeps(fetchImpl);

    await expect(
      buyRouterBalance({ ...deps, ...refillOptions(deps.wallets) }, 1),
    ).resolves.toMatchObject({ balance: usageResponse().balance });
    expect(balanceKeyCalls).toBe(2);
    expect(deps.secrets.entries[agentSecretAccounts("main").routerBalance]).toBe(BALANCE_KEY);
  });
});

describe("confirmed Router purchases", () => {
  it.each(["receipt", "key-store"] as const)(
    "returns the confirmed receipt when %s persistence fails",
    async (failure) => {
      const deps = await linkedDeps(vi.fn());
      const transport = purchaseTransport(deps.wallets.home, failure, ROUTER_BASE);
      if (failure === "key-store") {
        const set = deps.secrets.set.bind(deps.secrets);
        vi.spyOn(deps.secrets, "set").mockImplementation(async (account, value) => {
          if (account === agentSecretAccounts("main").routerBalance)
            throw new Error("private-store-error-must-not-leak");
          await set(account, value);
        });
      }
      const result = await buyRouterBalance(
        { ...deps, ...refillOptions(deps.wallets), fetchImpl: transport.fetchImpl },
        5,
      );
      expect(transport.calls.paid).toBe(1);
      expect(result.receipt).toMatchObject({
        outcome: "paid",
        settlement: { outcome: "succeeded" },
      });
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: failure === "receipt" ? "receipt_unavailable" : "router_key_unavailable",
          }),
        ]),
      );
      expect(JSON.stringify(result)).not.toContain("private-store-error-must-not-leak");
    },
  );

  it.each(["audit", "key", "balance", "all", "response"] as const)(
    "returns the paid receipt when %s follow-up fails",
    async (failure) => {
      const deps = await linkedDeps(vi.fn());
      const { fetchImpl, calls } = purchaseTransport(deps.wallets.home, failure, ROUTER_BASE);
      const result = await buyRouterBalance(
        { ...deps, ...refillOptions(deps.wallets), fetchImpl },
        5,
      );
      expect(calls.paid).toBe(1);
      expect(result.receipt).toMatchObject({
        outcome: "paid",
        settlement: { outcome: "succeeded" },
        quote: { amountAtomic: "4750000" },
      });
      expect(result).toMatchObject({
        warnings:
          failure === "all"
            ? [
                { code: "audit_unavailable" },
                { code: "router_key_unavailable" },
                { code: "balance_unavailable" },
              ]
            : [
                {
                  code:
                    failure === "response"
                      ? "purchase_response_unavailable"
                      : failure === "audit"
                        ? "audit_unavailable"
                        : failure === "key"
                          ? "router_key_unavailable"
                          : "balance_unavailable",
                },
              ],
      });
      expect(calls.key).toBe(1);
      expect(calls.balance).toBe(1);
      expect(result.balance).toEqual(
        failure === "balance" || failure === "all"
          ? null
          : { purchasedUsd: 5, spentUsd: 0, remainingUsd: 5 },
      );
      expect((await readReceipts(join(deps.wallets.home, "receipts.jsonl")))[0]?.id).toBe(
        result.receipt.id,
      );
      expect(JSON.stringify(result)).not.toContain("private-follow-up-error-must-not-leak");
    },
  );
});

describe("console Router endpoints", () => {
  it("parses Router usage and owner stake contracts", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/agents/self/router") return Response.json(usageResponse());
      if (url.pathname === "/api/agents/self/stake") {
        return Response.json({
          owner: OWNER,
          epoch: 42,
          stake: "1000000000000000000",
          computeTodayUsd: 5,
          stakeUrl: "https://console.example/stake",
        });
      }
      throw new Error(`Unexpected test URL ${url.origin}${url.pathname}`);
    });
    const deps = await linkedDeps(fetchImpl);

    await expect(routerUsage(deps)).resolves.toEqual(usageResponse());
    await expect(ownerStake(deps)).resolves.toEqual({
      owner: OWNER,
      stake: "1000000000000000000",
      computeTodayUsd: 5,
      stakeUrl: "https://console.example/stake",
    });
  });

  it("maps an agentFetch not_linked error to RouterClientError", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const deps = await linkedDeps(fetchImpl);
    await deps.secrets.remove(agentSecretAccounts("main").tokens);

    await expect(routerUsage(deps)).rejects.toMatchObject({
      name: "RouterClientError",
      code: "not_linked",
      message: "Not linked. Run vapi login.",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stores a rotated key, updates the Router base, and returns undefined", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/agents/self/router-key");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
      expect(new Headers(init?.headers).get("authorization")).not.toBe(`Bearer ${ROUTER_KEY}`);
      return Response.json({
        router_key: "sk-test-rotated-key",
        router_base_url: "https://new-router.example/base/",
      });
    });
    const deps = await linkedDeps(fetchImpl);

    await expect(rotateRouterKey(deps)).resolves.toBeUndefined();

    const accounts = agentSecretAccounts("main");
    expect(deps.secrets.entries[accounts.routerStake]).toBe("sk-test-rotated-key");
    await deps.wallets.reload();
    expect(deps.wallets.entry("main")?.link?.routerBaseUrl).toBe(
      "https://new-router.example/base/",
    );
  });

  it("refuses an invalid rotated Router base without storing the returned key", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        router_key: "sk-test-rotated-key",
        router_base_url: "https://user:password@router.example",
      }),
    );
    const deps = await linkedDeps(fetchImpl);

    await expect(rotateRouterKey(deps)).rejects.toMatchObject({ code: "http" });
    expect(deps.secrets.setCalls).toEqual([]);
    expect(deps.secrets.entries[agentSecretAccounts("main").routerStake]).toBe(ROUTER_KEY);
  });

  it("does not apply an old rotation response after the wallet is relinked", async () => {
    let rotationRequested!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      rotationRequested = resolve;
    });
    let releaseRotation!: () => void;
    const rotationGate = new Promise<void>((resolve) => {
      releaseRotation = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname !== "/api/agents/self/router-key") {
        throw new Error(`Unexpected test URL ${url.origin}${url.pathname}`);
      }
      rotationRequested();
      await rotationGate;
      return Response.json({
        router_key: "sk-test-stale-rotation-key",
        router_base_url: "https://stale-router.example",
      });
    });
    const deps = await linkedDeps(fetchImpl);
    const rotation = rotateRouterKey(deps);
    await requestStarted;

    const newOwner = "0x2222222222222222222222222222222222222222" as const;
    const newRouterKey = "sk-test-new-owner-key";
    const newRouterBaseUrl = "https://new-owner-router.example";
    await saveAgentLink({
      secrets: deps.secrets,
      wallets: deps.wallets,
      wallet: "main",
      start: {
        clientId: agentLink().clientId,
        deviceCode: "new-device-code",
        userCode: "NEW-CODE",
        verificationUri: `${API_BASE}/link`,
        verificationUriComplete: `${API_BASE}/link?code=NEW-CODE`,
        expiresIn: 600,
        interval: 5,
        autoApproved: false,
      },
      result: {
        tokens: {
          accessToken: "new-owner-access-token",
          refreshToken: "new-owner-refresh-token",
          expiresAt: Number.MAX_SAFE_INTEGER,
          scopes: ["mcp:call", "router.use"],
        },
        owner: newOwner,
        routerKey: newRouterKey,
        routerBaseUrl: newRouterBaseUrl,
      },
      apiBase: API_BASE,
      label: "new owner",
    });
    releaseRotation();

    await expect(rotation).rejects.toMatchObject({
      code: "http",
      message: "The agent link changed during Router key rotation.",
    });
    await deps.wallets.reload();
    expect(deps.wallets.entry("main")?.link).toMatchObject({
      owner: newOwner,
      routerBaseUrl: newRouterBaseUrl,
    });
    expect(deps.secrets.entries[agentSecretAccounts("main").routerStake]).toBe(newRouterKey);
  });
});

describe("listRouterModels", () => {
  it("lists models without an Authorization header", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(`${API_BASE}/api/router/models`);
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return Response.json({ models: [{ id: "provider/model", context_window: 128_000 }] });
    });

    await expect(listRouterModels({ apiBase: `${API_BASE}/`, fetchImpl })).resolves.toEqual([
      { id: "provider/model", context_window: 128_000 },
    ]);
  });
});

describe("routerCredentials", () => {
  it("returns the selected account's balance key and Router URL without a request or purchase", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const deps = await linkedDeps(fetchImpl, { balanceKey: BALANCE_KEY });
    deps.secrets.entries[agentSecretAccounts("other").routerBalance] = "other-account-key";
    await expect(routerCredentials(deps, { funding: "balance" })).resolves.toEqual({
      baseURL: "https://router.example/gateway/v1",
      apiKey: BALANCE_KEY,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(deps.secrets.setCalls).toEqual([]);
    await expect(routerCredentials(deps)).resolves.toMatchObject({ apiKey: ROUTER_KEY });
  });

  it("does not substitute another account's key or the Compute key when a balance key is absent", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const deps = await linkedDeps(fetchImpl);
    deps.secrets.entries[agentSecretAccounts("other").routerBalance] = BALANCE_KEY;
    await expect(routerCredentials(deps, { funding: "balance" })).rejects.toMatchObject({
      code: "no_router_key",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(deps.secrets.setCalls).toEqual([]);
  });

  it("rejects balance credentials without an available secret store", async () => {
    const deps = await linkedDeps(vi.fn(), { balanceKey: BALANCE_KEY, available: false });
    await expect(routerCredentials(deps, { funding: "balance" })).rejects.toMatchObject({
      code: "no_router_key",
    });
  });

  it("returns the OpenAI-compatible base URL and stored stake key", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const deps = await linkedDeps(fetchImpl, {
      link: agentLink({ routerBaseUrl: undefined }),
    });

    await expect(routerCredentials(deps)).resolves.toEqual({
      baseURL: `${DEFAULT_ROUTER_BASE_URL}/v1`,
      apiKey: ROUTER_KEY,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
