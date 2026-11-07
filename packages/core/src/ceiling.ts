import { randomBytes } from "node:crypto";

import { bytesToHex, getAddress, isAddress, type Hex } from "viem";

import {
  AccountMovementLockedError,
  withSwarmAccountMovementLocks,
} from "./account-movement-lock.js";
import { appendAudit, type AuditRecord } from "./audit.js";
import { checkReceiptSettlement, type AuthorizationState } from "./authorization-state.js";
import { getVapiPaths, type VapiConfig } from "./config.js";
import { createPublicFetch, type LookupFn } from "./net-guard.js";
import { configuredNetworkFor } from "./networks.js";
import { reconcileUnresolvedMovementsForAccountLocked } from "./movement.js";
import { readReceipts, type Receipt } from "./receipts.js";
import type { SecretStore } from "./secret-store.js";
import { fetchSiblings, SiblingsError, type SiblingsResult } from "./siblings.js";
import { readUsdcBalance } from "./sweep.js";
import {
  executeTransfer,
  TransferError,
  type TransferArgs,
  type TransferResult,
} from "./transfer.js";
import type { WalletCeilingSweepPending, WalletName, WalletStore } from "./wallet-store.js";
import { BASE_MAINNET_CAIP2 } from "./x402-networks.js";

export const CEILING_SWEEP_MINIMUM_ATOMIC = 100_000n;
export const CEILING_SWEEP_GUARD_MS = 10 * 60 * 1_000;
export const CEILING_SWEEP_TIMEOUT_MS = 10_000;

export type SweepTargetAccount = {
  account: WalletName;
  owner: `0x${string}`;
  parent?: { account: WalletName; address: `0x${string}` };
};

/** The single recipient seam future swarm treasury routing will replace. */
export function sweepTarget(account: SweepTargetAccount): `0x${string}` {
  return account.parent?.address ?? account.owner;
}

/** A disabled ceiling stays disabled; otherwise the daily cap is its floor. */
export function effectiveCeiling(
  ceilingAtomic: bigint | null,
  perDayCapAtomic?: bigint | null,
): bigint | null {
  if (ceilingAtomic === null) return null;
  if (perDayCapAtomic === null || perDayCapAtomic === undefined) return ceilingAtomic;
  return ceilingAtomic > perDayCapAtomic ? ceilingAtomic : perDayCapAtomic;
}

/** True when the per-day cap, rather than the configured ceiling, sets the floor. */
export function ceilingFloorApplies(
  ceilingAtomic: bigint | null,
  perDayCapAtomic?: bigint | null,
): boolean {
  return (
    ceilingAtomic !== null &&
    perDayCapAtomic !== null &&
    perDayCapAtomic !== undefined &&
    perDayCapAtomic > ceilingAtomic
  );
}

export type CeilingSweepStatus = "swept" | "skipped" | "failed" | "unknown";
export type CeilingSweepResult = {
  account: WalletName;
  status: CeilingSweepStatus;
  reason?: string;
  amountUsd?: string;
  txHash?: string;
};

export type CeilingBalanceReader = (args: {
  address: `0x${string}`;
  signal?: AbortSignal;
}) => Promise<bigint>;

export type CeilingSiblingsFetcher = (args: {
  apiBase: string;
  account: WalletName;
  secrets: SecretStore;
  wallets: WalletStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
  timeoutMs?: number;
}) => Promise<SiblingsResult>;

export type CeilingTransfer = (args: TransferArgs) => Promise<TransferResult>;
export type CeilingAuthorizationStateReader = (input: {
  receipt: Receipt;
  pending: Readonly<WalletCeilingSweepPending>;
}) => Promise<AuthorizationState>;

export type SweepAboveCeilingArgs = {
  store: WalletStore;
  secrets: SecretStore;
  apiBase: string;
  account: WalletName;
  config?: VapiConfig;
  balanceReader?: CeilingBalanceReader;
  addressReader?: (account: WalletName) => Promise<string | undefined>;
  resolveParent?: (
    account: WalletName,
  ) => Promise<{ account: WalletName; address: `0x${string}` } | undefined>;
  fetchSiblingsImpl?: CeilingSiblingsFetcher;
  transfer?: CeilingTransfer;
  authorizationState?: CeilingAuthorizationStateReader;
  randomNonce?: () => Hex;
  unlock?: TransferArgs["unlock"];
  fetchImpl?: typeof fetch;
  lookup?: LookupFn;
  now?: () => number;
  signal?: AbortSignal;
  timeoutMs?: number;
  auditHome?: string;
  warn?: (message: string) => void;
};

/**
 * Best-effort Base USDC ceiling enforcement for one local account. Expected
 * network, link, balance, signing, and relay failures are returned, not thrown.
 */
export async function sweepAboveCeiling(args: SweepAboveCeilingArgs): Promise<CeilingSweepResult> {
  try {
    return await withCeilingSweepLock(args, async () => await sweepAboveCeilingLocked(args));
  } catch (error) {
    const now = args.now ?? Date.now;
    const reason = ceilingFailureReason(error);
    await auditFailure(args.auditHome ?? args.store.home, args.account, undefined, reason, now);
    return failed(args.account, reason);
  }
}

async function sweepAboveCeilingLocked(args: SweepAboveCeilingArgs): Promise<CeilingSweepResult> {
  const now = args.now ?? Date.now;
  const auditHome = args.auditHome ?? args.store.home;
  let owner: `0x${string}` | undefined;

  try {
    args.signal?.throwIfAborted();
    await args.store.reload();
    const entry = args.store.entry(args.account);
    if (entry?.link === undefined || !sameOrigin(entry.link.apiBase, args.apiBase)) {
      return skipped(args.account, "not_linked");
    }

    const caps = args.store.ceilingCaps(args.account);
    if (caps.effectiveCeilingAtomic === null) {
      return skipped(args.account, "ceiling_off");
    }

    const unresolvedMovement = await reconcileUnresolvedMovementsForAccountLocked(
      auditHome,
      args.account,
      {
        store: args.store,
        secrets: args.secrets,
        apiBase: args.apiBase,
        home: auditHome,
        ...(args.transfer === undefined ? {} : { transfer: args.transfer }),
        ...(args.addressReader === undefined ? {} : { addressReader: args.addressReader }),
        ...(args.fetchImpl === undefined ? {} : { fetchImpl: args.fetchImpl }),
        ...(args.now === undefined ? {} : { now: args.now }),
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
      },
    );
    if (unresolvedMovement !== undefined) {
      await auditFailure(auditHome, args.account, undefined, "unfinished_movement", now);
      return skipped(args.account, "unfinished_movement");
    }

    const rawAddress = await (args.addressReader ?? ((account) => args.store.readAddress(account)))(
      args.account,
    );
    if (rawAddress === undefined || !isAddress(rawAddress, { strict: false })) {
      return skipped(args.account, "address_unknown");
    }
    const address = getAddress(rawAddress);

    args.signal?.throwIfAborted();
    let siblingResult: SiblingsResult;
    try {
      siblingResult = await (args.fetchSiblingsImpl ?? fetchSiblings)({
        apiBase: args.apiBase,
        account: args.account,
        secrets: args.secrets,
        wallets: args.store,
        ...(args.fetchImpl === undefined ? {} : { fetchImpl: args.fetchImpl }),
        now,
        ...(args.signal === undefined ? {} : { signal: args.signal }),
        timeoutMs: args.timeoutMs ?? CEILING_SWEEP_TIMEOUT_MS,
      });
    } catch (error) {
      if (error instanceof SiblingsError && error.code === "not_linked") {
        return skipped(args.account, "revoked");
      }
      throw error;
    }
    const self =
      siblingResult.siblings.find((candidate) => candidate.self) ??
      siblingResult.siblings.find((candidate) => sameAddress(candidate.address, address));
    if (self?.status === "revoked") return skipped(args.account, "revoked");
    if (siblingResult.owner === null) return skipped(args.account, "no_known_owner");
    const serverOwner = siblingResult.owner;
    const linkedOwner = isAddress(entry.link.owner, { strict: false })
      ? getAddress(entry.link.owner)
      : undefined;
    if (linkedOwner === undefined || !sameAddress(linkedOwner, serverOwner)) {
      safeWarn(
        args.warn,
        `Refusing to sweep ${args.account}: its stored owner differs from the linked server owner.`,
      );
      await auditFailure(auditHome, args.account, serverOwner, "owner_mismatch", now);
      return failed(args.account, "owner_mismatch");
    }
    owner = linkedOwner;

    const readBalance = args.balanceReader ?? defaultBalanceReader(args);
    let pending = args.store.ceilingSweepPending(args.account);
    if (pending === undefined) {
      const initialBalance = await readBalance({
        address,
        ...(args.signal === undefined ? {} : { signal: args.signal }),
      });
      const initialAmount = initialBalance - caps.effectiveCeilingAtomic;
      if (initialAmount < CEILING_SWEEP_MINIMUM_ATOMIC) {
        return skipped(args.account, "below_threshold");
      }
    }

    args.signal?.throwIfAborted();
    const claimed = await args.store.claimCeilingSweepAttempt(
      args.account,
      new Date(now()),
      CEILING_SWEEP_GUARD_MS,
    );
    if (!claimed) return skipped(args.account, "throttled");

    // Ceiling sweeps keep their own pending record instead of a movement file;
    // movement-backed resume is deferred.
    if (pending !== undefined) {
      if (!sameAddress(pending.owner, owner)) {
        return {
          account: args.account,
          status: "unknown",
          reason: "pending_owner_changed",
          amountUsd: formatAtomicUsd(BigInt(pending.amountAtomic)),
        };
      }
    }
    const parent = await args.resolveParent?.(args.account);
    const target = sweepTarget({
      account: args.account,
      owner,
      ...(parent === undefined ? {} : { parent }),
    });

    if (pending !== undefined) {
      const reconciled = await executePendingSweep({
        args,
        pending,
        address,
        owner,
        target,
        sweepParent: parent?.address,
        readBalance,
      });
      if (reconciled !== undefined) return reconciled;
      pending = undefined;
    }

    // Network and registry waits above can make the first policy snapshot
    // stale. Reload the cap and balance together immediately before planning
    // the one authorization this attempt may sign.
    await args.store.reload();
    const currentEntry = args.store.entry(args.account);
    if (
      currentEntry?.link === undefined ||
      !sameOrigin(currentEntry.link.apiBase, args.apiBase) ||
      !sameAddress(currentEntry.link.owner, owner)
    ) {
      return skipped(args.account, "not_linked");
    }
    const currentCeiling = args.store.ceilingCaps(args.account).effectiveCeilingAtomic;
    if (currentCeiling === null) return skipped(args.account, "ceiling_off");
    const currentBalance = await readBalance({
      address,
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
    const amountAtomic = currentBalance - currentCeiling;
    if (amountAtomic < CEILING_SWEEP_MINIMUM_ATOMIC) {
      return skipped(args.account, "below_threshold");
    }
    args.signal?.throwIfAborted();

    pending = {
      owner,
      target,
      amountAtomic: amountAtomic.toString(),
      nonce: (args.randomNonce ?? (() => bytesToHex(randomBytes(32))))(),
      createdAt: new Date(now()).toISOString(),
      status: "planned",
    };
    const stored = await args.store.updateCeilingSweepPending(args.account, (current) =>
      current === undefined ? pending : { ...current },
    );
    if (stored === undefined) throw new Error("The ceiling sweep plan could not be stored.");
    return (
      (await executePendingSweep({
        args,
        pending: stored,
        address,
        owner,
        target,
        sweepParent: parent?.address,
        readBalance,
      })) ?? skipped(args.account, "below_threshold")
    );
  } catch (error) {
    const reason = ceilingFailureReason(error);
    await auditFailure(auditHome, args.account, owner, reason, now);
    return failed(args.account, reason);
  }
}

async function executePendingSweep(input: {
  args: SweepAboveCeilingArgs;
  pending: Readonly<WalletCeilingSweepPending>;
  address: `0x${string}`;
  owner: `0x${string}`;
  target: `0x${string}`;
  sweepParent?: `0x${string}`;
  readBalance: CeilingBalanceReader;
}): Promise<CeilingSweepResult | undefined> {
  const {
    args,
    pending,
    address,
    owner,
    target: currentTarget,
    sweepParent: currentSweepParent,
    readBalance,
  } = input;
  const now = args.now ?? Date.now;
  const auditHome = args.auditHome ?? args.store.home;
  const amountAtomic = BigInt(pending.amountAtomic);
  const amountUsd = formatAtomicUsd(amountAtomic);
  const hasJournal = await hasTransferJournal(auditHome, args.account, pending.nonce);
  // A `planned` row with no transfer receipt means no authorization reached
  // the durable transfer journal. Reusing its fixed nonce is safe. Once a
  // receipt exists (or this sweep already returned unknown), only resume.
  const resume = pending.status === "unknown" || hasJournal;
  const storedTarget = getAddress(pending.target ?? owner);
  if (!resume && !sameAddress(storedTarget, currentTarget)) {
    await clearPendingSweep(args.store, args.account, pending.nonce);
    return undefined;
  }
  const target = resume ? storedTarget : currentTarget;
  const sweepParent = resume
    ? !sameAddress(target, owner)
      ? target
      : undefined
    : currentSweepParent;

  try {
    const result = await executeTransfer(
      {
        store: args.store,
        secrets: args.secrets,
        apiBase: args.apiBase,
        from: args.account,
        to: target,
        amountUsd,
        network: "base",
        purpose: "sweep",
        ...(sweepParent === undefined ? {} : { sweepParent }),
        ...(resume ? { resume: pending.nonce as Hex } : { nonce: pending.nonce as Hex }),
        unlock: guardedSweepUnlock(args, address, owner, amountAtomic, readBalance),
        ...(args.fetchImpl === undefined ? {} : { fetchImpl: args.fetchImpl }),
        ...(args.signal === undefined ? {} : { signal: args.signal }),
        now,
        timeoutMs: args.timeoutMs ?? CEILING_SWEEP_TIMEOUT_MS,
        home: auditHome,
      },
      args.transfer,
    );

    if (result.status === "unknown") {
      await args.store.updateCeilingSweepPending(args.account, (current) =>
        current?.nonce === pending.nonce ? { ...current, status: "unknown" } : current,
      );
      await auditFailure(auditHome, args.account, owner, "transfer_unknown", now);
      return {
        account: args.account,
        status: "unknown",
        reason: "transfer_unknown",
        amountUsd,
        ...(result.txHash === null ? {} : { txHash: result.txHash }),
      };
    }

    await clearPendingSweep(args.store, args.account, pending.nonce);
    await safeAppendAudit(
      auditHome,
      {
        event: "ceiling.swept",
        wallet: args.account,
        owner,
        tty: false,
        detail: `amountUsd=${amountUsd}${result.txHash === null ? "" : ` txHash=${result.txHash}`}`,
      },
      now,
    );
    return {
      account: args.account,
      status: "swept",
      amountUsd,
      ...(result.txHash === null ? {} : { txHash: result.txHash }),
    };
  } catch (error) {
    const journaled =
      hasJournal || (await hasTransferJournal(auditHome, args.account, pending.nonce));
    if (pending.status === "planned" && !journaled) {
      await clearPendingSweep(args.store, args.account, pending.nonce);
      throw error;
    }
    if (!resume && error instanceof TransferError) {
      await clearPendingSweep(args.store, args.account, pending.nonce);
      throw error;
    }
    const state = await pendingAuthorizationState(args, pending, auditHome);
    if (state === "settled") {
      await clearPendingSweep(args.store, args.account, pending.nonce);
      await safeAppendAudit(
        auditHome,
        {
          event: "ceiling.swept",
          wallet: args.account,
          owner,
          tty: false,
          detail: `amountUsd=${amountUsd}`,
        },
        now,
      );
      return { account: args.account, status: "swept", amountUsd };
    }
    if (state === "expired") {
      await clearPendingSweep(args.store, args.account, pending.nonce);
      return undefined;
    }
    await args.store.updateCeilingSweepPending(args.account, (current) =>
      current?.nonce === pending.nonce ? { ...current, status: "unknown" } : current,
    );
    await auditFailure(
      auditHome,
      args.account,
      owner,
      error instanceof TransferError ? error.code : ceilingFailureReason(error),
      now,
    );
    return {
      account: args.account,
      status: "unknown",
      reason: "transfer_unknown",
      amountUsd,
    };
  }
}

async function clearPendingSweep(
  store: WalletStore,
  account: WalletName,
  nonce: string,
): Promise<void> {
  await store.updateCeilingSweepPending(account, (current) =>
    current?.nonce === nonce ? undefined : current,
  );
}

async function hasTransferJournal(
  home: string,
  account: WalletName,
  nonce: string,
): Promise<boolean> {
  const receipts = await readReceipts(getVapiPaths(home).receipts, { wallet: account });
  return receipts.some((receipt) => receipt.transfer?.nonce.toLowerCase() === nonce.toLowerCase());
}

async function pendingAuthorizationState(
  args: SweepAboveCeilingArgs,
  pending: Readonly<WalletCeilingSweepPending>,
  home: string,
): Promise<AuthorizationState | undefined> {
  try {
    const receipts = await readReceipts(getVapiPaths(home).receipts, { wallet: args.account });
    const receipt = [...receipts]
      .reverse()
      .find(
        (candidate) =>
          candidate.transfer?.nonce.toLowerCase() === pending.nonce.toLowerCase() &&
          candidate.transfer.request !== undefined,
      );
    const request = receipt?.transfer?.request;
    if (receipt === undefined || request === undefined) return undefined;
    const settlementReceipt: Receipt = {
      ...receipt,
      authorization: {
        from: request.authorization.from,
        nonce: request.authorization.nonce,
        validBefore: request.authorization.validBefore,
      },
    };
    if (args.authorizationState !== undefined) {
      return await args.authorizationState({ receipt: settlementReceipt, pending });
    }
    if (args.config === undefined) return undefined;
    const guardedFetch =
      args.fetchImpl ??
      createPublicFetch({
        allowPrivateNetwork: args.config.allowPrivateNetwork ?? false,
        ...(args.lookup === undefined ? {} : { lookup: args.lookup }),
      });
    return (
      await checkReceiptSettlement(settlementReceipt, args.config, {
        fetchImpl: withDeadlineSignal(guardedFetch, args.signal),
        ...(args.lookup === undefined ? {} : { lookup: args.lookup }),
      })
    ).state;
  } catch {
    // An unavailable chain verdict must leave the old nonce blocking.
    return undefined;
  }
}

function guardedSweepUnlock(
  args: SweepAboveCeilingArgs,
  address: `0x${string}`,
  owner: `0x${string}`,
  amountAtomic: bigint,
  readBalance: CeilingBalanceReader,
): NonNullable<TransferArgs["unlock"]> {
  const unlock =
    args.unlock ?? (async (account: WalletName) => await args.store.unlock(account, ""));
  return async (account) => {
    args.signal?.throwIfAborted();
    await args.store.reload();
    const entry = args.store.entry(account);
    if (
      entry?.link === undefined ||
      !sameOrigin(entry.link.apiBase, args.apiBase) ||
      !sameAddress(entry.link.owner, owner)
    ) {
      throw new CeilingPolicyChangedError();
    }
    const ceiling = args.store.ceilingCaps(account).effectiveCeilingAtomic;
    if (ceiling === null) throw new CeilingPolicyChangedError();
    const balance = await readBalance({
      address,
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
    if (balance - ceiling !== amountAtomic || amountAtomic < CEILING_SWEEP_MINIMUM_ATOMIC) {
      throw new CeilingPolicyChangedError();
    }
    args.signal?.throwIfAborted();
    const signer = await unlock(account);
    args.signal?.throwIfAborted();
    return {
      address: signer.address,
      signTypedData: async (typedData) => {
        args.signal?.throwIfAborted();
        const signature = await signer.signTypedData(typedData);
        args.signal?.throwIfAborted();
        return signature;
      },
    };
  };
}

export type SweepAllAboveCeilingArgs = Omit<SweepAboveCeilingArgs, "account">;

/** Runs local accounts in registry order; relay and registry work stays serial. */
export async function sweepAllAboveCeiling(
  args: SweepAllAboveCeilingArgs,
): Promise<CeilingSweepResult[]> {
  await args.store.reload();
  const results: CeilingSweepResult[] = [];
  for (const account of args.store.names()) {
    results.push(await sweepAboveCeiling({ ...args, account }));
  }
  return results;
}

export type CeilingSweepHook = {
  account: WalletName;
  auditHome: string;
  run: (signal: AbortSignal) => Promise<unknown>;
  timeoutMs?: number;
  now?: () => number;
};

const pendingCeilingSweeps = new Set<Promise<void>>();

/** Starts a settled-call sweep off the result path and tracks it for short-lived clients. */
export function scheduleCeilingSweep(hook: CeilingSweepHook): void {
  const task: Promise<void> = new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  })
    .then(async () => {
      const timeoutMs = hook.timeoutMs ?? CEILING_SWEEP_TIMEOUT_MS;
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          hook.run(controller.signal),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              controller.abort();
              reject(new CeilingSweepTimeoutError());
            }, timeoutMs);
            timeout.unref();
          }),
        ]);
      } catch (error) {
        await auditFailure(
          hook.auditHome,
          hook.account,
          undefined,
          ceilingFailureReason(error),
          hook.now ?? Date.now,
        );
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    })
    .finally(() => pendingCeilingSweeps.delete(task));
  pendingCeilingSweeps.add(task);
}

/** Waits for currently queued sweeps without holding a CLI longer than the bound. */
export async function drainCeilingSweeps(timeoutMs = CEILING_SWEEP_TIMEOUT_MS): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error("The ceiling sweep drain timeout must be a non-negative duration.");
  }
  const pending = [...pendingCeilingSweeps];
  if (pending.length === 0) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

class CeilingSweepTimeoutError extends Error {
  readonly code = "timeout";
}

class CeilingPolicyChangedError extends Error {
  readonly code = "policy_changed";
}

async function withCeilingSweepLock<T>(
  args: SweepAboveCeilingArgs,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await withSwarmAccountMovementLocks(
      args.store.home,
      [args.account],
      args.timeoutMs ?? CEILING_SWEEP_TIMEOUT_MS,
      operation,
      args.signal,
    );
  } catch (error) {
    if (error instanceof AccountMovementLockedError) throw new CeilingSweepTimeoutError();
    throw error;
  }
}

function defaultBalanceReader(args: SweepAboveCeilingArgs): CeilingBalanceReader {
  return async ({ address, signal }) => {
    const configured =
      args.config === undefined
        ? undefined
        : configuredNetworkFor(args.config.networks, BASE_MAINNET_CAIP2);
    if (configured === undefined) throw new Error("Base is not configured for ceiling sweeps.");
    const guardedFetch =
      args.fetchImpl ??
      createPublicFetch({
        allowPrivateNetwork: args.config?.allowPrivateNetwork ?? false,
        ...(args.lookup === undefined ? {} : { lookup: args.lookup }),
      });
    return await readUsdcBalance({
      network: BASE_MAINNET_CAIP2,
      configured,
      address,
      allowPrivateNetwork: args.config?.allowPrivateNetwork,
      fetchImpl: withDeadlineSignal(guardedFetch, signal),
      ...(args.lookup === undefined ? {} : { lookup: args.lookup }),
    });
  };
}

function withDeadlineSignal(fetchImpl: typeof fetch, deadline?: AbortSignal): typeof fetch {
  if (deadline === undefined) return fetchImpl;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal =
      requestSignal === undefined || requestSignal === deadline
        ? deadline
        : AbortSignal.any([requestSignal, deadline]);
    return await fetchImpl(input, { ...init, signal });
  }) as typeof fetch;
}

function skipped(account: WalletName, reason: string): CeilingSweepResult {
  return { account, status: "skipped", reason };
}

function failed(account: WalletName, reason: string): CeilingSweepResult {
  return { account, status: "failed", reason };
}

function formatAtomicUsd(amountAtomic: bigint): string {
  const whole = amountAtomic / 1_000_000n;
  const fraction = (amountAtomic % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function sameAddress(left: string, right: string): boolean {
  return (
    isAddress(left, { strict: false }) &&
    isAddress(right, { strict: false }) &&
    getAddress(left) === getAddress(right)
  );
}

function safeWarn(warn: SweepAboveCeilingArgs["warn"], message: string): void {
  try {
    (warn ?? ((value) => process.stderr.write(`${value}\n`)))(message);
  } catch {
    // A diagnostic sink cannot change whether money moves.
  }
}

function ceilingFailureReason(error: unknown): string {
  if (error instanceof TransferError) return error.code;
  if (error instanceof SiblingsError) return `siblings_${error.code}`;
  if (error instanceof CeilingSweepTimeoutError) return error.code;
  if (error instanceof CeilingPolicyChangedError) return error.code;
  if (error instanceof DOMException && error.name === "AbortError") return "aborted";
  return "unexpected_error";
}

async function auditFailure(
  home: string,
  account: WalletName,
  owner: string | undefined,
  reason: string,
  now: () => number,
): Promise<void> {
  await safeAppendAudit(
    home,
    {
      event: "ceiling.sweep_failed",
      wallet: account,
      ...(owner === undefined ? {} : { owner }),
      tty: false,
      detail: `reason=${reason}`,
    },
    now,
  );
}

async function safeAppendAudit(
  home: string,
  record: AuditRecord,
  now: () => number,
): Promise<void> {
  await appendAudit(home, record, { now: () => new Date(now()) }).catch(() => undefined);
}
