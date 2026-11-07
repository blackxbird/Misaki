import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
  SOLANA_MAINNET_CAIP2,
  VAPI_CLIENT_VERSION,
  SpendCapExceededError,
  createKeystore,
  getDefaultConfig,
  readReceipts,
  type MarketplaceDiscoveryPage,
  type MarketplaceHit,
} from "@vapi-network/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createVapiServer, toolError } from "./server.js";
import { SERVER_ICONS } from "./tool-presentation.js";
import { MCP_APP_VIEWS, createViewLoader } from "./views.js";
import { VapiCallError } from "./tools/call.js";

const PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as Hex;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Agent Cash MCP marketplace tools", () => {
  it("serializes spend-cap refusals as structured, non-retryable tool errors", () => {
    const error = new SpendCapExceededError({
      cap: "per_day",
      amountUsd: "0.01",
      limitUsd: "1",
      spentUsd: "0.995",
      wallet: "researcher",
    });

    const bundledCopy = Object.assign(new Error(error.message), error.toJSON(), {
      retryable: false,
    });
    expect(JSON.parse(toolError(bundledCopy).content[0]!.text)).toEqual({
      error: error.message,
      code: "spend_cap_exceeded",
      cap: "per_day",
      amountUsd: "0.01",
      limitUsd: "1",
      spentUsd: "0.995",
      wallet: "researcher",
      command: "vapi accounts caps researcher --per-day 1.005",
      retryable: false,
    });
  });

  it("keeps a null command for the internal Router amount cap", () => {
    const error = new SpendCapExceededError({
      cap: "max_amount",
      amountUsd: "5.01",
      limitUsd: "5",
    });

    expect(toolError(error).isError).toBe(true);
    expect(JSON.parse(toolError(error).content[0]!.text)).toEqual({
      error: error.message,
      code: "spend_cap_exceeded",
      cap: "max_amount",
      amountUsd: "5.01",
      limitUsd: "5",
      command: null,
      retryable: false,
    });
  });

  it("omits an SVM signed transaction from serialized uncertain-settlement errors", () => {
    const signedTransaction = "signed-solana-transaction-fixture";
    const error = new VapiCallError("settlement_unknown", "Settlement is uncertain.", {
      network: "solana:mainnet",
      asset: "usdc",
      amountAtomic: "1",
      payTo: "payee",
      payer: "payer",
      receipt: null,
      authorizationTransaction: signedTransaction,
    } as never);

    const serialized = JSON.stringify(toolError(error));
    expect(serialized).toContain("settlement_unknown");
    expect(serialized).not.toContain(signedTransaction);
    expect(serialized).not.toContain("authorizationTransaction");
  });

  it("returns the Solana holder-graph row through call.search output validation", async () => {
    const page = await fixture("vapi-discovery-holder-graph-solana.json");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(page));
    const { client, server } = await connectedServer(fetchImpl);

    const result = await client.callTool({
      name: "call.search",
      arguments: { query: "holder graph", limit: 20 },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      items: [
        { ref: "the-graph" },
        {
          ref: "https://api.deepnets.ai/api/token/holder-graph",
          execution: { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" },
        },
      ],
    });
    await client.close();
    await server.close();
  });

  it.each([
    {
      label: "an indexed DeepNets result",
      id: "https://api.deepnets.ai/api/token/holder-graph",
      fixtureName: "vapi-discovery-holder-graph-solana.json",
      responsePath: "/api/call/discovery",
    },
    {
      label: "the registered Birdeye service",
      id: "birdeye",
      fixtureName: "vapi-services-birdeye-solana.json",
      responsePath: "/api/call/services",
    },
  ])("returns unsupported_network when call.inspect resolves $label", async (testCase) => {
    const response = await fixture(testCase.fixtureName);
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (pathname === testCase.responsePath) return Response.json(response);
      if (pathname === "/api/call/services") return Response.json({ services: [] });
      throw new Error(`Unexpected request to ${pathname}`);
    });
    const { client, server } = await connectedServer(fetchImpl);

    const result = await client.callTool({
      name: "call.inspect",
      arguments: { id: testCase.id },
    });

    expect(result.isError).toBe(true);
    const error = JSON.parse(result.content[0]?.text ?? "null") as {
      code?: string;
      error?: string;
    };
    expect(error.code).toBe("unsupported_network");
    expect(error.error).toContain("Solana payments are not supported");
    expect(error.error).not.toContain("ZodError");
    await client.close();
    await server.close();
  });

  it("refuses call.pay for a cached Solana row without requesting, signing, or recording payment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-mcp-solana-refusal-"));
    temporaryDirectories.push(directory);
    const ledgerPath = join(directory, "ledger.json");
    const receiptsPath = join(directory, "receipts.jsonl");
    const page = await fixture("vapi-discovery-holder-graph-solana.json");
    const account = privateKeyToAccount(PRIVATE_KEY);
    const signTypedData = vi.spyOn(account, "signTypedData");
    const signMessage = vi.spyOn(account, "signMessage");
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (pathname === "/api/call/discovery") return Response.json(page);
      throw new Error(`Unexpected request to ${pathname}`);
    });
    const server = createVapiServer({
      account,
      config: getDefaultConfig(),
      fetchImpl,
      ledgerPath,
      receiptsPath,
      searchesPath: join(directory, "searches.jsonl"),
    });

    await server.callTool({ name: "call.search", arguments: { query: "holder graph" } });
    const result = await server.callTool({
      name: "call.pay",
      arguments: { id: "https://api.deepnets.ai/api/token/holder-graph" },
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "null")).toMatchObject({
      code: "unsupported_network",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(signTypedData).not.toHaveBeenCalled();
    expect(signMessage).not.toHaveBeenCalled();
    await expect(readFile(ledgerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(receiptsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await server.close();
  });

  it("refuses call.pay for the registered Birdeye service before requesting or signing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-mcp-birdeye-refusal-"));
    temporaryDirectories.push(directory);
    const ledgerPath = join(directory, "ledger.json");
    const receiptsPath = join(directory, "receipts.jsonl");
    const services = await fixture("vapi-services-birdeye-solana.json");
    const account = privateKeyToAccount(PRIVATE_KEY);
    const signTypedData = vi.spyOn(account, "signTypedData");
    const signMessage = vi.spyOn(account, "signMessage");
    const requestedPaths: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
      requestedPaths.push(pathname);
      if (pathname === "/api/call/discovery") {
        return Response.json(marketplacePage([nativeApiHit("birdeye")]));
      }
      if (pathname === "/api/call/services") return Response.json(services);
      throw new Error(`Unexpected request to ${pathname}`);
    });
    const server = createVapiServer({
      account,
      config: getDefaultConfig(),
      fetchImpl,
      ledgerPath,
      receiptsPath,
      searchesPath: join(directory, "searches.jsonl"),
    });

    await server.callTool({ name: "call.search", arguments: { query: "birdeye" } });
    const result = await server.callTool({ name: "call.pay", arguments: { id: "birdeye" } });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "null")).toMatchObject({
      code: "unsupported_network",
    });
    expect(requestedPaths).toEqual(["/api/call/discovery", "/api/call/services"]);
    expect(signTypedData).not.toHaveBeenCalled();
    expect(signMessage).not.toHaveBeenCalled();
    await expect(readFile(ledgerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(receiptsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await server.close();
  });

  it("registers inspect as the free request-contract step before call", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { client, server } = await connectedServer(fetchImpl);

    const tools = await client.listTools();

    const names = tools.tools.map((tool) => tool.name);
    expect(names).toEqual([
      "docs.search",
      "docs.read",
      "auth.link",
      "auth.status",
      "router.models",
      "router.usage",
      "router.chat",
      "router.buy",
      "tasks.search",
      "tasks.show",
      "tasks.post",
      "tasks.propose",
      "tasks.submit",
      "tasks.award",
      "tasks.sign",
      "tasks.fund",
      "tasks.deliver",
      "tasks.release",
      "tasks.refund",
      "tasks.dispute",
      "tasks.counter-evidence",
      "tasks.resolve-unmatched",
      "tasks.message",
      "tasks.thread",
      "tasks.watch",
      "tasks.status",
      "vapi.status",
      "vapi.accounts",
      "vapi.siblings",
      "accounts.add",
      "accounts.caps",
      "accounts.send",
      "call.search",
      "search",
      "call.inspect",
      "inspect",
      "call.pay",
      "call",
      "call.read",
      "wallet.address",
      "wallet.balance",
      "wallet.accounts",
      "wallet.list",
      "wallet.use",
      "wallet.fund",
      "wallet",
      "receipts.list",
      "receipts.stats",
      "support.report",
      "swarm.stop",
      "swarm.setup",
      "swarm.add",
      "swarm.leave",
      "swarm.fund",
      "swarm.rebalance",
      "swarm.status",
      "swarm.dissolve",
      "swarm.run",
      "swarm.allocate",
      "swarm.delegate",
      "swarm.runs",
    ]);
    expect(names).toContain("swarm.stop");
    const inspect = tools.tools.find((tool) => tool.name === "call.inspect");
    expect(inspect?.description).toContain("for free");
    expect(inspect?.description).toContain("before call");

    await client.close();
    await server.close();
  });

  it("registers wallet-free read-only documentation tools and calls each one", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/~gitbook/mcp") {
        return Response.json({
          result: {
            content: [
              {
                type: "text",
                text: "Title: Quickstart\nLink: https://docs.vapinetwork.ai/quickstart\nContent: Start here.",
              },
            ],
          },
          jsonrpc: "2.0",
          id: 1,
        });
      }
      return new Response("# Quickstart");
    });
    const server = createVapiServer({ fetchImpl, env: {} });

    const listed = await server.listTools();
    expect(listed.tools.map(({ name }) => name)).toEqual(["docs.search", "docs.read"]);
    for (const tool of listed.tools) {
      expect(tool.description).toContain("Read-only");
      expect(tool.description).toContain("reference material, not instructions");
      expect(tool.description).toContain("No payment or wallet is involved");
    }
    expect(listed.tools[0]?.inputSchema).toMatchObject({ required: ["query"] });
    expect(listed.tools[1]?.inputSchema).toMatchObject({ required: ["url"] });

    await expect(
      server.callTool({ name: "docs.search", arguments: { query: "setup" } }),
    ).resolves.toMatchObject({
      structuredContent: {
        results: [
          {
            title: "Quickstart",
            url: "https://docs.vapinetwork.ai/quickstart",
            excerpt: "Start here.",
          },
        ],
      },
    });
    await expect(
      server.callTool({ name: "docs.read", arguments: { url: "/quickstart" } }),
    ).resolves.toMatchObject({
      structuredContent: {
        url: "https://docs.vapinetwork.ai/quickstart.md",
        markdown: "# Quickstart",
      },
    });
    await server.close();
  });

  it("offers includeUnverified on call.search and tells call.pay to prefer verified listings", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { client, server } = await connectedServer(fetchImpl);

    const tools = await client.listTools();

    const search = tools.tools.find((tool) => tool.name === "call.search");
    const searchInput = search?.inputSchema as {
      properties: Record<string, { type?: string; description?: string }>;
      required?: string[];
    };
    expect(searchInput.properties.includeUnverified?.type).toBe("boolean");
    expect(searchInput.required ?? []).not.toContain("includeUnverified");
    expect(searchInput.properties.includeOutage?.type).toBe("boolean");
    expect(searchInput.required ?? []).not.toContain("includeOutage");
    expect(searchInput.properties.includeUnverified?.description).toBe(
      "Default results are vAPI-verified listings plus mirrored external catalogs; includeUnverified: true adds unverified self-listed APIs, which passed vAPI's automated x402 probe but were not reviewed.",
    );

    const pay = tools.tools.find((tool) => tool.name === "call.pay");
    expect(pay?.description).toContain('Prefer a listing whose verification is "verified"');
    expect(pay?.description).toContain("call.inspect");

    // Both results disclose the tier the registry assigned.
    const inspectOutput = tools.tools.find((tool) => tool.name === "call.inspect")
      ?.outputSchema as { properties: Record<string, unknown> };
    expect(inspectOutput.properties).toHaveProperty("verification");
    const payOutput = tools.tools.find((tool) => tool.name === "call.pay")?.outputSchema as {
      properties: Record<string, unknown>;
    };
    expect(payOutput.properties).toHaveProperty("verification");

    await client.close();
    await server.close();
  });

  it("publishes object output schemas only for tools that declare structured output", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("No network in output schema tests.");
    });
    const server = createVapiServer({
      account: privateKeyToAccount(PRIVATE_KEY),
      config: getDefaultConfig({}),
      env: {},
      fetchImpl,
    });

    try {
      const tools = (await server.listTools()).tools;
      for (const tool of tools) {
        if ("outputSchema" in tool) expect(tool.outputSchema).toMatchObject({ type: "object" });
      }

      const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
      expect(byName["auth.status"]).toBeDefined();
      expect(byName["auth.status"]).not.toHaveProperty("outputSchema");
      expect(byName["swarm.run"]).toBeDefined();
      expect(byName["swarm.run"]).not.toHaveProperty("outputSchema");
      expect(byName["call.pay"]?.outputSchema).toMatchObject({ type: "object" });
      expect(byName["docs.search"]?.outputSchema).toMatchObject({ type: "object" });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("keeps deprecated aliases behavior-compatible and emits one deprecation line", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(marketplacePage([workHit("research-brief")])));
    const { client, server } = await connectedServer(fetchImpl);

    const result = await client.callTool({ name: "search", arguments: { query: "research" } });
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";

    expect(result.isError).not.toBe(true);
    expect(text.split("\n")[0]).toBe(
      "DEPRECATED: use call.search; this alias will be removed in a later release.",
    );
    expect(result.structuredContent).toEqual({
      ...marketplacePage([workHit("research-brief")]),
      _view: { createdAt: expect.any(Number), seq: 1 },
      hints: [],
    });

    await client.close();
    await server.close();
  });

  it.each([
    ["inspect", "call.inspect", {}],
    ["call", "call.pay", {}],
    ["wallet", "wallet.balance", {}],
  ] as const)("marks every %s alias result as deprecated", async (name, replacement, args) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(marketplacePage([])));
    const { client, server } = await connectedServer(fetchImpl);

    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";

    expect(text.split("\n")[0]).toBe(
      `DEPRECATED: use ${replacement}; this alias will be removed in a later release.`,
    );
    await client.close();
    await server.close();
  });

  it("records calls in the same ledger exposed by receipts.list", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    const { client, server } = await connectedServer(fetchImpl);

    const callResult = await client.callTool({
      name: "call.pay",
      arguments: { url: "https://93.184.216.34/free" },
    });
    const receiptsResult = await client.callTool({ name: "receipts.list" });

    expect(callResult.isError).not.toBe(true);
    expect(receiptsResult.structuredContent).toMatchObject({
      receipts: [
        {
          resourceUrl: "https://93.184.216.34/free",
          status: 200,
          source: "direct",
          outcome: "paid",
          listing: { providerHost: "93.184.216.34", source: "direct" },
          policy: { capsApplied: false },
          client: { name: "vapi-network", version: "0.12.0" },
        },
      ],
    });

    const statsResult = await client.callTool({ name: "receipts.stats" });
    expect(statsResult.structuredContent).toMatchObject({
      range: "24h",
      totals: { spendUsd: "0", calls: 1, uniqueApis: 1, policyDeclines: 0 },
      search: { count: 0, zeroResultRate: 0 },
    });
    await client.close();
    await server.close();
  });

  it("returns a structured spend-cap error before call.pay signs or retries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-mcp-cap-"));
    temporaryDirectories.push(directory);
    const ledgerPath = join(directory, "ledger.json");
    const receiptsPath = join(directory, "receipts.jsonl");
    const config = getDefaultConfig();
    config.spendCaps = { perCallAtomic: "2499", perDayAtomic: "10000" };
    const account = privateKeyToAccount(PRIVATE_KEY);
    const signTypedData = vi.spyOn(account, "signTypedData");
    const challenge = {
      x402Version: 2,
      resource: { url: "https://93.184.216.34/paid" },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          amount: "2500",
          asset: config.networks["eip155:8453"]!.usdc,
          payTo: "0x1111111111111111111111111111111111111111",
          maxTimeoutSeconds: 60,
          extra: { name: "USD Coin", version: "2" },
        },
      ],
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(challenge, { status: 402 }));
    const server = createVapiServer({
      account,
      config,
      fetchImpl,
      ledgerPath,
      receiptsPath,
    });

    const result = await server.callTool({
      name: "call.pay",
      arguments: { url: "https://93.184.216.34/paid" },
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "null")).toMatchObject({
      code: "spend_cap_exceeded",
      cap: "per_call",
      amountUsd: "0.0025",
      limitUsd: "0.002499",
      retryable: false,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(signTypedData).not.toHaveBeenCalled();
    expect(await readReceipts(receiptsPath)).toMatchObject([
      { outcome: "declined_policy", error: { code: "spend_cap_exceeded" } },
    ]);
    await server.close();
  });

  it("lists configured accounts with deposit guidance", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const body = init?.body ?? (input instanceof Request ? await input.clone().text() : "");
      const request = JSON.parse(String(body)) as { id: number; method: string };
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: request.method === "eth_call" ? `0x${"0".repeat(64)}` : "0x0",
      });
    });
    const { client, server } = await connectedServer(fetchImpl);

    const result = await client.callTool({ name: "wallet.accounts" });

    expect(result.isError).not.toBe(true);
    expect(
      (result.structuredContent as { accounts: Array<{ error?: string }> }).accounts[0]?.error,
    ).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      accounts: [
        {
          caip2: "eip155:8453",
          name: "Base mainnet",
          usdcBalance: { atomic: "0", formatted: "0" },
          gasTokenBalance: { symbol: "ETH", atomic: "0", formatted: "0" },
          depositInstructions: expect.stringContaining("Send USDC on Base"),
        },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await client.close();
    await server.close();
  });

  it("returns the hosted funding page from wallet.fund without any network call", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { client, server } = await connectedServer(fetchImpl);

    const result = await client.callTool({ name: "wallet.fund", arguments: { amountUsd: 20 } });

    expect(result.isError).not.toBe(true);
    const address = privateKeyToAccount(PRIVATE_KEY).address;
    expect(result.structuredContent).toEqual({
      wallet: "main",
      address,
      network: "base",
      url: `https://api.vapinetwork.ai/fund/${address}?amount=20`,
      instructions: expect.stringContaining("Give this link to your human"),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });

  it("omits the amount from wallet.fund when the agent has no preference", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { client, server } = await connectedServer(fetchImpl);

    const tools = await client.listTools();
    const result = await client.callTool({ name: "wallet.fund" });

    expect(tools.tools.find((tool) => tool.name === "wallet.fund")?.description).toContain(
      "hand the link to your human",
    );
    expect(result.structuredContent).toMatchObject({
      url: `https://api.vapinetwork.ai/fund/${privateKeyToAccount(PRIVATE_KEY).address}`,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });

  it("uses the enabled Solana address in both wallet tools", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-mcp-solana-wallet-"));
    temporaryDirectories.push(directory);
    const account = await createKeystore("test-only-passphrase", join(directory, "keystore.json"), {
      enableSolana: true,
    });
    const config = getDefaultConfig({}, { networks: ["base", "solana"] });
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const body = init?.body ?? (input instanceof Request ? await input.clone().text() : "");
      const request = JSON.parse(String(body)) as { id: number; method: string };
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result:
          request.method === "eth_call"
            ? `0x${"0".repeat(64)}`
            : request.method === "eth_getBalance"
              ? "0x0"
              : request.method === "getTokenAccountsByOwner"
                ? { context: { slot: 1 }, value: [] }
                : { context: { slot: 1 }, value: 0 },
      });
    });
    const server = createVapiServer({ account, config, fetchImpl });

    const accounts = await server.callTool({ name: "wallet.accounts" });
    const balance = await server.callTool({ name: "wallet.balance" });

    expect(accounts.structuredContent).toMatchObject({
      accounts: [
        { caip2: "eip155:8453", address: account.address },
        {
          caip2: SOLANA_MAINNET_CAIP2,
          address: account.solana?.address,
          usdcBalance: { atomic: "0", formatted: "0" },
          gasTokenBalance: { symbol: "SOL", atomic: "0", formatted: "0" },
        },
      ],
    });
    expect(balance.structuredContent).toMatchObject({
      balances: [
        { network: "eip155:8453", usdcAtomic: "0" },
        { network: SOLANA_MAINNET_CAIP2, usdcAtomic: "0" },
      ],
    });
    await server.close();
  });

  it("writes support reports locally without sending by default", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-mcp-report-"));
    temporaryDirectories.push(directory);
    const fetchImpl = vi.fn<typeof fetch>();
    const server = createVapiServer({
      account: privateKeyToAccount(PRIVATE_KEY),
      config: getDefaultConfig(),
      fetchImpl,
      receiptsPath: join(directory, "receipts.jsonl"),
      reportsDirectory: join(directory, "reports"),
    });

    const result = await server.callTool({
      name: "support.report",
      arguments: { message: "payment failed" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      issueUrl: expect.stringContaining("title=payment%20failed"),
      report: { message: "payment failed", receiptIds: [] },
    });
    const path = (result.structuredContent as { path: string }).path;
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ message: "payment failed" });
    expect(fetchImpl).not.toHaveBeenCalled();
    await server.close();
  });

  it("searches all marketplace kinds and refuses to call a cached Work result", async () => {
    const page = {
      protocol: "vapi.marketplace.discovery/1",
      items: [
        {
          ref: "research-brief",
          kind: "service_offer",
          card: {
            title: "Research brief",
            summary: "Evidence-backed market research.",
            badges: [],
            facts: [],
          },
          action: { type: "start_engagement", href: "/work/listings/research-brief" },
        },
      ],
      nextCursor: null,
      unavailableKinds: [],
      rankingVersion: "marketplace-ranking-v1",
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(page), { status: 200 }));
    const server = createVapiServer({
      account: privateKeyToAccount(PRIVATE_KEY),
      config: getDefaultConfig(),
      fetchImpl,
    });
    const client = server;

    const searchResult = await client.callTool({
      name: "search",
      arguments: { query: "research", kinds: ["service_offer"] },
    });
    expect(searchResult.isError).not.toBe(true);
    expect(JSON.stringify(searchResult.content)).toContain("research-brief");
    // The page predates the verification tier, so every item reads as `none`.
    expect(searchResult.structuredContent).toEqual({
      ...page,
      hints: [],
      items: page.items.map((item) => ({ ...item, verification: "none" })),
      _view: { createdAt: expect.any(Number), seq: 1 },
    });

    const callResult = await client.callTool({
      name: "call",
      arguments: { id: "research-brief" },
    });
    expect(callResult.isError).toBe(true);
    expect(JSON.stringify(callResult.content)).toContain("only invokes API marketplace results");
    expect(fetchImpl).toHaveBeenCalledOnce();

    await client.close();
    await server.close();
  });

  it("retains source-bound external execution metadata across later searches", async () => {
    const external = externalApiHit("https://93.184.216.34/weather");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(marketplacePage([external])))
      .mockResolvedValueOnce(Response.json(marketplacePage([workHit("research-brief")])));
    const { client, server } = await connectedServer(fetchImpl);

    await client.callTool({ name: "search", arguments: { query: "weather" } });
    await client.callTool({ name: "search", arguments: { query: "research" } });
    const callResult = await client.callTool({
      name: "call",
      arguments: { id: external.ref, network: "eip155:5042002" },
    });

    expect(callResult.isError).toBe(true);
    expect(JSON.stringify(callResult.content)).toContain(
      "registered endpoint requires eip155:8453",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await client.close();
    await server.close();
  });

  it("replaces a repeated source snapshot without discarding its ref", async () => {
    const ref = "https://93.184.216.34/weather";
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(marketplacePage([externalApiHit(ref)])))
      .mockResolvedValueOnce(
        Response.json(marketplacePage([externalApiHit(ref, "eip155:5042002")])),
      );
    const { client, server } = await connectedServer(fetchImpl);

    await client.callTool({ name: "search", arguments: { query: "weather" } });
    await client.callTool({ name: "search", arguments: { query: "weather" } });
    const callResult = await client.callTool({
      name: "call",
      arguments: { id: ref, network: "eip155:8453" },
    });

    expect(callResult.isError).toBe(true);
    expect(JSON.stringify(callResult.content)).toContain(
      "registered endpoint requires eip155:5042002",
    );
    expect(JSON.stringify(callResult.content)).not.toContain("ambiguous");
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await client.close();
    await server.close();
  });

  it("fails closed when searches return different result sources for one ref", async () => {
    const ref = "shared-ref";
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(marketplacePage([externalApiHit(ref)])))
      .mockResolvedValueOnce(Response.json(marketplacePage([nativeApiHit(ref)])));
    const { client, server } = await connectedServer(fetchImpl);

    await client.callTool({ name: "search", arguments: { query: "external" } });
    await client.callTool({ name: "search", arguments: { query: "native" } });
    const callResult = await client.callTool({ name: "call", arguments: { id: ref } });

    expect(callResult.isError).toBe(true);
    expect(JSON.stringify(callResult.content)).toContain(
      "ambiguous across result sources or kinds",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await client.close();
    await server.close();
  });

  it("never falls back to legacy Calls resolution for an uncached external ref", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { client, server } = await connectedServer(fetchImpl);

    const callResult = await client.callTool({
      name: "call",
      arguments: { id: "weather-api" },
    });

    expect(callResult.isError).toBe(true);
    expect(JSON.stringify(callResult.content)).toContain(
      "is not retained by this vAPI process; run call.search again",
    );
    expect(fetchImpl).not.toHaveBeenCalled();

    await client.close();
    await server.close();
  });

  it("evicts whole ref groups and keeps an evicted external ref fail-closed", async () => {
    const pages = Array.from({ length: 5 }, (_, pageIndex) =>
      marketplacePage(
        Array.from({ length: 50 }, (_, itemIndex) =>
          externalApiHit(`external-${pageIndex}-${itemIndex}`),
        ),
      ),
    );
    const fetchImpl = vi.fn<typeof fetch>();
    for (const page of pages) {
      fetchImpl.mockResolvedValueOnce(Response.json(page));
    }
    const { client, server } = await connectedServer(fetchImpl);

    for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
      await client.callTool({
        name: "search",
        arguments: { query: `page ${pageIndex}` },
      });
    }
    const callResult = await client.callTool({
      name: "call",
      arguments: { id: pages[0]!.items[0]!.ref },
    });

    expect(callResult.isError).toBe(true);
    expect(JSON.stringify(callResult.content)).toContain(
      "is not retained by this vAPI process; run call.search again",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(5);

    await client.close();
    await server.close();
  });

  it("serializes confirmed settlement separately when the paid body is unreadable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-mcp-server-"));
    temporaryDirectories.push(directory);
    const config = getDefaultConfig();
    const settlement = { success: true, transaction: `0x${"77".repeat(32)}` };
    const challenge = {
      x402Version: 2,
      resource: { url: "https://93.184.216.34/paid" },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          amount: "2500",
          asset: config.networks["eip155:8453"]!.usdc,
          payTo: "0x1111111111111111111111111111111111111111",
          maxTimeoutSeconds: 60,
          extra: { name: "USD Coin", version: "2" },
        },
      ],
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(challenge, {
          status: 402,
        }),
      )
      .mockResolvedValueOnce(
        new Response("provider body", {
          status: 200,
          headers: {
            "content-length": "1048577",
            "payment-response": Buffer.from(JSON.stringify(settlement), "utf8").toString("base64"),
          },
        }),
      );
    const server = createVapiServer({
      account: privateKeyToAccount(PRIVATE_KEY),
      config,
      fetchImpl,
      ledgerPath: join(directory, "ledger.json"),
      receiptsPath: join(directory, "receipts.jsonl"),
    });
    const client = server;

    const callResult = await client.callTool({
      name: "call",
      arguments: { url: "https://93.184.216.34/paid" },
    });

    const serialized = JSON.stringify(callResult.content);
    expect(callResult.isError).toBe(true);
    expect(serialized).toContain("response_unreadable");
    expect(serialized).toContain("confirmedSettlement");
    expect(serialized).not.toContain("possibleSettlement");
    expect(serialized).toContain(settlement.transaction);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await client.close();
    await server.close();
  });
});

async function connectedServer(fetchImpl: typeof fetch) {
  const directory = await mkdtemp(join(tmpdir(), "vapi-mcp-server-"));
  temporaryDirectories.push(directory);
  const server = createVapiServer({
    account: privateKeyToAccount(PRIVATE_KEY),
    config: getDefaultConfig(),
    fetchImpl,
    ledgerPath: join(directory, "ledger.json"),
    receiptsPath: join(directory, "receipts.jsonl"),
    searchesPath: join(directory, "searches.jsonl"),
  });
  const client = server;
  return { client, server };
}

function marketplacePage(items: MarketplaceHit[]): MarketplaceDiscoveryPage {
  return {
    protocol: "vapi.marketplace.discovery/1",
    items,
    nextCursor: null,
    unavailableKinds: [],
    rankingVersion: "marketplace-ranking-v1",
  };
}

function externalApiHit(ref: string, network = "eip155:8453"): MarketplaceHit {
  return {
    ref,
    kind: "api",
    provenance: "indexed",
    // A mirrored catalog row is never vAPI-verified.
    verification: "none",
    execution: {
      mode: "direct",
      url: "https://93.184.216.34/weather",
      method: "POST",
      network,
    },
    card: {
      title: "External weather API",
      summary: "Weather from the external catalog.",
      badges: [{ code: "external_catalog", label: "External catalog" }],
      facts: [],
    },
    action: { type: "invoke_api", href: "/call/invoke" },
  };
}

function nativeApiHit(
  ref: string,
  verification: MarketplaceHit["verification"] = "verified",
): MarketplaceHit {
  return {
    ref,
    kind: "api",
    provenance: "self_listed",
    verification,
    execution: { mode: "direct" },
    card: {
      title: "Native weather API",
      summary: "Weather from a registered provider.",
      badges: [],
      facts: [],
    },
    action: { type: "invoke_api", href: `/call/${ref}` },
  };
}

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(new URL(`../../sources/src/__fixtures__/${name}`, import.meta.url), "utf8"),
  ) as unknown;
}

function workHit(ref: string): MarketplaceHit {
  return {
    ref,
    kind: "service_offer",
    verification: "none",
    card: {
      title: "Research brief",
      summary: "Evidence-backed market research.",
      badges: [],
      facts: [],
    },
    action: { type: "start_engagement", href: `/work/listings/${ref}` },
  };
}

describe("MCP request dispatch", () => {
  it("initializes with the vAPI identity and icons", async () => {
    const server = createVapiServer();
    try {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25" },
      });
      expect(response).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: {
            name: "@vapi-network/mcp",
            title: "vAPI Network",
            version: VAPI_CLIENT_VERSION,
            websiteUrl: "https://vapinetwork.ai",
            icons: SERVER_ICONS,
          },
        },
      });
      expect(SERVER_ICONS.map((icon) => icon.theme)).toEqual(["light", "dark"]);
    } finally {
      await server.close();
    }
  });

  it("lists titles and all four annotation hints through the dispatcher", async () => {
    const { server } = await connectedServer(vi.fn<typeof fetch>());
    try {
      const response = await server.handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const expected = await server.listTools();
      expect(response).toEqual({ jsonrpc: "2.0", id: 2, result: expected });
      for (const tool of expected.tools) {
        expect(tool.title).toEqual(expect.any(String));
        expect(tool.annotations).toEqual({
          readOnlyHint: expect.any(Boolean),
          destructiveHint: expect.any(Boolean),
          idempotentHint: expect.any(Boolean),
          openWorldHint: expect.any(Boolean),
        });
      }
      expect(expected.tools.find((tool) => tool.name === "call.pay")?.annotations).toMatchObject({
        destructiveHint: true,
        readOnlyHint: false,
      });
      expect(expected.tools.find((tool) => tool.name === "call.search")?.annotations).toMatchObject(
        {
          readOnlyHint: true,
          openWorldHint: true,
        },
      );
    } finally {
      await server.close();
    }
  });

  it("drops notifications and requests without a string method", async () => {
    const server = createVapiServer();
    try {
      expect(await server.handleRequest({ method: "initialize" })).toBeUndefined();
      expect(await server.handleRequest({ id: 1, method: 42 })).toBeUndefined();
      expect(await server.handleRequest({ id: 1 })).toBeUndefined();
      expect(await server.handleRequest({ id: null, method: "ping" })).toEqual({
        jsonrpc: "2.0",
        id: null,
        result: {},
      });
      expect(await server.handleRequest({ id: 0, method: "unknown" })).toEqual({
        jsonrpc: "2.0",
        id: 0,
        error: { code: -32601, message: "Method not found: unknown" },
      });
    } finally {
      await server.close();
    }
  });

  it("awaits tool calls and passes their parameters through", async () => {
    const server = createVapiServer();
    const result = { content: [{ type: "text" as const, text: "Tool result" }] };
    const call = vi.spyOn(server, "callTool").mockImplementation(async () => {
      await Promise.resolve();
      return result;
    });
    try {
      expect(
        await server.handleRequest({
          id: "call",
          method: "tools/call",
          params: { name: "docs.search", arguments: { query: "docs" } },
        }),
      ).toEqual({ jsonrpc: "2.0", id: "call", result });
      expect(call).toHaveBeenCalledWith({ name: "docs.search", arguments: { query: "docs" } });
    } finally {
      await server.close();
    }
  });

  it.each([new Error("Dispatch failed"), "Dispatch failed"])(
    "returns internal errors for rejected dispatch: %s",
    async (error) => {
      const server = createVapiServer();
      vi.spyOn(server, "listTools").mockRejectedValue(error);
      try {
        expect(await server.handleRequest({ id: 1, method: "tools/list" })).toEqual({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32603, message: "Dispatch failed" },
        });
      } finally {
        await server.close();
      }
    },
  );

  it("preserves stdio parse errors, silent notifications and newline responses", async () => {
    const server = createVapiServer();
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      server.connectStdio();
      process.stdin.emit(
        "data",
        Buffer.from('  \n{broken\n{"method":"ping"}\n{"id":7,"method":"ping"}\n'),
      );
      await vi.waitFor(() => {
        expect(write.mock.calls.map(([message]) => message)).toEqual([
          '{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}\n',
          '{"jsonrpc":"2.0","id":7,"result":{}}\n',
        ]);
      });
    } finally {
      await server.close();
      write.mockRestore();
    }
  });
});

describe("MCP App resources", () => {
  const apiOrigin = new URL(getDefaultConfig().marketplaceDiscoveryUrl).origin;
  const html = "<html>view</html>";
  const mimeType = "text/html;profile=mcp-app";

  function viewsFetch(status = 200) {
    return vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.startsWith("/mcp/apps/")) return new Response(html, { status });
      throw new Error(`Unexpected request to ${url.pathname}`);
    });
  }

  it("warms both views on initialize, with no eager fetches or repeated successful fetches", async () => {
    const fetchImpl = viewsFetch();
    const { server } = await connectedServer(fetchImpl);
    try {
      expect(apiOrigin).toBe("https://api.vapinetwork.ai");
      expect((await server.listTools()).tools.every((tool) => tool._meta === undefined)).toBe(true);
      await server.handleRequest({ id: 0, method: "resources/list" });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(
        await server.handleRequest({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-11-25" },
        }),
      ).toMatchObject({ result: { capabilities: { tools: {}, resources: {} } } });
      expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
        `${apiOrigin}/mcp/apps/call-search.html`,
        `${apiOrigin}/mcp/apps/call-inspect.html`,
      ]);
      await server.handleRequest({ id: 2, method: "initialize" });
      await server.handleRequest({ id: 3, method: "tools/list" });
      await server.handleRequest({
        id: 4,
        method: "resources/read",
        params: { uri: MCP_APP_VIEWS.search.uri },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      await server.close();
    }
  });

  it("advertises cached views only on Call search, inspect and their aliases with object schemas", async () => {
    const { server } = await connectedServer(viewsFetch());
    try {
      await server.handleRequest({ id: 1, method: "initialize" });
      const tools = await server.listTools();
      expect(await server.handleRequest({ id: 2, method: "tools/list" })).toEqual({
        jsonrpc: "2.0",
        id: 2,
        result: tools,
      });
      for (const tool of tools.tools) {
        const view = Object.hasOwn(MCP_APP_VIEWS, tool.name)
          ? MCP_APP_VIEWS[tool.name as keyof typeof MCP_APP_VIEWS]
          : undefined;
        if (!view) {
          expect(tool).not.toHaveProperty("_meta");
          continue;
        }
        expect(tool._meta).toEqual({ ui: { resourceUri: view.uri }, "ui/resourceUri": view.uri });
        expect(tool._meta?.ui).not.toHaveProperty("domain");
        const schema = tool.outputSchema as {
          type: string;
          properties: Record<string, unknown>;
          required: string[];
        };
        expect(schema.type).toBe("object");
        expect(schema.properties._view).toMatchObject({
          type: "object",
          properties: { createdAt: { type: "number" }, seq: { type: "integer" } },
        });
        expect(schema.required).not.toContain("_view");
      }
    } finally {
      await server.close();
    }
  });

  it("falls back to text on 404 and returns a resource error without logging a retry twice", async () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const fetchImpl = viewsFetch(404);
    const { server } = await connectedServer(fetchImpl);
    try {
      expect(await server.handleRequest({ id: 1, method: "initialize" })).toHaveProperty(
        "result.serverInfo",
      );
      expect((await server.listTools()).tools.every((tool) => tool._meta === undefined)).toBe(true);
      expect(
        await server.handleRequest({
          id: 2,
          method: "resources/read",
          params: { uri: MCP_APP_VIEWS.search.uri },
        }),
      ).toEqual({
        jsonrpc: "2.0",
        id: 2,
        error: { code: -32603, message: "view call-search is unavailable" },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(write).toHaveBeenCalledTimes(2);
    } finally {
      await server.close();
    }
  });

  it("lists two resources with their CSP and returns HTML and the same metadata", async () => {
    const fetchImpl = viewsFetch();
    const { server } = await connectedServer(fetchImpl);
    const resources = [
      {
        uri: "ui://vapi/call-search.html",
        name: "vapi-call-search",
        title: "vAPI marketplace results",
        description: "Interactive list of Call listings returned by call.search.",
        mimeType,
        _meta: {
          ui: {
            csp: {
              connectDomains: [apiOrigin],
              resourceDomains: ["https://assets.claude.ai", apiOrigin],
            },
            prefersBorder: false,
          },
        },
      },
      {
        uri: "ui://vapi/call-inspect.html",
        name: "vapi-call-inspect",
        title: "vAPI listing inspector",
        description: "Interactive request contract and price for one Call listing.",
        mimeType,
        _meta: {
          ui: {
            csp: {
              connectDomains: [apiOrigin],
              resourceDomains: ["https://assets.claude.ai", apiOrigin],
            },
            prefersBorder: true,
          },
        },
      },
    ];
    try {
      expect(await server.handleRequest({ id: 1, method: "resources/list" })).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: { resources },
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      for (const resource of resources) {
        expect(
          await server.handleRequest({
            id: 2,
            method: "resources/read",
            params: { uri: resource.uri },
          }),
        ).toEqual({
          jsonrpc: "2.0",
          id: 2,
          result: {
            contents: [{ uri: resource.uri, mimeType, text: html, _meta: resource._meta }],
          },
        });
      }
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      for (const uri of ["ui://vapi/nope.html", undefined, "toString"]) {
        expect(
          await server.handleRequest({ id: 3, method: "resources/read", params: { uri } }),
        ).toEqual({
          jsonrpc: "2.0",
          id: 3,
          error: { code: -32002, message: "resource not found" },
        });
      }
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      await server.close();
    }
  });

  it("advertises only the view whose read succeeded, even before initialize", async () => {
    const { server } = await connectedServer(viewsFetch());
    try {
      await server.handleRequest({
        id: 1,
        method: "resources/read",
        params: { uri: MCP_APP_VIEWS.search.uri },
      });
      const { tools } = await server.listTools();
      expect(tools.filter((tool) => tool._meta).map((tool) => tool.name)).toEqual([
        "call.search",
        "search",
      ]);
    } finally {
      await server.close();
    }
  });

  it("keeps the docs-only server resource-free without any network access", async () => {
    const fetchImpl = viewsFetch();
    const server = createVapiServer({ fetchImpl });
    try {
      expect(await server.handleRequest({ id: 1, method: "resources/list" })).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: { resources: [] },
      });
      expect(
        await server.handleRequest({
          id: 2,
          method: "resources/read",
          params: { uri: MCP_APP_VIEWS.search.uri },
        }),
      ).toEqual({
        jsonrpc: "2.0",
        id: 2,
        error: { code: -32002, message: "resource not found" },
      });
      await server.handleRequest({ id: 3, method: "initialize" });
      expect((await server.listTools()).tools.every((tool) => tool._meta === undefined)).toBe(true);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("bounds initialize when the asset fetch never settles", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const { server } = await connectedServer(fetchImpl);
    vi.useFakeTimers();
    server.useViews(
      createViewLoader({ registryUrl: apiOrigin, fetchImpl, timeoutMs: 10, log: vi.fn() }),
    );
    try {
      const pending = server.handleRequest({ id: 1, method: "initialize" });
      await vi.advanceTimersByTimeAsync(10);
      expect(await pending).toHaveProperty("result.serverInfo");
      expect((await server.listTools()).tools.every((tool) => tool._meta === undefined)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      await server.close();
    }
  });

  it.each([
    {
      discovery: "https://registry.example/prefix/api/call/discovery",
      override: undefined,
      expectedOrigin: "https://registry.example",
    },
    {
      discovery: "https://registry.example/api/call/discovery",
      override: "https://override.example/prefix",
      expectedOrigin: "https://override.example",
    },
  ])(
    "uses the configured API origin $expectedOrigin for assets and CSP",
    async ({ discovery, override, expectedOrigin }) => {
      const fetchImpl = viewsFetch();
      const server = createVapiServer({
        account: privateKeyToAccount(PRIVATE_KEY),
        config: { ...getDefaultConfig(), marketplaceDiscoveryUrl: discovery },
        fetchImpl,
        ...(override ? { agentLink: { apiBase: override } } : {}),
      });
      try {
        await server.handleRequest({ id: 1, method: "initialize" });
        expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
          `${expectedOrigin}/mcp/apps/call-search.html`,
          `${expectedOrigin}/mcp/apps/call-inspect.html`,
        ]);
        expect(await server.handleRequest({ id: 2, method: "resources/list" })).toMatchObject({
          result: {
            resources: [
              {
                _meta: {
                  ui: {
                    csp: {
                      connectDomains: [expectedOrigin],
                      resourceDomains: ["https://assets.claude.ai", expectedOrigin],
                    },
                  },
                },
              },
              {
                _meta: {
                  ui: {
                    csp: {
                      connectDomains: [expectedOrigin],
                      resourceDomains: ["https://assets.claude.ai", expectedOrigin],
                    },
                  },
                },
              },
            ],
          },
        });
      } finally {
        await server.close();
      }
    },
  );

  it("stamps successful search and inspect results and aliases without changing text or stamping errors", async () => {
    const createdAt = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(createdAt);
    const page = {
      ...marketplacePage([externalApiHit("weather")]),
      rankingVersion: "marketplace-ranking-v2",
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (pathname === "/api/call/discovery") return Response.json(page);
      if (pathname === "/api/call/services") return Response.json({ services: [] });
      throw new Error(`Unexpected request to ${pathname}`);
    });
    const { server } = await connectedServer(fetchImpl);
    try {
      const failed = await server.callTool({ name: "call.search", arguments: { limit: 0 } });
      expect(failed.isError).toBe(true);
      expect(failed.structuredContent).toBeUndefined();
      const requests = [
        { name: "call.search", arguments: { query: "weather", includeOutage: true } },
        { name: "call.search", arguments: { query: "weather" } },
        { name: "search", arguments: { query: "weather" } },
        { name: "call.inspect", arguments: { id: "weather" } },
        { name: "inspect", arguments: { id: "weather" } },
      ];
      for (const [index, request] of requests.entries()) {
        const result = await server.callTool(request);
        expect(result.isError).not.toBe(true);
        const { _view, ...payload } = result.structuredContent ?? {};
        expect(_view).toEqual({ createdAt, seq: index + 1 });
        expect(Array.isArray(payload.hints)).toBe(true);
        expect((payload.hints as string[]).length).toBeLessThanOrEqual(4);
        if (request.name === "call.search" || request.name === "search") {
          expect(payload.rankingVersion).toBe("marketplace-ranking-v2");
        }
        const text = result.content[0]?.text ?? "";
        const body = request.name.includes(".") ? text : text.slice(text.indexOf("\n") + 1);
        expect(body).toBe(JSON.stringify(payload, null, 2));
      }
      expect(String(fetchImpl.mock.calls[0]![0])).toContain("includeOutage=true");
      const second = await connectedServer(fetchImpl);
      try {
        expect(
          (await second.server.callTool({ name: "call.search", arguments: { query: "weather" } }))
            .structuredContent?._view,
        ).toEqual({ createdAt, seq: 1 });
      } finally {
        await second.server.close();
      }
      expect(fetchImpl.mock.calls.every(([input]) => !String(input).includes("/mcp/apps/"))).toBe(
        true,
      );
    } finally {
      await server.close();
    }
  });
});

describe("VapiMcpServer.connect", () => {
  it("serves JSON-RPC over caller-supplied streams", async () => {
    const input = new PassThrough();
    const written: string[] = [];
    const server = createVapiServer({});
    server.connect(input, { write: (chunk: string) => written.push(chunk) });

    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const replies = written.map((line) => JSON.parse(line) as { id: number; result: unknown });
    expect(replies.map((reply) => reply.id)).toEqual([1, 2]);
    expect((replies[0]?.result as { serverInfo: { name: string } }).serverInfo.name).toBe(
      "@vapi-network/mcp",
    );
    expect((replies[1]?.result as { tools: unknown[] }).tools.length).toBeGreaterThan(0);

    input.end();
  });
});
