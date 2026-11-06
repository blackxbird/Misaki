import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { isMissingFile } from "./config.js";
import {
  capitalLockAccess,
  mayReuseAccountLock,
  trackAccountLock,
  withCapitalLocks,
} from "./swarm-lock-context.js";
import type { WalletName } from "./wallet-name.js";

export class AccountMovementLockedError extends Error {
  readonly code = "account_movement_locked";

  constructor(readonly account: WalletName) {
    super(`Another capital movement is already running for account ${account}.`);
    this.name = "AccountMovementLockedError";
  }
}

/** Serializes every signer that can create an EIP-3009 authorization for one account. */
export async function withAccountMovementLock<T>(
  home: string,
  account: WalletName,
  timeoutMs: number | undefined,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const access = capitalLockAccess(home, "account", account);
  if (access === "outside")
    return await withCapitalLocks(
      home,
      {
        accounts: [account],
        metadataOnly: true,
        timeoutMs,
        ...(signal === undefined ? {} : { signal }),
      },
      operation,
    );
  if (access === "reuse") {
    if (!mayReuseAccountLock()) throw new AccountMovementLockedError(account);
    return await operation();
  }
  const directory = join(home, "movements");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `.${account}.lock`);
  const deadline = Date.now() + (timeoutMs ?? 2_000);
  const owner = JSON.stringify({ pid: process.pid, token: randomBytes(16).toString("hex") });
  let handle: FileHandle | undefined;
  while (handle === undefined) {
    signal?.throwIfAborted();
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(owner, "utf8");
      await handle.sync();
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      await removeStaleLock(path);
      if (Date.now() >= deadline) throw new AccountMovementLockedError(account);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  const ownedHandle = handle;
  const heartbeat = setInterval(() => {
    const time = new Date();
    void ownedHandle.utimes(time, time).catch(() => undefined);
  }, 30_000);
  heartbeat.unref();
  try {
    return await trackAccountLock(home, account, operation);
  } finally {
    clearInterval(heartbeat);
    await ownedHandle.close();
    await unlinkOwnedLock(path, owner);
  }
}

export async function withAccountMovementLocks<T>(
  home: string,
  accounts: readonly WalletName[],
  timeoutMs: number | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (accounts.length > 0 && capitalLockAccess(home, "account", accounts[0]!) === "outside")
    return await withCapitalLocks(home, { accounts, metadataOnly: true, timeoutMs }, operation);
  for (const account of accounts) capitalLockAccess(home, "account", account);
  return await acquireAccountMovementLocks(
    home,
    [...new Set(accounts)].sort(),
    timeoutMs,
    operation,
  );
}

async function acquireAccountMovementLocks<T>(
  home: string,
  accounts: readonly WalletName[],
  timeoutMs: number | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const [account, ...remaining] = accounts;
  if (account === undefined) return await operation();
  return await withAccountMovementLock(home, account, timeoutMs, async () =>
    acquireAccountMovementLocks(home, remaining, timeoutMs, operation),
  );
}

/** Money paths take all swarm locks before sender locks; metadata operations keep the plain account lock. */
export async function withSwarmAccountMovementLocks<T>(
  home: string,
  accounts: readonly WalletName[],
  timeoutMs: number | undefined,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return await withCapitalLocks(
    home,
    { accounts, timeoutMs, ...(signal === undefined ? {} : { signal }) },
    operation,
  );
}

async function removeStaleLock(path: string): Promise<void> {
  try {
    const metadata = await stat(path);
    if (Date.now() - metadata.mtimeMs <= 120_000) return;
    const owner = await readFile(path, "utf8").catch(() => "");
    const pid = lockOwnerPid(owner);
    if (pid !== undefined && processIsAlive(pid)) return;
    await unlinkOwnedLock(path, owner);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

async function unlinkOwnedLock(path: string, owner: string): Promise<void> {
  try {
    if ((await readFile(path, "utf8")) === owner) await unlink(path);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

function lockOwnerPid(owner: string): number | undefined {
  try {
    const value: unknown = JSON.parse(owner);
    if (typeof value !== "object" || value === null) return undefined;
    const pid = Reflect.get(value, "pid");
    return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}
