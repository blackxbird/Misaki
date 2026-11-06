import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";

import { withSwarmLock } from "./swarm.js";

type HeldLock = { home: string; name: string; active: boolean };
const heldLocks = new AsyncLocalStorage<HeldLock[]>();

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
