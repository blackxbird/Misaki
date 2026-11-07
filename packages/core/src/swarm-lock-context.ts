import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";

import { withAccountMovementLocks } from "./account-movement-lock.js";
import { listUnfinishedMovements, readMovement } from "./movement.js";
import { listSwarms, swarmAccountNames, SwarmError, withSwarmLock } from "./swarm.js";
import { resolveSenderOwnership } from "./swarm-sender.js";
import { WalletStore } from "./wallet-store.js";
import { walletNameSchema } from "./wallet-name.js";

export type CapitalLockRequest = {
  swarms?: readonly string[];
  accounts?: readonly string[];
  /** Metadata-only operations must not parse or acquire unrelated swarm state. */
  metadataOnly?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
};
type LockPlan = {
  home: string;
  swarms: Set<string>;
  accounts: Set<string>;
  heldSwarms: Set<string>;
  heldAccounts: Set<string>;
  active: boolean;
  phase: "acquiring" | "running";
  metadataOnly: boolean;
};
const registryKey = Symbol.for("@vapi-network/core/capital-lock-plan/v2");
const registry = globalThis as typeof globalThis & { [registryKey]?: AsyncLocalStorage<LockPlan> };
const plans = (registry[registryKey] ??= new AsyncLocalStorage<LockPlan>());

/** Plain metadata locks retain their non-reentrant busy-account contract. */
export function mayReuseAccountLock(): boolean {
  return plans.getStore()?.metadataOnly === false;
}

export function capitalLockAccess(
  home: string,
  kind: "swarm" | "account",
  name: string,
): "outside" | "acquire" | "reuse" {
  const plan = plans.getStore();
  if (!plan?.active) return "outside";
  const declared = kind === "swarm" ? plan.swarms : plan.accounts;
  const held = kind === "swarm" ? plan.heldSwarms : plan.heldAccounts;
  if (
    plan.home !== resolve(home) ||
    !declared.has(name) ||
    (plan.phase === "running" && !held.has(name))
  ) {
    throw new SwarmError(
      "swarm_locked",
      `The ${kind} ${name} is not in the pre-acquired lock set. Retry the operation with its complete lock set.`,
    );
  }
  return held.has(name) ? "reuse" : "acquire";
}

async function track<T>(
  home: string,
  kind: "swarm" | "account",
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  const plan = plans.getStore();
  if (!plan?.active || plan.home !== resolve(home))
    throw new Error("No capital lock plan owns this acquisition.");
  const held = kind === "swarm" ? plan.heldSwarms : plan.heldAccounts;
  held.add(name);
  try {
    return await operation();
  } finally {
    held.delete(name);
  }
}
export async function trackSwarmLock<T>(
  home: string,
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  return await track(home, "swarm", name, operation);
}
export async function trackAccountLock<T>(
  home: string,
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  return await track(home, "account", name, operation);
}

function addAccount(accounts: Set<string>, name: string): void {
  if (name !== "owner" && walletNameSchema.safeParse(name).success) accounts.add(name);
}

/** Plan the whole connected operation before acquiring anything; nested plans may only reuse it. */
export async function withCapitalLocks<T>(
  home: string,
  request: CapitalLockRequest,
  operation: () => Promise<T>,
): Promise<T> {
  const swarms = new Set(request.swarms ?? []);
  const accounts = new Set(request.accounts ?? []);
  if (!request.metadataOnly) {
    const known = await listSwarms(home);
    const store = await WalletStore.open(home);
    const movements = await Promise.all(
      (await listUnfinishedMovements({ home })).map(
        async (item) => await readMovement(home, item.id),
      ),
    );
    let previous = "";
    while (previous !== `${[...swarms].sort()}|${[...accounts].sort()}`) {
      previous = `${[...swarms].sort()}|${[...accounts].sort()}`;
      for (const swarm of known) {
        const members = swarmAccountNames(swarm);
        if (swarms.has(swarm.name)) {
          for (const account of members) accounts.add(account);
        }
      }
      const ownership = await resolveSenderOwnership(store, { accounts: [...accounts] });
      for (const alias of ownership.accounts) accounts.add(alias);
      for (const swarm of ownership.swarms) swarms.add(swarm.name);
      for (const movement of movements) {
        if (!movement.legs.some((leg) => accounts.has(leg.from) || accounts.has(leg.to))) continue;
        for (const leg of movement.legs) {
          addAccount(accounts, leg.from);
          addAccount(accounts, leg.to);
        }
      }
    }
  }
  const existing = plans.getStore();
  if (existing?.active) {
    for (const name of swarms)
      if (capitalLockAccess(home, "swarm", name) !== "reuse")
        throw new Error("Nested swarm acquisition during lock planning.");
    for (const name of accounts)
      if (capitalLockAccess(home, "account", name) !== "reuse")
        throw new Error("Nested account acquisition during lock planning.");
    return await operation();
  }
  const plan: LockPlan = {
    home: resolve(home),
    swarms,
    accounts,
    heldSwarms: new Set(),
    heldAccounts: new Set(),
    active: true,
    phase: "acquiring",
    metadataOnly: request.metadataOnly === true,
  };
  // Swarms first (by name), then accounts (by name), in every process.
  const names = [...swarms].sort();
  const acquire = async (index: number): Promise<T> => {
    if (index < names.length)
      return await withSwarmLock(home, names[index]!, async () => await acquire(index + 1));
    return await withAccountMovementLocks(
      home,
      [...accounts].sort(),
      request.timeoutMs,
      async () => {
        request.signal?.throwIfAborted();
        plan.phase = "running";
        return await operation();
      },
    );
  };
  try {
    return await plans.run(plan, async () => await acquire(0));
  } finally {
    plan.active = false;
  }
}

export async function withSwarmMovementLock<T>(
  home: string,
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  return await withCapitalLocks(home, { swarms: [name] }, operation);
}
export async function withSwarmAccountLocks<T>(
  home: string,
  accounts: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  return await withCapitalLocks(home, { accounts }, operation);
}
