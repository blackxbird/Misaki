import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { bytesToHex, getAddress, isAddress, type Hex } from "viem";
import { z } from "zod";

import { formatUsdCents, parseUsdCents, RELAY_MAX_PER_TRANSFER_ATOMIC } from "./allocation.js";
import { AccountMovementLockedError, withAccountMovementLocks } from "./account-movement-lock.js";
import { checkReceiptSettlement, type AuthorizationState } from "./authorization-state.js";
import { getVapiPaths, isMissingFile, loadConfig } from "./config.js";
import { isOpenMovementLeg } from "./movement-open.js";
import { explorerAddressUrl } from "./networks.js";
import type { Receipt } from "./receipts.js";
import type { SecretStore } from "./secret-store.js";
import { releaseSpend } from "./spend-policy.js";
import { dissolutionSwarm } from "./swarm-dissolution.js";
import { withSwarmMovementLock } from "./swarm-lock-context.js";
import { assertSwarmWorkersStopped } from "./swarm-workers.js";
import { readSwarm } from "./swarm.js";
import { readTransferJournal, type TransferJournal } from "./transfer-journal.js";
import {
  transferBetweenAccounts,
  TransferError,
  type TransferArgs,
  type TransferNetwork,
  type TransferResult,
} from "./transfer.js";
import { walletNameSchema, type WalletName } from "./wallet-name.js";
import { ARC_MAINNET_CAIP2, BASE_MAINNET_CAIP2 } from "./x402-networks.js";

const movementIdSchema = z.string().regex(/^mv_[A-Za-z0-9_-]{8,128}$/);
const nonceSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const amountSchema = z.string().regex(/^\d+\.\d{2}$/);
const movementReasonSchema = z.enum([
  "distribute",
  "allocate",
  "rebalance",
  "delegate",
  "sweep",
  "send",
]);
const movementPurposeSchema = z.enum(["send", "sweep"]);
const movementAddressSchema = z.string().refine((value) => isAddress(value, { strict: false }));
const movementLegSchema = z.strictObject({
  from: walletNameSchema,
  to: z.string().trim().min(1),
  fromAddress: movementAddressSchema.optional(),
  toAddress: movementAddressSchema.optional(),
  amountUsd: amountSchema,
  purpose: movementPurposeSchema,
  nonce: nonceSchema,
  status: z.enum(["planned", "sent", "failed", "unknown", "cancelled"]),
  txHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/)
    .optional(),
  reason: z.string().min(1).optional(),
  retryable: z.boolean().optional(),
  restored: z.literal(true).optional(),
  addressBindingSource: z.enum(["journal", "terminal-review"]).optional(),
});
const movementSchema = z.strictObject({
  v: z.literal(2),
  id: movementIdSchema,
  reason: movementReasonSchema,
  from: walletNameSchema,
  // The only account a `sweep` leg may name besides the owner. Sweeps skip the
  // spend caps, so the parent comes from the plan, never from a leg's `to`.
  treasury: walletNameSchema.optional(),
  dissolution: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,15}$/u)
    .optional(),
  network: z.enum([BASE_MAINNET_CAIP2, ARC_MAINNET_CAIP2]),
  createdAt: z.iso.datetime(),
  legs: z.array(movementLegSchema).min(1),
});
const legacyMovementSchema = z.strictObject({
  v: z.literal(1),
  id: movementIdSchema,
  reason: z.literal("distribute"),
  from: walletNameSchema,
  network: z.enum([BASE_MAINNET_CAIP2, ARC_MAINNET_CAIP2]),
  createdAt: z.iso.datetime(),
  legs: z
    .array(
      z.strictObject({
        to: z.string().trim().min(1),
        amountUsd: amountSchema,
        nonce: nonceSchema,
        status: z.enum(["planned", "sent", "failed", "unknown"]),
        txHash: z
          .string()
          .regex(/^0x[0-9a-fA-F]+$/)
          .optional(),
        reason: z.string().min(1).optional(),
        retryable: z.boolean().optional(),
      }),
    )
    .min(1),
});

export type MovementLeg = z.infer<typeof movementLegSchema>;
export type Movement = z.infer<typeof movementSchema>;
export type MovementPlan = {
  reason: Movement["reason"];
  from: WalletName;
  treasury?: WalletName;
  /** Swarm whose dissolution owns these legs, including member-to-treasury sweeps. */
  dissolution?: string;
  network: TransferNetwork;
  legs: readonly {
    from?: WalletName;
    to: string;
    amountUsd: string;
    purpose?: MovementLeg["purpose"];
  }[];
};
export type MovementSummary = {
  id: string;
  from: WalletName;
  network: TransferNetwork;
  createdAt: string;
  pendingLegs: number;
  unknownLegs: number;
};
export type UnfinishedMovementSnapshot = {
  movement: Movement;
  summary: MovementSummary;
  signedFailedLegKeys: readonly string[];
};
export type MovementAuthorizationStateReader = (input: {
  movement: Movement;
  leg: MovementLeg;
  validBefore?: string;
}) => Promise<AuthorizationState>;
export type MovementTransfer = (args: TransferArgs) => Promise<TransferResult>;
export type MovementDependencies = {
  store: TransferArgs["store"];
  secrets: SecretStore;
  apiBase: string;
  home?: string;
  transfer?: MovementTransfer;
  authorizationState?: MovementAuthorizationStateReader;
  addressReader?: (account: WalletName) => Promise<string | undefined>;
  recipientAddressReader?: (from: WalletName, recipient: string) => Promise<string | undefined>;
  now?: () => number;
  randomId?: () => string;
  randomNonce?: () => Hex;
  unlock?: TransferArgs["unlock"];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  ledgerPath?: string;
  lockTimeoutMs?: number;
  replaceExpiredRestored?: boolean;
  bindLegacyAddresses?: boolean;
};

export class MovementError extends Error {
  constructor(
    readonly code:
      | "invalid_movement"
      | "movement_not_found"
      | "unfinished_movement"
      | "movement_locked"
      | "ceiling_sweep_pending"
      | "movement_address_unbound"
      | "account_address_mismatch"
      | "restored_leg_review"
      | "movement_not_cancellable",
    message: string,
    readonly movementId?: string,
  ) {
    super(message);
    this.name = "MovementError";
  }
}

/** Creates and executes a movement, or resumes one already journaled on disk. */
export async function executeMovement(
  plan: MovementPlan | { resume: string },
  deps: MovementDependencies,
): Promise<Movement> {
  const home = deps.home ?? deps.store.home;
  const initial = "resume" in plan ? await readMovement(home, parseMovementId(plan.resume)) : plan;
  const swarm = await dissolutionSwarm(home, initial);
  if (swarm !== undefined) {
    // Always acquire the swarm lock before any sender/account movement lock.
    return await withSwarmMovementLock(home, swarm.name, async () => {
      await assertSwarmWorkersStopped(home, await readSwarm(home, swarm.name));
      return await executeMovementLocked(plan, deps);
    });
  }
  return await executeMovementLocked(plan, deps);
}

async function executeMovementLocked(
  plan: MovementPlan | { resume: string },
  deps: MovementDependencies,
): Promise<Movement> {
  const home = deps.home ?? deps.store.home;
  if ("resume" in plan) {
    const id = parseMovementId(plan.resume);
    const initial = await readMovement(home, id);
    return await withMovementLocks(home, movementSenders(initial), deps.lockTimeoutMs, async () => {
      const movement = await readMovement(home, id);
      await assertNoPendingCeilingSweep(deps, movementSenders(movement));
      return await resumeMovement(movement, home, deps);
    });
  }

  if (plan.legs.length === 0) {
    throw new MovementError("invalid_movement", "A movement needs at least one leg.");
  }
  plan = splitMovementPlanAtRelayLimit(plan);
  const from = walletNameSchema.parse(plan.from);
  const legs = plan.legs.map((leg) => ({
    ...leg,
    from: walletNameSchema.parse(leg.from ?? from),
    purpose: leg.purpose ?? ("send" as const),
  }));
  const senders = sortedUniqueSenders(legs.map((leg) => leg.from));

  return await withMovementLocks(home, senders, deps.lockTimeoutMs, async () => {
    await assertNoPendingCeilingSweep(deps, senders);
    const conflict = await firstUnfinishedMovement(home, senders);
    if (conflict !== undefined) {
      throw new MovementError(
        "unfinished_movement",
        `Account ${conflict.from} has unfinished movement ${conflict.movement.id}. Resume it with vapi accounts distribute --resume ${conflict.movement.id}. If it cannot resume, wait for any signed authorization to expire and run vapi accounts distribute --cancel ${conflict.movement.id}.`,
        conflict.movement.id,
      );
    }
    for (const leg of legs) {
      if (leg.purpose === "sweep" && !isOwnerSweep(leg.to) && leg.to !== plan.treasury) {
        throw new MovementError(
          "invalid_movement",
          "A sweep leg can only go to the owner or the movement's treasury.",
        );
      }
    }
    const boundLegs = [];
    for (const leg of legs) {
      boundLegs.push(await bindLegAddresses(leg, deps));
    }
    const now = deps.now ?? Date.now;
    const movement = movementSchema.parse({
      v: 2,
      id: (deps.randomId ?? createMovementId)(),
      reason: plan.reason,
      from,
      ...(plan.treasury === undefined ? {} : { treasury: plan.treasury }),
      ...(plan.dissolution === undefined ? {} : { dissolution: plan.dissolution }),
      network: plan.network,
      createdAt: new Date(now()).toISOString(),
      legs: boundLegs.map((leg) => ({
        ...leg,
        nonce: (deps.randomNonce ?? createMovementNonce)(),
        status: "planned" as const,
      })),
    });
    await writeMovement(home, movement);
    return await executePlannedLegs(movement, home, deps);
  });
}

/** Terminates every leg that can no longer settle, without signing or relaying anything. */
export async function cancelMovement(id: string, deps: MovementDependencies): Promise<Movement> {
  const home = deps.home ?? deps.store.home;
  const safeId = parseMovementId(id);
  const initial = await readMovement(home, safeId);
  return await withMovementLocks(home, movementSenders(initial), deps.lockTimeoutMs, async () => {
    const movement = await readMovement(home, safeId);
    return await cancelMovementLocked(movement, home, deps);
  });
}

async function cancelMovementLocked(
  initial: Movement,
  home: string,
  deps: MovementDependencies,
): Promise<Movement> {
  let movement = initial;
  const expired: { leg: MovementLeg; journal: TransferJournal }[] = [];

  // Preflight every leg before changing the movement or spend ledger. One
  // authorization that may still settle refuses the whole cancellation.
  for (let index = 0; index < movement.legs.length; index += 1) {
    const leg = movement.legs[index]!;
    if (leg.status === "sent" || leg.status === "cancelled") continue;
    const journal = await readTransferJournal(home, leg.from, leg.nonce);
    if (journal.latest?.transfer?.status === "sent") {
      movement = replaceLeg(
        movement,
        index,
        sentLeg(
          leg,
          journal.latest.transfer.txHash === null ? undefined : journal.latest.transfer.txHash,
        ),
      );
      continue;
    }
    if (leg.restored === true) {
      if (!journal.signed) {
        // An unknown leg's own saved nonce may still settle, and without its
        // journal the chain cannot be checked; the override does not cover it.
        if (leg.status === "unknown") throw unknownCancellationError(movement, leg);
        if (deps.replaceExpiredRestored !== true) {
          await throwRestoredCancellationReview(movement, leg, deps);
        }
        movement = replaceLeg(movement, index, cancelledLeg(leg));
        continue;
      }
      let state: AuthorizationState;
      try {
        state = await authorizationState(movement, leg, journal.validBefore, home, deps);
      } catch (error) {
        return await throwRestoredCancellationReview(movement, leg, deps, error);
      }
      if (state === "settled") {
        movement = replaceLeg(movement, index, sentLeg(leg));
        continue;
      }
      if (deps.replaceExpiredRestored !== true) {
        return await throwRestoredCancellationReview(movement, leg, deps);
      }
      if (state === "pending") throw pendingCancellationError(movement, leg);
      movement = replaceLeg(movement, index, cancelledLeg(leg));
      expired.push({ leg, journal });
      continue;
    }
    if (!journal.signed) {
      if (leg.status === "unknown") throw unknownCancellationError(movement, leg);
      movement = replaceLeg(movement, index, cancelledLeg(leg));
      continue;
    }

    let state: AuthorizationState;
    try {
      state = await authorizationState(movement, leg, journal.validBefore, home, deps);
    } catch (error) {
      throw unprovenCancellationError(movement, leg, error);
    }
    if (state === "settled") {
      movement = replaceLeg(movement, index, sentLeg(leg));
      continue;
    }
    if (state === "pending") throw pendingCancellationError(movement, leg);
    movement = replaceLeg(movement, index, cancelledLeg(leg));
    expired.push({ leg, journal });
  }

  for (const terminal of expired) {
    await releaseExpiredReservation(terminal.leg, terminal.journal, home, deps);
  }
  if (movement !== initial) await writeMovement(home, movement);
  return movement;
}

/** Splits lifecycle sweeps and swarm funding into durable relay-sized legs before journaling. */
export function splitMovementPlanAtRelayLimit(plan: MovementPlan): MovementPlan {
  const maximumCents = RELAY_MAX_PER_TRANSFER_ATOMIC / 10_000n;
  const legs = plan.legs.flatMap((leg) => {
    const purpose = leg.purpose ?? "send";
    const split =
      purpose === "sweep" ||
      (plan.reason === "send" && plan.treasury !== undefined && leg.to === plan.treasury);
    let remaining = parseUsdCents(leg.amountUsd);
    if (!split || remaining <= maximumCents) return [leg];
    const parts: MovementPlan["legs"][number][] = [];
    while (remaining > 0n) {
      const cents = remaining > maximumCents ? maximumCents : remaining;
      parts.push({ ...leg, amountUsd: formatUsdCents(cents) });
      remaining -= cents;
    }
    return parts;
  });
  return { ...plan, legs };
}

export async function listUnfinishedMovements(options: {
  home: string;
  from?: string;
}): Promise<MovementSummary[]> {
  const directory = movementsDirectory(options.home);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  const summaries: MovementSummary[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith(".json")).sort()) {
    const movement = parseMovement(JSON.parse(await readFile(join(directory, name), "utf8")));
    if (options.from !== undefined && !movement.legs.some((leg) => leg.from === options.from)) {
      continue;
    }
    const pendingLegs = movement.legs.filter((leg) => leg.status === "planned").length;
    const unknownLegs = movement.legs.filter((leg) => leg.status === "unknown").length;
    if (!(await movementHasOpenLeg(options.home, movement, options.from))) continue;
    summaries.push({
      id: movement.id,
      from: movement.from,
      network: movement.network,
      createdAt: movement.createdAt,
      pendingLegs,
      unknownLegs,
    });
  }
  return summaries.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
}

/** Internal backup snapshot with the journal evidence used to keep failed legs open. */
export async function listUnfinishedMovementSnapshots(options: {
  home: string;
  from?: string;
}): Promise<UnfinishedMovementSnapshot[]> {
  const directory = movementsDirectory(options.home);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  const snapshots: UnfinishedMovementSnapshot[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith(".json")).sort()) {
    const movement = parseMovement(JSON.parse(await readFile(join(directory, name), "utf8")));
    if (options.from !== undefined && !movement.legs.some((leg) => leg.from === options.from)) {
      continue;
    }
    const pendingLegs = movement.legs.filter((leg) => leg.status === "planned").length;
    const unknownLegs = movement.legs.filter((leg) => leg.status === "unknown").length;
    const evidence = await movementOpenEvidence(options.home, movement, options.from);
    if (!evidence.open) continue;
    snapshots.push({
      movement,
      summary: {
        id: movement.id,
        from: movement.from,
        network: movement.network,
        createdAt: movement.createdAt,
        pendingLegs,
        unknownLegs,
      },
      signedFailedLegKeys: evidence.signedFailedLegKeys,
    });
  }
  return snapshots.sort(
    (left, right) =>
      left.summary.createdAt.localeCompare(right.summary.createdAt) ||
      left.summary.id.localeCompare(right.summary.id),
  );
}

/** Uses the transfer journal to distinguish signed failed legs from terminal unsigned ones. */
export async function movementHasOpenLeg(
  home: string,
  movement: Movement,
  from?: string,
): Promise<boolean> {
  for (const leg of movement.legs) {
    if (from !== undefined && leg.from !== from) continue;
    if (isOpenMovementLeg(leg, "unsigned")) return true;
    if (leg.status !== "failed") continue;
    const journal = await readTransferJournal(home, leg.from, leg.nonce);
    if (isOpenMovementLeg(leg, journal.signed ? "signed" : "unsigned")) return true;
  }
  return false;
}

async function movementOpenEvidence(
  home: string,
  movement: Movement,
  from?: string,
): Promise<{ open: boolean; signedFailedLegKeys: string[] }> {
  let open = false;
  const signedFailedLegKeys: string[] = [];
  for (const leg of movement.legs) {
    if (from !== undefined && leg.from !== from) continue;
    if (isOpenMovementLeg(leg, "unsigned")) open = true;
    if (leg.status !== "failed") continue;
    const journal = await readTransferJournal(home, leg.from, leg.nonce);
    if (journal.signed) signedFailedLegKeys.push(movementTransferKey(leg.from, leg.nonce));
    if (isOpenMovementLeg(leg, journal.signed ? "signed" : "unsigned")) open = true;
  }
  return { open, signedFailedLegKeys };
}

export async function readMovement(home: string, id: string): Promise<Movement> {
  const safeId = parseMovementId(id);
  try {
    return parseMovement(
      JSON.parse(await readFile(join(movementsDirectory(home), `${safeId}.json`), "utf8")),
    );
  } catch (error) {
    if (isMissingFile(error)) {
      throw new MovementError(
        "movement_not_found",
        `No movement named ${safeId} was found.`,
        safeId,
      );
    }
    throw error;
  }
}

/** Internal restore key for a wallet and EIP-3009 nonce pair. */
export function movementTransferKey(from: string, nonce: string): string {
  return `${from}\0${nonce.toLowerCase()}`;
}

/** Rewrites journal-proven non-sent legs under every sender lock. */
export async function reconcileSignedLegs(
  home: string,
  id: string,
  signedKeys: ReadonlySet<string>,
): Promise<Movement> {
  const initial = await readMovement(home, id);
  return await withMovementLocks(home, movementSenders(initial), undefined, async () => {
    const movement = await readMovement(home, id);
    const reconciled = movementWithSignedLegsUnknown(movement, signedKeys);
    if (reconciled !== movement) await writeMovement(home, reconciled);
    return reconciled;
  });
}

/**
 * Reconciles only authorizations already signed by one account. The caller must
 * hold that account's movement lock; this helper never signs a planned leg.
 */
export async function reconcileUnresolvedMovementsForAccountLocked(
  home: string,
  account: WalletName,
  deps: MovementDependencies,
): Promise<Movement | undefined> {
  for (const summary of await listUnfinishedMovements({ home, from: account })) {
    let movement = await readMovement(home, summary.id);
    try {
      for (let index = 0; index < movement.legs.length; index += 1) {
        const leg = movement.legs[index];
        if (
          leg?.from !== account ||
          (leg.status !== "planned" && !(leg.status === "failed" && leg.retryable === true))
        ) {
          continue;
        }
        const reconciled = await reconcileJournaledLeg(movement, index, home);
        if (reconciled !== movement) {
          movement = reconciled;
          await writeMovement(home, movement);
        }
      }
      for (let index = 0; index < movement.legs.length; index += 1) {
        const leg = movement.legs[index];
        if (leg?.from !== account || leg.status !== "unknown") continue;
        movement = await resolveUnknownLeg(movement, index, home, deps);
      }
      for (let index = 0; index < movement.legs.length; index += 1) {
        const leg = movement.legs[index];
        if (leg?.from !== account || leg.status !== "failed") continue;
        movement = await prepareFailedLeg(movement, index, home, deps);
      }
    } catch {
      // A failed address, relay, journal, or chain check cannot prove that the
      // old authorization is unable to settle. Leave it blocking.
    }
    // Any leg that may still move this account's money blocks the caller: an
    // unknown or signed leg may settle, and a planned or retryable leg will be
    // signed on resume for an amount planned against the earlier balance.
    if (await movementHasOpenLeg(home, movement, account)) return movement;
  }
  return undefined;
}

/** Marks every unfinished leg in an existing readable movement as restored. */
export async function markOpenLegsRestored(
  home: string,
  id: string,
): Promise<Movement | undefined> {
  let initial: Movement;
  try {
    initial = await readMovement(home, id);
  } catch (error) {
    if (
      (error instanceof MovementError && error.code === "movement_not_found") ||
      error instanceof SyntaxError ||
      error instanceof z.ZodError
    ) {
      return undefined;
    }
    throw error;
  }
  return await withMovementLocks(home, movementSenders(initial), undefined, async () => {
    const movement = await readMovement(home, id);
    let changed = false;
    const legs = movement.legs.map((leg) => {
      if (leg.status === "sent" || leg.status === "cancelled" || leg.restored === true) return leg;
      changed = true;
      return { ...leg, restored: true as const };
    });
    if (!changed) return movement;
    const restored = movementSchema.parse({ ...movement, legs });
    await writeMovement(home, restored);
    return restored;
  });
}

async function resumeMovement(
  initial: Movement,
  home: string,
  deps: MovementDependencies,
): Promise<Movement> {
  let movement = initial;
  movement = await bindLegacyLegsFromJournal(movement, home);
  // The transfer journal is the signing source of truth. A process can die
  // after transferBetweenAccounts persists an authorization but before this
  // movement file changes from `planned`; such a leg must resume that nonce,
  // never enter the fresh-signing path again.
  for (let index = 0; index < movement.legs.length; index += 1) {
    const leg = movement.legs[index];
    if (leg?.status !== "planned" && !(leg?.status === "failed" && leg.retryable === true)) {
      continue;
    }
    const reconciled = await reconcileJournaledLeg(movement, index, home);
    if (reconciled !== movement) {
      movement = reconciled;
      await writeMovement(home, movement);
    }
  }
  for (let index = 0; index < movement.legs.length; index += 1) {
    if (movement.legs[index]?.status !== "unknown") continue;
    movement = await bindLegacyLegForReview(movement, index, home, deps);
    movement = await resolveUnknownLeg(movement, index, home, deps);
  }
  for (let index = 0; index < movement.legs.length; index += 1) {
    const leg = movement.legs[index];
    if (leg?.status === "failed") {
      movement = await prepareFailedLeg(movement, index, home, deps);
    }
    const planned = movement.legs[index];
    if (planned?.status === "planned") {
      // A restored leg that was never proven signed may still have been paid by the
      // original device with a later nonce after the backup was taken. Signing its
      // saved nonce again with a fresh validity window could pay it twice.
      if (planned.restored === true && deps.replaceExpiredRestored !== true) {
        await throwRestoredLegReview(movement, planned, deps, "planned");
      }
      if (planned.fromAddress === undefined || planned.toAddress === undefined) {
        if (planned.restored !== true && deps.bindLegacyAddresses !== true) {
          await throwLegacyAddressReview(movement, planned, deps);
        }
        movement = replaceLeg(movement, index, {
          ...planned,
          ...(await bindLegAddresses(planned, deps)),
          ...(planned.restored !== true && deps.bindLegacyAddresses === true
            ? { addressBindingSource: "terminal-review" as const }
            : {}),
        });
        await writeMovement(home, movement);
      }
      movement = await sendLeg(movement, index, home, deps);
    }
  }
  return movement;
}

async function bindLegacyLegsFromJournal(initial: Movement, home: string): Promise<Movement> {
  let movement = initial;
  let changed = false;
  for (let index = 0; index < movement.legs.length; index += 1) {
    const leg = movement.legs[index]!;
    if (leg.status === "sent" || leg.status === "cancelled") continue;
    if (leg.restored === true) continue;
    if (leg.fromAddress !== undefined && leg.toAddress !== undefined) continue;
    const journal = await readTransferJournal(home, leg.from, leg.nonce);
    const binding = journalAddressBinding(movement, leg, journal);
    if (binding === undefined) continue;
    movement = replaceLeg(movement, index, { ...leg, ...binding });
    changed = true;
  }
  if (changed) await writeMovement(home, movement);
  return movement;
}

async function bindLegacyLegForReview(
  movement: Movement,
  index: number,
  home: string,
  deps: MovementDependencies,
): Promise<Movement> {
  const leg = movement.legs[index]!;
  if (leg.fromAddress !== undefined && leg.toAddress !== undefined) return movement;
  if (leg.restored === true) return movement;
  if (deps.bindLegacyAddresses !== true) {
    await throwLegacyAddressReview(movement, leg, deps);
  }
  const bound = replaceLeg(movement, index, {
    ...leg,
    ...(await bindLegAddresses(leg, deps)),
    ...(leg.restored !== true && deps.bindLegacyAddresses === true
      ? { addressBindingSource: "terminal-review" as const }
      : {}),
  });
  await writeMovement(home, bound);
  return bound;
}

async function executePlannedLegs(
  initial: Movement,
  home: string,
  deps: MovementDependencies,
): Promise<Movement> {
  let movement = initial;
  for (let index = 0; index < movement.legs.length; index += 1) {
    movement = await sendLeg(movement, index, home, deps);
  }
  return movement;
}

async function resolveUnknownLeg(
  movement: Movement,
  index: number,
  home: string,
  deps: MovementDependencies,
): Promise<Movement> {
  const leg = movement.legs[index]!;
  if (isExpiredRestoredReview(leg)) {
    if (deps.replaceExpiredRestored !== true) {
      await throwRestoredLegReview(movement, leg, deps);
    }
    const journal = await readTransferJournal(home, leg.from, leg.nonce);
    await releaseExpiredReservation(leg, journal, home, deps);
    const bound =
      leg.fromAddress === undefined || leg.toAddress === undefined
        ? await bindLegAddresses(leg, deps)
        : leg;
    movement = replaceLeg(
      movement,
      index,
      plannedLeg(bound, (deps.randomNonce ?? createMovementNonce)()),
    );
    await writeMovement(home, movement);
    return movement;
  }
  try {
    const result = await callTransfer(movement, leg, deps, true);
    if (result.status === "sent") {
      movement = replaceLeg(movement, index, sentLeg(leg, result.txHash));
      await writeMovement(home, movement);
      return movement;
    }
  } catch (error) {
    // Recipient discovery and relay retries happen before the existing nonce
    // can be classified. Even a definite relay refusal does not prove the
    // previously journaled authorization cannot settle, so only the chain can
    // move this leg out of `unknown`.
    if (error instanceof TransferError || error instanceof SweepParentUnknownError) {
      // Continue to authorizationState below.
    } else {
      await reconcileCrash(movement, index, home);
      throw error;
    }
  }

  const journal = await readTransferJournal(home, leg.from, leg.nonce);
  const state = await authorizationState(movement, leg, journal.validBefore, home, deps);
  if (state === "settled") {
    movement = replaceLeg(movement, index, sentLeg(leg));
  } else if (state === "expired") {
    if (leg.restored === true && deps.replaceExpiredRestored !== true) {
      movement = replaceLeg(movement, index, restoredExpiredReviewLeg(leg));
      await writeMovement(home, movement);
      await throwRestoredLegReview(movement, movement.legs[index]!, deps);
    }
    await releaseExpiredReservation(leg, journal, home, deps);
    movement = replaceLeg(
      movement,
      index,
      plannedLeg(leg, (deps.randomNonce ?? createMovementNonce)()),
    );
  }
  await writeMovement(home, movement);
  return movement;
}

async function reconcileJournaledLeg(
  movement: Movement,
  index: number,
  home: string,
): Promise<Movement> {
  const leg = movement.legs[index]!;
  const journal = await readTransferJournal(home, leg.from, leg.nonce);
  if (journal.latest?.transfer?.status === "sent") {
    return replaceLeg(
      movement,
      index,
      sentLeg(
        leg,
        journal.latest.transfer.txHash === null ? undefined : journal.latest.transfer.txHash,
      ),
    );
  }
  return journal.signed ? replaceLeg(movement, index, unknownLeg(leg)) : movement;
}

async function prepareFailedLeg(
  movement: Movement,
  index: number,
  home: string,
  deps: MovementDependencies,
): Promise<Movement> {
  const leg = movement.legs[index]!;
  // Only an unsigned failure with a released reservation can reuse its nonce.
  // Signed failures wait for an on-chain expired verdict before receiving a new nonce.
  if (leg.retryable === true) {
    const reconciled = await reconcileJournaledLeg(movement, index, home);
    if (reconciled !== movement) {
      await writeMovement(home, reconciled);
      return reconciled;
    }
    return replaceLeg(movement, index, plannedLeg(leg, leg.nonce, true));
  }
  const journal = await readTransferJournal(home, leg.from, leg.nonce);
  if (!journal.signed) return movement;
  const state = await authorizationState(movement, leg, journal.validBefore, home, deps);
  if (state === "settled") {
    movement = replaceLeg(movement, index, sentLeg(leg));
  } else if (state === "expired") {
    if (leg.restored === true && deps.replaceExpiredRestored !== true) {
      movement = replaceLeg(movement, index, restoredExpiredReviewLeg(leg));
      await writeMovement(home, movement);
      await throwRestoredLegReview(movement, movement.legs[index]!, deps);
    }
    await releaseExpiredReservation(leg, journal, home, deps);
    movement = replaceLeg(
      movement,
      index,
      plannedLeg(leg, (deps.randomNonce ?? createMovementNonce)()),
    );
  }
  await writeMovement(home, movement);
  return movement;
}

async function sendLeg(
  movement: Movement,
  index: number,
  home: string,
  deps: MovementDependencies,
): Promise<Movement> {
  const leg = movement.legs[index]!;
  try {
    const result = await callTransfer(movement, leg, deps, false);
    movement = replaceLeg(
      movement,
      index,
      result.status === "sent" ? sentLeg(leg, result.txHash) : unknownLeg(leg),
    );
    await writeMovement(home, movement);
    return movement;
  } catch (error) {
    if (error instanceof MovementError) throw error;
    if (error instanceof SweepParentUnknownError) {
      movement = replaceLeg(movement, index, sweepParentUnknownLeg(leg));
      await writeMovement(home, movement);
      return movement;
    }
    if (error instanceof TransferError) {
      const journal = await readTransferJournal(home, leg.from, leg.nonce);
      movement = replaceLeg(
        movement,
        index,
        failedLeg(leg, error, error.reservationReleased && !journal.signed),
      );
      await writeMovement(home, movement);
      return movement;
    }
    await reconcileCrash(movement, index, home);
    throw error;
  }
}

async function callTransfer(
  movement: Movement,
  leg: MovementLeg,
  deps: MovementDependencies,
  resume: boolean,
): Promise<TransferResult> {
  if (leg.fromAddress !== undefined && leg.toAddress !== undefined) {
    await assertLegAddressBinding(movement, leg, deps);
  } else if (!resume) {
    throw movementAddressUnboundError(movement);
  }
  const transfer = deps.transfer ?? transferBetweenAccounts;
  const sweepParent = await readSweepParent(movement, leg, deps);
  return await transfer({
    store: deps.store,
    secrets: deps.secrets,
    apiBase: deps.apiBase,
    from: leg.from,
    to: leg.to,
    amountUsd: leg.amountUsd,
    network: movement.network,
    purpose: leg.purpose,
    expectedFromAddress: leg.fromAddress,
    expectedToAddress: leg.toAddress,
    ...(sweepParent === undefined ? {} : { sweepParent }),
    home: deps.home ?? deps.store.home,
    ...(resume ? { resume: leg.nonce as Hex } : { nonce: leg.nonce as Hex }),
    ...(deps.unlock === undefined ? {} : { unlock: deps.unlock }),
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
    ...(deps.ledgerPath === undefined ? {} : { ledgerPath: deps.ledgerPath }),
  });
}

async function reconcileCrash(movement: Movement, index: number, home: string): Promise<void> {
  const leg = movement.legs[index]!;
  const journal = await readTransferJournal(home, leg.from, leg.nonce);
  let reconciled = leg;
  if (journal.latest?.transfer?.status === "sent") {
    reconciled = sentLeg(
      leg,
      journal.latest.transfer.txHash === null ? undefined : journal.latest.transfer.txHash,
    );
  } else if (journal.latest?.transfer?.status === "failed") {
    reconciled = journalFailedLeg(leg, journal.latest.error?.code ?? "transfer_failed");
  } else if (journal.signed) {
    reconciled = unknownLeg(leg);
  }
  await writeMovement(home, replaceLeg(movement, index, reconciled));
}

async function authorizationState(
  movement: Movement,
  leg: MovementLeg,
  validBefore: string | undefined,
  home: string,
  deps: MovementDependencies,
): Promise<AuthorizationState> {
  if (deps.authorizationState !== undefined) {
    return await deps.authorizationState({
      movement,
      leg,
      ...(validBefore === undefined ? {} : { validBefore }),
    });
  }
  const journal = await readTransferJournal(home, leg.from, leg.nonce);
  const receipt = journal.request;
  const request = receipt?.transfer?.request;
  if (receipt === undefined || request === undefined) {
    throw new MovementError(
      "invalid_movement",
      `Movement ${movement.id} has no journaled authorization for nonce ${leg.nonce}.`,
      movement.id,
    );
  }
  const config = await loadConfig(getVapiPaths(home).config);
  const settlementReceipt: Receipt = {
    ...receipt,
    authorization: {
      from: request.authorization.from,
      nonce: request.authorization.nonce,
      validBefore: request.authorization.validBefore,
    },
  };
  return (
    await checkReceiptSettlement(settlementReceipt, config, {
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    })
  ).state;
}

function journalAddressBinding(
  movement: Movement,
  leg: MovementLeg,
  journal: TransferJournal,
): Pick<MovementLeg, "fromAddress" | "toAddress" | "addressBindingSource"> | undefined {
  if (!journal.signed) return undefined;
  const request = journal.request?.transfer?.request?.authorization;
  const receipt = journal.latest ?? journal.request;
  const transfer = receipt?.transfer;
  const rawFrom = request?.from ?? receipt?.payer;
  const rawTo = request?.to ?? transfer?.to;
  if (
    rawFrom === undefined ||
    rawTo === undefined ||
    !isAddress(rawFrom, { strict: false }) ||
    !isAddress(rawTo, { strict: false })
  ) {
    throw invalidJournalBindingError(movement, leg);
  }
  const expectedAtomic = (parseUsdCents(leg.amountUsd) * 10_000n).toString();
  const evidence = [journal.request, journal.latest].filter(
    (candidate): candidate is Receipt => candidate !== undefined,
  );
  if (
    evidence.some(
      (candidate) =>
        candidate.transfer?.network !== movement.network ||
        candidate.transfer.amountAtomic !== expectedAtomic ||
        !sameAddress(candidate.payer ?? rawFrom, rawFrom) ||
        !sameAddress(candidate.transfer.to, rawTo),
    ) ||
    (request !== undefined &&
      (request.value !== expectedAtomic ||
        request.nonce.toLowerCase() !== leg.nonce.toLowerCase() ||
        !sameAddress(request.from, rawFrom) ||
        !sameAddress(request.to, rawTo)))
  ) {
    throw invalidJournalBindingError(movement, leg);
  }
  return {
    fromAddress: getAddress(rawFrom),
    toAddress: getAddress(rawTo),
    addressBindingSource: "journal",
  };
}

function invalidJournalBindingError(movement: Movement, leg: MovementLeg): MovementError {
  return new MovementError(
    "invalid_movement",
    `Movement ${movement.id} has inconsistent signed journal evidence for nonce ${leg.nonce}. Nothing was signed. Inspect the movement and receipts before resuming.`,
    movement.id,
  );
}

function pendingCancellationError(movement: Movement, leg: MovementLeg): MovementError {
  const retry = `vapi accounts distribute --cancel ${movement.id}${
    leg.restored === true ? " --replace-expired-restored" : ""
  }`;
  return new MovementError(
    "movement_not_cancellable",
    `Movement ${movement.id} cannot be cancelled because authorization ${leg.nonce} from ${leg.from} to ${leg.to} may still settle. Nothing was changed or signed. Wait for its on-chain expiry, then retry ${retry}.`,
    movement.id,
  );
}

function unprovenCancellationError(
  movement: Movement,
  leg: MovementLeg,
  cause: unknown,
): MovementError {
  const detail = cause instanceof Error ? ` ${cause.message}` : "";
  return new MovementError(
    "movement_not_cancellable",
    `Movement ${movement.id} cannot be cancelled because vAPI could not prove authorization ${leg.nonce} from ${leg.from} to ${leg.to} is settled or expired.${detail} Nothing was changed or signed. Restore chain access, wait for expiry, then retry vapi accounts distribute --cancel ${movement.id}.`,
    movement.id,
  );
}

function unknownCancellationError(movement: Movement, leg: MovementLeg): MovementError {
  return new MovementError(
    "movement_not_cancellable",
    `Movement ${movement.id} cannot be cancelled because its ${leg.amountUsd} USDC leg from ${leg.from} to ${leg.to} is unknown and has no signed journal evidence to check on-chain. Nothing was changed or signed. First retry vapi accounts distribute --resume ${movement.id}; if it remains unresolved, inspect the saved movement and receipts before retrying vapi accounts distribute --cancel ${movement.id}.`,
    movement.id,
  );
}

async function releaseExpiredReservation(
  leg: MovementLeg,
  journal: TransferJournal,
  home: string,
  deps: MovementDependencies,
): Promise<void> {
  if (journal.reservedOn === undefined) return;
  await releaseSpend(parseUsdCents(leg.amountUsd) * 10_000n, {
    reservedOn: journal.reservedOn,
    ledgerPath: deps.ledgerPath ?? getVapiPaths(home).ledger,
    now: new Date((deps.now ?? Date.now)()),
    wallet: leg.from,
    reservationId: leg.nonce.toLowerCase(),
  });
}

function sentLeg(leg: MovementLeg, txHash?: string | null): MovementLeg {
  return {
    from: leg.from,
    to: leg.to,
    ...legAddressBinding(leg),
    amountUsd: leg.amountUsd,
    purpose: leg.purpose,
    nonce: leg.nonce,
    status: "sent",
    ...restoredMarker(leg),
    ...(txHash === undefined || txHash === null ? {} : { txHash }),
  };
}

function cancelledLeg(leg: MovementLeg): MovementLeg {
  return {
    from: leg.from,
    to: leg.to,
    ...legAddressBinding(leg),
    amountUsd: leg.amountUsd,
    purpose: leg.purpose,
    nonce: leg.nonce,
    status: "cancelled",
    ...restoredMarker(leg),
  };
}

function unknownLeg(leg: MovementLeg): MovementLeg {
  return {
    from: leg.from,
    to: leg.to,
    ...legAddressBinding(leg),
    amountUsd: leg.amountUsd,
    purpose: leg.purpose,
    nonce: leg.nonce,
    status: "unknown",
    ...restoredMarker(leg),
  };
}

function failedLeg(leg: MovementLeg, error: TransferError, retryable: boolean): MovementLeg {
  return {
    from: leg.from,
    to: leg.to,
    ...legAddressBinding(leg),
    amountUsd: leg.amountUsd,
    purpose: leg.purpose,
    nonce: leg.nonce,
    status: "failed",
    reason: error.code,
    ...restoredMarker(leg),
    ...(retryable ? { retryable: true } : {}),
  };
}

function sweepParentUnknownLeg(leg: MovementLeg): MovementLeg {
  return {
    from: leg.from,
    to: leg.to,
    ...legAddressBinding(leg),
    amountUsd: leg.amountUsd,
    purpose: leg.purpose,
    nonce: leg.nonce,
    status: "failed",
    reason: "sweep_parent_unknown",
    retryable: false,
    ...restoredMarker(leg),
  };
}

function journalFailedLeg(leg: MovementLeg, reason: string): MovementLeg {
  return {
    from: leg.from,
    to: leg.to,
    ...legAddressBinding(leg),
    amountUsd: leg.amountUsd,
    purpose: leg.purpose,
    nonce: leg.nonce,
    status: "failed",
    reason,
    ...restoredMarker(leg),
  };
}

function plannedLeg(leg: MovementLeg, nonce: string, preserveRestored = false): MovementLeg {
  return {
    from: leg.from,
    to: leg.to,
    ...legAddressBinding(leg),
    amountUsd: leg.amountUsd,
    purpose: leg.purpose,
    nonce,
    status: "planned",
    ...(preserveRestored ? restoredMarker(leg) : {}),
  };
}

function restoredExpiredReviewLeg(leg: MovementLeg): MovementLeg {
  return {
    from: leg.from,
    to: leg.to,
    ...legAddressBinding(leg),
    amountUsd: leg.amountUsd,
    purpose: leg.purpose,
    nonce: leg.nonce,
    status: "unknown",
    reason: "restored_nonce_expired",
    restored: true,
  };
}

function restoredMarker(leg: MovementLeg): { restored: true } | Record<string, never> {
  return leg.restored === true ? { restored: true } : {};
}

function legAddressBinding(
  leg: MovementLeg,
): Pick<MovementLeg, "fromAddress" | "toAddress" | "addressBindingSource"> {
  return {
    ...(leg.fromAddress === undefined ? {} : { fromAddress: leg.fromAddress }),
    ...(leg.toAddress === undefined ? {} : { toAddress: leg.toAddress }),
    ...(leg.addressBindingSource === undefined
      ? {}
      : { addressBindingSource: leg.addressBindingSource }),
  };
}

function isExpiredRestoredReview(leg: MovementLeg): boolean {
  return leg.restored === true && leg.reason === "restored_nonce_expired";
}

async function throwRestoredLegReview(
  movement: Movement,
  leg: MovementLeg,
  deps: MovementDependencies,
  kind: "expired" | "planned" = "expired",
): Promise<never> {
  const address = await (deps.addressReader === undefined
    ? deps.store.readAddress(leg.from)
    : deps.addressReader(leg.from));
  const explorer =
    address === undefined ? undefined : explorerAddressUrl(movement.network, address);
  const addressHint = address ?? `account ${leg.from}`;
  const explorerHint = explorer === undefined ? "a block explorer" : explorer;
  throw new MovementError(
    "restored_leg_review",
    `Movement ${movement.id} restored a ${leg.amountUsd} USDC transfer from ${leg.from} to ${leg.to}, ${kind === "expired" ? `but its saved authorization ${leg.nonce} has expired` : "that the backup recorded before it was signed"}. The original device may already have paid it with a later nonce, so nothing was signed. Check the balance with vapi balance --account ${leg.from}, then inspect ${addressHint} on ${explorerHint}. If the transfer was not paid, continue deliberately in a terminal with vapi accounts distribute --resume ${movement.id} --replace-expired-restored. This override is unavailable through MCP.`,
    movement.id,
  );
}

async function throwRestoredCancellationReview(
  movement: Movement,
  leg: MovementLeg,
  deps: MovementDependencies,
  cause?: unknown,
): Promise<never> {
  const address = await (deps.addressReader === undefined
    ? deps.store.readAddress(leg.from)
    : deps.addressReader(leg.from));
  const explorer =
    address === undefined ? undefined : explorerAddressUrl(movement.network, address);
  const addressHint = address ?? `account ${leg.from}`;
  const explorerHint = explorer === undefined ? "a block explorer" : explorer;
  const detail =
    cause instanceof Error ? ` The saved nonce could not be checked: ${cause.message}` : "";
  throw new MovementError(
    "movement_not_cancellable",
    `Movement ${movement.id} cannot be cancelled because its restored ${leg.amountUsd} USDC leg from ${leg.from} to ${leg.to} has no conclusive settlement evidence. The original device may have signed, re-nonced, or paid it after the backup.${detail} Nothing was changed or signed. Check the balance with vapi balance --account ${leg.from}, then review ${addressHint}'s explorer history on ${explorerHint}. If no authorization remains pending after that review, either cancel deliberately in a terminal with vapi accounts distribute --cancel ${movement.id} --replace-expired-restored, resume deliberately with vapi accounts distribute --resume ${movement.id} --replace-expired-restored, or leave the movement open. This override is unavailable through MCP.`,
    movement.id,
  );
}

function replaceLeg(movement: Movement, index: number, leg: MovementLeg): Movement {
  const legs = [...movement.legs];
  legs[index] = movementLegSchema.parse(leg);
  return movementSchema.parse({ ...movement, legs });
}

function movementWithSignedLegsUnknown(
  movement: Movement,
  signedKeys: ReadonlySet<string>,
): Movement {
  let changed = false;
  const legs = movement.legs.map((leg) => {
    if (isExpiredRestoredReview(leg)) return leg;
    if (
      leg.status === "sent" ||
      leg.status === "cancelled" ||
      !signedKeys.has(movementTransferKey(leg.from, leg.nonce)) ||
      (leg.status === "unknown" &&
        leg.txHash === undefined &&
        leg.reason === undefined &&
        leg.retryable === undefined)
    ) {
      return leg;
    }
    changed = true;
    return unknownLeg(leg);
  });
  return changed ? movementSchema.parse({ ...movement, legs }) : movement;
}

function parseMovement(value: unknown): Movement {
  const current = movementSchema.safeParse(value);
  if (current.success) return current.data;
  const legacy = legacyMovementSchema.parse(value);
  return movementSchema.parse({
    ...legacy,
    v: 2,
    legs: legacy.legs.map((leg) => ({
      ...leg,
      from: legacy.from,
      purpose: "send",
    })),
  });
}

function movementSenders(movement: Movement): WalletName[] {
  return sortedUniqueSenders(movement.legs.map((leg) => leg.from));
}

function sortedUniqueSenders(senders: readonly WalletName[]): WalletName[] {
  return [...new Set(senders)].sort();
}

async function bindLegAddresses<
  T extends Pick<MovementLeg, "from" | "to" | "amountUsd" | "purpose">,
>(
  leg: T,
  deps: MovementDependencies,
): Promise<
  T & {
    fromAddress: NonNullable<MovementLeg["fromAddress"]>;
    toAddress: NonNullable<MovementLeg["toAddress"]>;
  }
> {
  const fromAddress = await resolveAccountAddress(leg.from, deps);
  if (fromAddress === undefined) {
    throw new MovementError(
      "invalid_movement",
      `Cannot plan a movement from ${leg.from}: its local address is unavailable. Restore that account, then retry.`,
    );
  }
  const toAddress = await resolveRecipientAddress(leg.from, leg.to, deps);
  if (toAddress === undefined) {
    throw new MovementError(
      "invalid_movement",
      `Cannot plan a movement to ${leg.to}: its address is unavailable. Restore or relink that account, then retry.`,
    );
  }
  return { ...leg, fromAddress, toAddress };
}

async function assertLegAddressBinding(
  movement: Movement,
  leg: MovementLeg,
  deps: MovementDependencies,
): Promise<void> {
  if (leg.fromAddress === undefined || leg.toAddress === undefined) {
    throw movementAddressUnboundError(movement);
  }
  const fromAddress = await resolveAccountAddress(leg.from, deps);
  if (fromAddress === undefined || !sameAddress(fromAddress, leg.fromAddress)) {
    throw new MovementError(
      "account_address_mismatch",
      `Movement ${movement.id} bound sender ${leg.from} to ${leg.fromAddress}, but that name now resolves differently. Restore ${leg.from} to the recorded address before resuming, or wait for any signed authorization to expire and run vapi accounts distribute --cancel ${movement.id}.`,
      movement.id,
    );
  }
  const toAddress = await resolveRecipientAddress(leg.from, leg.to, deps);
  if (toAddress === undefined || !sameAddress(toAddress, leg.toAddress)) {
    throw new MovementError(
      "account_address_mismatch",
      `Movement ${movement.id} bound recipient ${leg.to} to ${leg.toAddress}, but that name now resolves differently. Restore or relink ${leg.to} to the recorded address before resuming, or wait for any signed authorization to expire and run vapi accounts distribute --cancel ${movement.id}.`,
      movement.id,
    );
  }
}

function movementAddressUnboundError(movement: Movement): MovementError {
  return new MovementError(
    "movement_address_unbound",
    `Movement ${movement.id} predates address binding, so vAPI cannot safely sign its planned leg. Check balances and the saved nonce, then create a new movement deliberately if no authorization can settle.`,
    movement.id,
  );
}

async function throwLegacyAddressReview(
  movement: Movement,
  leg: MovementLeg,
  deps: MovementDependencies,
): Promise<never> {
  const fromAddress = await resolveAccountAddress(leg.from, deps);
  const toAddress = await resolveRecipientAddress(leg.from, leg.to, deps);
  const from = fromAddress ?? "unavailable";
  const to = toAddress ?? "unavailable";
  throw new MovementError(
    "movement_address_unbound",
    `Movement ${movement.id} predates address binding and has no signed journal evidence for nonce ${leg.nonce}. Current addresses are ${leg.from}: ${from}; ${leg.to}: ${to}. Nothing was signed. Verify these are the original accounts, then continue deliberately in a terminal with vapi accounts distribute --resume ${movement.id} --bind-legacy-addresses. This override is unavailable through MCP.`,
    movement.id,
  );
}

async function resolveAccountAddress(
  account: WalletName,
  deps: MovementDependencies,
): Promise<`0x${string}` | undefined> {
  const raw = await (deps.addressReader ?? ((name) => deps.store.readAddress(name)))(account);
  return raw !== undefined && isAddress(raw, { strict: false }) ? getAddress(raw) : undefined;
}

async function resolveRecipientAddress(
  from: WalletName,
  recipient: string,
  deps: MovementDependencies,
): Promise<`0x${string}` | undefined> {
  const requested = recipient.trim();
  if (isAddress(requested, { strict: false })) return getAddress(requested);
  if (requested === "owner") {
    const owner = deps.store.entry(from)?.link?.owner;
    if (owner !== undefined && isAddress(owner, { strict: false })) return getAddress(owner);
  } else {
    const account = walletNameSchema.safeParse(requested);
    if (account.success) {
      const local = await resolveAccountAddress(account.data, deps);
      if (local !== undefined) return local;
    }
  }
  const resolved = await deps.recipientAddressReader?.(from, requested);
  return resolved !== undefined && isAddress(resolved, { strict: false })
    ? getAddress(resolved)
    : undefined;
}

function sameAddress(left: string, right: string): boolean {
  return (
    isAddress(left, { strict: false }) &&
    isAddress(right, { strict: false }) &&
    getAddress(left) === getAddress(right)
  );
}

async function firstUnfinishedMovement(
  home: string,
  senders: readonly WalletName[],
): Promise<{ from: WalletName; movement: MovementSummary } | undefined> {
  for (const from of senders) {
    const [movement] = await listUnfinishedMovements({ home, from });
    if (movement !== undefined) return { from, movement };
  }
  return undefined;
}

class SweepParentUnknownError extends Error {}

/** Sweeps named `owner` or by address get no parent: transfer then accepts only the owner. */
function isOwnerSweep(to: string): boolean {
  return to.trim() === "owner" || isAddress(to, { strict: false });
}

async function readSweepParent(
  movement: Movement,
  leg: MovementLeg,
  deps: MovementDependencies,
): Promise<`0x${string}` | undefined> {
  if (leg.purpose !== "sweep" || isOwnerSweep(leg.to)) return undefined;
  if (movement.treasury === undefined || leg.to !== movement.treasury) {
    throw new SweepParentUnknownError();
  }
  const account = walletNameSchema.safeParse(leg.to);
  if (!account.success) throw new SweepParentUnknownError();
  const address =
    deps.addressReader === undefined
      ? await deps.store.readAddress(account.data)
      : await deps.addressReader(account.data);
  if (address === undefined || !isAddress(address, { strict: false })) {
    throw new SweepParentUnknownError();
  }
  return address as `0x${string}`;
}

function parseMovementId(value: string): string {
  const parsed = movementIdSchema.safeParse(value);
  if (!parsed.success) throw new MovementError("invalid_movement", "The movement id is invalid.");
  return parsed.data;
}

function movementsDirectory(home: string): string {
  return join(home, "movements");
}

function createMovementId(): string {
  return `mv_${randomBytes(12).toString("hex")}`;
}

function createMovementNonce(): Hex {
  return bytesToHex(randomBytes(32));
}

async function writeMovement(home: string, movement: Movement): Promise<void> {
  const parsed = movementSchema.parse(movement);
  const directory = movementsDirectory(home);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = join(directory, `${parsed.id}.json`);
  const temporary = join(
    directory,
    `.${parsed.id}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(serializeMovement(parsed), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** Returns the canonical bytes used for movement files on disk. */
export function serializeMovement(movement: Movement): string {
  return `${JSON.stringify(movementSchema.parse(movement), null, 2)}\n`;
}

async function withMovementLock<T>(
  home: string,
  from: WalletName,
  timeoutMs: number | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await withAccountMovementLocks(home, [from], timeoutMs, operation);
  } catch (error) {
    if (error instanceof AccountMovementLockedError) {
      throw new MovementError(
        "movement_locked",
        `Another movement is already running for account ${from}.`,
      );
    }
    throw error;
  }
}

async function withMovementLocks<T>(
  home: string,
  senders: readonly WalletName[],
  timeoutMs: number | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const [sender, ...remaining] = senders;
  if (sender === undefined) return await operation();
  return await withMovementLock(home, sender, timeoutMs, async () =>
    withMovementLocks(home, remaining, timeoutMs, operation),
  );
}

async function assertNoPendingCeilingSweep(
  deps: MovementDependencies,
  senders: readonly WalletName[],
): Promise<void> {
  if (
    typeof deps.store.reload !== "function" ||
    typeof deps.store.ceilingSweepPending !== "function"
  ) {
    return;
  }
  await deps.store.reload();
  const pending = senders.find((sender) => deps.store.ceilingSweepPending(sender) !== undefined);
  if (pending !== undefined) {
    throw new MovementError(
      "ceiling_sweep_pending",
      `Account ${pending} has an unresolved automatic ceiling sweep. Run vapi status to reconcile it, then retry this movement.`,
    );
  }
}
