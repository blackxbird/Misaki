import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";

import { createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { readAuditLog } from "./audit.js";
import { drainCeilingSweeps } from "./ceiling.js";
import { getDefaultConfig } from "./config.js";
import { NETWORKS } from "./networks.js";
import { readReceipts } from "./receipts.js";
import { createRunBudget } from "./run-budget.js";
import { SpendCapExceededError } from "./spend-cap-exceeded.js";
import { readSpendLedger, reserveSpend } from "./spend-policy.js";
import {
  ARC_TESTNET_CAIP2,
  BASE_MAINNET_CAIP2,
  SOLANA_MAINNET_CAIP2,
  SOLANA_MAINNET_USDC,
  X402_SOLANA_MAINNET_CAIP2,
} from "./x402-networks.js";
import { completeX402Payment, payRequest } from "./x402-pay.js";
import * as x402 from "./x402.js";

const PAY_TO = getAddress("0x1111111111111111111111111111111111111111");
const PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as Hex;
const NOW = new Date("2026-09-23T10:00:00.000Z");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function exactOffer(network: string, amount = "2500") {
  const configured = NETWORKS[network as keyof typeof NETWORKS];
  if (!configured) throw new Error(`Missing configured network ${network}.`);
  return {
    scheme: "exact",
    network,
    amount,
    asset: configured.usdc,
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra:
      network === ARC_TESTNET_CAIP2
        ? { name: "USDC", version: "2" }
        : { name: "USD Coin", version: "2" },
  };
}

function challenge(accepts: unknown[] = [exactOffer(BASE_MAINNET_CAIP2)]) {
  return {
    x402Version: 2,
    resource: {
      url: "https://vendor.example/paid",
      description: "Fixture endpoint",
      mimeType: "application/json",
    },
    accepts,
  };
}

function paymentRequired(accepts?: unknown[]) {
  return new Response(JSON.stringify(challenge(accepts)), {
    status: 402,
    headers: { "content-type": "application/json" },
  });
}

function paidResponse(transaction = `0x${"33".repeat(32)}`) {
  const settlement = { success: true, transaction };
  return new Response(JSON.stringify({ paid: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "payment-response": Buffer.from(JSON.stringify(settlement), "utf8").toString("base64"),
    },
  });
}

async function paths() {
  const directory = await mkdtemp(join(tmpdir(), "vapi-core-x402-pay-"));
  temporaryDirectories.push(directory);
  return {
    directory,
    ledgerPath: join(directory, "spend-ledger.json"),
    receiptsPath: join(directory, "receipts.jsonl"),
  };
}

describe("payRequest", () => {
  it("retains settlement evidence when the final receipt clock throws", async () => {
    const localPaths = await paths();
    const paid = paidResponse();
    let finalClock = false;
    const get = paid.headers.get.bind(paid.headers);
    vi.spyOn(paid.headers, "get").mockImplementation((name) => {
      if (name.toLowerCase() === "x-vapi-payment-proof") finalClock = true;
      return get(name);
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(paymentRequired())
      .mockResolvedValueOnce(paid);
    const result = await payRequest({
      url: "https://vendor.example/paid",
      init: { method: "POST" },
      account: privateKeyToAccount(PRIVATE_KEY),
      wallet: "main",
      caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
      config: getDefaultConfig(),
      fetchImpl,
      paths: localPaths,
      now: NOW,
      nowMs: () => {
        if (finalClock) throw new Error("private-clock-error");
        return 0;
      },
      lookup: async () => ["93.184.216.34"],
    });
    expect(result.receipt).toMatchObject({
      outcome: "paid",
      settlement: { outcome: "succeeded" },
      quote: { amountAtomic: "2500" },
      latencyMs: 0,
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "payment_followup_unavailable" })]),
    );
    expect(JSON.stringify(result)).not.toContain("private-clock-error");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((await readReceipts(localPaths.receiptsPath))[0]?.id).toBe(result.receipt.id);
  });

  it("validates receipt metadata before sending a payment", async () => {
    const localPaths = await paths();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(paymentRequired())
      .mockResolvedValueOnce(paidResponse());
    await expect(
      payRequest({
        url: "https://vendor.example/paid",
        init: { method: "POST" },
        account: privateKeyToAccount(PRIVATE_KEY),
        wallet: "main",
        source: "",
        caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
        config: getDefaultConfig(),
        fetchImpl,
        paths: localPaths,
        now: NOW,
        lookup: async () => ["93.184.216.34"],
      }),
    ).rejects.toBeDefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns a warning when receipt validation fails after settlement", async () => {
    const localPaths = await paths();
    let settled = false;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      if (settled) throw new Error("Unexpected repeat payment");
      if (fetchImpl.mock.calls.length === 1) return paymentRequired();
      settled = true;
      return paidResponse();
    });
    const result = await payRequest({
      url: "https://vendor.example/paid",
      init: { method: "POST" },
      account: privateKeyToAccount(PRIVATE_KEY),
      wallet: "main",
      caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
      config: getDefaultConfig(),
      fetchImpl,
      paths: localPaths,
      now: NOW,
      nowMs: () => (settled ? NaN : 0),
      lookup: async () => ["93.184.216.34"],
    });
    expect(result).toMatchObject({
      receipt: { outcome: "paid", settlement: { outcome: "succeeded" } },
      warnings: [{ code: "receipt_unavailable" }],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retains the settled receipt when response-proof processing fails after confirmation", async () => {
    const localPaths = await paths();
    const paid = paidResponse();
    const get = paid.headers.get.bind(paid.headers);
    vi.spyOn(paid.headers, "get").mockImplementation((name) => {
      if (name.toLowerCase() === "x-vapi-payment-proof")
        throw new Error("private-proof-error-must-not-leak");
      return get(name);
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(paymentRequired())
      .mockResolvedValueOnce(paid);
    const result = await payRequest({
      url: "https://vendor.example/paid",
      init: { method: "POST" },
      account: privateKeyToAccount(PRIVATE_KEY),
      wallet: "main",
      caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
      config: getDefaultConfig(),
      fetchImpl,
      paths: localPaths,
      now: NOW,
      lookup: async () => ["93.184.216.34"],
    });
    expect(result).toMatchObject({
      receipt: { outcome: "paid", settlement: { outcome: "succeeded" } },
      warnings: [{ code: "payment_followup_unavailable" }],
    });
    expect(JSON.stringify(result)).not.toContain("private-proof-error-must-not-leak");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])(
    "receipt-write failure becomes a warning only after confirmed settlement=%s",
    async (confirmed) => {
      const localPaths = await paths();
      await mkdir(localPaths.receiptsPath);
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(confirmed ? paymentRequired() : new Response("unpaid"));
      if (confirmed) fetchImpl.mockResolvedValueOnce(paidResponse());
      const payment = payRequest({
        url: "https://vendor.example/paid",
        init: { method: "POST" },
        account: privateKeyToAccount(PRIVATE_KEY),
        wallet: "main",
        caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
        config: getDefaultConfig(),
        fetchImpl,
        paths: localPaths,
        now: NOW,
        lookup: async () => ["93.184.216.34"],
      });
      if (confirmed) {
        await expect(payment).resolves.toMatchObject({
          receipt: { wallet: "main", outcome: "paid", settlement: { outcome: "succeeded" } },
          warnings: [{ code: "receipt_unavailable" }],
        });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
      } else {
        await expect(payment).rejects.toMatchObject({ code: "EISDIR" });
      }
    },
  );

  it("preserves a non-secret Uint8Array consumed response body", async () => {
    const localPaths = await paths();
    const bytes = Uint8Array.from([0, 1, 2, 127, 255]);
    const challengeRequest = new Request("https://vendor.example/paid");
    const paid = paidResponse();

    const result = await completeX402Payment({
      challenge: {
        response: paymentRequired(),
        request: challengeRequest,
        finish() {},
        async waitFor<T>(operation: Promise<T>): Promise<T> {
          return await operation;
        },
      },
      account: privateKeyToAccount(PRIVATE_KEY),
      caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
      config: getDefaultConfig(),
      ledgerPath: localPaths.ledgerPath,
      wallet: "main",
      now: NOW,
      send: async (request) => ({
        response: paid,
        request,
        finish() {},
        async waitFor<T>(operation: Promise<T>): Promise<T> {
          return await operation;
        },
      }),
      consumeResponse: async () => bytes,
    });

    expect(result.body).toBe(bytes);
    expect(result.body).toBeInstanceOf(Uint8Array);
    expect([...result.body!]).toEqual([0, 1, 2, 127, 255]);
  });

  it("preserves deep clean JSON while redacting reflected signatures beyond 16 levels", async () => {
    const localPaths = await paths();
    const cleanLeaf = { value: "kept" };
    let clean: Record<string, unknown> = cleanLeaf;
    for (let index = 0; index < 20; index += 1) clean = { nested: clean };
    let returnedBody: Record<string, unknown> | undefined;
    let signature = "";

    const result = await completeX402Payment({
      challenge: {
        response: paymentRequired(),
        request: new Request("https://vendor.example/paid"),
        finish() {},
        async waitFor<T>(operation: Promise<T>): Promise<T> {
          return await operation;
        },
      },
      account: privateKeyToAccount(PRIVATE_KEY),
      caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
      config: getDefaultConfig(),
      ledgerPath: localPaths.ledgerPath,
      wallet: "main",
      now: NOW,
      send: async (request) => {
        const payment = JSON.parse(
          Buffer.from(request.headers.get("payment-signature")!, "base64").toString("utf8"),
        ) as { payload: { signature: string } };
        signature = payment.payload.signature;
        let reflected: Record<string, unknown> = {
          [`key-${payment.payload.signature}`]: `value-${payment.payload.signature}`,
        };
        for (let index = 0; index < 20; index += 1) reflected = { nested: reflected };
        const proto = JSON.parse(
          `{"__proto__":{"polluted":"${payment.payload.signature}"}}`,
        ) as Record<string, unknown>;
        returnedBody = { clean, reflected, proto };
        return {
          response: paidResponse(),
          request,
          finish() {},
          async waitFor<T>(operation: Promise<T>): Promise<T> {
            return await operation;
          },
        };
      },
      consumeResponse: async () => returnedBody!,
    });

    expect((result.body as { clean: unknown }).clean).toBe(clean);
    let cleanCursor = (result.body as { clean: Record<string, unknown> }).clean;
    for (let index = 0; index < 20; index += 1) {
      cleanCursor = cleanCursor.nested as Record<string, unknown>;
    }
    expect(cleanCursor).toBe(cleanLeaf);
    const serialized = JSON.stringify(result.body);
    expect(serialized).toContain('"value":"kept"');
    expect(serialized).not.toContain(signature);
    expect(serialized).toContain("key-[redacted]");
    expect(serialized).toContain("value-[redacted]");
    const proto = (result.body as { proto: Record<string, unknown> }).proto;
    expect(Object.hasOwn(proto, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(proto)).toBe(Object.prototype);
    expect(Reflect.get(proto, "polluted")).toBeUndefined();
    expect(Reflect.get(proto, "__proto__")).toEqual({ polluted: "[redacted]" });
  });

  it("declines an over-cap quote before signing or mutating the spend ledger", async () => {
    const localPaths = await paths();
    const config = getDefaultConfig();
    const account = privateKeyToAccount(PRIVATE_KEY);
    const signSpy = vi.spyOn(account, "signTypedData");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(paymentRequired());

    await expect(
      payRequest({
        url: "https://vendor.example/paid",
        init: { method: "POST", body: JSON.stringify({ prompt: "hello" }) },
        account,
        wallet: "main",
        caps: { perCallAtomic: "2499", perDayAtomic: "10000" },
        config,
        fetchImpl,
        paths: localPaths,
        now: NOW,
        lookup: async () => ["93.184.216.34"],
      }),
    ).rejects.toMatchObject({
      code: "spend_cap_exceeded",
      cap: "per_call",
      amountUsd: "0.0025",
      limitUsd: "0.002499",
      wallet: "main",
      command: "vapi accounts caps main --per-call 0.0025",
      cause: { code: "per_call_cap_exceeded" },
    } satisfies Partial<SpendCapExceededError>);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(signSpy).not.toHaveBeenCalled();
    await expect(readSpendLedger(localPaths.ledgerPath, NOW)).resolves.toEqual({
      date: "2026-09-23",
      spentAtomic: "0",
    });
    await expect(readReceipts(localPaths.receiptsPath)).resolves.toMatchObject([
      {
        outcome: "declined_policy",
        quote: { network: BASE_MAINNET_CAIP2, amountAtomic: "2500", payTo: PAY_TO },
        error: {
          code: "spend_cap_exceeded",
          message: expect.stringContaining("per-call spend cap"),
        },
      },
    ]);
  });

  it("reports locked per-day spend without adding another reservation", async () => {
    const localPaths = await paths();
    const account = privateKeyToAccount(PRIVATE_KEY);
    const signSpy = vi.spyOn(account, "signTypedData");
    const caps = { perCallAtomic: "10000", perDayAtomic: "10000" };
    await reserveSpend(8_000n, caps, {
      ledgerPath: localPaths.ledgerPath,
      now: NOW,
      wallet: "main",
    });

    await expect(
      payRequest({
        url: "https://vendor.example/paid",
        init: { method: "GET" },
        account,
        wallet: "main",
        caps,
        config: getDefaultConfig(),
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(paymentRequired()),
        paths: localPaths,
        now: NOW,
        lookup: async () => ["93.184.216.34"],
      }),
    ).rejects.toMatchObject({
      code: "spend_cap_exceeded",
      cap: "per_day",
      amountUsd: "0.0025",
      limitUsd: "0.01",
      spentUsd: "0.008",
      command: "vapi accounts caps main --per-day 0.0105",
      cause: { code: "per_day_cap_exceeded" },
    } satisfies Partial<SpendCapExceededError>);

    expect(signSpy).not.toHaveBeenCalled();
    await expect(readSpendLedger(localPaths.ledgerPath, NOW, "main")).resolves.toMatchObject({
      spentAtomic: "8000",
    });
  });

  it("returns the paid response and writes one paid receipt with settlement details", async () => {
    const localPaths = await paths();
    const transaction = `0x${"44".repeat(32)}`;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(paymentRequired())
      .mockResolvedValueOnce(paidResponse(transaction));

    const result = await payRequest({
      url: "https://vendor.example/paid",
      init: {
        method: "POST",
        headers: { "x-version": "4" },
        body: JSON.stringify({ prompt: "hello" }),
      },
      account: privateKeyToAccount(PRIVATE_KEY),
      wallet: "main",
      caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
      config: getDefaultConfig(),
      fetchImpl,
      paths: localPaths,
      now: NOW,
      lookup: async () => ["93.184.216.34"],
    });

    expect(result.response.status).toBe(200);
    await expect(result.response.json()).resolves.toEqual({ paid: true });
    expect(result.receipt).toMatchObject({
      outcome: "paid",
      quote: {
        network: BASE_MAINNET_CAIP2,
        amountAtomic: "2500",
        payTo: PAY_TO,
      },
      settlement: { outcome: "succeeded", transaction },
      status: 200,
    });
    await expect(readReceipts(localPaths.receiptsPath)).resolves.toHaveLength(1);
  });

  it("keeps a settled paid result when the deferred ceiling sweep fails and audits it", async () => {
    const localPaths = await paths();
    const transaction = `0x${"66".repeat(32)}`;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(paymentRequired())
      .mockResolvedValueOnce(paidResponse(transaction));
    const run = vi.fn(async () => {
      throw new Error("sweep failed with a secret that must not be recorded");
    });

    const result = await payRequest({
      url: "https://vendor.example/paid",
      init: { method: "GET" },
      account: privateKeyToAccount(PRIVATE_KEY),
      wallet: "main",
      caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
      config: getDefaultConfig(),
      fetchImpl,
      paths: localPaths,
      now: NOW,
      lookup: async () => ["93.184.216.34"],
      ceilingSweep: {
        account: "main",
        auditHome: localPaths.directory,
        run,
        now: () => NOW.getTime(),
      },
    });

    expect(result.response.status).toBe(200);
    expect(result.receipt).toMatchObject({
      outcome: "paid",
      settlement: { outcome: "succeeded", transaction },
    });
    await drainCeilingSweeps();
    expect(run).toHaveBeenCalledTimes(1);
    const audit = await readAuditLog(localPaths.directory);
    expect(audit).toContainEqual(
      expect.objectContaining({
        event: "ceiling.sweep_failed",
        wallet: "main",
        detail: "reason=unexpected_error",
      }),
    );
    expect(JSON.stringify(audit)).not.toContain("secret that must not be recorded");
  });

  it("keeps the caller authorization header on the paid retry without recording secrets", async () => {
    const localPaths = await paths();
    const bearer = "Bearer agent-token-must-stay-secret";
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(paymentRequired())
      .mockResolvedValueOnce(paidResponse());

    await payRequest({
      url: "https://vendor.example/paid",
      init: {
        method: "POST",
        headers: { authorization: bearer, "x-caller-header": "kept" },
        body: JSON.stringify({ prompt: "hello" }),
      },
      account: privateKeyToAccount(PRIVATE_KEY),
      wallet: "main",
      caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
      config: getDefaultConfig(),
      fetchImpl,
      paths: localPaths,
      now: NOW,
      lookup: async () => ["93.184.216.34"],
    });

    const paidRequest = fetchImpl.mock.calls[1]![0] as Request;
    expect(paidRequest.headers.get("authorization")).toBe(bearer);
    expect(paidRequest.headers.get("x-caller-header")).toBe("kept");
    expect(paidRequest.headers.get("payment-signature")).toBeTruthy();
    expect(paidRequest.headers.get("x-payment")).toBeTruthy();

    const receiptJson = await readFile(localPaths.receiptsPath, "utf8");
    expect(receiptJson).not.toContain(bearer);
    expect(receiptJson).not.toContain(paidRequest.headers.get("payment-signature"));
    expect(receiptJson).not.toContain(paidRequest.headers.get("x-payment"));
  });

  it("refuses a quote above maxAtomic before reserving or signing", async () => {
    const localPaths = await paths();
    const account = privateKeyToAccount(PRIVATE_KEY);
    const signSpy = vi.spyOn(account, "signTypedData");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(paymentRequired());

    await expect(
      payRequest({
        url: "https://vendor.example/paid",
        init: { method: "GET" },
        account,
        wallet: "main",
        caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
        config: getDefaultConfig(),
        fetchImpl,
        paths: localPaths,
        maxAtomic: 2499n,
        now: NOW,
        lookup: async () => ["93.184.216.34"],
      }),
    ).rejects.toMatchObject({
      code: "spend_cap_exceeded",
      cap: "max_amount",
      amountUsd: "0.0025",
      limitUsd: "0.002499",
      command: null,
      cause: { code: "max_price_exceeded" },
    } satisfies Partial<SpendCapExceededError>);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(signSpy).not.toHaveBeenCalled();
    await expect(readSpendLedger(localPaths.ledgerPath, NOW)).resolves.toMatchObject({
      spentAtomic: "0",
    });
    await expect(readReceipts(localPaths.receiptsPath)).resolves.toMatchObject([
      { outcome: "declined_policy", error: { code: "spend_cap_exceeded" } },
    ]);
  });

  it("reports maxPriceUsd separately from the maximum atomic amount", async () => {
    const localPaths = await paths();
    const account = privateKeyToAccount(PRIVATE_KEY);
    const signSpy = vi.spyOn(account, "signTypedData");

    await expect(
      completeX402Payment({
        challenge: {
          response: paymentRequired(),
          request: new Request("https://vendor.example/paid"),
          finish() {},
          async waitFor<T>(operation: Promise<T>): Promise<T> {
            return await operation;
          },
        },
        account,
        caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
        config: getDefaultConfig(),
        ledgerPath: localPaths.ledgerPath,
        wallet: "main",
        maxPriceUsd: "0.002499",
        now: NOW,
        send: vi.fn(),
      }),
    ).rejects.toMatchObject({
      code: "spend_cap_exceeded",
      cap: "max_price",
      amountUsd: "0.0025",
      limitUsd: "0.002499",
      command: "--max 0.0025",
      cause: { code: "max_price_exceeded" },
    } satisfies Partial<SpendCapExceededError>);

    expect(signSpy).not.toHaveBeenCalled();
    await expect(readSpendLedger(localPaths.ledgerPath, NOW)).resolves.toMatchObject({
      spentAtomic: "0",
    });
  });

  it.each([
    {
      cap: "per_call" as const,
      caps: { perCallAtomic: "1000", perDayAtomic: "2000" },
      seedAtomic: 1_000n,
      expected: {
        limitUsd: "0.001",
        command: "vapi accounts caps main --per-call 0.0025 --per-day 0.0025",
        cause: { code: "per_call_cap_exceeded" },
      },
    },
    {
      cap: "per_call" as const,
      caps: { perCallAtomic: "2499", perDayAtomic: "10000" },
      seedAtomic: 1_000n,
      expected: {
        limitUsd: "0.002499",
        command: "vapi accounts caps main --per-call 0.0025",
        cause: { code: "per_call_cap_exceeded" },
      },
    },
    {
      cap: "per_day" as const,
      caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
      seedAtomic: 8_000n,
      expected: {
        limitUsd: "0.01",
        spentUsd: "0.008",
        command: "vapi accounts caps main --per-day 0.0105",
        cause: { code: "per_day_cap_exceeded" },
      },
    },
    {
      cap: "max_amount" as const,
      caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
      seedAtomic: 1_000n,
      maxAtomic: 2_499n,
      expected: {
        limitUsd: "0.002499",
        command: null,
        cause: { code: "max_price_exceeded" },
      },
    },
    {
      cap: "max_price" as const,
      caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
      seedAtomic: 1_000n,
      maxPriceUsd: "0.002499",
      expected: {
        limitUsd: "0.002499",
        command: "--max 0.0025",
        cause: { code: "max_price_exceeded" },
      },
    },
    {
      cap: "run_budget" as const,
      caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
      seedAtomic: 1_000n,
      expected: {
        limitUsd: "0.003499",
        spentUsd: "0.001",
        command: "--budget 0.0035",
        cause: { code: "run_budget_exceeded" },
      },
    },
  ])("blocks $cap before building a payment and preserves reservations", async (testCase) => {
    const localPaths = await paths();
    const account = privateKeyToAccount(PRIVATE_KEY);
    const signSpy = vi.spyOn(account, "signTypedData");
    const buildSpy = vi.spyOn(x402, "buildCompatibleX402Payment");
    const runBudget = createRunBudget({
      id: "run_test",
      limitAtomic: testCase.cap === "run_budget" ? 3_499n : 100_000n,
    });
    runBudget.reserve(1_000n, "existing-run-reservation");
    await reserveSpend(testCase.seedAtomic, testCase.caps, {
      ledgerPath: localPaths.ledgerPath,
      now: NOW,
      wallet: "main",
    });

    await expect(
      completeX402Payment({
        challenge: {
          response: paymentRequired(),
          request: new Request("https://vendor.example/paid"),
          finish() {},
          async waitFor<T>(operation: Promise<T>): Promise<T> {
            return await operation;
          },
        },
        account,
        caps: testCase.caps,
        config: getDefaultConfig(),
        ledgerPath: localPaths.ledgerPath,
        wallet: "main",
        paymentId: "blocked-payment",
        runBudget,
        ...(testCase.maxAtomic === undefined ? {} : { maxAtomic: testCase.maxAtomic }),
        ...(testCase.maxPriceUsd === undefined ? {} : { maxPriceUsd: testCase.maxPriceUsd }),
        now: NOW,
        send: vi.fn(),
      }),
    ).rejects.toMatchObject({
      code: "spend_cap_exceeded",
      cap: testCase.cap,
      amountUsd: "0.0025",
      wallet: "main",
      ...testCase.expected,
    } satisfies Partial<SpendCapExceededError>);

    expect(buildSpy).not.toHaveBeenCalled();
    expect(signSpy).not.toHaveBeenCalled();
    expect(runBudget.spentAtomic()).toBe(1_000n);
    expect(runBudget.reservedAtomic("existing-run-reservation")).toBe(1_000n);
    expect(runBudget.reservedAtomic("blocked-payment")).toBe(0n);
    await expect(readSpendLedger(localPaths.ledgerPath, NOW, "main")).resolves.toMatchObject({
      spentAtomic: testCase.seedAtomic.toString(),
    });
    expect(await readFile(localPaths.ledgerPath, "utf8")).not.toContain("blocked-payment");
  });

  it("honors preferNetworks when two configured exact quotes are offered", async () => {
    const localPaths = await paths();
    const config = getDefaultConfig();
    config.networks[ARC_TESTNET_CAIP2] = {
      rpcUrl: "https://arc-rpc.example",
      usdc: NETWORKS[ARC_TESTNET_CAIP2].usdc,
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        paymentRequired([exactOffer(BASE_MAINNET_CAIP2), exactOffer(ARC_TESTNET_CAIP2, "2000")]),
      )
      .mockResolvedValueOnce(paidResponse());

    const { receipt } = await payRequest({
      url: "https://vendor.example/paid",
      init: { method: "GET" },
      account: privateKeyToAccount(PRIVATE_KEY),
      wallet: "main",
      caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
      config,
      fetchImpl,
      paths: localPaths,
      preferNetworks: [ARC_TESTNET_CAIP2, BASE_MAINNET_CAIP2],
      now: NOW,
      lookup: async () => ["93.184.216.34"],
    });

    expect(receipt.quote).toMatchObject({ network: ARC_TESTNET_CAIP2, amountAtomic: "2000" });
    const paidRequest = fetchImpl.mock.calls[1]![0] as Request;
    const payload = JSON.parse(
      Buffer.from(paidRequest.headers.get("payment-signature")!, "base64").toString("utf8"),
    ) as { accepted: { network: string } };
    expect(payload.accepted.network).toBe(ARC_TESTNET_CAIP2);
  });

  it("does not expose reflected caller or payment credentials in errors or receipts", async () => {
    const localPaths = await paths();
    const bearer = "Bearer reflected-agent-token";
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ...challenge(),
          x402Version: bearer,
        }),
        { status: 402, headers: { "content-type": "application/json" } },
      ),
    );

    const error = await payRequest({
      url: "https://vendor.example/paid",
      init: { headers: { authorization: bearer } },
      account: privateKeyToAccount(PRIVATE_KEY),
      wallet: "main",
      caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
      config: getDefaultConfig(),
      fetchImpl,
      paths: localPaths,
      now: NOW,
      lookup: async () => ["93.184.216.34"],
    }).then(
      () => new Error("Expected a reflected invalid challenge to fail."),
      (failure: unknown) => failure as Error,
    );

    expect(error.message).not.toContain(bearer);
    expect(error.message).not.toContain("reflected-agent-token");
    expect(inspect(error, { depth: 10 })).not.toContain("reflected-agent-token");
    expect(await readFile(localPaths.receiptsPath, "utf8")).not.toContain("reflected-agent-token");

    const settlementPaths = await paths();
    let paymentSignature = "";
    const settlementFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(paymentRequired())
      .mockImplementationOnce(async (input) => {
        paymentSignature = (input as Request).headers.get("payment-signature") ?? "";
        return paidResponse(paymentSignature);
      });
    const result = await payRequest({
      url: "https://vendor.example/paid",
      init: { headers: { authorization: bearer } },
      account: privateKeyToAccount(PRIVATE_KEY),
      wallet: "main",
      caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
      config: getDefaultConfig(),
      fetchImpl: settlementFetch,
      paths: settlementPaths,
      now: NOW,
      lookup: async () => ["93.184.216.34"],
    });

    expect(paymentSignature).not.toBe("");
    expect(result.receipt.settlement?.transaction).toBe("[redacted]");
    expect(await readFile(settlementPaths.receiptsPath, "utf8")).not.toContain(paymentSignature);
  });

  it("honors cancellation before reserving or signing the paid retry", async () => {
    const localPaths = await paths();
    const controller = new AbortController();
    const account = privateKeyToAccount(PRIVATE_KEY);
    const signSpy = vi.spyOn(account, "signTypedData");
    const fetchImpl = vi.fn<typeof fetch>().mockImplementationOnce(async () => {
      controller.abort();
      return paymentRequired();
    });

    await expect(
      payRequest({
        url: "https://vendor.example/paid",
        init: { signal: controller.signal },
        account,
        wallet: "main",
        caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
        config: getDefaultConfig(),
        fetchImpl,
        paths: localPaths,
        now: NOW,
        lookup: async () => ["93.184.216.34"],
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(signSpy).not.toHaveBeenCalled();
    await expect(readSpendLedger(localPaths.ledgerPath, NOW)).resolves.toMatchObject({
      spentAtomic: "0",
    });
  });

  it("refuses an over-budget quote before signing or sending the paid request", async () => {
    const localPaths = await paths();
    const account = privateKeyToAccount(PRIVATE_KEY);
    const signSpy = vi.spyOn(account, "signTypedData");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(paymentRequired());
    const runBudget = createRunBudget({ id: "run_test", limitAtomic: 3_499n });
    runBudget.reserve(1_000n, "existing");

    await expect(
      payRequest({
        url: "https://vendor.example/paid",
        init: { method: "GET" },
        account,
        wallet: "main",
        caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
        config: getDefaultConfig(),
        fetchImpl,
        paths: localPaths,
        now: NOW,
        lookup: async () => ["93.184.216.34"],
        runBudget,
      }),
    ).rejects.toMatchObject({
      code: "spend_cap_exceeded",
      cap: "run_budget",
      amountUsd: "0.0025",
      limitUsd: "0.003499",
      spentUsd: "0.001",
      command: "--budget 0.0035",
      cause: { code: "run_budget_exceeded" },
    } satisfies Partial<SpendCapExceededError>);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(signSpy).not.toHaveBeenCalled();
    expect(runBudget.spentAtomic()).toBe(1_000n);
    await expect(readSpendLedger(localPaths.ledgerPath, NOW)).resolves.toMatchObject({
      spentAtomic: "0",
    });
  });

  it("releases wallet spend even when reading a failed run budget throws", async () => {
    const localPaths = await paths();
    const account = privateKeyToAccount(PRIVATE_KEY);
    const signSpy = vi.spyOn(account, "signTypedData");
    const budget = createRunBudget({ id: "run_test", limitAtomic: 2_499n });
    const reportingFailure = new Error("Run budget usage could not be read.");

    await expect(
      payRequest({
        url: "https://vendor.example/paid",
        init: { method: "GET" },
        account,
        wallet: "main",
        caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
        config: getDefaultConfig(),
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(paymentRequired()),
        paths: localPaths,
        now: NOW,
        lookup: async () => ["93.184.216.34"],
        runBudget: {
          ...budget,
          spentAtomic() {
            throw reportingFailure;
          },
        },
      }),
    ).rejects.toBe(reportingFailure);

    expect(signSpy).not.toHaveBeenCalled();
    expect(budget.spentAtomic()).toBe(0n);
    await expect(readSpendLedger(localPaths.ledgerPath, NOW, "main")).resolves.toMatchObject({
      spentAtomic: "0",
    });
  });

  it("rebuilds a typed cap error while redacting its foreign run-budget cause", async () => {
    const localPaths = await paths();
    const secret = "agent-token-must-stay-secret";
    const account = privateKeyToAccount(PRIVATE_KEY);
    const signSpy = vi.spyOn(account, "signTypedData");
    const foreignFailure = Object.assign(new Error(`budget rejected ${secret}`), {
      code: "run_budget_exceeded",
    });
    const runBudget = {
      id: "foreign",
      limitAtomic: 2_499n,
      spentAtomic: () => 0n,
      reservedAtomic: () => 0n,
      reserve: vi.fn(() => {
        throw foreignFailure;
      }),
      release: vi.fn(),
    };

    let failure: unknown;
    try {
      await payRequest({
        url: "https://vendor.example/paid",
        init: { method: "GET", headers: { authorization: `Bearer ${secret}` } },
        account,
        wallet: "main",
        caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
        config: getDefaultConfig(),
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(paymentRequired()),
        paths: localPaths,
        now: NOW,
        lookup: async () => ["93.184.216.34"],
        runBudget,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SpendCapExceededError);
    expect(failure).toMatchObject({
      cap: "run_budget",
      amountUsd: "0.0025",
      limitUsd: "0.002499",
      spentUsd: "0",
      command: "--budget 0.0025",
      cause: { message: "budget rejected [redacted]" },
    });
    expect(failure).not.toHaveProperty("cause", foreignFailure);
    expect(signSpy).not.toHaveBeenCalled();
    expect(runBudget.reserve).toHaveBeenCalledTimes(1);
    expect(runBudget.release).not.toHaveBeenCalled();
    await expect(readSpendLedger(localPaths.ledgerPath, NOW)).resolves.toMatchObject({
      spentAtomic: "0",
    });
    await expect(readReceipts(localPaths.receiptsPath)).resolves.toMatchObject([
      {
        outcome: "declined_policy",
        error: { code: "spend_cap_exceeded", message: expect.stringContaining("run budget") },
      },
    ]);
  });

  it("releases the run budget when the spend cap refuses the quote", async () => {
    const localPaths = await paths();
    const account = privateKeyToAccount(PRIVATE_KEY);
    const signSpy = vi.spyOn(account, "signTypedData");
    const runBudget = createRunBudget({ id: "run_test", limitAtomic: 10_000n });

    await expect(
      payRequest({
        url: "https://vendor.example/paid",
        init: { method: "GET" },
        account,
        wallet: "main",
        caps: { perCallAtomic: "2499", perDayAtomic: "10000" },
        config: getDefaultConfig(),
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(paymentRequired()),
        paths: localPaths,
        now: NOW,
        lookup: async () => ["93.184.216.34"],
        runBudget,
      }),
    ).rejects.toMatchObject({ code: "spend_cap_exceeded", cap: "per_call" });

    expect(signSpy).not.toHaveBeenCalled();
    expect(runBudget.spentAtomic()).toBe(0n);
  });

  it("releases spend and run reservations when Solana cannot be signed", async () => {
    const localPaths = await paths();
    const account = privateKeyToAccount(PRIVATE_KEY);
    const signSpy = vi.spyOn(account, "signTypedData");
    const runBudget = createRunBudget({ id: "run_test", limitAtomic: 10_000n });
    const config = getDefaultConfig();
    config.networks[SOLANA_MAINNET_CAIP2] = {
      rpcUrl: "https://api.mainnet-beta.solana.com",
      usdc: SOLANA_MAINNET_USDC,
    };
    const solanaOffer = {
      scheme: "exact",
      network: X402_SOLANA_MAINNET_CAIP2,
      amount: "2500",
      asset: SOLANA_MAINNET_USDC,
      payTo: "11111111111111111111111111111111",
      maxTimeoutSeconds: 60,
      extra: { feePayer: "SysvarRent111111111111111111111111111111111" },
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(paymentRequired([solanaOffer]));

    await expect(
      payRequest({
        url: "https://vendor.example/paid",
        init: { method: "GET" },
        account,
        wallet: "main",
        caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
        config,
        fetchImpl,
        paths: localPaths,
        now: NOW,
        lookup: async () => ["93.184.216.34"],
        runBudget,
      }),
    ).rejects.toMatchObject({
      code: "unsupported_challenge",
      message: expect.stringContaining("Solana is not enabled"),
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(signSpy).not.toHaveBeenCalled();
    expect(runBudget.spentAtomic()).toBe(0n);
    await expect(readSpendLedger(localPaths.ledgerPath, NOW)).resolves.toMatchObject({
      spentAtomic: "0",
    });
  });

  it("does not expose an SVM signed transaction in an uncertain settlement error", async () => {
    const localPaths = await paths();
    const solana = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(7));
    const account = Object.assign(privateKeyToAccount(PRIVATE_KEY), { solana });
    const config = getDefaultConfig();
    config.networks[SOLANA_MAINNET_CAIP2] = {
      rpcUrl: "https://rpc.example",
      usdc: SOLANA_MAINNET_USDC,
    };
    const solanaOffer = {
      scheme: "exact",
      network: X402_SOLANA_MAINNET_CAIP2,
      amount: "2500",
      asset: SOLANA_MAINNET_USDC,
      payTo: "11111111111111111111111111111111",
      maxTimeoutSeconds: 60,
      extra: {
        feePayer: "SysvarRent111111111111111111111111111111111",
        recentBlockhash: "11111111111111111111111111111111",
        lastValidBlockHeight: "365123999",
      },
    };
    let signedTransaction = "";
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (
        request.url === "https://vendor.example/paid" &&
        !request.headers.has("payment-signature")
      ) {
        return paymentRequired([solanaOffer]);
      }
      if (request.url === "https://rpc.example/") {
        const rpc = (await request.clone().json()) as { id: string | number };
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            context: { apiVersion: "3.0.6", slot: 365_123_456 },
            value: {
              data: [solanaMintAccountBase64(), "base64"],
              executable: false,
              lamports: 1_461_600,
              owner: TOKEN_PROGRAM_ADDRESS,
              rentEpoch: 0,
              space: 82,
            },
          },
        });
      }
      const envelope = JSON.parse(
        Buffer.from(request.headers.get("payment-signature")!, "base64").toString("utf8"),
      ) as { payload: { transaction: string } };
      signedTransaction = envelope.payload.transaction;
      throw new Error(`provider lost response after ${signedTransaction}`);
    });

    let thrown: unknown;
    try {
      await payRequest({
        url: "https://vendor.example/paid",
        init: { method: "GET" },
        account,
        wallet: "main",
        caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
        config,
        fetchImpl,
        paths: localPaths,
        now: NOW,
        lookup: async () => ["93.184.216.34"],
      });
    } catch (error) {
      thrown = error;
    }

    expect(signedTransaction).not.toBe("");
    const serialized = JSON.stringify(thrown, (_key, value: unknown) =>
      value instanceof Error
        ? Object.fromEntries(
            Object.getOwnPropertyNames(value).map((name) => [name, Reflect.get(value, name)]),
          )
        : value,
    );
    expect(serialized).toContain("settlement_unknown");
    expect(serialized).not.toContain(signedTransaction);
    expect(serialized).not.toContain("authorizationTransaction");
  });

  it("keeps the run budget reserved when settlement is unknown", async () => {
    const localPaths = await paths();
    const runBudget = createRunBudget({ id: "run_test", limitAtomic: 10_000n });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(paymentRequired())
      .mockResolvedValueOnce(new Response("upstream failure", { status: 503 }));

    await expect(
      payRequest({
        url: "https://vendor.example/paid",
        init: { method: "GET" },
        account: privateKeyToAccount(PRIVATE_KEY),
        wallet: "main",
        caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
        config: getDefaultConfig(),
        fetchImpl,
        paths: localPaths,
        now: NOW,
        lookup: async () => ["93.184.216.34"],
        runBudget,
      }),
    ).rejects.toMatchObject({ code: "settlement_unknown" });

    expect(runBudget.spentAtomic()).toBe(2_500n);
  });

  it("keeps the quote amount reserved after a successful payment", async () => {
    const localPaths = await paths();
    const runBudget = createRunBudget({ id: "run_test", limitAtomic: 10_000n });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(paymentRequired())
      .mockResolvedValueOnce(paidResponse());

    await payRequest({
      url: "https://vendor.example/paid",
      init: { method: "GET" },
      account: privateKeyToAccount(PRIVATE_KEY),
      wallet: "main",
      caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
      config: getDefaultConfig(),
      fetchImpl,
      paths: localPaths,
      now: NOW,
      lookup: async () => ["93.184.216.34"],
      runBudget,
    });

    expect(runBudget.spentAtomic()).toBe(2_500n);
  });

  it("writes the run descriptor on success and error receipts", async () => {
    const run = {
      id: "run_000102030405060708090a0b",
      swarm: "research",
      member: "research-lead-1",
    };
    const successPaths = await paths();
    const successFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(paymentRequired())
      .mockResolvedValueOnce(paidResponse());

    const success = await payRequest({
      url: "https://vendor.example/paid",
      init: { method: "GET" },
      account: privateKeyToAccount(PRIVATE_KEY),
      wallet: "main",
      caps: { perCallAtomic: "10000", perDayAtomic: "10000" },
      config: getDefaultConfig(),
      fetchImpl: successFetch,
      paths: successPaths,
      now: NOW,
      lookup: async () => ["93.184.216.34"],
      run,
    });
    expect(success.receipt.run).toEqual(run);

    const errorPaths = await paths();
    await expect(
      payRequest({
        url: "https://vendor.example/paid",
        init: { method: "GET" },
        account: privateKeyToAccount(PRIVATE_KEY),
        wallet: "main",
        caps: { perCallAtomic: "2499", perDayAtomic: "10000" },
        config: getDefaultConfig(),
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(paymentRequired()),
        paths: errorPaths,
        now: NOW,
        lookup: async () => ["93.184.216.34"],
        run,
      }),
    ).rejects.toBeInstanceOf(SpendCapExceededError);
    await expect(readReceipts(errorPaths.receiptsPath)).resolves.toMatchObject([{ run }]);
  });
});

function solanaMintAccountBase64(): string {
  const data = Buffer.alloc(82);
  data[44] = 6;
  data[45] = 1;
  return data.toString("base64");
}
