import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import { AccountMovementLockedError, withAccountMovementLocks } from "./account-movement-lock.js";
import { withFileLock, writeJsonAtomic } from "./atomic-file.js";
import { appendAudit, type AuditRecord } from "./audit.js";
import {
  DEFAULT_CEILING_ATOMIC,
  DEFAULT_SPEND_CAPS,
  getVapiPaths,
  isMissingFile,
  spendCapsSchema,
  type SpendCaps,
} from "./config.js";
import { deriveEvmPrivateKey, phraseToSeed } from "./hd.js";
import { KeystoreError, unlockKeystore, type VapiPaymentAccount } from "./keystore.js";
import { isOpenMovementLeg } from "./movement-open.js";
import { PASSPHRASE_ENVIRONMENT_VARIABLE } from "./passphrase.js";
import { renameReceiptWallet } from "./receipts.js";
import { secretStore, type SecretStore } from "./secret-store.js";
import { readTransferJournal } from "./transfer-journal.js";
import { loadOrCreateDeviceKey, unlockProtectedVault } from "./vault-key.js";
import { legacyKeystoreNames, migrateKeystores, type PassphraseResolver } from "./vault-migrate.js";
import {
  createVault,
  openVault as openDeviceVault,
  readVaultFileUnlocked,
  reinstateVaultAccount,
  VaultError,
  type StoredVaultAccount,
  type StoredVaultFile,
  type Vault,
  type VaultAccount,
} from "./vault.js";
import {
  DEFAULT_WALLET_NAME,
  isWalletName,
  walletNameSchema,
  type WalletName,
} from "./wallet-name.js";

export {
  DEFAULT_WALLET_NAME,
  isWalletName,
  walletNameSchema,
  WALLET_NAME_PATTERN,
  type WalletName,
} from "./wallet-name.js";

export type AgentLink = {
  apiBase: string;
  clientId: string;
  owner: `0x${string}`;
  label: string;
  scopes: string[];
  linkedAt: string;
  routerBaseUrl?: string;
};

const agentLinkSchema: z.ZodType<AgentLink> = z.object({
  apiBase: z.string(),
  clientId: z.string(),
  owner: z.custom<`0x${string}`>((value) => typeof value === "string" && value.startsWith("0x")),
  label: z.string(),
  scopes: z.array(z.string()),
  linkedAt: z.iso.datetime(),
  routerBaseUrl: z.string().optional(),
});

export const ROUTER_TOPUP_TIERS = [1, 5, 20, 50] as const;
export type RouterTopupTier = (typeof ROUTER_TOPUP_TIERS)[number];
export type RouterRefill = { belowUsd: number; tierUsd: RouterTopupTier };

const routerRefillSchema: z.ZodType<RouterRefill> = z.object({
  belowUsd: z.number().finite().min(0),
  tierUsd: z.union([z.literal(1), z.literal(5), z.literal(20), z.literal(50)]),
});

// Public payment evidence only. Signed is journaled BEFORE invoking the signer.
// Unknown preserves legacy or non-EIP-3009 attempts that cannot be proved unpaid.
const routerPendingPurchaseSchema = z
  .strictObject({
    receiptId: z.string().min(1),
    status: z.enum(["prepared", "signed", "settled", "unknown"]),
    createdAt: z.iso.datetime(),
    tierUsd: z.union([z.literal(1), z.literal(5), z.literal(20), z.literal(50)]),
    link: agentLinkSchema,
    network: z.string().min(1).optional(),
    amountAtomic: z.string().regex(/^\d+$/u).optional(),
    transaction: z.string().optional(),
    authorization: z
      .strictObject({
        token: z.string().regex(/^0x[0-9a-fA-F]{40}$/u),
        from: z.string().regex(/^0x[0-9a-fA-F]{40}$/u),
        nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/u),
        validBefore: z.string().regex(/^\d+$/u),
      })
      .optional(),
  })
  .superRefine((pending, context) => {
    if (
      pending.status === "signed" &&
      (pending.authorization === undefined || pending.network === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Signed purchases require public authorization evidence.",
      });
    }
  });

const routerPurchaseStateSchema = z.strictObject({
  version: z.literal(1),
  pending: routerPendingPurchaseSchema.optional(),
  completedReceiptId: z.string().optional(),
});

type RouterPurchaseState = z.infer<typeof routerPurchaseStateSchema>;

export type RouterPendingPurchase = z.infer<typeof routerPendingPurchaseSchema>;

const ceilingSweepPendingSchema = z.strictObject({
  owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  target: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  amountAtomic: z.string().regex(/^\d+$/),
  nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  createdAt: z.iso.datetime(),
  status: z.enum(["planned", "unknown"]),
});

export type WalletCeilingSweepPending = z.infer<typeof ceilingSweepPendingSchema>;

/** What `wallets.json` records about one wallet. Keys live in the vault or a legacy keystore. */
export const walletEntrySchema = z.object({
  createdAt: z.iso.datetime(),
  label: z.string().trim().min(1).max(80).optional(),
  spendCaps: spendCapsSchema,
  // On disk, null explicitly disables ceiling sweeps; an absent field is the
  // backwards-compatible 5 USDC default and is not written during reads.
  ceilingAtomic: z.string().regex(/^\d+$/).nullable().optional(),
  ceilingSweepAttemptedAt: z.iso.datetime().optional(),
  ceilingSweepPending: ceilingSweepPendingSchema.optional(),
  routerRefill: routerRefillSchema.optional(),
  routerPendingPurchase: routerPendingPurchaseSchema.optional(),
  link: agentLinkSchema.optional(),
});

export const walletRegistrySchema = z.object({
  version: z.literal(1),
  default: walletNameSchema.optional(),
  wallets: z.record(walletNameSchema, walletEntrySchema),
});

export type WalletEntry = z.infer<typeof walletEntrySchema>;
export type WalletRegistry = z.infer<typeof walletRegistrySchema>;

export type WalletCeilingCaps = {
  ceilingAtomic: bigint | null;
  effectiveCeilingAtomic: bigint | null;
};

/** How a caller names the wallet it wants; every field is optional. */
export type WalletSelection = {
  /** An explicit name, from `--wallet` or an MCP argument. */
  name?: string | undefined;
  /** Environment to read `VAPI_WALLET` from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv | undefined;
};

export type ResolvedWallet = {
  name: WalletName;
  path: string;
  entry: WalletEntry;
};

export type WalletInfo = ResolvedWallet & {
  address?: string;
  solanaAddress?: string;
  keystoreVersion?: number;
  isDefault: boolean;
  spendCaps: SpendCaps;
  label?: string;
  createdAt: string;
};

export type CreatedWallet = ResolvedWallet & {
  account: VapiPaymentAccount;
  recoveryPhrase?: string;
};

export type ImportedWallet = ResolvedWallet & {
  account: VapiPaymentAccount;
};

export type TrashedWallet = {
  name: WalletName;
  removedAt: string;
  path: string;
  entry?: WalletEntry;
};

/** Reads the USDC balance of an address, so `remove` can refuse a funded wallet. */
export type WalletBalanceReader = (address: string) => Promise<bigint>;

type WalletRenameOptions = {
  secrets?: SecretStore;
  serialize?: <T>(operation: () => Promise<T>) => Promise<T>;
};

type WalletRemoveOptions = {
  force?: boolean;
  balanceReader?: WalletBalanceReader;
  allowDefault?: boolean;
};

export type WalletStoreOptions = {
  /** Injected clock, so `createdAt` is deterministic in tests. */
  now?: () => Date;
  /** OS secret store holding the device vault key and optional legacy passphrases. */
  secrets?: SecretStore;
  /** Environment used for vault and legacy-keystore passwords. */
  env?: NodeJS.ProcessEnv;
  /** Resolves a 0.5 keystore passphrase without prompting. */
  resolvePassphrase?: PassphraseResolver;
  /** Writes migration audit records. */
  audit?: (record: AuditRecord) => Promise<unknown>;
};

export type LayoutMigration = {
  moved: boolean;
  from?: string;
  to?: string;
};

const WALLETS_DIRECTORY = "wallets";
const TRASH_DIRECTORY = ".trash";
const REGISTRY_FILE = "wallets.json";
const VAULT_FILE = "vault.json";
const TRASHED_NAME_PATTERN = /^(.+)-(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\.json$/;

export const VAULT_LOCKED_MESSAGE =
  "The vault is locked. Run vapi vault unlock, or set VAPI_VAULT_PASSWORD.";

/**
 * The wallets on this machine: a vault of keys, a registry of settings, and the
 * rules for picking the wallet a command acts on.
 *
 * Layout under the config home (`~/.vapi`, or `VAPI_HOME`):
 *
 * ```
 * vault.json            encrypted device vault and named accounts
 * wallets.json          registry: default wallet, per-wallet caps and labels
 * wallets/<name>.json   0.5 keystores awaiting migration
 * wallets.migrated/     migrated 0.5 keystores, retained as encrypted backups
 * wallets/.trash/       removed accounts and their registry sidecars
 * audit.log             append-only local audit trail
 * ```
 */
export class WalletStore {
  private registry: WalletRegistry;
  private readonly secrets: SecretStore;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly passphraseResolver: PassphraseResolver;
  private readonly audit: (record: AuditRecord) => Promise<unknown>;
  private cachedVault: Vault | undefined;
  private vaultKey: Uint8Array | undefined;
  private balanceProbe: WalletBalanceReader | undefined;

  private constructor(
    /** The config home these wallets live under. */
    readonly home: string,
    private readonly options: WalletStoreOptions,
    registry: WalletRegistry,
  ) {
    this.registry = registry;
    this.secrets = options.secrets ?? secretStore();
    this.environment = options.env ?? process.env;
    this.passphraseResolver =
      options.resolvePassphrase ?? defaultPassphraseResolver(this.environment, this.secrets);
    this.audit =
      options.audit ??
      (async (record) => await appendAudit(this.home, record, { now: () => this.now() }));
  }

  /** Opens the store, migrating a 0.2.x single-keystore home on the way. */
  static async open(
    home = getVapiPaths().directory,
    options: WalletStoreOptions = {},
  ): Promise<WalletStore> {
    const store = new WalletStore(home, options, emptyRegistry());
    await store.migrateLegacyLayout();
    await store.reload();
    const storedVault = await store.readVaultUnlocked();
    if (storedVault !== undefined) {
      await store.registerMissingVaultAccounts(storedVault.accounts);
    }

    if ((await legacyKeystoreNames(home)).length > 0) {
      try {
        const opened = await store.openVault({ create: true });
        const migration = await migrateKeystores({
          home,
          vault: opened.vault,
          resolvePassphrase: store.passphraseResolver,
          audit: store.audit,
          now: () => store.now(),
        });
        if (migration.imported.length > 0) {
          const imported = new Set(migration.imported);
          await store.registerMissingVaultAccounts(
            opened.vault.accounts().filter((account) => imported.has(account.name)),
          );
        }
      } catch (error) {
        if (!isLockedVaultError(error)) throw error;
      }
    }
    return store;
  }

  get registryPath(): string {
    return join(this.home, REGISTRY_FILE);
  }

  get walletsDirectory(): string {
    return join(this.home, WALLETS_DIRECTORY);
  }

  get trashDirectory(): string {
    return join(this.walletsDirectory, TRASH_DIRECTORY);
  }

  /** The legacy 0.5 keystore path of a wallet, whether or not it exists. */
  pathFor(name: string): string {
    return join(this.walletsDirectory, `${assertWalletName(name)}.json`);
  }

  /** The names this machine knows, in registry order. */
  names(): WalletName[] {
    return Object.keys(this.registry.wallets);
  }

  /** The name a command uses when nothing selects another wallet. */
  get defaultName(): WalletName | undefined {
    return this.registry.default;
  }

  /** True once `wallets.json` exists; false for an un-migrated 0.2.x home. */
  hasRegistry(): boolean {
    return this.registry.default !== undefined || this.names().length > 0;
  }

  entry(name: string): WalletEntry | undefined {
    return isWalletName(name) ? this.registry.wallets[name] : undefined;
  }

  has(name: string): boolean {
    return this.entry(name) !== undefined;
  }

  /** True only when the device vault currently contains an account with this name. */
  async hasVaultAccount(name: string): Promise<boolean> {
    return (
      (await this.readVaultUnlocked())?.accounts.some((account) => account.name === name) ?? false
    );
  }

  /** A copy of the registry as it was last read or written. */
  snapshot(): WalletRegistry {
    return structuredClone(this.registry);
  }

  /** Re-reads `wallets.json` from disk and drops the process-local vault cache. */
  async reload(): Promise<WalletRegistry> {
    this.dropVaultCache();
    this.registry = await this.readRegistry();
    return this.snapshot();
  }

  /**
   * Re-reads `wallets.json` for a long-running process such as the MCP server.
   * Unlike `reload`, it never zeroes the cached vault key, because a payment in
   * flight may still be signing with it. When accounts were added elsewhere the
   * cached vault is forgotten, so the next unlock reads the vault file again.
   */
  async refreshRegistry(): Promise<WalletRegistry> {
    const registry = await this.readRegistry();
    const known = new Set(this.names());
    if (Object.keys(registry.wallets).some((name) => !known.has(name))) {
      this.cachedVault = undefined;
      this.vaultKey = undefined;
    }
    this.registry = registry;
    return this.snapshot();
  }

  /**
   * Picks the wallet a command acts on: an explicit name first, then
   * `VAPI_WALLET`, then the registry default.
   */
  resolve(selection: WalletSelection = {}): ResolvedWallet {
    const environment = selection.env ?? process.env;
    const requested = selection.name?.trim() || environment.VAPI_WALLET?.trim() || undefined;
    const name = requested ?? this.registry.default;
    if (name === undefined) {
      throw new KeystoreError("No wallet yet. Run vapi init.");
    }
    assertWalletName(name);
    const entry = this.registry.wallets[name];
    if (!entry) {
      throw new KeystoreError(unknownWalletMessage(name, this.names()));
    }
    return { name, path: this.pathFor(name), entry: structuredClone(entry) };
  }

  /** Every wallet with its addresses, read without a passphrase. */
  async list(): Promise<WalletInfo[]> {
    const vaultAccounts = new Map(
      (await this.readVaultUnlocked())?.accounts.map((account) => [account.name, account]) ?? [],
    );
    const infos: WalletInfo[] = [];
    for (const [name, entry] of Object.entries(this.registry.wallets)) {
      const path = this.pathFor(name);
      const vaultAccount = vaultAccounts.get(name);
      const summary = await readKeystoreSummary(path);
      infos.push({
        name,
        path,
        entry: structuredClone(entry),
        isDefault: name === this.registry.default,
        spendCaps: { ...entry.spendCaps },
        createdAt: entry.createdAt,
        ...(entry.label === undefined ? {} : { label: entry.label }),
        ...(vaultAccount === undefined
          ? summary.address === undefined
            ? {}
            : { address: summary.address }
          : { address: vaultAccount.address }),
        ...(summary.solanaAddress === undefined ? {} : { solanaAddress: summary.solanaAddress }),
        ...(summary.version === undefined ? {} : { keystoreVersion: summary.version }),
      });
    }
    return infos;
  }

  /** The stored Base address of a wallet, without its passphrase. */
  async readAddress(name: string): Promise<string | undefined> {
    const target = assertWalletName(name);
    const account = (await this.readVaultUnlocked())?.accounts.find(
      (candidate) => candidate.name === target,
    );
    return account?.address ?? (await readKeystoreSummary(this.pathFor(target))).address;
  }

  /**
   * Creates the vault without deriving an account, for apps that create every
   * account by name. Refuses when a vault already exists in this home.
   */
  async createEmptyVault(): Promise<void> {
    if ((await this.readVaultUnlocked()) !== undefined) {
      throw new KeystoreError("A vault already exists in this home.");
    }
    await this.openVault({ create: true });
    this.dropVaultCache();
  }

  /**
   * Creates a vault account from a fresh or supplied recovery phrase. The first
   * wallet on a machine also becomes the default. `passphrase` and
   * `enableSolana` are accepted and ignored for one release. Every derived
   * account returns the vault's shared phrase to preserve this method's public
   * contract; callers decide whether their current flow may display it.
   */
  async create(
    name: string,
    passphrase: string,
    options?: {
      phrase?: string;
      enableSolana?: boolean;
      label?: string;
      spendCaps?: SpendCaps;
    },
  ): Promise<CreatedWallet & { recoveryPhrase: string }>;
  async create(
    name: string,
    passphrase: string,
    options: {
      phrase?: string;
      enableSolana?: boolean;
      label?: string;
      spendCaps?: SpendCaps;
    } = {},
  ): Promise<CreatedWallet> {
    void passphrase;
    void options.enableSolana;
    const nameToCreate = assertWalletName(name);
    return await withAccountMutationLocks(
      this.home,
      [nameToCreate],
      `vapi accounts add ${nameToCreate}`,
      async () => {
        await this.reload();
        const path = await this.prepareNewWallet(nameToCreate);
        const opened = await this.openVault({
          create: true,
          ...(options.phrase === undefined ? {} : { phrase: options.phrase }),
        });
        if (opened.created || options.phrase === undefined) {
          await opened.vault.deriveAccount(nameToCreate);
        } else {
          const seed = phraseToSeed(options.phrase);
          try {
            await opened.vault.importAccount(
              nameToCreate,
              deriveEvmPrivateKey(seed, "m/44'/60'/0'/0/0"),
            );
          } finally {
            seed.fill(0);
          }
        }
        const account = await opened.vault.signer(nameToCreate);
        const recoveryPhrase = await opened.vault.phrase();
        const entry = await this.registerWallet(nameToCreate, options);
        return {
          name: nameToCreate,
          path,
          entry,
          account,
          ...(recoveryPhrase === undefined ? {} : { recoveryPhrase }),
        };
      },
    );
  }

  /** Imports a private key into the vault. `passphrase` is ignored for one release. */
  async importKey(
    name: string,
    passphrase: string,
    privateKey: string,
    options: { label?: string; spendCaps?: SpendCaps } = {},
  ): Promise<ImportedWallet> {
    void passphrase;
    const nameToImport = assertWalletName(name);
    return await withAccountMutationLocks(
      this.home,
      [nameToImport],
      `vapi accounts import ${nameToImport}`,
      async () => {
        await this.reload();
        const path = await this.prepareNewWallet(nameToImport);
        const opened = await this.openVault({ create: true });
        try {
          await opened.vault.importAccount(nameToImport, privateKey as `0x${string}`);
        } catch (error) {
          if (error instanceof VaultError && error.code === "bad_key") {
            throw new KeystoreError("The imported private key is not valid.", { cause: error });
          }
          throw error;
        }
        const account = await opened.vault.signer(nameToImport);
        const entry = await this.registerWallet(nameToImport, options);
        return { name: nameToImport, path, entry, account };
      },
    );
  }

  /** Checks a cached signer's current vault session without decrypting its account again. */
  async assertSigningAuthority(name: string): Promise<void> {
    const stored = await this.readVaultUnlocked();
    if (!stored?.protected || !stored.accounts.some((account) => account.name === name)) return;
    try {
      const key = await unlockProtectedVault({
        path: this.vaultPath,
        secrets: this.secrets,
        env: this.environment,
        now: () => this.now(),
      });
      key.fill(0);
    } catch (error) {
      this.dropVaultCache();
      if (error instanceof VaultError && error.code === "password_required") {
        throw new KeystoreError(VAULT_LOCKED_MESSAGE, { cause: error });
      }
      throw error;
    }
  }

  /** Returns one wallet's vault signer, migrating its legacy keystore if needed. */
  async unlock(name: string, passphrase: string): Promise<VapiPaymentAccount> {
    const wallet = this.resolve({ name });
    const vaultHasAccount = (await this.readVaultUnlocked())?.accounts.some(
      (account) => account.name === wallet.name,
    );
    if (vaultHasAccount === true) {
      const opened = await this.openVault({ create: false });
      if (opened === undefined) {
        throw new KeystoreError(`No key for wallet ${wallet.name} in the vault.`);
      }
      return await opened.vault.signer(wallet.name);
    }

    const legacyExists = await pathExists(wallet.path);
    if (legacyExists) {
      const opened = await this.openVault({ create: true });
      const migration = await migrateKeystores({
        home: this.home,
        vault: opened.vault,
        resolvePassphrase: async () => passphrase,
        audit: this.audit,
        now: () => this.now(),
        only: [wallet.name],
      });
      if (migration.imported.includes(wallet.name)) {
        return await opened.vault.signer(wallet.name);
      }
      if (
        migration.skipped.some(
          (candidate) => candidate.name === wallet.name && candidate.reason === "passphrase_needed",
        )
      ) {
        return await unlockKeystore(passphrase, wallet.path);
      }
    }
    throw new KeystoreError(`No key for wallet ${wallet.name} in the vault.`);
  }

  async setDefault(name: string): Promise<WalletRegistry> {
    const wallet = this.resolve({ name });
    return await this.update((registry) => {
      registry.default = wallet.name;
    });
  }

  async setSpendCaps(name: string, caps: SpendCaps): Promise<WalletEntry> {
    const parsed = spendCapsSchema.parse(caps);
    return await this.updateSpendCaps(name, () => parsed);
  }

  /** Stores an explicit atomic ceiling, or null to disable automatic sweeps. */
  async setCeiling(name: string, ceilingAtomic: bigint | null): Promise<WalletEntry> {
    return await this.updateCeiling(name, () => ceilingAtomic);
  }

  /** Updates a ceiling from the latest value while holding the registry write lock. */
  async updateCeiling(
    name: string,
    update: (current: bigint | null) => bigint | null,
  ): Promise<WalletEntry> {
    const walletName = assertWalletName(name);
    return await withRegistryLock(this.registryPath, async () => {
      const registry = await this.readRegistry();
      const entry = registry.wallets[walletName];
      if (!entry) {
        throw new KeystoreError(unknownWalletMessage(walletName, Object.keys(registry.wallets)));
      }
      const ceilingAtomic = update(storedCeilingAtomic(entry));
      if (ceilingAtomic !== null && ceilingAtomic < 0n) {
        throw new KeystoreError("The wallet ceiling cannot be negative.");
      }
      const stored = ceilingAtomic === null ? null : ceilingAtomic.toString();
      if (entry.ceilingAtomic !== stored) {
        entry.ceilingAtomic = stored;
        await this.writeRegistry(registry);
      } else {
        this.registry = registry;
      }
      return structuredClone(entry);
    });
  }

  /** Reads the configured ceiling and the per-day-cap floor for one wallet. */
  ceilingCaps(name: string): WalletCeilingCaps {
    const entry = this.resolve({ name }).entry;
    const ceilingAtomic = storedCeilingAtomic(entry);
    const perDayAtomic = BigInt(entry.spendCaps.perDayAtomic);
    return {
      ceilingAtomic,
      effectiveCeilingAtomic:
        ceilingAtomic === null ? null : ceilingAtomic > perDayAtomic ? ceilingAtomic : perDayAtomic,
    };
  }

  /**
   * Atomically claims the ten-minute sweep window. The timestamp is written
   * before authorization work, so failed attempts consume the window too.
   */
  async claimCeilingSweepAttempt(
    name: string,
    now: Date,
    guardMs = 10 * 60 * 1_000,
  ): Promise<boolean> {
    const walletName = assertWalletName(name);
    if (!Number.isFinite(guardMs) || guardMs < 0) {
      throw new Error("The ceiling sweep guard must be a non-negative duration.");
    }
    return await withRegistryLock(this.registryPath, async () => {
      const registry = await this.readRegistry();
      const entry = registry.wallets[walletName];
      if (!entry) {
        throw new KeystoreError(unknownWalletMessage(walletName, Object.keys(registry.wallets)));
      }
      const previous = entry.ceilingSweepAttemptedAt;
      if (previous !== undefined && now.getTime() - new Date(previous).getTime() < guardMs) {
        this.registry = registry;
        return false;
      }
      entry.ceilingSweepAttemptedAt = now.toISOString();
      await this.writeRegistry(registry);
      return true;
    });
  }

  /** Reads the durable authorization plan used to resume an uncertain sweep. */
  ceilingSweepPending(name: string): WalletCeilingSweepPending | undefined {
    return structuredClone(this.resolve({ name }).entry.ceilingSweepPending);
  }

  /** Updates an uncertain sweep from the latest registry value under its lock. */
  async updateCeilingSweepPending(
    name: string,
    update: (
      current: Readonly<WalletCeilingSweepPending> | undefined,
    ) => WalletCeilingSweepPending | undefined,
  ): Promise<WalletCeilingSweepPending | undefined> {
    const walletName = assertWalletName(name);
    return await withRegistryLock(this.registryPath, async () => {
      const registry = await this.readRegistry();
      const entry = registry.wallets[walletName];
      if (!entry) {
        throw new KeystoreError(unknownWalletMessage(walletName, Object.keys(registry.wallets)));
      }
      const current = structuredClone(entry.ceilingSweepPending);
      const next = update(current);
      if (next === undefined) delete entry.ceilingSweepPending;
      else entry.ceilingSweepPending = ceilingSweepPendingSchema.parse(next);
      if (JSON.stringify(current) === JSON.stringify(entry.ceilingSweepPending)) {
        this.registry = registry;
      } else {
        await this.writeRegistry(registry);
      }
      return structuredClone(entry.ceilingSweepPending);
    });
  }

  /** Updates spend caps from the latest registry value while holding its write lock. */
  async updateSpendCaps(
    name: string,
    update: (current: Readonly<SpendCaps>) => SpendCaps,
  ): Promise<WalletEntry> {
    const walletName = assertWalletName(name);
    return await withRegistryLock(this.registryPath, async () => {
      const registry = await this.readRegistry();
      const entry = registry.wallets[walletName];
      if (!entry) {
        throw new KeystoreError(unknownWalletMessage(walletName, Object.keys(registry.wallets)));
      }
      const next = spendCapsSchema.parse(update({ ...entry.spendCaps }));
      if (
        next.perCallAtomic !== entry.spendCaps.perCallAtomic ||
        next.perDayAtomic !== entry.spendCaps.perDayAtomic
      ) {
        entry.spendCaps = next;
        await this.writeRegistry(registry);
      } else {
        this.registry = registry;
      }
      return structuredClone(entry);
    });
  }

  /** Atomically keeps the stricter current or planned provisioning limit in every field. */
  async lowerProvisioningLimits(
    name: string,
    plannedCaps: SpendCaps,
    plannedCeilingAtomic: bigint | null,
  ): Promise<WalletEntry> {
    const walletName = assertWalletName(name);
    const planned = spendCapsSchema.parse(plannedCaps);
    if (plannedCeilingAtomic !== null && plannedCeilingAtomic < 0n) {
      throw new KeystoreError("The wallet ceiling cannot be negative.");
    }
    return await withRegistryLock(this.registryPath, async () => {
      const registry = await this.readRegistry();
      const entry = registry.wallets[walletName];
      if (!entry) {
        throw new KeystoreError(unknownWalletMessage(walletName, Object.keys(registry.wallets)));
      }
      const nextCaps = {
        perCallAtomic: lowerAtomic(entry.spendCaps.perCallAtomic, planned.perCallAtomic),
        perDayAtomic: lowerAtomic(entry.spendCaps.perDayAtomic, planned.perDayAtomic),
      };
      const nextCeiling = lowerCeiling(storedCeilingAtomic(entry), plannedCeilingAtomic);
      const storedCeiling = nextCeiling === null ? null : nextCeiling.toString();
      if (
        nextCaps.perCallAtomic !== entry.spendCaps.perCallAtomic ||
        nextCaps.perDayAtomic !== entry.spendCaps.perDayAtomic ||
        storedCeiling !== entry.ceilingAtomic
      ) {
        entry.spendCaps = nextCaps;
        entry.ceilingAtomic = storedCeiling;
        await this.writeRegistry(registry);
      } else {
        this.registry = registry;
      }
      return structuredClone(entry);
    });
  }

  async setRouterRefill(name: string, refill: RouterRefill | null): Promise<WalletEntry> {
    const parsed = refill === null ? undefined : routerRefillSchema.parse(refill);
    const wallet = this.resolve({ name });
    const registry = await this.update((registry) => {
      const entry = registry.wallets[wallet.name];
      if (!entry)
        throw new KeystoreError(unknownWalletMessage(wallet.name, Object.keys(registry.wallets)));
      if (parsed === undefined) delete entry.routerRefill;
      else entry.routerRefill = parsed;
    });
    return structuredClone(registry.wallets[wallet.name]!);
  }

  /** Atomically reserve a purchase, or update/clear the matching reservation.
   * A competing reservation is returned unchanged. No payment may precede this write.
   */
  async setRouterPendingPurchase(
    name: string,
    pending: RouterPendingPurchase | null,
    expectedReceiptId?: string,
  ): Promise<WalletEntry> {
    const parsed = pending === null ? undefined : routerPendingPurchaseSchema.parse(pending);
    const wallet = this.resolve({ name });
    const path = this.routerPurchasePath(wallet.name);
    return await withFileLock(`${path}.lock`, async () => {
      const state = await this.readRouterPurchaseState(
        wallet.name,
        wallet.entry.routerPendingPurchase,
      );
      if (state.pending?.receiptId === expectedReceiptId) {
        if (parsed === undefined) {
          if (state.pending?.status === "settled")
            state.completedReceiptId = state.pending.receiptId;
          delete state.pending;
        } else state.pending = parsed;
        // Keep an empty tombstone so a legacy registry field cannot resurrect.
        await writeJsonAtomic(path, state);
      }
      const entry = this.registry.wallets[wallet.name]!;
      if (state.pending === undefined) delete entry.routerPendingPurchase;
      else entry.routerPendingPurchase = state.pending;
      return structuredClone(entry);
    });
  }

  /** Separate from registry locks: held throughout recovery, reservation and payment. */
  async withRouterPurchaseLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
    return await withFileLock(`${this.routerPurchasePath(name)}.purchase.lock`, operation);
  }

  private assertNoPendingRouterPurchase(name: WalletName): void {
    if (this.entry(name)?.routerPendingPurchase !== undefined) {
      throw new KeystoreError(
        `Account ${name} has a pending Router purchase. Resolve it with vapi router clear-pending --account ${name} before renaming or removing the account.`,
      );
    }
  }

  async routerCompletedPurchase(name: string): Promise<string | undefined> {
    return (await this.readRouterPurchaseState(name)).completedReceiptId;
  }

  private routerPurchasePath(name: string): string {
    return join(this.home, "router-pending", `${assertWalletName(name)}.json`);
  }

  private async readRouterPurchaseState(
    name: string,
    legacy?: RouterPendingPurchase,
  ): Promise<RouterPurchaseState> {
    const path = this.routerPurchasePath(name);
    try {
      return routerPurchaseStateSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (!isMissingFile(error)) throw error; // Corrupt evidence must fail closed.
    }
    return { version: 1, ...(legacy === undefined ? {} : { pending: legacy }) };
  }

  /** Sets or, with `undefined`, clears the human label of a wallet. */
  async setLabel(name: string, label: string | undefined): Promise<WalletEntry> {
    const parsed =
      label === undefined || label.trim().length === 0
        ? undefined
        : walletEntrySchema.shape.label.parse(label);
    const wallet = this.resolve({ name });
    await this.update((registry) => {
      const entry = registry.wallets[wallet.name];
      if (!entry) return;
      if (parsed === undefined) delete entry.label;
      else entry.label = parsed;
    });
    const entry = { ...wallet.entry };
    if (parsed === undefined) delete entry.label;
    else entry.label = parsed;
    return entry;
  }

  async setLink(name: WalletName, link: AgentLink): Promise<WalletEntry> {
    const parsed = agentLinkSchema.parse(link);
    const wallet = this.resolve({ name });
    const registry = await this.update((registry) => {
      const entry = registry.wallets[wallet.name];
      if (!entry)
        throw new KeystoreError(unknownWalletMessage(wallet.name, Object.keys(registry.wallets)));
      entry.link = parsed;
    });
    return structuredClone(registry.wallets[wallet.name]!);
  }

  async clearLink(name: WalletName): Promise<WalletEntry> {
    const wallet = this.resolve({ name });
    const registry = await this.update((registry) => {
      const entry = registry.wallets[wallet.name];
      if (!entry)
        throw new KeystoreError(unknownWalletMessage(wallet.name, Object.keys(registry.wallets)));
      delete entry.link;
    });
    return structuredClone(registry.wallets[wallet.name]!);
  }

  /**
   * Renames a wallet everywhere its name is recorded: the vault or legacy
   * keystore, the registry, and the wallet field of its receipts.
   */
  async rename(
    oldName: string,
    newName: string,
    options: WalletRenameOptions = {},
  ): Promise<ResolvedWallet> {
    const source = assertWalletName(oldName.trim());
    const target = assertWalletName(newName);
    try {
      return await this.withRouterPurchaseLock(source, async () => {
        return await withAccountMovementLocks(this.home, [source, target], undefined, async () => {
          return await withAccountMutationLocks(
            this.home,
            [source, target],
            `vapi accounts rename ${source} ${target}`,
            async () => {
              await this.reload();
              this.assertNoPendingRouterPurchase(source);
              return await this.renameWithMovementLocksHeld(source, target, options);
            },
          );
        });
      });
    } catch (error) {
      if (error instanceof AccountMovementLockedError) {
        throw accountChangeBusyError(error.account, `vapi accounts rename ${source} ${target}`);
      }
      throw error;
    }
  }

  private async renameWithMovementLocksHeld(
    source: WalletName,
    target: WalletName,
    options: WalletRenameOptions,
  ): Promise<ResolvedWallet> {
    const wallet = this.resolve({ name: source });
    if (target === wallet.name) return wallet;
    if (this.has(target)) {
      throw new KeystoreError(`Wallet ${target} already exists. Choose another name.`);
    }
    await assertAccountNameUnreferenced(this.home, wallet.name, "rename");
    await assertAccountNameUnreferenced(this.home, target, "rename_to");
    const targetPath = this.pathFor(target);
    if (await pathExists(targetPath)) {
      throw new KeystoreError(
        `A keystore already exists at ${targetPath}. Refusing to overwrite it.`,
      );
    }
    const storedAccount = (await this.readVaultUnlocked())?.accounts.find(
      (account) => account.name === wallet.name,
    );
    const legacyExists = await pathExists(wallet.path);
    const mutate = async (): Promise<ResolvedWallet> => {
      const secretMigration =
        wallet.entry.link === undefined
          ? undefined
          : await prepareAgentSecretRename(options.secrets, wallet.name, target);
      let vaultRenamed = false;
      let legacyRenamed = false;
      let registryRenamed = false;
      try {
        if (storedAccount !== undefined) {
          const opened = await this.openVault({ create: false });
          if (opened === undefined) {
            throw new KeystoreError(`No key for wallet ${wallet.name} in the vault.`);
          }
          await opened.vault.rename(wallet.name, target);
          vaultRenamed = true;
        }
        if (storedAccount === undefined || legacyExists) {
          await rename(wallet.path, targetPath);
          legacyRenamed = true;
        }
        await this.update((registry) => {
          const entry = registry.wallets[wallet.name];
          delete registry.wallets[wallet.name];
          if (entry) registry.wallets[target] = entry;
          if (registry.default === wallet.name) registry.default = target;
        });
        registryRenamed = true;
        await renameReceiptWallet(wallet.name, target, getVapiPaths(this.home).receipts);
      } catch (error) {
        try {
          if (legacyRenamed) await rename(targetPath, wallet.path);
          if (vaultRenamed) {
            const opened = await this.openVault({ create: false });
            if (opened === undefined) {
              throw new KeystoreError(`No key for wallet ${target} in the vault.`);
            }
            await opened.vault.rename(target, wallet.name);
          }
          if (registryRenamed) {
            await this.update((registry) => {
              const entry = registry.wallets[target];
              delete registry.wallets[target];
              if (entry) registry.wallets[wallet.name] = entry;
              if (registry.default === target) registry.default = wallet.name;
            });
          }
          await secretMigration?.rollback();
        } catch (rollbackError) {
          throw new KeystoreError(
            `Account rename could not be rolled back safely. Run vapi accounts list and inspect ${wallet.name} and ${target} before retrying.`,
            { cause: new AggregateError([error, rollbackError]) },
          );
        }
        throw error;
      }
      await secretMigration?.commit().catch(() => undefined);
      return { name: target, path: targetPath, entry: wallet.entry };
    };
    return options.serialize === undefined ? await mutate() : await options.serialize(mutate);
  }

  /**
   * Moves a wallet's encrypted vault record or legacy keystore to
   * `wallets/.trash/`. The default wallet and a wallet that still holds USDC
   * are refused unless forced.
   *
   * `allowDefault` exists for one caller: `vapi import --replace`, which puts a
   * new wallet under the same name back in place immediately afterwards, so the
   * machine is never left without a default. `vapi wallet remove` never sets it.
   */
  async remove(name: string, options: WalletRemoveOptions = {}): Promise<TrashedWallet> {
    const account = assertWalletName(name.trim());
    try {
      return await this.withRouterPurchaseLock(account, async () => {
        return await withAccountMovementLocks(this.home, [account], undefined, async () => {
          await this.reload();
          this.assertNoPendingRouterPurchase(account);
          return await this.removeWithMovementLockHeld(account, options);
        });
      });
    } catch (error) {
      if (error instanceof AccountMovementLockedError) {
        throw accountChangeBusyError(error.account, `vapi accounts remove ${account}`);
      }
      throw error;
    }
  }

  private async removeWithMovementLockHeld(
    account: WalletName,
    options: WalletRemoveOptions,
  ): Promise<TrashedWallet> {
    const wallet = this.resolve({ name: account });
    if (options.allowDefault !== true && wallet.name === this.registry.default) {
      throw new KeystoreError(
        `Wallet ${wallet.name} is the default wallet. Choose another default first with vapi wallet use <name>.`,
      );
    }
    await assertAccountNameUnreferenced(this.home, wallet.name, "remove");
    if (options.force !== true && options.balanceReader) {
      const address = await this.readAddress(wallet.name);
      if (address) {
        const balance = await options.balanceReader(address);
        if (balance > 0n) {
          throw new KeystoreError(
            `Wallet ${wallet.name} (${address}) still holds ${balance} atomic USDC. Move the funds out with vapi sweep first, or re-run with --force.`,
          );
        }
      }
    }

    const removedAt = this.now().toISOString();
    await mkdir(this.trashDirectory, { recursive: true, mode: 0o700 });
    const trashedPath = join(this.trashDirectory, `${wallet.name}-${removedAt}.json`);
    const storedAccount = (await this.readVaultUnlocked())?.accounts.find(
      (candidate) => candidate.name === wallet.name,
    );
    if (storedAccount !== undefined) {
      const opened = await this.openVault({ create: false });
      if (opened === undefined) {
        throw new KeystoreError(`No key for wallet ${wallet.name} in the vault.`);
      }
      this.balanceProbe =
        options.force === true || options.balanceReader === undefined
          ? async () => 0n
          : options.balanceReader;
      try {
        await writeJsonFile(trashedPath, storedAccount);
        try {
          await opened.vault.removeAccount(wallet.name);
        } catch (error) {
          await unlink(trashedPath).catch(() => undefined);
          throw error;
        }
      } finally {
        this.balanceProbe = undefined;
      }
      if (await pathExists(wallet.path)) {
        const legacyTrashedPath = join(
          this.trashDirectory,
          `${wallet.name}-${removedAt}.legacy.json`,
        );
        const legacyMetadata = await lstat(wallet.path);
        await rename(wallet.path, legacyTrashedPath);
        if (!legacyMetadata.isSymbolicLink()) await chmod(legacyTrashedPath, 0o600);
      }
    } else {
      await rename(wallet.path, trashedPath);
      await chmod(trashedPath, 0o600);
    }
    await writeJsonFile(entrySidecarPath(trashedPath), wallet.entry);
    await this.update((registry) => {
      delete registry.wallets[wallet.name];
    });
    return { name: wallet.name, removedAt, path: trashedPath, entry: wallet.entry };
  }

  /** Brings the most recently removed wallet of that name back. */
  async restore(name: string): Promise<ResolvedWallet> {
    const target = assertWalletName(name);
    return await withAccountMutationLocks(
      this.home,
      [target],
      `vapi accounts restore ${target}`,
      async () => {
        await this.reload();
        return await this.restoreWithAccountMutationLockHeld(target);
      },
    );
  }

  private async restoreWithAccountMutationLockHeld(target: WalletName): Promise<ResolvedWallet> {
    if (this.has(target)) {
      throw new KeystoreError(`Wallet ${target} already exists. Rename it before restoring.`);
    }
    const trashed = (await this.listTrash()).find((candidate) => candidate.name === target);
    if (!trashed) {
      throw new KeystoreError(`No removed wallet named ${target} is in ${this.trashDirectory}.`);
    }
    const path = this.pathFor(target);
    if (await pathExists(path)) {
      throw new KeystoreError(`A keystore already exists at ${path}. Refusing to overwrite it.`);
    }
    const storedAccount = await readTrashedVaultAccount(trashed.path);
    if (storedAccount !== undefined) {
      const opened = await this.openVault({ create: false });
      if (opened === undefined || this.vaultKey === undefined) {
        throw new KeystoreError(`No vault exists to restore wallet ${target}.`);
      }
      await reinstateVaultAccount({
        path: this.vaultPath,
        key: this.vaultKey,
        account: storedAccount,
      });
      await unlink(trashed.path);
      this.dropVaultCache();
      const legacyTrashedPath = trashed.path.replace(/\.json$/u, ".legacy.json");
      if (await pathExists(legacyTrashedPath)) {
        await mkdir(this.walletsDirectory, { recursive: true, mode: 0o700 });
        await rename(legacyTrashedPath, path);
        if (!(await lstat(path)).isSymbolicLink()) await chmod(path, 0o600);
      }
    } else {
      await mkdir(this.walletsDirectory, { recursive: true, mode: 0o700 });
      await rename(trashed.path, path);
      await chmod(path, 0o600);
    }
    await unlink(entrySidecarPath(trashed.path)).catch(() => undefined);
    const entry = trashed.entry ?? this.newEntry({});
    await this.update((registry) => {
      registry.wallets[target] = entry;
      registry.default ??= target;
    });
    return { name: target, path, entry };
  }

  /** Every removed wallet still in the trash, newest first. */
  async listTrash(): Promise<TrashedWallet[]> {
    let files: string[];
    try {
      files = await readdir(this.trashDirectory);
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    const trashed: TrashedWallet[] = [];
    for (const file of files.sort()) {
      const match = TRASHED_NAME_PATTERN.exec(file);
      if (!match) continue;
      const [, name, removedAt] = match;
      if (name === undefined || removedAt === undefined || !isWalletName(name)) continue;
      const path = join(this.trashDirectory, file);
      const entry = await readEntrySidecar(entrySidecarPath(path));
      trashed.push({ name, removedAt, path, ...(entry ? { entry } : {}) });
    }
    return trashed.reverse();
  }

  /**
   * Moves a 0.2.x home into the wallet layout, once: `keystore.json` becomes
   * `wallets/main.json`, ready for vault migration. The keystore contents are
   * never rewritten, and a home without a keystore migrates nothing.
   */
  async migrateLegacyLayout(): Promise<LayoutMigration> {
    const legacyPath = getVapiPaths(this.home).keystore;
    let info;
    try {
      info = await lstat(legacyPath);
    } catch (error) {
      if (isMissingFile(error)) return { moved: false };
      throw error;
    }
    // A symlink means the migration already ran; anything but a regular file
    // is not ours to move.
    if (!info.isFile()) return { moved: false };

    const target = this.pathFor(DEFAULT_WALLET_NAME);
    if (await pathExists(target)) return { moved: false };

    await mkdir(this.walletsDirectory, { recursive: true, mode: 0o700 });
    await rename(legacyPath, target);
    await chmod(target, 0o600);

    const spendCaps = await readConfiguredSpendCaps(getVapiPaths(this.home).config);
    await this.update((registry) => {
      registry.wallets[DEFAULT_WALLET_NAME] ??= {
        createdAt: keystoreCreatedAt(info),
        spendCaps,
      };
      registry.default ??= DEFAULT_WALLET_NAME;
    });
    return { moved: true, from: legacyPath, to: target };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private newEntry(options: { label?: string; spendCaps?: SpendCaps }): WalletEntry {
    return walletEntrySchema.parse({
      createdAt: this.now().toISOString(),
      spendCaps: options.spendCaps ?? { ...DEFAULT_SPEND_CAPS },
      ceilingAtomic: DEFAULT_CEILING_ATOMIC.toString(),
      ...(options.label === undefined || options.label.trim().length === 0
        ? {}
        : { label: options.label }),
    });
  }

  private async prepareNewWallet(name: string): Promise<string> {
    const target = assertWalletName(name);
    if (this.has(target)) {
      throw new KeystoreError(`Wallet ${target} already exists. Choose another name.`);
    }
    const path = this.pathFor(target);
    if (await pathExists(path)) {
      throw new KeystoreError(
        `A keystore already exists at ${path}. Refusing to replace the local payment key.`,
      );
    }
    return path;
  }

  private async registerWallet(
    name: string,
    options: { label?: string; spendCaps?: SpendCaps },
  ): Promise<WalletEntry> {
    const entry = this.newEntry(options);
    await this.update((registry) => {
      registry.wallets[name] = entry;
      registry.default ??= name;
    });
    return entry;
  }

  private get vaultPath(): string {
    return join(this.home, VAULT_FILE);
  }

  private async readVaultUnlocked(): Promise<StoredVaultFile | undefined> {
    try {
      return await readVaultFileUnlocked(this.vaultPath);
    } catch (error) {
      if (error instanceof VaultError && error.code === "not_found") return undefined;
      throw error;
    }
  }

  private async registerMissingVaultAccounts(accounts: readonly VaultAccount[]): Promise<void> {
    const candidates = accounts
      .filter((account) => !this.has(account.name))
      .map((account) => assertWalletName(account.name));
    if (candidates.length === 0) return;
    await withAccountMutationLocks(this.home, candidates, "your vapi command", async () => {
      await this.reload();
      const currentVault = await this.readVaultUnlocked();
      if (currentVault === undefined) return;
      const candidateNames = new Set(candidates);
      const missing = currentVault.accounts.filter(
        (account) => candidateNames.has(account.name) && !this.has(account.name),
      );
      if (missing.length === 0) return;
      await this.update((registry) => {
        for (const account of missing) {
          const name = assertWalletName(account.name);
          registry.wallets[name] ??= {
            createdAt: account.createdAt,
            spendCaps: { ...DEFAULT_SPEND_CAPS },
            ceilingAtomic: DEFAULT_CEILING_ATOMIC.toString(),
          };
        }
        registry.default ??= Object.keys(registry.wallets)[0] as WalletName | undefined;
      });
    });
  }

  private async openVault(options: {
    create: true;
    phrase?: string;
  }): Promise<{ vault: Vault; created: boolean }>;
  private async openVault(options: {
    create: false;
    phrase?: string;
  }): Promise<{ vault: Vault; created: boolean } | undefined>;
  private async openVault(options: {
    create: boolean;
    phrase?: string;
  }): Promise<{ vault: Vault; created: boolean } | undefined> {
    const stored = await this.readVaultUnlocked();
    if (this.cachedVault !== undefined && stored?.protected === false) {
      return { vault: this.cachedVault, created: false };
    }
    if (this.cachedVault !== undefined) this.dropVaultCache();
    if (stored === undefined) {
      if (!options.create) return undefined;
      const key = await loadOrCreateDeviceKey({ secrets: this.secrets });
      try {
        const vault = await createVault({
          path: this.vaultPath,
          key,
          now: () => this.now(),
          balanceOf: async (address) =>
            this.balanceProbe === undefined ? 0n : await this.balanceProbe(address),
          ...(options.phrase === undefined ? {} : { phrase: options.phrase }),
        });
        this.cachedVault = vault;
        this.vaultKey = key;
        return { vault, created: true };
      } catch (error) {
        key.fill(0);
        throw error;
      }
    }

    let key: Uint8Array;
    try {
      key = stored.protected
        ? await unlockProtectedVault({
            path: this.vaultPath,
            secrets: this.secrets,
            env: this.environment,
            now: () => this.now(),
          })
        : await loadOrCreateDeviceKey({ secrets: this.secrets });
    } catch (error) {
      if (error instanceof VaultError && error.code === "password_required") {
        throw new KeystoreError(VAULT_LOCKED_MESSAGE, { cause: error });
      }
      throw error;
    }
    try {
      const vault = await openDeviceVault({
        path: this.vaultPath,
        key,
        now: () => this.now(),
        balanceOf: async (address) =>
          this.balanceProbe === undefined ? 0n : await this.balanceProbe(address),
      });
      this.cachedVault = vault;
      this.vaultKey = key;
      return { vault, created: false };
    } catch (error) {
      key.fill(0);
      throw error;
    }
  }

  private dropVaultCache(): void {
    this.vaultKey?.fill(0);
    this.vaultKey = undefined;
    this.cachedVault = undefined;
  }

  private async update(mutate: (registry: WalletRegistry) => void): Promise<WalletRegistry> {
    return await withRegistryLock(this.registryPath, async () => {
      const registry = await this.readRegistry();
      mutate(registry);
      await this.writeRegistry(registry);
      return this.snapshot();
    });
  }

  private async readRegistry(): Promise<WalletRegistry> {
    let raw: string;
    try {
      raw = await readFile(this.registryPath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return emptyRegistry();
      throw error;
    }
    try {
      const registry = walletRegistrySchema.parse(JSON.parse(raw));
      for (const [name, entry] of Object.entries(registry.wallets)) {
        const legacy = entry.routerPendingPurchase;
        // Older prepared records may already have signed; they have no signing journal.
        const migrated =
          legacy?.status === "prepared" ? { ...legacy, status: "unknown" as const } : legacy;
        const path = this.routerPurchasePath(name);
        let state = await this.readRouterPurchaseState(name);
        if (legacy !== undefined) {
          state = await withFileLock(`${path}.lock`, async () => {
            const current = await this.readRouterPurchaseState(name, migrated);
            await writeJsonAtomic(path, current);
            return current;
          });
        }
        if (state.pending === undefined) delete entry.routerPendingPurchase;
        else entry.routerPendingPurchase = state.pending;
      }
      return registry;
    } catch (error) {
      throw new KeystoreError(
        `The wallet registry at ${this.registryPath} could not be read. Fix or move the file, then run vapi wallet list again.`,
        { cause: error },
      );
    }
  }

  private async writeRegistry(registry: WalletRegistry): Promise<void> {
    const parsed = walletRegistrySchema.parse(registry);
    const disk = structuredClone(parsed);
    for (const entry of Object.values(disk.wallets)) delete entry.routerPendingPurchase;
    await writeJsonFile(this.registryPath, disk);
    this.registry = parsed;
  }
}

async function swarmReferencingAccount(
  home: string,
  account: WalletName,
): Promise<string | undefined> {
  const directory = join(home, "swarms");
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
  for (const file of files.filter((name) => name.endsWith(".json")).sort()) {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(join(directory, file), "utf8"));
    } catch {
      throw new KeystoreError(
        `Cannot verify swarm references because ${file} is invalid. Repair or remove that swarm file before renaming an account.`,
      );
    }
    if (typeof value !== "object" || value === null) {
      throw new KeystoreError(
        `Cannot verify swarm references because ${file} is invalid. Repair or remove that swarm file before renaming an account.`,
      );
    }
    const name = Reflect.get(value, "name");
    const treasury = Reflect.get(value, "treasury");
    const members = Reflect.get(value, "members");
    if (
      typeof name !== "string" ||
      typeof treasury !== "object" ||
      treasury === null ||
      typeof Reflect.get(treasury, "account") !== "string" ||
      !Array.isArray(members) ||
      members.some(
        (member) =>
          typeof member !== "object" ||
          member === null ||
          typeof Reflect.get(member, "account") !== "string",
      )
    ) {
      throw new KeystoreError(
        `Cannot verify swarm references because ${file} is invalid. Repair or remove that swarm file before renaming an account.`,
      );
    }
    const treasuryAccount =
      typeof treasury === "object" && treasury !== null
        ? Reflect.get(treasury, "account")
        : undefined;
    const memberMatch =
      Array.isArray(members) &&
      members.some(
        (member) =>
          typeof member === "object" &&
          member !== null &&
          Reflect.get(member, "account") === account,
      );
    if (treasuryAccount === account || memberMatch) {
      return name.length > 0 ? name : file.slice(0, -5);
    }
  }
  return undefined;
}

async function unfinishedMovementReferencingAccount(
  home: string,
  account: WalletName,
): Promise<string | undefined> {
  const directory = join(home, "movements");
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
  for (const file of files.filter((name) => name.endsWith(".json")).sort()) {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(join(directory, file), "utf8"));
    } catch {
      throw invalidMovementReferenceError(file);
    }
    if (typeof value !== "object" || value === null) throw invalidMovementReferenceError(file);
    const id = Reflect.get(value, "id");
    const movementFrom = Reflect.get(value, "from");
    const legs = Reflect.get(value, "legs");
    if (
      typeof id !== "string" ||
      typeof movementFrom !== "string" ||
      !Array.isArray(legs) ||
      legs.some(
        (leg) =>
          typeof leg !== "object" ||
          leg === null ||
          (Reflect.get(leg, "from") !== undefined &&
            typeof Reflect.get(leg, "from") !== "string") ||
          typeof Reflect.get(leg, "to") !== "string" ||
          typeof Reflect.get(leg, "status") !== "string",
      )
    ) {
      throw invalidMovementReferenceError(file);
    }
    let movementOpen = false;
    for (const leg of legs) {
      const status = Reflect.get(leg as object, "status");
      const retryable = Reflect.get(leg as object, "retryable");
      const nonce = Reflect.get(leg as object, "nonce");
      const restored = Reflect.get(leg as object, "restored");
      const legFrom = Reflect.get(leg as object, "from") ?? movementFrom;
      const journal =
        restored !== true && status === "failed" && retryable !== true && typeof nonce === "string"
          ? await readTransferJournal(home, legFrom as WalletName, nonce)
          : undefined;
      const open = isOpenMovementLeg(
        { status, retryable, nonce, restored },
        journal?.signed === true ? "signed" : "unsigned",
      );
      if (open) movementOpen = true;
    }
    if (
      movementOpen &&
      (movementFrom === account ||
        legs.some(
          (leg) =>
            (Reflect.get(leg as object, "from") ?? movementFrom) === account ||
            Reflect.get(leg as object, "to") === account,
        ))
    ) {
      return id;
    }
  }
  return undefined;
}

function invalidMovementReferenceError(file: string): KeystoreError {
  return new KeystoreError(
    `Cannot verify movement references because ${file} is invalid. Repair or remove that movement file before changing an account.`,
  );
}

async function assertAccountNameUnreferenced(
  home: string,
  account: WalletName,
  operation: "rename" | "rename_to" | "remove",
): Promise<void> {
  const swarm = await swarmReferencingAccount(home, account);
  if (swarm !== undefined) {
    const action =
      operation === "rename_to"
        ? `Account name ${account} is still referenced by swarm ${swarm}. Run vapi swarm dissolve ${swarm} before reusing it.`
        : `Account ${account} belongs to swarm ${swarm}. Run vapi swarm dissolve ${swarm} before ${operation === "remove" ? "removing" : "renaming"} it.`;
    throw new KeystoreError(action);
  }
  const movement = await unfinishedMovementReferencingAccount(home, account);
  if (movement !== undefined) {
    const action =
      operation === "rename_to"
        ? `Account name ${account} is still referenced by unfinished movement ${movement}. Resume it with vapi accounts distribute --resume ${movement}, or safely cancel it with vapi accounts distribute --cancel ${movement}, before reusing that name.`
        : `Account ${account} is referenced by unfinished movement ${movement}. Resume it with vapi accounts distribute --resume ${movement}, or safely cancel it with vapi accounts distribute --cancel ${movement}, before ${operation === "remove" ? "removing" : "renaming"} the account.`;
    throw new KeystoreError(action);
  }
}

function accountChangeBusyError(account: WalletName, command: string): KeystoreError {
  return new KeystoreError(
    `Account ${account} is busy with another capital movement. Wait for it to finish, then retry ${command}.`,
  );
}

async function withAccountMutationLocks<T>(
  home: string,
  accounts: readonly WalletName[],
  command: string,
  operation: () => Promise<T>,
): Promise<T> {
  const [account, ...remaining] = [...new Set(accounts)].sort();
  if (account === undefined) return await operation();
  return await withFileLock(
    join(home, `.account-${account}.lock`),
    async () => await withAccountMutationLocks(home, remaining, command, operation),
    {
      lockedMessage: `Account ${account} is busy with another account change. Wait for it to finish, then retry ${command}.`,
    },
  );
}

function lowerAtomic(current: string, planned: string): string {
  return BigInt(current) < BigInt(planned) ? current : planned;
}

function lowerCeiling(current: bigint | null, planned: bigint | null): bigint | null {
  if (current === null) return planned;
  if (planned === null) return current;
  return current < planned ? current : planned;
}

/**
 * The caps that apply to one wallet: its own entry, or — in a home that has no
 * registry yet — the legacy `config.spendCaps`, and otherwise the defaults.
 */
export async function spendCapsForWallet(
  store: WalletStore,
  name: WalletName = DEFAULT_WALLET_NAME,
): Promise<SpendCaps> {
  const entry = store.entry(name);
  if (entry) return { ...entry.spendCaps };
  return await readConfiguredSpendCaps(getVapiPaths(store.home).config);
}

/** Formats atomic USDC without floating point for JSON-facing cap objects. */
export function formatCeilingUsd(ceilingAtomic: bigint | null): string {
  if (ceilingAtomic === null) return "off";
  if (ceilingAtomic < 0n) throw new Error("The wallet ceiling cannot be negative.");
  const whole = ceilingAtomic / 1_000_000n;
  const fraction = (ceilingAtomic % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
}

/** The JSON fragment used by account and caps output. */
export function ceilingCapsJson(caps: Pick<WalletCeilingCaps, "ceilingAtomic">): {
  ceilingUsd: string;
} {
  return { ceilingUsd: formatCeilingUsd(caps.ceilingAtomic) };
}

/** Rejects anything that is not a wallet name, including path traversal. */
export function assertWalletName(value: string): WalletName {
  const name = value.trim();
  if (name === "." || name === ".." || /[/\\]/.test(name) || name.includes("\0")) {
    throw new KeystoreError(
      `A wallet name is a name, not a path: ${JSON.stringify(value)} cannot be used.`,
    );
  }
  if (!isWalletName(name)) {
    throw new KeystoreError(
      `Invalid wallet name ${JSON.stringify(value)}. Use 1 to 32 characters of lowercase letters, digits and dashes, starting with a letter or digit.`,
    );
  }
  return name;
}

function unknownWalletMessage(name: string, names: readonly string[]): string {
  if (names.length === 0) return "No wallet yet. Run vapi init.";
  return `No wallet named ${name}. This machine has: ${[...names].sort().join(", ")}.`;
}

function emptyRegistry(): WalletRegistry {
  return { version: 1, wallets: {} };
}

function storedCeilingAtomic(entry: WalletEntry): bigint | null {
  return entry.ceilingAtomic === null
    ? null
    : BigInt(entry.ceilingAtomic ?? DEFAULT_CEILING_ATOMIC.toString());
}

function entrySidecarPath(trashedPath: string): string {
  return `${trashedPath.slice(0, -".json".length)}.entry.json`;
}

function defaultPassphraseResolver(
  environment: NodeJS.ProcessEnv,
  secrets: SecretStore,
): PassphraseResolver {
  return async (name) => {
    const fromEnvironment = environment[PASSPHRASE_ENVIRONMENT_VARIABLE];
    if (fromEnvironment !== undefined && fromEnvironment.length > 0) return fromEnvironment;
    if (!secrets.available) return undefined;
    try {
      return await secrets.get(name);
    } catch {
      return undefined;
    }
  };
}

function isLockedVaultError(error: unknown): boolean {
  return (
    error instanceof KeystoreError &&
    error.message === VAULT_LOCKED_MESSAGE &&
    error.cause instanceof VaultError &&
    error.cause.code === "password_required"
  );
}

async function readTrashedVaultAccount(path: string): Promise<StoredVaultAccount | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("kind" in parsed)) return undefined;
  return parsed as StoredVaultAccount;
}

async function readEntrySidecar(path: string): Promise<WalletEntry | undefined> {
  try {
    const parsed = walletEntrySchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The addresses a keystore names, without its passphrase. Only the encrypted
 * key material needs the passphrase, so `vapi wallet list` stays instant.
 */
async function readKeystoreSummary(
  path: string,
): Promise<{ address?: string; solanaAddress?: string; version?: number }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const address = Reflect.get(parsed, "address");
  const version = Reflect.get(parsed, "version");
  const keys: unknown = Reflect.get(parsed, "keys");
  const solana =
    typeof keys === "object" && keys !== null
      ? (Reflect.get(keys, "solana") as unknown)
      : undefined;
  const solanaAddress =
    typeof solana === "object" && solana !== null ? Reflect.get(solana, "address") : undefined;
  return {
    ...(typeof address === "string" ? { address } : {}),
    ...(typeof version === "number" ? { version } : {}),
    ...(typeof solanaAddress === "string" ? { solanaAddress } : {}),
  };
}

async function readConfiguredSpendCaps(configPath: string): Promise<SpendCaps> {
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
    const caps =
      typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "spendCaps") : undefined;
    const result = spendCapsSchema.safeParse(caps);
    if (result.success) return result.data;
  } catch {
    // A missing or unreadable config falls back to the shipped defaults.
  }
  return { ...DEFAULT_SPEND_CAPS };
}

function keystoreCreatedAt(info: { birthtimeMs: number; mtimeMs: number }): string {
  const stamp = info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs;
  return new Date(stamp).toISOString();
}

type AgentSecretSet = { tokens: string; routerStake: string; routerBalance: string };
type AgentSecretValues = { tokens?: string; routerStake?: string; routerBalance?: string };

function agentSecretsForWallet(wallet: WalletName): AgentSecretSet {
  return {
    tokens: `vapi.agent.${wallet}.tokens`,
    routerStake: `vapi.agent.${wallet}.router.stake`,
    routerBalance: `vapi.agent.${wallet}.router.balance`,
  };
}

async function prepareAgentSecretRename(
  secrets: SecretStore | undefined,
  from: WalletName,
  to: WalletName,
): Promise<{ commit(): Promise<void>; rollback(): Promise<void> }> {
  if (secrets?.available !== true) {
    throw new KeystoreError(
      "This linked wallet cannot be renamed safely because no OS secret store is available.",
    );
  }
  const source = agentSecretsForWallet(from);
  const target = agentSecretsForWallet(to);
  let targetValues: AgentSecretValues | undefined;
  try {
    targetValues = await readAgentSecretValues(secrets, target);
    const sourceValues = await readAgentSecretValues(secrets, source);
    await writeAgentSecretValues(secrets, target, sourceValues);
  } catch (error) {
    if (targetValues !== undefined) {
      await writeAgentSecretValues(secrets, target, targetValues).catch(() => undefined);
    }
    throw new KeystoreError("The linked wallet credentials could not be prepared for rename.", {
      cause: error,
    });
  }
  const previousTarget = targetValues;

  return {
    async commit() {
      await removeAgentSecrets(secrets, source);
    },
    async rollback() {
      await writeAgentSecretValues(secrets, target, previousTarget);
    },
  };
}

async function readAgentSecretValues(
  secrets: SecretStore,
  accounts: AgentSecretSet,
): Promise<AgentSecretValues> {
  const [tokens, routerStake, routerBalance] = await Promise.all([
    secrets.get(accounts.tokens),
    secrets.get(accounts.routerStake),
    secrets.get(accounts.routerBalance),
  ]);
  return {
    ...(tokens === undefined ? {} : { tokens }),
    ...(routerStake === undefined ? {} : { routerStake }),
    ...(routerBalance === undefined ? {} : { routerBalance }),
  };
}

async function writeAgentSecretValues(
  secrets: SecretStore,
  accounts: AgentSecretSet,
  values: AgentSecretValues,
): Promise<void> {
  await writeAgentSecretValue(secrets, accounts.tokens, values.tokens);
  await writeAgentSecretValue(secrets, accounts.routerStake, values.routerStake);
  await writeAgentSecretValue(secrets, accounts.routerBalance, values.routerBalance);
}

async function writeAgentSecretValue(
  secrets: SecretStore,
  account: string,
  value: string | undefined,
): Promise<void> {
  if (value === undefined) await secrets.remove(account);
  else await secrets.set(account, value);
}

async function removeAgentSecrets(secrets: SecretStore, accounts: AgentSecretSet): Promise<void> {
  await secrets.remove(accounts.tokens);
  await secrets.remove(accounts.routerStake);
  await secrets.remove(accounts.routerBalance);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

/** Serializes registry read-modify-write transactions across CLI and MCP processes. */
async function withRegistryLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + 2_000;
  let handle: FileHandle | undefined;

  while (!handle) {
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      await removeStaleRegistryLock(lockPath);
      if (Date.now() >= deadline) {
        throw new KeystoreError("Timed out waiting for the wallet registry lock.");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  try {
    return await operation();
  } finally {
    await handle.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

async function removeStaleRegistryLock(path: string): Promise<void> {
  try {
    const metadata = await stat(path);
    if (Date.now() - metadata.mtimeMs > 30_000) await unlink(path);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

/** Temp file plus rename, mode 0600, the same write every keystore change uses. */
async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporaryPath, path);
}
