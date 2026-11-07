import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  createAccount,
  startAccountLink,
  type AccountCapsInput,
  type AccountLinkOutcome,
  type StartAccountLinkArgs,
} from "./account-add.js";
import { DEFAULT_AGENT_TOOLS, writeAgentProfile, type AgentGrant } from "./agent-profile.js";
import { FileLockedError, withFileLock, writeJsonAtomic } from "./atomic-file.js";
import {
  DEFAULT_SPEND_CAPS,
  getVapiPaths,
  isMissingFile,
  loadConfig,
  type SpendCaps,
  type VapiConfig,
} from "./config.js";
import { DEVICE_NAME_PATTERN, ensureDeviceName } from "./device.js";
import { listUnfinishedMovements, readMovement, type MovementSummary } from "./movement.js";
import { configuredNetworkFor, formatUsdc } from "./networks.js";
import type { SecretStore } from "./secret-store.js";
import { readUsdcBalance } from "./sweep.js";
import type { TransferNetwork } from "./transfer.js";
import { walletNameSchema, type WalletName } from "./wallet-name.js";
import type { WalletStore } from "./wallet-store.js";
import {
  ARC_MAINNET_CAIP2,
  BASE_MAINNET_CAIP2,
  type CanonicalX402UsdcNetwork,
} from "./x402-networks.js";
import { usdToAtomic } from "./x402.js";

export const SWARM_NAME_PATTERN = /^[a-z][a-z0-9-]{0,15}$/;
export const SWARM_ROLE_PATTERN = /^[a-z][a-z0-9]{0,7}$/;
export const DEFAULT_SWARM_MODEL = "venice/claude-sonnet-5";
export type SwarmStrategy = "targets" | "even" | "weights";
export const SWARM_TREASURY_CAPS = { perCallAtomic: "5000000", perDayAtomic: "20000000" } as const;

const atomicSchema = z.string().regex(/^\d+$/);
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const capsSchema = z.strictObject({ perCallAtomic: atomicSchema, perDayAtomic: atomicSchema });
const movementIdSchema = z.string().regex(/^mv_[A-Za-z0-9_-]{8,128}$/u);
const amountUsdSchema = z.string().regex(/^\d+\.\d{2}$/u);
const setupFundingStatusSchema = z.enum(["planned", "sent", "incomplete"]);
const blockedFundingLegSchema = z.strictObject({
  to: z.string().trim().min(1),
  amountUsd: amountUsdSchema,
  reason: z.string().trim().min(1),
});
const setupFundingSchema = z.strictObject({
  amountUsd: amountUsdSchema,
  from: walletNameSchema,
  movementId: movementIdSchema.optional(),
  status: setupFundingStatusSchema,
  policy: z
    .strictObject({
      strategy: z.enum(["targets", "even", "weights"]),
      movementId: movementIdSchema.optional(),
      status: setupFundingStatusSchema,
      blocked: z.array(blockedFundingLegSchema).optional(),
    })
    .optional(),
});
const accountSteps = {
  creating: z.boolean().default(false),
  created: z.boolean(),
  capped: z.boolean(),
  linked: z.boolean(),
};
const treasurySchema = z
  .strictObject({
    account: walletNameSchema,
    // A planned account has no address until its vault derivation succeeds.
    address: addressSchema.optional(),
    steps: z.strictObject(accountSteps),
  })
  .refine(
    (value) => !value.steps.created || value.address !== undefined,
    "Created accounts require an address.",
  );
const memberSchema = z
  .strictObject({
    account: walletNameSchema,
    address: addressSchema.optional(),
    role: z.string().regex(SWARM_ROLE_PATTERN),
    weight: z.number().int().positive(),
    targetAtomic: atomicSchema,
    ceilingAtomic: atomicSchema.nullable(),
    steps: z.strictObject({ ...accountSteps, profiled: z.boolean() }),
  })
  .refine(
    (value) => !value.steps.created || value.address !== undefined,
    "Created accounts require an address.",
  );
export const swarmFileSchema = z
  .strictObject({
    v: z.literal(1),
    name: z.string().regex(SWARM_NAME_PATTERN),
    device: z.string().regex(DEVICE_NAME_PATTERN),
    network: z.enum([BASE_MAINNET_CAIP2, ARC_MAINNET_CAIP2]),
    createdAt: z.iso.datetime(),
    treasury: treasurySchema,
    members: z.array(memberSchema),
    setupFunding: setupFundingSchema.optional(),
    policy: z.strictObject({
      strategy: z.enum(["targets", "even", "weights"]),
      treasuryCaps: capsSchema,
    }),
  })
  .refine(
    (value) =>
      new Set([value.treasury.account, ...value.members.map((member) => member.account)]).size ===
      value.members.length + 1,
    "Swarm accounts must be unique.",
  );

export type SwarmFile = z.infer<typeof swarmFileSchema>;
export type SwarmMember = SwarmFile["members"][number];
export type SwarmErrorCode =
  | "invalid_swarm"
  | "swarm_not_found"
  | "swarm_exists_different_shape"
  | "account_in_other_swarm"
  | "account_name_taken"
  | "name_too_long"
  | "treasury_refused"
  | "member_not_found"
  | "member_not_linked"
  | "draw_exceeded"
  | "request_conflict"
  | "movement_unfinished"
  | "ceiling_sweep_pending"
  | "account_address_mismatch"
  | "swarm_locked"
  | "swarm_workers_active";
export class SwarmError extends Error {
  constructor(
    readonly code: SwarmErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SwarmError";
  }
}

export function swarmsDirectory(home: string): string {
  return join(home, "swarms");
}
export function swarmFilePath(home: string, name: string): string {
  assertName(name);
  return join(swarmsDirectory(home), `${name}.json`);
}
export async function readSwarm(home: string, name: string): Promise<SwarmFile> {
  const path = swarmFilePath(home, name);
  try {
    const swarm = parseSwarm(JSON.parse(await readFile(path, "utf8")));
    if (swarm.name !== name)
      throw new SwarmError("invalid_swarm", "Swarm name does not match its file.");
    return swarm;
  } catch (error) {
    if (isMissingFile(error)) throw new SwarmError("swarm_not_found", `No swarm named ${name}.`);
    if (error instanceof SwarmError) throw error;
    throw new SwarmError("invalid_swarm", `Invalid swarm file for ${name}.`);
  }
}
export async function listSwarms(home: string): Promise<SwarmFile[]> {
  let files: string[];
  try {
    files = await readdir(swarmsDirectory(home));
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  return await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .sort()
      .map((file) => readSwarm(home, file.slice(0, -5))),
  );
}
export async function writeSwarm(home: string, value: SwarmFile): Promise<void> {
  const swarm = parseSwarm(value);
  const path = swarmFilePath(home, swarm.name);
  const bytes = `${JSON.stringify(swarm, null, 2)}\n`;
  try {
    if ((await readFile(path, "utf8")) === bytes) return;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  await writeJsonAtomic(path, swarm, { mode: 0o600 });
}
export async function deleteSwarmFile(home: string, name: string): Promise<void> {
  try {
    await unlink(swarmFilePath(home, name));
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}
export async function withSwarmLock<T>(
  home: string,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  assertName(name);
  const path = join(swarmsDirectory(home), `.${name}.lock`);
  try {
    return await withFileLock(path, fn, { lockedMessage: `Swarm ${name} is locked.` });
  } catch (error) {
    if (error instanceof FileLockedError) throw new SwarmError("swarm_locked", error.message);
    throw error;
  }
}
export function swarmAccountNames(swarm: SwarmFile): WalletName[] {
  return [swarm.treasury.account, ...swarm.members.map((member) => member.account)];
}
export function swarmTreasuryName(name: string): WalletName {
  assertName(name);
  return derivedName(`${name}-treasury`);
}
export function swarmMemberName(name: string, role: string, n: number): WalletName {
  assertName(name);
  assertRole(role);
  if (!Number.isSafeInteger(n) || n < 1)
    throw new SwarmError("invalid_swarm", "Member index must be a positive integer.");
  return derivedName(`${name}-${role}-${n}`);
}
export function roleDefaults(role: string): {
  weight: number;
  targetAtomic: string;
  ceilingAtomic: string;
} {
  assertRole(role);
  return role === "lead"
    ? { weight: 2, targetAtomic: "2000000", ceilingAtomic: "10000000" }
    : { weight: 1, targetAtomic: "1000000", ceilingAtomic: "5000000" };
}
export function roleGrants(role: string): AgentGrant[] {
  assertRole(role);
  return role === "lead" ? ["read", "delegate", "allocate"] : ["read"];
}
export function swarmParentResolver(
  home: string,
): (account: WalletName) => Promise<{ account: WalletName; address: `0x${string}` } | undefined> {
  return async (account) => {
    const swarms = await listSwarms(home);
    const matches = swarms.filter((swarm) =>
      swarm.members.some((member) => member.account === account),
    );
    if (matches.length > 1)
      throw new SwarmError(
        "account_in_other_swarm",
        `Account ${account} belongs to multiple swarms.`,
      );
    const treasury = matches[0]?.treasury;
    if (treasury === undefined) return undefined;
    if (treasury.address === undefined)
      throw new SwarmError("invalid_swarm", "The swarm treasury is not created yet.");
    return { account: treasury.account, address: treasury.address as `0x${string}` };
  };
}

type LinkOptions = Pick<
  StartAccountLinkArgs,
  | "fetchImpl"
  | "startDeviceLink"
  | "pollDeviceLink"
  | "saveAgentLink"
  | "sleep"
  | "signal"
  | "configPath"
  | "env"
  | "hostname"
  | "awaitApproval"
>;
export type SetupSwarmOptions = LinkOptions & {
  home?: string;
  store: WalletStore;
  secrets: SecretStore;
  apiBase: string;
  name: string;
  agents?: number;
  roles?: string[];
  strategy?: SwarmStrategy;
  targetsUsd?: Record<string, string | number>;
  weights?: Record<string, number>;
  ceilingsUsd?: Record<string, string | number | null>;
  caps?: { perCallUsd: string | number; perDayUsd: string | number };
  treasuryCaps?: { perCallUsd: string | number; perDayUsd: string | number };
  network?: TransferNetwork;
  model?: string;
  surface: "cli" | "mcp";
  now?: () => Date;
};
export type AddSwarmMemberOptions = Omit<
  SetupSwarmOptions,
  "agents" | "roles" | "strategy" | "treasuryCaps" | "network"
> & {
  role: string;
  targetUsd?: string | number;
  weight?: number;
  ceilingUsd?: string | number | null;
};
export type SwarmNextStep =
  | {
      kind: "link";
      account: string;
      userCode: string;
      verificationUri: string;
      verificationUriComplete: string;
      expiresInSeconds: number;
    }
  | { kind: "caps"; account: string; command: string };
export type SwarmMemberSetupStatus = {
  account: string;
  address: string;
  role: string;
  created: boolean;
  capped: boolean;
  profiled: boolean;
  linked: boolean;
};
export type SwarmSetupResult = {
  swarm: SwarmFile;
  members: SwarmMemberSetupStatus[];
  next: SwarmNextStep[];
  completions: Map<string, Promise<AccountLinkOutcome>>;
};

export async function setupSwarm(opts: SetupSwarmOptions): Promise<SwarmSetupResult> {
  const home = opts.home ?? opts.store.home;
  const roles = selectedRoles(opts);
  const network = opts.network ?? BASE_MAINNET_CAIP2;
  const strategy = opts.strategy ?? "targets";
  const plannedMembers = planMembers(opts.name, roles, opts);
  const treasuryAccount = swarmTreasuryName(opts.name);
  const treasuryCaps = resolveCaps(opts.treasuryCaps, SWARM_TREASURY_CAPS);
  resolveCaps(opts.caps, DEFAULT_SPEND_CAPS);
  const result = await withSwarmLock(home, opts.name, async () => {
    let swarm = await optionalSwarm(home, opts.name);
    if (swarm !== undefined) {
      if (
        JSON.stringify(swarm.members.map((member) => member.role)) !== JSON.stringify(roles) ||
        swarm.network !== network ||
        swarm.policy.strategy !== strategy
      ) {
        throw new SwarmError(
          "swarm_exists_different_shape",
          "This swarm has a different shape; use swarm add/leave.",
        );
      }
    } else {
      await assertNoConflicts(home, opts.name, [
        treasuryAccount,
        ...plannedMembers.map((member) => member.account),
      ]);
      swarm = parseSwarm({
        v: 1,
        name: opts.name,
        device: await ensureDeviceName({
          env: opts.env,
          hostname: opts.hostname,
          configPath: opts.configPath ?? getVapiPaths(home).config,
        }),
        network,
        createdAt: (opts.now?.() ?? new Date()).toISOString(),
        treasury: {
          account: treasuryAccount,
          steps: { creating: false, created: false, capped: false, linked: false },
        },
        members: plannedMembers,
        policy: { strategy, treasuryCaps },
      });
      await writeSwarm(home, swarm);
    }
    await assertNoConflicts(home, opts.name, swarmAccountNames(swarm));
    await refuseTreasuryProfile(home, swarm.treasury.account);
    return await provisionSwarm(opts, home, swarm, [swarm.treasury, ...swarm.members]);
  });
  return trackApprovals(home, result);
}

export async function addSwarmMember(opts: AddSwarmMemberOptions): Promise<SwarmSetupResult> {
  const home = opts.home ?? opts.store.home;
  assertRole(opts.role);
  resolveCaps(opts.caps, DEFAULT_SPEND_CAPS);
  const result = await withSwarmLock(home, opts.name, async () => {
    const swarm = await readSwarm(home, opts.name);
    await refuseTreasuryProfile(home, swarm.treasury.account);
    await opts.store.reload();
    let member = swarm.members.find(
      (candidate) =>
        candidate.role === opts.role &&
        (!candidate.steps.created ||
          !candidate.steps.capped ||
          !candidate.steps.profiled ||
          opts.store.entry(candidate.account)?.link === undefined),
    );
    if (member === undefined) {
      let n =
        Math.max(
          0,
          ...swarm.members
            .filter((candidate) => candidate.role === opts.role)
            .map((candidate) => Number(candidate.account.split("-").at(-1)) || 0),
        ) + 1;
      do {
        member = plannedMember(opts.name, opts.role, n, {
          targetUsd: opts.targetUsd ?? opts.targetsUsd?.[opts.role],
          weight: opts.weight ?? opts.weights?.[opts.role],
          ceilingUsd:
            opts.ceilingUsd === undefined ? opts.ceilingsUsd?.[opts.role] : opts.ceilingUsd,
        });
        await assertNoConflicts(home, opts.name, [member.account]);
        n += 1;
      } while (
        opts.store.entry(member.account) !== undefined ||
        (await opts.store.hasVaultAccount(member.account))
      );
      swarm.members.push(member);
      await writeSwarm(home, swarm);
    }
    return await provisionSwarm(opts, home, swarm, [member]);
  });
  return trackApprovals(home, result);
}

async function provisionSwarm(
  opts: SetupSwarmOptions | AddSwarmMemberOptions,
  home: string,
  swarm: SwarmFile,
  accounts: Array<SwarmFile["treasury"] | SwarmMember>,
): Promise<SwarmSetupResult> {
  const result: SwarmSetupResult = { swarm, members: [], next: [], completions: new Map() };
  for (const account of accounts) {
    const member = "role" in account ? account : undefined;
    const desired =
      member === undefined ? swarm.policy.treasuryCaps : resolveCaps(opts.caps, DEFAULT_SPEND_CAPS);
    const desiredCeiling =
      member === undefined || member.ceilingAtomic === null ? null : BigInt(member.ceilingAtomic);
    await opts.store.reload();
    const existedBeforeCreate =
      opts.store.entry(account.account) !== undefined ||
      (await opts.store.hasVaultAccount(account.account));
    if (!account.steps.creating && !account.steps.created && existedBeforeCreate) {
      throw new SwarmError(
        "account_name_taken",
        `Account ${account.account} already exists; account name taken. Choose another swarm name or remove the existing account first.`,
      );
    }
    if (!account.steps.creating && !account.steps.created) {
      account.steps.creating = true;
      await writeSwarm(home, swarm);
    }
    const created = await createAccount({
      store: opts.store,
      name: account.account,
      existing: "return",
    });
    if (!(await opts.store.hasVaultAccount(account.account)))
      throw new SwarmError(
        "invalid_swarm",
        `Account ${account.account} has no key on this device.`,
      );
    if (
      account.address !== undefined &&
      account.address.toLowerCase() !== created.address.toLowerCase()
    )
      throw new SwarmError(
        "invalid_swarm",
        `Account ${account.account} has a different address on this device.`,
      );
    account.address = created.address;
    account.steps.created = true;
    await writeSwarm(home, swarm);
    if (account.steps.creating && !account.steps.capped) {
      if (existedBeforeCreate) {
        await opts.store.lowerProvisioningLimits(account.account, desired, desiredCeiling);
      } else {
        await opts.store.setSpendCaps(account.account, desired);
        await opts.store.setCeiling(account.account, desiredCeiling);
      }
      account.steps.capped = true;
      await writeSwarm(home, swarm);
    }
    const current = opts.store.resolve({ name: account.account }).entry;
    if (
      desired.perCallAtomic !== current.spendCaps.perCallAtomic ||
      desired.perDayAtomic !== current.spendCaps.perDayAtomic
    ) {
      result.next.push({
        kind: "caps",
        account: account.account,
        command: `vapi accounts caps ${account.account} --per-call ${formatUsdc(BigInt(desired.perCallAtomic))} --per-day ${formatUsdc(BigInt(desired.perDayAtomic))}`,
      });
    }
    if (opts.store.ceilingCaps(account.account).ceilingAtomic !== desiredCeiling) {
      result.next.push({
        kind: "caps",
        account: account.account,
        command: `vapi accounts caps ${account.account} --ceiling ${desiredCeiling === null ? "off" : formatUsdc(desiredCeiling)}`,
      });
    }
    if (member !== undefined) {
      if (!(await profileExists(home, member.account))) {
        await writeAgentProfile(home, {
          version: 1,
          name: member.account,
          wallet: member.account,
          model: opts.model ?? DEFAULT_SWARM_MODEL,
          instructions: `You are the ${member.role} agent in the ${swarm.name} swarm. Complete your assigned tasks carefully and use the available tools within your spending limits.`,
          tools: [...DEFAULT_AGENT_TOOLS],
          grants: roleGrants(member.role),
          verifiedOnly: true,
          approveAboveUsd: 0.5,
          maxSteps: 12,
          paused: false,
          createdAt: (opts.now?.() ?? new Date()).toISOString(),
        });
      }
      member.steps.profiled = true;
      await writeSwarm(home, swarm);
    }
    await opts.store.reload();
    account.steps.linked = opts.store.entry(account.account)?.link !== undefined;
    if (!account.steps.linked) {
      const link = await startAccountLink({
        store: opts.store,
        secrets: opts.secrets,
        apiBase: opts.apiBase,
        account: account.account,
        configPath: opts.configPath ?? getVapiPaths(home).config,
        env: opts.env,
        hostname: opts.hostname,
        fetchImpl: opts.fetchImpl,
        startDeviceLink: opts.startDeviceLink,
        pollDeviceLink: opts.pollDeviceLink,
        saveAgentLink: opts.saveAgentLink,
        sleep: opts.sleep,
        signal: opts.signal,
        awaitApproval: opts.awaitApproval,
        ...(opts.now === undefined ? {} : { now: () => opts.now!().getTime() }),
      });
      if (link.linkError !== undefined) {
        throw new SwarmError(
          "invalid_swarm",
          `Account ${account.account} could not be linked. Retry swarm setup.`,
        );
      }
      account.steps.linked = link.linked;
      if (link.link !== undefined)
        result.next.push({ kind: "link", account: account.account, ...link.link });
      if (link.completion !== undefined) {
        result.completions.set(account.account, link.completion);
      }
    }
    await writeSwarm(home, swarm);
  }
  const allAccounts: Array<SwarmFile["treasury"] | SwarmMember> = [
    swarm.treasury,
    ...swarm.members,
  ];
  result.members = allAccounts.map((account) => ({
    account: account.account,
    address: account.address ?? "",
    role: "role" in account ? account.role : "treasury",
    ...account.steps,
    profiled: "role" in account ? account.steps.profiled : false,
    linked: opts.store.entry(account.account)?.link !== undefined,
  }));
  return result;
}

function trackApprovals(home: string, result: SwarmSetupResult): SwarmSetupResult {
  // Attach these continuations only after provisioning releases the lock.
  // Re-read the file so a later approval cannot overwrite newer members.
  for (const [account, completion] of result.completions) {
    const address = result.members.find((member) => member.account === account)?.address;
    result.completions.set(
      account,
      completion.then(async (outcome) => {
        const publicOutcome: AccountLinkOutcome = outcome.linked
          ? outcome
          : {
              ...outcome,
              message: `Account ${account} could not be linked. Retry swarm setup.`,
            };
        if (outcome.linked) {
          try {
            await withSwarmLock(home, result.swarm.name, async () => {
              const latest = await optionalSwarm(home, result.swarm.name);
              if (latest === undefined) return;
              const target = [latest.treasury, ...latest.members].find(
                (candidate) => candidate.account === account && candidate.address === address,
              );
              if (target === undefined) return;
              target.steps.linked = true;
              await writeSwarm(home, latest);
            });
          } catch {
            // The wallet link is already durable and is the source of truth for
            // status. A busy or damaged swarm journal must not turn a detached
            // MCP continuation into an unhandled rejection; the next setup
            // call will reconcile the step marker from the wallet store.
          }
        }
        return publicOutcome;
      }),
    );
  }
  return result;
}

export type SwarmBalanceReader = (input: {
  account: WalletName;
  address: string;
  network: CanonicalX402UsdcNetwork;
}) => Promise<bigint>;
export type SwarmStatusOptions = {
  home?: string;
  store: WalletStore;
  name: string;
  balanceReader?: SwarmBalanceReader;
  config?: VapiConfig;
  fetchImpl?: typeof fetch;
};
export type SwarmStatusResult = {
  swarm: string;
  network: TransferNetwork;
  strategy: SwarmStrategy;
  treasury: {
    account: string;
    address: string;
    linked: boolean;
    balanceAtomic: string;
    balanceUsd: string;
  };
  members: Array<{
    account: string;
    address: string;
    role: string;
    weight: number;
    targetUsd: string;
    ceilingUsd: string | null;
    linked: boolean;
    profile: boolean;
    balanceAtomic: string;
    balanceUsd: string;
    allocatedInUsd: string;
    sweptOutUsd: string;
    netUsd: string;
  }>;
  openMovements: MovementSummary[];
};
export async function swarmStatus(opts: SwarmStatusOptions): Promise<SwarmStatusResult> {
  const home = opts.home ?? opts.store.home;
  const swarm = await readSwarm(home, opts.name);
  await opts.store.reload();
  let balanceReader = opts.balanceReader;
  if (balanceReader === undefined) {
    const config = opts.config ?? (await loadConfig(getVapiPaths(home).config));
    const configured = configuredNetworkFor(config.networks, swarm.network);
    if (configured === undefined)
      throw new SwarmError("invalid_swarm", `Network ${swarm.network} is not configured.`);
    balanceReader = async ({ address, network }) =>
      await readUsdcBalance({
        address,
        network,
        configured,
        allowPrivateNetwork: config.allowPrivateNetwork,
        fetchImpl: opts.fetchImpl,
      });
  }
  const totals = new Map(
    swarm.members.map((member) => [member.account, { allocated: 0n, swept: 0n }]),
  );
  let movementFiles: string[];
  try {
    movementFiles = await readdir(join(home, "movements"));
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    movementFiles = [];
  }
  for (const file of movementFiles.filter((name) => name.endsWith(".json")).sort()) {
    const movement = await readMovement(home, file.slice(0, -5));
    if (movement.treasury !== swarm.treasury.account) continue;
    for (const leg of movement.legs) {
      if (leg.status !== "sent") continue;
      const incoming = totals.get(leg.to);
      const outgoing = totals.get(leg.from);
      if (leg.from === swarm.treasury.account && incoming)
        incoming.allocated += usdToAtomic(leg.amountUsd);
      if (leg.to === swarm.treasury.account && outgoing)
        outgoing.swept += usdToAtomic(leg.amountUsd);
    }
  }
  const summary = async (account: SwarmFile["treasury"] | SwarmMember) => {
    const address = account.address ?? (await opts.store.readAddress(account.account));
    if (address === undefined)
      throw new SwarmError(
        "invalid_swarm",
        `Account ${account.account} is not created yet. Resume swarm setup.`,
      );
    const balance = await balanceReader({
      account: account.account,
      address,
      network: swarm.network,
    });
    return {
      account: account.account,
      address,
      linked: opts.store.entry(account.account)?.link !== undefined,
      balanceAtomic: balance.toString(),
      balanceUsd: fixedUsd(balance),
    };
  };
  const treasury = await summary(swarm.treasury);
  const members = await Promise.all(
    swarm.members.map(async (member) => {
      const balance = await summary(member);
      const total = totals.get(member.account)!;
      return {
        ...balance,
        role: member.role,
        weight: member.weight,
        targetUsd: fixedUsd(BigInt(member.targetAtomic)),
        ceilingUsd: member.ceilingAtomic === null ? null : fixedUsd(BigInt(member.ceilingAtomic)),
        profile: await profileExists(home, member.account),
        allocatedInUsd: fixedUsd(total.allocated),
        sweptOutUsd: fixedUsd(total.swept),
        netUsd: fixedUsd(BigInt(balance.balanceAtomic) - total.allocated + total.swept),
      };
    }),
  );
  const accounts = new Set<string>(swarmAccountNames(swarm));
  const open: MovementSummary[] = [];
  for (const summary of await listUnfinishedMovements({ home })) {
    const movement = await readMovement(home, summary.id);
    if (
      movement.treasury === swarm.treasury.account ||
      movement.legs.some((leg) => accounts.has(leg.from) || accounts.has(leg.to))
    ) {
      open.push(summary);
    }
  }
  return {
    swarm: swarm.name,
    network: swarm.network,
    strategy: swarm.policy.strategy,
    treasury,
    members,
    openMovements: open.sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    ),
  };
}

function fixedUsd(amount: bigint): string {
  const absolute = amount < 0n ? -amount : amount;
  return `${amount < 0n ? "-" : ""}${absolute / 1_000_000n}.${((absolute % 1_000_000n) / 10_000n).toString().padStart(2, "0")}`;
}
function parseSwarm(value: unknown): SwarmFile {
  const result = swarmFileSchema.safeParse(value);
  if (!result.success) throw new SwarmError("invalid_swarm", "Invalid swarm state.");
  return result.data;
}
function assertName(name: string): void {
  if (!SWARM_NAME_PATTERN.test(name))
    throw new SwarmError(
      "invalid_swarm",
      "A swarm name must be 1 to 16 lowercase letters, digits or dashes, starting with a letter.",
    );
}
function assertRole(role: string): void {
  if (!SWARM_ROLE_PATTERN.test(role))
    throw new SwarmError(
      "invalid_swarm",
      "A role must be 1 to 8 lowercase letters or digits, starting with a letter.",
    );
}
function derivedName(name: string): string {
  if (name.length > 32)
    throw new SwarmError("name_too_long", `Derived account name ${name} exceeds 32 characters.`);
  return walletNameSchema.parse(name);
}
function selectedRoles(opts: SetupSwarmOptions): string[] {
  if (opts.roles !== undefined) {
    if (opts.roles.length === 0)
      throw new SwarmError("invalid_swarm", "A swarm requires at least one member.");
    opts.roles.forEach(assertRole);
    return opts.roles;
  }
  const n = opts.agents ?? 2;
  if (!Number.isSafeInteger(n) || n < 1)
    throw new SwarmError("invalid_swarm", "Agent count must be a positive integer.");
  return ["lead", ...Array.from({ length: n - 1 }, () => "helper")];
}
function resolveCaps(caps: AccountCapsInput | undefined, fallback: SpendCaps): SpendCaps {
  const resolved = {
    perCallAtomic:
      caps?.perCallUsd === undefined
        ? fallback.perCallAtomic
        : usdToAtomic(caps.perCallUsd).toString(),
    perDayAtomic:
      caps?.perDayUsd === undefined
        ? fallback.perDayAtomic
        : usdToAtomic(caps.perDayUsd).toString(),
  };
  if (BigInt(resolved.perCallAtomic) > BigInt(resolved.perDayAtomic))
    throw new SwarmError("invalid_swarm", "Per-call caps cannot exceed per-day caps.");
  return resolved;
}
function plannedMember(
  name: string,
  role: string,
  n: number,
  overrides: { targetUsd?: string | number; weight?: number; ceilingUsd?: string | number | null },
): SwarmMember {
  const defaults = roleDefaults(role);
  return memberSchema.parse({
    account: swarmMemberName(name, role, n),
    role,
    weight: overrides.weight ?? defaults.weight,
    targetAtomic:
      overrides.targetUsd === undefined
        ? defaults.targetAtomic
        : usdToAtomic(overrides.targetUsd).toString(),
    ceilingAtomic:
      overrides.ceilingUsd === undefined
        ? defaults.ceilingAtomic
        : overrides.ceilingUsd === null
          ? null
          : usdToAtomic(overrides.ceilingUsd).toString(),
    steps: { creating: false, created: false, capped: false, profiled: false, linked: false },
  });
}
function planMembers(name: string, roles: string[], opts: SetupSwarmOptions): SwarmMember[] {
  const counts = new Map<string, number>();
  return roles.map((role) => {
    const n = (counts.get(role) ?? 0) + 1;
    counts.set(role, n);
    return plannedMember(name, role, n, {
      targetUsd: opts.targetsUsd?.[role],
      weight: opts.weights?.[role],
      ceilingUsd: opts.ceilingsUsd?.[role],
    });
  });
}
async function optionalSwarm(home: string, name: string): Promise<SwarmFile | undefined> {
  try {
    return await readSwarm(home, name);
  } catch (error) {
    if (error instanceof SwarmError && error.code === "swarm_not_found") return undefined;
    throw error;
  }
}
async function assertNoConflicts(home: string, name: string, accounts: string[]): Promise<void> {
  const wanted = new Set(accounts);
  for (const swarm of await listSwarms(home))
    if (swarm.name !== name)
      for (const account of swarmAccountNames(swarm))
        if (wanted.has(account))
          throw new SwarmError(
            "account_in_other_swarm",
            `Account ${account} already belongs to swarm ${swarm.name}.`,
          );
}
async function profileExists(home: string, account: string): Promise<boolean> {
  try {
    await stat(join(getVapiPaths(home).agentsDir, `${account}.json`));
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}
async function refuseTreasuryProfile(home: string, account: string): Promise<void> {
  if (await profileExists(home, account))
    throw new SwarmError("invalid_swarm", `Treasury ${account} must not have an agent profile.`);
}
