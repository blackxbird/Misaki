import { createHash, randomBytes } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import { getAddress, isAddress } from "viem";
import { z } from "zod";

import {
  formatUsdCents,
  parseUsdCents,
  planAllocation,
  type AllocationPlan,
} from "./allocation.js";
import { writeJsonAtomic } from "./atomic-file.js";
import { sweepAboveCeiling, type CeilingSweepResult } from "./ceiling.js";
import { getVapiPaths, isMissingFile, loadConfig, type VapiConfig } from "./config.js";
import {
  executeMovement,
  listUnfinishedMovements,
  movementHasOpenLeg,
  MovementError,
  readMovement,
  splitMovementPlanAtRelayLimit,
  type Movement,
  type MovementDependencies,
  type MovementPlan,
  type MovementSummary,
} from "./movement.js";
import { configuredNetworkFor } from "./networks.js";
import { RunBudgetError, type RunBudget } from "./run-budget.js";
import { readSpendLedger } from "./spend-policy.js";
import {
  deleteSwarmFile,
  readSwarm,
  SWARM_NAME_PATTERN,
  swarmAccountNames,
  SwarmError,
  writeSwarm,
  type SwarmBalanceReader,
  type SwarmFile,
  type SwarmMember,
} from "./swarm.js";
import { withCapitalLocks } from "./swarm-lock-context.js";
import { readUsdcBalance } from "./sweep.js";
import { assertSwarmWorkersStopped } from "./swarm-workers.js";
import {
  transferBetweenAccounts,
  TransferError,
  type TransferErrorCode,
  type TransferNetwork,
} from "./transfer.js";
import { walletNameSchema, type WalletName } from "./wallet-name.js";
import { assertWalletName, spendCapsForWallet } from "./wallet-store.js";
import { usdToAtomic } from "./x402.js";

export type SwarmCapitalDeps = MovementDependencies & {
  balanceReader?: SwarmBalanceReader;
  config?: VapiConfig;
  reconcileCeilingSweep?: (account: WalletName) => Promise<CeilingSweepResult>;
};

export type SwarmLegResult = {
  from: string;
  to: string;
  amountUsd: string;
  purpose: "send" | "sweep";
  status: "planned" | "sent" | "failed" | "unknown" | "cancelled";
  txHash?: string;
  reason?: string;
};

export type SwarmMovementResult = {
  movementId: string;
  reason: string;
  resumed: boolean;
  legs: SwarmLegResult[];
  complete: boolean;
};

type SwarmSkippedMember = { account: string; reason: string };
type SwarmBlockedLeg = { to: string; amountUsd: string; reason: string };

const movementIdSchema = z.string().regex(/^mv_[A-Za-z0-9_-]{8,128}$/u);
const amountSchema = z.string().regex(/^\d+\.\d{2}$/u);
const requestIdSchema = z.string().min(1).max(512);
const blockedLegSchema = z.strictObject({
  to: z.string().trim().min(1),
  amountUsd: amountSchema,
  reason: z.string(),
});
const treasuryRequestRecordSchema = z.strictObject({
  v: z.literal(1),
  requestId: requestIdSchema,
  swarm: z.string().regex(SWARM_NAME_PATTERN),
  member: walletNameSchema,
  reason: z.enum(["allocate", "delegate"]),
  amountUsd: amountSchema,
  movementId: movementIdSchema,
  createdAt: z.iso.datetime(),
  blocked: z.array(blockedLegSchema),
});
type TreasuryRequestRecord = z.infer<typeof treasuryRequestRecordSchema>;
const delegationRecordSchema = z.strictObject({
  v: z.literal(1),
  movementId: movementIdSchema,
  requestId: requestIdSchema,
  swarm: z.string().regex(SWARM_NAME_PATTERN),
  member: walletNameSchema,
  budgetUsd: amountSchema,
  childRunId: z.string().trim().min(1),
  startedAt: z.iso.datetime(),
  result: z
    .strictObject({
      runId: z.string().nullable(),
      answer: z.string().nullable(),
      stoppedBecause: z
        .strictObject({
          reason: z.string(),
          detail: z.string().optional(),
        })
        .nullable(),
      spentUsd: z.number(),
      budgetUsd: z.number(),
    })
    .optional(),
});
export type DelegationRecord = z.infer<typeof delegationRecordSchema>;
const legacyFundingPolicySchema = z.strictObject({
  movementId: movementIdSchema,
  legs: z.array(
    z.strictObject({
      from: walletNameSchema.optional(),
      to: z.string().trim().min(1),
      amountUsd: amountSchema,
      purpose: z.enum(["send", "sweep"]).optional(),
    }),
  ),
  blocked: z.array(blockedLegSchema),
  skipped: z.array(z.strictObject({ account: walletNameSchema, reason: z.string().trim().min(1) })),
});
const legacyFundingProgressSchema = z.strictObject({
  v: z.literal(1),
  name: z.string().regex(SWARM_NAME_PATTERN),
  from: walletNameSchema,
  amountUsd: amountSchema,
  applyPolicy: z.boolean(),
  fundMovementId: movementIdSchema,
  policy: legacyFundingPolicySchema.optional(),
});
type LegacyFundingProgress = z.infer<typeof legacyFundingProgressSchema>;
const resumableSwarmReasons: ReadonlySet<Movement["reason"]> = new Set([
  "send",
  "allocate",
  "delegate",
  "rebalance",
  "sweep",
]);

export type SwarmFundResult = {
  status: "sent" | "incomplete" | "waiting_for_owner" | "resumed";
  treasury: { account: string; address: string };
  network: TransferNetwork;
  amountUsd: string;
  fund?: SwarmMovementResult;
  policy?: SwarmMovementResult | SwarmRebalanceResult;
  blocked: SwarmBlockedLeg[];
  skipped: SwarmSkippedMember[];
  message: string;
};

export type SwarmFundOptions =
  | { name: string; amountUsd: string | number; from: string; setup: true }
  | { name: string; amountUsd: string | number; from?: string; setup?: undefined };

export type SwarmRebalanceResult = {
  status: "sent" | "incomplete" | "balanced" | "resumed";
  movement?: SwarmMovementResult;
  blocked: SwarmBlockedLeg[];
  skipped: SwarmSkippedMember[];
  message: string;
};

export type SwarmLeaveResult = {
  status: "left" | "kept" | "resumed";
  member: string;
  movement?: SwarmMovementResult;
  message: string;
};

export type SwarmDissolveResult = {
  status: "dissolved" | "incomplete" | "resumed";
  movements: SwarmMovementResult[];
  message: string;
};

export type AllocateFromTreasuryOptions = {
  name: string;
  member: string;
  amountUsd: string | number;
  reason: "allocate" | "delegate";
  requestId?: string;
  draw?: RunBudget;
};

export type AllocateFromTreasuryResult = {
  status: "sent" | "incomplete" | "blocked" | "resumed";
  movementId: string | null;
  requestedUsd: string;
  sentUsd: string;
  unknownUsd: string;
  blocked: Array<{ to: string; amountUsd: string; reason: string }>;
  movement?: SwarmMovementResult;
  message: string;
};

export function treasuryRequestMovementId(swarm: string, requestId: string): string {
  const digest = createHash("sha256").update(`${swarm}\n${requestId}`).digest("hex").slice(0, 24);
  return movementIdSchema.parse(`mv_${digest}`);
}

/**
 * Moves treasury capital for one intent. Reusing a requestId returns a finished result or resumes
 * its unfinished movement; changing its member, amount, or reason is a request conflict. Different
 * requestIds are distinct intents, bounded only by the run draw and treasury caps.
 */
export async function allocateFromTreasury(
  opts: AllocateFromTreasuryOptions,
  deps: SwarmCapitalDeps,
): Promise<AllocateFromTreasuryResult> {
  const amountCents = parseUsdCents(opts.amountUsd);
  if (opts.requestId !== undefined && !requestIdSchema.safeParse(opts.requestId).success) {
    throw new SwarmError(
      "invalid_swarm",
      "A treasury allocation request id must contain between 1 and 512 characters.",
    );
  }
  const home = capitalHome(deps);
  return await withCapitalLocks(home, { swarms: [opts.name] }, async () =>
    allocateFromTreasuryLocked(opts, amountCents, deps, home),
  );
}

async function allocateFromTreasuryLocked(
  opts: AllocateFromTreasuryOptions,
  amountCents: bigint,
  deps: SwarmCapitalDeps,
  home: string,
): Promise<AllocateFromTreasuryResult> {
  const swarm = await readSwarm(home, opts.name);
  await assertSwarmAccountAddresses(swarm, deps);
  await reconcilePendingCeilingSweeps(swarm, [swarm.treasury.account], deps, home);
  const member = swarm.members.find((candidate) => candidate.account === opts.member);
  if (member === undefined) {
    throw new SwarmError(
      "member_not_found",
      `Member ${opts.member} is not in swarm ${swarm.name}.`,
    );
  }
  await deps.store.reload();
  if (deps.store.entry(member.account)?.link === undefined) {
    throw new SwarmError(
      "member_not_linked",
      `Member ${member.account} is not linked and cannot receive an allocation.`,
    );
  }

  if (opts.requestId !== undefined) {
    return await allocateTreasuryRequestLocked(
      opts,
      opts.requestId,
      amountCents,
      deps,
      home,
      swarm,
      member,
    );
  }

  const unfinished = await findSwarmMovements(swarm, home);
  const blocking = unfinished.blocking[0];
  if (blocking !== undefined) throw unfinishedMovementError(swarm, blocking.id);
  let resumable: Movement | undefined;
  for (const summary of unfinished.resumable) {
    const movement = await readMovement(home, summary.id);
    if (!isMatchingTreasuryAllocation(movement, swarm, member.account, opts.reason, amountCents)) {
      throw unfinishedMovementError(swarm, movement.id);
    }
    if (resumable !== undefined) throw unfinishedMovementError(swarm, movement.id);
    resumable = movement;
  }
  if (resumable !== undefined) {
    opts.draw?.release(resumable.id);
    reserveDraw(opts.draw, movementAmountAtomic(resumable), resumable.id);
    const movement = movementResult(
      await executeMovement({ resume: resumable.id }, movementDeps(deps, home)),
      true,
    );
    reconcileDraw(opts.draw, movement);
    const amounts = movementAmounts(movement);
    return {
      status: "resumed",
      movementId: movement.movementId,
      requestedUsd: formatUsdCents(amountCents),
      sentUsd: formatUsdCents(amounts.sentCents),
      unknownUsd: formatUsdCents(amounts.unknownCents),
      blocked: [],
      movement,
      message: `Resumed treasury allocation ${movement.movementId}.`,
    };
  }

  const amountUsd = formatUsdCents(amountCents);
  const balanceReader = await capitalBalanceReader(swarm, deps, home);
  const treasuryBalance = await balanceReader({
    account: swarm.treasury.account,
    address: await accountAddress(swarm.treasury, deps),
    network: swarm.network,
  });
  const memberBalance = await balanceReader({
    account: member.account,
    address: await accountAddress(member, deps),
    network: swarm.network,
  });
  const allocation = planAllocation({
    strategy: "weights",
    from: swarm.treasury.account,
    recipients: [
      {
        to: member.account,
        weight: 1,
        balanceAtomic: memberBalance,
        ceilingAtomic: deps.store.ceilingCaps(member.account).effectiveCeilingAtomic,
      },
    ],
    amountUsd,
    policy: await treasuryPolicy(swarm, treasuryBalance, deps, home),
  });
  const blocked = allocation.blocked.map(({ to, amountUsd: blockedUsd, reason }) => ({
    to,
    amountUsd: blockedUsd,
    reason,
  }));
  if (allocation.legs.length === 0) {
    return {
      status: "blocked",
      movementId: null,
      requestedUsd: amountUsd,
      sentUsd: "0.00",
      unknownUsd: "0.00",
      blocked,
      message: `Treasury allocation to ${member.account} is blocked.`,
    };
  }

  const movementId = nextMovementId(deps);
  const plannedAtomic = allocation.legs.reduce(
    (total, leg) => total + parseUsdCents(leg.amountUsd) * 10_000n,
    0n,
  );
  reserveDraw(opts.draw, plannedAtomic, movementId);
  const recorded = await executeRecordedMovement(
    movementId,
    {
      reason: opts.reason,
      from: swarm.treasury.account,
      treasury: swarm.treasury.account,
      network: swarm.network,
      legs: allocation.legs,
    },
    deps,
    home,
  );
  const movement = movementResult(recorded.movement, recorded.resumed);
  reconcileDraw(opts.draw, movement);
  const amounts = movementAmounts(movement);
  const sent = movementSent(movement);
  return {
    status: sent ? "sent" : "incomplete",
    movementId,
    requestedUsd: amountUsd,
    sentUsd: formatUsdCents(amounts.sentCents),
    unknownUsd: formatUsdCents(amounts.unknownCents),
    blocked,
    movement,
    message: sent
      ? `Allocated ${formatUsdCents(amounts.sentCents)} USDC to ${member.account}.`
      : `Treasury allocation ${movementId} is incomplete.`,
  };
}

async function allocateTreasuryRequestLocked(
  opts: AllocateFromTreasuryOptions,
  requestId: string,
  amountCents: bigint,
  deps: SwarmCapitalDeps,
  home: string,
  swarm: SwarmFile,
  member: SwarmMember,
): Promise<AllocateFromTreasuryResult> {
  const amountUsd = formatUsdCents(amountCents);
  const movementId = treasuryRequestMovementId(swarm.name, requestId);
  const record = await readTreasuryRequestRecord(home, movementId);
  if (record !== undefined) {
    if (record.swarm !== swarm.name) {
      throw new SwarmError(
        "invalid_swarm",
        `Treasury request record ${movementId} does not belong to swarm ${swarm.name}.`,
      );
    }
    if (
      record.requestId !== requestId ||
      record.member !== member.account ||
      record.reason !== opts.reason ||
      record.amountUsd !== amountUsd
    ) {
      throw new SwarmError(
        "request_conflict",
        `Treasury request ${movementId} was already recorded with different allocation details.`,
      );
    }
  }

  const existing = await optionalMovement(home, movementId);
  if (record !== undefined && existing === undefined) {
    throw missingRecordedMovementError(swarm, movementId);
  }
  if (existing !== undefined) {
    assertTreasuryRequestMovement(existing, swarm, member.account, opts.reason, amountCents);
    if (!(await movementHasOpenLeg(home, existing))) {
      const movement = movementResult(existing, true);
      reconcileDraw(opts.draw, movement);
      return treasuryRequestResult({
        status: movementSent(movement) ? "sent" : "incomplete",
        movement,
        requestedUsd: amountUsd,
        blocked: record?.blocked ?? [],
        member: member.account,
      });
    }

    await assertNoOtherUnfinishedSwarmMovement(swarm, home, movementId);
    opts.draw?.release(movementId);
    reserveDraw(opts.draw, movementAmountAtomic(existing), movementId);
    const movement = movementResult(
      await executeMovement({ resume: movementId }, movementDeps(deps, home)),
      true,
    );
    reconcileDraw(opts.draw, movement);
    return treasuryRequestResult({
      status: "resumed",
      movement,
      requestedUsd: amountUsd,
      blocked: record?.blocked ?? [],
      member: member.account,
    });
  }

  await assertNoOtherUnfinishedSwarmMovement(swarm, home, movementId);
  const balanceReader = await capitalBalanceReader(swarm, deps, home);
  const treasuryBalance = await balanceReader({
    account: swarm.treasury.account,
    address: await accountAddress(swarm.treasury, deps),
    network: swarm.network,
  });
  const memberBalance = await balanceReader({
    account: member.account,
    address: await accountAddress(member, deps),
    network: swarm.network,
  });
  const allocation = planAllocation({
    strategy: "weights",
    from: swarm.treasury.account,
    recipients: [
      {
        to: member.account,
        weight: 1,
        balanceAtomic: memberBalance,
        ceilingAtomic: deps.store.ceilingCaps(member.account).effectiveCeilingAtomic,
      },
    ],
    amountUsd,
    policy: await treasuryPolicy(swarm, treasuryBalance, deps, home),
  });
  const blocked = allocation.blocked.map(({ to, amountUsd: blockedUsd, reason }) => ({
    to,
    amountUsd: blockedUsd,
    reason,
  }));
  if (allocation.legs.length === 0) {
    opts.draw?.release(movementId);
    return {
      status: "blocked",
      movementId: null,
      requestedUsd: amountUsd,
      sentUsd: "0.00",
      unknownUsd: "0.00",
      blocked,
      message: `Treasury allocation to ${member.account} is blocked.`,
    };
  }

  const plannedAtomic = allocation.legs.reduce(
    (total, leg) => total + parseUsdCents(leg.amountUsd) * 10_000n,
    0n,
  );
  replaceDrawReservation(opts.draw, plannedAtomic, movementId);
  const requestRecord: TreasuryRequestRecord = {
    v: 1,
    requestId,
    swarm: swarm.name,
    member: member.account,
    reason: opts.reason,
    amountUsd,
    movementId,
    createdAt: record?.createdAt ?? new Date((deps.now ?? Date.now)()).toISOString(),
    blocked,
  };
  try {
    await writeTreasuryRequestRecord(home, requestRecord);
  } catch (error) {
    opts.draw?.release(movementId);
    throw error;
  }

  const recorded = await executeRecordedMovement(
    movementId,
    {
      reason: opts.reason,
      from: swarm.treasury.account,
      treasury: swarm.treasury.account,
      network: swarm.network,
      legs: allocation.legs,
    },
    deps,
    home,
  );
  const movement = movementResult(recorded.movement, recorded.resumed);
  reconcileDraw(opts.draw, movement);
  return treasuryRequestResult({
    status: movementSent(movement) ? "sent" : "incomplete",
    movement,
    requestedUsd: amountUsd,
    blocked,
    member: member.account,
  });
}

function treasuryRequestResult(args: {
  status: "sent" | "incomplete" | "resumed";
  movement: SwarmMovementResult;
  requestedUsd: string;
  blocked: SwarmBlockedLeg[];
  member: string;
}): AllocateFromTreasuryResult {
  const amounts = movementAmounts(args.movement);
  return {
    status: args.status,
    movementId: args.movement.movementId,
    requestedUsd: args.requestedUsd,
    sentUsd: formatUsdCents(amounts.sentCents),
    unknownUsd: formatUsdCents(amounts.unknownCents),
    blocked: args.blocked,
    movement: args.movement,
    message:
      args.status === "resumed"
        ? `Resumed treasury allocation ${args.movement.movementId}.`
        : args.status === "sent"
          ? `Allocated ${formatUsdCents(amounts.sentCents)} USDC to ${args.member}.`
          : `Treasury allocation ${args.movement.movementId} is incomplete.`,
  };
}

function assertTreasuryRequestMovement(
  movement: Movement,
  swarm: SwarmFile,
  member: string,
  reason: AllocateFromTreasuryOptions["reason"],
  amountCents: bigint,
): void {
  if (isMatchingTreasuryAllocation(movement, swarm, member, reason, amountCents)) return;
  throw new SwarmError(
    "invalid_swarm",
    `Recorded movement ${movement.id} does not match its treasury request.`,
  );
}

async function assertNoOtherUnfinishedSwarmMovement(
  swarm: SwarmFile,
  home: string,
  movementId: string,
): Promise<void> {
  const unfinished = await findSwarmMovements(swarm, home);
  const other =
    unfinished.blocking.find((movement) => movement.id !== movementId) ??
    unfinished.resumable.find((movement) => movement.id !== movementId);
  if (other !== undefined) throw unfinishedMovementError(swarm, other.id);
}

export async function fundSwarm(
  opts: SwarmFundOptions,
  deps: SwarmCapitalDeps,
): Promise<SwarmFundResult> {
  const home = capitalHome(deps);
  return await withCapitalLocks(
    home,
    { swarms: [opts.name], accounts: opts.from === undefined ? [] : [opts.from] },
    async () => fundSwarmLocked(opts, deps, home),
  );
}

async function fundSwarmLocked(
  opts: SwarmFundOptions,
  deps: SwarmCapitalDeps,
  home: string,
): Promise<SwarmFundResult> {
  const swarm = await readSwarm(home, opts.name);
  await assertSwarmAccountAddresses(swarm, deps);
  const treasury = {
    account: swarm.treasury.account,
    address: await accountAddress(swarm.treasury, deps),
  };
  const amountCents = parseUsdCents(opts.amountUsd);
  const amountUsd = formatUsdCents(amountCents);
  const base = { treasury, network: swarm.network, amountUsd };

  if (opts.from === undefined) {
    return {
      ...base,
      status: "waiting_for_owner",
      blocked: [],
      skipped: [],
      message: `Send ${amountUsd} USDC on ${swarm.network} to treasury ${treasury.account} at ${treasury.address}.`,
    };
  }

  const from = assertWalletName(opts.from);
  await reconcilePendingCeilingSweeps(
    swarm,
    opts.setup === true ? [from, ...swarmAccountNames(swarm)] : [from],
    deps,
    home,
  );
  if (opts.setup === true) {
    return await fundSwarmAtSetupLocked(swarm, base, from, amountCents, deps, home);
  }

  const resumed = await resumeOrBlock(swarm, deps, home);
  if (resumed !== undefined) {
    return {
      ...base,
      status: "resumed",
      fund: resumed,
      blocked: failedLegsAsBlocked(resumed),
      skipped: [],
      message: resumedMessage(resumed.movementId),
    };
  }
  const fund = movementResult(
    await executeMovement(
      {
        reason: "send",
        from,
        treasury: swarm.treasury.account,
        network: swarm.network,
        legs: [{ to: swarm.treasury.account, amountUsd, purpose: "send" }],
      },
      movementDeps(deps, home),
    ),
    false,
  );
  const sent = movementSent(fund);
  return {
    ...base,
    status: sent ? "sent" : "incomplete",
    fund,
    blocked: failedLegsAsBlocked(fund),
    skipped: [],
    message: sent
      ? `Funded swarm ${swarm.name} with ${amountUsd} USDC.`
      : `Funding swarm ${swarm.name} is incomplete; inspect the movement legs and retry.`,
  };
}

async function fundSwarmAtSetupLocked(
  swarm: SwarmFile,
  base: Pick<SwarmFundResult, "treasury" | "network" | "amountUsd">,
  from: string,
  amountCents: bigint,
  deps: SwarmCapitalDeps,
  home: string,
): Promise<SwarmFundResult> {
  let setupFunding = swarm.setupFunding;
  let createdSetupFunding = false;
  const legacy = await readLegacyFundingProgress(home, swarm.name);
  if (setupFunding === undefined) {
    if (legacy !== undefined) {
      if (legacy.from !== from || legacy.amountUsd !== base.amountUsd) {
        throw new SwarmError(
          "invalid_swarm",
          `Swarm ${swarm.name} has legacy setup funding recorded as ${legacy.amountUsd} USDC from ${legacy.from}; retry that request before starting another.`,
        );
      }
      setupFunding = await migrateLegacySetupFunding(swarm, legacy, home);
    }
  } else if (legacy !== undefined) {
    if (
      legacy.from !== setupFunding.from ||
      legacy.amountUsd !== setupFunding.amountUsd ||
      legacy.fundMovementId !== setupFunding.movementId
    ) {
      throw new SwarmError(
        "invalid_swarm",
        `Swarm ${swarm.name} has conflicting legacy and current setup funding records.`,
      );
    }
    // The current swarm record is already durable; this is the crash window
    // after migration wrote swarm.json but before it removed the old journal.
    await deleteLegacyFundingProgress(home, swarm.name);
  }
  if (setupFunding !== undefined) {
    if (setupFunding.from !== from || setupFunding.amountUsd !== base.amountUsd) {
      throw new SwarmError(
        "invalid_swarm",
        `Swarm ${swarm.name} setup funding is recorded as ${setupFunding.amountUsd} USDC from ${setupFunding.from}; use vapi swarm fund for a new funding request.`,
      );
    }
  } else {
    createdSetupFunding = true;
    setupFunding = {
      amountUsd: base.amountUsd,
      from: assertWalletName(from),
      movementId: nextMovementId(deps),
      status: "planned",
      policy: { strategy: swarm.policy.strategy, status: "planned" },
    };
    swarm.setupFunding = setupFunding;
    await writeSwarm(home, swarm);
  }

  if (setupFunding.movementId === undefined) {
    if (setupFunding.status === "planned") {
      throw new SwarmError(
        "invalid_swarm",
        `Swarm ${swarm.name} has planned setup funding without a movement id; refusing to guess a new funding operation.`,
      );
    }
    if (setupFunding.status === "incomplete") {
      return {
        ...base,
        status: "incomplete",
        blocked: [],
        skipped: [],
        message: `Setup funding for swarm ${swarm.name} is recorded as incomplete without a resumable movement. Use vapi swarm fund to add capital, then vapi swarm rebalance.`,
      };
    }
    if (setupFunding.policy === undefined) {
      return {
        ...base,
        status: "sent",
        blocked: [],
        skipped: [],
        message: `Setup funding for swarm ${swarm.name} was already recorded as sent.`,
      };
    }
    const outcome = await applySetupFundingPolicy(swarm, amountCents, deps, home);
    return {
      ...base,
      status: outcome.sent ? "sent" : "incomplete",
      ...(outcome.policy === undefined ? {} : { policy: outcome.policy }),
      blocked: outcome.blocked,
      skipped: outcome.skipped,
      message: outcome.sent
        ? `Applied swarm ${swarm.name}'s recorded ${setupFunding.policy.strategy} setup policy.`
        : outcome.final
          ? `Setup funding for swarm ${swarm.name} is final but incomplete; run vapi swarm rebalance after resolving the blocked amounts.`
          : openMovementMessage(setupFunding.policy.movementId),
    };
  }

  const recordedIds = new Set(
    [setupFunding.movementId, setupFunding.policy?.movementId].filter(
      (id): id is string => id !== undefined,
    ),
  );
  const resumedOther = await resumeOrBlockOther(swarm, recordedIds, deps, home);
  if (resumedOther !== undefined) {
    return {
      ...base,
      status: "resumed",
      fund: resumedOther,
      blocked: failedLegsAsBlocked(resumedOther),
      skipped: [],
      message: resumedMessage(resumedOther.movementId),
    };
  }

  const recordedFund = await executeRecordedMovement(
    setupFunding.movementId,
    {
      reason: "send",
      from,
      treasury: swarm.treasury.account,
      network: swarm.network,
      legs: [{ to: swarm.treasury.account, amountUsd: base.amountUsd, purpose: "send" }],
    },
    deps,
    home,
    { allowCreate: createdSetupFunding, swarm },
  );
  const fund = movementResult(recordedFund.movement, recordedFund.resumed);
  setupFunding.status = movementSent(fund) ? "sent" : "incomplete";
  await writeSwarm(home, swarm);
  const fundBlocked = failedLegsAsBlocked(fund);
  if (!movementSent(fund)) {
    const final = !(await movementHasOpenLeg(home, recordedFund.movement));
    return {
      ...base,
      status: "incomplete",
      fund,
      blocked: fundBlocked,
      skipped: [],
      message: final
        ? `Setup funding for swarm ${swarm.name} is final but incomplete. Use vapi swarm fund to add capital, then vapi swarm rebalance.`
        : openMovementMessage(fund.movementId),
    };
  }

  if (setupFunding.policy === undefined) {
    return {
      ...base,
      status: "sent",
      fund,
      blocked: [],
      skipped: [],
      message: `Funded swarm ${swarm.name} with ${base.amountUsd} USDC.`,
    };
  }

  const outcome = await applySetupFundingPolicy(swarm, amountCents, deps, home);
  return {
    ...base,
    status: outcome.sent ? "sent" : "incomplete",
    fund,
    ...(outcome.policy === undefined ? {} : { policy: outcome.policy }),
    blocked: outcome.blocked,
    skipped: outcome.skipped,
    message: outcome.sent
      ? `Funded swarm ${swarm.name} and applied its ${setupFunding.policy.strategy} policy.`
      : outcome.final
        ? `Setup funding for swarm ${swarm.name} is final but incomplete; run vapi swarm rebalance after resolving the blocked amounts.`
        : openMovementMessage(setupFunding.policy.movementId),
  };
}

export async function rebalanceSwarm(
  opts: { name: string; targetsUsd?: Record<string, string | number> },
  deps: SwarmCapitalDeps,
): Promise<SwarmRebalanceResult> {
  const home = capitalHome(deps);
  return await withCapitalLocks(home, { swarms: [opts.name] }, async () =>
    rebalanceSwarmLocked(opts, deps, home),
  );
}

async function rebalanceSwarmLocked(
  opts: { name: string; targetsUsd?: Record<string, string | number> },
  deps: SwarmCapitalDeps,
  home: string,
): Promise<SwarmRebalanceResult> {
  const swarm = await readSwarm(home, opts.name);
  await assertSwarmAccountAddresses(swarm, deps);
  await reconcilePendingCeilingSweeps(swarm, swarmAccountNames(swarm), deps, home);
  const resumed = await resumeOrBlock(swarm, deps, home);
  if (resumed !== undefined) {
    return {
      status: "resumed",
      movement: resumed,
      blocked: [],
      skipped: [],
      message: resumedMessage(resumed.movementId),
    };
  }

  await deps.store.reload();
  const balanceReader = await capitalBalanceReader(swarm, deps, home);
  const treasuryAddress = await accountAddress(swarm.treasury, deps);
  const treasuryBalance = await balanceReader({
    account: swarm.treasury.account,
    address: treasuryAddress,
    network: swarm.network,
  });
  const memberBalances = await Promise.all(
    swarm.members.map(async (member) => ({
      member,
      balanceAtomic: await balanceReader({
        account: member.account,
        address: await accountAddress(member, deps),
        network: swarm.network,
      }),
    })),
  );
  const skipped = swarm.members
    .filter((member) => deps.store.entry(member.account)?.link === undefined)
    .map((member) => ({ account: member.account, reason: "not_linked" }));
  const linked = memberBalances.filter(
    ({ member }) => deps.store.entry(member.account)?.link !== undefined,
  );

  if (linked.length === 0) {
    return {
      status: "balanced",
      blocked: [],
      skipped,
      message: `Swarm ${swarm.name} has no linked members to rebalance.`,
    };
  }

  const policy = await treasuryPolicy(swarm, treasuryBalance, deps, home);
  const allocation = planAllocation({
    strategy: "targets",
    treasury: swarm.treasury.account,
    members: await Promise.all(
      linked.map(async ({ member, balanceAtomic }) => ({
        account: member.account,
        balanceAtomic,
        targetAtomic: targetAtomic(member, opts.targetsUsd),
        ceilingAtomic: deps.store.ceilingCaps(member.account).ceilingAtomic,
        perDayCapAtomic: (await spendCapsForWallet(deps.store, member.account)).perDayAtomic,
      })),
    ),
    policy,
  });
  const blocked = allocation.blocked.map(({ to, amountUsd, reason }) => ({
    to,
    amountUsd,
    reason,
  }));
  if (allocation.legs.length === 0) {
    return {
      status: blocked.length === 0 ? "balanced" : "incomplete",
      blocked,
      skipped,
      message:
        blocked.length === 0
          ? `Swarm ${swarm.name} has no executable rebalance legs.`
          : `Rebalancing swarm ${swarm.name} is incomplete; every required leg is blocked.`,
    };
  }

  const movement = movementResult(
    await executeMovement(
      {
        reason: "rebalance",
        from: swarm.treasury.account,
        treasury: swarm.treasury.account,
        network: swarm.network,
        legs: allocation.legs,
      },
      movementDeps(deps, home),
    ),
    false,
  );
  const complete = movementSent(movement) && blocked.length === 0;
  return {
    status: complete ? "sent" : "incomplete",
    movement,
    blocked,
    skipped,
    message: complete
      ? `Rebalanced swarm ${swarm.name}.`
      : `Rebalancing swarm ${swarm.name} is incomplete; inspect the blocked and movement legs.`,
  };
}

export async function leaveSwarm(
  opts: { name: string; member: string },
  deps: SwarmCapitalDeps,
): Promise<SwarmLeaveResult> {
  const home = capitalHome(deps);
  return await withCapitalLocks(home, { swarms: [opts.name] }, async () =>
    leaveSwarmLocked(opts, deps, home),
  );
}

async function leaveSwarmLocked(
  opts: { name: string; member: string },
  deps: SwarmCapitalDeps,
  home: string,
): Promise<SwarmLeaveResult> {
  const swarm = await readSwarm(home, opts.name);
  await assertSwarmAccountAddresses(swarm, deps);
  if (opts.member === swarm.treasury.account) {
    throw new SwarmError(
      "treasury_refused",
      `Treasury ${opts.member} cannot leave the swarm; use swarm dissolve instead.`,
    );
  }
  const member = swarm.members.find((candidate) => candidate.account === opts.member);
  if (member === undefined) {
    throw new SwarmError(
      "member_not_found",
      `Member ${opts.member} is not in swarm ${swarm.name}.`,
    );
  }

  await reconcilePendingCeilingSweeps(swarm, [member.account], deps, home);

  const resumed = await resumeOrBlock(swarm, deps, home);
  if (resumed !== undefined) {
    const unfinished = await firstUnfinishedMovementTouching(home, member.account);
    if (unfinished !== undefined) throw unfinishedMovementError(swarm, unfinished.id);
    return {
      status: "resumed",
      member: member.account,
      movement: resumed,
      message: resumedMessage(resumed.movementId),
    };
  }

  const balanceReader = await capitalBalanceReader(swarm, deps, home);
  const balance = await balanceReader({
    account: member.account,
    address: await accountAddress(member, deps),
    network: swarm.network,
  });
  const cents = balance / 10_000n;
  if (cents === 0n) {
    await removeMemberLocked(home, swarm, member.account);
    return {
      status: "left",
      member: member.account,
      message: `Removed ${member.account} from swarm ${swarm.name}; its balance was below one cent.`,
    };
  }

  const movement = movementResult(
    await executeMovement(
      {
        reason: "sweep",
        from: member.account,
        treasury: swarm.treasury.account,
        network: swarm.network,
        legs: [
          {
            from: member.account,
            to: swarm.treasury.account,
            amountUsd: formatUsdCents(cents),
            purpose: "sweep",
          },
        ],
      },
      movementDeps(deps, home),
    ),
    false,
  );
  if (movementSent(movement)) {
    await removeMemberLocked(home, swarm, member.account);
    return {
      status: "left",
      member: member.account,
      movement,
      message: `Swept ${member.account} to the treasury and removed it from swarm ${swarm.name}.`,
    };
  }
  return {
    status: "kept",
    member: member.account,
    movement,
    message: `Kept ${member.account} in swarm ${swarm.name} because its sweep was not sent.`,
  };
}

export async function dissolveSwarm(
  opts: { name: string },
  deps: SwarmCapitalDeps,
): Promise<SwarmDissolveResult> {
  const home = capitalHome(deps);
  return await withCapitalLocks(home, { swarms: [opts.name] }, async () =>
    dissolveSwarmLocked(opts, deps, home),
  );
}

async function dissolveSwarmLocked(
  opts: { name: string },
  deps: SwarmCapitalDeps,
  home: string,
): Promise<SwarmDissolveResult> {
  const swarm = await readSwarm(home, opts.name);
  await deps.reconcileRuns?.({ home, name: swarm.name });
  await assertSwarmWorkersStopped(home, swarm);
  await assertSwarmAccountAddresses(swarm, deps);
  await reconcilePendingCeilingSweeps(swarm, swarmAccountNames(swarm), deps, home);
  const resumed = await resumeOrBlock(swarm, deps, home);
  if (resumed !== undefined) {
    return {
      status: "resumed",
      movements: [resumed],
      message: resumedMessage(resumed.movementId),
    };
  }

  // Resuming pre-existing work returns without starting dissolution. Record
  // intent only when the first dissolution sweep is about to be prepared.
  swarm.dissolving = true;
  await writeSwarm(home, swarm);

  const balanceReader = await capitalBalanceReader(swarm, deps, home);
  const memberBalances = await Promise.all(
    swarm.members.map(async (member) => ({
      member,
      cents:
        (await balanceReader({
          account: member.account,
          address: await accountAddress(member, deps),
          network: swarm.network,
        })) / 10_000n,
    })),
  );
  const movements: SwarmMovementResult[] = [];
  const memberLegs = memberBalances
    .filter(({ cents }) => cents > 0n)
    .map(({ member, cents }) => ({
      from: member.account,
      to: swarm.treasury.account,
      amountUsd: formatUsdCents(cents),
      purpose: "sweep" as const,
    }));
  if (memberLegs.length > 0) {
    const memberMovement = movementResult(
      await executeMovement(
        {
          reason: "sweep",
          from: memberLegs[0]!.from,
          dissolution: swarm.name,
          treasury: swarm.treasury.account,
          network: swarm.network,
          legs: memberLegs,
        },
        movementDeps(deps, home),
      ),
      false,
    );
    movements.push(memberMovement);
    if (!movementSent(memberMovement)) {
      return {
        status: "incomplete",
        movements,
        message: `Kept swarm ${swarm.name} because one or more member sweeps were not sent.`,
      };
    }
  }

  const treasuryBalance = await balanceReader({
    account: swarm.treasury.account,
    address: await accountAddress(swarm.treasury, deps),
    network: swarm.network,
  });
  const treasuryCents = treasuryBalance / 10_000n;
  if (treasuryCents > 0n) {
    const ownerMovement = movementResult(
      await executeMovement(
        {
          reason: "sweep",
          from: swarm.treasury.account,
          dissolution: swarm.name,
          treasury: swarm.treasury.account,
          network: swarm.network,
          legs: [{ to: "owner", amountUsd: formatUsdCents(treasuryCents), purpose: "sweep" }],
        },
        movementDeps(deps, home),
      ),
      false,
    );
    movements.push(ownerMovement);
    if (!movementSent(ownerMovement)) {
      return {
        status: "incomplete",
        movements,
        message: `Kept swarm ${swarm.name} because its treasury sweep was not sent.`,
      };
    }
  }

  await deleteSwarmFile(home, swarm.name);
  return {
    status: "dissolved",
    movements,
    message: `Dissolved swarm ${swarm.name}; its accounts and profiles remain on this device. A deposit arriving at the treasury after dissolve stays on the treasury account, which is kept on this device.`,
  };
}

function capitalHome(deps: SwarmCapitalDeps): string {
  return deps.home ?? deps.store.home;
}

function movementDeps(deps: SwarmCapitalDeps, home: string): MovementDependencies {
  return { ...deps, home };
}

export async function readDelegationRecord(
  home: string,
  movementId: string,
): Promise<DelegationRecord | undefined> {
  const safeId = runRecordMovementId(movementId);
  try {
    const record = delegationRecordSchema.parse(
      JSON.parse(await readFile(delegationRecordPath(home, safeId), "utf8")),
    );
    if (record.movementId !== safeId) {
      throw new SwarmError(
        "invalid_swarm",
        `Delegation record ${safeId} names a different movement.`,
      );
    }
    return record;
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    if (error instanceof SwarmError) throw error;
    throw new SwarmError("invalid_swarm", `Invalid delegation record ${safeId}.`);
  }
}

export async function writeDelegationRecord(home: string, record: DelegationRecord): Promise<void> {
  const safeId = runRecordMovementId(record.movementId);
  const parsed = delegationRecordSchema.safeParse(record);
  if (!parsed.success) {
    throw new SwarmError("invalid_swarm", `Invalid delegation record ${safeId}.`);
  }
  await writeJsonAtomic(delegationRecordPath(home, safeId), parsed.data, { mode: 0o600 });
}

async function readTreasuryRequestRecord(
  home: string,
  movementId: string,
): Promise<TreasuryRequestRecord | undefined> {
  const safeId = runRecordMovementId(movementId);
  try {
    const record = treasuryRequestRecordSchema.parse(
      JSON.parse(await readFile(treasuryRequestRecordPath(home, safeId), "utf8")),
    );
    if (record.movementId !== safeId) {
      throw new SwarmError(
        "invalid_swarm",
        `Treasury request record ${safeId} names a different movement.`,
      );
    }
    return record;
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    if (error instanceof SwarmError) throw error;
    throw new SwarmError("invalid_swarm", `Invalid treasury request record ${safeId}.`);
  }
}

async function writeTreasuryRequestRecord(
  home: string,
  record: TreasuryRequestRecord,
): Promise<void> {
  const parsed = treasuryRequestRecordSchema.safeParse(record);
  if (!parsed.success) {
    throw new SwarmError("invalid_swarm", `Invalid treasury request record ${record.movementId}.`);
  }
  const safeId = runRecordMovementId(parsed.data.movementId);
  await writeJsonAtomic(treasuryRequestRecordPath(home, safeId), parsed.data, { mode: 0o600 });
}

function runRecordMovementId(value: string): string {
  const parsed = movementIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new SwarmError("invalid_swarm", "The run record movement id is invalid.");
  }
  return parsed.data;
}

function treasuryRequestRecordPath(home: string, movementId: string): string {
  return join(home, "runs", "requests", `${movementId}.json`);
}

function delegationRecordPath(home: string, movementId: string): string {
  return join(home, "runs", "delegations", `${movementId}.json`);
}

function legacyFundingProgressPath(home: string, name: string): string {
  return join(home, "swarms", `.${name}.funding`);
}

async function readLegacyFundingProgress(
  home: string,
  name: string,
): Promise<LegacyFundingProgress | undefined> {
  try {
    const progress = legacyFundingProgressSchema.parse(
      JSON.parse(await readFile(legacyFundingProgressPath(home, name), "utf8")),
    );
    if (progress.name !== name) {
      throw new SwarmError("invalid_swarm", `Invalid funding progress for swarm ${name}.`);
    }
    return progress;
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    if (error instanceof SwarmError) throw error;
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new SwarmError("invalid_swarm", `Invalid funding progress for swarm ${name}.`);
    }
    throw error;
  }
}

async function migrateLegacySetupFunding(
  swarm: SwarmFile,
  legacy: LegacyFundingProgress,
  home: string,
): Promise<NonNullable<SwarmFile["setupFunding"]>> {
  const fundingMovement = await optionalMovement(home, legacy.fundMovementId);
  const setupFunding: NonNullable<SwarmFile["setupFunding"]> = {
    amountUsd: legacy.amountUsd,
    from: legacy.from,
    movementId: legacy.fundMovementId,
    status: movementStatus(fundingMovement),
    ...(legacy.applyPolicy
      ? {
          policy: {
            strategy: swarm.policy.strategy,
            ...(legacy.policy === undefined ? {} : { movementId: legacy.policy.movementId }),
            status: await legacyPolicyStatus(legacy, home),
            ...(legacy.policy?.blocked.length
              ? {
                  blocked: legacy.policy.blocked.map(({ to, amountUsd, reason }) => ({
                    to,
                    amountUsd,
                    reason,
                  })),
                }
              : {}),
          },
        }
      : {}),
  };
  swarm.setupFunding = setupFunding;
  // Persist the adopted movement IDs before removing the old journal. A crash
  // can therefore leave both records, but can never leave neither record.
  await writeSwarm(home, swarm);
  await deleteLegacyFundingProgress(home, swarm.name);
  return setupFunding;
}

async function legacyPolicyStatus(
  legacy: LegacyFundingProgress,
  home: string,
): Promise<"planned" | "sent" | "incomplete"> {
  if (legacy.policy === undefined) return "planned";
  const movement = await optionalMovement(home, legacy.policy.movementId);
  if (movement === undefined || (await movementHasOpenLeg(home, movement))) return "planned";
  return movement.legs.every((leg) => leg.status === "sent") && legacy.policy.blocked.length === 0
    ? "sent"
    : "incomplete";
}

function movementStatus(movement: Movement | undefined): "planned" | "sent" | "incomplete" {
  if (movement === undefined) return "planned";
  return movement.legs.every((leg) => leg.status === "sent") ? "sent" : "incomplete";
}

async function deleteLegacyFundingProgress(home: string, name: string): Promise<void> {
  try {
    await unlink(legacyFundingProgressPath(home, name));
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

type RecordedSetupPolicy = NonNullable<NonNullable<SwarmFile["setupFunding"]>["policy"]>;

type SetupPolicyOutcome = {
  policy?: SwarmMovementResult | SwarmRebalanceResult;
  blocked: SwarmBlockedLeg[];
  skipped: SwarmSkippedMember[];
  sent: boolean;
  final: boolean;
};

type PlannedSetupPolicy = {
  reason: "allocate" | "rebalance";
  legs: AllocationPlan["legs"];
  blocked: SwarmBlockedLeg[];
  skipped: SwarmSkippedMember[];
  emptyIsSent: boolean;
};

async function applySetupFundingPolicy(
  swarm: SwarmFile,
  amountCents: bigint,
  deps: SwarmCapitalDeps,
  home: string,
): Promise<SetupPolicyOutcome> {
  const policy = swarm.setupFunding?.policy;
  if (policy === undefined) {
    return { blocked: [], skipped: [], sent: true, final: true };
  }

  let existing: Movement | undefined;
  if (policy.movementId !== undefined) {
    existing = await optionalMovement(home, policy.movementId);
    if (existing === undefined) throw missingRecordedMovementError(swarm, policy.movementId);
    if (existing !== undefined) assertSetupPolicyMovement(swarm, policy.strategy, existing);
  } else if (policy.status === "incomplete") {
    const blocked = policy.blocked ?? [];
    return {
      ...(policy.strategy === "targets"
        ? { policy: recordedTargetPolicy(undefined, blocked, [], false) }
        : {}),
      blocked,
      skipped: [],
      sent: false,
      final: true,
    };
  } else if (policy.status === "sent") {
    return {
      ...(policy.strategy === "targets"
        ? { policy: recordedTargetPolicy(undefined, policy.blocked ?? [], [], true) }
        : {}),
      blocked: policy.blocked ?? [],
      skipped: [],
      sent: true,
      final: true,
    };
  }

  let skipped: SwarmSkippedMember[] = [];
  const failedBeforeResume =
    existing === undefined ? [] : failedLegsAsBlocked(movementResult(existing, true));
  let plannedBlocked =
    existing === undefined
      ? []
      : (policy.blocked ?? []).filter(
          (blocked) => !failedBeforeResume.some((failed) => sameBlockedLeg(blocked, failed)),
        );
  let resumed = true;
  if (existing === undefined) {
    const planned = await planSetupPolicy(swarm, policy.strategy, amountCents, deps, home);
    skipped = planned.skipped;
    plannedBlocked = planned.blocked;
    if (planned.legs.length === 0) {
      delete policy.movementId;
      setPolicyBlocked(policy, plannedBlocked);
      const sent = planned.emptyIsSent && plannedBlocked.length === 0;
      policy.status = sent ? "sent" : "incomplete";
      await writeSwarm(home, swarm);
      return {
        ...(policy.strategy === "targets"
          ? { policy: recordedTargetPolicy(undefined, plannedBlocked, skipped, sent) }
          : {}),
        blocked: plannedBlocked,
        skipped,
        sent,
        final: true,
      };
    }

    policy.movementId = nextMovementId(deps);
    policy.status = "planned";
    setPolicyBlocked(policy, plannedBlocked);
    await writeSwarm(home, swarm);
    const recorded = await executeRecordedMovement(
      policy.movementId,
      {
        reason: planned.reason,
        from: swarm.treasury.account,
        treasury: swarm.treasury.account,
        network: swarm.network,
        legs: planned.legs,
      },
      deps,
      home,
    );
    existing = recorded.movement;
    resumed = recorded.resumed;
  } else if (await movementHasOpenLeg(home, existing)) {
    existing = await resumeSetupPolicyMovement(existing, deps, home);
  }

  const movement = movementResult(existing, resumed);
  const blocked = uniqueBlocked([...plannedBlocked, ...failedLegsAsBlocked(movement)]);
  const sent = movementSent(movement) && blocked.length === 0;
  policy.status = sent ? "sent" : "incomplete";
  setPolicyBlocked(policy, blocked);
  await writeSwarm(home, swarm);
  return {
    policy:
      policy.strategy === "targets"
        ? recordedTargetPolicy(movement, blocked, skipped, sent)
        : movement,
    blocked,
    skipped,
    sent,
    final: !(await movementHasOpenLeg(home, existing)),
  };
}

async function planSetupPolicy(
  swarm: SwarmFile,
  strategy: RecordedSetupPolicy["strategy"],
  amountCents: bigint,
  deps: SwarmCapitalDeps,
  home: string,
): Promise<PlannedSetupPolicy> {
  if (strategy !== "targets") {
    const allocation = await fundedAllocation(swarm, amountCents, strategy, deps, home);
    return {
      reason: "allocate",
      legs: allocation.plan.legs,
      blocked: allocation.plan.blocked.map(({ to, amountUsd, reason }) => ({
        to,
        amountUsd,
        reason,
      })),
      skipped: allocation.skipped,
      emptyIsSent: false,
    };
  }

  await deps.store.reload();
  const balanceReader = await capitalBalanceReader(swarm, deps, home);
  const treasuryBalance = await balanceReader({
    account: swarm.treasury.account,
    address: await accountAddress(swarm.treasury, deps),
    network: swarm.network,
  });
  const memberBalances = await Promise.all(
    swarm.members.map(async (member) => ({
      member,
      balanceAtomic: await balanceReader({
        account: member.account,
        address: await accountAddress(member, deps),
        network: swarm.network,
      }),
    })),
  );
  const skipped = swarm.members
    .filter((member) => deps.store.entry(member.account)?.link === undefined)
    .map((member) => ({ account: member.account, reason: "not_linked" }));
  const linked = memberBalances.filter(
    ({ member }) => deps.store.entry(member.account)?.link !== undefined,
  );
  if (linked.length === 0) {
    return { reason: "rebalance", legs: [], blocked: [], skipped, emptyIsSent: true };
  }
  const allocation = planAllocation({
    strategy: "targets",
    treasury: swarm.treasury.account,
    members: await Promise.all(
      linked.map(async ({ member, balanceAtomic }) => ({
        account: member.account,
        balanceAtomic,
        targetAtomic: member.targetAtomic,
        ceilingAtomic: deps.store.ceilingCaps(member.account).ceilingAtomic,
        perDayCapAtomic: (await spendCapsForWallet(deps.store, member.account)).perDayAtomic,
      })),
    ),
    policy: await treasuryPolicy(swarm, treasuryBalance, deps, home),
  });
  return {
    reason: "rebalance",
    legs: allocation.legs,
    blocked: allocation.blocked.map(({ to, amountUsd, reason }) => ({ to, amountUsd, reason })),
    skipped,
    emptyIsSent: true,
  };
}

function recordedTargetPolicy(
  movement: SwarmMovementResult | undefined,
  blocked: SwarmBlockedLeg[],
  skipped: SwarmSkippedMember[],
  sent: boolean,
): SwarmRebalanceResult {
  return {
    status: sent ? (movement === undefined ? "balanced" : "sent") : "incomplete",
    ...(movement === undefined ? {} : { movement }),
    blocked,
    skipped,
    message: sent
      ? movement === undefined
        ? "The swarm already matches its targets policy."
        : "Applied the swarm targets policy."
      : "The setup targets policy is incomplete; run vapi swarm rebalance.",
  };
}

function setPolicyBlocked(policy: RecordedSetupPolicy, blocked: SwarmBlockedLeg[]): void {
  if (blocked.length === 0) delete policy.blocked;
  else policy.blocked = blocked;
}

async function optionalMovement(home: string, id: string): Promise<Movement | undefined> {
  try {
    return await readMovement(home, id);
  } catch (error) {
    if (error instanceof MovementError && error.code === "movement_not_found") return undefined;
    throw error;
  }
}

function nextMovementId(deps: SwarmCapitalDeps): string {
  return movementIdSchema.parse(deps.randomId?.() ?? `mv_${randomBytes(12).toString("hex")}`);
}

async function executeRecordedMovement(
  id: string,
  plan: MovementPlan,
  deps: SwarmCapitalDeps,
  home: string,
  options: { allowCreate?: boolean; swarm?: SwarmFile } = {},
): Promise<{ movement: Movement; resumed: boolean }> {
  try {
    const existing = await readMovement(home, id);
    assertRecordedMovementMatchesPlan(existing, plan);
    if (!(await movementHasOpenLeg(home, existing))) {
      return { movement: existing, resumed: true };
    }
    return {
      movement: await executeMovement({ resume: id }, movementDeps(deps, home)),
      resumed: true,
    };
  } catch (error) {
    if (!(error instanceof MovementError && error.code === "movement_not_found")) throw error;
  }
  if (options.allowCreate === false) {
    if (options.swarm === undefined) {
      throw new SwarmError("invalid_swarm", `Referenced movement ${id} is missing.`);
    }
    throw missingRecordedMovementError(options.swarm, id);
  }
  return {
    movement: await executeMovement(plan, {
      ...movementDeps(deps, home),
      randomId: () => id,
    }),
    resumed: false,
  };
}

function missingRecordedMovementError(swarm: SwarmFile, movementId: string): SwarmError {
  return new SwarmError(
    "invalid_swarm",
    `Swarm ${swarm.name} references movement ${movementId}, but its movement file is missing. The transfer may already have settled. Check balances with vapi swarm status ${swarm.name}, then add capital deliberately with vapi swarm fund ${swarm.name} <usd>.`,
  );
}

async function resumeSetupPolicyMovement(
  movement: Movement,
  deps: SwarmCapitalDeps,
  home: string,
): Promise<Movement> {
  const failed = movement.legs.filter((leg) => leg.status === "failed");
  if (failed.length === 0) {
    return await executeMovement({ resume: movement.id }, movementDeps(deps, home));
  }
  const transfer = deps.transfer ?? transferBetweenAccounts;
  return await executeMovement(
    { resume: movement.id },
    {
      ...movementDeps(deps, home),
      transfer: async (args) => {
        const blocked = failed.find(
          (leg) =>
            leg.from === args.from &&
            leg.to === args.to &&
            leg.amountUsd === String(args.amountUsd) &&
            leg.purpose === args.purpose,
        );
        if (blocked !== undefined) {
          throw new TransferError(
            (blocked.reason ?? "relay_failed") as TransferErrorCode,
            `Setup allocation leg to ${blocked.to} is blocked; use swarm rebalance for a new attempt.`,
          );
        }
        return await transfer(args);
      },
    },
  );
}

function assertRecordedMovementMatchesPlan(movement: Movement, plan: MovementPlan): void {
  plan = splitMovementPlanAtRelayLimit(plan);
  const legacyFundingMovement =
    plan.reason === "send" && plan.treasury !== undefined && movement.treasury === undefined;
  const legsMatch =
    movement.legs.length === plan.legs.length &&
    movement.legs.every((leg, index) => {
      const planned = plan.legs[index];
      return (
        planned !== undefined &&
        leg.from === (planned.from ?? plan.from) &&
        leg.to === planned.to &&
        leg.amountUsd === planned.amountUsd &&
        leg.purpose === (planned.purpose ?? "send")
      );
    });
  if (
    movement.reason !== plan.reason ||
    movement.from !== plan.from ||
    movement.network !== plan.network ||
    (!legacyFundingMovement && movement.treasury !== plan.treasury) ||
    !legsMatch
  ) {
    throw new SwarmError(
      "invalid_swarm",
      `Recorded movement ${movement.id} does not match the swarm funding step.`,
    );
  }
}

function movementResult(movement: Movement, resumed: boolean): SwarmMovementResult {
  return {
    movementId: movement.id,
    reason: movement.reason,
    resumed,
    legs: movement.legs.map((leg) => ({
      from: leg.from,
      to: leg.to,
      amountUsd: leg.amountUsd,
      purpose: leg.purpose,
      status: leg.status,
      ...(leg.txHash === undefined ? {} : { txHash: leg.txHash }),
      ...(leg.reason === undefined ? {} : { reason: leg.reason }),
    })),
    complete: movement.legs.every((leg) => leg.status === "sent"),
  };
}

function movementSent(movement: SwarmMovementResult): boolean {
  return movement.legs.every((leg) => leg.status === "sent");
}

function failedLegsAsBlocked(movement: SwarmMovementResult): SwarmBlockedLeg[] {
  return movement.legs
    .filter((leg) => leg.status === "failed")
    .map((leg) => ({
      to: leg.to,
      amountUsd: leg.amountUsd,
      reason: leg.reason ?? "transfer_failed",
    }));
}

function uniqueBlocked(blocked: SwarmBlockedLeg[]): SwarmBlockedLeg[] {
  const seen = new Set<string>();
  return blocked.filter((leg) => {
    const key = JSON.stringify([leg.to, leg.amountUsd, leg.reason]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sameBlockedLeg(left: SwarmBlockedLeg, right: SwarmBlockedLeg): boolean {
  return left.to === right.to && left.amountUsd === right.amountUsd && left.reason === right.reason;
}

async function findSwarmMovements(
  swarm: SwarmFile,
  home: string,
): Promise<{ resumable: MovementSummary[]; blocking: MovementSummary[] }> {
  const accounts = new Set<string>(swarmAccountNames(swarm));
  const result: { resumable: MovementSummary[]; blocking: MovementSummary[] } = {
    resumable: [],
    blocking: [],
  };
  for (const summary of await listUnfinishedMovements({ home })) {
    const movement = await readMovement(home, summary.id);
    if (!movement.legs.some((leg) => accounts.has(leg.from) || accounts.has(leg.to))) continue;
    result[isResumableSwarmMovement(movement, swarm) ? "resumable" : "blocking"].push(summary);
  }
  return result;
}

async function resumeOrBlock(
  swarm: SwarmFile,
  deps: SwarmCapitalDeps,
  home: string,
): Promise<SwarmMovementResult | undefined> {
  const movements = await findSwarmMovements(swarm, home);
  const blocking = movements.blocking[0];
  if (blocking !== undefined) throw unfinishedMovementError(swarm, blocking.id);
  const resumable = movements.resumable[0];
  if (resumable === undefined) return undefined;
  const movement = await readMovement(home, resumable.id);
  return movementResult(
    resumable.id === swarm.setupFunding?.policy?.movementId
      ? await resumeSetupPolicyMovement(movement, deps, home)
      : await executeMovement({ resume: resumable.id }, movementDeps(deps, home)),
    true,
  );
}

async function resumeOrBlockOther(
  swarm: SwarmFile,
  recordedIds: ReadonlySet<string>,
  deps: SwarmCapitalDeps,
  home: string,
): Promise<SwarmMovementResult | undefined> {
  const movements = await findSwarmMovements(swarm, home);
  const blocking = movements.blocking.find((movement) => !recordedIds.has(movement.id));
  if (blocking !== undefined) throw unfinishedMovementError(swarm, blocking.id);
  const resumable = movements.resumable.find((movement) => !recordedIds.has(movement.id));
  if (resumable === undefined) return undefined;
  return movementResult(
    await executeMovement({ resume: resumable.id }, movementDeps(deps, home)),
    true,
  );
}

function isResumableSwarmMovement(movement: Movement, swarm: SwarmFile): boolean {
  if (
    movement.treasury !== swarm.treasury.account ||
    movement.network !== swarm.network ||
    !resumableSwarmReasons.has(movement.reason)
  ) {
    return false;
  }
  if (movement.reason === "send") {
    // The movement records its funding source in `from`; every funding leg must
    // come from that one source and terminate at this swarm's treasury.
    return movement.legs.every(
      (leg) =>
        leg.from === movement.from && leg.to === swarm.treasury.account && leg.purpose === "send",
    );
  }
  const treasury = swarm.treasury.account;
  const members = new Set(swarm.members.map((member) => member.account));
  if (movement.reason === "allocate" || movement.reason === "delegate") {
    return movement.legs.every(
      (leg) => leg.from === treasury && members.has(leg.to) && leg.purpose === "send",
    );
  }
  if (movement.reason === "rebalance") {
    return movement.legs.every(
      (leg) =>
        (leg.from === treasury && members.has(leg.to) && leg.purpose === "send") ||
        (members.has(leg.from) && leg.to === treasury && leg.purpose === "sweep"),
    );
  }
  return movement.legs.every(
    (leg) =>
      leg.purpose === "sweep" &&
      ((members.has(leg.from) && leg.to === treasury) ||
        (leg.from === treasury && leg.to === "owner")),
  );
}

function isMatchingTreasuryAllocation(
  movement: Movement,
  swarm: SwarmFile,
  member: string,
  reason: AllocateFromTreasuryOptions["reason"],
  authorizedCents: bigint,
): boolean {
  return (
    movement.id !== swarm.setupFunding?.policy?.movementId &&
    movement.reason === reason &&
    movement.treasury === swarm.treasury.account &&
    movementAmountAtomic(movement) <= authorizedCents * 10_000n &&
    movement.legs.every(
      (leg) => leg.from === swarm.treasury.account && leg.to === member && leg.purpose === "send",
    )
  );
}

function movementAmountAtomic(movement: Movement): bigint {
  return movement.legs.reduce((total, leg) => total + parseUsdCents(leg.amountUsd) * 10_000n, 0n);
}

function movementAmounts(movement: SwarmMovementResult): {
  sentCents: bigint;
  unknownCents: bigint;
} {
  return movement.legs.reduce(
    (amounts, leg) => {
      const cents = parseUsdCents(leg.amountUsd);
      if (leg.status === "sent") amounts.sentCents += cents;
      if (leg.status === "unknown") amounts.unknownCents += cents;
      return amounts;
    },
    { sentCents: 0n, unknownCents: 0n },
  );
}

function reserveDraw(draw: RunBudget | undefined, amountAtomic: bigint, movementId: string): void {
  if (draw === undefined) return;
  try {
    draw.reserve(amountAtomic, movementId);
  } catch (error) {
    if (error instanceof RunBudgetError) {
      throw new SwarmError(
        "draw_exceeded",
        `Treasury draw ${draw.id} cannot reserve ${amountAtomic} atomic USDC for movement ${movementId}.`,
      );
    }
    throw error;
  }
}

function replaceDrawReservation(
  draw: RunBudget | undefined,
  amountAtomic: bigint,
  movementId: string,
): void {
  if (draw === undefined) return;
  const previousAtomic = draw.reservedAtomic(movementId);
  draw.release(movementId);
  try {
    reserveDraw(draw, amountAtomic, movementId);
  } catch (error) {
    if (previousAtomic > 0n) draw.reserve(previousAtomic, movementId);
    throw error;
  }
}

function reconcileDraw(draw: RunBudget | undefined, movement: SwarmMovementResult): void {
  if (draw === undefined) return;
  const amounts = movementAmounts(movement);
  draw.release(movement.movementId);
  draw.reserve((amounts.sentCents + amounts.unknownCents) * 10_000n, movement.movementId);
}

function assertSetupPolicyMovement(
  swarm: SwarmFile,
  strategy: RecordedSetupPolicy["strategy"],
  movement: Movement,
): void {
  const expectedReason = strategy === "targets" ? "rebalance" : "allocate";
  if (movement.reason !== expectedReason || !isResumableSwarmMovement(movement, swarm)) {
    throw new SwarmError(
      "invalid_swarm",
      `Recorded setup policy movement ${movement.id} does not belong to swarm ${swarm.name}.`,
    );
  }
}

async function firstUnfinishedMovementTouching(
  home: string,
  account: string,
): Promise<MovementSummary | undefined> {
  for (const summary of await listUnfinishedMovements({ home })) {
    const movement = await readMovement(home, summary.id);
    if (movement.legs.some((leg) => leg.from === account || leg.to === account)) return summary;
  }
  return undefined;
}

function unfinishedMovementError(swarm: SwarmFile, movementId: string): SwarmError {
  return new SwarmError(
    "movement_unfinished",
    `Movement ${movementId} touches swarm ${swarm.name} and is unfinished; resume it with vapi accounts distribute --resume ${movementId}.`,
  );
}

function resumedMessage(movementId: string): string {
  return `Resumed unfinished movement ${movementId} instead of planning a new one.`;
}

function openMovementMessage(movementId: string | undefined): string {
  return movementId === undefined
    ? "The setup movement is unresolved; rerun swarm create or swarm.setup."
    : `Movement ${movementId} is unresolved; resume it with vapi accounts distribute --resume ${movementId}.`;
}

async function capitalBalanceReader(
  swarm: SwarmFile,
  deps: SwarmCapitalDeps,
  home: string,
): Promise<SwarmBalanceReader> {
  if (deps.balanceReader !== undefined) return deps.balanceReader;
  const config = deps.config ?? (await loadConfig(getVapiPaths(home).config));
  const configured = configuredNetworkFor(config.networks, swarm.network);
  if (configured === undefined) {
    throw new SwarmError("invalid_swarm", `Network ${swarm.network} is not configured.`);
  }
  return async ({ address, network }) =>
    await readUsdcBalance({
      address,
      network,
      configured,
      allowPrivateNetwork: config.allowPrivateNetwork,
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    });
}

async function assertSwarmAccountAddresses(
  swarm: SwarmFile,
  deps: SwarmCapitalDeps,
): Promise<void> {
  for (const recorded of [swarm.treasury, ...swarm.members]) {
    if (recorded.address === undefined) {
      throw new SwarmError(
        "invalid_swarm",
        `Account ${recorded.account} is not created yet. Resume swarm setup.`,
      );
    }
    const current = await (deps.addressReader ?? ((name) => deps.store.readAddress(name)))(
      recorded.account,
    );
    if (
      current === undefined ||
      !isAddress(current, { strict: false }) ||
      getAddress(current) !== getAddress(recorded.address)
    ) {
      throw new SwarmError(
        "account_address_mismatch",
        `Account ${recorded.account} in swarm ${swarm.name} no longer matches its recorded address ${recorded.address}. Restore ${recorded.account} to that address on this device, then retry.`,
      );
    }
  }
}

async function reconcilePendingCeilingSweeps(
  swarm: SwarmFile,
  accounts: readonly WalletName[],
  deps: SwarmCapitalDeps,
  home: string,
): Promise<void> {
  const unique = [...new Set(accounts)];
  await deps.store.reload();
  for (const account of unique) {
    if (deps.store.ceilingSweepPending(account) === undefined) continue;
    if (deps.reconcileCeilingSweep !== undefined) {
      await deps.reconcileCeilingSweep(account);
    } else {
      const config = deps.config ?? (await loadConfig(getVapiPaths(home).config));
      await sweepAboveCeiling({
        store: deps.store,
        secrets: deps.secrets,
        apiBase: deps.apiBase,
        account,
        config,
        ...(deps.balanceReader === undefined
          ? {}
          : {
              balanceReader: async ({ address }) =>
                await deps.balanceReader!({ account, address, network: swarm.network }),
            }),
        ...(deps.addressReader === undefined ? {} : { addressReader: deps.addressReader }),
        resolveParent: async (sender) => {
          const member = swarm.members.find((candidate) => candidate.account === sender);
          if (member === undefined || swarm.treasury.address === undefined) return undefined;
          return {
            account: swarm.treasury.account,
            address: getAddress(swarm.treasury.address),
          };
        },
        ...(deps.transfer === undefined ? {} : { transfer: deps.transfer }),
        ...(deps.randomNonce === undefined ? {} : { randomNonce: deps.randomNonce }),
        ...(deps.unlock === undefined ? {} : { unlock: deps.unlock }),
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
        ...(deps.now === undefined ? {} : { now: deps.now }),
        ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
        auditHome: home,
      });
    }
    await deps.store.reload();
    if (deps.store.ceilingSweepPending(account) !== undefined) {
      throw new SwarmError(
        "ceiling_sweep_pending",
        `Account ${account} has an unresolved automatic ceiling sweep. Run vapi status to reconcile it, then retry the swarm command.`,
      );
    }
  }
}

async function accountAddress(
  account: SwarmFile["treasury"] | SwarmMember,
  deps: SwarmCapitalDeps,
): Promise<string> {
  const address = account.address ?? (await deps.store.readAddress(account.account));
  if (address === undefined) {
    throw new SwarmError(
      "invalid_swarm",
      `Account ${account.account} is not created yet. Resume swarm setup.`,
    );
  }
  return address;
}

async function treasuryPolicy(
  swarm: SwarmFile,
  balanceAtomic: bigint,
  deps: SwarmCapitalDeps,
  home: string,
): Promise<{
  balanceAtomic: bigint;
  perCallAtomic: string;
  perDayRemainingAtomic: bigint;
}> {
  const now = new Date((deps.now ?? Date.now)());
  const ledger = await readSpendLedger(
    deps.ledgerPath ?? getVapiPaths(home).ledger,
    now,
    swarm.treasury.account,
  );
  const caps = await spendCapsForWallet(deps.store, swarm.treasury.account);
  const perDayAtomic = BigInt(caps.perDayAtomic);
  const spentAtomic = BigInt(ledger.spentAtomic);
  return {
    balanceAtomic,
    perCallAtomic: caps.perCallAtomic,
    perDayRemainingAtomic: perDayAtomic > spentAtomic ? perDayAtomic - spentAtomic : 0n,
  };
}

async function fundedAllocation(
  swarm: SwarmFile,
  amountCents: bigint,
  strategy: "even" | "weights",
  deps: SwarmCapitalDeps,
  home: string,
): Promise<{ plan: AllocationPlan; skipped: SwarmSkippedMember[] }> {
  await deps.store.reload();
  const linked = swarm.members.filter(
    (member) => deps.store.entry(member.account)?.link !== undefined,
  );
  const skipped = swarm.members
    .filter((member) => deps.store.entry(member.account)?.link === undefined)
    .map((member) => ({ account: member.account, reason: "not_linked" }));
  if (linked.length === 0) return { plan: { legs: [], blocked: [] }, skipped };
  const amountUsd = formatUsdCents(amountCents);
  const balanceReader = await capitalBalanceReader(swarm, deps, home);
  const balanceAtomic = await balanceReader({
    account: swarm.treasury.account,
    address: await accountAddress(swarm.treasury, deps),
    network: swarm.network,
  });
  const policy = await treasuryPolicy(swarm, balanceAtomic, deps, home);
  const recipients = await Promise.all(
    linked.map(async (member) => ({
      to: member.account,
      weight: strategy === "even" ? 1 : member.weight,
      balanceAtomic: await balanceReader({
        account: member.account,
        address: await accountAddress(member, deps),
        network: swarm.network,
      }),
      ceilingAtomic: deps.store.ceilingCaps(member.account).effectiveCeilingAtomic,
    })),
  );
  const plan =
    strategy === "even"
      ? planAllocation({
          strategy: "even",
          from: swarm.treasury.account,
          recipients: recipients.map(({ to, balanceAtomic, ceilingAtomic }) => ({
            to,
            balanceAtomic,
            ceilingAtomic,
          })),
          amountUsd,
          policy,
        })
      : planAllocation({
          strategy: "weights",
          from: swarm.treasury.account,
          recipients,
          amountUsd,
          policy,
        });
  return { plan, skipped };
}

function targetAtomic(
  member: SwarmMember,
  targetsUsd: Record<string, string | number> | undefined,
): string {
  const override = targetsUsd?.[member.account] ?? targetsUsd?.[member.role];
  return override === undefined ? member.targetAtomic : usdToAtomic(override).toString();
}

async function removeMemberLocked(home: string, swarm: SwarmFile, account: string): Promise<void> {
  const index = swarm.members.findIndex((member) => member.account === account);
  if (index === -1) return;
  swarm.members.splice(index, 1);
  await writeSwarm(home, swarm);
}
