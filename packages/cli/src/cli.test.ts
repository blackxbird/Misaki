import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

import {
  ARC_MAINNET_CAIP2,
  appendReceipt,
  BASE_MAINNET_CAIP2,
  appendSearchEvent,
  getVapiPaths,
  protectVault,
  SpendCapExceededError,
  SweepGasError,
  type AgentProfile,
  type SecretStore,
  WalletStore,
  writeAgentProfile,
} from "@vapi-network/core";

import {
  runCli as runCliImpl,
  verificationNotice,
  type CliDependencies,
  type CliIo,
  type CliPrompts,
} from "./cli.js";

/** BIP-39's own test phrase, and the Base account every wallet derives from it. */
const VECTOR_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const VECTOR_ADDRESS = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const IMPORTED_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as Hex;
const BACKUP_WARNING =
  "Anyone with these words can spend the wallet. Never type them into a website or chat.";

/** The one encrypted device vault shared by every account in a home. */
function vaultPath(home: string): string {
  return join(home, "vault.json");
}

/**
 * A person at a bare terminal: the only situation in which vAPI prints a
 * secret. The empty environment stands in for "no agent or CI marker set",
 * which a test process cannot assume of its own.
 */
const HUMAN: CliDependencies = { interactive: true, env: {} };

/** An OS secret store in a plain object, so no test ever touches a keychain. */
function secretStoreStub(entries: Record<string, string> = {}): SecretStore {
  return {
    available: true,
    platform: "darwin",
    description: "the macOS Keychain",
    get: async (name) => entries[name],
    has: async (name) => entries[name] !== undefined,
    set: async (name, passphrase) => {
      entries[name] = passphrase;
    },
    remove: async (name) => {
      if (entries[name] === undefined) return false;
      delete entries[name];
      return true;
    },
  };
}

const secretStores = new Map<string, SecretStore>();

function sharedSecretStore(home: string): SecretStore {
  let secretStore = secretStores.get(home);
  if (secretStore === undefined) {
    secretStore = secretStoreStub();
    secretStores.set(home, secretStore);
  }
  return secretStore;
}

/** Every CLI run uses the same deterministic device secret store for its VAPI_HOME. */
function runCli(
  argv: string[] = [],
  io?: CliIo,
  dependencies: CliDependencies = {},
): Promise<number> {
  const home = process.env.VAPI_HOME ?? "<default>";
  return runCliImpl(argv, io, { ...dependencies, secretStore: sharedSecretStore(home) });
}

async function accountAddress(home: string, name = "main"): Promise<string> {
  const store = await WalletStore.open(home, { secrets: sharedSecretStore(home) });
  const address = await store.readAddress(name);
  if (address === undefined) throw new Error(`Missing address for ${name}.`);
  return address;
}

const originalHome = process.env.VAPI_HOME;
const originalPassword = process.env.VAPI_KEYSTORE_PASSWORD;
const originalSolanaRpc = process.env.SOLANA_RPC_URL;
const originalArcRpc = process.env.ARC_RPC_URL;

beforeEach(() => {
  delete process.env.VAPI_KEYSTORE_PASSWORD;
});

afterEach(() => {
  restoreEnvironment("VAPI_HOME", originalHome);
  restoreEnvironment("VAPI_KEYSTORE_PASSWORD", originalPassword);
  restoreEnvironment("SOLANA_RPC_URL", originalSolanaRpc);
  restoreEnvironment("ARC_RPC_URL", originalArcRpc);
});

describe("CLI JSON output", () => {
  it("initializes a wallet without printing a QR code", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-init-"));
    process.env.VAPI_HOME = home;
    const captured = captureIo();

    expect(await runCli(["init", "--json"], captured.io, { fetchImpl: zeroBalanceRpc() })).toBe(0);
    expect(captured.stderr).toEqual([]);
    expect(captured.stdout).toHaveLength(1);
    const value = JSON.parse(captured.stdout[0]!) as Record<string, unknown>;
    expect(value).toMatchObject({
      accounts: [
        {
          caip2: "eip155:8453",
          usdcBalance: { atomic: "0", formatted: "0" },
          gasTokenBalance: { symbol: "ETH", atomic: "0", formatted: "0" },
        },
      ],
      wallet: "main",
      config: join(home, "config.json"),
      vault: vaultPath(home),
      message: "vAPI wallet created. Its encrypted key stays on this machine.",
    });
    expect(value.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(captured.stdout[0]).not.toContain("\u2588");
    expect(JSON.parse(await readFile(vaultPath(home), "utf8"))).not.toHaveProperty("privateKey");
  });

  it("returns the next steps in --json and prints them under the mark", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-next-steps-"));
    process.env.VAPI_HOME = home;
    const jsonRun = captureIo();
    expect(await runCli(["init", "--json"], jsonRun.io, { fetchImpl: zeroBalanceRpc() })).toBe(0);
    const value = JSON.parse(jsonRun.stdout[0]!) as { address: string; nextSteps: string[] };

    expect(value.nextSteps).toHaveLength(6);
    expect(value.nextSteps[0]).toContain(value.address);
    expect(value.nextSteps[0]).toContain("(copy this to fund it)");
    expect(value.nextSteps[1]).toBe(
      "Back up   vapi backup                                (write the 12 words down; vAPI cannot recover them)",
    );

    const humanHome = await mkdtemp(join(tmpdir(), "vapi-cli-next-steps-human-"));
    process.env.VAPI_HOME = humanHome;
    const humanRun = captureIo();
    expect(await runCli(["init"], humanRun.io, { fetchImpl: zeroBalanceRpc() })).toBe(0);
    const text = humanRun.stdout.join("\n");

    expect(text).toContain("vAPI Network");
    expect(text).toContain("\u2588");
    expect(text).toMatch(/Fund {6}vapi fund\s+\(card via Coinbase, a wallet transfer/);
    expect(text).toContain('vapi search "weather"');
    expect(text).toContain(
      'Agent     add {"command":"npx","args":["-y","vapi-network@latest","mcp"]}',
    );
    expect(text).not.toContain("\u001b[");
  });

  it("reports an empty configured balance without making a network request", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-balance-"));
    process.env.VAPI_HOME = home;
    expect(await runCli(["init", "--json"], captureIo().io, { fetchImpl: zeroBalanceRpc() })).toBe(
      0,
    );

    const paths = getVapiPaths(home);
    const config = JSON.parse(await readFile(paths.config, "utf8")) as Record<string, unknown>;
    config.networks = {};
    await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const captured = captureIo();

    expect(await runCli(["balance", "--json"], captured.io)).toBe(0);
    expect(captured.stderr).toEqual([]);
    expect(JSON.parse(captured.stdout[0]!)).toEqual({
      wallet: "main",
      address: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/),
      balances: [],
    });
  });

  it("rejects Solana during init until the device vault supports it", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-solana-init-"));
    process.env.VAPI_HOME = home;
    delete process.env.SOLANA_RPC_URL;
    const captured = captureIo();

    expect(
      await runCli(["init", "--networks", "base,solana"], captured.io, {
        fetchImpl: zeroBalanceRpc(),
      }),
    ).toBe(2);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual(["Solana keys are not part of the device vault yet."]);
  });

  it("writes the public Arc mainnet config when requested", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-arc-init-"));
    process.env.VAPI_HOME = home;
    delete process.env.ARC_RPC_URL;
    const captured = captureIo();

    expect(
      await runCli(["init", "--networks", "base,arc", "--json"], captured.io, {
        fetchImpl: zeroBalanceRpc(),
      }),
    ).toBe(0);

    const config = JSON.parse(await readFile(join(home, "config.json"), "utf8")) as {
      networks: Record<string, { rpcUrl: string; usdc: string }>;
    };
    expect(config.networks[ARC_MAINNET_CAIP2]).toEqual({
      rpcUrl: "https://rpc.mainnet.arc.io",
      usdc: "0x3600000000000000000000000000000000000000",
    });
  });

  it("rejects an unknown init network with the complete supported list", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-invalid-network-"));
    process.env.VAPI_HOME = home;
    const captured = captureIo();

    expect(await runCli(["init", "--networks", "base,foo"], captured.io)).toBe(2);
    expect(captured.stderr[0]).toBe(
      "--networks supports base and arc; Solana vault setup is unavailable.",
    );
  });

  it("rejects enabling Solana until the device vault supports it", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-solana-enable-"));
    process.env.VAPI_HOME = home;
    delete process.env.SOLANA_RPC_URL;
    const initialized = captureIo();
    const fetchImpl = zeroBalanceRpc();
    expect(await runCli(["init", "--json"], initialized.io, { fetchImpl })).toBe(0);
    const enabled = captureIo();

    expect(await runCli(["accounts", "--enable", "solana"], enabled.io, { fetchImpl })).toBe(2);
    expect(enabled.stdout).toEqual([]);
    expect(enabled.stderr).toEqual([
      "vapi accounts --enable is a legacy form and will move in a later release.",
      "Solana keys are not part of the device vault yet.",
    ]);
  });

  it("lazily enables Arc mainnet without deriving another key", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-arc-enable-"));
    process.env.VAPI_HOME = home;
    delete process.env.ARC_RPC_URL;
    const initialized = captureIo();
    const fetchImpl = zeroBalanceRpc();
    expect(await runCli(["init", "--json"], initialized.io, { fetchImpl })).toBe(0);
    const enabled = captureIo();

    expect(await runCli(["accounts", "--enable", "arc", "--json"], enabled.io, { fetchImpl })).toBe(
      0,
    );

    const config = JSON.parse(await readFile(join(home, "config.json"), "utf8")) as {
      networks: Record<string, { rpcUrl: string; usdc: string }>;
    };
    expect(config.networks[ARC_MAINNET_CAIP2]).toEqual({
      rpcUrl: "https://rpc.mainnet.arc.io",
      usdc: "0x3600000000000000000000000000000000000000",
    });
    expect(JSON.parse(enabled.stdout[0]!)).toMatchObject({
      accounts: [{ caip2: "eip155:8453" }, { caip2: ARC_MAINNET_CAIP2 }],
    });
  });

  it("prints Arc gas retention and its explorer URL for a human sweep", async () => {
    await initializedHome("vapi-cli-arc-sweep-");
    const enabled = captureIo();
    const fetchImpl = zeroBalanceRpc();
    expect(await runCli(["accounts", "--enable", "arc", "--json"], enabled.io, { fetchImpl })).toBe(
      0,
    );

    const captured = captureIo();
    const transaction = `0x${"ab".repeat(32)}`;
    expect(
      await runCli(
        ["sweep", "0x2222222222222222222222222222222222222222", "--network", ARC_MAINNET_CAIP2],
        captured.io,
        { fetchImpl: sweepRpc(transaction) },
      ),
    ).toBe(0);

    expect(captured.stdout.join("\n")).toContain(
      `Arc mainnet: swept 0.95 USDC in ${transaction} (https://explorer.arc.io/tx/${transaction}) (retained 0.05 USDC for gas)`,
    );
  });
});

describe("help invocation", () => {
  it("prints the usage list with its heading", async () => {
    const captured = captureIo();

    expect(await runCli(["help"], captured.io)).toBe(0);
    const text = captured.stdout.join("\n");

    expect(text.startsWith("vAPI Network")).toBe(true);
    expect(text).not.toContain("\u2588");
    expect(text).toContain("vapi fund [--amount <usd>] [--account <name>] [--json]");
    expect(text).toContain("vapi accounts [--all] [--json]");
    expect(text).not.toContain("vapi wallet list [--json]");
  });

  it("keeps --json help output free of the mark", async () => {
    const captured = captureIo();

    expect(await runCli(["help", "--json"], captured.io)).toBe(0);
    const value = JSON.parse(captured.stdout[0]!) as { command: string; help: string };
    expect(value.command).toBe("help");
    expect(value.help.startsWith("vAPI Network")).toBe(true);
    expect(captured.stdout[0]).not.toContain("\u2588");
  });
});

describe("fund command", () => {
  it("prints the funding page link without touching the network", async () => {
    const home = await initializedHome("vapi-cli-fund-page-");
    const fetchImpl = vi.fn<typeof fetch>();
    const captured = captureIo();

    expect(await runCli(["fund", "--amount", "20"], captured.io, { fetchImpl })).toBe(0);
    expect(captured.stderr).toEqual([]);
    expect(captured.stdout[0]).toMatch(/^Wallet: main \(0x[0-9a-fA-F]{40}\)$/);
    expect(captured.stdout[1]).toMatch(/^Address: 0x[0-9a-fA-F]{40}\n/);
    expect(captured.stdout[1]).toMatch(
      /Fund: https:\/\/api\.vapinetwork\.ai\/fund\/0x[0-9a-fA-F]{40}\?amount=20/,
    );
    expect(captured.stdout[1]).toContain("card via Coinbase");
    expect(captured.stdout[1]).toContain("Send USDC on Base (eip155:8453)");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(home).toContain("vapi-cli-fund-page-");
  });

  it("returns the address, network and link as JSON", async () => {
    await initializedHome("vapi-cli-fund-json-");
    const fetchImpl = vi.fn<typeof fetch>();
    const captured = captureIo();

    expect(await runCli(["fund", "--json"], captured.io, { fetchImpl })).toBe(0);
    const value = JSON.parse(captured.stdout[0]!) as Record<string, string>;
    expect(Object.keys(value).sort()).toEqual(["address", "network", "url", "wallet"]);
    expect(value.network).toBe("base");
    expect(value.url).toBe(`https://api.vapinetwork.ai/fund/${value.address}`);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("honours VAPI_REGISTRY_URL", async () => {
    await initializedHome("vapi-cli-fund-registry-");
    const previous = process.env.VAPI_REGISTRY_URL;
    process.env.VAPI_REGISTRY_URL = "https://staging.example";
    const captured = captureIo();

    try {
      expect(await runCli(["fund", "--json"], captured.io)).toBe(0);
    } finally {
      restoreEnvironment("VAPI_REGISTRY_URL", previous);
    }
    expect((JSON.parse(captured.stdout[0]!) as { url: string }).url).toContain(
      "https://staging.example/fund/0x",
    );
  });

  it("rejects an amount that is not a dollar figure", async () => {
    await initializedHome("vapi-cli-fund-amount-");
    const captured = captureIo();

    expect(await runCli(["fund", "--amount", "twenty"], captured.io)).toBe(2);
    expect(captured.stderr[0]).toContain("--amount must be a US dollar amount");
  });
});

describe("pay command arguments", () => {
  it("prints the complete usage when the payment reference is missing", async () => {
    const captured = captureIo();

    expect(await runCli(["pay"], captured.io)).toBe(2);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr.join("\n")).toBe(
      "Missing <id-or-url>.\nUsage: vapi pay <id-or-url> [--method <method>] [--endpoint <name>] [--body <json>] [--content-type <type>] [--network <caip2>] [--expected-pay-to <address>] [--max <amount>] [--timeout <seconds>] [--account <name>] [--json]",
    );
  });

  it("keeps missing-argument errors machine-readable with --json", async () => {
    const captured = captureIo();

    expect(await runCli(["pay", "--json"], captured.io)).toBe(2);
    expect(captured.stderr).toEqual([]);
    expect(JSON.parse(captured.stdout[0]!)).toEqual({
      error:
        "Missing <id-or-url>.\nUsage: vapi pay <id-or-url> [--method <method>] [--endpoint <name>] [--body <json>] [--content-type <type>] [--network <caip2>] [--expected-pay-to <address>] [--max <amount>] [--timeout <seconds>] [--account <name>] [--json]",
      exitCode: 2,
    });
  });

  it.each(["0", "abc", "301"])("rejects pay --timeout %s", async (timeout) => {
    const captured = captureIo();

    expect(
      await runCli(["pay", "https://example.test/paid", "--timeout", timeout], captured.io),
    ).toBe(2);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual(["--timeout must be an integer from 1 to 300."]);
  });

  it("rejects --wallet together with --account", async () => {
    const captured = captureIo();

    expect(await runCli(["balance", "--wallet", "main", "--account", "main"], captured.io)).toBe(2);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual(["--wallet and --account cannot be used together."]);
  });

  it("keeps unknown commands concise and bare wallet as an accounts alias", async () => {
    const unknown = captureIo();
    expect(await runCli(["nonsense"], unknown.io)).toBe(2);
    expect(unknown.stdout).toEqual([]);
    expect(unknown.stderr).toEqual(['Unknown command "nonsense". Run vapi help.']);

    process.env.VAPI_HOME = await mkdtemp(join(tmpdir(), "vapi-cli-wallet-alias-"));
    const wallet = captureIo();
    expect(await runCli(["wallet"], wallet.io, { env: {}, secretStore: secretStoreStub() })).toBe(
      0,
    );
    expect(wallet.stdout).toEqual(["Accounts"]);
    expect(wallet.stderr).toEqual(["vapi wallet is now vapi accounts."]);
  });

  it("accepts legacy --wallet for a vault account with one deprecation line", async () => {
    const home = await initializedHome("vapi-cli-pay-legacy-wallet-");
    const configPath = join(home, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    config.allowPrivateNetwork = true;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    const captured = captureIo();

    const code = await runCli(
      ["pay", "https://127.0.0.1/paid", "--wallet", "main", "--json"],
      captured.io,
      {
        fetchImpl,
      },
    );
    expect(code).toBe(0);
    expect(captured.stderr).toEqual([
      "--wallet is now --account; --wallet keeps working for one release.",
    ]);
    expect(JSON.parse(captured.stdout[0]!)).toMatchObject({ wallet: "main", status: 200 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("reports a blocked payment as a structured spend-cap error", async () => {
    const home = await initializedHome("vapi-cli-pay-cap-");
    const configPath = join(home, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      networks: Record<string, { usdc: string }>;
    } & Record<string, unknown>;
    config.allowPrivateNetwork = true;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const store = await WalletStore.open(home, { secrets: sharedSecretStore(home) });
    await store.setSpendCaps("main", {
      perCallAtomic: "1000000",
      perDayAtomic: "10000000",
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input) =>
      Response.json(
        {
          x402Version: 2,
          resource: {
            url: String(input),
            description: "fixture",
            mimeType: "application/json",
          },
          accepts: [
            {
              scheme: "exact",
              network: BASE_MAINNET_CAIP2,
              amount: "2000000",
              asset: config.networks[BASE_MAINNET_CAIP2]!.usdc,
              payTo: VECTOR_ADDRESS,
              maxTimeoutSeconds: 60,
              extra: { name: "USD Coin", version: "2" },
            },
          ],
        },
        { status: 402 },
      ),
    );
    const expectedError = new SpendCapExceededError({
      cap: "per_call",
      amountUsd: "2",
      limitUsd: "1",
      wallet: "main",
    }).toJSON();
    const json = captureIo();

    expect(await runCli(["pay", "https://127.0.0.1/paid", "--json"], json.io, { fetchImpl })).toBe(
      1,
    );
    expect(json.stderr).toEqual([]);
    expect(JSON.parse(json.stdout[0]!)).toEqual({ error: expectedError, exitCode: 1 });
    expect(fetchImpl).toHaveBeenCalledOnce();

    const human = captureIo();
    expect(await runCli(["pay", "https://127.0.0.1/paid"], human.io, { fetchImpl })).toBe(1);
    expect(human.stdout).toEqual([]);
    expect(human.stderr).toEqual([expectedError.message]);
  });

  it("records spend_cap_exceeded in an agent result file", async () => {
    const home = await initializedHome("vapi-cli-result-cap-");
    const profile: AgentProfile = {
      version: 1,
      name: "researcher",
      wallet: "main",
      model: "router/test",
      instructions: "Research carefully.",
      verifiedOnly: true,
      approveAboveUsd: 0.5,
      maxPerTaskUsd: 100,
      autoReleaseBelowUsd: 25,
      maxSteps: 12,
      tools: ["call.search", "call.inspect", "call.pay"],
      grants: [],
      paused: false,
      createdAt: "2026-10-18T00:00:00.000Z",
    };
    await writeAgentProfile(home, profile);
    const refusal = new SpendCapExceededError({
      cap: "run_budget",
      amountUsd: "0.25",
      limitUsd: "0.1",
      spentUsd: "0",
      wallet: "main",
    });
    const resultFile = join(home, "run.result.json");
    const captured = captureIo();

    expect(
      await runCli(
        ["agent", "run", "researcher", "Do work", "--result-file", resultFile, "--json"],
        captured.io,
        {
          agent: {
            runAgent: async () => {
              throw refusal;
            },
          },
        },
      ),
    ).toBe(1);
    expect(JSON.parse(captured.stdout[0]!)).toEqual({ error: refusal.toJSON(), exitCode: 1 });
    expect(JSON.parse(await readFile(resultFile, "utf8"))).toEqual({
      v: 1,
      exitCode: 1,
      error: { message: refusal.message, code: "spend_cap_exceeded" },
    });
  });

  it("does not print payment headers reflected by a paid provider", async () => {
    const home = await initializedHome("vapi-cli-pay-redaction-");
    const configPath = join(home, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      networks: Record<string, { usdc: string }>;
    } & Record<string, unknown>;
    config.allowPrivateNetwork = true;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const paymentSignature = request.headers.get("payment-signature");
      const legacyPayment = request.headers.get("x-payment");
      if (paymentSignature === null || legacyPayment === null) {
        return Response.json(
          {
            x402Version: 2,
            resource: { url: request.url, description: "fixture", mimeType: "application/json" },
            accepts: [
              {
                scheme: "exact",
                network: BASE_MAINNET_CAIP2,
                amount: "1",
                asset: config.networks[BASE_MAINNET_CAIP2]!.usdc,
                payTo: VECTOR_ADDRESS,
                maxTimeoutSeconds: 60,
                extra: { name: "USD Coin", version: "2" },
              },
            ],
          },
          { status: 402 },
        );
      }
      const settlement = {
        success: true,
        nested: { [`settlement-${paymentSignature}`]: `echo:${legacyPayment}` },
      };
      return new Response(
        JSON.stringify({ nested: { [`body-${legacyPayment}`]: `echo:${paymentSignature}` } }),
        {
          headers: {
            "content-type": "application/json",
            "payment-response": Buffer.from(JSON.stringify(settlement), "utf8").toString("base64"),
          },
        },
      );
    });
    const captured = captureIo();

    expect(
      await runCli(["pay", "https://127.0.0.1/paid", "--json"], captured.io, { fetchImpl }),
    ).toBe(0);

    const serialized = captured.stdout.join("\n");
    const paidRequest = fetchImpl.mock.calls[1]![0] as Request;
    expect(serialized).not.toContain(paidRequest.headers.get("payment-signature"));
    expect(serialized).not.toContain(paidRequest.headers.get("x-payment"));
    expect(serialized).toContain("[redacted]");
  });

  it("prints a paid-call result before draining queued ceiling sweeps", async () => {
    const home = await initializedHome("vapi-cli-pay-ceiling-drain-");
    const configPath = join(home, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    config.allowPrivateNetwork = true;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const captured = captureIo();
    const drain = vi.fn(async (timeoutMs?: number) => {
      expect(timeoutMs).toBe(10_000);
      expect(captured.stdout).toHaveLength(1);
    });

    expect(
      await runCli(["pay", "https://127.0.0.1/free", "--json"], captured.io, {
        fetchImpl: async () => Response.json({ ok: true }),
        ceiling: { drainCeilingSweeps: drain },
      }),
    ).toBe(0);
    expect(drain).toHaveBeenCalledOnce();
  });
});

describe("accounts and support commands", () => {
  it("lists deposit accounts as stable JSON", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-accounts-"));
    process.env.VAPI_HOME = home;
    const fetchImpl = zeroBalanceRpc();
    expect(await runCli(["init", "--json"], captureIo().io, { fetchImpl })).toBe(0);
    const captured = captureIo();

    expect(
      await runCli(["accounts", "--account", "main", "--json"], captured.io, { fetchImpl }),
    ).toBe(0);
    expect(captured.stderr).toEqual([
      "vapi accounts --enable is a legacy form and will move in a later release.",
    ]);
    expect(JSON.parse(captured.stdout[0]!)).toMatchObject({
      accounts: [
        {
          caip2: "eip155:8453",
          name: "Base mainnet",
          address: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/),
          usdcBalance: { atomic: "0", formatted: "0" },
          gasTokenBalance: { symbol: "ETH", atomic: "0", formatted: "0" },
          depositInstructions: expect.stringContaining("Send USDC on Base"),
        },
      ],
    });
  });

  it("selects a vault account with --account for balance", async () => {
    await initializedHome("vapi-cli-balance-account-");
    const captured = captureIo();

    expect(
      await runCli(["balance", "--account", "main", "--json"], captured.io, {
        fetchImpl: zeroBalanceRpc(),
      }),
    ).toBe(0);
    expect(JSON.parse(captured.stdout[0]!)).toMatchObject({ wallet: "main" });
    expect(captured.stderr).toEqual([]);
  });

  it("writes a private local report without a network request", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-report-"));
    process.env.VAPI_HOME = home;
    const paths = getVapiPaths();
    await appendReceipt(
      {
        id: "latest-receipt",
        timestamp: new Date().toISOString(),
        resourceUrl: "https://api.example/call",
        quote: {
          network: "eip155:8453",
          asset: "0xasset",
          amountAtomic: "2500",
          payTo: "0xpayee",
        },
        payer: "0xpayer",
      },
      paths.receipts,
    );
    const fetchImpl = vi.fn<typeof fetch>();
    const captured = captureIo();

    expect(await runCli(["report", "payment failed", "--json"], captured.io, { fetchImpl })).toBe(
      0,
    );
    const result = JSON.parse(captured.stdout[0]!) as { path: string; issueUrl: string };
    const report = await readFile(result.path, "utf8");
    expect(result.issueUrl).toContain("title=payment%20failed");
    expect(report).toContain('"receiptIds"');
    expect(report).toContain("latest-receipt");
    expect(report).not.toContain("0xpayer");
    expect(report).not.toContain("0xpayee");
    expect(report).not.toContain("2500");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("search output", () => {
  const discoveryPage = {
    protocol: "vapi.marketplace.discovery/1",
    items: [
      {
        ref: "decodepaymentauthorization",
        kind: "api",
        provenance: "self_listed",
        group: "vapi",
        fee: { bps: 500, label: "Network fee kept by this API's legacy payout splitter" },
        execution: { mode: "direct" },
        card: {
          title: "decodePaymentAuthorization",
          summary: "Decode what an EVM payment authorization actually authorizes.",
          badges: [{ code: "live_x402", label: "Live x402" }],
          facts: [{ label: "Price", value: "$0.005" }],
        },
        action: { type: "invoke_api", href: "/call/decodepaymentauthorization" },
      },
      {
        ref: "https://agent402.tools/api/skill/decode-blob",
        kind: "api",
        provenance: "indexed",
        group: "external",
        fee: { bps: 0, label: "Outdated fee label" },
        execution: {
          mode: "direct",
          url: "https://agent402.tools/api/skill/decode-blob",
          method: "POST",
          network: "eip155:8453",
        },
        card: {
          title: "agent402.tools/api/skill/decode-blob",
          summary: "Unwrap an opaque blob layer by layer.",
          badges: [{ code: "external_catalog", label: "External catalog" }],
          facts: [{ label: "Price", value: "$0.007" }],
        },
        action: {
          type: "invoke_api",
          href: "/call/invoke?url=https%3A%2F%2Fagent402.tools%2Fapi%2Fskill%2Fdecode-blob",
        },
      },
    ],
    nextCursor: null,
    unavailableKinds: [],
    rankingVersion: "marketplace-ranking-v1",
  };

  it("tags each listing with its group and prints the network fee label", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-search-"));
    process.env.VAPI_HOME = home;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(discoveryPage));
    const captured = captureIo();

    expect(await runCli(["search", "decode"], captured.io, { fetchImpl })).toBe(0);

    const text = captured.stdout.join("\n");
    // The page sends no tier, so the first-party listing is not vouched for.
    expect(text).toContain(
      "decodepaymentauthorization\tapi\t-\t[vapi] [unverified] decodePaymentAuthorization",
    );
    // A mirrored row says `external` once, not `[external] [external]`.
    expect(text).toContain(
      "https://agent402.tools/api/skill/decode-blob\tapi\t-\t[external] agent402.tools/api/skill/decode-blob",
    );
    expect(text).not.toContain("[external] [external]");
    expect(text).toContain("Fee: Network fee kept by this API's legacy payout splitter (5%)");
    expect(text).toContain("Fee: No network fee");
  });

  it.each([
    { verification: "verified", tag: "[vapi] [verified] decodePaymentAuthorization" },
    { verification: "requested", tag: "[vapi] [requested] decodePaymentAuthorization" },
    { verification: "none", tag: "[vapi] [unverified] decodePaymentAuthorization" },
  ])("shows $verification as $tag", async ({ verification, tag }) => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-search-tier-"));
    process.env.VAPI_HOME = home;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ...discoveryPage,
        items: [{ ...discoveryPage.items[0], verification }],
      }),
    );
    const captured = captureIo();

    expect(await runCli(["search", "decode"], captured.io, { fetchImpl })).toBe(0);

    expect(captured.stdout.join("\n")).toContain(tag);
  });

  it("sends the trust switch only when --include-unverified is given", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-search-switch-"));
    process.env.VAPI_HOME = home;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(discoveryPage));
    const captured = captureIo();

    expect(await runCli(["search", "decode"], captured.io, { fetchImpl })).toBe(0);
    expect(
      await runCli(["search", "decode", "--include-unverified"], captured.io, { fetchImpl }),
    ).toBe(0);

    const switches = fetchImpl.mock.calls.map((call) =>
      new URL(call[0] as URL).searchParams.get("includeUnverified"),
    );
    expect(switches).toEqual([null, "true"]);
  });

  it("forwards --include-outage only when given", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-search-outage-"));
    process.env.VAPI_HOME = home;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) =>
      Response.json({
        ...discoveryPage,
        rankingVersion:
          new URL(input as URL).searchParams.get("includeOutage") === "true"
            ? "marketplace-ranking-v2"
            : discoveryPage.rankingVersion,
      }),
    );

    expect(await runCli(["search", "decode"], captureIo().io, { fetchImpl })).toBe(0);
    const captured = captureIo();
    expect(
      await runCli(["search", "decode", "--include-outage", "--json"], captured.io, {
        fetchImpl,
      }),
    ).toBe(0);
    expect(JSON.parse(captured.stdout[0]!)).toMatchObject({
      rankingVersion: "marketplace-ranking-v2",
    });
    expect(
      fetchImpl.mock.calls.map(([url]) => new URL(url as URL).searchParams.get("includeOutage")),
    ).toEqual([null, "true"]);
  });

  it.each([
    {
      health: {
        state: "healthy",
        uptime7d: 1,
        latencyP50Ms: 212.6,
        latencyP95Ms: 480,
        checks7d: 168,
      },
      cell: "healthy 213ms",
    },
    {
      health: {
        state: "unknown",
        uptime7d: null,
        latencyP50Ms: null,
        latencyP95Ms: null,
        checks7d: 0,
      },
      cell: "unknown",
    },
    {
      health: {
        state: "degraded",
        uptime7d: 0.9,
        latencyP50Ms: 0,
        latencyP95Ms: 10,
        checks7d: 168,
      },
      cell: "degraded 0ms",
    },
    {
      health: {
        state: "outage",
        uptime7d: 0.8,
        latencyP50Ms: null,
        latencyP95Ms: null,
        checks7d: 168,
      },
      cell: "outage",
    },
    { health: undefined, cell: "-" },
    { health: "malformed", cell: "-" },
  ])("prints a plain tab-separated health cell: $cell", async ({ health, cell }) => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-search-health-"));
    process.env.VAPI_HOME = home;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ...discoveryPage,
        items: [{ ...discoveryPage.items[0], health }],
      }),
    );
    const captured = captureIo();

    expect(await runCli(["search", "decode"], captured.io, { fetchImpl })).toBe(0);
    const text = captured.stdout.join("\n");
    expect(text.split("\n")[0]!.split("\t")).toEqual([
      "decodepaymentauthorization",
      "api",
      cell,
      "[vapi] [unverified] decodePaymentAuthorization",
    ]);
    expect(text).not.toContain(String.fromCharCode(27));
    expect(captured.stderr).toEqual([]);
  });

  it("prints the health placeholder for Work hits and lists API alternatives", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-search-alternatives-"));
    process.env.VAPI_HOME = home;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ...discoveryPage,
        items: [
          {
            ...discoveryPage.items[0],
            alternatives: [
              { ref: "budget-api", reason: "cheaper" },
              { ref: "reliable-api", reason: "healthier" },
            ],
          },
          {
            ...discoveryPage.items[0],
            ref: "work",
            kind: "service_offer",
            action: { type: "start_engagement", href: "/work/listings/work" },
            health: { state: "healthy" },
          },
        ],
      }),
    );
    const captured = captureIo();
    expect(await runCli(["search"], captured.io, { fetchImpl })).toBe(0);
    const text = captured.stdout.join("\n");
    expect(text).toContain("  Alternatives: budget-api (cheaper), reliable-api (healthier)");
    expect(text).toContain("work\tservice_offer\t-\t");
    expect(text).not.toContain(String.fromCharCode(27));
  });

  it("passes the verification tier through --json", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-search-verification-json-"));
    process.env.VAPI_HOME = home;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ...discoveryPage,
        items: [{ ...discoveryPage.items[0], verification: "verified" }],
      }),
    );
    const captured = captureIo();

    expect(await runCli(["search", "decode", "--json"], captured.io, { fetchImpl })).toBe(0);

    const page = JSON.parse(captured.stdout[0]!) as { items: Array<{ verification?: string }> };
    expect(page.items.map((item) => item.verification)).toEqual(["verified"]);
  });

  it("passes the group and fee through --json untouched", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-search-json-"));
    process.env.VAPI_HOME = home;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(discoveryPage));
    const captured = captureIo();

    expect(await runCli(["search", "decode", "--json"], captured.io, { fetchImpl })).toBe(0);

    const page = JSON.parse(captured.stdout[0]!) as {
      items: Array<{ group?: string; fee?: { bps: number; label: string } }>;
    };
    expect(page.items.map((item) => item.group)).toEqual(["vapi", "external"]);
    expect(page.items[0]?.fee).toEqual({
      bps: 500,
      label: "Network fee kept by this API's legacy payout splitter",
    });
  });

  it("returns an indexed Solana row from the production holder-graph page in --json", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-search-solana-"));
    process.env.VAPI_HOME = home;
    const fixture = JSON.parse(
      await readFile(
        new URL(
          "../../sources/src/__fixtures__/vapi-discovery-holder-graph-solana.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { items: Array<{ ref: string; execution: { network?: string } }> };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(fixture));
    const captured = captureIo();

    expect(
      await runCli(["search", "holder graph", "--limit", "20", "--json"], captured.io, {
        fetchImpl,
      }),
    ).toBe(0);

    const page = JSON.parse(captured.stdout[0]!) as typeof fixture;
    expect(page.items).toHaveLength(2);
    expect(page.items).toContainEqual(
      expect.objectContaining({
        ref: "https://api.deepnets.ai/api/token/holder-graph",
        execution: expect.objectContaining({
          network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        }),
      }),
    );
  });
});

describe("inspect output", () => {
  function servicesResponse(overrides: Record<string, unknown> = {}) {
    return {
      services: [
        {
          id: "decodepaymentauthorization",
          name: "Decode Payment Authorization",
          description: "Decode an x402 payment authorization.",
          category: "crypto",
          tier: "verified",
          group: "vapi",
          fee: { bps: 500, label: "Network fee kept by this API's legacy payout splitter" },
          verified: true,
          wrapped: false,
          price: "$0.005",
          networks: ["eip155:8453"],
          endpoints: [
            {
              name: "decode",
              method: "POST",
              url: "https://decode.example/decode",
              price: "$0.005",
              description: "Decode an authorization payload.",
            },
          ],
          ...overrides,
        },
      ],
    };
  }

  it.each([
    { fee: { bps: 0, label: "Outdated fee label" }, display: "No network fee" },
    {
      fee: { bps: 500, label: "Network fee kept by this API's legacy payout splitter" },
      display: "Network fee kept by this API's legacy payout splitter (5%)",
    },
  ])("shows the fee for $fee.bps basis points", async ({ fee, display }) => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-inspect-"));
    process.env.VAPI_HOME = home;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(servicesResponse({ verification: "verified", fee })));
    const captured = captureIo();

    expect(
      await runCli(["inspect", "decodepaymentauthorization"], captured.io, { fetchImpl }),
    ).toBe(0);

    const text = captured.stdout.join("\n");
    expect(text).toContain("Verification: verified");
    expect(text).toContain(`Fee: ${display}`);
  });

  it("calls a listing the registry never reviewed unverified, in text and in --json", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-inspect-unverified-"));
    process.env.VAPI_HOME = home;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(servicesResponse()));
    const captured = captureIo();

    expect(
      await runCli(["inspect", "decodepaymentauthorization"], captured.io, { fetchImpl }),
    ).toBe(0);
    expect(captured.stdout.join("\n")).toContain("Verification: unverified");

    const asJson = captureIo();
    expect(
      await runCli(["inspect", "decodepaymentauthorization", "--json"], asJson.io, { fetchImpl }),
    ).toBe(0);
    expect(JSON.parse(asJson.stdout[0]!)).toMatchObject({ verification: "none" });
  });

  it("says how the listing has behaved lately when the registry knows", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-inspect-health-"));
    process.env.VAPI_HOME = home;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json(
        servicesResponse({
          liveness: { uptime7d: 0.9941, latencyP50Ms: 212.4, latencyP95Ms: null, checks7d: 168 },
          conformance: {
            declaredVersion: 2,
            versionConformant: false,
            offerTransport: "header",
            issues: ["v2_missing_resource", "offer_header_only"],
          },
        }),
      ),
    );
    const captured = captureIo();

    expect(
      await runCli(["inspect", "decodepaymentauthorization"], captured.io, { fetchImpl }),
    ).toBe(0);

    const text = captured.stdout.join("\n");
    expect(text).toContain("Liveness: 99.4% up over 7 days (168 checks) · p50 212 ms");
    expect(text).not.toContain("p95");
    expect(text).toContain(
      "Conformance: x402 v2, not conformant, offer in the PAYMENT-REQUIRED header only · issues: v2_missing_resource, offer_header_only",
    );
  });

  it("stays silent about liveness and conformance a registry does not send", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-inspect-no-health-"));
    process.env.VAPI_HOME = home;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(servicesResponse()));
    const captured = captureIo();

    expect(
      await runCli(["inspect", "decodepaymentauthorization"], captured.io, { fetchImpl }),
    ).toBe(0);

    const text = captured.stdout.join("\n");
    expect(text).not.toContain("Liveness:");
    expect(text).not.toContain("Conformance:");
    expect(text).not.toContain("Health:");
    expect(text).not.toContain("Example request:");
  });

  it("prints health and a compact example request before the inspect JSON", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-inspect-contract-"));
    process.env.VAPI_HOME = home;
    const responseSchema = { type: "object", properties: { decoded: { type: "string" } } };
    const exampleRequest = { query: { format: "json" }, body: { authorization: "example" } };
    const response = servicesResponse({
      health: {
        state: "healthy",
        uptime7d: 0.9941,
        latencyP50Ms: 212.4,
        latencyP95Ms: 480.6,
        checks7d: 168,
      },
    });
    Object.assign(response.services[0]!.endpoints[0]!, { responseSchema, exampleRequest });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(response));
    const captured = captureIo();
    expect(
      await runCli(["inspect", "decodepaymentauthorization"], captured.io, { fetchImpl }),
    ).toBe(0);
    const text = captured.stdout.join("\n");
    expect(text).toContain(
      "Health: healthy · 99.4% up over 7 days (168 checks) · p50 212 ms · p95 481 ms",
    );
    expect(text).toContain(`Example request: ${JSON.stringify(exampleRequest)}`);
    const jsonStart = text.indexOf("\n{");
    expect(text.indexOf("Health:")).toBeLessThan(jsonStart);
    expect(text.indexOf("Example request:")).toBeLessThan(jsonStart);
    expect(JSON.parse(text.slice(jsonStart + 1))).toMatchObject({ responseSchema, exampleRequest });

    const asJson = captureIo();
    expect(
      await runCli(["inspect", "decodepaymentauthorization", "--json"], asJson.io, { fetchImpl }),
    ).toBe(0);
    expect(JSON.parse(asJson.stdout[0]!)).toMatchObject({
      responseSchema,
      exampleRequest,
      health: { state: "healthy" },
    });
  });

  it("omits unknown uptime and latency from the health line", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-inspect-unknown-health-"));
    process.env.VAPI_HOME = home;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        servicesResponse({
          health: {
            state: "unknown",
            uptime7d: null,
            latencyP50Ms: null,
            latencyP95Ms: null,
            checks7d: 0,
          },
        }),
      ),
    );
    const captured = captureIo();
    expect(
      await runCli(["inspect", "decodepaymentauthorization"], captured.io, { fetchImpl }),
    ).toBe(0);
    expect(captured.stdout[0]!.split("\n")).toContain("Health: unknown · (0 checks)");
    expect(captured.stdout[0]).not.toContain("null% up");
  });

  it("prints the registry's ERC-8004 identity and reputation", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-inspect-identity-"));
    process.env.VAPI_HOME = home;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        servicesResponse({
          identity: { erc8004Id: "42", reputation: { score: 4.567, count: 1 } },
        }),
      ),
    );
    const captured = captureIo();

    expect(
      await runCli(["inspect", "decodepaymentauthorization"], captured.io, { fetchImpl }),
    ).toBe(0);

    const text = captured.stdout.join("\n");
    expect(text).toContain("On-chain identity: ERC-8004 agent #42 (Base)");
    expect(text).toContain("Reputation: 4.57 (1 review)");
  });

  it("prints an identity without reputation and stays silent when it is absent", async () => {
    const identityHome = await mkdtemp(join(tmpdir(), "vapi-cli-inspect-identity-only-"));
    process.env.VAPI_HOME = identityHome;
    const identityFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(servicesResponse({ identity: { erc8004Id: "42" } })));
    const identityCaptured = captureIo();

    expect(
      await runCli(["inspect", "decodepaymentauthorization"], identityCaptured.io, {
        fetchImpl: identityFetch,
      }),
    ).toBe(0);
    const identityText = identityCaptured.stdout.join("\n");
    expect(identityText).toContain("On-chain identity: ERC-8004 agent #42 (Base)");
    expect(identityText).not.toContain("Reputation:");

    const absentHome = await mkdtemp(join(tmpdir(), "vapi-cli-inspect-no-identity-"));
    process.env.VAPI_HOME = absentHome;
    const absentFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json(servicesResponse()));
    const absentCaptured = captureIo();
    expect(
      await runCli(["inspect", "decodepaymentauthorization"], absentCaptured.io, {
        fetchImpl: absentFetch,
      }),
    ).toBe(0);
    expect(absentCaptured.stdout.join("\n")).not.toContain("On-chain identity:");
  });

  it("ignores malformed identity and carries valid identity through --json", async () => {
    const malformedHome = await mkdtemp(join(tmpdir(), "vapi-cli-inspect-bad-identity-"));
    process.env.VAPI_HOME = malformedHome;
    const malformedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(servicesResponse({ identity: { erc8004Id: 7 } })));
    const malformedCaptured = captureIo();
    expect(
      await runCli(["inspect", "decodepaymentauthorization"], malformedCaptured.io, {
        fetchImpl: malformedFetch,
      }),
    ).toBe(0);
    expect(malformedCaptured.stdout.join("\n")).not.toContain("On-chain identity:");

    const jsonHome = await mkdtemp(join(tmpdir(), "vapi-cli-inspect-identity-json-"));
    process.env.VAPI_HOME = jsonHome;
    const jsonFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          servicesResponse({ identity: { erc8004Id: "42", reputation: { score: 4, count: 0 } } }),
        ),
      );
    const jsonCaptured = captureIo();
    expect(
      await runCli(["inspect", "decodepaymentauthorization", "--json"], jsonCaptured.io, {
        fetchImpl: jsonFetch,
      }),
    ).toBe(0);
    expect(JSON.parse(jsonCaptured.stdout[0]!)).toMatchObject({
      identity: { erc8004Id: "42", reputation: { score: 4, count: 0 } },
    });
  });

  it.each([
    {
      label: "indexed DeepNets",
      ref: "https://api.deepnets.ai/api/token/holder-graph",
      fixture: "vapi-discovery-holder-graph-solana.json",
    },
    {
      label: "partner Birdeye",
      ref: "birdeye",
      fixture: "vapi-services-birdeye-solana.json",
    },
    {
      label: "services-API DeepNets mirror",
      ref: "https://api.deepnets.ai/api/token/holder-graph",
      fixture: "vapi-services-deepnets-solana.json",
    },
  ])("refuses the $label Solana listing with a clean JSON error", async ({ ref, fixture }) => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-inspect-solana-"));
    process.env.VAPI_HOME = home;
    const response = JSON.parse(
      await readFile(new URL(`../../sources/src/__fixtures__/${fixture}`, import.meta.url), "utf8"),
    ) as unknown;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (fixture.startsWith("vapi-discovery") && url.pathname.endsWith("/services")) {
        return Response.json({ services: [] });
      }
      return Response.json(response);
    });
    const captured = captureIo();

    expect(await runCli(["inspect", ref, "--json"], captured.io, { fetchImpl })).toBe(1);

    const error = JSON.parse(captured.stdout[0]!) as {
      code?: string;
      error: string;
      exitCode: number;
    };
    expect(error.error).toContain("Solana payments are not supported");
    expect(error.error).not.toContain("ZodError");
    expect(error.error).not.toContain("invalid_format");
    expect(error).toMatchObject({ code: "unsupported_network", exitCode: 1 });
  });
});

describe("Solana pay refusal", () => {
  it.each([
    { label: "indexed DeepNets", ref: "deepnets-holder-graph", kind: "indexed" },
    { label: "partner Birdeye", ref: "birdeye", kind: "partner" },
  ])(
    "refuses the $label row before requesting, signing, or recording payment",
    async (testCase) => {
      await initializedHome("vapi-cli-pay-solana-");
      const paths = getVapiPaths();
      const discoveryFixture = JSON.parse(
        await readFile(
          new URL(
            "../../sources/src/__fixtures__/vapi-discovery-holder-graph-solana.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ) as { items: Array<Record<string, unknown>> };
      const indexedItem = discoveryFixture.items.find(
        (item) => item.ref === "https://api.deepnets.ai/api/token/holder-graph",
      );
      if (indexedItem === undefined) throw new Error("Missing DeepNets fixture row.");
      const indexedFixture = {
        ...discoveryFixture,
        items: [{ ...indexedItem, ref: "deepnets-holder-graph" }],
      };
      const partnerFixture = JSON.parse(
        await readFile(
          new URL(
            "../../sources/src/__fixtures__/vapi-services-birdeye-solana.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ) as unknown;
      const targetUrl = "https://api.deepnets.ai/api/token/holder-graph";
      const fetchImpl = vi.fn<typeof fetch>(async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/services")) {
          return Response.json(testCase.kind === "partner" ? partnerFixture : { services: [] });
        }
        if (url.pathname.endsWith("/discovery")) return Response.json(indexedFixture);
        throw new Error(`Unexpected request to ${url.href}`);
      });
      const captured = captureIo();

      expect(await runCli(["pay", testCase.ref, "--json"], captured.io, { fetchImpl })).toBe(1);

      const error = JSON.parse(captured.stdout[0]!) as {
        code?: string;
        error: string;
        exitCode: number;
      };
      expect(error.error).toContain("Solana payments are not supported");
      expect(error.error).not.toContain("ZodError");
      expect(error).toMatchObject({ code: "unsupported_network", exitCode: 1 });
      expect(fetchImpl.mock.calls.some(([input]) => String(input).startsWith(targetUrl))).toBe(
        false,
      );
      await expect(readFile(paths.ledger, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(paths.receipts, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});

describe("vapi receipts", () => {
  it("prints an Arc mainnet settlement explorer URL", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-receipts-"));
    process.env.VAPI_HOME = home;
    await appendReceipt(
      {
        id: "arc-paid",
        timestamp: "2026-09-21T10:00:00.000Z",
        resourceUrl: "https://vendor.example/paid",
        quote: { network: "eip155:5042", amountAtomic: "2500" },
        settlement: { outcome: "succeeded", transaction: "0xabc" },
      },
      getVapiPaths().receipts,
    );
    const captured = captureIo();

    expect(await runCli(["receipts"], captured.io)).toBe(0);
    expect(captured.stdout.join("\n")).toContain("https://explorer.arc.io/tx/0xabc");
  });
});

describe("vapi pay --resume", () => {
  const PAYER = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
  const VALID_BEFORE = 1_790_000_000;
  const PAYMENT_ID = `pay_${"ab".repeat(16)}`;

  async function homeWithLostPayment(overrides: Record<string, unknown> = {}): Promise<void> {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-resume-"));
    process.env.VAPI_HOME = home;
    await appendReceipt(
      {
        id: "lost-1",
        timestamp: "2026-09-21T10:00:00.000Z",
        wallet: "agent",
        resourceUrl: "https://vendor.example/paid",
        method: "POST",
        quote: {
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          amountAtomic: "2500",
          payTo: "0x1111111111111111111111111111111111111111",
        },
        payer: PAYER,
        paymentId: PAYMENT_ID,
        authorization: {
          from: PAYER,
          nonce: `0x${"ab".repeat(32)}`,
          validBefore: String(VALID_BEFORE),
        },
        settlement: { outcome: "unknown" },
        outcome: "settlement_unknown",
        ...overrides,
      },
      getVapiPaths().receipts,
    );
  }

  /** A Base node: the latest block at `chainTime`, and the nonce `used` or not. */
  function baseNode(used: boolean, chainTime: number) {
    return vi.fn<typeof fetch>(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { id: number; method: string };
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result:
          request.method === "eth_getBlockByNumber"
            ? {
                number: "0x10",
                hash: `0x${"cd".repeat(32)}`,
                timestamp: `0x${chainTime.toString(16)}`,
              }
            : `0x${(used ? "1" : "0").padStart(64, "0")}`,
      });
    });
  }

  it("says a settled payment must not be paid again, without opening a wallet", async () => {
    await homeWithLostPayment();
    const captured = captureIo();

    expect(
      await runCli(["pay", "--resume", "lost-1"], captured.io, {
        fetchImpl: baseNode(true, VALID_BEFORE - 30),
      }),
    ).toBe(0);

    const text = captured.stdout.join("\n");
    expect(text).toMatch(/^Wallet: agent$/mu);
    expect(text).toContain("Receipt: lost-1 — POST https://vendor.example/paid");
    expect(text).toContain(`Payment id: ${PAYMENT_ID}`);
    expect(text).toContain(
      "Settled: the authorization was used on-chain, so the payment went through (or the payer cancelled it, which this client never does). Do not pay again.",
    );
  });

  it("tells an expired authorization from a pending one, in --json", async () => {
    await homeWithLostPayment();
    const expired = captureIo();
    expect(
      await runCli(["pay", "--resume", "lost-1", "--json"], expired.io, {
        fetchImpl: baseNode(false, VALID_BEFORE),
      }),
    ).toBe(0);
    expect(JSON.parse(expired.stdout[0]!)).toMatchObject({
      wallet: "agent",
      receipt: "lost-1",
      paymentId: PAYMENT_ID,
      state: "expired",
      authorizer: PAYER,
      validBefore: String(VALID_BEFORE),
      validBeforeAt: new Date(VALID_BEFORE * 1_000).toISOString(),
      message:
        "Expired: the authorization was never used and can no longer settle. Paying again is safe.",
    });

    const pending = captureIo();
    expect(
      await runCli(["pay", "--resume", "lost-1"], pending.io, {
        fetchImpl: baseNode(false, VALID_BEFORE - 1),
      }),
    ).toBe(0);
    expect(pending.stdout.join("\n")).toContain(
      `Pending: the authorization is unused but can still settle. Wait until ${new Date(VALID_BEFORE * 1_000).toISOString()}, then run vapi pay --resume lost-1 again; paying now could pay twice.`,
    );
  });

  it("still resumes a receipt written without a payment id", async () => {
    await homeWithLostPayment({ paymentId: undefined });
    const captured = captureIo();

    expect(
      await runCli(["pay", "--resume", "lost-1", "--json"], captured.io, {
        fetchImpl: baseNode(true, VALID_BEFORE - 30),
      }),
    ).toBe(0);
    const result = JSON.parse(captured.stdout[0]!) as Record<string, unknown>;
    expect(result.state).toBe("settled");
    expect(result).not.toHaveProperty("paymentId");
  });

  it("says a Solana receipt cannot be checked yet", async () => {
    await homeWithLostPayment({
      quote: {
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amountAtomic: "2500",
      },
      authorization: undefined,
    });
    const captured = captureIo();
    const fetchImpl = baseNode(false, 0);

    expect(await runCli(["pay", "--resume", "lost-1"], captured.io, { fetchImpl })).toBe(1);
    expect(captured.stderr.join("\n")).toContain(
      "checking a Solana payment's settlement is not supported yet",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("names a receipt it cannot find, and refuses to mix --resume with a payment", async () => {
    await homeWithLostPayment();
    const missing = captureIo();
    expect(await runCli(["pay", "--resume", "nope"], missing.io, {})).toBe(1);
    expect(missing.stderr.join("\n")).toContain('No receipt "nope" in');

    const mixed = captureIo();
    expect(
      await runCli(["pay", "https://vendor.example/paid", "--resume", "lost-1"], mixed.io, {}),
    ).toBe(2);
  });
});

describe("the verification notice vapi pay prints", () => {
  it("says nothing for a verified listing, or for a call with no listing at all", () => {
    expect(verificationNotice("verified")).toEqual([]);
    expect(verificationNotice(undefined)).toEqual([]);
  });

  it("is one line that neither prompts nor blocks", () => {
    expect(verificationNotice("none")).toEqual([
      "Verification: unverified — vAPI has not reviewed this listing. Check its request contract and its price with vapi inspect.",
    ]);
    expect(verificationNotice("requested")).toEqual([
      "Verification: requested — vAPI review is pending. Check its request contract and its price with vapi inspect.",
    ]);
  });
});

describe("local metrics commands", () => {
  it("prints stable stats JSON and exports flattened CSV", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-metrics-"));
    process.env.VAPI_HOME = home;
    const paths = getVapiPaths();
    const timestamp = new Date().toISOString();
    await appendReceipt(
      {
        id: "paid-weather",
        timestamp,
        resourceUrl: "https://weather.example/call",
        quote: {
          network: "eip155:8453",
          asset: "0xasset",
          amountAtomic: "2500",
          payTo: "0xpayee",
        },
        outcome: "paid",
        latencyMs: 25,
        phases: { quoteMs: 10, requestMs: 15 },
        listing: { name: "Weather", providerHost: "weather.example", source: "vapi" },
        policy: { capsApplied: true },
        client: { name: "vapi-network", version: "0.2.0-dev.3" },
      },
      paths.receipts,
    );
    await appendSearchEvent(
      {
        timestamp,
        query: "weather",
        sources: [{ source: "api.vapinetwork.ai", latencyMs: 12, count: 1 }],
        mergedCount: 1,
      },
      paths.searches,
    );

    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}));
    const statsOutput = captureIo();
    expect(await runCli(["stats", "--range", "24h", "--json"], statsOutput.io, { fetchImpl })).toBe(
      0,
    );
    expect(JSON.parse(statsOutput.stdout[0]!)).toMatchObject({
      range: "24h",
      totals: { spendUsd: "0.0025", calls: 1, uniqueApis: 1, policyDeclines: 0 },
      outcomes: { paid: { count: 1, rate: 1 } },
      search: { count: 1, zeroResultRate: 0 },
    });

    const csvOutput = captureIo();
    expect(
      await runCli(["receipts", "export", "--format", "csv", "--range", "24h"], csvOutput.io),
    ).toBe(0);
    expect(csvOutput.stdout[0]).toContain("id,timestamp,outcome,resourceUrl");
    expect(csvOutput.stdout[0]).toContain("paid-weather");
    expect(csvOutput.stdout[0]).toContain("0.0025");
  });

  it("adds routed-through-vAPI network stats to text and JSON output", async () => {
    await initializedHome("vapi-cli-network-stats-");
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        routedThroughVapi: { usd24h: "12.5", usd30d: "1234.567891", txCount: 42 },
      }),
    );

    const textOutput = captureIo();
    expect(await runCli(["stats"], textOutput.io, { fetchImpl })).toBe(0);
    const text = textOutput.stdout.join("\n");
    expect(text).toContain("NETWORK (all vAPI clients)\tVALUE");
    expect(text).toContain("Routed through vAPI (24h, USD)\t12.5");
    expect(text).toContain("Routed through vAPI (30d, USD)\t1234.567891");
    expect(text).toContain("Routed through vAPI (30d, tx)\t42");

    const jsonOutput = captureIo();
    expect(await runCli(["stats", "--json"], jsonOutput.io, { fetchImpl })).toBe(0);
    expect(JSON.parse(jsonOutput.stdout[0]!)).toMatchObject({
      network: {
        routedThroughVapi: { usd24h: "12.5", usd30d: "1234.567891", txCount: 42 },
      },
    });
    const requestedUrl = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(requestedUrl.pathname.endsWith("/api/call/stats")).toBe(true);
    expect(requestedUrl.searchParams.get("range")).toBe("30d");
  });

  it("keeps local stats successful and silent when network stats are unavailable", async () => {
    const cases: Array<[string, typeof fetch]> = [
      ["fetch throws", vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"))],
      [
        "fetch returns 500",
        vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 500 })),
      ],
      [
        "body is invalid JSON",
        vi.fn<typeof fetch>().mockResolvedValue(new Response("not-json", { status: 200 })),
      ],
      [
        "body omits routedThroughVapi",
        vi.fn<typeof fetch>().mockResolvedValue(Response.json({ other: true })),
      ],
      [
        "body has malformed fields",
        vi.fn<typeof fetch>().mockResolvedValue(
          Response.json({
            routedThroughVapi: { usd24h: "12.1234567", usd30d: "1", txCount: -1 },
          }),
        ),
      ],
    ];

    for (const [name, fetchImpl] of cases) {
      await initializedHome(`vapi-cli-network-stats-${name.replaceAll(" ", "-")}-`);
      const output = captureIo();

      expect(await runCli(["stats", "--json"], output.io, { fetchImpl }), name).toBe(0);
      expect(output.stdout[0]).not.toContain("NETWORK");
      expect(JSON.parse(output.stdout[0]!).network).toBeNull();
      expect(output.stderr).toEqual([]);
    }
  });
});

describe("vapi sweep destinations", () => {
  const owner = "0x1111111111111111111111111111111111111111" as const;
  const explicit = "0x2222222222222222222222222222222222222222";

  it("uses the linked owner when no address is supplied", async () => {
    const home = await initializedHome("vapi-cli-sweep-owner-");
    const store = await WalletStore.open(home, { secrets: sharedSecretStore(home) });
    await store.setLink("main", {
      apiBase: "https://api.vapinetwork.ai",
      clientId: "agent_main",
      owner,
      label: "researcher",
      scopes: ["mcp:call", "router.use"],
      linkedAt: "2026-09-23T10:00:00.000Z",
    });
    const sweepBack = successfulSweep();
    const captured = captureIo();

    expect(await runCli(["sweep"], captured.io, { sweepBack })).toBe(0);

    expect(sweepBack).toHaveBeenCalledOnce();
    expect(sweepBack.mock.calls[0]![0]).toMatchObject({ destination: owner });
    expect(captured.stdout.join("\n")).toContain(`to your owner wallet ${owner}`);
  });

  it("keeps the usage error when no address or link exists", async () => {
    await initializedHome("vapi-cli-sweep-no-owner-");
    const captured = captureIo();

    expect(await runCli(["sweep"], captured.io, { sweepBack: successfulSweep() })).toBe(2);

    const message = captured.stderr.join("\n");
    expect(message).toContain("Usage: vapi sweep [<address>] [--network <caip2>]");
    expect(message).toContain("vapi login");
  });

  it("plans same-key aliases before the outer sweep lock", async () => {
    const home = await initializedHome("vapi-cli-sweep-alias-");
    const store = await WalletStore.open(home, { secrets: sharedSecretStore(home) });
    await store.importKey("first-alias", "", IMPORTED_KEY);
    await store.importKey("second-alias", "", IMPORTED_KEY);
    const sweepBack = successfulSweep();
    const captured = captureIo();
    expect(
      await runCli(
        ["sweep", explicit, "--wallet", "first-alias", "--network", BASE_MAINNET_CAIP2, "--json"],
        captured.io,
        { sweepBack },
      ),
    ).toBe(0);
    expect(JSON.parse(captured.stdout[0]!)).toMatchObject({
      wallet: "first-alias",
      results: [{ status: "swept" }],
    });
    expect(sweepBack).toHaveBeenCalledOnce();
  });

  it("keeps an explicit destination unchanged", async () => {
    await initializedHome("vapi-cli-sweep-explicit-");
    const sweepBack = successfulSweep();
    const captured = captureIo();

    expect(await runCli(["sweep", explicit], captured.io, { sweepBack })).toBe(0);

    expect(sweepBack.mock.calls[0]![0]).toMatchObject({ destination: explicit });
    expect(captured.stdout.join("\n")).not.toContain("your owner wallet");
  });

  it("refuses a manual sweep while a signed failed movement may still settle", async () => {
    const home = await initializedHome("vapi-cli-sweep-open-movement-");
    const payer = await accountAddress(home);
    const nonce = `0x${"12".repeat(32)}` as const;
    const movementId = "mv_manualsweep1";
    await mkdir(join(home, "movements"), { recursive: true });
    await writeFile(
      join(home, "movements", `${movementId}.json`),
      `${JSON.stringify({
        v: 2,
        id: movementId,
        reason: "sweep",
        from: "main",
        network: BASE_MAINNET_CAIP2,
        createdAt: "2026-09-30T10:00:00.000Z",
        legs: [
          {
            from: "main",
            to: owner,
            fromAddress: payer,
            toAddress: owner,
            amountUsd: "10.00",
            purpose: "sweep",
            nonce,
            status: "failed",
            reason: "relay_limit",
          },
        ],
      })}\n`,
      "utf8",
    );
    await appendReceipt(
      {
        id: "signed-failed-manual-sweep",
        timestamp: "2026-09-30T10:00:01.000Z",
        kind: "transfer",
        wallet: "main",
        resourceUrl: "https://api.vapinetwork.ai/api/agents/relay-transfer",
        method: "POST",
        quote: { network: BASE_MAINNET_CAIP2, amountAtomic: "10000000", payTo: owner },
        payer,
        transfer: {
          to: owner,
          toName: "owner",
          toKind: "owner",
          amountAtomic: "10000000",
          network: BASE_MAINNET_CAIP2,
          nonce,
          status: "failed",
          txHash: null,
          replayed: false,
        },
        settlement: { outcome: "rejected" },
        error: { code: "relay_limit", message: "relay limit" },
      },
      getVapiPaths(home).receipts,
      { wallet: "main" },
    );
    const sweepBack = successfulSweep();
    const captured = captureIo();

    expect(await runCli(["sweep", explicit], captured.io, { sweepBack })).toBe(1);
    expect(sweepBack).not.toHaveBeenCalled();
    expect(captured.stderr.join("\n")).toContain(`vapi accounts distribute --resume ${movementId}`);
  });

  it("prints a friendly gas error for an explicit network", async () => {
    const home = await initializedHome("vapi-cli-sweep-gas-");
    const address = await accountAddress(home);
    const captured = captureIo();

    expect(
      await runCli(["sweep", explicit, "--network", BASE_MAINNET_CAIP2], captured.io, {
        sweepBack: failingGasSweep(),
      }),
    ).toBe(1);

    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual([friendlySweepGasMessage(address)]);
  });

  it("returns the friendly gas error as the only JSON value", async () => {
    const home = await initializedHome("vapi-cli-sweep-gas-json-");
    const address = await accountAddress(home);
    const captured = captureIo();

    expect(
      await runCli(["sweep", explicit, "--network", BASE_MAINNET_CAIP2, "--json"], captured.io, {
        sweepBack: failingGasSweep(),
      }),
    ).toBe(1);

    expect(captured.stderr).toEqual([]);
    expect(JSON.parse(captured.stdout[0]!)).toEqual({
      error: friendlySweepGasMessage(address),
      exitCode: 1,
    });
  });

  it("surfaces a gas error when every configured network fails", async () => {
    const home = await initializedHome("vapi-cli-sweep-gas-all-");
    const address = await accountAddress(home);
    delete process.env.ARC_RPC_URL;
    expect(await runCli(["accounts", "--enable", "arc", "--json"], captureIo().io)).toBe(0);
    const captured = captureIo();
    const sweepBack = vi.fn<NonNullable<CliDependencies["sweepBack"]>>(
      async ({ account, network }) => {
        if (network === BASE_MAINNET_CAIP2) {
          throw new SweepGasError(account.address, new Error("insufficient funds"));
        }
        throw new Error("temporary RPC failure");
      },
    );

    expect(await runCli(["sweep", explicit], captured.io, { sweepBack })).toBe(1);

    expect(captured.stderr).toEqual([friendlySweepGasMessage(address)]);
  });
});

/**
 * `vapi publish` is a real command since 0.4.0, so only the gateway daemon is
 * still a stub. Its tests live in `publish-cli.test.ts`.
 */
describe("the gateway daemon preview", () => {
  it("serve exits 2 with the promised message", async () => {
    const captured = captureIo();
    expect(await runCli(["serve"], captured.io)).toBe(2);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual(["gateway daemon lands in 0.3"]);
  });

  it("serve remains a stub when its future arguments are supplied", async () => {
    const captured = captureIo();
    expect(await runCli(["serve", "--port", "4020"], captured.io)).toBe(2);
    expect(captured.stderr).toEqual(["gateway daemon lands in 0.3"]);
  });

  it("serve has machine-readable JSON output", async () => {
    const captured = captureIo();
    expect(await runCli(["serve", "--json"], captured.io)).toBe(2);
    expect(captured.stderr).toEqual([]);
    expect(JSON.parse(captured.stdout[0]!)).toEqual({
      error: "gateway daemon lands in 0.3",
      exitCode: 2,
    });
  });
});

describe("init safety", () => {
  it("lists the wallets it found instead of asking for a second passphrase", async () => {
    const home = await initializedHome("vapi-cli-init-twice-");
    const address = await accountAddress(home);
    // No passphrase in the environment: reaching the prompt would fail differently.
    delete process.env.VAPI_KEYSTORE_PASSWORD;
    const captured = captureIo();

    expect(
      await runCli(["init"], captured.io, {
        fetchImpl: zeroBalanceRpc(),
        secretStore: secretStoreStub(),
      }),
    ).toBe(0);

    const text = captured.stdout.join("\n");
    expect(text).toContain("This machine already has a wallet, so vapi init created nothing.");
    expect(text).toContain(address);
    expect(text).toContain("vapi accounts add <name>");
    expect(captured.stderr).toEqual([]);

    const asJson = captureIo();
    expect(
      await runCli(["init", "--json"], asJson.io, {
        fetchImpl: zeroBalanceRpc(),
        secretStore: secretStoreStub(),
      }),
    ).toBe(0);
    expect(JSON.parse(asJson.stdout[0]!)).toMatchObject({
      default: "main",
      wallets: [{ name: "main", address, isDefault: true }],
      message: "This machine already has a wallet, so vapi init created nothing.",
    });
  });
});

describe("export-key command", () => {
  const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

  it("prints the wallet name and then only the EVM key, behind a stderr warning", async () => {
    const home = await initializedHome("vapi-cli-export-evm-");
    const address = await accountAddress(home);
    const prompts = scriptedPrompts({ "Type main to print its private key: ": "main" });
    const captured = captureIo();

    expect(await runCli(["export-key"], captured.io, { ...HUMAN, prompts: prompts.prompts })).toBe(
      0,
    );

    expect(captured.stderr).toEqual([
      "Anyone with this key can spend the wallet. Never paste it into a website or chat.",
    ]);
    expect(captured.stdout).toHaveLength(2);
    expect(captured.stdout[0]).toBe(`Wallet: main (${address})`);
    const privateKey = captured.stdout[1]!;
    expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(privateKeyToAccount(privateKey as Hex).address).toBe(address);
  });

  it("returns the wallet, network, address, and key as JSON", async () => {
    await initializedHome("vapi-cli-export-json-");
    const prompts = scriptedPrompts({ "Type main to print its private key: ": "main" });
    const captured = captureIo();

    expect(
      await runCli(["export-key", "--json"], captured.io, { ...HUMAN, prompts: prompts.prompts }),
    ).toBe(0);

    const value = JSON.parse(captured.stdout[0]!) as {
      wallet: string;
      network: string;
      address: string;
      privateKey: string;
    };
    expect(value.wallet).toBe("main");
    expect(value.network).toBe("eip155:8453");
    expect(privateKeyToAccount(value.privateKey as Hex).address).toBe(value.address);
  });

  it("exports from a password-protected vault without asking for an account passphrase", async () => {
    const home = await initializedHome("vapi-cli-export-protected-");
    const secrets = sharedSecretStore(home);
    await protectVault({ path: vaultPath(home), secrets, password: "vault-password" });
    const prompts = scriptedPrompts({ "Type main to print its private key: ": "main" });
    const captured = captureIo();

    expect(
      await runCli(["export-key", "--json"], captured.io, {
        ...HUMAN,
        env: { VAPI_VAULT_PASSWORD: "vault-password" },
        prompts: prompts.prompts,
      }),
    ).toBe(0);

    const value = JSON.parse(captured.stdout[0]!) as { address: string; privateKey: Hex };
    expect(privateKeyToAccount(value.privateKey).address).toBe(value.address);
    expect(prompts.prompted).toEqual(["Type main to print its private key: "]);
  });

  it("prints nothing when the typed name does not match", async () => {
    await initializedHome("vapi-cli-export-wrong-name-");
    const prompts = scriptedPrompts({ "Type main to print its private key: ": "agent" });
    const captured = captureIo();

    expect(await runCli(["export-key"], captured.io, { ...HUMAN, prompts: prompts.prompts })).toBe(
      1,
    );

    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual(["That is not the wallet name. Nothing was printed."]);
  });

  it("rejects exporting a Solana key until the device vault supports it", async () => {
    await initializedHome("vapi-cli-export-solana-");
    const captured = captureIo();

    expect(
      await runCli(["export-key", "--network", SOLANA_MAINNET], captured.io, { ...HUMAN }),
    ).toBe(2);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual(["Solana keys are not part of the device vault yet."]);
  });

  it("rejects a network identifier it cannot map to a key", async () => {
    await initializedHome("vapi-cli-export-bad-network-");
    const captured = captureIo();

    expect(await runCli(["export-key", "--network", "bitcoin:mainnet"], captured.io)).toBe(2);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr[0]).toContain("eip155:<chainId> or Solana network identifier");
  });
});

describe("custody at creation", () => {
  it("prints the custody notice and shows the phrase once behind an Enter gate", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-init-phrase-"));
    process.env.VAPI_HOME = home;
    const prompts = scriptedPrompts({ "Write these 12 words down, then press Enter. ": "" });
    const captured = captureIo();

    expect(
      await runCli(["init", "--no-link"], captured.io, {
        ...HUMAN,
        fetchImpl: zeroBalanceRpc(),
        prompts: prompts.prompts,
      }),
    ).toBe(0);

    const text = captured.stdout.join("\n");
    expect(text).toContain(
      "This wallet is yours. vAPI has no copy of the key and cannot recover it.",
    );
    expect(text).toContain(
      "If you lose this machine and your recovery phrase, the funds are gone.",
    );
    expect(text).toContain(`Vault: ${vaultPath(home)}`);
    expect(prompts.prompted).toEqual(["Write these 12 words down, then press Enter. "]);
    expect(captured.stderr).toEqual([]);

    const words = numberedWords(text);
    expect(words).toHaveLength(12);
    const backupPrompts = scriptedPrompts({
      "Type main to print its recovery phrase: ": "main",
    });
    const backup = captureIo();
    expect(
      await runCli(["backup", "--json"], backup.io, { ...HUMAN, prompts: backupPrompts.prompts }),
    ).toBe(0);
    expect(JSON.parse(backup.stdout[0]!)).toEqual({
      wallet: "main",
      recoveryPhrase: words.join(" "),
    });
  });

  it("hides the phrase in --json and names vapi backup without a terminal", async () => {
    const jsonHome = await mkdtemp(join(tmpdir(), "vapi-cli-init-json-phrase-"));
    process.env.VAPI_HOME = jsonHome;
    const jsonRun = captureIo();

    expect(
      await runCli(["init", "--json"], jsonRun.io, {
        ...HUMAN,
        fetchImpl: zeroBalanceRpc(),
        prompts: refusingPrompts(),
      }),
    ).toBe(0);

    expect(jsonRun.stdout).toHaveLength(1);
    expect(JSON.parse(jsonRun.stdout[0]!)).toMatchObject({
      custody: "self",
      recoveryPhrase: "hidden",
      warning:
        "This wallet is yours. vAPI has no copy of the key and cannot recover it.\nIf you lose this machine and your recovery phrase, the funds are gone.",
    });
    expect(numberedWords(jsonRun.stdout[0]!)).toEqual([]);

    const pipedHome = await mkdtemp(join(tmpdir(), "vapi-cli-init-piped-phrase-"));
    process.env.VAPI_HOME = pipedHome;
    const piped = captureIo();

    expect(
      await runCli(["init"], piped.io, {
        fetchImpl: zeroBalanceRpc(),
        interactive: false,
        env: {},
        prompts: refusingPrompts(),
      }),
    ).toBe(0);

    const text = piped.stdout.join("\n");
    expect(text).toContain("Recovery phrase: run vapi backup yourself in a terminal to see it.");
    expect(numberedWords(text)).toEqual([]);
  });
});

describe("backup command", () => {
  it("prints the wallet name and then the numbered words, behind a stderr warning", async () => {
    await initializedHome("vapi-cli-backup-v3-");
    const prompts = scriptedPrompts({ "Type main to print its recovery phrase: ": "main" });
    const captured = captureIo();

    expect(await runCli(["backup"], captured.io, { ...HUMAN, prompts: prompts.prompts })).toBe(0);

    expect(captured.stderr).toEqual([BACKUP_WARNING]);
    expect(captured.stdout).toHaveLength(2);
    expect(captured.stdout[0]).toMatch(/^Wallet: main \(0x[0-9a-fA-F]{40}\)$/);
    expect(numberedWords(captured.stdout[1]!)).toHaveLength(12);
  });

  it("backs up a password-protected vault without an account passphrase prompt", async () => {
    const home = await initializedHome("vapi-cli-backup-protected-");
    const secrets = sharedSecretStore(home);
    await protectVault({ path: vaultPath(home), secrets, password: "vault-password" });
    const prompts = scriptedPrompts({
      "Type main to print its recovery phrase: ": "main",
    });
    const captured = captureIo();

    expect(
      await runCli(["backup"], captured.io, {
        ...HUMAN,
        env: { VAPI_VAULT_PASSWORD: "vault-password" },
        prompts: prompts.prompts,
      }),
    ).toBe(0);

    expect(numberedWords(captured.stdout[1]!)).toHaveLength(12);
    expect(prompts.prompted).toEqual(["Type main to print its recovery phrase: "]);
  });

  it("audits a shown vault phrase without recording the recovery phrase", async () => {
    const home = await initializedHome("vapi-cli-backup-audit-");
    const prompts = scriptedPrompts({ "Type main to print its recovery phrase: ": "main" });
    const captured = captureIo();

    expect(await runCli(["backup"], captured.io, { ...HUMAN, prompts: prompts.prompts })).toBe(0);

    const phraseWords = numberedWords(captured.stdout[1]!);
    expect(phraseWords).toHaveLength(12);
    const auditLines = (await readFile(join(home, "audit.log"), "utf8"))
      .trim()
      .split("\n")
      .filter((line) => line.includes('"event":"vault.backup_shown"'));
    expect(auditLines).toHaveLength(1);
    const auditEntry = JSON.parse(auditLines[0]!) as Record<string, unknown>;
    expect(auditEntry).toMatchObject({
      event: "vault.backup_shown",
      wallet: "main",
    });
    expect(Object.keys(auditEntry).sort()).toEqual(["event", "time", "tty", "wallet"]);
    expect(auditLines[0]).not.toContain(phraseWords.join(" "));
  });

  it("refuses to present the vault phrase as an imported account backup", async () => {
    await initializedHome("vapi-cli-backup-imported-");
    const imported = captureIo();
    expect(
      await runCli(["accounts", "import", "imported"], imported.io, {
        ...HUMAN,
        prompts: scriptedPrompts({ "Private key: ": `0x${"44".repeat(32)}` }).prompts,
      }),
    ).toBe(0);
    const captured = captureIo();

    expect(
      await runCli(["backup", "--account", "imported"], captured.io, {
        ...HUMAN,
        prompts: refusingPrompts(),
      }),
    ).toBe(1);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual([
      "Account imported was imported and is not recoverable from the vault phrase. Back it up with vapi export-key --account imported.",
    ]);
  });
});

describe("import command", () => {
  it("restores the vector wallet from words typed at the prompt", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-import-phrase-"));
    process.env.VAPI_HOME = home;
    const prompts = scriptedPrompts({ "Recovery phrase: ": VECTOR_PHRASE });
    const captured = captureIo();

    expect(
      await runCli(["import", "--phrase", "--json"], captured.io, {
        fetchImpl: zeroBalanceRpc(),
        prompts: prompts.prompts,
      }),
    ).toBe(0);

    expect(captured.stderr).toEqual([]);
    expect(JSON.parse(captured.stdout[0]!)).toEqual({
      wallet: "main",
      address: VECTOR_ADDRESS,
      vault: vaultPath(home),
      message: "Wallet imported. Its encrypted key stays on this machine.",
    });
    expect(captured.stdout[0]).not.toContain("abandon");
    expect(JSON.parse(await readFile(vaultPath(home), "utf8"))).toMatchObject({
      accounts: [{ name: "main", kind: "derived", address: VECTOR_ADDRESS }],
    });
  });

  it("refuses to replace an existing wallet, and never reads the phrase from argv", async () => {
    const home = await initializedHome("vapi-cli-import-existing-");
    const prompts = scriptedPrompts({ "Recovery phrase: ": VECTOR_PHRASE });
    const unnamed = captureIo();

    // Without a name there is nothing safe to do: main already holds a key.
    expect(
      await runCli(["import", "--phrase"], unnamed.io, {
        fetchImpl: zeroBalanceRpc(),
        env: {},
        prompts: prompts.prompts,
      }),
    ).toBe(1);
    expect(unnamed.stderr.join("\n")).toContain("This machine already has main.");
    expect(unnamed.stderr.join("\n")).toContain("vapi import --account <name>");

    const refused = captureIo();
    expect(
      await runCli(["import", "--phrase", "--wallet", "main"], refused.io, {
        fetchImpl: zeroBalanceRpc(),
        env: {},
        prompts: prompts.prompts,
      }),
    ).toBe(1);
    expect(refused.stderr.join("\n")).toContain(
      `Wallet main already exists at ${vaultPath(home)}.`,
    );
    expect(refused.stderr.join("\n")).toContain("--replace");
    expect(prompts.prompted).toEqual([]);

    const onArgv = captureIo();
    expect(
      await runCli(["import", "--phrase", "abandon", "abandon"], onArgv.io, {
        prompts: refusingPrompts(),
      }),
    ).toBe(2);
    expect(onArgv.stderr[0]).toContain("reads the secret from a prompt");
  });

  it("replaces an empty vault account and keeps a funded one", async () => {
    const home = await initializedHome("vapi-cli-import-replace-");
    const previousAddress = await accountAddress(home);
    const fundedPrompts = scriptedPrompts({ "Recovery phrase: ": VECTOR_PHRASE });
    const funded = captureIo();

    expect(
      await runCli(["import", "--phrase", "--wallet", "main", "--replace"], funded.io, {
        fetchImpl: fundedRpc(),
        env: {},
        prompts: fundedPrompts.prompts,
      }),
    ).toBe(1);
    expect(funded.stderr.join("\n")).toContain(
      `Wallet main (${previousAddress}) still holds 1000000 atomic USDC.`,
    );
    expect(funded.stderr.join("\n")).toContain("--force");

    const prompts = scriptedPrompts({ "Recovery phrase: ": VECTOR_PHRASE });
    const captured = captureIo();
    expect(
      await runCli(["import", "--phrase", "--wallet", "main", "--replace", "--json"], captured.io, {
        fetchImpl: zeroBalanceRpc(),
        env: {},
        prompts: prompts.prompts,
      }),
    ).toBe(0);

    const value = JSON.parse(captured.stdout[0]!) as {
      wallet: string;
      address: string;
      vault: string;
    };
    expect(value.wallet).toBe("main");
    expect(value.address).toBe(VECTOR_ADDRESS);
    expect(value.vault).toBe(vaultPath(home));
    expect(JSON.parse(await readFile(vaultPath(home), "utf8"))).toMatchObject({
      accounts: [{ name: "main", kind: "imported", address: VECTOR_ADDRESS }],
    });
  });

  it("round-trips a private key typed at the prompt", async () => {
    const home = await mkdtemp(join(tmpdir(), "vapi-cli-import-key-"));
    process.env.VAPI_HOME = home;
    const prompts = scriptedPrompts({ "Private key: ": IMPORTED_KEY });
    const captured = captureIo();

    expect(
      await runCli(["import", "--key", "--json"], captured.io, {
        fetchImpl: zeroBalanceRpc(),
        prompts: prompts.prompts,
      }),
    ).toBe(0);

    const expected = privateKeyToAccount(IMPORTED_KEY).address;
    expect(JSON.parse(captured.stdout[0]!)).toMatchObject({ wallet: "main", address: expected });
    expect(captured.stdout[0]).not.toContain(IMPORTED_KEY.slice(2));
    expect(JSON.parse(await readFile(vaultPath(home), "utf8"))).toMatchObject({
      accounts: [{ name: "main", kind: "imported", address: expected }],
    });

    const exportPrompts = scriptedPrompts({ "Type main to print its private key: ": "main" });
    const exported = captureIo();
    expect(
      await runCli(["export-key"], exported.io, { ...HUMAN, prompts: exportPrompts.prompts }),
    ).toBe(0);
    expect(exported.stdout[1]).toBe(IMPORTED_KEY);
  });
});

describe("passphrase command", () => {
  it("directs account passphrases to whole-vault protection", async () => {
    await initializedHome("vapi-cli-passphrase-");
    const captured = captureIo();

    expect(await runCli(["passphrase"], captured.io)).toBe(1);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual([
      "Vault accounts have no passphrase. Protect the whole vault instead with vapi vault protect.",
    ]);
  });
});

/** The words a numbered phrase listing shows, in order. */
function numberedWords(text: string): string[] {
  return text.split("\n").flatMap((line) => {
    const match = /^ *\d+\. ([a-z]+)$/u.exec(line);
    return match ? [match[1]!] : [];
  });
}

function scriptedPrompts(answers: Record<string, string>): {
  prompts: CliPrompts;
  prompted: string[];
} {
  const prompted: string[] = [];
  const answer = async (prompt: string) => {
    prompted.push(prompt);
    const scripted = answers[prompt];
    if (scripted === undefined) throw new Error(`Unexpected prompt ${JSON.stringify(prompt)}.`);
    return scripted;
  };
  return { prompted, prompts: { secret: answer, line: answer } };
}

/** A prompt that must never be reached. */
function refusingPrompts(): CliPrompts {
  const refuse = async (prompt: string): Promise<string> => {
    throw new Error(`Unexpected prompt ${JSON.stringify(prompt)}.`);
  };
  return { secret: refuse, line: refuse };
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

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function initializedHome(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  process.env.VAPI_HOME = home;
  expect(await runCli(["init", "--json"], captureIo().io, { fetchImpl: zeroBalanceRpc() })).toBe(0);
  return home;
}

/** One USDC on Base, so a replace has something to refuse. */
function fundedRpc() {
  return vi.fn<typeof fetch>(async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { id: number; method: string };
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result:
        request.method === "eth_call" ? `0x${(1_000_000).toString(16).padStart(64, "0")}` : "0x0",
    });
  });
}

function zeroBalanceRpc() {
  return vi.fn<typeof fetch>(async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { id: number; method: string };
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result:
        request.method === "eth_call"
          ? `0x${"0".repeat(64)}`
          : request.method === "getTokenAccountsByOwner"
            ? { context: { slot: 1 }, value: [] }
            : request.method === "getBalance"
              ? { context: { slot: 1 }, value: 0 }
              : "0x0",
    });
  });
}

function sweepRpc(transaction: string) {
  const blockHash = `0x${"cd".repeat(32)}`;
  const usdc = "0x3600000000000000000000000000000000000000";
  return vi.fn<typeof fetch>(async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { id: number; method: string };
    let result: unknown = "0x0";
    switch (request.method) {
      case "eth_call":
        result = `0x${(1_000_000).toString(16).padStart(64, "0")}`;
        break;
      case "eth_chainId":
        result = "0x13b2";
        break;
      case "eth_getTransactionCount":
        result = "0x0";
        break;
      case "eth_estimateGas":
        result = "0x5208";
        break;
      case "eth_gasPrice":
      case "eth_maxPriorityFeePerGas":
        result = "0x1";
        break;
      case "eth_getBlockByNumber":
        result = {
          number: "0x1",
          hash: blockHash,
          parentHash: `0x${"ef".repeat(32)}`,
          timestamp: "0x1",
          baseFeePerGas: "0x1",
        };
        break;
      case "eth_sendRawTransaction":
        result = transaction;
        break;
      case "eth_getTransactionReceipt":
        result = {
          transactionHash: transaction,
          blockHash,
          blockNumber: "0x1",
          cumulativeGasUsed: "0x5208",
          effectiveGasPrice: "0x1",
          gasUsed: "0x5208",
          logs: [],
          status: "0x1",
          type: "0x2",
          contractAddress: null,
          from: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
          to: usdc,
        };
        break;
    }
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  });
}

function successfulSweep() {
  return vi.fn<NonNullable<CliDependencies["sweepBack"]>>(async ({ network }) => ({
    network,
    amountAtomic: "1000000",
    transaction: "0x1234",
  }));
}

function failingGasSweep() {
  return vi.fn<NonNullable<CliDependencies["sweepBack"]>>(async ({ account }) => {
    throw new SweepGasError(
      account.address,
      new Error("insufficient funds for gas * price + value"),
    );
  });
}

function friendlySweepGasMessage(address: string): string {
  return `This wallet has no ETH on Base to pay the gas for the sweep. Send a little ETH on Base (a few cents) to ${address}, then run vapi sweep again.`;
}
