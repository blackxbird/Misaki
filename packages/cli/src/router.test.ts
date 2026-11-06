import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SpendCapError,
  SpendCapExceededError,
  getDefaultConfig,
  type Receipt,
  type SecretStore,
  WalletStore,
} from "@vapi-network/core";
import { AGENT_LINK_REVOKED_MESSAGE, agentSecretAccounts } from "@vapi-network/core/agent-link";
import {
  ROUTER_KEY_REVOKED_MESSAGE,
  RouterClientError,
  type buyRouterBalance,
  type AgentRouterUsage,
  type ChatRequest,
  type ChatResult,
  type RouterClientDeps,
} from "@vapi-network/core/router-client";

import { runCli, type CliDependencies, type CliIo } from "./cli.js";
import { purchaseTransport } from "../../../test-fixtures/router-purchase.js";

const PASSPHRASE = "test-only-passphrase";
const WALLET = "researcher";
const TEST_ROUTER_KEY = "test-router-key-value";
const REVOKED_ACCESS_TOKEN = "revoked-agent-access-token";
const REVOKED_REFRESH_TOKEN = "revoked-agent-refresh-token";
const REVOKED_ROUTER_KEY = "revoked-router-key";
const homes: string[] = [];
const originalHome = process.env.VAPI_HOME;
let activeSecretStore: SecretStore | undefined;
let activeSecretEntries: Record<string, string> | undefined;

afterEach(async () => {
  restoreEnvironment("VAPI_HOME", originalHome);
  activeSecretStore = undefined;
  activeSecretEntries = undefined;
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("vapi router models", () => {
  it("prints model ids in human and JSON output without requiring a link", async () => {
    await initializedHome();
    const listRouterModels = vi.fn(async () => [{ id: "model-a" }, { id: "model-b" }]);
    const dependencies = commandDependencies({ router: { listRouterModels } });
    const human = captureIo();

    expect(await runCli(["router", "models", "--wallet", WALLET], human.io, dependencies)).toBe(0);
    expect(human.stdout).toEqual(["model-a", "model-b"]);
    expect(listRouterModels).toHaveBeenCalledWith({ apiBase: "https://api.vapinetwork.ai/" });

    const json = captureIo();
    expect(
      await runCli(["router", "models", "--wallet", WALLET, "--json"], json.io, dependencies),
    ).toBe(0);
    expect(JSON.parse(json.stdout[0]!)).toEqual(["model-a", "model-b"]);
  });
});

describe("vapi router usage", () => {
  it("prints the Compute allowance and preserves the usage object as JSON", async () => {
    await initializedHome();
    const usage = usageResult();
    const dependencies = commandDependencies({
      router: { routerUsage: vi.fn(async () => usage) },
    });
    const human = captureIo();

    expect(await runCli(["router", "usage", "--wallet", WALLET], human.io, dependencies)).toBe(0);
    expect(human.stdout).toEqual([
      "Compute today: $0.42 of $2.00 (resets 03:07 UTC)",
      "Owner's Compute: $0.90 of $5.00",
      "Router balance: none bought yet",
    ]);

    const json = captureIo();
    expect(
      await runCli(["router", "usage", "--wallet", WALLET, "--json"], json.io, dependencies),
    ).toBe(0);
    expect(JSON.parse(json.stdout[0]!)).toEqual(usage);
  });

  it("formats a purchased Router balance", async () => {
    await initializedHome();
    const dependencies = commandDependencies({
      router: {
        routerUsage: async () => ({
          ...usageResult(),
          balance: { purchasedUsd: 10, spentUsd: 2.25, remainingUsd: 7.75 },
        }),
      },
    });
    const captured = captureIo();

    expect(await runCli(["router", "usage", "--wallet", WALLET], captured.io, dependencies)).toBe(
      0,
    );
    expect(captured.stdout).toContain("Router balance: $7.75 (bought $10.00, used $2.25)");
  });
});

describe("vapi router buy", () => {
  it.each(["audit", "key", "balance"] as const)(
    "returns success through real payment when %s follow-up fails",
    async (failure) => {
      const dependencies = await linkedRouterDependencies(
        async (input, init) => await transport.fetchImpl(input, init),
      );
      const home = process.env.VAPI_HOME!;
      const transport = purchaseTransport(home, failure);
      await writeFile(
        join(home, "config.json"),
        JSON.stringify({ ...getDefaultConfig({}), allowPrivateNetwork: true }),
      );
      const store = await WalletStore.open(home, { secrets: currentSecretStore() });
      await store.setSpendCaps(WALLET, { perCallAtomic: "5000000", perDayAtomic: "20000000" });
      const captured = captureIo();
      expect(
        await runCli(
          ["router", "buy", "5", "--wallet", WALLET, "--json"],
          captured.io,
          dependencies,
        ),
      ).toBe(0);
      expect(transport.calls.paid).toBe(1);
      expect(JSON.parse(captured.stdout[0]!)).toMatchObject({
        amountUsd: 4.75,
        receiptId: expect.any(String),
        warnings: [
          {
            code:
              failure === "audit"
                ? "audit_unavailable"
                : failure === "key"
                  ? "router_key_unavailable"
                  : "balance_unavailable",
          },
        ],
      });
      expect(allOutput(captured)).not.toContain("private-follow-up-error-must-not-leak");
    },
  );

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
      await initializedHome();
      const receipt: Receipt = {
        ...purchaseResult().receipt,
        quote,
        settlement: { outcome: "succeeded", transaction: "0xtransaction", evidence },
      };
      const buy = vi.fn<typeof buyRouterBalance>(async () => ({ receipt, balance: null }));
      const dependencies = {
        ...commandDependencies(),
        router: { buyRouterBalance: buy },
      };
      const captured = captureIo();

      expect(
        await runCli(
          ["router", "buy", "5", "--wallet", WALLET, "--json"],
          captured.io,
          dependencies,
        ),
      ).toBe(0);
      expect(JSON.parse(captured.stdout[0]!)).toMatchObject({ amountUsd, network, tierUsd: 5 });
      expect(buy).toHaveBeenCalledTimes(1);

      const human = captureIo();
      expect(await runCli(["router", "buy", "5", "--wallet", WALLET], human.io, dependencies)).toBe(
        0,
      );
      expect(human.stdout.join("\n")).toContain(
        amountUsd === null ? "charged amount unknown" : "Paid $4.75 USDC",
      );
    },
  );

  it("unlocks the wallet, applies its spend caps, and prints the paid balance", async () => {
    await initializedHome();
    const buy = vi.fn<typeof buyRouterBalance>(async () => purchaseResult());
    const secret = vi.fn(async () => PASSPHRASE);
    const captured = captureIo();

    expect(
      await runCli(["router", "buy", "5", "--wallet", WALLET], captured.io, {
        ...commandDependencies(),
        interactive: true,
        prompts: { secret },
        router: { buyRouterBalance: buy },
      }),
    ).toBe(0);
    expect(captured.stdout).toEqual(["Paid $5.00 USDC on Base. Router balance: $7.40."]);
    expect(secret).not.toHaveBeenCalled();
    expect(buy).toHaveBeenCalledWith(
      expect.objectContaining({
        wallet: WALLET,
        caps: { perCallAtomic: "100000", perDayAtomic: "1000000" },
        paths: expect.objectContaining({
          ledgerPath: expect.stringContaining("spend-ledger.json"),
          receiptsPath: expect.stringContaining("receipts.jsonl"),
        }),
      }),
      5,
    );
  });

  it("prints a secret-free JSON summary and handles a not-yet-visible balance", async () => {
    await initializedHome();
    const buy = vi.fn<typeof buyRouterBalance>(async () => purchaseResult(null));
    const dependencies = {
      ...commandDependencies(),
      interactive: true,
      prompts: { secret: async () => PASSPHRASE },
      router: { buyRouterBalance: buy },
    };
    const json = captureIo();

    expect(
      await runCli(["router", "buy", "5", "--wallet", WALLET, "--json"], json.io, dependencies),
    ).toBe(0);
    expect(JSON.parse(json.stdout[0]!)).toEqual({
      tierUsd: 5,
      amountUsd: 5,
      network: "eip155:8453",
      transaction: "0xtransaction",
      receiptId: "router-receipt",
      balance: null,
    });
    expect(allOutput(json)).not.toContain(TEST_ROUTER_KEY);

    const human = captureIo();
    expect(await runCli(["router", "buy", "5", "--wallet", WALLET], human.io, dependencies)).toBe(
      0,
    );
    expect(human.stdout).toEqual(["Paid $5.00 USDC on Base. Router balance is not visible yet."]);
  });

  it("stores and clears automatic refill without unlocking the wallet", async () => {
    const home = await initializedHome();
    const secret = vi.fn(async () => PASSPHRASE);
    const human = captureIo();
    const dependencies = {
      ...commandDependencies(),
      interactive: true,
      prompts: { secret },
    };

    expect(
      await runCli(
        ["router", "buy", "--auto", "5", "--below", "2.50", "--wallet", WALLET],
        human.io,
        dependencies,
      ),
    ).toBe(0);
    expect(human.stdout).toEqual([
      "Automatic Router refill: buy $5.00 when the balance is below $2.50.",
    ]);
    expect(
      (await WalletStore.open(home, { secrets: currentSecretStore() })).entry(WALLET)?.routerRefill,
    ).toEqual({
      tierUsd: 5,
      belowUsd: 2.5,
    });
    expect(secret).not.toHaveBeenCalled();

    const json = captureIo();
    expect(
      await runCli(
        ["router", "buy", "--auto", "off", "--wallet", WALLET, "--json"],
        json.io,
        dependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(json.stdout[0]!)).toEqual({ wallet: WALLET, routerRefill: null });
    expect(
      (await WalletStore.open(home, { secrets: currentSecretStore() })).entry(WALLET)?.routerRefill,
    ).toBeUndefined();
    expect(secret).not.toHaveBeenCalled();
  });

  it("rejects unsupported tiers as usage errors", async () => {
    await initializedHome();
    const captured = captureIo();

    expect(
      await runCli(["router", "buy", "3", "--wallet", WALLET, "--json"], captured.io, {
        ...commandDependencies(),
        interactive: true,
        prompts: { secret: async () => PASSPHRASE },
      }),
    ).toBe(2);
    expect(JSON.parse(captured.stdout[0]!)).toEqual({
      error: "Router balance tier must be 1, 5, 20, or 50.",
      exitCode: 2,
    });
  });

  it("reports spend-policy refusal as an operational error with the caps remedy", async () => {
    await initializedHome();
    const buy = vi.fn<typeof buyRouterBalance>(async () => {
      throw new SpendCapError("per_call_cap_exceeded", "Refusing to sign.");
    });
    const captured = captureIo();

    expect(
      await runCli(["router", "buy", "5", "--wallet", WALLET, "--json"], captured.io, {
        ...commandDependencies(),
        interactive: true,
        prompts: { secret: async () => PASSPHRASE },
        router: { buyRouterBalance: buy },
      }),
    ).toBe(1);
    expect(JSON.parse(captured.stdout[0]!)).toEqual({
      error:
        "Router balance purchase refused by the wallet spend policy: Refusing to sign. Review or change it with vapi accounts caps researcher.",
      exitCode: 1,
    });
  });

  it("preserves a typed spend-cap refusal for the top-level JSON handler", async () => {
    await initializedHome();
    const refusal = new SpendCapExceededError({
      cap: "per_call",
      amountUsd: "5",
      limitUsd: "1",
      wallet: WALLET,
    });
    const buy = vi.fn<typeof buyRouterBalance>(async () => {
      throw refusal;
    });
    const captured = captureIo();

    expect(
      await runCli(["router", "buy", "5", "--wallet", WALLET, "--json"], captured.io, {
        ...commandDependencies(),
        interactive: true,
        prompts: { secret: async () => PASSPHRASE },
        router: { buyRouterBalance: buy },
      }),
    ).toBe(1);
    expect(JSON.parse(captured.stdout[0]!)).toEqual({ error: refusal.toJSON(), exitCode: 1 });
  });
});

describe("vapi router chat", () => {
  it("preserves settled refill evidence in chat errors and payment-aware guidance", async () => {
    await initializedHome();
    const purchase = {
      ...purchaseResult(null),
      warnings: [{ code: "router_key_unavailable" as const, message: "Key recovery is pending." }],
    };
    const message =
      "Payment settled, but the Router balance key is not yet available. It will be fetched on the next request.";
    const dependencies = commandDependencies({
      router: {
        routerChat: async () => {
          throw new RouterClientError("refill_pending", message, undefined, purchase);
        },
      },
    });
    const json = captureIo();
    expect(
      await runCli(
        ["router", "chat", "--wallet", WALLET, "--model", "model-a", "hi", "--json"],
        json.io,
        dependencies,
      ),
    ).toBe(1);
    expect(JSON.parse(json.stdout[0]!)).toMatchObject({
      error: message,
      code: "refill_pending",
      exitCode: 1,
      refill: {
        receipt: { id: "router-receipt", amountUsd: 5 },
        balance: null,
        warnings: purchase.warnings,
      },
    });
    const human = captureIo();
    expect(
      await runCli(
        ["router", "chat", "--wallet", WALLET, "--model", "model-a", "hi"],
        human.io,
        dependencies,
      ),
    ).toBe(1);
    expect(human.stderr).toContain(message);
  });

  it("keeps auto-refill warnings in chat JSON and human diagnostics", async () => {
    await initializedHome();
    const refill = {
      ...purchaseResult(null),
      warnings: [
        {
          code: "balance_unavailable" as const,
          message: "Payment succeeded; balance unavailable.",
        },
      ],
    };
    const dependencies = commandDependencies({
      router: { routerChat: async () => ({ ...chatResult(), refill }) },
    });
    const json = captureIo();
    expect(
      await runCli(
        ["router", "chat", "--wallet", WALLET, "--model", "model-a", "hi", "--json"],
        json.io,
        dependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(json.stdout[0]!)).toMatchObject({
      content: "Done.",
      refill: { receiptId: "router-receipt", balance: null, warnings: refill.warnings },
    });
    const human = captureIo();
    expect(
      await runCli(
        ["router", "chat", "--wallet", WALLET, "--model", "model-a", "hi"],
        human.io,
        dependencies,
      ),
    ).toBe(0);
    expect(human.stderr).toContain(refill.warnings[0]!.message);
  });

  it("builds system and user messages and prints human and JSON results", async () => {
    await initializedHome();
    const result: ChatResult = {
      model: "model-a",
      content: "Hello from the Router.",
      toolCalls: [],
      usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
      keyUsed: "stake",
    };
    const routerChat = vi.fn(async (_deps: RouterClientDeps, _request: ChatRequest) => result);
    const dependencies = commandDependencies({ router: { routerChat } });
    const human = captureIo();

    expect(
      await runCli(
        [
          "router",
          "chat",
          "--wallet",
          WALLET,
          "--model",
          "model-a",
          "--system",
          "Be concise.",
          "--max-tokens",
          "200",
          "Hello",
        ],
        human.io,
        dependencies,
      ),
    ).toBe(0);
    expect(human.stdout).toEqual(["Hello from the Router."]);
    expect(routerChat.mock.calls[0]![1]).toEqual({
      model: "model-a",
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "Hello" },
      ],
      max_tokens: 200,
    });

    const json = captureIo();
    expect(
      await runCli(
        ["router", "chat", "--wallet", WALLET, "--model", "model-a", "Hello", "--json"],
        json.io,
        dependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(json.stdout[0]!)).toEqual({
      model: "model-a",
      content: "Hello from the Router.",
      usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
    });
  });

  it("reads a dash prompt from the injected stdin reader", async () => {
    await initializedHome();
    const routerChat = vi.fn(async (_deps: RouterClientDeps, _request: ChatRequest) =>
      chatResult(),
    );
    const readStdin = vi.fn(async () => "Prompt from stdin\n");
    const captured = captureIo();

    expect(
      await runCli(
        ["router", "chat", "--wallet", WALLET, "--model", "model-a", "-"],
        captured.io,
        commandDependencies({ router: { routerChat }, readStdin }),
      ),
    ).toBe(0);
    expect(readStdin).toHaveBeenCalledOnce();
    expect(routerChat.mock.calls[0]![1].messages).toEqual([
      { role: "user", content: "Prompt from stdin\n" },
    ]);
  });

  it("reports a revoked link in one line for chat, including JSON errors", async () => {
    const fetchImpl = revokedLinkFetch();
    const dependencies = await linkedRouterDependencies(fetchImpl);
    const human = captureIo();

    expect(
      await runCli(
        ["router", "chat", "--wallet", WALLET, "--model", "model-a", "Hello"],
        human.io,
        dependencies,
      ),
    ).toBe(1);
    expect(human.stdout).toEqual([]);
    expect(human.stderr).toEqual([
      "--wallet is now --account; --wallet keeps working for one release.",
      AGENT_LINK_REVOKED_MESSAGE,
    ]);
    expect(human.stderr.join("\n")).not.toContain("could not be read safely");
    expect(human.stderr.join("\n")).not.toMatch(/\bat\s/);
    expect(allOutput(human)).not.toContain(REVOKED_ACCESS_TOKEN);
    expect(allOutput(human)).not.toContain(REVOKED_REFRESH_TOKEN);
    expect(allOutput(human)).not.toContain(REVOKED_ROUTER_KEY);

    const json = captureIo();
    expect(
      await runCli(
        ["router", "chat", "--wallet", WALLET, "--model", "model-a", "Hello", "--json"],
        json.io,
        dependencies,
      ),
    ).toBe(1);
    expect(JSON.parse(json.stdout[0]!)).toEqual({ error: AGENT_LINK_REVOKED_MESSAGE, exitCode: 1 });
    expect(json.stderr).toEqual([
      "--wallet is now --account; --wallet keeps working for one release.",
    ]);
    expect(allOutput(json)).not.toContain(REVOKED_ACCESS_TOKEN);
    expect(allOutput(json)).not.toContain(REVOKED_REFRESH_TOKEN);
    expect(allOutput(json)).not.toContain(REVOKED_ROUTER_KEY);
  });

  it("reports a revoked Router link for usage and key rotation", async () => {
    const fetchImpl = revokedLinkFetch();
    const dependencies = await linkedRouterDependencies(fetchImpl);

    for (const argv of [
      ["router", "usage", "--wallet", WALLET],
      ["router", "key", "--rotate", "--wallet", WALLET],
    ]) {
      const captured = captureIo();
      expect(await runCli(argv, captured.io, dependencies)).toBe(1);
      expect(captured.stdout).toEqual([]);
      expect(captured.stderr).toEqual([
        "--wallet is now --account; --wallet keeps working for one release.",
        AGENT_LINK_REVOKED_MESSAGE,
      ]);
      expect(allOutput(captured)).not.toContain(REVOKED_ACCESS_TOKEN);
      expect(allOutput(captured)).not.toContain(REVOKED_REFRESH_TOKEN);
      expect(allOutput(captured)).not.toContain(REVOKED_ROUTER_KEY);
    }
  });

  it("reports a rejected Router key when the agent link is still active", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.host === "router.example") return new Response("rejected", { status: 401 });
      if (url.pathname === "/api/agents/self/router") return Response.json(usageResult());
      throw new Error(`Unexpected test URL ${url.origin}${url.pathname}`);
    });
    const dependencies = await linkedRouterDependencies(fetchImpl);
    const captured = captureIo();

    expect(
      await runCli(
        ["router", "chat", "--wallet", WALLET, "--model", "model-a", "Hello"],
        captured.io,
        dependencies,
      ),
    ).toBe(1);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual([
      "--wallet is now --account; --wallet keeps working for one release.",
      ROUTER_KEY_REVOKED_MESSAGE,
    ]);
    expect(allOutput(captured)).not.toContain(REVOKED_ACCESS_TOKEN);
    expect(allOutput(captured)).not.toContain(REVOKED_REFRESH_TOKEN);
    expect(allOutput(captured)).not.toContain(REVOKED_ROUTER_KEY);
  });

  it("offers auto-refill for a device-vault wallet without prompting", async () => {
    const home = await initializedHome();
    const store = await WalletStore.open(home, { secrets: currentSecretStore() });
    await store.setRouterRefill(WALLET, { tierUsd: 5, belowUsd: 2 });
    const prompt = vi.fn(async () => PASSPHRASE);
    const unlockedChat = vi.fn(async (_deps: RouterClientDeps, _request: ChatRequest) =>
      chatResult(),
    );
    expect(
      await runCli(
        ["router", "chat", "--wallet", WALLET, "--model", "model-a", "Hello"],
        captureIo().io,
        commandDependencies({
          interactive: true,
          prompts: { secret: prompt },
          router: { routerChat: unlockedChat },
        }),
      ),
    ).toBe(0);
    const refill = unlockedChat.mock.calls[0]![0].refill;
    expect(refill).toBeDefined();
    expect(typeof refill!.caps === "function" ? await refill!.caps() : refill!.caps).toEqual({
      perCallAtomic: "100000",
      perDayAtomic: "1000000",
    });
    expect(prompt).not.toHaveBeenCalled();
  });

  it.each([
    [
      ["router", "chat", "hello"],
      'Missing --model <id>.\nUsage: vapi router chat --model <id> [--system <text>] [--max-tokens <n>] "<prompt>".',
    ],
    [
      ["router", "chat", "--model", "model-a"],
      'Missing <prompt>.\nUsage: vapi router chat --model <id> [--system <text>] [--max-tokens <n>] "<prompt>".',
    ],
  ] as const)("rejects an incomplete invocation", async (argv, message) => {
    await initializedHome();
    const captured = captureIo();

    expect(await runCli([...argv, "--json"], captured.io, commandDependencies())).toBe(2);
    expect(JSON.parse(captured.stdout[0]!)).toEqual({ error: message, exitCode: 2 });
  });
});

describe("vapi router key", () => {
  it("prints a Router key only for an allowed terminal run and audits the export", async () => {
    const home = await initializedHome();
    const routerCredentials = vi.fn(async () => ({
      baseURL: "https://router.vapinetwork.ai/v1",
      apiKey: TEST_ROUTER_KEY,
    }));
    const captured = captureIo();

    expect(
      await runCli(
        ["router", "key", "--wallet", WALLET],
        captured.io,
        commandDependencies({ interactive: true, env: {}, router: { routerCredentials } }),
      ),
    ).toBe(0);
    expect(captured.stdout).toEqual([TEST_ROUTER_KEY]);
    expect(captured.stderr.join("\n")).not.toContain(TEST_ROUTER_KEY);
    const audit = await readFile(join(home, "audit.log"), "utf8");
    expect(audit).toContain('"event":"secret.export.key"');
    expect(audit).not.toContain(TEST_ROUTER_KEY);
  });

  it.each([
    ["an agent marker", true, { CLAUDECODE: "1" }, "CLAUDECODE is set."],
    ["non-TTY output", false, {}, "stdin is not a terminal."],
  ])("refuses for %s before reading the key", async (_name, interactive, env, reason) => {
    await initializedHome();
    const routerCredentials = vi.fn(async () => ({
      baseURL: "https://router.vapinetwork.ai/v1",
      apiKey: TEST_ROUTER_KEY,
    }));
    const captured = captureIo();

    expect(
      await runCli(
        ["router", "key", "--wallet", WALLET],
        captured.io,
        commandDependencies({ interactive, env, router: { routerCredentials } }),
      ),
    ).toBe(1);
    expect(routerCredentials).not.toHaveBeenCalled();
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr.join("\n")).toContain(
      "Run this yourself in a terminal; an agent must never see these words.",
    );
    expect(captured.stderr.join("\n")).toContain(reason);
    expect(allOutput(captured)).not.toContain(TEST_ROUTER_KEY);
  });

  it("always refuses JSON output before reading the key", async () => {
    await initializedHome();
    const routerCredentials = vi.fn(async () => ({
      baseURL: "https://router.vapinetwork.ai/v1",
      apiKey: TEST_ROUTER_KEY,
    }));
    const captured = captureIo();

    expect(
      await runCli(
        ["router", "key", "--wallet", WALLET, "--json"],
        captured.io,
        commandDependencies({ interactive: true, env: {}, router: { routerCredentials } }),
      ),
    ).toBe(1);
    expect(routerCredentials).not.toHaveBeenCalled();
    expect(JSON.parse(captured.stdout[0]!)).toEqual({
      error:
        "Run this yourself in a terminal; an agent must never see these words. Router keys are never printed as JSON.",
      exitCode: 1,
    });
    expect(allOutput(captured)).not.toContain(TEST_ROUTER_KEY);
  });

  it("rotates the key without exposing it in human or JSON output", async () => {
    await initializedHome();
    const rotateRouterKey = vi.fn(async () => undefined);
    const dependencies = commandDependencies({ router: { rotateRouterKey } });
    const human = captureIo();

    expect(
      await runCli(["router", "key", "--wallet", WALLET, "--rotate"], human.io, dependencies),
    ).toBe(0);
    expect(human.stdout).toEqual(["New Router key stored."]);
    expect(allOutput(human)).not.toContain(TEST_ROUTER_KEY);

    const json = captureIo();
    expect(
      await runCli(
        ["router", "key", "--wallet", WALLET, "--rotate", "--json"],
        json.io,
        dependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(json.stdout[0]!)).toEqual({ wallet: WALLET, rotated: true });
    expect(allOutput(json)).not.toContain(TEST_ROUTER_KEY);
  });
});

describe("Router client errors", () => {
  it("lists the buy command in the router usage error", async () => {
    const captured = captureIo();

    expect(await runCli(["router", "--json"], captured.io, commandDependencies())).toBe(2);
    expect(JSON.parse(captured.stdout[0]!)).toEqual({
      error: "Usage: vapi router <models|usage|chat|key|buy>.",
      exitCode: 2,
    });
  });

  it("normalizes an unlinked wallet in human and JSON output", async () => {
    await initializedHome();
    const routerUsage = vi.fn(async () => {
      throw new RouterClientError("not_linked", "unsafe service detail");
    });
    const dependencies = commandDependencies({ router: { routerUsage } });
    const human = captureIo();

    expect(await runCli(["router", "usage", "--wallet", WALLET], human.io, dependencies)).toBe(1);
    expect(human.stderr).toEqual([
      "--wallet is now --account; --wallet keeps working for one release.",
      "Not linked. Run vapi login.",
    ]);

    const json = captureIo();
    expect(
      await runCli(["router", "usage", "--wallet", WALLET, "--json"], json.io, dependencies),
    ).toBe(1);
    expect(JSON.parse(json.stdout[0]!)).toEqual({
      error: "Not linked. Run vapi login.",
      exitCode: 1,
    });
  });
});

function usageResult(): AgentRouterUsage {
  return {
    compute: {
      allowanceUsd: 2,
      spentTodayUsd: 0.42,
      remainingTodayUsd: 1.58,
      resetsAt: "2026-09-24T03:07:00.000Z",
      ownerLimitUsd: 5,
      ownerSpentUsd: 0.9,
    },
    balance: null,
  };
}

function purchaseResult(
  balance: AgentRouterUsage["balance"] = {
    purchasedUsd: 10,
    spentUsd: 2.6,
    remainingUsd: 7.4,
  },
): Awaited<ReturnType<typeof buyRouterBalance>> {
  return {
    receipt: {
      id: "router-receipt",
      timestamp: "2026-09-23T12:00:00.000Z",
      resourceUrl: "https://api.vapinetwork.ai/api/router/top-up/5",
      quote: { network: "eip155:8453", amountAtomic: "5000000" },
      settlement: { outcome: "succeeded", transaction: "0xtransaction" },
    },
    balance,
  };
}

function chatResult(): ChatResult {
  return {
    model: "model-a",
    content: "Done.",
    toolCalls: [],
    keyUsed: "stake",
  };
}

function commandDependencies(overrides: Partial<CliDependencies> = {}): CliDependencies {
  return {
    interactive: false,
    env: {},
    secretStore: activeSecretStore ?? secretStoreStub(),
    ...overrides,
  };
}

async function linkedRouterDependencies(fetchImpl: typeof fetch): Promise<CliDependencies> {
  const home = await initializedHome();
  const store = await WalletStore.open(home, { secrets: currentSecretStore() });
  await store.setLink(WALLET, {
    apiBase: "https://console.example",
    clientId: "agent_researcher",
    owner: "0x1111111111111111111111111111111111111111",
    label: WALLET,
    scopes: ["mcp:call", "router.use"],
    linkedAt: "2026-09-23T10:00:00.000Z",
    routerBaseUrl: "https://router.example",
  });
  const accounts = agentSecretAccounts(WALLET);
  const secretStore = currentSecretStore();
  await secretStore.set(
    accounts.tokens,
    JSON.stringify({
      accessToken: REVOKED_ACCESS_TOKEN,
      refreshToken: REVOKED_REFRESH_TOKEN,
      expiresAt: Number.MAX_SAFE_INTEGER,
      scopes: ["mcp:call", "router.use"],
    }),
  );
  await secretStore.set(accounts.routerStake, REVOKED_ROUTER_KEY);
  return commandDependencies({ fetchImpl, secretStore });
}

function revokedLinkFetch(): typeof fetch {
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/oauth/token") {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    if (url.host === "router.example") return new Response("revoked", { status: 401 });
    if (url.pathname.startsWith("/api/agents/self/")) {
      return new Response(null, { status: 401 });
    }
    throw new Error(`Unexpected test URL ${url.origin}${url.pathname}`);
  });
}

function secretStoreStub(entries?: Record<string, string>): SecretStore {
  if (activeSecretStore !== undefined && activeSecretEntries !== undefined) {
    if (entries !== undefined) {
      Object.assign(entries, activeSecretEntries);
      activeSecretEntries = entries;
    }
    return activeSecretStore;
  }
  activeSecretEntries = entries ?? {};
  activeSecretStore = {
    available: true,
    platform: "darwin",
    description: "the macOS Keychain",
    get: async (name) => activeSecretEntries![name],
    has: async (name) => activeSecretEntries![name] !== undefined,
    set: async (name, value) => {
      activeSecretEntries![name] = value;
    },
    remove: async (name) => {
      if (activeSecretEntries![name] === undefined) return false;
      delete activeSecretEntries![name];
      return true;
    },
  };
  return activeSecretStore;
}

function currentSecretStore(): SecretStore {
  if (activeSecretStore === undefined) throw new Error("Test home has no secret store.");
  return activeSecretStore;
}

function captureIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
  };
}

function allOutput(captured: { stdout: string[]; stderr: string[] }): string {
  return [...captured.stdout, ...captured.stderr].join("\n");
}

async function initializedHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "vapi-router-cli-"));
  homes.push(home);
  process.env.VAPI_HOME = home;
  const secrets = secretStoreStub();
  const store = await WalletStore.open(home, { secrets });
  await store.create(WALLET, PASSPHRASE);
  return home;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
