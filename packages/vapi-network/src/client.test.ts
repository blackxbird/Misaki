import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BASE_MAINNET_CAIP2,
  VAULT_LOCKED_MESSAGE,
  VAULT_SESSION_ACCOUNT,
  WalletStore,
  createKeystoreFromPrivateKey,
  drainCeilingSweeps,
  getDefaultConfig,
  getVapiPaths,
  lockVault,
  protectVault,
  unlockProtectedVault,
  writeAgentProfile,
  type AgentLink,
  type SecretStore,
  type SpendCaps,
} from "@vapi-network/core";
import { agentSecretAccounts } from "@vapi-network/core/agent-link";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createVapiClient } from "./client.js";

const PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const PASSPHRASE = "test-only-passphrase";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const ACCESS_TOKEN = "test-agent-access-token";
const ROUTER_KEY = "sk-test-router-key";
const BALANCE_KEY = "sk-test-router-balance-key";
const NOT_LINKED = "Not linked. Run vapi login on this machine, or set VAPI_HOME to a linked home.";
const WALLET_OPTION_WARNING =
  "vapi-network: createVapiClient({ wallet }) is deprecated; pass { account } instead.\n";
const temporaryDirectories: string[] = [];
const secretStores = new Map<string, SecretStore>();

afterEach(async () => {
  // A paid call schedules a best-effort ceiling sweep that keeps writing into the
  // home after the test's own awaits; let it finish before deleting the home.
  await drainCeilingSweeps();
  vi.restoreAllMocks();
  const directories = temporaryDirectories.splice(0);
  for (const directory of directories) secretStores.delete(directory);
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("createVapiClient", () => {
  it("documents wallet removal at the next major release", async () => {
    const source = await readFile(new URL("./client.ts", import.meta.url), "utf8");
    expect(source).toMatch(
      /\/\*\* @deprecated Use `account`; removed in the next major release\. \*\/\s+wallet\?: string;/u,
    );
  });

  it.each(["lock", "expiry", "protect"] as const)(
    "refuses a cached vault signer after %s and allows a new session",
    async (invalidation) => {
      const home = await temporaryHome();
      const secretStore = secretsFor(home);
      const store = await WalletStore.open(home, { secrets: secretStore, env: {} });
      await store.create("main", "");
      const protection = {
        path: join(home, "vault.json"),
        secrets: secretStore,
        password: "test-vault-password",
      };
      if (invalidation !== "protect") {
        await protectVault(protection);
        (await unlockProtectedVault(protection)).fill(0);
      }
      const fetchImpl = vi.fn<typeof fetch>(async (input, init) =>
        (input instanceof Request ? input.headers : new Headers(init?.headers)).has(
          "payment-signature",
        )
          ? Response.json({ paid: true })
          : paymentRequired(),
      );
      const client = await createVapiClient({ home, secretStore, env: {}, fetch: fetchImpl });
      const input = { url: "https://93.184.216.34/weather", method: "GET" as const };
      await expect(client.call.pay(input)).resolves.toMatchObject({ body: { paid: true } });
      await drainCeilingSweeps();
      if (invalidation === "protect") {
        await protectVault(protection);
      } else if (invalidation === "lock") {
        await lockVault({ secrets: secretStore });
      } else {
        const session = JSON.parse((await secretStore.get(VAULT_SESSION_ACCOUNT))!);
        session.expiresAt = "2000-01-01T00:00:00.000Z";
        await secretStore.set(VAULT_SESSION_ACCOUNT, JSON.stringify(session));
      }
      const callsBeforeLock = fetchImpl.mock.calls.length;
      await expect(client.call.pay(input)).rejects.toThrow(VAULT_LOCKED_MESSAGE);
      expect(fetchImpl).toHaveBeenCalledTimes(callsBeforeLock);
      (await unlockProtectedVault(protection)).fill(0);
      await expect(client.call.pay(input)).resolves.toMatchObject({ body: { paid: true } });
    },
    15_000,
  );

  it("reads documentation before a wallet exists", async () => {
    const home = await temporaryHome();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          "Use the CLI.\n\n# Sources:\n- [Quickstart](https://docs.vapinetwork.ai/quickstart)\n",
        ),
      );
    const client = await createVapiClient({ home, fetch: fetchImpl, env: {} });

    await expect(client.docs.ask("How do I start?")).resolves.toEqual({
      answer: "Use the CLI.",
      sources: [{ title: "Quickstart", url: "https://docs.vapinetwork.ai/quickstart" }],
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("returns the linked wallet's Router base URL and stored key", async () => {
    const home = await registryHome({ link: agentLink() });
    const account = await externalAccount(home);
    const secrets = memorySecretStore({
      [agentSecretAccounts("main").routerStake]: ROUTER_KEY,
    });
    const client = await createVapiClient({ account, home, secretStore: secrets, env: {} });

    await expect(client.router.openai()).resolves.toEqual({
      baseURL: "https://router.example/gateway/v1",
      apiKey: ROUTER_KEY,
    });
    expect(client.wallet).toEqual({ name: "main", address: account.address, owner: OWNER });
  });

  it("reloads the selected wallet's caps before every payment", async () => {
    const home = await registryHome({
      spendCaps: { perCallAtomic: "10000", perDayAtomic: "1000000" },
    });
    const account = await externalAccount(home);
    const sign = vi.spyOn(account, "signTypedData");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(paymentRequired());
    const client = await createVapiClient({ account, home, fetch: fetchImpl, env: {} });
    const capsWriter = await WalletStore.open(home);
    await capsWriter.setSpendCaps("main", {
      perCallAtomic: "1000",
      perDayAtomic: "1000",
    });

    await expect(
      client.call.pay({ url: "https://93.184.216.34/weather", method: "GET" }),
    ).rejects.toMatchObject({
      code: "spend_cap_exceeded",
      cap: "per_call",
      amountUsd: "0.0025",
      limitUsd: "0.001",
      wallet: "main",
      command: "vapi accounts caps main --per-call 0.0025 --per-day 0.0025",
      retryable: false,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(sign).not.toHaveBeenCalled();
    await expect(stat(getVapiPaths(home).ledger)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses an injected account without a local wallet registry or keystore", async () => {
    const home = await temporaryHome();
    const account = await externalAccount(home);
    const sign = vi.spyOn(account, "signTypedData");
    const unlock = vi.spyOn(WalletStore.prototype, "unlock");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(paymentRequired())
      .mockResolvedValueOnce(Response.json({ paid: true }));
    const client = await createVapiClient({ account, home, fetch: fetchImpl, env: {} });

    expect(client.wallet).toEqual({ name: "main", address: account.address, owner: null });
    expect((await WalletStore.open(home)).hasRegistry()).toBe(false);

    await expect(
      client.call.pay({
        url: "https://93.184.216.34/weather",
        method: "GET",
        maxPriceUsd: 0.01,
        timeoutSeconds: 45,
      }),
    ).resolves.toMatchObject({ body: { paid: true } });
    expect(sign).toHaveBeenCalledOnce();
    expect(unlock).not.toHaveBeenCalled();
  });

  it("selects the account named by `account`", async () => {
    const home = await temporaryHome();
    const secretStore = secretsFor(home);
    const store = await WalletStore.open(home, { secrets: secretStore, env: {} });
    await store.create("main", "");
    await store.create("researcher", "");
    const researcher = (await store.list()).find((wallet) => wallet.name === "researcher");
    const unlock = vi.spyOn(WalletStore.prototype, "unlock");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ free: true }, { status: 200 }));

    const client = await createVapiClient({
      account: "researcher",
      home,
      env: {},
      secretStore,
      fetch: fetchImpl,
    });

    expect(client.wallet.name).toBe("researcher");
    expect(client.wallet.address).toBe(researcher?.address);
    await expect(
      client.call.pay({ url: "https://93.184.216.34/weather", method: "GET" }),
    ).resolves.toMatchObject({ body: { free: true } });
    expect(unlock).toHaveBeenCalledOnce();
    expect(unlock).toHaveBeenCalledWith("researcher", expect.any(String));
  });

  it("unlocks a protected vault from the supplied environment", async () => {
    const home = await temporaryHome();
    const secretStore = secretsFor(home);
    const store = await WalletStore.open(home, { secrets: secretStore, env: {} });
    await store.create("main", "");
    await protectVault({
      path: join(home, "vault.json"),
      secrets: secretStore,
      password: "vault-password",
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ free: true }, { status: 200 }));

    const client = await createVapiClient({
      account: "main",
      home,
      env: { VAPI_VAULT_PASSWORD: "vault-password" },
      secretStore,
      fetch: fetchImpl,
    });

    await expect(
      client.call.pay({ url: "https://93.184.216.34/weather", method: "GET" }),
    ).resolves.toMatchObject({ body: { free: true } });
  });

  it("still accepts `wallet` and logs one deprecation line per process", async () => {
    vi.resetModules();
    const { createVapiClient: createIsolatedClient } = await import("./client.js");
    const home = await temporaryHome();
    const secretStore = secretsFor(home);
    const store = await WalletStore.open(home, { secrets: secretStore, env: {} });
    await store.create("main", "");
    await store.create("researcher", "");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const researcher = await createIsolatedClient({
      wallet: "researcher",
      home,
      env: {},
      secretStore,
    });

    expect(researcher.wallet.name).toBe("researcher");
    expect(stderr).toHaveBeenCalledOnce();
    expect(stderr).toHaveBeenCalledWith(WALLET_OPTION_WARNING);

    const main = await createIsolatedClient({ wallet: "main", home, env: {}, secretStore });

    expect(main.wallet.name).toBe("main");
    expect(stderr).toHaveBeenCalledOnce();
    expect(stdout).not.toHaveBeenCalled();
  });

  it("`account` wins over `wallet` when both are given", async () => {
    vi.resetModules();
    const { createVapiClient: createIsolatedClient } = await import("./client.js");
    const home = await temporaryHome();
    const secretStore = secretsFor(home);
    const store = await WalletStore.open(home, { secrets: secretStore, env: {} });
    await store.create("main", "");
    await store.create("researcher", "");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const client = await createIsolatedClient({
      account: "main",
      wallet: "researcher",
      home,
      env: {},
      secretStore,
    });

    expect(client.wallet.name).toBe("main");
    expect(stderr).toHaveBeenCalledOnce();
    expect(stderr).toHaveBeenCalledWith(WALLET_OPTION_WARNING);
  });

  it("unlocks the local keystore lazily and only once per client", async () => {
    const home = await temporaryHome();
    const secretStore = secretsFor(home);
    const store = await WalletStore.open(home, { secrets: secretStore, env: {} });
    await store.create("main", PASSPHRASE);
    const unlock = vi.spyOn(WalletStore.prototype, "unlock");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ free: true }, { status: 200 }));
    const client = await createVapiClient({
      home,
      passphrase: PASSPHRASE,
      secretStore,
      fetch: fetchImpl,
      env: {},
    });

    expect(unlock).not.toHaveBeenCalled();
    await client.call.pay({ url: "https://93.184.216.34/one", method: "GET" });
    await client.call.pay({ url: "https://93.184.216.34/two", method: "GET" });
    expect(unlock).toHaveBeenCalledOnce();
  });

  it("buys Router balance with the lazily unlocked wallet and records the payment", async () => {
    const home = await temporaryHome();
    const secrets = memorySecretStore({
      [agentSecretAccounts("main").tokens]: JSON.stringify({
        accessToken: ACCESS_TOKEN,
        refreshToken: "test-agent-refresh-token",
        expiresAt: Number.MAX_SAFE_INTEGER,
        scopes: ["mcp:call", "router.use"],
      }),
    });
    const store = await WalletStore.open(home, { secrets, env: {} });
    await store.importKey("main", PASSPHRASE, PRIVATE_KEY, {
      spendCaps: { perCallAtomic: "10000000", perDayAtomic: "10000000" },
    });
    await store.setLink("main", agentLink());
    const config = getDefaultConfig();
    config.allowPrivateNetwork = true;
    await writeFile(getVapiPaths(home).config, `${JSON.stringify(config)}\n`, { mode: 0o600 });
    const balance = { purchasedUsd: 5, spentUsd: 0, remainingUsd: 5 };
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/api/router/top-up/5") {
        return request.headers.has("payment-signature")
          ? routerTopupAccepted()
          : routerTopupRequired();
      }
      if (url.pathname === "/api/agents/self/router-balance-key") {
        return Response.json({
          router_key: BALANCE_KEY,
          router_base_url: "https://router.example/gateway",
        });
      }
      if (url.pathname === "/api/agents/self/router") {
        return Response.json({
          compute: {
            allowanceUsd: 10,
            spentTodayUsd: 1,
            remainingTodayUsd: 9,
            resetsAt: "2026-09-24T00:00:00.000Z",
            ownerLimitUsd: 20,
            ownerSpentUsd: 1,
          },
          balance,
        });
      }
      throw new Error(`Unexpected request to ${url.href}`);
    });
    const unlock = vi.spyOn(WalletStore.prototype, "unlock");
    const client = await createVapiClient({
      home,
      passphrase: PASSPHRASE,
      secretStore: secrets,
      fetch: fetchImpl,
      env: {},
    });

    expect(unlock).not.toHaveBeenCalled();
    await expect(client.router.buy(5)).resolves.toMatchObject({
      receipt: { outcome: "paid", source: "router.topup" },
      balance,
    });
    expect(unlock).toHaveBeenCalledOnce();
    await expect(stat(getVapiPaths(home).ledger)).resolves.toBeDefined();
    await expect(stat(getVapiPaths(home).receipts)).resolves.toBeDefined();
  });

  it("auto-refills configured Router balance for SDK chats and agent runs", async () => {
    const home = await registryHome({
      link: agentLink(),
      spendCaps: { perCallAtomic: "10000000", perDayAtomic: "20000000" },
      routerRefill: { belowUsd: 2, tierUsd: 5 },
    });
    await writeAgentProfile(home, {
      version: 1,
      name: "researcher",
      wallet: "main",
      model: "router/test",
      instructions: "Research carefully.",
      verifiedOnly: true,
      approveAboveUsd: 0.5,
      maxSteps: 2,
      tools: ["call.search", "call.inspect", "call.pay"],
      paused: false,
      createdAt: "2026-09-23T00:00:00.000Z",
    });
    const config = getDefaultConfig();
    config.allowPrivateNetwork = true;
    await writeFile(getVapiPaths(home).config, `${JSON.stringify(config)}\n`, { mode: 0o600 });
    const account = await externalAccount(home);
    const secrets = memorySecretStore({
      [agentSecretAccounts("main").tokens]: JSON.stringify({
        accessToken: ACCESS_TOKEN,
        refreshToken: "test-agent-refresh-token",
        expiresAt: Number.MAX_SAFE_INTEGER,
        scopes: ["mcp:call", "router.use"],
      }),
      [agentSecretAccounts("main").routerStake]: ROUTER_KEY,
      [agentSecretAccounts("main").routerBalance]: BALANCE_KEY,
    });
    let topupCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname === "router.example") {
        const authorization = request.headers.get("authorization");
        if (authorization === `Bearer ${ROUTER_KEY}`) {
          return new Response("budget exceeded", { status: 429 });
        }
        expect(authorization).toBe(`Bearer ${BALANCE_KEY}`);
        return Response.json({
          model: "router/test",
          choices: [{ message: { content: "Answered from balance." } }],
        });
      }
      if (url.pathname === "/api/agents/self/router") {
        return Response.json({
          compute: {
            allowanceUsd: 1,
            spentTodayUsd: 1,
            remainingTodayUsd: 0,
            resetsAt: "2026-09-24T00:00:00.000Z",
            ownerLimitUsd: 5,
            ownerSpentUsd: 5,
          },
          balance: { purchasedUsd: 5, spentUsd: 4, remainingUsd: 1 },
        });
      }
      if (url.pathname === "/api/router/top-up/5") {
        topupCalls += 1;
        return request.headers.has("payment-signature")
          ? routerTopupAccepted()
          : routerTopupRequired();
      }
      throw new Error(`Unexpected request to ${url.href}`);
    });
    const client = await createVapiClient({
      account,
      home,
      secretStore: secrets,
      fetch: fetchImpl,
      env: {},
    });

    await expect(
      client.router.chat({
        model: "router/test",
        messages: [{ role: "user", content: "Chat" }],
      }),
    ).resolves.toMatchObject({ content: "Answered from balance.", keyUsed: "balance" });
    await expect(client.agent.run("researcher", "Run")).resolves.toMatchObject({
      answer: "Answered from balance.",
      stoppedBecause: { type: "stopped", reason: "finished" },
    });
    expect(topupCalls).toBe(4);
  });

  it("declines an above-threshold agent payment by default", async () => {
    const home = await registryHome({
      link: agentLink(),
      spendCaps: { perCallAtomic: "1000000", perDayAtomic: "2000000" },
    });
    await writeAgentProfile(home, {
      version: 1,
      name: "researcher",
      wallet: "main",
      model: "router/test",
      instructions: "Research carefully.",
      verifiedOnly: true,
      approveAboveUsd: 0.5,
      maxSteps: 4,
      tools: ["call.search", "call.inspect", "call.pay"],
      paused: false,
      createdAt: "2026-09-23T00:00:00.000Z",
    });
    const account = await externalAccount(home);
    const secrets = memorySecretStore({
      [agentSecretAccounts("main").routerStake]: ROUTER_KEY,
    });
    const endpointCalls: string[] = [];
    let chatRound = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      endpointCalls.push(url.href);
      if (url.hostname === "router.example") {
        chatRound += 1;
        if (chatRound === 1) {
          return chatToolReply("search", "call_search", {
            query: "base dex volume",
            network: null,
          });
        }
        if (chatRound === 2) {
          return chatToolReply("pay", "call_pay", {
            ref: "dex-volume",
            body: null,
            max_usd: 1,
          });
        }
        return chatToolReply("finish", "finish", { answer: "Payment declined." });
      }
      if (url.pathname === "/api/call/discovery") return marketplacePage();
      if (url.pathname === "/api/call/services") return servicePage();
      throw new Error(`Unexpected request to ${url.href}`);
    });
    const events: Array<{ type: string }> = [];
    const client = await createVapiClient({
      account,
      home,
      secretStore: secrets,
      fetch: fetchImpl,
      env: {},
    });

    const result = await client.agent.run("researcher", "Summarise Base DEX volume", {
      onEvent: (event) => events.push(event),
    });

    expect(result.answer).toBe("Payment declined.");
    expect(events).toContainEqual(expect.objectContaining({ type: "declined", ref: "dex-volume" }));
    expect(endpointCalls).not.toContain("https://93.184.216.34/paid");
  });

  it("rejects every Router method and agent runs for an unlinked injected account", async () => {
    const home = await registryHome();
    await writeAgentProfile(home, {
      version: 1,
      name: "researcher",
      wallet: "main",
      model: "router/test",
      instructions: "Research carefully.",
      verifiedOnly: true,
      approveAboveUsd: 0.5,
      maxSteps: 4,
      tools: ["call.search", "call.inspect", "call.pay"],
      paused: false,
      createdAt: "2026-09-23T00:00:00.000Z",
    });
    const client = await createVapiClient({
      account: await externalAccount(home),
      home,
      secretStore: memorySecretStore(),
      fetch: vi.fn<typeof fetch>(),
      env: {},
    });

    await expect(client.router.models()).rejects.toThrow(NOT_LINKED);
    await expect(client.router.usage()).rejects.toThrow(NOT_LINKED);
    await expect(client.router.buy(1)).rejects.toThrow(NOT_LINKED);
    await expect(
      client.router.chat({ model: "router/test", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(NOT_LINKED);
    await expect(client.router.openai()).rejects.toThrow(NOT_LINKED);
    await expect(client.agent.run("researcher", "Do work")).rejects.toThrow(NOT_LINKED);
  });
});

type MemorySecretStore = SecretStore & { entries: Record<string, string> };

function memorySecretStore(initial: Record<string, string> = {}): MemorySecretStore {
  const entries = { ...initial };
  return {
    available: true,
    platform: "darwin",
    description: "the test keychain",
    entries,
    get: async (name) => entries[name],
    has: async (name) => entries[name] !== undefined,
    set: async (name, value) => {
      entries[name] = value;
    },
    remove: async (name) => {
      if (entries[name] === undefined) return false;
      delete entries[name];
      return true;
    },
  };
}

function memoryStore(): SecretStore {
  const entries = new Map<string, string>();
  return {
    available: true,
    platform: "darwin",
    description: "the macOS Keychain",
    async get(name) {
      return entries.get(name);
    },
    async has(name) {
      return entries.has(name);
    },
    async set(name, value) {
      entries.set(name, value);
    },
    async remove(name) {
      return entries.delete(name);
    },
  };
}

function secretsFor(home: string): SecretStore {
  const existing = secretStores.get(home);
  if (existing !== undefined) return existing;
  const created = memoryStore();
  secretStores.set(home, created);
  return created;
}

function agentLink(): AgentLink {
  return {
    apiBase: "https://api.vapinetwork.ai",
    clientId: `agent_${OWNER.toLowerCase()}`,
    owner: OWNER,
    label: "main",
    scopes: ["mcp:call", "router.use"],
    linkedAt: "2026-09-23T10:00:00.000Z",
    routerBaseUrl: "https://router.example/gateway",
  };
}

async function registryHome(
  options: {
    spendCaps?: SpendCaps;
    link?: AgentLink;
    routerRefill?: { belowUsd: number; tierUsd: 1 | 5 | 20 | 50 };
  } = {},
): Promise<string> {
  const home = await temporaryHome();
  await writeFile(
    join(home, "wallets.json"),
    `${JSON.stringify(
      {
        version: 1,
        default: "main",
        wallets: {
          main: {
            createdAt: "2026-09-23T09:00:00.000Z",
            spendCaps: options.spendCaps ?? {
              perCallAtomic: "100000",
              perDayAtomic: "1000000",
            },
            ...(options.routerRefill === undefined ? {} : { routerRefill: options.routerRefill }),
            ...(options.link === undefined ? {} : { link: options.link }),
          },
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return home;
}

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "vapi-client-"));
  temporaryDirectories.push(home);
  return home;
}

async function externalAccount(home: string) {
  return await createKeystoreFromPrivateKey(PASSPHRASE, join(home, "external-account.json"), {
    privateKey: PRIVATE_KEY,
  });
}

function paymentRequired(): Response {
  const config = getDefaultConfig();
  return Response.json(
    {
      x402Version: 2,
      resource: { url: "https://93.184.216.34/weather" },
      accepts: [
        {
          scheme: "exact",
          network: BASE_MAINNET_CAIP2,
          amount: "2500",
          asset: config.networks[BASE_MAINNET_CAIP2]!.usdc,
          payTo: PAY_TO,
          maxTimeoutSeconds: 60,
          extra: { name: "USD Coin", version: "2" },
        },
      ],
    },
    { status: 402 },
  );
}

function routerTopupRequired(): Response {
  const config = getDefaultConfig();
  return Response.json(
    {
      x402Version: 2,
      resource: { url: "https://api.vapinetwork.ai/api/router/top-up/5" },
      accepts: [
        {
          scheme: "exact",
          network: BASE_MAINNET_CAIP2,
          amount: "5000000",
          asset: config.networks[BASE_MAINNET_CAIP2]!.usdc,
          payTo: PAY_TO,
          maxTimeoutSeconds: 60,
          extra: { name: "USD Coin", version: "2" },
        },
      ],
    },
    { status: 402 },
  );
}

function routerTopupAccepted(): Response {
  return Response.json(
    { status: "accepted", usd: 5, owner: OWNER },
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

function chatToolReply(id: string, name: string, args: Record<string, unknown>): Response {
  return Response.json({
    model: "router/test",
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            { id, type: "function", function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  });
}

function marketplacePage(): Response {
  return Response.json({
    protocol: "vapi.marketplace.discovery/1",
    items: [
      {
        ref: "dex-volume",
        kind: "api",
        provenance: "self_listed",
        verification: "verified",
        execution: { mode: "direct" },
        card: {
          title: "DEX volume",
          summary: "Current Base DEX volume.",
          badges: [],
          facts: [{ label: "Price", value: "$0.80" }],
        },
        action: { type: "invoke_api", href: "/call/dex-volume" },
      },
    ],
    nextCursor: null,
    unavailableKinds: [],
    rankingVersion: "test-ranking",
  });
}

function servicePage(): Response {
  return Response.json({
    services: [
      {
        id: "dex-volume",
        name: "DEX volume",
        description: "Current Base DEX volume.",
        category: "data",
        tier: "verified",
        verification: "verified",
        verified: true,
        wrapped: false,
        price: "$0.80",
        networks: [BASE_MAINNET_CAIP2],
        endpoints: [
          {
            name: "volume",
            method: "GET",
            url: "https://93.184.216.34/paid",
            price: "$0.80",
            description: "Current Base DEX volume.",
          },
        ],
      },
    ],
  });
}
