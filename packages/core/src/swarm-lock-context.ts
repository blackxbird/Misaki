import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";

import { listSwarms, swarmAccountNames, withSwarmLock } from "./swarm.js";

type HeldLock = { home: string; name: string; active: boolean };
// CLI/MCP tarballs bundle independent core copies. Share ownership context,
// which contains only paths and lifecycle flags, through Node's symbol registry.
const registryKey = Symbol.for("@vapi-network/core/swarm-lock-context/v1");
const registry = globalThis as typeof globalThis & {
  [registryKey]?: AsyncLocalStorage<HeldLock[]>;
};
const heldLocks = (registry[registryKey] ??= new AsyncLocalStorage<HeldLock[]>());

/** Internal ownership context: movement execution can reuse its caller's lock. */
export async function trackSwarmLock<T>(
  home: string,
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  const owner = { home: resolve(home), name, active: true };
  try {
    return await heldLocks.run([...(heldLocks.getStore() ?? []), owner], operation);
  } finally {
    owner.active = false;
  }
}

export async function withSwarmMovementLock<T>(
  home: string,
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (
    heldLocks
      .getStore()
      ?.some((owner) => owner.active && owner.home === resolve(home) && owner.name === name)
  ) {
    return await operation();
  }
  return await withSwarmLock(home, name, operation);
}

/** Acquire every sender's swarm lock before any account lock, in stable order. */
export async function withSwarmAccountLocks<T>(
  home: string,
  accounts: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const senders = new Set(accounts);
  const names = (await listSwarms(home))
    .filter((swarm) => swarmAccountNames(swarm).some((account) => senders.has(account)))
    .map((swarm) => swarm.name)
    .sort();
  const acquire = async (index: number): Promise<T> =>
    names[index] === undefined
      ? await operation()
      : await withSwarmMovementLock(home, names[index]!, async () => await acquire(index + 1));
  return await acquire(0);
}
