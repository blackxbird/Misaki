import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AGENT_MARKER_VARIABLES,
  appendReceipt,
  ARC_MAINNET_CAIP2,
  ARC_TESTNET_CAIP2,
  BASE_MAINNET_CAIP2,
  CANONICAL_X402_USDC_NETWORKS,
  getDefaultConfig,
  getVapiPaths,
  loadOrCreateDeviceKey,
  memorySecretStore,
  NETWORKS,
  readAuditLog,
  readSpendLedger,
  reserveSpend,
  SpendCapExceededError,
  WalletStore,
  writeAgentProfile,
  writeSwarm,
  type SecretStore,
  type SwarmBalanceReader,
  type SwarmFile,
  type VapiConfig,
} from "@vapi-network/core";
import { agentSecretAccounts } from "@vapi-network/core/agent-link";
import { exportMemberKey, openMemberBundle } from "@vapi-network/core/secrets";
import {
  runResultPath,
  readRunRecord,
  runsDirectory,
  RuntimeError,
  startDetachedRun,
  stopRun,
  writeRunRecord,
  type RuntimeHandle,
  type RuntimeMember,
  type RuntimeRun,
} from "@vapi-network/mcp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CliDependencies } from "./cli.js";
import { resolveRuntime } from "./runtime-local.js";
import {
  assertRemoteSafeMember,
  createRailwayRuntime,
  defaultRailwayExec,
  destroyRailwaySidecar,
  listRailwaySidecars,
  ownerBalanceReader,
  parseSandboxId,
  RAILWAY_CLI,
  railwaySidecarPath,
  RemoteKeyRefusedError,
  type RailwayExec,
  type RailwayExecResult,
  type RailwayRuntimeOptions,
  type RailwaySidecar,
} from "./runtime-railway.js";

const PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const OWNER = "0x1111111111111111111111111111111111111111" as const;
const ALPHA = "team-alpha-1";
const BETA = "team-beta-1";
const TREASURY = "team-treasury";
const LONER = "loner";
const RUN_ID = "run_111111111111111111111111";
const PARENT_RUN_ID = "run_222222222222222222222222";
const SANDBOX_ID = "sbx_7f3a9c";
const CHECKPOINT = "vapi-cli-0-6";
const STARTED_AT = "2026-09-30T10:00:00.000Z";
const ALPHA_ACCESS = "alpha-access-token-that-must-stay-secret";
const ALPHA_REFRESH = "alpha-refresh-token-that-must-stay-secret";
const ALPHA_ROUTER = "alpha-router-key-that-must-stay-secret";
const BETA_ACCESS = "beta-access-token-that-must-stay-secret";
const BETA_ROUTER = "beta-router-key-that-must-stay-secret";
const MISSING_RESULT = {
  code: 1,
  stdout: "",
  stderr: "cat: /tmp/vapi-result.json: No such file or directory\n",
};
const SANDBOX_GONE = { code: 1, stdout: "", stderr: "Error: Sandbox sbx_7f3a9c not found\n" };
const OK = { code: 0, stdout: "", stderr: "" };

const MEMBER: RuntimeMember = { swarm: "team", account: ALPHA, profile: ALPHA, role: "alpha" };
const RUN: RuntimeRun = {
  runId: RUN_ID,
  task: "Find a weather API and call it once",
  mode: "agent",
  budgetUsd: "0.50",
  parentRunId: PARENT_RUN_ID,
};

const homes: string[] = [];

beforeEach(() => {
  // The adapter also reads process.env for agent markers, and the shell running
  // these tests may well set one. Empty counts as unset.
  for (const name of AGENT_MARKER_VARIABLES) vi.stubEnv(name, "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

type Fixture = {
  home: string;
  store: WalletStore;
  secrets: SecretStore;
  tmp: string;
  alphaKey: `0x${string}`;
  swarm: SwarmFile;
};

async function fixture(): Promise<Fixture> {
  const home = await mkdtemp(join(tmpdir(), "vapi-railway-home-"));
  const tmp = await mkdtemp(join(tmpdir(), "vapi-railway-tmp-"));
  homes.push(home, tmp);
  const secrets = memorySecretStore();
  const store = await WalletStore.open(home, { secrets });
  const treasury = await store.create(TREASURY, "", { phrase: PHRASE });
  const alpha = await store.create(ALPHA, "");
  const beta = await store.create(BETA, "");
  await store.create(LONER, "");
  for (const name of [ALPHA, BETA, LONER]) {
    await store.setSpendCaps(name, { perCallAtomic: "100000", perDayAtomic: "1000000" });
    await store.setCeiling(name, 2_000_000n);
    await store.setLink(name, link(name));
  }
  const alphaNames = agentSecretAccounts(ALPHA);
  await secrets.set(alphaNames.tokens, tokens(ALPHA_ACCESS, ALPHA_REFRESH));
  await secrets.set(alphaNames.routerStake, ALPHA_ROUTER);
  const betaNames = agentSecretAccounts(BETA);
  await secrets.set(betaNames.tokens, tokens(BETA_ACCESS, "beta-refresh-token-must-stay-secret"));
  await secrets.set(betaNames.routerStake, BETA_ROUTER);
  await secrets.set(agentSecretAccounts(LONER).tokens, tokens("loner-access-token", "loner-r"));

  const swarm: SwarmFile = {
    v: 1,
    name: "team",
    device: "test-device",
    network: BASE_MAINNET_CAIP2,
    createdAt: "2026-09-29T12:00:00.000Z",
    treasury: {
      account: TREASURY,
      address: treasury.account.address,
      steps: { creating: true, created: true, capped: true, linked: true },
    },
    members: [
      swarmMember(ALPHA, alpha.account.address, "alpha"),
      swarmMember(BETA, beta.account.address, "beta"),
    ],
    policy: {
      strategy: "targets",
      treasuryCaps: { perCallAtomic: "5000000", perDayAtomic: "20000000" },
    },
  };
  await writeSwarm(home, swarm);
  for (const name of [ALPHA, BETA, TREASURY, LONER]) {
    await writeAgentProfile(home, {
      version: 1,
      name,
      wallet: name,
      model: "router/test",
      instructions: "Help the team.",
      tools: ["call.search"],
      verifiedOnly: true,
      approveAboveUsd: 0.5,
      maxSteps: 2,
      paused: false,
      grants: ["read", "delegate"],
      createdAt: "2026-09-29T12:00:00.000Z",
    });
  }
  const key = await loadOrCreateDeviceKey({ secrets });
  const alphaKey = await exportMemberKey({ path: join(home, "vault.json"), key, name: ALPHA });
  return { home, store, secrets, tmp, alphaKey, swarm };
}

function swarmMember(account: string, address: `0x${string}`, role: string) {
  return {
    account,
    address,
    role,
    weight: 1,
    targetAtomic: "1000000",
    ceilingAtomic: "2000000",
    steps: { creating: true, created: true, capped: true, profiled: true, linked: true },
  };
}

function link(name: string) {
  return {
    apiBase: "https://api.vapinetwork.ai",
    clientId: `agent_${name}`,
    owner: OWNER,
    label: name,
    scopes: ["mcp:call", "router.use"],
    linkedAt: "2026-09-29T12:00:00.000Z",
    routerBaseUrl: "https://router.vapinetwork.ai",
  };
}

function tokens(accessToken: string, refreshToken: string): string {
  return JSON.stringify({
    accessToken,
    refreshToken,
    expiresAt: Number.MAX_SAFE_INTEGER,
    scopes: ["mcp:call"],
  });
}

function remoteTokens(accessToken: string): string {
  return JSON.stringify({
    accessToken,
    expiresAt: Number.MAX_SAFE_INTEGER,
    scopes: ["mcp:call"],
    refreshable: false,
  });
}

type EnvFileObservation = { path: string; mode: number; directoryMode: number; content: string };

/** A fake `railway` binary. Every call is recorded; nothing real ever runs. */
function fakeRailway(
  handlers: {
    create?: (observation: EnvFileObservation) => RailwayExecResult | Promise<RailwayExecResult>;
    detach?: () => RailwayExecResult | Promise<RailwayExecResult>;
    ready?: () => RailwayExecResult | Promise<RailwayExecResult>;
    cat?: () => RailwayExecResult | Promise<RailwayExecResult>;
    destroy?: () => RailwayExecResult | Promise<RailwayExecResult>;
  } = {},
) {
  const calls: string[][] = [];
  const observations: EnvFileObservation[] = [];
  const exec = vi.fn<RailwayExec>(async (file, args) => {
    expect(file).toBe("railway");
    calls.push([...args]);
    const [group, verb] = args;
    expect(group).toBe("sandbox");
    if (verb === "create") {
      const path = args[args.indexOf("--env-file") + 1]!;
      const directory = join(path, "..");
      const observation: EnvFileObservation = {
        path,
        mode: (await stat(path)).mode & 0o777,
        directoryMode: (await stat(directory)).mode & 0o777,
        content: await readFile(path, "utf8"),
      };
      observations.push(observation);
      return await (handlers.create?.(observation) ?? {
        code: 0,
        stdout: `${JSON.stringify({ id: SANDBOX_ID, status: "CREATING" })}\n`,
        stderr: "",
      });
    }
    if (verb === "exec" && args.includes("--detach")) return await (handlers.detach?.() ?? OK);
    if (verb === "exec" && args.at(-1) === "true") return await (handlers.ready?.() ?? OK);
    if (verb === "exec") return await (handlers.cat?.() ?? MISSING_RESULT);
    if (verb === "destroy") return await (handlers.destroy?.() ?? OK);
    throw new Error(`unexpected railway call: ${args.join(" ")}`);
  });
  return { exec, calls, observations };
}

function runtimeFor(
  f: Fixture,
  exec: RailwayExec,
  overrides: Partial<RailwayRuntimeOptions> = {},
): ReturnType<typeof createRailwayRuntime> {
  return createRailwayRuntime({
    home: f.home,
    store: f.store,
    secrets: f.secrets,
    checkpoint: CHECKPOINT,
    allowRemoteKey: true,
    exec,
    tmpdir: f.tmp,
    config: async () => getDefaultConfig({}),
    now: () => new Date(STARTED_AT),
    tty: false,
    env: {},
    sleep: async () => undefined,
    balanceReader: async ({ network }) => (network === BASE_MAINNET_CAIP2 ? 1_000_000n : 0n),
    confirmedMembers: [ALPHA, BETA],
    ...overrides,
  });
}

function handle(overrides: Partial<RuntimeHandle> = {}): RuntimeHandle {
  return {
    runId: RUN_ID,
    kind: "railway",
    member: MEMBER,
    startedAt: STARTED_AT,
    ref: SANDBOX_ID,
    ...overrides,
  };
}

function forbiddenValues(f: Fixture, bundle?: string): string[] {
  return [
    ...(bundle === undefined ? [] : [bundle]),
    f.alphaKey,
    f.alphaKey.slice(2),
    ALPHA_ACCESS,
    ALPHA_REFRESH,
    ALPHA_ROUTER,
    BETA_ACCESS,
    BETA_ROUTER,
    PHRASE,
  ];
}

function bundleOf(observation: EnvFileObservation): string {
  const prefix = `${RAILWAY_CLI.bundleVariable}=`;
  expect(observation.content.startsWith(prefix)).toBe(true);
  expect(observation.content.endsWith("\n")).toBe(true);
  return observation.content.slice(prefix.length, -1);
}

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    () => false,
  );
}

async function directoryText(path: string): Promise<string> {
  const files = await readdir(path);
  const texts = await Promise.all(files.map((file) => readFile(join(path, file), "utf8")));
  return texts.join("\n");
}

describe("railway runtime policy refusals", () => {
  const cases: Array<{
    name: string;
    member?: RuntimeMember;
    run?: Partial<RuntimeRun>;
    options?: Partial<RailwayRuntimeOptions>;
    prepare?: (f: Fixture) => Promise<void>;
    error: RegExp;
    fix?: string;
  }> = [
    {
      name: "the swarm treasury",
      member: { swarm: "team", account: TREASURY, profile: TREASURY },
      error: /treasury of swarm team.*never leaves this machine/u,
    },
    {
      name: "an account that is not a member",
      member: { swarm: "team", account: LONER, profile: LONER },
      error: /loner is not a member of swarm team/u,
    },
    {
      name: "an account outside a swarm",
      member: { account: ALPHA, profile: ALPHA },
      error: /team-alpha-1 is not in a swarm/u,
    },
    {
      name: "lead mode",
      run: { mode: "lead" },
      error: /--mode each.*treasury key/u,
    },
    {
      name: "a target above 1.00 USDC",
      prepare: async (f) => {
        await writeSwarm(f.home, {
          ...f.swarm,
          members: f.swarm.members.map((member) =>
            member.account === ALPHA ? { ...member, targetAtomic: "1000001" } : member,
          ),
        });
      },
      error: /target of 1\.000001 USDC.*1\.00 USDC or less/su,
      fix: "vapi swarm create <name> --targets alpha=1",
    },
    {
      name: "an effective ceiling above 2.00 USDC",
      prepare: async (f) => {
        await f.store.setCeiling(ALPHA, 2_000_001n);
      },
      error: /effective ceiling of 2\.000001 USDC/u,
      fix: "vapi accounts caps team-alpha-1 --ceiling 2",
    },
    {
      name: "a per-day cap that lifts the effective ceiling above 2.00 USDC",
      prepare: async (f) => {
        await f.store.setSpendCaps(ALPHA, { perCallAtomic: "100000", perDayAtomic: "5000000" });
      },
      error: /effective ceiling of 5\.00 USDC/u,
      fix: "vapi accounts caps team-alpha-1 --ceiling 2 --per-day 2",
    },
    {
      name: "a disabled ceiling",
      prepare: async (f) => {
        await f.store.setCeiling(ALPHA, null);
      },
      error: /ceiling sweeps off/u,
      fix: "vapi accounts caps team-alpha-1 --ceiling 2",
    },
    {
      name: "a missing allowRemoteKey",
      options: { allowRemoteKey: undefined },
      error: /--allow-remote-key/u,
    },
    {
      name: "a missing checkpoint",
      options: { checkpoint: undefined },
      error: /--checkpoint <name> or set VAPI_RAILWAY_CHECKPOINT/u,
    },
    ...["--env-file", "-x", "../etc", "vapi cli", "a".repeat(65)].map((checkpoint) => ({
      name: `the checkpoint name ${JSON.stringify(checkpoint.slice(0, 12))}`,
      options: { checkpoint },
      error: /checkpoint name must be 1-64 letters, digits/u,
    })),
  ];

  it.each(cases)(
    "refuses $name before any key is read or railway runs",
    async ({ member, run, options, prepare, error, fix }) => {
      const f = await fixture();
      await prepare?.(f);
      const railway = fakeRailway();
      const vaultKey = vi.fn(async () => ({
        path: join(f.home, "vault.json"),
        key: new Uint8Array(32),
      }));
      const readCredentials = vi.spyOn(f.secrets, "get");
      const runtime = runtimeFor(f, railway.exec, { vaultKey, ...options });

      const failure = await runtime.start(member ?? MEMBER, { ...RUN, ...run }).catch((e) => e);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(error);
      if (fix !== undefined) expect((failure as Error).message).toContain(fix);
      expect(failure instanceof RemoteKeyRefusedError || failure instanceof RuntimeError).toBe(
        true,
      );
      expect(railway.exec).not.toHaveBeenCalled();
      expect(vaultKey).not.toHaveBeenCalled();
      expect(readCredentials).not.toHaveBeenCalled();
      // A key refusal is audited; a usage error (checkpoint, task) is not a refusal.
      expect(await readAuditLog(f.home)).toEqual(
        failure instanceof RemoteKeyRefusedError
          ? [
              expect.objectContaining({
                event: "agent.remote_key_refused",
                wallet: (member ?? MEMBER).account,
                detail: `refused: ${failure.code}`,
              }),
            ]
          : [],
      );
      expect(await readdir(f.tmp)).toEqual([]);
    },
  );

  it.each(["VAPI_NO_SECRETS", "CLAUDECODE", "CI"])(
    "refuses the export when %s is set, and audits the refusal",
    async (marker) => {
      const f = await fixture();
      const railway = fakeRailway();
      const vaultKey = vi.fn(async () => ({
        path: join(f.home, "vault.json"),
        key: new Uint8Array(32),
      }));
      const readCredentials = vi.spyOn(f.secrets, "get");

      const failure = (await runtimeFor(f, railway.exec, { vaultKey, env: { [marker]: "1" } })
        .start(MEMBER, RUN)
        .catch((error: unknown) => error)) as RemoteKeyRefusedError;

      expect(failure).toBeInstanceOf(RemoteKeyRefusedError);
      expect(failure.code).toBe("agent_marker");
      expect(failure.message).toContain(`${marker} is set`);
      expect(railway.exec).not.toHaveBeenCalled();
      expect(vaultKey).not.toHaveBeenCalled();
      expect(readCredentials).not.toHaveBeenCalled();
      expect(await readdir(f.tmp)).toEqual([]);
      expect(await readAuditLog(f.home)).toEqual([
        expect.objectContaining({
          event: "agent.remote_key_refused",
          wallet: ALPHA,
          agentMarker: marker,
          detail: `refused: ${marker} is set.`,
        }),
      ]);
    },
  );

  it("exports the pre-check for the CLI and returns the member policy", async () => {
    const f = await fixture();
    const safe = await assertRemoteSafeMember({
      home: f.home,
      member: MEMBER,
      mode: "agent",
      store: f.store,
      allowRemoteKey: true,
    });
    expect(safe.swarmMember.account).toBe(ALPHA);
    expect(safe.ceilingAtomic).toBe(2_000_000n);
    expect(safe.effectiveCeilingAtomic).toBe(2_000_000n);
  });

  it("refuses a task that would read as an option", async () => {
    const f = await fixture();
    const railway = fakeRailway();
    await expect(
      runtimeFor(f, railway.exec).start(MEMBER, { ...RUN, task: "--help" }),
    ).rejects.toThrow('must not start with "--"');
    expect(railway.exec).not.toHaveBeenCalled();
  });
});

/** A key reader that must never run: every refusal happens before it. */
function untouchedVaultKey(f: Fixture) {
  return vi.fn(async () => ({ path: join(f.home, "vault.json"), key: new Uint8Array(32) }));
}

async function expectRefusedBeforeExport(
  f: Fixture,
  railway: ReturnType<typeof fakeRailway>,
  vaultKey: ReturnType<typeof untouchedVaultKey>,
  code: string,
): Promise<void> {
  expect(railway.exec).not.toHaveBeenCalled();
  expect(vaultKey).not.toHaveBeenCalled();
  expect(await readdir(f.tmp)).toEqual([]);
  const audit = await readAuditLog(f.home);
  expect(audit).toEqual([
    expect.objectContaining({
      event: "agent.remote_key_refused",
      wallet: ALPHA,
      detail: `refused: ${code}`,
    }),
  ]);
  const text = await readFile(join(f.home, "audit.log"), "utf8");
  for (const value of forbiddenValues(f)) expect(text).not.toContain(value);
  expect(text).not.toContain("SECRET");
}

describe("railway runtime confirmed members", () => {
  it("refuses a member the owner did not confirm, before any key is read", async () => {
    const f = await fixture();
    const railway = fakeRailway();
    const vaultKey = untouchedVaultKey(f);
    const readCredentials = vi.spyOn(f.secrets, "get");

    const failure = (await runtimeFor(f, railway.exec, { vaultKey, confirmedMembers: [BETA] })
      .start(MEMBER, RUN)
      .catch((error: unknown) => error)) as RemoteKeyRefusedError;

    expect(failure).toBeInstanceOf(RemoteKeyRefusedError);
    expect(failure.code).toBe("member_not_confirmed");
    expect(failure.message).toContain(ALPHA);
    expect(readCredentials).not.toHaveBeenCalled();
    await expectRefusedBeforeExport(f, railway, vaultKey, "member_not_confirmed");
    expect(await exists(railwaySidecarPath(f.home, RUN_ID))).toBe(false);
  });

  it("refuses every member when no confirmed set was passed", async () => {
    const f = await fixture();
    const railway = fakeRailway();
    const vaultKey = untouchedVaultKey(f);

    const failure = (await runtimeFor(f, railway.exec, { vaultKey, confirmedMembers: undefined })
      .start(MEMBER, RUN)
      .catch((error: unknown) => error)) as RemoteKeyRefusedError;

    expect(failure).toBeInstanceOf(RemoteKeyRefusedError);
    expect(failure.code).toBe("member_not_confirmed");
    await expectRefusedBeforeExport(f, railway, vaultKey, "member_not_confirmed");
  });

  it("refuses a swarm member added after the owner confirmed the run", async () => {
    const f = await fixture();
    const railway = fakeRailway();
    const vaultKey = untouchedVaultKey(f);
    const runtime = runtimeFor(f, railway.exec, { vaultKey, confirmedMembers: [ALPHA] });

    const failure = (await runtime
      .start({ swarm: "team", account: BETA, profile: BETA, role: "beta" }, RUN)
      .catch((error: unknown) => error)) as RemoteKeyRefusedError;

    expect(failure).toBeInstanceOf(RemoteKeyRefusedError);
    expect(failure.code).toBe("member_not_confirmed");
    expect(failure.message).toContain(BETA);
    expect(railway.exec).not.toHaveBeenCalled();
    expect(vaultKey).not.toHaveBeenCalled();
    expect(await readAuditLog(f.home)).toEqual([
      expect.objectContaining({
        event: "agent.remote_key_refused",
        wallet: BETA,
        detail: "refused: member_not_confirmed",
      }),
    ]);
  });
});

describe("railway runtime unresolved authorizations", () => {
  const cases: Array<{
    name: string;
    prepare: (f: Fixture) => Promise<void>;
    fix: string;
  }> = [
    {
      name: "a ceiling sweep",
      prepare: async (f) => {
        await f.store.updateCeilingSweepPending(ALPHA, () => ({
          owner: OWNER,
          amountAtomic: "1000000",
          nonce: `0x${"11".repeat(32)}`,
          createdAt: STARTED_AT,
          status: "unknown",
        }));
      },
      fix: `vapi sweep --account ${ALPHA}`,
    },
    {
      name: "a movement leg",
      prepare: async (f) => {
        const directory = join(f.home, "movements");
        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, "mv_unfinished1.json"),
          JSON.stringify({
            v: 2,
            id: "mv_unfinished1",
            reason: "send",
            from: ALPHA,
            network: BASE_MAINNET_CAIP2,
            createdAt: STARTED_AT,
            legs: [
              {
                from: ALPHA,
                to: OWNER,
                amountUsd: "0.50",
                purpose: "send",
                nonce: `0x${"22".repeat(32)}`,
                status: "planned",
              },
            ],
          }),
        );
      },
      fix: "vapi swarm status team",
    },
    {
      name: "an unknown transfer receipt",
      prepare: async (f) => {
        await appendReceipt(
          {
            id: "transfer-unknown",
            timestamp: STARTED_AT,
            kind: "transfer",
            wallet: ALPHA,
            resourceUrl: "https://api.vapinetwork.ai/api/agents/transfers",
            transfer: {
              to: OWNER,
              toName: "owner",
              toKind: "owner",
              amountAtomic: "500000",
              network: BASE_MAINNET_CAIP2,
              nonce: `0x${"33".repeat(32)}`,
              status: "unknown",
              txHash: null,
              replayed: false,
            },
            settlement: { outcome: "unknown" },
          },
          getVapiPaths(f.home).receipts,
          { wallet: ALPHA },
        );
      },
      fix: "--resume",
    },
  ];

  it.each(cases)("refuses export while $name is unresolved", async ({ prepare, fix }) => {
    const f = await fixture();
    await prepare(f);
    const railway = fakeRailway();
    const vaultKey = untouchedVaultKey(f);

    const failure = (await runtimeFor(f, railway.exec, { vaultKey })
      .start(MEMBER, RUN)
      .catch((error: unknown) => error)) as RemoteKeyRefusedError;

    expect(failure).toBeInstanceOf(RemoteKeyRefusedError);
    expect(failure.code).toBe("authorization_unresolved");
    expect(failure.message).toContain(fix);
    await expectRefusedBeforeExport(f, railway, vaultKey, "authorization_unresolved");
  });

  it("allows export after a later resumed receipt settles the same transfer nonce", async () => {
    const f = await fixture();
    const nonce = `0x${"44".repeat(32)}`;
    const transfer = {
      to: OWNER,
      toName: "owner",
      toKind: "owner" as const,
      amountAtomic: "500000",
      network: BASE_MAINNET_CAIP2,
      nonce,
      txHash: null,
      replayed: false,
    };
    for (const [id, status, timestamp] of [
      ["transfer-timeout", "unknown", "2026-09-30T09:59:00.000Z"],
      ["transfer-resumed", "sent", "2026-09-30T10:00:00.000Z"],
    ] as const) {
      await appendReceipt(
        {
          id,
          timestamp,
          kind: "transfer",
          wallet: ALPHA,
          resourceUrl: "https://api.vapinetwork.ai/api/agents/transfers",
          transfer: { ...transfer, status },
          settlement: { outcome: status === "sent" ? "succeeded" : "unknown" },
        },
        getVapiPaths(f.home).receipts,
        { wallet: ALPHA },
      );
    }
    const railway = fakeRailway();

    await expect(runtimeFor(f, railway.exec).start(MEMBER, RUN)).resolves.toEqual(handle());
    expect(railway.observations).toHaveLength(1);
  });
});

describe("railway runtime bundle config", () => {
  function ownerConfig(overrides: Partial<VapiConfig> = {}): VapiConfig {
    const base = getDefaultConfig({});
    return {
      ...base,
      networks: {
        [BASE_MAINNET_CAIP2]: {
          ...base.networks[BASE_MAINNET_CAIP2]!,
          rpcUrl: "https://base.example/rpc?apikey=SECRET",
        },
      },
      ...overrides,
    };
  }

  it("never puts the owner's RPC URLs or API key into the bundle", async () => {
    const f = await fixture();
    const railway = fakeRailway();
    // configSchema drops `apiKey`, so a parsed owner config never has one to leak.
    await runtimeFor(f, railway.exec, { config: async () => ownerConfig() }).start(MEMBER, RUN);

    const text = bundleOf(railway.observations[0]!);
    const decoded = Buffer.from(text, "base64url").toString("utf8");
    for (const absent of ["SECRET", "rpcUrl", "apiKey", "base.example"]) {
      expect(decoded).not.toContain(absent);
    }
    expect(openMemberBundle(text).config.networks).toEqual({
      [BASE_MAINNET_CAIP2]: { usdc: getDefaultConfig({}).networks[BASE_MAINNET_CAIP2]!.usdc },
    });
  });

  it("carries only the swarm network after every known EVM network was checked", async () => {
    const f = await fixture();
    const railway = fakeRailway();
    const base = getDefaultConfig({});
    const owner: VapiConfig = {
      ...base,
      networks: {
        ...base.networks,
        [ARC_MAINNET_CAIP2]: {
          rpcUrl: NETWORKS[ARC_MAINNET_CAIP2].publicRpcUrl!,
          usdc: NETWORKS[ARC_MAINNET_CAIP2].usdc,
        },
      },
    };
    const balanceReader = vi.fn<SwarmBalanceReader>(async ({ network }) =>
      network === BASE_MAINNET_CAIP2 ? 500_000n : 0n,
    );

    await runtimeFor(f, railway.exec, { config: async () => owner, balanceReader }).start(
      MEMBER,
      RUN,
    );

    expect(balanceReader.mock.calls.map(([request]) => request.network)).toEqual(
      Object.keys(CANONICAL_X402_USDC_NETWORKS),
    );
    expect(
      Object.keys(openMemberBundle(bundleOf(railway.observations[0]!)).config.networks),
    ).toEqual([BASE_MAINNET_CAIP2]);
  });

  it("refuses a discovery URL with a query string before any key is read", async () => {
    const f = await fixture();
    const railway = fakeRailway();
    const vaultKey = untouchedVaultKey(f);
    const owner = ownerConfig({ discoveryUrl: "https://api.example/services?key=SECRET" });

    const failure = (await runtimeFor(f, railway.exec, { vaultKey, config: async () => owner })
      .start(MEMBER, RUN)
      .catch((error: unknown) => error)) as RemoteKeyRefusedError;

    expect(failure).toBeInstanceOf(RemoteKeyRefusedError);
    expect(failure.code).toBe("unsafe_config");
    expect(failure.message).toContain("discoveryUrl");
    expect(failure.message).not.toContain("SECRET");
    await expectRefusedBeforeExport(f, railway, vaultKey, "unsafe_config");
  });
});

describe("railway runtime live balance check", () => {
  it("refuses a member holding more than 2.00 USDC before any key is read", async () => {
    const f = await fixture();
    const railway = fakeRailway();
    const vaultKey = untouchedVaultKey(f);
    const balanceReader = vi.fn<SwarmBalanceReader>(async () => 2_000_001n);

    const failure = (await runtimeFor(f, railway.exec, { vaultKey, balanceReader })
      .start(MEMBER, RUN)
      .catch((error: unknown) => error)) as RemoteKeyRefusedError;

    expect(failure).toBeInstanceOf(RemoteKeyRefusedError);
    expect(failure.code).toBe("balance_too_high");
    expect(failure.message).toContain(ALPHA);
    expect(failure.message).toContain("2.000001 USDC");
    expect(failure.message).toContain("vapi swarm rebalance team");
    expect(failure.message).toContain(`vapi sweep --account ${ALPHA}`);
    expect(balanceReader).toHaveBeenCalledWith({
      account: ALPHA,
      address: f.swarm.members[0]!.address,
      network: BASE_MAINNET_CAIP2,
    });
    await expectRefusedBeforeExport(f, railway, vaultKey, "balance_too_high");
  });

  it("allows a member holding exactly 2.00 USDC", async () => {
    const f = await fixture();
    const railway = fakeRailway();

    await expect(
      runtimeFor(f, railway.exec, {
        balanceReader: async ({ network }) => (network === BASE_MAINNET_CAIP2 ? 2_000_000n : 0n),
      }).start(MEMBER, RUN),
    ).resolves.toEqual(handle());
    expect(railway.observations).toHaveLength(1);
  });

  it("refuses a positive balance on a known network other than the swarm network", async () => {
    const f = await fixture();
    const railway = fakeRailway();
    const vaultKey = untouchedVaultKey(f);
    const balanceReader = vi.fn<SwarmBalanceReader>(async ({ network }) =>
      network === ARC_MAINNET_CAIP2 ? 1n : 0n,
    );

    const failure = (await runtimeFor(f, railway.exec, { vaultKey, balanceReader })
      .start(MEMBER, RUN)
      .catch((error: unknown) => error)) as RemoteKeyRefusedError;

    expect(failure).toBeInstanceOf(RemoteKeyRefusedError);
    expect(failure.code).toBe("balance_on_other_network");
    expect(failure.message).toContain("Arc mainnet");
    expect(failure.message).toContain("dedicated account");
    await expectRefusedBeforeExport(f, railway, vaultKey, "balance_on_other_network");
  });

  it("refuses when any known mainnet balance is unreadable", async () => {
    const f = await fixture();
    const railway = fakeRailway();
    const vaultKey = untouchedVaultKey(f);
    const balanceReader = vi.fn<SwarmBalanceReader>(async ({ network }) => {
      if (network === ARC_MAINNET_CAIP2) throw new Error("unavailable SECRET rpc");
      return 0n;
    });

    const failure = (await runtimeFor(f, railway.exec, { vaultKey, balanceReader })
      .start(MEMBER, RUN)
      .catch((error: unknown) => error)) as RemoteKeyRefusedError;

    expect(failure.code).toBe("balance_unreadable");
    expect(failure.message).toContain("Arc mainnet");
    expect(failure.message).not.toContain("SECRET");
    await expectRefusedBeforeExport(f, railway, vaultKey, "balance_unreadable");
  });

  it("does not block on an unreadable testnet outside the swarm network", async () => {
    const f = await fixture();
    const railway = fakeRailway();
    const balanceReader = vi.fn<SwarmBalanceReader>(async ({ network }) => {
      if (network === ARC_TESTNET_CAIP2) throw new Error("no public rpc");
      return network === BASE_MAINNET_CAIP2 ? 500_000n : 0n;
    });

    await expect(
      runtimeFor(f, railway.exec, { balanceReader }).start(MEMBER, RUN),
    ).resolves.toEqual(handle());
    expect(railway.observations).toHaveLength(1);

    expect(balanceReader).toHaveBeenCalledWith(
      expect.objectContaining({ network: ARC_TESTNET_CAIP2 }),
    );
  });

  it("refuses, fail closed, when the balance cannot be read", async () => {
    const f = await fixture();
    const railway = fakeRailway();
    const vaultKey = untouchedVaultKey(f);

    const failure = (await runtimeFor(f, railway.exec, {
      vaultKey,
      balanceReader: async () => {
        throw new Error("fetch failed: https://base.example/rpc?apikey=SECRET");
      },
    })
      .start(MEMBER, RUN)
      .catch((error: unknown) => error)) as RemoteKeyRefusedError;

    expect(failure).toBeInstanceOf(RemoteKeyRefusedError);
    expect(failure.code).toBe("balance_unreadable");
    expect(failure.message).toContain(ALPHA);
    expect(failure.message).not.toContain("SECRET");
    await expectRefusedBeforeExport(f, railway, vaultKey, "balance_unreadable");
  });

  it("reads the balance from the owner's network config by default", async () => {
    const f = await fixture();
    const railway = fakeRailway();
    const vaultKey = untouchedVaultKey(f);
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id: number; method: string };
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        // 3.00 USDC for balanceOf.
        result: `0x${(3_000_000).toString(16).padStart(64, "0")}`,
      });
    });

    const failure = (await runtimeFor(f, railway.exec, {
      vaultKey,
      balanceReader: undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
      .start(MEMBER, RUN)
      .catch((error: unknown) => error)) as RemoteKeyRefusedError;

    expect(fetchImpl).toHaveBeenCalled();
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://mainnet.base.org/");
    expect(failure.code).toBe("balance_too_high");
    await expectRefusedBeforeExport(f, railway, vaultKey, "balance_too_high");
  });

  it("uses a configured RPC URL but always queries canonical USDC", async () => {
    const configuredToken = "0x2222222222222222222222222222222222222222";
    const calls: Array<{ to: string }> = [];
    const urls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      urls.push(input instanceof Request ? input.url : String(input));
      const request = JSON.parse(String(init?.body)) as {
        id: number;
        params: Array<{ to: string }>;
      };
      calls.push(request.params[0]!);
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: `0x${"0".repeat(64)}`,
      });
    });
    const config = getDefaultConfig({});
    config.networks[BASE_MAINNET_CAIP2] = {
      rpcUrl: "https://configured-rpc.example",
      usdc: configuredToken,
    };

    await expect(
      ownerBalanceReader(
        config,
        fetchImpl,
      )({
        account: ALPHA,
        address: OWNER,
        network: BASE_MAINNET_CAIP2,
      }),
    ).resolves.toBe(0n);

    expect(urls).toEqual(["https://configured-rpc.example/"]);
    expect(calls.map((call) => call.to)).toEqual([
      CANONICAL_X402_USDC_NETWORKS[BASE_MAINNET_CAIP2].usdc,
    ]);
    expect(calls[0]!.to.toLowerCase()).not.toBe(configuredToken.toLowerCase());
  });
});

describe("railway runtime through resolveRuntime", () => {
  function sdkDependencies(
    f: Fixture,
    railway: ReturnType<typeof fakeRailway>,
    env: NodeJS.ProcessEnv,
    reads: string[],
  ): CliDependencies {
    const secrets: SecretStore = {
      ...f.secrets,
      async get(name) {
        reads.push(name);
        return await f.secrets.get(name);
      },
    };
    return {
      env,
      interactive: false,
      secretStore: secrets,
      railwayExec: railway.exec,
      now: () => new Date(STARTED_AT),
      swarm: { balanceReader: async () => 0n },
      fetchImpl: (async () => {
        throw new Error("No live network in tests.");
      }) as typeof fetch,
    };
  }

  it("refuses when process.env sets VAPI_NO_SECRETS, even with a clean injected env", async () => {
    const f = await fixture();
    const railway = fakeRailway();
    const reads: string[] = [];
    vi.stubEnv("VAPI_NO_SECRETS", "1");

    const failure = (await resolveRuntime(
      "railway",
      f.home,
      sdkDependencies(f, railway, {}, reads),
      { checkpoint: CHECKPOINT, allowRemoteKey: true, confirmedMembers: [ALPHA] },
    )
      .start(MEMBER, RUN)
      .catch((error: unknown) => error)) as RemoteKeyRefusedError;

    expect(failure).toBeInstanceOf(RemoteKeyRefusedError);
    expect(failure.code).toBe("agent_marker");
    expect(failure.message).toContain("VAPI_NO_SECRETS is set");
    expect(railway.exec).not.toHaveBeenCalled();
    expect(reads).toEqual([]);
    const audit = await readAuditLog(f.home);
    expect(audit.map((entry) => entry.event)).toEqual(["agent.remote_key_refused"]);
  });

  it("refuses when the injected env sets an agent marker and process.env is clean", async () => {
    const f = await fixture();
    const railway = fakeRailway();
    const reads: string[] = [];

    const failure = (await resolveRuntime(
      "railway",
      f.home,
      sdkDependencies(f, railway, { CLAUDECODE: "1" }, reads),
      { checkpoint: CHECKPOINT, allowRemoteKey: true, confirmedMembers: [ALPHA] },
    )
      .start(MEMBER, RUN)
      .catch((error: unknown) => error)) as RemoteKeyRefusedError;

    expect(failure).toBeInstanceOf(RemoteKeyRefusedError);
    expect(failure.code).toBe("agent_marker");
    expect(failure.message).toContain("CLAUDECODE is set");
    expect(railway.exec).not.toHaveBeenCalled();
    expect(reads).toEqual([]);
  });

  it("plumbs the CLI balance reader into the adapter", async () => {
    const f = await fixture();
    const railway = fakeRailway();
    const reads: string[] = [];
    const dependencies = sdkDependencies(f, railway, {}, reads);
    const balanceReader = vi.fn<SwarmBalanceReader>(async () => 5_000_000n);

    const failure = (await resolveRuntime(
      "railway",
      f.home,
      { ...dependencies, swarm: { balanceReader } },
      { checkpoint: CHECKPOINT, allowRemoteKey: true, confirmedMembers: [ALPHA] },
    )
      .start(MEMBER, RUN)
      .catch((error: unknown) => error)) as RemoteKeyRefusedError;

    expect(balanceReader).toHaveBeenCalledOnce();
    expect(failure.code).toBe("balance_too_high");
    expect(railway.exec).not.toHaveBeenCalled();
  });
});

describe("railway runtime env file", () => {
  it("passes only this member's bundle through a 0600 env file that is gone after create", async () => {
    const f = await fixture();
    const railway = fakeRailway();

    await runtimeFor(f, railway.exec).start(MEMBER, RUN);

    const [observation] = railway.observations;
    expect(observation).toBeDefined();
    expect(observation!.mode).toBe(0o600);
    expect(observation!.directoryMode).toBe(0o700);
    expect(observation!.path.startsWith(f.tmp)).toBe(true);
    expect(await exists(observation!.path)).toBe(false);
    expect(await readdir(f.tmp)).toEqual([]);

    const bundleText = bundleOf(observation!);
    const bundle = openMemberBundle(bundleText);
    expect(bundle.account).toBe(ALPHA);
    expect(bundle.privateKey).toBe(f.alphaKey);
    expect(bundle.swarm).toBe("team");
    expect(bundle.runId).toBe(RUN_ID);
    expect(bundle.parentRunId).toBe(PARENT_RUN_ID);
    expect(bundle.ceilingAtomic).toBe("2000000");
    expect(bundle.profile.grants).toEqual(["read"]);
    expect(bundle.credentials).toEqual({
      tokens: remoteTokens(ALPHA_ACCESS),
      routerStake: ALPHA_ROUTER,
    });
    expect(JSON.stringify(bundle.credentials)).not.toContain(ALPHA_REFRESH);
    const decoded = JSON.stringify(bundle);
    for (const absent of [BETA_ACCESS, BETA_ROUTER, PHRASE, ...PHRASE.split(" ").slice(-1)]) {
      expect(decoded).not.toContain(absent);
    }
    expect(observation!.content).not.toContain(BETA_ACCESS);

    const argv = railway.calls.flat();
    for (const value of forbiddenValues(f, bundleText)) {
      for (const element of argv) expect(element).not.toContain(value);
    }
  });

  it.each([
    [
      "returns non-zero",
      async () => ({ code: 1, stdout: "", stderr: "Error: checkpoint missing" }),
    ],
    [
      "throws",
      async () => {
        throw new Error("railway crashed");
      },
    ],
  ] as const)(
    "deletes the env file when create %s and audits the failed export",
    async (_label, create) => {
      const f = await fixture();
      const railway = fakeRailway({ create });

      const failure = (await runtimeFor(f, railway.exec)
        .start(MEMBER, RUN)
        .catch((error: unknown) => error)) as Error;

      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toMatch(/railway sandbox create failed/u);
      const observation = railway.observations[0]!;
      expect(observation.mode).toBe(0o600);
      expect(await exists(observation.path)).toBe(false);
      expect(await readdir(f.tmp)).toEqual([]);
      for (const value of forbiddenValues(f, bundleOf(observation))) {
        expect(failure.message).not.toContain(value);
      }
      expect(railway.calls).toHaveLength(1);
      const audit = await readAuditLog(f.home);
      expect(audit).toEqual([
        expect.objectContaining({
          event: "agent.remote_key_exported",
          wallet: ALPHA,
          detail: "runtime=railway sandbox=none create_failed",
          tty: false,
        }),
      ]);
    },
  );

  it("redacts a create error that echoes the bundle", async () => {
    const f = await fixture();
    const railway = fakeRailway({
      create: (observation) => ({ code: 1, stdout: "", stderr: `bad env: ${observation.content}` }),
    });

    const failure = (await runtimeFor(f, railway.exec)
      .start(MEMBER, RUN)
      .catch((error: unknown) => error)) as Error;

    expect(failure.message).toContain("[redacted]");
    expect(failure.message).not.toContain(bundleOf(railway.observations[0]!));
  });

  it("parses the sandbox id from create output and fails clearly otherwise", () => {
    expect(parseSandboxId('{"id":"sbx_1"}')).toBe("sbx_1");
    expect(parseSandboxId('{"sandboxId":"sbx_2","status":"CREATING"}')).toBe("sbx_2");
    expect(parseSandboxId('Creating sandbox...\n{"sandbox":{"id":"sbx_3"}}\n')).toBe("sbx_3");
    expect(() => parseSandboxId("Sandbox created")).toThrow(/expected JSON with id or sandboxId/u);
    expect(() => parseSandboxId('{"id":"--rm"}')).toThrow(/sandbox id/u);
  });
});

describe("railway runtime spend reservation", () => {
  it("classifies the typed per-day cap raised during reservation as exhausted allowance", async () => {
    const f = await fixture();
    const railway = fakeRailway();
    const reservation = vi
      .spyOn(await import("@vapi-network/core"), "reserveSpend")
      .mockRejectedValueOnce(
        new SpendCapExceededError({
          cap: "per_day",
          amountUsd: "1",
          limitUsd: "1",
          spentUsd: "0.5",
          wallet: ALPHA,
        }),
      );

    const failure = await runtimeFor(f, railway.exec)
      .start(MEMBER, RUN)
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "no_daily_allowance" });
    expect((failure as Error).message).toContain("changed while Railway was starting");
    reservation.mockRestore();
  });

  it("reserves the remaining local daily allowance and gives only that amount to the run", async () => {
    const f = await fixture();
    const railway = fakeRailway();
    const ledgerPath = getVapiPaths(f.home).ledger;
    await reserveSpend(
      750_000n,
      { perCallAtomic: "1000000", perDayAtomic: "1000000" },
      { ledgerPath, wallet: ALPHA, now: new Date(STARTED_AT) },
    );

    await runtimeFor(f, railway.exec).start(MEMBER, RUN);

    await expect(readSpendLedger(ledgerPath, new Date(STARTED_AT), ALPHA)).resolves.toMatchObject({
      spentAtomic: "1000000",
    });
    const bundle = openMemberBundle(bundleOf(railway.observations[0]!));
    expect(bundle.caps).toEqual({ perCallAtomic: "100000", perDayAtomic: "250000" });
    expect(railway.calls.find((call) => call.includes("--detach"))).toContain("0.25");
  });

  it("expires a 23:59 UTC reservation at the next UTC midnight", async () => {
    const f = await fixture();
    const railway = fakeRailway();
    const reservedAt = new Date("2026-09-30T23:59:00.000Z");

    await runtimeFor(f, railway.exec, { now: () => reservedAt }).start(MEMBER, RUN);

    expect(openMemberBundle(bundleOf(railway.observations[0]!))).toMatchObject({
      allowanceExpiresAt: "2026-10-01T00:00:00.000Z",
    });
  });

  it("refuses launch when no daily allowance remains", async () => {
    const f = await fixture();
    const railway = fakeRailway();
    const vaultKey = untouchedVaultKey(f);
    const ledgerPath = getVapiPaths(f.home).ledger;
    await reserveSpend(
      1_000_000n,
      { perCallAtomic: "1000000", perDayAtomic: "1000000" },
      { ledgerPath, wallet: ALPHA, now: new Date(STARTED_AT) },
    );

    const failure = (await runtimeFor(f, railway.exec, { vaultKey })
      .start(MEMBER, RUN)
      .catch((error: unknown) => error)) as RemoteKeyRefusedError;

    expect(failure.code).toBe("no_daily_allowance");
    expect(failure.message).toContain("daily allowance");
    await expectRefusedBeforeExport(f, railway, vaultKey, "no_daily_allowance");
  });
});

describe("railway runtime lifecycle", () => {
  it("recovers and stops a sandbox after a crash left its run starting", async () => {
    const f = await fixture();
    const railway = fakeRailway();
    const runtime = runtimeFor(f, railway.exec);
    await writeRunRecord(f.home, {
      v: 1,
      runId: RUN_ID,
      kind: "railway",
      member: MEMBER,
      run: RUN,
      handle: { ...handle(), ref: "" },
      startedAt: STARTED_AT,
      state: "starting",
    });
    await mkdir(runsDirectory(f.home), { recursive: true });
    await writeFile(
      railwaySidecarPath(f.home, RUN_ID),
      JSON.stringify(sidecarOf({ state: "running", sandboxId: SANDBOX_ID })),
    );

    const stopped = await stopRun({
      home: f.home,
      runtime,
      record: (await readRunRecord(f.home, RUN_ID))!,
    });

    expect(stopped.state).toBe("stopped");
    expect(stopped.handle.ref).toBe(SANDBOX_ID);
    expect(railway.calls).toContainEqual(["sandbox", "destroy", SANDBOX_ID]);
    expect(await exists(railwaySidecarPath(f.home, RUN_ID))).toBe(false);
  });

  it("does not retire an id-less sidecar for another member", async () => {
    const f = await fixture();
    const railway = fakeRailway();
    const runtime = runtimeFor(f, railway.exec, {
      now: () => new Date("2026-09-30T10:06:00.000Z"),
    });
    const starting = {
      v: 1,
      runId: RUN_ID,
      kind: "railway",
      member: MEMBER,
      run: RUN,
      handle: { ...handle(), ref: "" },
      startedAt: STARTED_AT,
      state: "starting",
    } as const;
    await writeRunRecord(f.home, starting);
    await mkdir(runsDirectory(f.home), { recursive: true });
    await writeFile(
      railwaySidecarPath(f.home, RUN_ID),
      JSON.stringify(sidecarOf({ account: BETA })),
    );

    await expect(
      stopRun({
        home: f.home,
        runtime,
        record: starting,
        confirmWorkerStopped: true,
        now: () => new Date("2026-09-30T10:06:00.000Z"),
      }),
    ).rejects.toThrow(/does not match the confirmed stale start/u);
    await expect(readRunRecord(f.home, RUN_ID)).resolves.toMatchObject({ state: "starting" });
    expect(await exists(railwaySidecarPath(f.home, RUN_ID))).toBe(true);
    expect(railway.calls).toEqual([]);
  });

  it("creates, detaches the headless run, reports running, then finished and destroys", async () => {
    const f = await fixture();
    let cat: RailwayExecResult = MISSING_RESULT;
    const railway = fakeRailway({ cat: () => cat });
    const runtime = runtimeFor(f, railway.exec);

    await expect(runtime.start(MEMBER, RUN)).resolves.toEqual(handle());

    const envFile = railway.observations[0]!.path;
    expect(railway.calls).toEqual([
      [
        "sandbox",
        "create",
        "--checkpoint",
        CHECKPOINT,
        "--env-file",
        envFile,
        "--idle-timeout-minutes",
        "30",
        "--json",
      ],
      ["sandbox", "exec", SANDBOX_ID, "--", "true"],
      [
        "sandbox",
        "exec",
        SANDBOX_ID,
        "--detach",
        "--",
        "vapi",
        "agent",
        "run",
        "--bundle-env",
        "VAPI_MEMBER_BUNDLE",
        "--task-base64url",
        Buffer.from(RUN.task, "utf8").toString("base64url"),
        "--json",
        "--result-file",
        "/tmp/vapi-result.json",
        "--budget",
        "0.50",
      ],
    ]);
    expect(JSON.parse(await readFile(railwaySidecarPath(f.home, RUN_ID), "utf8"))).toEqual({
      v: 1,
      runId: RUN_ID,
      account: ALPHA,
      swarm: "team",
      state: "running",
      sandboxId: SANDBOX_ID,
      checkpoint: CHECKPOINT,
      keepSandbox: false,
    });
    expect((await stat(railwaySidecarPath(f.home, RUN_ID))).mode & 0o777).toBe(0o600);

    await expect(runtime.status(handle())).resolves.toEqual({ state: "running" });
    expect(railway.calls.at(-1)).toEqual([
      "sandbox",
      "exec",
      SANDBOX_ID,
      "--",
      "cat",
      "/tmp/vapi-result.json",
    ]);

    const leakedKey = `0x${"ab".repeat(32)}`;
    cat = {
      code: 0,
      stdout: JSON.stringify({ v: 1, exitCode: 0, result: { answer: `Done. ${leakedKey}` } }),
      stderr: "",
    };
    // A fresh adapter, as a later `vapi swarm runs` would build: no checkpoint or opt-in needed.
    const later = createRailwayRuntime({ home: f.home, exec: railway.exec });
    const status = await later.status(handle());
    expect(status).toEqual({
      state: "finished",
      exitCode: 0,
      result: { answer: "Done. [redacted private key]" },
    });
    const destroys = railway.calls.filter((call) => call[1] === "destroy");
    expect(destroys).toEqual([["sandbox", "destroy", SANDBOX_ID]]);
    expect(await exists(railwaySidecarPath(f.home, RUN_ID))).toBe(false);
    const resultPath = runResultPath(f.home, RUN_ID);
    expect((await stat(resultPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual({
      v: 1,
      exitCode: 0,
      result: { answer: "Done. [redacted private key]" },
    });
  });

  it("reports a failed envelope as failed and still destroys the sandbox", async () => {
    const f = await fixture();
    const railway = fakeRailway({
      cat: () => ({
        code: 0,
        stdout: JSON.stringify({ v: 1, exitCode: 1, error: { message: "budget exhausted" } }),
        stderr: "",
      }),
    });

    await expect(runtimeFor(f, railway.exec).status(handle())).resolves.toEqual({
      state: "failed",
      exitCode: 1,
      detail: "budget exhausted",
    });
    expect(railway.calls.filter((call) => call[1] === "destroy")).toHaveLength(1);
  });

  it("keeps the sandbox when keepSandbox was set at start, also for a fresh adapter", async () => {
    const f = await fixture();
    const railway = fakeRailway({
      cat: () => ({
        code: 0,
        stdout: JSON.stringify({ v: 1, exitCode: 0, result: {} }),
        stderr: "",
      }),
    });
    await runtimeFor(f, railway.exec, { keepSandbox: true }).start(MEMBER, RUN);
    expect(JSON.parse(await readFile(railwaySidecarPath(f.home, RUN_ID), "utf8")).keepSandbox).toBe(
      true,
    );

    const later = createRailwayRuntime({ home: f.home, exec: railway.exec });
    await expect(later.status(handle())).resolves.toMatchObject({ state: "finished" });
    expect(railway.calls.filter((call) => call[1] === "destroy")).toEqual([]);
  });

  it("stops by destroying the sandbox and treats a missing sandbox as stopped", async () => {
    const f = await fixture();
    const railway = fakeRailway();
    const runtime = createRailwayRuntime({ home: f.home, exec: railway.exec });

    await runtime.stop(handle());
    expect(railway.calls).toEqual([["sandbox", "destroy", SANDBOX_ID]]);

    const gone = fakeRailway({ destroy: () => SANDBOX_GONE });
    await expect(
      createRailwayRuntime({ home: f.home, exec: gone.exec }).stop(handle()),
    ).resolves.toBeUndefined();
  });

  it("reports a sandbox that is gone as unknown", async () => {
    const f = await fixture();
    const railway = fakeRailway({ cat: () => SANDBOX_GONE });

    await expect(
      createRailwayRuntime({ home: f.home, exec: railway.exec }).status(handle()),
    ).resolves.toEqual({ state: "unknown", detail: "sandbox gone" });
    expect(railway.calls.filter((call) => call[1] === "destroy")).toEqual([]);
  });

  it("rejects a handle whose ref could read as a railway option", async () => {
    const f = await fixture();
    const railway = fakeRailway();
    const runtime = createRailwayRuntime({ home: f.home, exec: railway.exec });

    await expect(runtime.status(handle({ ref: "--all" }))).resolves.toEqual({
      state: "unknown",
      detail: "invalid railway runtime handle",
    });
    await expect(runtime.stop(handle({ ref: "--all" }))).rejects.toThrow(/Invalid railway/u);
    expect(railway.exec).not.toHaveBeenCalled();
  });

  it("waits until a booting sandbox answers before the detached run", async () => {
    const f = await fixture();
    const booting = { code: 1, stdout: "", stderr: "Error: sandbox is not running yet" };
    const answers = [booting, booting, OK];
    const sleep = vi.fn(async () => undefined);
    const railway = fakeRailway({ ready: () => answers.shift() ?? OK });

    await expect(
      runtimeFor(f, railway.exec, { sleep, readyIntervalMs: 250 }).start(MEMBER, RUN),
    ).resolves.toEqual(handle());

    expect(railway.calls.map((call) => call.slice(1, 2).concat(call.slice(-1)))).toEqual([
      ["create", "--json"],
      ["exec", "true"],
      ["exec", "true"],
      ["exec", "true"],
      ["exec", "0.50"],
    ]);
    expect(sleep.mock.calls).toEqual([[250], [250]]);
  });

  it("destroys a sandbox that never becomes ready", async () => {
    const f = await fixture();
    const railway = fakeRailway({
      ready: () => ({ code: 1, stdout: "", stderr: "Error: sandbox is not running yet" }),
    });

    await expect(
      runtimeFor(f, railway.exec, { readyAttempts: 3 }).start(MEMBER, RUN),
    ).rejects.toThrow(/railway sandbox sbx_7f3a9c did not become ready/u);
    expect(railway.calls.filter((call) => call.at(-1) === "true")).toHaveLength(3);
    expect(railway.calls.some((call) => call.includes("--detach"))).toBe(false);
    expect(railway.calls.at(-1)).toEqual(["sandbox", "destroy", SANDBOX_ID]);
    expect(await exists(railwaySidecarPath(f.home, RUN_ID))).toBe(false);
  });

  it("tells the owner to destroy a sandbox whose id it cannot read", async () => {
    const f = await fixture();
    const railway = fakeRailway({
      create: () => ({ code: 0, stdout: "Sandbox created\n", stderr: "" }),
    });

    const failure = (await runtimeFor(f, railway.exec)
      .start(MEMBER, RUN)
      .catch((error: unknown) => error)) as Error;

    expect(failure.message).toContain("expected JSON with id or sandboxId");
    expect(failure.message).toContain("railway sandbox destroy <id>");
    expect(failure.message).toContain(`can spend ${ALPHA}'s balance`);
    expect(railway.calls).toHaveLength(1);
    expect(await readdir(f.tmp)).toEqual([]);
    expect(await readAuditLog(f.home)).toEqual([
      expect.objectContaining({ detail: "runtime=railway sandbox=unknown create_unparsed" }),
    ]);
  });

  it("destroys the sandbox when the detached exec fails", async () => {
    const f = await fixture();
    const railway = fakeRailway({
      detach: () => ({ code: 1, stdout: "", stderr: "exec: vapi: not installed" }),
    });

    await expect(runtimeFor(f, railway.exec).start(MEMBER, RUN)).rejects.toThrow(
      /railway sandbox exec sbx_7f3a9c failed/u,
    );
    expect(railway.calls.at(-1)).toEqual(["sandbox", "destroy", SANDBOX_ID]);
    expect(await exists(railwaySidecarPath(f.home, RUN_ID))).toBe(false);
    expect(await readdir(f.tmp)).toEqual([]);
  });
});

describe("railway runtime audit and stored state", () => {
  it.each(["creating", "orphaned"] as const)(
    "treats a %s sidecar as busy for that member",
    async (state) => {
      const f = await fixture();
      const runId = state === "creating" ? RUN_ID : "run_333333333333333333333333";
      await mkdir(runsDirectory(f.home), { recursive: true });
      await writeFile(
        railwaySidecarPath(f.home, runId),
        JSON.stringify({
          v: 1,
          runId,
          account: ALPHA,
          swarm: "team",
          state,
          checkpoint: CHECKPOINT,
          keepSandbox: false,
        }),
      );
      const runtime = createRailwayRuntime({ home: f.home, exec: fakeRailway().exec });

      await expect(
        startDetachedRun({
          home: f.home,
          runtime,
          member: MEMBER,
          run: { ...RUN, runId: "run_444444444444444444444444" },
        }),
      ).rejects.toMatchObject({ code: "member_busy", message: expect.stringContaining(runId) });
    },
  );

  it("audits the export once and keeps every secret out of the audit, registry and sidecar", async () => {
    const f = await fixture();
    const railway = fakeRailway();
    const runtime = runtimeFor(f, railway.exec);

    const record = await startDetachedRun({
      home: f.home,
      runtime,
      member: MEMBER,
      run: RUN,
      env: {},
    });

    expect(record.kind).toBe("railway");
    expect(record.handle.ref).toBe(SANDBOX_ID);
    const audit = await readAuditLog(f.home);
    expect(audit).toEqual([
      {
        time: STARTED_AT,
        event: "agent.remote_key_exported",
        wallet: ALPHA,
        tty: false,
        detail: `runtime=railway sandbox=${SANDBOX_ID}`,
      },
    ]);

    const bundleText = bundleOf(railway.observations[0]!);
    const stored = [
      await readFile(join(f.home, "audit.log"), "utf8"),
      await directoryText(runsDirectory(f.home)),
    ].join("\n");
    expect(stored).toContain(SANDBOX_ID);
    for (const value of forbiddenValues(f, bundleText)) expect(stored).not.toContain(value);
    for (const word of ["abandon", "about"]) expect(stored).not.toContain(word);
  });
});

function readSidecarFile(f: Fixture): unknown {
  return JSON.parse(readFileSync(railwaySidecarPath(f.home, RUN_ID), "utf8"));
}

function sidecarOf(overrides: Partial<RailwaySidecar> = {}): RailwaySidecar {
  return {
    v: 1,
    runId: RUN_ID,
    account: ALPHA,
    swarm: "team",
    state: "creating",
    checkpoint: CHECKPOINT,
    keepSandbox: false,
    ...overrides,
  };
}

type SignalName = "SIGINT" | "SIGTERM";

function addedListener(signal: SignalName, before: readonly unknown[]) {
  const added = process.listeners(signal).filter((listener) => !before.includes(listener));
  expect(added).toHaveLength(1);
  return added[0]!;
}

function captureStderr(): string[] {
  const lines: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  return lines;
}

const CREATED = {
  code: 0,
  stdout: `${JSON.stringify({ id: SANDBOX_ID, status: "CREATING" })}\n`,
  stderr: "",
};

describe("railway runtime signals during start", () => {
  it("SIGINT during sandbox create removes the env file synchronously, keeps a creating sidecar and re-raises", async () => {
    const f = await fixture();
    const before = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const stderr = captureStderr();
    let atSignal: unknown;
    const railway = fakeRailway({
      create: async (observation) => {
        addedListener("SIGINT", before.SIGINT)("SIGINT");
        // Synchronously after the handler: the key file and its directory are gone.
        expect(existsSync(observation.path)).toBe(false);
        expect(existsSync(join(observation.path, ".."))).toBe(false);
        atSignal = readSidecarFile(f);
        await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(process.pid, "SIGINT"));
        return CREATED;
      },
    });

    const failure = (await runtimeFor(f, railway.exec)
      .start(MEMBER, RUN)
      .catch((error: unknown) => error)) as Error;

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toMatch(/interrupted by SIGINT/u);
    expect(atSignal).toEqual(sidecarOf());
    // The interrupted start never writes the sidecar back or goes on.
    expect(readSidecarFile(f)).toEqual(sidecarOf());
    expect(kill).toHaveBeenCalledTimes(1);
    expect(railway.calls).toHaveLength(1);
    const text = stderr.join("");
    expect(text).toContain("railway sandbox list");
    for (const value of forbiddenValues(f, bundleOf(railway.observations[0]!))) {
      expect(text).not.toContain(value);
      expect(failure.message).not.toContain(value);
    }
    expect(process.listeners("SIGINT")).toEqual(before.SIGINT);
    expect(process.listeners("SIGTERM")).toEqual(before.SIGTERM);
  });

  it("SIGTERM during readiness destroys the known sandbox and drops the sidecar", async () => {
    const f = await fixture();
    const before = process.listeners("SIGTERM");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const stderr = captureStderr();
    let atSignal: unknown;
    const railway = fakeRailway({
      ready: async () => {
        addedListener("SIGTERM", before)("SIGTERM");
        atSignal = readSidecarFile(f);
        await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM"));
        return OK;
      },
    });

    const failure = (await runtimeFor(f, railway.exec)
      .start(MEMBER, RUN)
      .catch((error: unknown) => error)) as Error;

    expect(failure.message).toMatch(/interrupted by SIGTERM/u);
    expect(atSignal).toEqual(sidecarOf({ state: "orphaned", sandboxId: SANDBOX_ID }));
    expect(railway.calls.filter((call) => call[1] === "destroy")).toEqual([
      ["sandbox", "destroy", SANDBOX_ID],
    ]);
    expect(railway.calls.some((call) => call.includes("--detach"))).toBe(false);
    expect(await exists(railwaySidecarPath(f.home, RUN_ID))).toBe(false);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(stderr.join("")).toContain(`railway sandbox destroy ${SANDBOX_ID}`);
    expect(process.listeners("SIGTERM")).toEqual(before);
  });

  it("SIGINT while create is in flight audits the possible export", async () => {
    const f = await fixture();
    const before = process.listeners("SIGINT");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    captureStderr();
    const railway = fakeRailway({
      create: async () => {
        addedListener("SIGINT", before)("SIGINT");
        await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(process.pid, "SIGINT"));
        return CREATED;
      },
    });

    await runtimeFor(f, railway.exec)
      .start(MEMBER, RUN)
      .catch(() => undefined);

    const audit = await readAuditLog(f.home);
    expect(audit.filter((entry) => entry.event === "agent.remote_key_exported")).toEqual([
      expect.objectContaining({
        wallet: ALPHA,
        detail: "runtime=railway sandbox=unknown interrupted",
      }),
    ]);
    const text = await readFile(join(f.home, "audit.log"), "utf8");
    for (const value of forbiddenValues(f, bundleOf(railway.observations[0]!))) {
      expect(text).not.toContain(value);
    }
  });

  it("SIGTERM right after create returns records the sandbox id, audits it and destroys it", async () => {
    const f = await fixture();
    const before = process.listeners("SIGTERM");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const stderr = captureStderr();
    const railway = fakeRailway();
    let atSignal: unknown;
    let signalled = false;
    // The env-file cleanup runs right after `sandbox create` returned.
    const rmAfterCreate = vi.fn(async (path: string, options: { recursive: true; force: true }) => {
      if (!signalled && railway.observations.length === 1) {
        signalled = true;
        addedListener("SIGTERM", before)("SIGTERM");
        atSignal = readSidecarFile(f);
        await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM"));
      }
      await rm(path, options);
    });

    const failure = (await runtimeFor(f, railway.exec, { fs: { rm: rmAfterCreate } })
      .start(MEMBER, RUN)
      .catch((error: unknown) => error)) as Error;

    expect(failure.message).toMatch(/interrupted by SIGTERM/u);
    expect(atSignal).toEqual(sidecarOf({ state: "orphaned", sandboxId: SANDBOX_ID }));
    expect(railway.calls.filter((call) => call[1] === "destroy")).toEqual([
      ["sandbox", "destroy", SANDBOX_ID],
    ]);
    expect(stderr.join("")).toContain(`railway sandbox destroy ${SANDBOX_ID}`);
    const audit = await readAuditLog(f.home);
    expect(audit.filter((entry) => entry.event === "agent.remote_key_exported")).toEqual([
      expect.objectContaining({ wallet: ALPHA, detail: `runtime=railway sandbox=${SANDBOX_ID}` }),
    ]);
  });

  it("SIGTERM during readiness keeps an orphaned sidecar when the destroy fails", async () => {
    const f = await fixture();
    const before = process.listeners("SIGTERM");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const stderr = captureStderr();
    const railway = fakeRailway({
      ready: async () => {
        addedListener("SIGTERM", before)("SIGTERM");
        await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM"));
        return OK;
      },
      destroy: () => ({ code: 1, stdout: "", stderr: "Error: railway API unavailable" }),
    });

    await expect(runtimeFor(f, railway.exec).start(MEMBER, RUN)).rejects.toThrow(
      /interrupted by SIGTERM/u,
    );

    expect(railway.calls.filter((call) => call[1] === "destroy")).toHaveLength(1);
    expect(readSidecarFile(f)).toEqual(sidecarOf({ state: "orphaned", sandboxId: SANDBOX_ID }));
    expect((await stat(railwaySidecarPath(f.home, RUN_ID))).mode & 0o777).toBe(0o600);
    expect(stderr.join("")).toContain(`railway sandbox destroy ${SANDBOX_ID}`);
    expect(process.listeners("SIGTERM")).toEqual(before);
  });

  it("bounds the destroy after a signal by signalDestroyTimeoutMs", async () => {
    const f = await fixture();
    const before = process.listeners("SIGINT");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    captureStderr();
    const railway = fakeRailway({
      ready: async () => {
        addedListener("SIGINT", before)("SIGINT");
        await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(process.pid, "SIGINT"));
        return OK;
      },
      destroy: () => new Promise<RailwayExecResult>(() => undefined),
    });

    await expect(
      runtimeFor(f, railway.exec, { signalDestroyTimeoutMs: 5 }).start(MEMBER, RUN),
    ).rejects.toThrow(/interrupted by SIGINT/u);
    expect(readSidecarFile(f)).toEqual(sidecarOf({ state: "orphaned", sandboxId: SANDBOX_ID }));
  });

  it("runs the signal cleanup once and restores the listeners after success and failure", async () => {
    const f = await fixture();
    const before = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
    const signalRun = { ...RUN, budgetUsd: "0.10" };

    await runtimeFor(f, fakeRailway().exec).start(MEMBER, signalRun);
    expect(process.listeners("SIGINT")).toEqual(before.SIGINT);
    expect(process.listeners("SIGTERM")).toEqual(before.SIGTERM);

    const failing = fakeRailway({
      create: () => ({ code: 1, stdout: "", stderr: "Error: checkpoint missing" }),
    });
    await expect(
      runtimeFor(f, failing.exec).start(MEMBER, { ...signalRun, runId: PARENT_RUN_ID }),
    ).rejects.toThrow(/railway sandbox create failed/u);
    expect(process.listeners("SIGINT")).toEqual(before.SIGINT);
    expect(process.listeners("SIGTERM")).toEqual(before.SIGTERM);

    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    captureStderr();
    const twice = fakeRailway({
      ready: async () => {
        const listener = addedListener("SIGINT", before.SIGINT);
        listener("SIGINT");
        listener("SIGINT");
        await vi.waitFor(() => expect(kill).toHaveBeenCalled());
        return OK;
      },
    });
    const third = "run_333333333333333333333333";
    await expect(
      runtimeFor(f, twice.exec).start(MEMBER, { ...signalRun, runId: third }),
    ).rejects.toThrow(/interrupted/u);
    expect(twice.calls.filter((call) => call[1] === "destroy")).toHaveLength(1);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(process.listeners("SIGINT")).toEqual(before.SIGINT);
  });
});

describe("railway runtime sidecar during start", () => {
  it("writes a creating sidecar before create, adds the id, then marks it running", async () => {
    const f = await fixture();
    const seen: unknown[] = [];
    const railway = fakeRailway({
      create: () => {
        seen.push(readSidecarFile(f));
        return CREATED;
      },
      ready: () => {
        seen.push(readSidecarFile(f));
        return OK;
      },
    });

    await runtimeFor(f, railway.exec).start(MEMBER, RUN);

    expect(seen).toEqual([sidecarOf(), sidecarOf({ sandboxId: SANDBOX_ID })]);
    expect(readSidecarFile(f)).toEqual(sidecarOf({ state: "running", sandboxId: SANDBOX_ID }));
    expect((await stat(railwaySidecarPath(f.home, RUN_ID))).mode & 0o777).toBe(0o600);
  });

  it("keeps an orphaned sidecar and names the destroy command when exec and destroy both fail", async () => {
    const f = await fixture();
    let bundle = "";
    const railway = fakeRailway({
      create: (observation) => {
        bundle = bundleOf(observation);
        return CREATED;
      },
      detach: () => ({ code: 1, stdout: "", stderr: `exec failed: ${bundle}` }),
      destroy: () => ({ code: 1, stdout: "", stderr: "Error: railway API unavailable" }),
    });

    const failure = (await runtimeFor(f, railway.exec)
      .start(MEMBER, RUN)
      .catch((error: unknown) => error)) as Error;

    expect(failure.message).toContain(`railway sandbox exec ${SANDBOX_ID} failed`);
    expect(failure.message).toContain(`railway sandbox destroy ${SANDBOX_ID}`);
    expect(failure.message).toContain("railway API unavailable");
    for (const value of forbiddenValues(f, bundle)) expect(failure.message).not.toContain(value);
    expect(readSidecarFile(f)).toEqual(sidecarOf({ state: "orphaned", sandboxId: SANDBOX_ID }));
  });

  it("keeps an orphaned sidecar when readiness fails and the destroy fails", async () => {
    const f = await fixture();
    const railway = fakeRailway({
      ready: () => ({ code: 1, stdout: "", stderr: "Error: sandbox is not running yet" }),
      destroy: () => ({ code: 1, stdout: "", stderr: "Error: timeout" }),
    });

    await expect(
      runtimeFor(f, railway.exec, { readyAttempts: 2 }).start(MEMBER, RUN),
    ).rejects.toThrow(`railway sandbox destroy ${SANDBOX_ID}`);
    expect(readSidecarFile(f)).toEqual(sidecarOf({ state: "orphaned", sandboxId: SANDBOX_ID }));
  });
});

describe("railway runtime create failures", () => {
  it("keeps a creating sidecar and warns that a sandbox may exist when create exits non-zero", async () => {
    const f = await fixture();
    const railway = fakeRailway({
      create: () => ({ code: 1, stdout: "", stderr: "Error: request timed out" }),
    });

    const failure = (await runtimeFor(f, railway.exec)
      .start(MEMBER, RUN)
      .catch((error: unknown) => error)) as Error;

    expect(failure.message).toContain("railway sandbox create failed");
    expect(failure.message).toContain(`A sandbox holding ${ALPHA}'s private key may still exist`);
    expect(failure.message).toContain("railway sandbox list");
    expect(readSidecarFile(f)).toEqual(sidecarOf());
  });

  it("keeps a creating sidecar when create throws for another reason", async () => {
    const f = await fixture();
    const railway = fakeRailway({
      create: () => {
        throw new Error("socket hang up");
      },
    });

    const failure = (await runtimeFor(f, railway.exec)
      .start(MEMBER, RUN)
      .catch((error: unknown) => error)) as Error;

    expect(failure.message).toContain("socket hang up");
    expect(failure.message).toContain("railway sandbox list");
    expect(readSidecarFile(f)).toEqual(sidecarOf());
  });

  it("drops the sidecar and reports runtime_unavailable when the railway binary is missing", async () => {
    const f = await fixture();
    const railway = fakeRailway({
      create: () => {
        throw Object.assign(new Error("spawn railway ENOENT"), { code: "ENOENT" });
      },
    });

    const failure = (await runtimeFor(f, railway.exec)
      .start(MEMBER, RUN)
      .catch((error: unknown) => error)) as RuntimeError;

    expect(failure).toBeInstanceOf(RuntimeError);
    expect(failure.code).toBe("runtime_unavailable");
    expect(failure.message).toContain("not installed or not on PATH");
    expect(await exists(railwaySidecarPath(f.home, RUN_ID))).toBe(false);
  });

  it("writes no export audit when the env file is refused before create runs", async () => {
    const f = await fixture();
    const railway = fakeRailway();
    const loose = vi.fn(async (path: string) =>
      path.endsWith("member.env") ? { mode: 0o100644 } : await stat(path),
    );

    const failure = (await runtimeFor(f, railway.exec, { fs: { stat: loose } })
      .start(MEMBER, RUN)
      .catch((error: unknown) => error)) as Error;

    expect(failure.message).toMatch(/env file has mode 644/u);
    expect(railway.exec).not.toHaveBeenCalled();
    expect(await readdir(f.tmp)).toEqual([]);
    expect(await exists(railwaySidecarPath(f.home, RUN_ID))).toBe(false);
    const events = (await readAuditLog(f.home)).map((entry) => entry.event);
    expect(events).not.toContain("agent.remote_key_exported");
  });

  it("writes no export audit when the railway binary is missing", async () => {
    const f = await fixture();
    const railway = fakeRailway({
      create: () => {
        throw Object.assign(new Error("spawn railway ENOENT"), { code: "ENOENT" });
      },
    });

    await runtimeFor(f, railway.exec)
      .start(MEMBER, RUN)
      .catch(() => undefined);

    const events = (await readAuditLog(f.home)).map((entry) => entry.event);
    expect(events).not.toContain("agent.remote_key_exported");
  });

  it("keeps a creating sidecar when the sandbox id is unreadable", async () => {
    const f = await fixture();
    const railway = fakeRailway({
      create: () => ({ code: 0, stdout: "Sandbox created\n", stderr: "" }),
    });

    await expect(runtimeFor(f, railway.exec).start(MEMBER, RUN)).rejects.toThrow(
      /railway sandbox list/u,
    );
    expect(readSidecarFile(f)).toEqual(sidecarOf());
  });

  it.each([
    ["create exits non-zero", { create: () => ({ code: 1, stdout: "", stderr: "Error: boom" }) }],
    [
      "the sandbox id is unreadable",
      { create: () => ({ code: 0, stdout: "Created", stderr: "" }) },
    ],
    ["create succeeds", {}],
  ] as const)(
    "names the env file path, never its content, when it cannot be deleted and %s",
    async (_label, handlers) => {
      const f = await fixture();
      const railway = fakeRailway(handlers);
      const failingRm = vi.fn(async (path: string) => {
        if (path.startsWith(f.tmp)) throw new Error(`EBUSY: resource busy, rm '${path}'`);
      });

      const failure = (await runtimeFor(f, railway.exec, { fs: { rm: failingRm } })
        .start(MEMBER, RUN)
        .catch((error: unknown) => error)) as Error;

      const observation = railway.observations[0]!;
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toContain(observation.path);
      expect(failure.message).toMatch(/Delete it yourself/u);
      for (const value of forbiddenValues(f, bundleOf(observation))) {
        expect(failure.message).not.toContain(value);
      }
    },
  );
});

describe("railway runtime sandbox-gone detection", () => {
  const responses = [
    ["ambiguous unquoted id punctuation", "", `HTTP 404 for ${SANDBOX_ID}.`, false, 1],
    ["unambiguous quoted id punctuation", "", `HTTP 404 for '${SANDBOX_ID}'.`, true, 1],
    ["case-mismatched not-found id", "", `sandbox ${SANDBOX_ID.toUpperCase()} not found`, false, 1],
    ["case-mismatched 404 id", "", `HTTP 404 for ${SANDBOX_ID.toUpperCase()}`, false, 1],
    [
      "wrong project suffix",
      "",
      `sandbox ${SANDBOX_ID} not found in project wrong-project`,
      false,
      1,
    ],
    ["environment suffix", "", `sandbox ${SANDBOX_ID} not found in environment other`, false, 1],
    [
      "404 plus conflicting line",
      "",
      `HTTP 404 for ${SANDBOX_ID}\nError: environment not found`,
      false,
      1,
    ],
    [
      "conflict before proof",
      "",
      `Error: environment not found\nHTTP 404 for ${SANDBOX_ID}`,
      false,
      1,
    ],
    ["stdout scope conflict", "Error: project not found", `HTTP 404 for ${SANDBOX_ID}`, false, 1],
    [
      "stderr scope conflict",
      `HTTP 404 for ${SANDBOX_ID}`,
      "Error: environment not found",
      false,
      1,
    ],
    [
      "stdout auth conflict",
      "Error: unauthorized (401)",
      `sandbox ${SANDBOX_ID} not found`,
      false,
      1,
    ],
    [
      "stdout transport conflict",
      "Error: network error",
      `sandbox ${SANDBOX_ID} not found`,
      false,
      1,
    ],
    ["timeout conflict", `sandbox ${SANDBOX_ID} not found`, "request timed out", false, 1],
    [
      "other sandbox conflict",
      `sandbox ${SANDBOX_ID} not found`,
      "sandbox other-id not found",
      false,
      1,
    ],
    ["token conflict", "Error: token expired", `HTTP 404 for ${SANDBOX_ID}`, false, 1],
    [
      "unverifiable named scope",
      "Project: original-project",
      `sandbox ${SANDBOX_ID} not found`,
      false,
      1,
    ],
    ["clean exact id", "", `sandbox ${SANDBOX_ID} not found`, true, 1],
    ["clean stdout exact id", `sandbox ${SANDBOX_ID} not found`, "", true, 1],
    [
      "clean punctuation and whitespace",
      "  ",
      `  Error: sandbox '${SANDBOX_ID}' was not found.\r\n`,
      true,
      1,
    ],
    [
      "consistent streams",
      `sandbox ${SANDBOX_ID} not found`,
      `HTTP 404 for ${SANDBOX_ID}`,
      true,
      1,
    ],
    ["another id", "", "sandbox another-id not found", false, 1],
    ["no exact id", "", "sandbox not found", false, 1],
    ["timeout", "", "request timed out", false, 1],
    ["401", "", "HTTP 401 Unauthorized", false, 1],
    ["network failure", "", "network error: connection reset", false, 1],
    ["unknown extra line", "try a different project", `sandbox ${SANDBOX_ID} not found`, false, 1],
    ["interrupted process", "", `sandbox ${SANDBOX_ID} not found`, false, null],
  ] as const;
  it.each(
    responses.flatMap(([label, stdout, stderr, gone, code]) =>
      (["stop", "status", "sidecar"] as const).map((route) => ({
        label,
        stdout,
        stderr,
        gone,
        code,
        route,
      })),
    ),
  )(
    "requires whole-response absence proof ($route: $label)",
    async ({ stdout, stderr, gone, code, route }) => {
      const home = await mkdtemp(join(tmpdir(), "vapi-railway-proof-"));
      homes.push(home);
      await mkdir(runsDirectory(home), { recursive: true });
      const path = railwaySidecarPath(home, RUN_ID);
      await writeFile(path, JSON.stringify(sidecarOf({ state: "running", sandboxId: SANDBOX_ID })));
      const response: RailwayExecResult = { code, stdout, stderr };
      const exec = vi.fn<RailwayExec>(async () => response);
      const runtime = createRailwayRuntime({ home, exec });
      if (route === "stop") {
        if (gone) await expect(runtime.stop(handle())).resolves.toBeUndefined();
        else
          await expect(runtime.stop(handle())).rejects.toThrow(
            `railway sandbox destroy ${SANDBOX_ID} failed`,
          );
      } else if (route === "status") {
        await expect(runtime.status(handle())).resolves.toMatchObject({
          state: gone ? "unknown" : "running",
        });
      } else {
        await expect(destroyRailwaySidecar(home, RUN_ID, { exec })).resolves.toMatchObject({
          destroyed: gone,
        });
      }
      expect(await exists(path)).toBe(!gone);
    },
  );

  it.each([
    { label: "empty successful response", stdout: "", stderr: "", succeeded: true },
    {
      label: "explicit destruction",
      stdout: `✓ Destroyed sandbox ${SANDBOX_ID}`,
      stderr: "",
      succeeded: true,
    },
    {
      label: "contradictory successful exit",
      stdout: `✓ Destroyed sandbox ${SANDBOX_ID}`,
      stderr: "Error: environment not found",
      succeeded: false,
    },
    {
      label: "case-mismatched success",
      stdout: `✓ Destroyed sandbox ${SANDBOX_ID.toUpperCase()}`,
      stderr: "",
      succeeded: false,
    },
    {
      label: "ambiguous unquoted success punctuation",
      stdout: `✓ Destroyed sandbox ${SANDBOX_ID}.`,
      stderr: "",
      succeeded: false,
    },
    {
      label: "wrong id success",
      stdout: "✓ Destroyed sandbox another-id",
      stderr: "",
      succeeded: false,
    },
  ])(
    "checks the whole successful destroy response ($label)",
    async ({ stdout, stderr, succeeded }) => {
      const home = await mkdtemp(join(tmpdir(), "vapi-railway-destroy-proof-"));
      homes.push(home);
      const runtime = createRailwayRuntime({
        home,
        exec: async () => ({ code: 0, stdout, stderr }),
      });
      if (succeeded) await expect(runtime.stop(handle())).resolves.toBeUndefined();
      else
        await expect(runtime.stop(handle())).rejects.toThrow(
          `railway sandbox destroy ${SANDBOX_ID} failed`,
        );
    },
  );

  it.each([
    ["bash: railway: command not found", false],
    ["Error: file not found", false],
    ["Error: not found", false],
    ["Error: does not exist", false],
    ["HTTP 404 Not Found", false],
    // Another sandbox, or another thing that is not found, says nothing about this one.
    ["Error: sandbox abc not found", false],
    [`Failed to destroy sandbox ${SANDBOX_ID}: project not found`, false],
    [`Error: sandbox ${SANDBOX_ID}: environment not found`, false],
    ["Error: sandbox token not found", false],
    [`Failed to destroy sandbox ${SANDBOX_ID}: workspace not found`, false],
    [`HTTP 404 for ${SANDBOX_ID}: project not found`, false],
    [`HTTP 404 for ${SANDBOX_ID}0`, false],
    ["Error: Sandbox not found", false],
    [`Error: Sandbox ${SANDBOX_ID} not found`, true],
    [`Error: sandbox '${SANDBOX_ID}' was not found`, true],
    [`HTTP 404 for ${SANDBOX_ID}`, true],
  ] as const)("stop on destroy stderr %j treats the sandbox as gone: %s", async (stderr, gone) => {
    const f = await fixture();
    const railway = fakeRailway({ destroy: () => ({ code: 1, stdout: "", stderr }) });
    const stopping = createRailwayRuntime({ home: f.home, exec: railway.exec }).stop(handle());
    if (gone) await expect(stopping).resolves.toBeUndefined();
    else await expect(stopping).rejects.toThrow(`railway sandbox destroy ${SANDBOX_ID} failed`);
  });

  it("leaves the run record running when stop hits an unrelated failure", async () => {
    const f = await fixture();
    const railway = fakeRailway({
      destroy: () => ({ code: 1, stdout: "", stderr: "Error: request timed out" }),
    });
    const record = await startDetachedRun({
      home: f.home,
      runtime: runtimeFor(f, railway.exec),
      member: MEMBER,
      run: RUN,
      env: {},
    });

    await expect(
      stopRun({ home: f.home, runtime: runtimeFor(f, railway.exec), record }),
    ).rejects.toThrow(/request timed out/u);
    expect((await readRunRecord(f.home, RUN_ID))?.state).toBe("running");
  });

  it("reports running with the error when status hits an unrelated failure", async () => {
    const f = await fixture();
    const railway = fakeRailway({
      cat: () => ({ code: 1, stdout: "", stderr: "Error: command not found" }),
    });

    await expect(
      createRailwayRuntime({ home: f.home, exec: railway.exec }).status(handle()),
    ).resolves.toEqual({
      state: "running",
      detail: `railway sandbox exec ${SANDBOX_ID} failed (exit 1): Error: command not found`,
    });
  });

  it("keeps the run and its sidecar when status hits a not-found for something else", async () => {
    const f = await fixture();
    await mkdir(runsDirectory(f.home), { recursive: true, mode: 0o700 });
    await writeFile(
      railwaySidecarPath(f.home, RUN_ID),
      JSON.stringify(sidecarOf({ state: "running", sandboxId: SANDBOX_ID })),
      { mode: 0o600 },
    );
    const stderr = `Failed to exec in sandbox ${SANDBOX_ID}: project not found`;
    const railway = fakeRailway({ cat: () => ({ code: 1, stdout: "", stderr }) });

    await expect(
      createRailwayRuntime({ home: f.home, exec: railway.exec }).status(handle()),
    ).resolves.toEqual({
      state: "running",
      detail: `railway sandbox exec ${SANDBOX_ID} failed (exit 1): ${stderr}`,
    });
    expect(await exists(railwaySidecarPath(f.home, RUN_ID))).toBe(true);
  });

  it("keeps a finished run running while its sandbox cannot be destroyed", async () => {
    const f = await fixture();
    const railway = fakeRailway({
      cat: () => ({
        code: 0,
        stdout: JSON.stringify({ v: 1, exitCode: 0, result: {} }),
        stderr: "",
      }),
      destroy: () => ({ code: 1, stdout: "", stderr: "Error: request timed out" }),
    });
    await runtimeFor(f, fakeRailway().exec).start(MEMBER, RUN);

    const status = await createRailwayRuntime({ home: f.home, exec: railway.exec }).status(
      handle(),
    );

    expect(status.state).toBe("running");
    expect(status.detail).toMatch(/^finished; sandbox destroy failed: /u);
    expect(status.detail).toContain("request timed out");
    expect(readSidecarFile(f)).toEqual(sidecarOf({ state: "running", sandboxId: SANDBOX_ID }));
  });

  it("marks a kept finished sandbox's sidecar kept", async () => {
    const f = await fixture();
    const railway = fakeRailway({
      cat: () => ({
        code: 0,
        stdout: JSON.stringify({ v: 1, exitCode: 0, result: {} }),
        stderr: "",
      }),
    });
    await runtimeFor(f, railway.exec, { keepSandbox: true }).start(MEMBER, RUN);

    await expect(
      createRailwayRuntime({ home: f.home, exec: railway.exec }).status(handle()),
    ).resolves.toMatchObject({ state: "finished" });
    expect(readSidecarFile(f)).toEqual(
      sidecarOf({ state: "kept", sandboxId: SANDBOX_ID, keepSandbox: true }),
    );
    expect(railway.calls.filter((call) => call[1] === "destroy")).toEqual([]);
  });
});

describe("railway sidecar helpers", () => {
  const OTHER = "run_444444444444444444444444";

  it("lists readable sidecars, reads the legacy shape as running and skips invalid files", async () => {
    const f = await fixture();
    const directory = runsDirectory(f.home);
    await mkdir(directory, { recursive: true });
    const current = sidecarOf({ state: "orphaned", sandboxId: SANDBOX_ID });
    await writeFile(railwaySidecarPath(f.home, RUN_ID), JSON.stringify(current));
    await writeFile(
      railwaySidecarPath(f.home, OTHER),
      JSON.stringify({ v: 1, sandboxId: "sbx_legacy", checkpoint: CHECKPOINT, keepSandbox: true }),
    );
    await writeFile(
      railwaySidecarPath(f.home, PARENT_RUN_ID),
      JSON.stringify({ ...current, runId: PARENT_RUN_ID, state: "exploded" }),
    );
    await writeFile(join(directory, "run_555555555555555555555555.railway.json"), "{not json");
    await writeFile(
      join(directory, "run_666666666666666666666666.railway.json"),
      JSON.stringify({ ...current, runId: OTHER }),
    );

    const listed = await listRailwaySidecars(f.home);

    expect(listed.sort((a, b) => a.runId.localeCompare(b.runId))).toEqual([
      current,
      {
        v: 1,
        runId: OTHER,
        account: "",
        swarm: "",
        state: "running",
        sandboxId: "sbx_legacy",
        checkpoint: CHECKPOINT,
        keepSandbox: true,
      },
    ]);
    await expect(listRailwaySidecars(join(f.home, "missing"))).resolves.toEqual([]);
  });

  it("destroys an orphaned sandbox and deletes its sidecar", async () => {
    const f = await fixture();
    await mkdir(runsDirectory(f.home), { recursive: true });
    await writeFile(
      railwaySidecarPath(f.home, RUN_ID),
      JSON.stringify(sidecarOf({ state: "orphaned", sandboxId: SANDBOX_ID })),
    );
    const railway = fakeRailway();

    await expect(destroyRailwaySidecar(f.home, RUN_ID, { exec: railway.exec })).resolves.toEqual({
      runId: RUN_ID,
      sandboxId: SANDBOX_ID,
      destroyed: true,
    });
    expect(railway.calls).toEqual([["sandbox", "destroy", SANDBOX_ID]]);
    expect(await exists(railwaySidecarPath(f.home, RUN_ID))).toBe(false);
  });

  it("deletes the sidecar of a sandbox that is clearly gone", async () => {
    const f = await fixture();
    await mkdir(runsDirectory(f.home), { recursive: true });
    await writeFile(
      railwaySidecarPath(f.home, RUN_ID),
      JSON.stringify(sidecarOf({ state: "orphaned", sandboxId: SANDBOX_ID })),
    );
    const railway = fakeRailway({ destroy: () => SANDBOX_GONE });

    await expect(
      destroyRailwaySidecar(f.home, RUN_ID, { exec: railway.exec }),
    ).resolves.toMatchObject({ destroyed: true });
    expect(await exists(railwaySidecarPath(f.home, RUN_ID))).toBe(false);
  });

  it("keeps an orphaned sidecar with the destroy command when the destroy fails", async () => {
    const f = await fixture();
    await mkdir(runsDirectory(f.home), { recursive: true });
    await writeFile(
      railwaySidecarPath(f.home, RUN_ID),
      JSON.stringify(sidecarOf({ state: "running", sandboxId: SANDBOX_ID })),
    );
    const railway = fakeRailway({
      destroy: () => ({ code: 1, stdout: "", stderr: "Error: request timed out" }),
    });

    const outcome = await destroyRailwaySidecar(f.home, RUN_ID, { exec: railway.exec });

    expect(outcome).toMatchObject({ runId: RUN_ID, sandboxId: SANDBOX_ID, destroyed: false });
    expect(outcome.error).toContain(`railway sandbox destroy ${SANDBOX_ID}`);
    expect(outcome.error).toContain("request timed out");
    expect(readSidecarFile(f)).toEqual(sidecarOf({ state: "orphaned", sandboxId: SANDBOX_ID }));
  });

  it("keeps a sidecar without a sandbox id and points at railway sandbox list", async () => {
    const f = await fixture();
    await mkdir(runsDirectory(f.home), { recursive: true });
    await writeFile(railwaySidecarPath(f.home, RUN_ID), JSON.stringify(sidecarOf()));
    const railway = fakeRailway();

    const outcome = await destroyRailwaySidecar(f.home, RUN_ID, { exec: railway.exec });

    expect(outcome).toMatchObject({ runId: RUN_ID, destroyed: false });
    expect(outcome.sandboxId).toBeUndefined();
    expect(outcome.error).toContain("railway sandbox list");
    expect(outcome.error).toContain("railway sandbox destroy <id>");
    expect(railway.exec).not.toHaveBeenCalled();
    expect(readSidecarFile(f)).toEqual(sidecarOf());
  });
});

describe("railway runtime default executor", () => {
  it("runs a process with stdin closed and reports its exit code and output", async () => {
    await expect(
      defaultRailwayExec(process.execPath, [
        "-e",
        "process.stdout.write('out');process.stderr.write('err');process.exit(3)",
      ]),
    ).resolves.toEqual({ code: 3, stdout: "out", stderr: "err" });
  });

  // Opt-in only: runs the real `railway` CLI against the account it is logged
  // into. Never runs in CI. Manual sequence it mirrors:
  //   railway login                      (or export RAILWAY_API_TOKEN=…)
  //   railway sandbox create --json      -> note the id
  //   railway sandbox exec <id> -- npm i -g @vapi-network/cli
  //   railway sandbox checkpoint create <id> <name>
  //   railway sandbox destroy <id>
  //   VAPI_RAILWAY_SMOKE=1 VAPI_RAILWAY_CHECKPOINT=<name> \
  //     pnpm --filter @vapi-network/cli exec vitest run src/runtime-railway.test.ts -t smoke
  // It boots a sandbox from the checkpoint with a harmless env file, checks the
  // id parses and `vapi` answers, and destroys the sandbox.
  it.skipIf(process.env.VAPI_RAILWAY_SMOKE !== "1")(
    "smoke: boots, execs and destroys a real sandbox",
    async () => {
      const checkpoint = process.env.VAPI_RAILWAY_CHECKPOINT;
      if (checkpoint === undefined)
        throw new Error("Set VAPI_RAILWAY_CHECKPOINT for the smoke test.");
      const directory = await mkdtemp(join(tmpdir(), "vapi-railway-smoke-"));
      homes.push(directory);
      const envFile = join(directory, "smoke.env");
      await writeFile(envFile, "VAPI_SMOKE=1\n", { mode: 0o600 });
      const created = await defaultRailwayExec(
        RAILWAY_CLI.binary,
        RAILWAY_CLI.create({ checkpoint, envFile, idleTimeoutMinutes: 5 }),
      );
      expect(created.code).toBe(0);
      const id = parseSandboxId(created.stdout);
      try {
        const help = await defaultRailwayExec(
          RAILWAY_CLI.binary,
          RAILWAY_CLI.exec(id, ["vapi", "version"], false),
        );
        expect(help.code).toBe(0);
      } finally {
        await defaultRailwayExec(RAILWAY_CLI.binary, RAILWAY_CLI.destroy(id));
      }
    },
    120_000,
  );
});
