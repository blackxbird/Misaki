import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { readAuditLog } from "./audit.js";
import { __setAtomicFileTestHooks } from "./atomic-file.js";
import { withAccountMovementLock } from "./account-movement-lock.js";
import { DEFAULT_CEILING_ATOMIC, DEFAULT_SPEND_CAPS, getVapiPaths } from "./config.js";
import {
  createKeystoreFromPrivateKey,
  createKeystoreWithPhrase,
  encryptPrivateKey,
  KeystoreError,
  unlockKeystore,
} from "./keystore.js";
import {
  appendReceipt,
  filterReceiptsByWallet,
  readReceipts,
  renameReceiptWallet,
  withReceiptJournalLock,
  type Receipt,
} from "./receipts.js";
import { executeMovement } from "./movement.js";
import type { SecretStore } from "./secret-store.js";
import { readSpendLedger, readSpendLedgerRows, reserveSpend } from "./spend-policy.js";
import type { TransferArgs, TransferResult } from "./transfer.js";
import { loadOrCreateDeviceKey, lockVault, protectVault } from "./vault-key.js";
import { createVault, readVaultFileUnlocked } from "./vault.js";
import {
  assertWalletName,
  ceilingCapsJson,
  formatCeilingUsd,
  ROUTER_TOPUP_TIERS,
  spendCapsForWallet,
  VAULT_LOCKED_MESSAGE,
  walletEntrySchema,
  WalletStore,
  type AgentLink,
  type WalletStoreOptions,
} from "./wallet-store.js";

const PASSPHRASE = "correct horse battery staple";
const PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as Hex;
const LEGACY_ADDRESS = privateKeyToAccount(PRIVATE_KEY).address;
const TEST_PHRASE = "test test test test test test test test test test test junk";
const SLOW = 60_000;
const MOVEMENT_NONCE = `0x${"11".repeat(32)}`;

const temporaryDirectories: string[] = [];
const secretStores = new Map<string, SecretStore>();

afterEach(async () => {
  __setAtomicFileTestHooks(undefined);
  delete process.env.VAPI_WALLET;
  const directories = temporaryDirectories.splice(0);
  for (const directory of directories) secretStores.delete(directory);
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function memoryStore(): SecretStore {
  const entries = new Map<string, string>();
  return {
    available: true,
    platform: "darwin",
    description: "a test store",
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

async function openStore(home: string, options: WalletStoreOptions = {}): Promise<WalletStore> {
  return await WalletStore.open(home, {
    secrets: secretsFor(home),
    resolvePassphrase: async () => PASSPHRASE,
    ...options,
  });
}

async function makeHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vapi-wallet-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeUnfinishedMovement(
  home: string,
  from: string,
  to: string,
  leg: {
    status?: "planned" | "failed" | "cancelled";
    retryable?: boolean;
    restored?: true;
  } = {},
): Promise<void> {
  const directory = join(home, "movements");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "mv_walletref1.json"),
    `${JSON.stringify({
      v: 2,
      id: "mv_walletref1",
      reason: "send",
      from,
      network: "eip155:8453",
      createdAt: "2026-09-29T10:00:00.000Z",
      legs: [
        {
          from,
          to,
          amountUsd: "1.00",
          purpose: "send",
          nonce: MOVEMENT_NONCE,
          status: leg.status ?? "planned",
          ...(leg.retryable === undefined ? {} : { retryable: leg.retryable }),
          ...(leg.restored === undefined ? {} : { restored: leg.restored }),
        },
      ],
    })}\n`,
    { mode: 0o600 },
  );
}

/** A 0.2.x home: one keystore.json, one config.json, one receipts.jsonl. */
async function legacyHome(
  options: { spendCaps?: { perCallAtomic: string; perDayAtomic: string } } = {},
) {
  const home = await makeHome();
  const paths = getVapiPaths(home);
  const keystore = await encryptPrivateKey(PRIVATE_KEY, PASSPHRASE);
  await writeFile(paths.keystore, `${JSON.stringify(keystore, null, 2)}\n`, { mode: 0o600 });
  await writeFile(
    paths.config,
    `${JSON.stringify(
      {
        discoveryUrl: "https://api.vapinetwork.ai/api/call/services",
        networks: {},
        ...(options.spendCaps ? { spendCaps: options.spendCaps } : {}),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return { home, paths };
}

function receipt(id: string, wallet?: string): Receipt {
  return {
    id,
    timestamp: "2026-09-18T10:00:00.000Z",
    resourceUrl: "https://api.example.com/echo",
    ...(wallet === undefined ? {} : { wallet }),
  };
}

async function fileMode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

async function temporaryFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory);
  return entries.filter((entry) => entry.endsWith(".tmp"));
}

describe("wallet layout migration", () => {
  it(
    "moves a 0.2.x keystore v2 into the vault and retires the symlink",
    async () => {
      const { home, paths } = await legacyHome({
        spendCaps: { perCallAtomic: "250000", perDayAtomic: "2500000" },
      });

      const store = await openStore(home);

      const mainPath = join(home, "wallets.migrated", "main.json");
      expect(await fileMode(mainPath)).toBe(0o600);
      expect(await fileMode(join(home, "wallets"))).toBe(0o700);
      await expect(lstat(paths.keystore)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fileMode(join(home, "vault.json"))).toBe(0o600);
      expect(await fileMode(join(home, "wallets.json"))).toBe(0o600);

      const registry = store.snapshot();
      expect(registry.version).toBe(1);
      expect(registry.default).toBe("main");
      expect(registry.wallets.main?.spendCaps).toEqual({
        perCallAtomic: "250000",
        perDayAtomic: "2500000",
      });
      expect(Date.parse(registry.wallets.main!.createdAt)).toBeGreaterThan(0);

      // The keystore contents were moved, never rewritten.
      const moved: unknown = JSON.parse(await readFile(mainPath, "utf8"));
      expect(Reflect.get(moved as object, "version")).toBe(2);
      expect(Reflect.get(moved as object, "address")).toBe(LEGACY_ADDRESS);

      expect(await readAuditLog(home)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "vault.migrate",
            wallet: "main",
            detail: LEGACY_ADDRESS,
          }),
        ]),
      );
      expect((await store.unlock("main", PASSPHRASE)).address).toBe(LEGACY_ADDRESS);
      expect((await unlockKeystore(PASSPHRASE, store.resolve({ name: "main" }).path)).address).toBe(
        LEGACY_ADDRESS,
      );
      expect(await temporaryFiles(home)).toEqual([]);
    },
    SLOW,
  );

  it(
    "keeps the Solana account of a keystore v3 and is idempotent",
    async () => {
      const home = await makeHome();
      const paths = getVapiPaths(home);
      const created = await createKeystoreWithPhrase(PASSPHRASE, paths.keystore, {
        enableSolana: true,
      });

      const first = await openStore(home);
      const migration = await first.migrateLegacyLayout();
      const store = await openStore(home);

      expect(migration.moved).toBe(false);
      const [main] = await store.list();
      expect(main).toMatchObject({
        name: "main",
        isDefault: true,
        address: created.account.address,
        solanaAddress: created.account.solana?.address,
        keystoreVersion: 3,
        spendCaps: { ...DEFAULT_SPEND_CAPS },
      });
      await expect(lstat(paths.keystore)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(join(home, "wallets.migrated"))).toEqual(["main.json"]);
      const compatibilityPath = join(home, "wallets", "main.json");
      expect((await lstat(compatibilityPath)).isSymbolicLink()).toBe(true);
      expect(await readlink(compatibilityPath)).toBe(join("..", "wallets.migrated", "main.json"));
      expect((await unlockKeystore(PASSPHRASE, compatibilityPath)).solana?.address).toBe(
        created.account.solana?.address,
      );
    },
    SLOW,
  );

  it(
    "does nothing when keystore.json is already a symlink or absent",
    async () => {
      const empty = await makeHome();
      expect((await openStore(empty)).snapshot()).toEqual({ version: 1, wallets: {} });
      expect(await readdir(empty)).toEqual([]);

      const home = await makeHome();
      const paths = getVapiPaths(home);
      const store = await openStore(home);
      const created = await store.create("main", PASSPHRASE);
      await symlink(join("wallets", "main.json"), paths.keystore);

      expect((await openStore(home)).snapshot().wallets.main?.createdAt).toBe(
        created.entry.createdAt,
      );
      expect((await lstat(paths.keystore)).isSymbolicLink()).toBe(true);
    },
    SLOW,
  );

  it(
    "treats legacy receipts without a wallet as main",
    async () => {
      const { home, paths } = await legacyHome();
      await appendReceipt(receipt("legacy-1"), paths.receipts);
      await appendReceipt(receipt("agent-1", "agent"), paths.receipts);

      await openStore(home);

      const rows = await readReceipts(paths.receipts);
      expect(filterReceiptsByWallet(rows, "main").map((row) => row.id)).toEqual(["legacy-1"]);
      expect(
        (await readReceipts(paths.receipts, { wallet: "agent" })).map((row) => row.id),
      ).toEqual(["agent-1"]);
    },
    SLOW,
  );

  it(
    "migrates a 0.5 keystore into the vault on first use",
    async () => {
      const home = await makeHome();
      const source = join(home, "wallets", "main.json");
      const spendCaps = { perCallAtomic: "123", perDayAtomic: "456" };
      const routerRefill = { belowUsd: 2.5, tierUsd: 5 as const };
      await createKeystoreFromPrivateKey(PASSPHRASE, source, { privateKey: PRIVATE_KEY });
      await writeFile(
        join(home, "wallets.json"),
        `${JSON.stringify({
          version: 1,
          default: "main",
          wallets: {
            main: {
              createdAt: "2026-09-28T12:00:00.000Z",
              spendCaps,
              routerRefill,
            },
          },
        })}\n`,
        { mode: 0o600 },
      );

      const passphrases = new Map([["main", PASSPHRASE]]);
      const store = await openStore(home, {
        resolvePassphrase: async (name) => passphrases.get(name),
      });

      expect(await store.list()).toEqual([
        expect.objectContaining({ name: "main", address: LEGACY_ADDRESS, spendCaps }),
      ]);
      expect(store.entry("main")).toMatchObject({ spendCaps, routerRefill });
      expect((await store.unlock("main", "anything")).address).toBe(LEGACY_ADDRESS);
      await expect(stat(join(home, "wallets.migrated", "main.json"))).resolves.toBeDefined();
      expect((await lstat(source)).isSymbolicLink()).toBe(true);
    },
    SLOW,
  );

  it(
    "leaves a keystore whose passphrase is unknown in place and migrates it when unlock receives the passphrase",
    async () => {
      const home = await makeHome();
      const source = join(home, "wallets", "agent.json");
      await createKeystoreFromPrivateKey(PASSPHRASE, source, { privateKey: PRIVATE_KEY });
      await writeFile(
        join(home, "wallets.json"),
        `${JSON.stringify({
          version: 1,
          default: "agent",
          wallets: {
            agent: {
              createdAt: "2026-09-28T12:00:00.000Z",
              spendCaps: DEFAULT_SPEND_CAPS,
            },
          },
        })}\n`,
        { mode: 0o600 },
      );

      const store = await openStore(home, { resolvePassphrase: async () => undefined });

      await expect(stat(source)).resolves.toBeDefined();
      expect(await store.list()).toEqual([
        expect.objectContaining({ name: "agent", address: LEGACY_ADDRESS }),
      ]);
      await expect(store.unlock("agent", "wrong")).rejects.toThrow(KeystoreError);
      expect((await store.unlock("agent", PASSPHRASE)).address).toBe(LEGACY_ADDRESS);
      expect((await lstat(source)).isSymbolicLink()).toBe(true);
      await expect(stat(join(home, "wallets.migrated", "agent.json"))).resolves.toBeDefined();
      expect((await readVaultFileUnlocked(join(home, "vault.json"))).accounts).toEqual([
        expect.objectContaining({ name: "agent", address: LEGACY_ADDRESS }),
      ]);
    },
    SLOW,
  );

  it(
    "runs the migration only once",
    async () => {
      const home = await makeHome();
      const source = join(home, "wallets", "main.json");
      await createKeystoreFromPrivateKey(PASSPHRASE, source, { privateKey: PRIVATE_KEY });
      await writeFile(
        join(home, "wallets.json"),
        `${JSON.stringify({
          version: 1,
          default: "main",
          wallets: {
            main: {
              createdAt: "2026-09-28T12:00:00.000Z",
              spendCaps: DEFAULT_SPEND_CAPS,
            },
          },
        })}\n`,
        { mode: 0o600 },
      );
      const options = { resolvePassphrase: async () => PASSPHRASE };

      await openStore(home, options);
      await openStore(home, options);

      expect(
        (await readAuditLog(home)).filter((entry) => entry.event === "vault.migrate"),
      ).toHaveLength(1);
      expect(await readdir(join(home, "wallets.migrated"))).toEqual(["main.json"]);
    },
    SLOW,
  );
});

describe("wallet names", () => {
  it("accepts names that are safe as file names and rejects the rest", () => {
    expect(assertWalletName("main")).toBe("main");
    expect(assertWalletName("agent-claude-2")).toBe("agent-claude-2");
    expect(assertWalletName("a".repeat(32))).toHaveLength(32);

    for (const invalid of [".", "..", "a/b", "a\\b", "../escape", "wallets/main"]) {
      expect(() => assertWalletName(invalid)).toThrow(KeystoreError);
      expect(() => assertWalletName(invalid)).toThrow(/wallet name/i);
    }
    for (const invalid of ["", "Main", "-main", "main_2", "main.json", "a".repeat(33), "café"]) {
      expect(() => assertWalletName(invalid)).toThrow(KeystoreError);
    }
  });
});

describe("wallet selection", () => {
  it(
    "prefers an explicit name, then VAPI_WALLET, then the default",
    async () => {
      const home = await makeHome();
      const store = await openStore(home);
      await store.create("main", PASSPHRASE);
      await store.create("agent", PASSPHRASE);

      expect(store.resolve().name).toBe("main");
      process.env.VAPI_WALLET = "agent";
      expect(store.resolve().name).toBe("agent");
      expect(store.resolve({ name: "main" }).name).toBe("main");
      delete process.env.VAPI_WALLET;
      expect(store.resolve({ env: { VAPI_WALLET: "agent" } }).name).toBe("agent");
      expect(store.resolve().path).toBe(join(home, "wallets", "main.json"));
    },
    SLOW,
  );

  it(
    "names the wallets that do exist when one does not",
    async () => {
      const home = await makeHome();
      const store = await openStore(home);
      await store.create("main", PASSPHRASE);

      expect(() => store.resolve({ name: "agent" })).toThrow(/No wallet named agent.*main/s);
      expect(() => store.resolve({ name: "../escape" })).toThrow(KeystoreError);
    },
    SLOW,
  );

  it("asks for vapi init when there is no wallet at all", async () => {
    const home = await makeHome();
    const store = await openStore(home);
    expect(() => store.resolve()).toThrow("No wallet yet. Run vapi init.");
    expect(() => store.resolve({ name: "main" })).toThrow("No wallet yet. Run vapi init.");
  });
});

describe("wallet store", () => {
  it("refreshes the registry without zeroing a vault key a signer may still hold", async () => {
    const home = await makeHome();
    const server = await openStore(home);
    await server.create("main", "");
    await server.unlock("main", "");
    const heldKey = (server as unknown as { vaultKey?: Uint8Array }).vaultKey;
    expect(heldKey?.some((byte) => byte !== 0)).toBe(true);

    const terminal = await openStore(home);
    await terminal.create("fresh", "");
    await server.refreshRegistry();

    expect(server.has("fresh")).toBe(true);
    expect(heldKey?.some((byte) => byte !== 0)).toBe(true);
    const fresh = await server.unlock("fresh", "");
    const main = await server.unlock("main", "");
    expect(fresh.address).not.toBe(main.address);
  });

  it("reports only accounts stored in the vault", async () => {
    const home = await makeHome();
    const store = await openStore(home);
    await store.create("vaulted", PASSPHRASE, { phrase: TEST_PHRASE });
    await createKeystoreFromPrivateKey(PASSPHRASE, store.pathFor("legacy"), {
      privateKey: PRIVATE_KEY,
    });

    await expect(store.hasVaultAccount("vaulted")).resolves.toBe(true);
    await expect(store.hasVaultAccount("legacy")).resolves.toBe(false);
    await expect(store.hasVaultAccount("unknown")).resolves.toBe(false);
  });

  it("persists and clears Router refill settings while legacy entries still parse", async () => {
    const home = await makeHome();
    const legacyEntry = walletEntrySchema.parse({
      createdAt: "2026-09-19T12:00:00.000Z",
      spendCaps: { ...DEFAULT_SPEND_CAPS },
    });
    expect(legacyEntry).not.toHaveProperty("routerRefill");
    expect(ROUTER_TOPUP_TIERS).toEqual([1, 5, 20, 50]);

    await writeFile(
      join(home, "wallets.json"),
      `${JSON.stringify(
        { version: 1, default: "main", wallets: { main: legacyEntry } },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    const store = await openStore(home);

    await expect(
      store.setRouterRefill("main", { belowUsd: 2.5, tierUsd: 5 }),
    ).resolves.toMatchObject({ routerRefill: { belowUsd: 2.5, tierUsd: 5 } });
    expect((await openStore(home)).entry("main")?.routerRefill).toEqual({
      belowUsd: 2.5,
      tierUsd: 5,
    });
    await expect(
      store.setRouterRefill("main", { belowUsd: 1, tierUsd: 3 as never }),
    ).rejects.toThrow();

    await expect(store.setRouterRefill("main", null)).resolves.not.toHaveProperty("routerRefill");
    expect((await openStore(home)).entry("main")).not.toHaveProperty("routerRefill");
  });

  it("parses entries without a link and persists link changes", async () => {
    const home = await makeHome();
    const entry = walletEntrySchema.parse({
      createdAt: "2026-09-19T12:00:00.000Z",
      spendCaps: { ...DEFAULT_SPEND_CAPS },
    });
    expect(entry).not.toHaveProperty("link");
    await writeFile(
      join(home, "wallets.json"),
      `${JSON.stringify({ version: 1, default: "main", wallets: { main: entry } }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const store = await openStore(home);
    const link: AgentLink = {
      apiBase: "https://api.vapinetwork.ai",
      clientId: "agent_0xabc",
      owner: "0x1234",
      label: "researcher",
      scopes: ["mcp:call", "router.use"],
      linkedAt: "2026-09-23T10:00:00.000Z",
      routerBaseUrl: "https://router.vapinetwork.ai",
    };

    expect((await store.setLink("main", link)).link).toEqual(link);
    expect((await openStore(home)).entry("main")?.link).toEqual(link);

    expect((await store.clearLink("main")).link).toBeUndefined();
    expect((await openStore(home)).entry("main")).not.toHaveProperty("link");
  });

  it("preserves concurrent link updates made by different store instances", async () => {
    const home = await makeHome();
    const entry = {
      createdAt: "2026-09-19T12:00:00.000Z",
      spendCaps: { ...DEFAULT_SPEND_CAPS },
    };
    await writeFile(
      join(home, "wallets.json"),
      `${JSON.stringify(
        { version: 1, default: "alpha", wallets: { alpha: entry, beta: entry } },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    const first = await openStore(home);
    const second = await openStore(home);
    const link = (owner: `0x${string}`): AgentLink => ({
      apiBase: "https://api.vapinetwork.ai",
      clientId: `agent_${owner}`,
      owner,
      label: owner,
      scopes: ["mcp:call"],
      linkedAt: "2026-09-23T10:00:00.000Z",
    });

    await Promise.all([
      first.setLink("alpha", link("0x1111111111111111111111111111111111111111")),
      second.setLink("beta", link("0x2222222222222222222222222222222222222222")),
    ]);

    const reopened = await openStore(home);
    expect(reopened.entry("alpha")?.link?.owner).toBe("0x1111111111111111111111111111111111111111");
    expect(reopened.entry("beta")?.link?.owner).toBe("0x2222222222222222222222222222222222222222");
  });

  it("setSpendCaps rejects an unknown account and writes nothing", async () => {
    const home = await makeHome();
    const store = await openStore(home);
    await store.create("main", PASSPHRASE, { phrase: TEST_PHRASE });
    const registryPath = join(home, "wallets.json");
    const before = await readFile(registryPath);
    const beforeMtime = (await stat(registryPath)).mtimeMs;

    await expect(
      store.setSpendCaps("ghost", { perCallAtomic: "1000", perDayAtomic: "2000" }),
    ).rejects.toBeInstanceOf(KeystoreError);

    expect(await readFile(registryPath)).toEqual(before);
    expect((await stat(registryPath)).mtimeMs).toBe(beforeMtime);
  });

  it("reads an absent ceiling as 5 USDC without rewriting and stores off as null", async () => {
    const home = await makeHome();
    const registryPath = join(home, "wallets.json");
    const registry = {
      version: 1,
      default: "main",
      wallets: {
        main: {
          createdAt: "2026-09-19T12:00:00.000Z",
          spendCaps: { perCallAtomic: "100000", perDayAtomic: "2000000" },
        },
      },
    };
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
    const before = await readFile(registryPath, "utf8");

    const store = await openStore(home);
    expect(store.ceilingCaps("main")).toEqual({
      ceilingAtomic: DEFAULT_CEILING_ATOMIC,
      effectiveCeilingAtomic: DEFAULT_CEILING_ATOMIC,
    });
    expect(ceilingCapsJson(store.ceilingCaps("main"))).toEqual({ ceilingUsd: "5" });
    expect(formatCeilingUsd(5_250_000n)).toBe("5.25");
    expect(await readFile(registryPath, "utf8")).toBe(before);

    await expect(
      store.updateCeiling("main", (current) => {
        expect(current).toBe(DEFAULT_CEILING_ATOMIC);
        return 4_000_000n;
      }),
    ).resolves.toMatchObject({ ceilingAtomic: "4000000" });
    expect(store.ceilingCaps("main")).toEqual({
      ceilingAtomic: 4_000_000n,
      effectiveCeilingAtomic: 4_000_000n,
    });

    await expect(store.setCeiling("main", null)).resolves.toMatchObject({
      ceilingAtomic: null,
    });
    expect(store.ceilingCaps("main")).toEqual({
      ceilingAtomic: null,
      effectiveCeilingAtomic: null,
    });
    expect(ceilingCapsJson(store.ceilingCaps("main"))).toEqual({ ceilingUsd: "off" });
    expect(JSON.parse(await readFile(registryPath, "utf8"))).toMatchObject({
      wallets: { main: { ceilingAtomic: null } },
    });
  });

  it(
    "creates, imports, lists, unlocks and re-labels wallets",
    async () => {
      const home = await makeHome();
      const store = await openStore(home, {
        now: () => new Date("2026-09-19T12:00:00.000Z"),
      });

      const main = await store.create("main", PASSPHRASE, { label: "Owner" });
      expect(main.recoveryPhrase.split(" ")).toHaveLength(12);
      expect(store.defaultName).toBe("main");
      expect(main.entry).toEqual({
        createdAt: "2026-09-19T12:00:00.000Z",
        label: "Owner",
        spendCaps: { ...DEFAULT_SPEND_CAPS },
        ceilingAtomic: DEFAULT_CEILING_ATOMIC.toString(),
      });

      const agent = await store.importKey("agent", PASSPHRASE, PRIVATE_KEY, {
        spendCaps: { perCallAtomic: "1000", perDayAtomic: "5000" },
      });
      expect(agent.account.address).toBe(LEGACY_ADDRESS);
      expect(store.defaultName).toBe("main");

      const researcher = await store.create("researcher", PASSPHRASE);
      expect(researcher.recoveryPhrase).toBe(main.recoveryPhrase);

      await expect(store.create("main", PASSPHRASE)).rejects.toThrow(/already exists/);
      await expect(store.importKey("agent", PASSPHRASE, PRIVATE_KEY)).rejects.toThrow(
        /already exists/,
      );

      expect(await store.readAddress("agent")).toBe(LEGACY_ADDRESS);
      expect((await store.unlock("agent", PASSPHRASE)).address).toBe(LEGACY_ADDRESS);

      expect((await store.list()).map((entry) => [entry.name, entry.isDefault])).toEqual([
        ["main", true],
        ["agent", false],
        ["researcher", false],
      ]);

      await store.setDefault("agent");
      expect(store.defaultName).toBe("agent");
      expect((await openStore(home)).defaultName).toBe("agent");

      expect(await store.setSpendCaps("agent", { perCallAtomic: "7", perDayAtomic: "9" })).toEqual({
        createdAt: "2026-09-19T12:00:00.000Z",
        spendCaps: { perCallAtomic: "7", perDayAtomic: "9" },
        ceilingAtomic: DEFAULT_CEILING_ATOMIC.toString(),
      });
      expect(await spendCapsForWallet(store, "agent")).toEqual({
        perCallAtomic: "7",
        perDayAtomic: "9",
      });
      await expect(
        store.setSpendCaps("agent", { perCallAtomic: "-1", perDayAtomic: "9" }),
      ).rejects.toThrow();

      expect((await store.setLabel("agent", "Claude")).label).toBe("Claude");
      expect((await store.setLabel("agent", undefined)).label).toBeUndefined();
      expect(store.entry("agent")?.label).toBeUndefined();

      expect(await fileMode(join(home, "wallets.json"))).toBe(0o600);
      expect(await fileMode(join(home, "vault.json"))).toBe(0o600);
      expect(await temporaryFiles(home)).toEqual([]);
      expect((await readVaultFileUnlocked(join(home, "vault.json"))).accounts).toMatchObject([
        { name: "main", kind: "derived", index: 0 },
        { name: "agent", kind: "imported", address: LEGACY_ADDRESS },
        { name: "researcher", kind: "derived", index: 1 },
      ]);
    },
    SLOW,
  );

  it(
    "refuses to sign with a protected vault that has no session",
    async () => {
      const home = await makeHome();
      const store = await openStore(home);
      const created = await store.create("main", PASSPHRASE);
      await protectVault({
        path: join(home, "vault.json"),
        secrets: secretsFor(home),
        password: "pw",
      });

      await expect(store.unlock("main", "x")).rejects.toMatchObject({
        name: "KeystoreError",
        message: VAULT_LOCKED_MESSAGE,
      });

      const locked = await openStore(home, { env: {} });
      expect(await locked.list()).toEqual([
        expect.objectContaining({ name: "main", address: created.account.address }),
      ]);
      await expect(locked.unlock("main", "x")).rejects.toMatchObject({
        name: "KeystoreError",
        message: VAULT_LOCKED_MESSAGE,
      });
      await expect(locked.create("agent", "x")).rejects.toMatchObject({
        name: "KeystoreError",
        message: VAULT_LOCKED_MESSAGE,
      });

      const unlocked = await openStore(home, { env: { VAPI_VAULT_PASSWORD: "pw" } });
      expect((await unlocked.unlock("main", "x")).address).toBe(created.account.address);
      const sessionStore = await openStore(home, { env: {} });
      expect((await sessionStore.unlock("main", "x")).address).toBe(created.account.address);
      await lockVault({ secrets: secretsFor(home) });
      await expect(sessionStore.unlock("main", "x")).rejects.toMatchObject({
        name: "KeystoreError",
        message: VAULT_LOCKED_MESSAGE,
      });
    },
    SLOW,
  );

  it(
    "refuses to reuse a cached protected-vault signer after the session expires",
    async () => {
      const home = await makeHome();
      let now = new Date("2026-09-28T12:00:00.000Z");
      const initial = await openStore(home, { now: () => now });
      const created = await initial.create("main", PASSPHRASE);
      await protectVault({
        path: join(home, "vault.json"),
        secrets: secretsFor(home),
        password: "pw",
      });
      const env: NodeJS.ProcessEnv = { VAPI_VAULT_PASSWORD: "pw" };
      const store = await openStore(home, { env, now: () => now });
      expect((await store.unlock("main", "x")).address).toBe(created.account.address);

      delete env.VAPI_VAULT_PASSWORD;
      now = new Date("2026-09-28T20:00:00.001Z");
      await expect(store.unlock("main", "x")).rejects.toMatchObject({
        name: "KeystoreError",
        message: VAULT_LOCKED_MESSAGE,
      });
    },
    SLOW,
  );

  it(
    "never writes a passphrase, phrase or private key to the audit log or the registry",
    async () => {
      const home = await makeHome();
      const source = join(home, "wallets", "migrated.json");
      await createKeystoreFromPrivateKey(PASSPHRASE, source, { privateKey: PRIVATE_KEY });
      await writeFile(
        join(home, "wallets.json"),
        `${JSON.stringify({
          version: 1,
          default: "migrated",
          wallets: {
            migrated: {
              createdAt: "2026-09-28T12:00:00.000Z",
              spendCaps: DEFAULT_SPEND_CAPS,
            },
          },
        })}\n`,
        { mode: 0o600 },
      );
      const store = await openStore(home);
      await store.create("main", PASSPHRASE, { phrase: TEST_PHRASE });
      await store.importKey("agent", PASSPHRASE, PRIVATE_KEY);

      const audit = await readFile(join(home, "audit.log"), "utf8");
      const registry = await readFile(join(home, "wallets.json"), "utf8");
      for (const contents of [audit, registry]) {
        expect(contents).not.toContain(PRIVATE_KEY.slice(2));
        expect(contents).not.toContain(PASSPHRASE);
        expect(contents).not.toMatch(/\b(?:[a-z]+ ){11}[a-z]+\b/u);
      }
      expect(audit).toContain(LEGACY_ADDRESS);
    },
    SLOW,
  );

  it(
    "registers a vault account the registry does not know",
    async () => {
      const home = await makeHome();
      const key = await loadOrCreateDeviceKey({ secrets: secretsFor(home) });
      const vault = await createVault({ path: join(home, "vault.json"), key });
      const ghost = await vault.deriveAccount("ghost");

      const store = await openStore(home);

      expect(store.names()).toContain("ghost");
      expect(store.entry("ghost")?.spendCaps).toEqual({ ...DEFAULT_SPEND_CAPS });
      expect(await store.list()).toEqual([
        expect.objectContaining({ name: "ghost", address: ghost.address }),
      ]);
      key.fill(0);
    },
    SLOW,
  );

  it.each(["rename", "remove"] as const)(
    "refuses %s while a Router purchase is pending, then permits it after clearing",
    async (operation) => {
      const home = await makeHome();
      const store = await openStore(home);
      await store.create("main", PASSPHRASE);
      await store.create("agent", PASSPHRASE);
      const stale = await openStore(home);
      const pending = {
        receiptId: "account-change-guard",
        status: "prepared" as const,
        createdAt: "2026-11-07T10:00:00.000Z",
        tierUsd: 5 as const,
        link: {
          apiBase: "https://console.example",
          clientId: "client",
          owner: "0x1111111111111111111111111111111111111111" as const,
          label: "test",
          scopes: [],
          linkedAt: "2026-11-07T10:00:00.000Z",
        },
      };
      await store.setRouterPendingPurchase("agent", pending);
      const evidencePath = join(home, "router-pending", "agent.json");
      const evidence = await readFile(evidencePath, "utf8");
      const change = () =>
        operation === "rename"
          ? stale.rename("agent", "renamed-agent")
          : stale.remove("agent", { force: true });
      await expect(change()).rejects.toThrow(/Router purchase.*vapi router clear-pending/iu);
      expect(await readFile(evidencePath, "utf8")).toBe(evidence);
      const reopened = await openStore(home);
      expect(reopened.has("agent")).toBe(true);
      expect(reopened.has("renamed-agent")).toBe(false);
      expect(
        (await readVaultFileUnlocked(join(home, "vault.json"))).accounts.some(
          (entry) => entry.name === "agent",
        ),
      ).toBe(true);
      await reopened.setRouterPendingPurchase("agent", null, pending.receiptId);
      await expect(change()).resolves.toMatchObject({
        name: operation === "rename" ? "renamed-agent" : "agent",
      });
    },
  );

  it.each(["rename", "remove"] as const)(
    "waits for the Router purchase lock before deciding whether to %s",
    async (operation) => {
      const home = await makeHome();
      const store = await openStore(home);
      await store.create("main", PASSPHRASE);
      await store.create("agent", PASSPHRASE);
      const stale = await openStore(home);
      let attempted!: () => void;
      const attempting = new Promise<void>((resolve) => {
        attempted = resolve;
      });
      let changing: Promise<unknown> | undefined;
      await store.withRouterPurchaseLock("agent", async () => {
        __setAtomicFileTestHooks({
          beforeLockAttempt: (path) => {
            if (path === join(home, "router-pending", "agent.json.purchase.lock")) attempted();
          },
        });
        changing =
          operation === "rename"
            ? stale.rename("agent", "renamed-agent")
            : stale.remove("agent", { force: true });
        await attempting;
        await store.setRouterPendingPurchase("agent", {
          receiptId: "reserved-while-mutation-waits",
          status: "prepared",
          createdAt: "2026-11-07T10:00:00.000Z",
          tierUsd: 5,
          link: {
            apiBase: "https://console.example",
            clientId: "client",
            owner: "0x1111111111111111111111111111111111111111",
            label: "test",
            scopes: [],
            linkedAt: "2026-11-07T10:00:00.000Z",
          },
        });
      });
      await expect(changing).rejects.toThrow(/Router purchase.*vapi router clear-pending/iu);
      expect((await openStore(home)).entry("agent")?.routerPendingPurchase?.receiptId).toBe(
        "reserved-while-mutation-waits",
      );
    },
  );

  it(
    "renames the vault account, the registry entry and the receipts of a wallet",
    async () => {
      const home = await makeHome();
      const paths = getVapiPaths(home);
      const store = await openStore(home);
      await store.create("main", PASSPHRASE);
      const agent = await store.importKey("agent", PASSPHRASE, PRIVATE_KEY);
      await appendReceipt(receipt("legacy-1"), paths.receipts);
      await appendReceipt(receipt("agent-1"), paths.receipts, { wallet: "agent" });

      const renamed = await store.rename("agent", "agent-claude");

      expect(renamed.path).toBe(join(home, "wallets", "agent-claude.json"));
      expect(
        (await readVaultFileUnlocked(join(home, "vault.json"))).accounts
          .map((account) => account.name)
          .sort(),
      ).toEqual(["agent-claude", "main"]);
      expect(store.has("agent")).toBe(false);
      expect(store.entry("agent-claude")).toEqual(agent.entry);
      expect((await store.unlock("agent-claude", PASSPHRASE)).address).toBe(LEGACY_ADDRESS);

      const rows = await readReceipts(paths.receipts);
      expect(rows.map((row) => [row.id, row.wallet])).toEqual([
        ["legacy-1", undefined],
        ["agent-1", "agent-claude"],
      ]);
      expect(await temporaryFiles(home)).toEqual([]);

      await expect(store.rename("agent-claude", "main")).rejects.toThrow(/already exists/);
      await expect(store.rename("main", "NOPE")).rejects.toThrow(KeystoreError);
    },
    SLOW,
  );

  it(
    "rolls back an account rename when the receipt journal stays busy",
    async () => {
      const home = await makeHome();
      const store = await openStore(home);
      await store.create("main", PASSPHRASE);
      await store.create("agent", PASSPHRASE);
      const receiptsPath = getVapiPaths(home).receipts;
      await appendReceipt(receipt("agent-receipt", "agent"), receiptsPath);
      const competingStore = await openStore(home);

      await withReceiptJournalLock(receiptsPath, async () => {
        const renameAttempt = store.rename("agent", "renamed-agent");
        await new Promise((resolve) => setTimeout(resolve, 100));
        await competingStore.reload();
        const recreateAttempt = competingStore.create("agent", PASSPHRASE);

        const [renameResult, recreateResult] = await Promise.allSettled([
          renameAttempt,
          recreateAttempt,
        ]);
        expect(renameResult).toMatchObject({
          status: "rejected",
          reason: { message: expect.stringMatching(/receipt journal is busy.*retry/i) },
        });
        expect(recreateResult).toMatchObject({
          status: "rejected",
          reason: { message: expect.stringMatching(/already exists|account agent is busy/i) },
        });
      });

      expect(store.has("agent")).toBe(true);
      expect(store.has("renamed-agent")).toBe(false);
      const reopened = await openStore(home);
      expect(reopened.has("agent")).toBe(true);
      expect(reopened.has("renamed-agent")).toBe(false);
      expect((await readVaultFileUnlocked(join(home, "vault.json"))).accounts).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "agent" })]),
      );
      await expect(readReceipts(receiptsPath, { wallet: "agent" })).resolves.toMatchObject([
        { id: "agent-receipt" },
      ]);
    },
    SLOW,
  );

  it(
    "does not let rename hide an authorization published after its reference check",
    async () => {
      const home = await makeHome();
      const entries = new Map<string, string>();
      let releaseRename!: () => void;
      const renameMayContinue = new Promise<void>((resolve) => {
        releaseRename = resolve;
      });
      let renamePaused!: () => void;
      const renameReachedSecretMigration = new Promise<void>((resolve) => {
        renamePaused = resolve;
      });
      let pauseRename = false;
      const secrets: SecretStore = {
        available: true,
        platform: "darwin",
        description: "a gated test store",
        async get(name) {
          if (pauseRename && name === "vapi.agent.renamed.tokens") {
            renamePaused();
            await renameMayContinue;
          }
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
      secretStores.set(home, secrets);
      const store = await openStore(home);
      await store.create("main", PASSPHRASE);
      await store.create("sender", PASSPHRASE);
      await store.create("recipient", PASSPHRASE);
      await store.setLink("sender", {
        apiBase: "https://api.vapinetwork.ai",
        clientId: "rename-race",
        owner: "0x1111111111111111111111111111111111111111",
        label: "Owner",
        scopes: ["call"],
        linkedAt: "2026-09-29T10:00:00.000Z",
      });

      pauseRename = true;
      const renaming = store.rename("sender", "renamed", { secrets });
      await renameReachedSecretMigration;

      const transfers: TransferArgs[] = [];
      const transfer = async (args: TransferArgs): Promise<TransferResult> => {
        transfers.push(args);
        return {
          status: "unknown",
          from: args.from,
          to: "0x2222222222222222222222222222222222222222",
          toName: args.to,
          toKind: "account",
          amountUsd: String(args.amountUsd),
          amountAtomic: "1000000",
          network: "eip155:8453",
          txHash: null,
          nonce: args.nonce!,
          replayed: false,
        };
      };
      const movement = executeMovement(
        {
          reason: "distribute",
          from: "sender",
          network: "eip155:8453",
          legs: [{ to: "recipient", amountUsd: "1.00" }],
        },
        {
          home,
          store,
          secrets,
          apiBase: "https://api.vapinetwork.ai",
          transfer,
          addressReader: async (account) =>
            account === "recipient" ? "0x2222222222222222222222222222222222222222" : LEGACY_ADDRESS,
          randomId: () => "mv_rename_race1",
          randomNonce: () => `0x${"aa".repeat(32)}`,
          lockTimeoutMs: 50,
        },
      );
      await movement.catch(() => undefined);
      releaseRename();
      await renaming;

      await executeMovement(
        {
          reason: "distribute",
          from: "renamed",
          network: "eip155:8453",
          legs: [{ to: "recipient", amountUsd: "1.00" }],
        },
        {
          home,
          store,
          secrets,
          apiBase: "https://api.vapinetwork.ai",
          transfer,
          addressReader: async (account) =>
            account === "recipient" ? "0x2222222222222222222222222222222222222222" : LEGACY_ADDRESS,
          randomId: () => "mv_rename_race2",
          randomNonce: () => `0x${"bb".repeat(32)}`,
          lockTimeoutMs: 50,
        },
      );

      expect(transfers).toHaveLength(1);
    },
    SLOW,
  );

  it(
    "holds source, target, and removed account names behind movement locks",
    async () => {
      const home = await makeHome();
      const store = await openStore(home);
      await store.create("main", PASSPHRASE);
      await store.create("source", PASSPHRASE);

      let releaseTarget!: () => void;
      const targetGate = new Promise<void>((resolve) => {
        releaseTarget = resolve;
      });
      let targetLocked!: () => void;
      const targetReady = new Promise<void>((resolve) => {
        targetLocked = resolve;
      });
      const targetLock = withAccountMovementLock(home, "renamed", undefined, async () => {
        targetLocked();
        await targetGate;
      });
      await targetReady;
      const renaming = store.rename("source", "renamed");
      await expect(
        Promise.race([
          renaming.then(() => "finished"),
          new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 50)),
        ]),
      ).resolves.toBe("waiting");
      releaseTarget();
      await targetLock;
      await expect(renaming).resolves.toMatchObject({ name: "renamed" });

      let releaseRemoved!: () => void;
      const removedGate = new Promise<void>((resolve) => {
        releaseRemoved = resolve;
      });
      let removedLocked!: () => void;
      const removedReady = new Promise<void>((resolve) => {
        removedLocked = resolve;
      });
      const removedLock = withAccountMovementLock(home, "renamed", undefined, async () => {
        removedLocked();
        await removedGate;
      });
      await removedReady;
      const removing = store.remove("renamed", { force: true });
      await expect(
        Promise.race([
          removing.then(() => "finished"),
          new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 50)),
        ]),
      ).resolves.toBe("waiting");
      releaseRemoved();
      await removedLock;
      await expect(removing).resolves.toMatchObject({ name: "renamed" });

      await store.create("busy", PASSPHRASE);
      await withAccountMovementLock(home, "busy", undefined, async () => {
        await expect(store.remove("busy", { force: true })).rejects.toThrow(
          "Account busy is busy with another capital movement. Wait for it to finish, then retry vapi accounts remove busy.",
        );
      });
      expect(store.has("busy")).toBe(true);
    },
    SLOW,
  );

  it(
    "renames a migrated 0.2.x wallet inside the vault",
    async () => {
      const { home, paths } = await legacyHome();
      const store = await openStore(home);

      await store.rename("main", "owner");

      expect((await store.unlock("owner", PASSPHRASE)).address).toBe(LEGACY_ADDRESS);
      await expect(lstat(paths.keystore)).rejects.toMatchObject({ code: "ENOENT" });
    },
    SLOW,
  );

  it(
    "refuses to remove the default wallet or a funded one, and restores from the trash",
    async () => {
      const home = await makeHome();
      const store = await openStore(home);
      await store.create("main", PASSPHRASE);
      await store.importKey("agent", PASSPHRASE, PRIVATE_KEY, { label: "Claude" });
      const entry = store.entry("agent");

      await expect(store.remove("main")).rejects.toThrow(/default wallet/);
      await expect(
        store.remove("agent", { balanceReader: async () => 2_500_000n }),
      ).rejects.toThrow(/still holds 2500000 atomic USDC/);
      expect(store.has("agent")).toBe(true);

      const removed = await store.remove("agent", {
        force: true,
        balanceReader: async () => 2_500_000n,
      });

      expect(store.has("agent")).toBe(false);
      expect(removed.path.startsWith(join(home, "wallets", ".trash"))).toBe(true);
      expect(await fileMode(removed.path)).toBe(0o600);
      expect(
        (await readVaultFileUnlocked(join(home, "vault.json"))).accounts.map(
          (account) => account.name,
        ),
      ).toEqual(["main"]);
      expect((await readdir(join(home, "wallets", ".trash"))).sort()).toEqual(
        [`agent-${removed.removedAt}.json`, `agent-${removed.removedAt}.entry.json`].sort(),
      );
      expect((await store.listTrash()).map((item) => item.name)).toEqual(["agent"]);
      await expect(store.unlock("agent", PASSPHRASE)).rejects.toThrow(/No wallet named agent/);

      const restored = await store.restore("agent");

      expect(restored.entry).toEqual(entry);
      expect((await store.unlock("agent", PASSPHRASE)).address).toBe(LEGACY_ADDRESS);
      expect(await store.listTrash()).toEqual([]);
      await expect(store.restore("agent")).rejects.toThrow(/already exists/);
      await expect(store.restore("ghost")).rejects.toThrow(/No removed wallet named ghost/);

      const unfunded = await store.remove("agent", { balanceReader: async () => 0n });
      expect(unfunded.entry).toEqual(entry);
      expect(await temporaryFiles(join(home, "wallets", ".trash"))).toEqual([]);
    },
    SLOW,
  );

  it(
    "refuses removal while a swarm or unfinished movement references the account",
    async () => {
      const home = await makeHome();
      const store = await openStore(home);
      await store.create("main", PASSPHRASE);
      await store.create("swarm-account", PASSPHRASE);
      await store.create("movement-account", PASSPHRASE);
      await mkdir(join(home, "swarms"), { recursive: true });
      await writeFile(
        join(home, "swarms", "team.json"),
        `${JSON.stringify({
          name: "team",
          treasury: { account: "main" },
          members: [{ account: "swarm-account" }],
        })}\n`,
      );
      await writeUnfinishedMovement(home, "movement-account", "recipient");

      await expect(store.remove("swarm-account", { force: true })).rejects.toThrow(
        /swarm-account.*swarm team/i,
      );
      await expect(store.remove("movement-account", { force: true })).rejects.toThrow(
        /movement-account.*unfinished movement mv_walletref1/i,
      );
      expect(store.has("swarm-account")).toBe(true);
      expect(store.has("movement-account")).toBe(true);
    },
    SLOW,
  );

  it(
    "refuses renaming to a name reserved by a swarm or unfinished movement",
    async () => {
      const home = await makeHome();
      const store = await openStore(home);
      await store.create("main", PASSPHRASE);
      await store.create("swarm-source", PASSPHRASE);
      await store.create("movement-source", PASSPHRASE);
      await mkdir(join(home, "swarms"), { recursive: true });
      await writeFile(
        join(home, "swarms", "team.json"),
        `${JSON.stringify({
          name: "team",
          treasury: { account: "main" },
          members: [{ account: "reserved-swarm" }],
        })}\n`,
      );
      await writeUnfinishedMovement(home, "main", "reserved-movement");

      await expect(store.rename("swarm-source", "reserved-swarm")).rejects.toThrow(
        /reserved-swarm.*swarm team/i,
      );
      await expect(store.rename("movement-source", "reserved-movement")).rejects.toThrow(
        /reserved-movement.*unfinished movement mv_walletref1/i,
      );
      expect(store.has("swarm-source")).toBe(true);
      expect(store.has("movement-source")).toBe(true);
    },
    SLOW,
  );

  it(
    "allows remove and rename for a terminal unsigned failed leg",
    async () => {
      const home = await makeHome();
      const store = await openStore(home);
      await store.create("main", PASSPHRASE);
      await store.create("remove-sender", PASSPHRASE);
      await store.create("rename-recipient", PASSPHRASE);
      await store.create("rename-sender", PASSPHRASE);
      await store.create("remove-recipient", PASSPHRASE);
      await writeUnfinishedMovement(home, "remove-sender", "rename-recipient", {
        status: "failed",
        retryable: false,
      });

      await store.remove("remove-sender", { force: true });
      await store.rename("rename-recipient", "renamed-recipient");

      await writeUnfinishedMovement(home, "rename-sender", "remove-recipient", {
        status: "failed",
        retryable: false,
      });
      await store.rename("rename-sender", "renamed-sender");
      await store.remove("remove-recipient", { force: true });

      expect(store.has("remove-sender")).toBe(false);
      expect(store.has("renamed-recipient")).toBe(true);
      expect(store.has("renamed-sender")).toBe(true);
      expect(store.has("remove-recipient")).toBe(false);
    },
    SLOW,
  );

  it(
    "refuses remove and rename for a failed leg with a signed journal entry",
    async () => {
      const home = await makeHome();
      const store = await openStore(home);
      await store.create("main", PASSPHRASE);
      const sender = await store.create("signed-sender", PASSPHRASE);
      const recipient = await store.create("signed-recipient", PASSPHRASE);
      await writeUnfinishedMovement(home, "signed-sender", "signed-recipient", {
        status: "failed",
        retryable: false,
      });
      await appendReceipt(
        {
          id: "wallet-store-signed-transfer",
          timestamp: "2026-09-29T10:00:01.000Z",
          kind: "transfer",
          wallet: "signed-sender",
          resourceUrl: "https://api.vapinetwork.ai/api/accounts/transfer",
          payer: sender.account.address,
          transfer: {
            to: recipient.account.address,
            toName: "signed-recipient",
            toKind: "account",
            amountAtomic: "1000000",
            network: "eip155:8453",
            nonce: MOVEMENT_NONCE,
            status: "failed",
            txHash: null,
            replayed: false,
            request: {
              authorization: {
                from: sender.account.address,
                to: recipient.account.address,
                value: "1000000",
                validAfter: "0",
                validBefore: "1790697600",
                nonce: MOVEMENT_NONCE,
              },
              signature: "0x12",
            },
          },
        },
        getVapiPaths(home).receipts,
      );

      await expect(store.remove("signed-sender", { force: true })).rejects.toThrow(
        /signed-sender.*unfinished movement mv_walletref1/i,
      );
      await expect(store.rename("signed-recipient", "renamed-recipient")).rejects.toThrow(
        /signed-recipient.*unfinished movement mv_walletref1/i,
      );
      expect(store.has("signed-sender")).toBe(true);
      expect(store.has("signed-recipient")).toBe(true);
    },
    SLOW,
  );

  it(
    "refuses remove and rename for both accounts in a restored nonretryable failed leg",
    async () => {
      const home = await makeHome();
      const store = await openStore(home);
      await store.create("main", PASSPHRASE);
      await store.create("restored-sender", PASSPHRASE);
      await store.create("restored-recipient", PASSPHRASE);
      await writeUnfinishedMovement(home, "restored-sender", "restored-recipient", {
        status: "failed",
        retryable: false,
        restored: true,
      });

      for (const change of [
        () => store.remove("restored-sender", { force: true }),
        () => store.rename("restored-sender", "renamed-sender"),
        () => store.remove("restored-recipient", { force: true }),
        () => store.rename("restored-recipient", "renamed-recipient"),
      ]) {
        await expect(change()).rejects.toThrow(/unfinished movement mv_walletref1/i);
      }
    },
    SLOW,
  );

  it.each(["remove", "rename"] as const)(
    "refuses to %s a completed sender while another sender keeps the movement unfinished",
    async (operation) => {
      const home = await makeHome();
      const store = await openStore(home);
      await store.create("main", PASSPHRASE);
      await store.create("coordinator", PASSPHRASE);
      await store.create("alpha", PASSPHRASE);
      await store.create("bravo", PASSPHRASE);
      const directory = join(home, "movements");
      const movementPath = join(directory, "mv_multisender.json");
      await mkdir(directory, { recursive: true });
      const movement = {
        v: 2,
        id: "mv_multisender",
        reason: "rebalance",
        from: "coordinator",
        network: "eip155:8453",
        createdAt: "2026-09-29T10:00:00.000Z",
        legs: [
          {
            from: "alpha",
            to: "recipient-a",
            amountUsd: "1.00",
            purpose: "send",
            nonce: `0x${"22".repeat(32)}`,
            status: "sent",
          },
          {
            from: "bravo",
            to: "recipient-b",
            amountUsd: "1.00",
            purpose: "send",
            nonce: `0x${"33".repeat(32)}`,
            status: "planned",
          },
        ],
      };
      await writeFile(movementPath, `${JSON.stringify(movement, null, 2)}\n`, { mode: 0o600 });

      const changeAlpha = async () => {
        if (operation === "remove") return await store.remove("alpha", { force: true });
        return await store.rename("alpha", "renamed-alpha");
      };
      await expect(changeAlpha()).rejects.toThrow(/alpha.*unfinished movement mv_multisender/i);
      await expect(store.rename("coordinator", "renamed-coordinator")).rejects.toThrow(
        /coordinator.*unfinished movement mv_multisender/i,
      );

      movement.legs[1]!.status = "sent";
      await writeFile(movementPath, `${JSON.stringify(movement, null, 2)}\n`, { mode: 0o600 });
      await expect(changeAlpha()).resolves.toBeDefined();
      await expect(store.rename("coordinator", "renamed-coordinator")).resolves.toBeDefined();
    },
    SLOW,
  );

  it.each(["remove", "rename"] as const)(
    "allows %s for a replacement account after its leg is cancelled",
    async (operation) => {
      const home = await makeHome();
      const store = await openStore(home);
      await store.create("main", PASSPHRASE);
      await store.create("sender", PASSPHRASE);
      await store.create("replacement", PASSPHRASE);
      await writeUnfinishedMovement(home, "sender", "replacement", { status: "cancelled" });

      if (operation === "remove") {
        await expect(store.remove("replacement", { force: true })).resolves.toBeDefined();
        expect(store.has("replacement")).toBe(false);
      } else {
        await expect(store.rename("replacement", "renamed-replacement")).resolves.toBeDefined();
        expect(store.has("renamed-replacement")).toBe(true);
      }
    },
    SLOW,
  );

  it(
    "refuses remove and rename while a retryable failed legacy leg references the names",
    async () => {
      const home = await makeHome();
      const store = await openStore(home);
      await store.create("main", PASSPHRASE);
      await store.create("sender", PASSPHRASE);
      await store.create("recipient", PASSPHRASE);
      await store.create("spare", PASSPHRASE);
      await writeUnfinishedMovement(home, "sender", "recipient", {
        status: "failed",
        retryable: true,
      });

      await expect(store.remove("recipient", { force: true })).rejects.toThrow(
        /recipient.*unfinished movement mv_walletref1/i,
      );
      await expect(store.rename("sender", "renamed-sender")).rejects.toThrow(
        /sender.*unfinished movement mv_walletref1/i,
      );
      await writeUnfinishedMovement(home, "sender", "retired-recipient", {
        status: "failed",
        retryable: true,
      });
      await expect(store.rename("spare", "retired-recipient")).rejects.toThrow(
        /retired-recipient.*unfinished movement mv_walletref1/i,
      );
      expect(store.has("recipient")).toBe(true);
      expect(store.has("sender")).toBe(true);
      expect(store.has("spare")).toBe(true);
    },
    SLOW,
  );

  it(
    "keeps a vault account when writing its trash backup fails",
    async () => {
      const home = await makeHome();
      const now = new Date("2026-09-28T12:00:00.000Z");
      const store = await openStore(home, { now: () => now });
      await store.create("main", PASSPHRASE);
      await store.importKey("agent", PASSPHRASE, PRIVATE_KEY);
      const blockedPath = join(home, "wallets", ".trash", `agent-${now.toISOString()}.json`);
      await mkdir(blockedPath, { recursive: true });

      await expect(store.remove("agent", { force: true })).rejects.toBeDefined();

      expect(store.has("agent")).toBe(true);
      expect((await store.unlock("agent", PASSPHRASE)).address).toBe(LEGACY_ADDRESS);
      expect(
        (await readVaultFileUnlocked(join(home, "vault.json"))).accounts.map(
          (account) => account.name,
        ),
      ).toEqual(["main", "agent"]);
    },
    SLOW,
  );

  it(
    "does not reuse a removed derivation index before restoring the account",
    async () => {
      const home = await makeHome();
      const store = await openStore(home);
      await store.create("main", PASSPHRASE);
      const agent = await store.create("agent", PASSPHRASE);
      const vaultPath = join(home, "vault.json");
      const legacyVault = JSON.parse(await readFile(vaultPath, "utf8")) as Record<string, unknown>;
      delete legacyVault.nextDerivedIndex;
      await writeFile(vaultPath, `${JSON.stringify(legacyVault, null, 2)}\n`, { mode: 0o600 });

      await store.remove("agent", { force: true });
      await store.create("other", PASSPHRASE);
      await expect(store.restore("agent")).resolves.toMatchObject({ name: "agent" });

      expect((await store.unlock("agent", PASSPHRASE)).address).toBe(agent.account.address);
      expect((await readVaultFileUnlocked(vaultPath)).accounts).toEqual([
        expect.objectContaining({ name: "main", kind: "derived", index: 0 }),
        expect.objectContaining({ name: "other", kind: "derived", index: 2 }),
        expect.objectContaining({ name: "agent", kind: "derived", index: 1 }),
      ]);
    },
    SLOW,
  );

  it(
    "falls back to the legacy config caps when a home has no registry",
    async () => {
      const { home } = await legacyHome({
        spendCaps: { perCallAtomic: "11", perDayAtomic: "22" },
      });
      const opened = await openStore(home);
      expect(await spendCapsForWallet(opened, "main")).toEqual({
        perCallAtomic: "11",
        perDayAtomic: "22",
      });
      expect(await spendCapsForWallet(opened, "unknown")).toEqual({
        perCallAtomic: "11",
        perDayAtomic: "22",
      });
      const emptyHome = await makeHome();
      expect(await spendCapsForWallet(await openStore(emptyHome))).toEqual({
        ...DEFAULT_SPEND_CAPS,
      });
    },
    SLOW,
  );
});

describe("per-wallet spend ledger", () => {
  it("keeps each wallet's daily total apart and counts legacy rows as main", async () => {
    const home = await makeHome();
    const ledgerPath = getVapiPaths(home).ledger;
    const caps = { perCallAtomic: "10", perDayAtomic: "15" };
    const now = new Date("2026-09-19T08:00:00.000Z");

    await writeFile(ledgerPath, `${JSON.stringify({ date: "2026-09-19", spentAtomic: "10" })}\n`, {
      mode: 0o600,
    });
    expect(await readSpendLedger(ledgerPath, now)).toEqual({
      date: "2026-09-19",
      spentAtomic: "10",
    });
    expect(await readSpendLedger(ledgerPath, now, "agent")).toEqual({
      date: "2026-09-19",
      spentAtomic: "0",
    });

    // The legacy row is main's, so main is nearly out of allowance ...
    await expect(reserveSpend(10n, caps, { ledgerPath, now })).rejects.toMatchObject({
      code: "per_day_cap_exceeded",
    });
    // ... while a second wallet starts its own day at zero.
    expect(await reserveSpend(10n, caps, { ledgerPath, now, wallet: "agent" })).toEqual({
      date: "2026-09-19",
      spentAtomic: "10",
    });
    expect(await reserveSpend(5n, caps, { ledgerPath, now })).toEqual({
      date: "2026-09-19",
      spentAtomic: "15",
    });

    expect(await readSpendLedgerRows(ledgerPath, now)).toEqual([
      { date: "2026-09-19", spentAtomic: "10", wallet: "agent" },
      { date: "2026-09-19", spentAtomic: "15", wallet: "main" },
    ]);
    expect(await readSpendLedgerRows(ledgerPath, new Date("2026-09-20T08:00:00.000Z"))).toEqual([]);
    expect(await fileMode(ledgerPath)).toBe(0o600);
    expect(await temporaryFiles(home)).toEqual([]);
  });

  it("writes a single main wallet in the shape 0.2.x reads", async () => {
    const home = await makeHome();
    const ledgerPath = getVapiPaths(home).ledger;
    const now = new Date("2026-09-19T08:00:00.000Z");

    await reserveSpend(3n, { perCallAtomic: "10", perDayAtomic: "15" }, { ledgerPath, now });

    expect(JSON.parse(await readFile(ledgerPath, "utf8"))).toEqual({
      date: "2026-09-19",
      spentAtomic: "3",
    });
  });
});

describe("receipts per wallet", () => {
  it("rewrites only the rows of the renamed wallet", async () => {
    const home = await makeHome();
    const path = getVapiPaths(home).receipts;
    await appendReceipt(receipt("legacy-1"), path);
    await appendReceipt(receipt("agent-1"), path, { wallet: "agent" });
    await appendReceipt(receipt("owner-1"), path, { wallet: "owner" });
    const before = await readFile(path, "utf8");

    expect(await renameReceiptWallet("agent", "agent-claude", path)).toBe(1);

    const lines = (await readFile(path, "utf8")).split("\n");
    expect(lines[0]).toBe(before.split("\n")[0]);
    expect(lines[2]).toBe(before.split("\n")[2]);
    expect(await fileMode(path)).toBe(0o600);
    expect(await temporaryFiles(home)).toEqual([]);

    // A rename of main also claims the rows that predate named wallets.
    expect(await renameReceiptWallet("main", "owner-2", path)).toBe(1);
    expect((await readReceipts(path, { wallet: "owner-2" })).map((row) => row.id)).toEqual([
      "legacy-1",
    ]);
    expect(await renameReceiptWallet("ghost", "other", path)).toBe(0);
    expect(await renameReceiptWallet("ghost", "other", join(home, "missing.jsonl"))).toBe(0);
  });

  it("keeps the wallet a receipt already names", async () => {
    const home = await makeHome();
    const path = getVapiPaths(home).receipts;
    await appendReceipt(receipt("agent-1", "agent"), path, { wallet: "main" });
    expect((await readReceipts(path))[0]?.wallet).toBe("agent");
    await expect(appendReceipt(receipt("bad", "NOPE"), path)).rejects.toThrow();
  });
});
