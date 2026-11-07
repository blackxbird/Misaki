import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import {
  mkdtemp as nodeMkdtemp,
  readdir,
  readFile,
  rm as nodeRm,
  stat as nodeStat,
  writeFile as nodeWriteFile,
} from "node:fs/promises";
import { tmpdir as osTmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  activeAgentMarker,
  appendAudit,
  ARC_TESTNET_CAIP2,
  CANONICAL_X402_USDC_NETWORKS,
  configuredNetworkFor,
  formatUsdAmount,
  getNetworkDefinition,
  getVapiPaths,
  isRunId,
  listUnfinishedMovements,
  loadConfig,
  loadOrCreateDeviceKey,
  readReceipts,
  readSpendLedger,
  readAgentProfile,
  readSwarm as coreReadSwarm,
  readUsdcBalance,
  readVaultFileUnlocked,
  secretStore,
  SpendCapExceededError,
  reserveSpend,
  unlockProtectedVault,
  usdToAtomic,
  WalletStore,
  writeJsonAtomic,
  type AgentProfile,
  type SecretStore,
  type SwarmBalanceReader,
  type SwarmFile,
  type SwarmMember,
  type VapiConfig,
  type WalletName,
} from "@vapi-network/core";
import {
  createMemberBundle,
  exportMemberKey,
  MemberBundleError,
  memberBundleConfig,
  readMemberCredentials,
  type MemberBundleConfig,
} from "@vapi-network/core/secrets";
import {
  redactRunText,
  redactRunValue,
  registeredAgentProfileSchema,
  runResultPath,
  runsDirectory,
  STARTING_RECONCILIATION_TIMEOUT_MS,
  RuntimeError,
  type RunRecord,
  type Runtime,
  type RuntimeHandle,
  type RuntimeMember,
  type RuntimeRun,
  type RuntimeStatus,
} from "@vapi-network/mcp";

/**
 * The experimental `railway` runtime: one swarm member runs `vapi agent run
 * --bundle-env` inside a Railway sandbox booted from a checkpoint that has the
 * vAPI CLI preinstalled.
 *
 * Only that member's own private key and its own link credentials leave this
 * machine, inside a member bundle passed through `--env-file`. Never the
 * recovery phrase, never the treasury, never another account. vAPI never reads
 * or stores Railway tokens: the `railway` CLI uses whatever it is logged into
 * (or `RAILWAY_API_TOKEN`).
 */

/**
 * Every `railway` invocation this adapter makes, in one place so flags are
 * easy to correct. Measured against Railway CLI 5.30.1; `--json` on `create`
 * is assumed. `create` may return while the sandbox is still booting, so the
 * adapter runs `readyCommand` until it succeeds before the detached run.
 */
export const RAILWAY_CLI = {
  binary: "railway",
  create: (options: { checkpoint: string; envFile: string; idleTimeoutMinutes: number }) => [
    "sandbox",
    "create",
    "--checkpoint",
    options.checkpoint,
    "--env-file",
    options.envFile,
    "--idle-timeout-minutes",
    String(options.idleTimeoutMinutes),
    "--json",
  ],
  exec: (id: string, command: readonly string[], detach: boolean) => [
    "sandbox",
    "exec",
    id,
    ...(detach ? ["--detach"] : []),
    "--",
    ...command,
  ],
  destroy: (id: string) => ["sandbox", "destroy", id],
  readyCommand: ["true"],
  resultPath: "/tmp/vapi-result.json",
  bundleVariable: "VAPI_MEMBER_BUNDLE",
} as const;

/** The largest target a member running on Railway may hold: 1.00 USDC. */
export const REMOTE_MAX_TARGET_ATOMIC = 1_000_000n;
/** The largest effective ceiling a member running on Railway may hold: 2.00 USDC. */
export const REMOTE_MAX_CEILING_ATOMIC = 2_000_000n;
export const DEFAULT_RAILWAY_IDLE_TIMEOUT_MINUTES = 30;
/** How often the adapter asks a new sandbox whether it runs yet: 20 × 1.5 s, about 30 s. */
export const DEFAULT_RAILWAY_READY_ATTEMPTS = 20;
export const DEFAULT_RAILWAY_READY_INTERVAL_MS = 1_500;
/** How long a SIGINT/SIGTERM during `start` waits for the sandbox destroy before re-raising. */
export const DEFAULT_RAILWAY_SIGNAL_DESTROY_TIMEOUT_MS = 5_000;

/** A checkpoint name: 1-64 characters, a letter or digit first, so it never reads as an option. */
export const RAILWAY_CHECKPOINT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
export const RAILWAY_CHECKPOINT_RULE =
  "1-64 letters, digits, '.', '_' or '-', starting with a letter or digit";

const SANDBOX_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const MISSING_FILE_PATTERN = /no such file or directory/iu;
const HTTP_NOT_FOUND_PATTERN = /\b404\b/u;
/** Any other thing a Railway error can report missing; its not-found says nothing about the sandbox. */
const OTHER_SCOPE_PATTERN =
  /\b(?:project|environment|service|workspace|team|token|user|account|volume|deployment|command|file|directory|module|package)s?\b/iu;
const SIDECAR_SUFFIX = ".railway.json";
const MINIMUM_SECRET_LENGTH = 8;

export type RailwayExecResult = { code: number | null; stdout: string; stderr: string };

export type RailwayExec = (file: string, args: readonly string[]) => Promise<RailwayExecResult>;

/**
 * Runs one process with stdin closed and this process's environment, so the
 * `railway` CLI authenticates however it is set up here. It rejects only when
 * the binary cannot be started at all.
 */
export const defaultRailwayExec: RailwayExec = (file, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });

/** Reads the sandbox id from `railway sandbox create --json` output. Never echoes the output. */
export function parseSandboxId(stdout: string): string {
  const trimmed = stdout.trim();
  const candidates = [trimmed, ...trimmed.split(/\r?\n/u).reverse()];
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const id = sandboxIdOf(parsed);
    if (id !== undefined) return id;
  }
  throw new Error(
    "Could not read a sandbox id from the railway sandbox create output (expected JSON with id or sandboxId).",
  );
}

function sandboxIdOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["id", "sandboxId"]) {
    const id = record[key];
    if (typeof id === "string" && SANDBOX_ID_PATTERN.test(id)) return id;
  }
  return "sandbox" in record ? sandboxIdOf(record.sandbox) : undefined;
}

function sandboxScope(stdout: string, id: string): RuntimeHandle["railwayScope"] {
  const trimmed = stdout.trim();
  for (const candidate of [trimmed, ...trimmed.split(/\r?\n/u).reverse()]) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (sandboxIdOf(value) !== id || typeof value !== "object" || value === null) continue;
      const outer = value as Record<string, unknown>;
      const sandbox =
        typeof outer.sandbox === "object" &&
        outer.sandbox !== null &&
        sandboxIdOf(outer.sandbox) === id
          ? (outer.sandbox as Record<string, unknown>)
          : outer;
      const projectId =
        typeof sandbox.projectId === "string" && sandbox.projectId.length > 0
          ? sandbox.projectId
          : undefined;
      const environmentId =
        typeof sandbox.environmentId === "string" && sandbox.environmentId.length > 0
          ? sandbox.environmentId
          : undefined;
      if (projectId !== undefined || environmentId !== undefined)
        return {
          ...(projectId === undefined ? {} : { projectId }),
          ...(environmentId === undefined ? {} : { environmentId }),
        };
    } catch {
      // Scope is optional. Never replace missing creation metadata with today's link.
    }
  }
  return undefined;
}

export type RemoteKeyRefusalCode =
  | "not_in_swarm"
  | "swarm_treasury"
  | "not_a_member"
  | "lead_mode"
  | "target_too_high"
  | "ceiling_too_high"
  | "ceiling_disabled"
  | "remote_key_not_allowed"
  | "agent_marker"
  | "balance_too_high"
  | "balance_on_other_network"
  | "balance_unreadable"
  | "authorization_unresolved"
  | "no_daily_allowance"
  | "unsafe_config"
  | "unsupported_network"
  | "member_not_confirmed";

/** A member that may not run on a remote sandbox. The message says how to fix it. */
export class RemoteKeyRefusedError extends Error {
  readonly name = "RemoteKeyRefusedError";

  constructor(
    readonly code: RemoteKeyRefusalCode,
    message: string,
  ) {
    super(message);
  }
}

export type RemoteSafeMember = {
  swarm: SwarmFile;
  swarmMember: SwarmMember;
  /** The configured ceiling; never null for a remote-safe member. */
  ceilingAtomic: bigint;
  effectiveCeilingAtomic: bigint;
};

/**
 * Refuses, before any key is read, every member whose key may not leave this
 * machine: accounts outside a swarm, a swarm treasury, non-members, lead runs,
 * a target above 1.00 USDC, an effective ceiling above 2.00 USDC or disabled,
 * and any run without an explicit `allowRemoteKey`.
 */
export async function assertRemoteSafeMember(args: {
  home: string;
  member: RuntimeMember;
  mode: RuntimeRun["mode"];
  store: Pick<WalletStore, "ceilingCaps" | "ceilingSweepPending">;
  allowRemoteKey?: boolean;
  readSwarm?: (home: string, name: string) => Promise<SwarmFile>;
}): Promise<RemoteSafeMember> {
  const { member } = args;
  if (args.mode === "lead") {
    throw new RemoteKeyRefusedError(
      "lead_mode",
      "The railway runtime runs members only (--mode each). A lead needs the treasury key, which stays on this machine.",
    );
  }
  if (member.swarm === undefined) {
    throw new RemoteKeyRefusedError(
      "not_in_swarm",
      `${member.account} is not in a swarm. Only a swarm member can run on Railway; run it locally instead.`,
    );
  }
  const swarm = await (args.readSwarm ?? coreReadSwarm)(args.home, member.swarm);
  if (swarm.treasury.account === member.account) {
    throw new RemoteKeyRefusedError(
      "swarm_treasury",
      `${member.account} is the treasury of swarm ${swarm.name}. Its key never leaves this machine.`,
    );
  }
  const swarmMember = swarm.members.find((candidate) => candidate.account === member.account);
  if (swarmMember === undefined) {
    throw new RemoteKeyRefusedError(
      "not_a_member",
      `${member.account} is not a member of swarm ${swarm.name}. Only its members can run on Railway.`,
    );
  }
  const targetAtomic = BigInt(swarmMember.targetAtomic);
  if (targetAtomic > REMOTE_MAX_TARGET_ATOMIC) {
    throw new RemoteKeyRefusedError(
      "target_too_high",
      [
        `${member.account} has a target of ${formatUsdAmount(targetAtomic)} USDC; a member on Railway needs ${formatUsdAmount(REMOTE_MAX_TARGET_ATOMIC)} USDC or less.`,
        `Targets are set with --targets: vapi swarm create <name> --targets ${swarmMember.role}=1 (vapi swarm rebalance ${swarm.name} --targets ${swarmMember.role}=1 moves funds to that target once).`,
      ].join("\n"),
    );
  }
  const caps = args.store.ceilingCaps(member.account);
  const effective = caps.effectiveCeilingAtomic;
  if (caps.ceilingAtomic === null || effective === null) {
    throw new RemoteKeyRefusedError(
      "ceiling_disabled",
      [
        `${member.account} has ceiling sweeps off; a member on Railway needs a ceiling of ${formatUsdAmount(REMOTE_MAX_CEILING_ATOMIC)} USDC or less.`,
        `Set one with: vapi accounts caps ${member.account} --ceiling 2`,
      ].join("\n"),
    );
  }
  if (effective > REMOTE_MAX_CEILING_ATOMIC) {
    const perDayTooHigh = effective > caps.ceilingAtomic;
    throw new RemoteKeyRefusedError(
      "ceiling_too_high",
      [
        `${member.account} has an effective ceiling of ${formatUsdAmount(effective)} USDC (the larger of its ceiling and per-day cap); a member on Railway needs ${formatUsdAmount(REMOTE_MAX_CEILING_ATOMIC)} USDC or less.`,
        `Lower it with: vapi accounts caps ${member.account} --ceiling 2${perDayTooHigh ? " --per-day 2" : ""}`,
      ].join("\n"),
    );
  }
  if (args.allowRemoteKey !== true) {
    throw new RemoteKeyRefusedError(
      "remote_key_not_allowed",
      `Running ${member.account} on Railway sends its private key to the sandbox. A leaked member key can spend that member's balance. Pass --allow-remote-key to allow it.`,
    );
  }
  await assertNoUnresolvedAuthorizations({
    home: args.home,
    store: args.store,
    account: member.account as WalletName,
    swarm: swarm.name,
  });
  return {
    swarm,
    swarmMember,
    ceilingAtomic: caps.ceilingAtomic,
    effectiveCeilingAtomic: effective,
  };
}

export type RailwayRuntimeFs = {
  mkdtemp: (prefix: string) => Promise<string>;
  writeFile: (
    path: string,
    data: string,
    options: { encoding: "utf8"; mode: number; flag: "wx" },
  ) => Promise<void>;
  rm: (path: string, options: { recursive: true; force: true }) => Promise<void>;
  stat: (path: string) => Promise<{ mode: number }>;
};

export type RailwayRuntimeOptions = {
  home: string;
  store?: WalletStore | (() => Promise<WalletStore>);
  vaultKey?: () => Promise<{ path: string; key: Uint8Array }>;
  secrets?: SecretStore;
  checkpoint?: string;
  idleTimeoutMinutes?: number;
  allowRemoteKey?: boolean;
  /**
   * The member accounts the owner confirmed for this run. `start` refuses any
   * other member, and every member when the set is missing.
   */
  confirmedMembers?: readonly string[];
  keepSandbox?: boolean;
  exec?: RailwayExec;
  fs?: Partial<RailwayRuntimeFs>;
  /** Parent directory of the temporary env-file directory. Defaults to `os.tmpdir()`. */
  tmpdir?: string;
  readProfile?: (name: string) => Promise<AgentProfile>;
  readSwarm?: (home: string, name: string) => Promise<SwarmFile>;
  /** The owner's local config. Only network ids, USDC and discovery URLs reach a bundle. */
  config?: () => Promise<VapiConfig>;
  /**
   * Reads a member's live USDC balance before its key is exported. Defaults to
   * an RPC read on the swarm network through the owner's local config.
   */
  balanceReader?: SwarmBalanceReader;
  /** The fetch the default balance reader uses. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
  tty?: boolean;
  /**
   * An environment checked for `VAPI_NO_SECRETS` and the agent markers, which
   * refuse a key export exactly as they refuse `vapi export-key`. `process.env`
   * is always checked as well, so an injected clean environment cannot lift a
   * marker this process runs under.
   */
  env?: NodeJS.ProcessEnv;
  /** Readiness probes after `sandbox create`. Defaults to {@link DEFAULT_RAILWAY_READY_ATTEMPTS}. */
  readyAttempts?: number;
  readyIntervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  /**
   * How long a SIGINT/SIGTERM during `start` waits for `sandbox destroy`
   * before it re-raises. Defaults to {@link DEFAULT_RAILWAY_SIGNAL_DESTROY_TIMEOUT_MS}.
   */
  signalDestroyTimeoutMs?: number;
};

/**
 * What this machine knows about a run's sandbox, at `<home>/runs/<runId>.railway.json`
 * (0600). Written before `sandbox create`, so a sandbox holding a member key is
 * never untracked: `creating` (no id yet, or create failed unclearly), `running`,
 * `orphaned` (a destroy failed or was interrupted) or `kept` (finished with
 * keepSandbox). No key, bundle or credential is ever in it.
 */
export type RailwaySidecar = {
  v: 1;
  runId: string;
  account: string;
  swarm: string;
  state: "creating" | "running" | "orphaned" | "kept";
  sandboxId?: string;
  checkpoint: string;
  keepSandbox: boolean;
};

export function railwaySidecarPath(home: string, runId: string): string {
  if (!isRunId(runId)) throw new RuntimeError("invalid_run_id", `Invalid run id: ${runId}.`);
  return join(runsDirectory(home), `${runId}.railway.json`);
}

export function createRailwayRuntime(options: RailwayRuntimeOptions): Runtime {
  const { home } = options;
  const exec = options.exec ?? defaultRailwayExec;
  const fs: RailwayRuntimeFs = {
    mkdtemp: options.fs?.mkdtemp ?? ((prefix) => nodeMkdtemp(prefix)),
    writeFile: options.fs?.writeFile ?? ((path, data, flags) => nodeWriteFile(path, data, flags)),
    rm: options.fs?.rm ?? ((path, flags) => nodeRm(path, flags)),
    stat: options.fs?.stat ?? ((path) => nodeStat(path)),
  };
  const now = options.now ?? (() => new Date());
  const tty = options.tty ?? Boolean(process.stdin.isTTY);
  const idleTimeoutMinutes = options.idleTimeoutMinutes ?? DEFAULT_RAILWAY_IDLE_TIMEOUT_MINUTES;
  const readyAttempts = options.readyAttempts ?? DEFAULT_RAILWAY_READY_ATTEMPTS;
  const readyIntervalMs = options.readyIntervalMs ?? DEFAULT_RAILWAY_READY_INTERVAL_MS;
  const signalDestroyTimeoutMs =
    options.signalDestroyTimeoutMs ?? DEFAULT_RAILWAY_SIGNAL_DESTROY_TIMEOUT_MS;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds);
      }));
  let secrets: SecretStore | undefined = options.secrets;
  const getSecrets = (): SecretStore => (secrets ??= secretStore());
  const openStore = async (): Promise<WalletStore> => {
    if (options.store === undefined) return await WalletStore.open(home, { secrets: getSecrets() });
    if (typeof options.store === "function") return await options.store();
    await options.store.reload();
    return options.store;
  };
  const readProfile =
    options.readProfile ??
    ((name: string) => readAgentProfile(home, name, { schema: registeredAgentProfileSchema }));
  const readConfig = options.config ?? (() => loadConfig(getVapiPaths(home).config));
  const vaultKey =
    options.vaultKey ?? (async () => await deviceVaultKey(home, getSecrets(), options.now));

  const waitUntilReady = async (id: string, secretValues: readonly string[]): Promise<void> => {
    let last: RailwayExecResult | undefined;
    for (let attempt = 1; attempt <= readyAttempts; attempt += 1) {
      last = await exec(RAILWAY_CLI.binary, RAILWAY_CLI.exec(id, RAILWAY_CLI.readyCommand, false));
      if (last.code === 0) return;
      if (attempt < readyAttempts) await sleep(readyIntervalMs);
    }
    throw new Error(
      `railway sandbox ${id} did not become ready${last === undefined ? "." : describeFailure(last, secretValues)}`,
    );
  };

  return {
    kind: "railway",
    async busy(member: RuntimeMember) {
      const unresolved = (await listRailwaySidecars(home)).find(
        (sidecar) =>
          sidecar.account === member.account &&
          (sidecar.state === "creating" || sidecar.state === "orphaned"),
      );
      return unresolved === undefined
        ? undefined
        : {
            runId: unresolved.runId,
            detail: `Railway sidecar is ${unresolved.state}. Run vapi swarm stop ${unresolved.swarm} ${unresolved.runId}.`,
          };
    },
    async recover(record: RunRecord): Promise<RuntimeHandle | undefined> {
      const sidecar = await readSidecar(home, record.runId);
      if (
        sidecar?.sandboxId === undefined ||
        (sidecar.account !== "" && sidecar.account !== record.member.account) ||
        (sidecar.swarm !== "" && sidecar.swarm !== record.member.swarm)
      ) {
        return undefined;
      }
      return {
        runId: record.runId,
        kind: "railway",
        member: record.member,
        startedAt: record.startedAt,
        ref: sidecar.sandboxId,
      };
    },
    async retireUnreconciledStart(record: RunRecord): Promise<void> {
      if (now().getTime() - Date.parse(record.startedAt) < STARTING_RECONCILIATION_TIMEOUT_MS) {
        throw new RuntimeError(
          "runtime_unavailable",
          `Railway run ${record.runId} is still within its launch reconciliation window.`,
        );
      }
      const sidecar = await readSidecar(home, record.runId);
      if (sidecar === undefined) return;
      if (
        sidecar.account !== record.member.account ||
        sidecar.swarm !== (record.member.swarm ?? "") ||
        sidecar.state !== "creating" ||
        sidecar.sandboxId !== undefined
      ) {
        throw new RuntimeError(
          "runtime_unavailable",
          `Railway sidecar ${record.runId} does not match the confirmed stale start; inspect it with vapi swarm runs ${record.member.swarm ?? sidecar.swarm}.`,
        );
      }
      await nodeRm(railwaySidecarPath(home, record.runId), { force: true });
    },
    async start(member: RuntimeMember, run: RuntimeRun, persistLaunch): Promise<RuntimeHandle> {
      const checkpoint = options.checkpoint?.trim();
      if (checkpoint === undefined || checkpoint === "") {
        throw new RuntimeError(
          "runtime_unavailable",
          "The railway runtime needs a sandbox checkpoint: pass --checkpoint <name> or set VAPI_RAILWAY_CHECKPOINT.",
        );
      }
      if (!RAILWAY_CHECKPOINT_PATTERN.test(checkpoint)) {
        throw new RuntimeError(
          "runtime_unavailable",
          `The railway checkpoint name must be ${RAILWAY_CHECKPOINT_RULE}.`,
        );
      }
      if (run.task.startsWith("--")) {
        throw new Error('A detached run task must not start with "--".');
      }
      if (!Number.isSafeInteger(idleTimeoutMinutes) || idleTimeoutMinutes < 1) {
        throw new Error("The railway idle timeout must be a positive number of minutes.");
      }
      const startedAt = now().toISOString();
      // The same kill switch as `vapi export-key`: with VAPI_NO_SECRETS or an
      // agent/CI marker set, no key leaves this machine, flag or not. Both the
      // injected environment and this process's own are checked.
      const marker = activeAgentMarker(options.env ?? {}) ?? activeAgentMarker(process.env);
      if (marker !== undefined) {
        await appendAudit(
          home,
          {
            event: "agent.remote_key_refused",
            wallet: member.account,
            tty,
            agentMarker: marker,
            detail: `refused: ${marker} is set.`,
          },
          { now },
        );
        throw agentMarkerRefusal(marker);
      }
      const store = await openStore();
      const policy = await assertRemoteSafeMember({
        home,
        member,
        mode: run.mode,
        store,
        ...(options.allowRemoteKey === undefined ? {} : { allowRemoteKey: options.allowRemoteKey }),
        ...(options.readSwarm === undefined ? {} : { readSwarm: options.readSwarm }),
      }).catch(async (error: unknown) => {
        // Every key refusal is audited, whoever called the adapter.
        if (error instanceof RemoteKeyRefusedError) {
          await appendAudit(
            home,
            {
              event: "agent.remote_key_refused",
              wallet: member.account,
              detail: `refused: ${error.code}`,
              tty,
            },
            { now },
          );
        }
        throw error;
      });
      // Only the members the owner saw and confirmed; one added to the swarm
      // since, or a start without a confirmed set, sends no key.
      if (options.confirmedMembers?.includes(member.account) !== true) {
        await appendAudit(
          home,
          {
            event: "agent.remote_key_refused",
            wallet: member.account,
            detail: "refused: member_not_confirmed",
            tty,
          },
          { now },
        );
        throw new RemoteKeyRefusedError(
          "member_not_confirmed",
          options.confirmedMembers === undefined
            ? `No members were confirmed for this railway run, so ${member.account}'s key stays on this machine. Start it with vapi swarm run --runtime railway.`
            : `${member.account} was not among the members confirmed for this railway run, so its key stays on this machine. Run vapi swarm run again to confirm it.`,
        );
      }
      const account = policy.swarmMember.account as WalletName;
      const entry = store.entry(account);
      if (entry?.link === undefined) {
        throw new Error(`${account} is not linked to vAPI. Link it with vapi login first.`);
      }
      const profile = await readProfile(member.profile);
      const address = await store.readAddress(account);
      if (address === undefined) throw new Error(`${account} has no address in the vault.`);

      // A refusal from here on is audited: the member is known, no key is read yet.
      const refuse = async (
        code: RemoteKeyRefusalCode,
        message: string,
      ): Promise<RemoteKeyRefusedError> => {
        await appendAudit(
          home,
          { event: "agent.remote_key_refused", wallet: account, detail: `refused: ${code}`, tty },
          { now },
        );
        return new RemoteKeyRefusedError(code, message);
      };

      // The owner's config stays here; the bundle gets the swarm network's id
      // and USDC only. This limits client configuration, not key authority.
      const network = policy.swarm.network;
      const ownerConfig = await readConfig();
      let config: MemberBundleConfig;
      try {
        config = memberBundleConfig(ownerConfig, network);
      } catch (error) {
        if (
          error instanceof MemberBundleError &&
          (error.code === "unsafe_config" || error.code === "unsupported_network")
        ) {
          throw await refuse(error.code, error.message);
        }
        throw error;
      }

      // An EVM private key controls the same address on every EVM chain. Check
      // every USDC network this client knows before that unrestricted key leaves.
      try {
        await assertRemoteBalance({
          account,
          address,
          network,
          swarm: policy.swarm.name,
          readBalance: options.balanceReader ?? ownerBalanceReader(ownerConfig, options.fetchImpl),
        });
      } catch (error) {
        if (error instanceof RemoteKeyRefusedError) throw await refuse(error.code, error.message);
        throw error;
      }

      const allowance = await reserveRemoteAllowance({
        home,
        account,
        caps: entry.spendCaps,
        run,
        now: now(),
      }).catch(async (error: unknown) => {
        if (error instanceof RemoteKeyRefusedError) throw await refuse(error.code, error.message);
        throw error;
      });
      const reservedAtomic = allowance.atomic;
      const remoteBudgetUsd = formatUsdAmount(reservedAtomic);
      const credentials = await readMemberCredentials({ secrets: getSecrets(), account });

      // The only place a key is read: after every refusal above.
      const { path: vaultPath, key } = await vaultKey();
      let privateKey: `0x${string}`;
      try {
        privateKey = await exportMemberKey({ path: vaultPath, key, name: account });
      } finally {
        key.fill(0);
      }
      const bundle = createMemberBundle({
        account,
        address: address as `0x${string}`,
        privateKey,
        swarm: policy.swarm.name,
        profile,
        link: entry.link,
        credentials,
        caps: {
          perCallAtomic: minAtomic(entry.spendCaps.perCallAtomic, reservedAtomic).toString(),
          perDayAtomic: reservedAtomic.toString(),
        },
        allowanceExpiresAt: allowance.expiresAt,
        ceilingAtomic: policy.ceilingAtomic.toString(),
        config,
        runId: run.runId,
        ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }),
      });
      const secretValues = collectSecrets([bundle, privateKey, privateKey.slice(2)], credentials);

      // One `agent.remote_key_exported` line per export: once `sandbox create`
      // ran, whether this path or the signal handler gets to write it.
      let exportAudited = false;
      const audit = async (detail: string): Promise<void> => {
        if (exportAudited) return;
        exportAudited = true;
        await appendAudit(
          home,
          { event: "agent.remote_key_exported", wallet: account, detail, tty },
          { now },
        );
      };

      // A sandbox holding this key is never untracked: the sidecar exists from
      // before `sandbox create` until the sandbox is destroyed. Writes on this
      // path are synchronous, so a signal handler never interleaves with one;
      // once a signal arrived, the handler alone owns the sidecar.
      const sidecarPath = railwaySidecarPath(home, run.runId);
      let sidecar: RailwaySidecar = {
        v: 1,
        runId: run.runId,
        account,
        swarm: policy.swarm.name,
        state: "creating",
        checkpoint,
        keepSandbox: options.keepSandbox === true,
      };
      let directory: string | undefined;
      let sandboxId: string | undefined;
      // Set just before `sandbox create` runs: from then on the key may have left.
      let attempted = false;
      let interrupted: NodeJS.Signals | undefined;
      const saveSidecar = (next: RailwaySidecar): void => {
        if (interrupted !== undefined) return;
        sidecar = next;
        writeSidecarSync(sidecarPath, next);
      };
      const dropSidecar = (): void => {
        if (interrupted === undefined) rmSync(sidecarPath, { force: true });
      };
      const assertNotInterrupted = (): void => {
        if (interrupted !== undefined) {
          throw new Error(`Starting ${account} on Railway was interrupted by ${interrupted}.`);
        }
      };

      // SIGINT/SIGTERM while the key is on disk or in a sandbox being set up:
      // delete the env file, record the sandbox, try a bounded destroy, re-raise.
      const cleanUpAfterSignal = async (signal: NodeJS.Signals): Promise<void> => {
        const id = sandboxId;
        try {
          if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
        } catch {
          // Nothing more can be done in a signal handler; the stderr line below still goes out.
        }
        try {
          writeSidecarSync(
            sidecarPath,
            id === undefined
              ? { ...sidecar, state: "creating" }
              : { ...sidecar, state: "orphaned", sandboxId: id },
          );
        } catch {
          // The stderr line below still tells the owner what to destroy.
        }
        process.stderr.write(
          id === undefined
            ? `Interrupted while starting ${account} on Railway. A sandbox holding its private key may exist: find it with railway sandbox list and run railway sandbox destroy <id>.\n`
            : `Interrupted while starting ${account} on Railway. Sandbox ${id} holds its private key; destroying it. If it is still listed, run: railway sandbox destroy ${id}\n`,
        );
        if (attempted) {
          try {
            await audit(`runtime=railway sandbox=${id ?? "unknown interrupted"}`);
          } catch {
            // The sidecar and the stderr line above still record it.
          }
        }
        if (id !== undefined) {
          try {
            await withTimeout(destroySandbox(exec, id), signalDestroyTimeoutMs);
            rmSync(sidecarPath, { force: true });
          } catch {
            // The sidecar stays "orphaned" for `vapi swarm stop` to retry.
          }
        }
        removeSignalHandlers();
        process.kill(process.pid, signal);
      };
      const onSignal = (signal: NodeJS.Signals): void => {
        if (interrupted !== undefined) return;
        interrupted = signal;
        void cleanUpAfterSignal(signal);
      };
      const removeSignalHandlers = (): void => {
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
      };

      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      try {
        saveSidecar(sidecar);

        // The bundle reaches the sandbox only through a 0600 env file in a fresh
        // 0700 directory, removed as soon as `sandbox create` returns or throws.
        let envFile: string | undefined;
        let created: RailwayExecResult | undefined;
        let createError: unknown;
        let cleanupError: unknown;
        try {
          directory = await fs.mkdtemp(join(options.tmpdir ?? osTmpdir(), "vapi-railway-"));
          assertNotInterrupted();
          await assertMode(fs, directory, 0o700, "env-file directory");
          envFile = join(directory, "member.env");
          await fs.writeFile(envFile, `${RAILWAY_CLI.bundleVariable}=${bundle}\n`, {
            encoding: "utf8",
            mode: 0o600,
            flag: "wx",
          });
          await assertMode(fs, envFile, 0o600, "env file");
          assertNotInterrupted();
          attempted = true;
          created = await exec(
            RAILWAY_CLI.binary,
            RAILWAY_CLI.create({ checkpoint, envFile, idleTimeoutMinutes }),
          );
          // Record the id before anything else is awaited, so a signal from
          // here on destroys this sandbox rather than pointing at a list.
          if (created.code === 0) {
            try {
              sandboxId = parseSandboxId(created.stdout);
              saveSidecar({ ...sidecar, sandboxId });
            } catch {
              // An unreadable id is reported below; the sidecar is written again there.
            }
          }
        } catch (error) {
          createError = error;
        } finally {
          if (directory !== undefined) {
            try {
              await fs.rm(directory, { recursive: true, force: true });
            } catch (error) {
              cleanupError = error;
            }
          }
        }
        assertNotInterrupted();

        // Reported on every branch below: the path only, never the content.
        const leftover =
          cleanupError === undefined || directory === undefined
            ? []
            : [
                `Could not delete the temporary env file ${envFile ?? directory}, which may hold ${account}'s private key. Delete it yourself: rm -rf ${directory}`,
              ];
        const withLeftover = (lines: readonly string[]): string =>
          [...lines, ...leftover].join("\n");

        if (createError !== undefined || created === undefined || created.code !== 0) {
          if (!attempted) {
            // Nothing reached railway, so nothing can exist remotely and nothing was exported.
            dropSidecar();
            throw new Error(
              withLeftover([
                `railway sandbox create failed: ${scrub(errorMessage(createError), secretValues)}`,
              ]),
            );
          }
          if (createError !== undefined && hasCode(createError, "ENOENT")) {
            // The binary never started: no sandbox was created and nothing was exported.
            dropSidecar();
            throw new RuntimeError(
              "runtime_unavailable",
              withLeftover([
                "The railway CLI is not installed or not on PATH. Install it and log in with railway login.",
              ]),
            );
          }
          await audit("runtime=railway sandbox=none create_failed");
          // The sidecar stays "creating": create may have gone through before it failed.
          throw new Error(
            withLeftover([
              createError !== undefined || created === undefined
                ? `railway sandbox create failed: ${scrub(errorMessage(createError), secretValues)}`
                : `railway sandbox create failed${describeFailure(created, secretValues)}`,
              `A sandbox holding ${account}'s private key may still exist. Check with railway sandbox list and destroy it with railway sandbox destroy <id>.`,
            ]),
          );
        }

        let id: string;
        try {
          id = sandboxId ?? parseSandboxId(created.stdout);
        } catch (error) {
          await audit("runtime=railway sandbox=unknown create_unparsed");
          // Without an id nothing here can destroy it, so the owner must.
          throw new Error(
            withLeftover([
              errorMessage(error),
              `A sandbox holding ${account}'s private key may be running. Find it with railway sandbox list and destroy it with railway sandbox destroy <id>.`,
              `Until then that key can spend ${account}'s balance; it stops at the idle timeout (${idleTimeoutMinutes} minutes).`,
            ]),
          );
        }

        sandboxId = id;
        const railwayScope = sandboxScope(created.stdout, id);
        try {
          saveSidecar({ ...sidecar, sandboxId: id });
          const handle: RuntimeHandle = {
            runId: run.runId,
            kind: "railway",
            member,
            startedAt,
            ref: id,
            ...(railwayScope === undefined ? {} : { railwayScope }),
          };
          await persistLaunch?.(handle);
          await audit(`runtime=railway sandbox=${id}`);
          if (leftover.length > 0) throw new Error(leftover.join("\n"));
          await waitUntilReady(id, secretValues);
          assertNotInterrupted();
          // The task travels base64url-encoded: one argument of [A-Za-z0-9_-]
          // reads the same whether `exec` passes argv or a shell string.
          const command = [
            "vapi",
            "agent",
            "run",
            "--bundle-env",
            RAILWAY_CLI.bundleVariable,
            "--task-base64url",
            Buffer.from(run.task, "utf8").toString("base64url"),
            "--json",
            "--result-file",
            RAILWAY_CLI.resultPath,
            "--budget",
            remoteBudgetUsd,
          ];
          const started = await exec(RAILWAY_CLI.binary, RAILWAY_CLI.exec(id, command, true));
          if (started.code !== 0) {
            throw new Error(
              `railway sandbox exec ${id} failed${describeFailure(started, secretValues)}`,
            );
          }
          assertNotInterrupted();
          saveSidecar({ ...sidecar, state: "running" });
        } catch (error) {
          const cause = scrub(errorMessage(error), secretValues);
          // After a signal the handler destroys the sandbox and owns the sidecar.
          if (interrupted !== undefined) throw new Error(cause);
          try {
            await destroySandbox(exec, id);
          } catch (destroyError) {
            try {
              saveSidecar({ ...sidecar, state: "orphaned", sandboxId: id });
            } catch {
              // The error below still names the sandbox and the command.
            }
            throw new Error(
              [
                cause,
                `Could not destroy sandbox ${id}, which holds ${account}'s private key: ${scrub(errorMessage(destroyError), secretValues)}`,
                `Destroy it yourself with: railway sandbox destroy ${id}`,
              ].join("\n"),
            );
          }
          try {
            dropSidecar();
          } catch {
            // The sandbox is gone; a stale sidecar only costs a retry later.
          }
          throw new Error(cause);
        }

        return {
          runId: run.runId,
          kind: "railway",
          member,
          startedAt,
          ref: id,
          ...(railwayScope === undefined ? {} : { railwayScope }),
        };
      } finally {
        removeSignalHandlers();
      }
    },

    async status(handle: RuntimeHandle): Promise<RuntimeStatus> {
      const id = sandboxRef(handle);
      if (id === undefined) return { state: "unknown", detail: "invalid railway runtime handle" };
      let outcome: RailwayExecResult;
      try {
        outcome = await exec(
          RAILWAY_CLI.binary,
          RAILWAY_CLI.exec(id, ["cat", RAILWAY_CLI.resultPath], false),
        );
      } catch (error) {
        return {
          state: "running",
          detail: `railway sandbox exec ${id} failed: ${scrub(errorMessage(error), [])}`,
        };
      }
      if (outcome.code !== 0) {
        if (MISSING_FILE_PATTERN.test(outcome.stderr)) return { state: "running" };
        if (sandboxGone(outcome.stderr, id)) {
          await removeSidecar(home, handle.runId);
          return { state: "unknown", detail: "sandbox gone" };
        }
        // Not clearly gone: keep the run tracked and say why.
        return {
          state: "running",
          detail: `railway sandbox exec ${id} failed${describeFailure(outcome, [])}`,
        };
      }

      const status = await copyResult(home, handle.runId, outcome.stdout);
      const sidecar = await readSidecar(home, handle.runId);
      const keepSandbox = sidecar?.keepSandbox ?? options.keepSandbox === true;
      if (keepSandbox) {
        if (sidecar !== undefined && sidecar.state !== "kept") {
          await writeSidecar(home, handle.runId, {
            ...sidecar,
            account: sidecar.account || handle.member.account,
            swarm: sidecar.swarm || (handle.member.swarm ?? ""),
            state: "kept",
          });
        }
        return status;
      }
      // A finished member's key must not sit in an idle VM. Until the destroy
      // succeeds the run stays running, so the next refresh retries it.
      try {
        await destroySandbox(exec, id);
      } catch (error) {
        return {
          state: "running",
          detail: `${status.state}; sandbox destroy failed: ${scrub(errorMessage(error), [])}`,
        };
      }
      await removeSidecar(home, handle.runId);
      return status;
    },

    async stop(handle: RuntimeHandle, stopOptions): Promise<void> {
      const id = sandboxRef(handle);
      if (id === undefined) throw new Error("Invalid railway runtime sandbox id.");
      if (stopOptions?.requireSuccessfulExit === true) {
        // An unknown worker cannot be cleared by text or the current CLI scope.
        // Only the destroy process's successful exit confirms this stop.
        const outcome = await exec(RAILWAY_CLI.binary, RAILWAY_CLI.destroy(id));
        if (outcome.code !== 0)
          throw new Error(`railway sandbox destroy ${id} failed${describeFailure(outcome, [])}`);
      } else {
        await destroySandbox(exec, id);
      }
      await removeSidecar(home, handle.runId);
    },
  };
}

/**
 * Every sidecar in `<home>/runs/`, including the 0.6 pre-release shape (read
 * as `running`). Unreadable or invalid files are skipped.
 */
export async function listRailwaySidecars(home: string): Promise<RailwaySidecar[]> {
  let names: string[];
  try {
    names = await readdir(runsDirectory(home));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
  const sidecars: RailwaySidecar[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(SIDECAR_SUFFIX)) continue;
    const runId = name.slice(0, -SIDECAR_SUFFIX.length);
    if (!isRunId(runId)) continue;
    const sidecar = await readSidecar(home, runId);
    if (sidecar !== undefined) sidecars.push(sidecar);
  }
  return sidecars;
}

/**
 * Destroys the sandbox a sidecar names and deletes the sidecar. Without a
 * sandbox id, or when the destroy fails, the sidecar stays (`orphaned` after a
 * failed destroy) and `error` tells the owner the exact `railway` command.
 */
export async function destroyRailwaySidecar(
  home: string,
  runId: string,
  options: { exec?: RailwayExec } = {},
): Promise<{ runId: string; sandboxId?: string; destroyed: boolean; error?: string }> {
  const sidecar = await readSidecar(home, runId);
  if (sidecar === undefined) {
    return { runId, destroyed: false, error: `No readable railway sidecar for run ${runId}.` };
  }
  const id = sidecar.sandboxId;
  if (id === undefined) {
    const holder = sidecar.account === "" ? "a member" : sidecar.account;
    return {
      runId,
      destroyed: false,
      error: `Run ${runId} has no sandbox id, and a sandbox holding ${holder}'s private key may exist. Find it with railway sandbox list and run railway sandbox destroy <id>.`,
    };
  }
  try {
    await destroySandbox(options.exec ?? defaultRailwayExec, id);
  } catch (error) {
    await writeSidecar(home, runId, { ...sidecar, state: "orphaned" }).catch(() => undefined);
    return {
      runId,
      sandboxId: id,
      destroyed: false,
      error: `${scrub(errorMessage(error), [])}\nDestroy it yourself with: railway sandbox destroy ${id}`,
    };
  }
  await removeSidecar(home, runId);
  return { runId, sandboxId: id, destroyed: true };
}

/** Destroys a sandbox; a clear sandbox-scoped not-found counts as destroyed. */
async function destroySandbox(exec: RailwayExec, id: string): Promise<void> {
  const outcome = await exec(RAILWAY_CLI.binary, RAILWAY_CLI.destroy(id));
  if (outcome.code === 0 || sandboxGone(outcome.stderr, id)) return;
  throw new Error(`railway sandbox destroy ${id} failed${describeFailure(outcome, [])}`);
}

/**
 * Only a clear not-found for this sandbox: "sandbox not found" or "sandbox
 * <this id> (was) not found" on one line, or a 404 line naming this id and no
 * other scope. "sandbox <id>: project not found", another sandbox's id, or a
 * missing command, token or environment is an error, never "gone".
 */
function sandboxGone(stderr: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const notFound = new RegExp(
    `\\bsandbox(?:\\s+["'\`]?${escaped}["'\`]?)?\\s+(?:was\\s+|is\\s+)?not\\s+found\\b`,
    "iu",
  );
  const namesId = new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, "u");
  return stderr
    .split(/\r?\n/u)
    .some(
      (line) =>
        notFound.test(line) ||
        (HTTP_NOT_FOUND_PATTERN.test(line) &&
          namesId.test(line) &&
          !OTHER_SCOPE_PATTERN.test(line.replaceAll(id, ""))),
    );
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function assertNoUnresolvedAuthorizations(args: {
  home: string;
  store: Pick<WalletStore, "ceilingSweepPending">;
  account: WalletName;
  swarm: string;
}): Promise<void> {
  if (args.store.ceilingSweepPending(args.account) !== undefined) {
    throw new RemoteKeyRefusedError(
      "authorization_unresolved",
      `${args.account} has an unresolved ceiling sweep. Run vapi sweep --account ${args.account} to resolve its existing authorization before starting Railway.`,
    );
  }
  const [movement] = await listUnfinishedMovements({ home: args.home, from: args.account });
  if (movement !== undefined) {
    throw new RemoteKeyRefusedError(
      "authorization_unresolved",
      `${args.account} has unfinished movement ${movement.id}. Run vapi swarm status ${args.swarm}, then resume that movement before starting Railway.`,
    );
  }
  const latestByAuthorization = new Map<string, Awaited<ReturnType<typeof readReceipts>>[number]>();
  for (const receipt of await readReceipts(getVapiPaths(args.home).receipts, {
    wallet: args.account,
  })) {
    const transfer = receipt.transfer;
    if (transfer === undefined) continue;
    latestByAuthorization.set(`${transfer.network}\u0000${transfer.nonce.toLowerCase()}`, receipt);
  }
  const unknown = [...latestByAuthorization.values()].find(
    (receipt) => receipt.transfer?.status === "unknown",
  );
  if (unknown?.transfer !== undefined) {
    throw new RemoteKeyRefusedError(
      "authorization_unresolved",
      `${args.account} has an unknown transfer authorization. Re-run its original vapi send command with --resume ${unknown.transfer.nonce} before starting Railway.`,
    );
  }
}

async function reserveRemoteAllowance(args: {
  home: string;
  account: WalletName;
  caps: { perCallAtomic: string; perDayAtomic: string };
  run: RuntimeRun;
  now: Date;
}): Promise<{ atomic: bigint; expiresAt: string }> {
  const perDayAtomic = BigInt(args.caps.perDayAtomic);
  const ledgerPath = getVapiPaths(args.home).ledger;
  const spent = BigInt((await readSpendLedger(ledgerPath, args.now, args.account)).spentAtomic);
  const remaining = spent >= perDayAtomic ? 0n : perDayAtomic - spent;
  const requested = args.run.budgetUsd === undefined ? remaining : usdToAtomic(args.run.budgetUsd);
  const reserved = requested < remaining ? requested : remaining;
  if (reserved === 0n) {
    throw new RemoteKeyRefusedError(
      "no_daily_allowance",
      `${args.account} has no remaining daily allowance. Wait for the UTC daily reset or raise its per-day cap before starting Railway.`,
    );
  }
  try {
    const reservation = await reserveSpend(
      reserved,
      { perCallAtomic: reserved.toString(), perDayAtomic: args.caps.perDayAtomic },
      {
        ledgerPath,
        now: args.now,
        wallet: args.account,
        reservationId: `railway:${args.run.runId}`,
      },
    );
    return { atomic: reserved, expiresAt: nextUtcMidnight(reservation.date) };
  } catch (error) {
    if (
      (error instanceof SpendCapExceededError && error.cap === "per_day") ||
      (error instanceof Error && "code" in error && error.code === "per_day_cap_exceeded")
    ) {
      throw new RemoteKeyRefusedError(
        "no_daily_allowance",
        `${args.account}'s remaining daily allowance changed while Railway was starting. Run the command again.`,
      );
    }
    throw error;
  }
}

function nextUtcMidnight(date: string): string {
  const midnight = new Date(`${date}T00:00:00.000Z`);
  midnight.setUTCDate(midnight.getUTCDate() + 1);
  return midnight.toISOString();
}

function minAtomic(value: string, maximum: bigint): bigint {
  const parsed = BigInt(value);
  return parsed < maximum ? parsed : maximum;
}

/**
 * Refuses a member whose live USDC balance on the swarm network is above the
 * remote ceiling, whose address has USDC on another known EVM network, or
 * whose balance cannot be read. Reader errors are never echoed because they
 * can name credential-bearing RPC URLs.
 */
const TESTNET_USDC_NETWORKS: ReadonlySet<string> = new Set([ARC_TESTNET_CAIP2]);

export async function assertRemoteBalance(
  args: Parameters<SwarmBalanceReader>[0] & { swarm: string; readBalance: SwarmBalanceReader },
): Promise<void> {
  const { account, address } = args;
  const networks = Object.keys(CANONICAL_X402_USDC_NETWORKS) as Array<
    keyof typeof CANONICAL_X402_USDC_NETWORKS
  >;
  for (const network of networks) {
    let balanceAtomic: bigint;
    try {
      balanceAtomic = await args.readBalance({ account, address, network });
    } catch {
      // Testnet USDC has no value and Arc testnet has no public RPC, so an
      // unreadable testnet only blocks when it is the swarm's own network.
      if (network !== args.network && TESTNET_USDC_NETWORKS.has(network)) continue;
      throw new RemoteKeyRefusedError(
        "balance_unreadable",
        `Could not read the live USDC balance of ${account} on ${networkName(network)}, so its key stays on this machine. Configure and check that network's RPC, then try again.`,
      );
    }
    if (network !== args.network && balanceAtomic > 0n) {
      throw new RemoteKeyRefusedError(
        "balance_on_other_network",
        `${account} holds ${formatUsdAmount(balanceAtomic)} USDC on ${networkName(network)} outside swarm ${args.swarm}. Move that balance to a dedicated account before starting Railway.`,
      );
    }
    if (network === args.network && balanceAtomic > REMOTE_MAX_CEILING_ATOMIC) {
      throw new RemoteKeyRefusedError(
        "balance_too_high",
        [
          `${account} holds ${formatUsdAmount(balanceAtomic)} USDC on ${networkName(network)}; a member on Railway may hold ${formatUsdAmount(REMOTE_MAX_CEILING_ATOMIC)} USDC or less when its key leaves this machine.`,
          `Move the excess back with: vapi swarm rebalance ${args.swarm}`,
          `Or sweep it with: vapi sweep --account ${account}`,
        ].join("\n"),
      );
    }
  }
}

/** The default balance reader: an RPC read through the owner's local network config. */
export function ownerBalanceReader(
  config: VapiConfig,
  fetchImpl: typeof fetch | undefined,
): SwarmBalanceReader {
  return async ({ address, network }) => {
    const definition = getNetworkDefinition(network);
    const rpcConfig =
      configuredNetworkFor(config.networks, network) ??
      (definition.publicRpcUrl === undefined
        ? undefined
        : { rpcUrl: definition.publicRpcUrl, usdc: definition.usdc });
    if (rpcConfig === undefined) throw new Error(`Network ${network} has no readable RPC.`);
    const canonical =
      CANONICAL_X402_USDC_NETWORKS[network as keyof typeof CANONICAL_X402_USDC_NETWORKS];
    if (canonical === undefined) throw new Error(`Network ${network} has no canonical USDC token.`);
    return await readUsdcBalance({
      address,
      network,
      configured: { ...rpcConfig, usdc: canonical.usdc },
      ...(config.allowPrivateNetwork === undefined
        ? {}
        : { allowPrivateNetwork: config.allowPrivateNetwork }),
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });
  };
}

function networkName(network: string): string {
  try {
    return getNetworkDefinition(network).name;
  } catch {
    return network;
  }
}

/** Why a key export was refused in an agent or locked-down environment. */
export function agentMarkerRefusal(marker: string): RemoteKeyRefusedError {
  return new RemoteKeyRefusedError(
    "agent_marker",
    `${marker} is set, so no private key leaves this machine. Run the railway runtime yourself in a terminal without ${marker}.`,
  );
}

async function copyResult(home: string, runId: string, text: string): Promise<RuntimeStatus> {
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return { state: "failed", detail: "unreadable result file" };
  }
  if (!isResultEnvelope(envelope)) return { state: "failed", detail: "unreadable result file" };
  const redacted = redactRunValue(envelope);
  await writeJsonAtomic(runResultPath(home, runId), redacted, { mode: 0o600 });
  return {
    state: redacted.exitCode === 0 ? "finished" : "failed",
    exitCode: redacted.exitCode,
    ...("result" in redacted ? { result: redacted.result } : {}),
    ...(redacted.error === undefined ? {} : { detail: redacted.error.message }),
  };
}

type ResultEnvelope = {
  v: 1;
  exitCode: number;
  result?: unknown;
  error?: { message: string; code?: string };
};

function isResultEnvelope(value: unknown): value is ResultEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const envelope = value as Partial<ResultEnvelope>;
  if (
    envelope.v !== 1 ||
    !Number.isSafeInteger(envelope.exitCode) ||
    (envelope.exitCode as number) < 0
  ) {
    return false;
  }
  const hasResult = Object.hasOwn(envelope, "result");
  const hasError =
    typeof envelope.error === "object" &&
    envelope.error !== null &&
    typeof envelope.error.message === "string" &&
    (envelope.error.code === undefined || typeof envelope.error.code === "string");
  if (envelope.exitCode === 0) return hasResult && envelope.error === undefined;
  return hasResult || hasError;
}

async function writeSidecar(home: string, runId: string, sidecar: RailwaySidecar): Promise<void> {
  await writeJsonAtomic(railwaySidecarPath(home, runId), sidecar, { mode: 0o600 });
}

/** The signal-safe twin of {@link writeSidecar}: a 0600 temp file in the same directory, then rename. */
function writeSidecarSync(path: string, sidecar: RailwaySidecar): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeSync(descriptor, `${JSON.stringify(sidecar, null, 2)}\n`, null, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

async function removeSidecar(home: string, runId: string): Promise<void> {
  try {
    await nodeRm(railwaySidecarPath(home, runId), { force: true });
  } catch {
    // Best effort: a stale sidecar only costs a retry later.
  }
}

const SIDECAR_STATES: ReadonlySet<unknown> = new Set(["creating", "running", "orphaned", "kept"]);
const SIDECAR_KEYS: ReadonlySet<string> = new Set([
  "v",
  "runId",
  "account",
  "swarm",
  "state",
  "sandboxId",
  "checkpoint",
  "keepSandbox",
]);
const LEGACY_SIDECAR_KEYS = ["checkpoint", "keepSandbox", "sandboxId", "v"];

async function readSidecar(home: string, runId: string): Promise<RailwaySidecar | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(railwaySidecarPath(home, runId), "utf8"));
  } catch {
    return undefined;
  }
  return parseSidecar(parsed, runId);
}

function parseSidecar(value: unknown, runId: string): RailwaySidecar | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const { v, checkpoint, keepSandbox, sandboxId } = record;
  if (v !== 1 || typeof checkpoint !== "string" || typeof keepSandbox !== "boolean") {
    return undefined;
  }
  if (
    sandboxId !== undefined &&
    (typeof sandboxId !== "string" || !SANDBOX_ID_PATTERN.test(sandboxId))
  ) {
    return undefined;
  }
  const keys = Object.keys(record).sort();
  // The 682cb47 shape, written only once the sandbox was running.
  if (keys.join(",") === LEGACY_SIDECAR_KEYS.join(",")) {
    if (sandboxId === undefined) return undefined;
    return {
      v: 1,
      runId,
      account: "",
      swarm: "",
      state: "running",
      sandboxId,
      checkpoint,
      keepSandbox,
    };
  }
  const { account, swarm, state } = record;
  if (
    !keys.every((key) => SIDECAR_KEYS.has(key)) ||
    record.runId !== runId ||
    typeof account !== "string" ||
    typeof swarm !== "string" ||
    !SIDECAR_STATES.has(state)
  ) {
    return undefined;
  }
  return {
    v: 1,
    runId,
    account,
    swarm,
    state: state as RailwaySidecar["state"],
    ...(sandboxId === undefined ? {} : { sandboxId }),
    checkpoint,
    keepSandbox,
  };
}

function sandboxRef(handle: RuntimeHandle): string | undefined {
  return handle.kind === "railway" && SANDBOX_ID_PATTERN.test(handle.ref) ? handle.ref : undefined;
}

async function assertMode(
  fs: RailwayRuntimeFs,
  path: string,
  mode: number,
  what: string,
): Promise<void> {
  if (process.platform === "win32") return;
  const actual = (await fs.stat(path)).mode & 0o777;
  if (actual !== mode) {
    throw new Error(
      `The temporary ${what} has mode ${actual.toString(8)}, expected ${mode.toString(8)}.`,
    );
  }
}

/** The device vault key, exactly as `vapi accounts export-key` reads it. */
async function deviceVaultKey(
  home: string,
  secrets: SecretStore,
  now: (() => Date) | undefined,
): Promise<{ path: string; key: Uint8Array }> {
  const path = join(home, "vault.json");
  const metadata = await readVaultFileUnlocked(path);
  const key = metadata.protected
    ? await unlockProtectedVault({
        path,
        secrets,
        env: process.env,
        ...(now === undefined ? {} : { now }),
      })
    : await loadOrCreateDeviceKey({ secrets });
  return { path, key };
}

/** Every value that must never appear in an error: the bundle, the key, and each credential. */
function collectSecrets(
  base: readonly string[],
  credentials: { tokens: string; routerStake?: string; routerBalance?: string },
): string[] {
  const values = [...base, credentials.tokens];
  if (credentials.routerStake !== undefined) values.push(credentials.routerStake);
  if (credentials.routerBalance !== undefined) values.push(credentials.routerBalance);
  try {
    collectStrings(JSON.parse(credentials.tokens), values);
  } catch {
    // Opaque token text is already covered as a whole.
  }
  return values.filter((value) => value.length >= MINIMUM_SECRET_LENGTH);
}

function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, into);
  else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectStrings(item, into);
  }
}

function scrub(text: string, secrets: readonly string[]): string {
  let scrubbed = text;
  for (const secret of secrets) scrubbed = scrubbed.replaceAll(secret, "[redacted]");
  return redactRunText(scrubbed);
}

function describeFailure(outcome: RailwayExecResult, secrets: readonly string[]): string {
  const line = outcome.stderr
    .split(/\r?\n/u)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  const exit = outcome.code === null ? "no exit code" : `exit ${outcome.code}`;
  if (line === undefined) return ` (${exit}).`;
  return ` (${exit}): ${scrub(line, secrets).slice(0, 300)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
