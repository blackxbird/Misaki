import {
  activeAgentMarker,
  ARC_MAINNET_CAIP2,
  BASE_MAINNET_CAIP2,
  SWARM_ROLE_PATTERN,
  addSwarmMember,
  assertWalletName,
  createPublicFetch,
  createRunId,
  dissolveSwarm,
  formatUsdc,
  fundSwarm,
  getDefaultConfig,
  getVapiPaths,
  isMissingFile,
  isRunId,
  leaveSwarm,
  loadConfig,
  rebalanceSwarm,
  readSwarm,
  setupSwarm,
  SwarmError,
  swarmStatus,
  usdToAtomic,
  writeJsonAtomic,
  type AccountLinkOutcome,
  type SwarmCapitalDeps,
  type SwarmLegResult,
  type SwarmMovementResult,
  type SwarmSetupResult,
  type SwarmStrategy,
  type VapiConfig,
} from "@vapi-network/core";
import {
  assessSwarmMembers,
  listRunRecords,
  redactRunText,
  refreshRunRecord,
  runSwarm,
  RuntimeError,
  startDetachedSwarmRun,
  stopRun,
  summarizeRunRecord,
  type AgentEvent,
  type DetachedRunSummary,
  type RunRecord,
  type SwarmRunMemberResult,
  type SwarmRunMode,
  type SwarmRunResult,
} from "@vapi-network/mcp";

import { buildAgentRunDeps } from "./agent.js";
import {
  UsageError,
  confirmWalletName,
  getEnvironment,
  getSecretStore,
  isStdinInteractive,
  openWalletStore,
  parseArguments,
  recordAudit,
  redactDetachedRunValue,
  registryBaseUrl,
  requiredPositional,
  unlockTarget,
  type CliDependencies,
  type CliIo,
} from "./cli.js";
import { parseRuntimeKind, resolveRuntime } from "./runtime-local.js";
import {
  agentMarkerRefusal,
  assertRemoteBalance,
  assertRemoteSafeMember,
  destroyRailwaySidecar,
  listRailwaySidecars,
  ownerBalanceReader,
  RAILWAY_CHECKPOINT_PATTERN,
  RAILWAY_CHECKPOINT_RULE,
  RemoteKeyRefusedError,
  type RailwaySidecar,
} from "./runtime-railway.js";

const SWARM_USAGE =
  "Usage: vapi swarm [create|add|remove|fund|rebalance|status|dissolve|run|runs|stop] …";
const CREATE_USAGE =
  "Usage: vapi swarm create <name> [--agents <n>|--roles <a,b,c>] [--fund <usd> --from <account>] [--strategy <targets|even|weights>] [--targets <role=usd,...>] [--caps <perCall>/<perDay>] [--treasury-caps <perCall>/<perDay>] [--network <base|arc>] [--model <id>] [--no-wait] [--json]";
const ADD_USAGE = "Usage: vapi swarm add <name> <role> [--json]";
const REMOVE_USAGE = "Usage: vapi swarm remove <name> <member> [--json]";
const FUND_USAGE = "Usage: vapi swarm fund <name> <usd> [--from <account>] [--json]";
const REBALANCE_USAGE = "Usage: vapi swarm rebalance <name> [--targets <role=usd,...>] [--json]";
const STATUS_USAGE = "Usage: vapi swarm status <name> [--json]";
const DISSOLVE_USAGE = "Usage: vapi swarm dissolve <name> [--json]";
const RUN_USAGE =
  'Usage: vapi swarm run <name> "<task>" [--mode lead|each] [--lead <member>] [--budget <usd>] [--draw <usd>] [--detach] [--runtime local|railway] [--result-file <path>] [--json]\n       vapi swarm run <name> "<task>" --mode each --runtime railway --checkpoint <name> --allow-remote-key [--budget <usd>] [--keep-sandbox] [--json]';
/** Told to the owner, in these words, before any member key leaves this machine. */
const REMOTE_KEY_WARNING =
  "A leaked member key can spend that member's whole balance. Revoking the link stops Router and relays, but not x402 payments the key signs itself.";
const RUNS_USAGE = "Usage: vapi swarm runs <name> [--json]";
const STOP_USAGE =
  "Usage: vapi swarm stop <name> [<runId>|--all] [--confirm-worker-stopped] [--json]";

export async function swarmCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const subcommand = argv[0];
  const rest = argv.slice(1);
  switch (subcommand) {
    case "create":
      return await createCommand(rest, json, io, dependencies);
    case "add":
      return await addCommand(rest, json, io, dependencies);
    case "remove":
      return await removeCommand(rest, json, io, dependencies);
    case "fund":
      return await fundCommand(rest, json, io, dependencies);
    case "rebalance":
      return await rebalanceCommand(rest, json, io, dependencies);
    case "status":
      return await statusCommand(rest, json, io, dependencies);
    case "dissolve":
      return await dissolveCommand(rest, json, io, dependencies);
    case "run":
      return await runCommand(rest, json, io, dependencies);
    case "runs":
      return await runsCommand(rest, json, io, dependencies);
    case "stop":
      return await stopCommand(rest, json, io, dependencies);
    default:
      throw new UsageError(
        subcommand === undefined
          ? SWARM_USAGE
          : `Unknown swarm subcommand ${JSON.stringify(subcommand)}. ${SWARM_USAGE}`,
      );
  }
}

async function createCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set([
      "--agents",
      "--roles",
      "--fund",
      "--from",
      "--strategy",
      "--targets",
      "--caps",
      "--treasury-caps",
      "--network",
      "--model",
    ]),
    booleanOptions: new Set(["--no-wait"]),
    maximumPositionals: 1,
  });
  const name = requiredPositional(parsed.positionals[0], "<name>", CREATE_USAGE);
  const agentsValue = parsed.one("--agents");
  const rolesValue = parsed.one("--roles");
  if (agentsValue !== undefined && rolesValue !== undefined) {
    throw new UsageError(`--agents and --roles cannot be used together.\n${CREATE_USAGE}`);
  }
  const fundAmount = parsed.one("--fund");
  const fromValue = parsed.one("--from");
  if (fundAmount !== undefined && fromValue === undefined) {
    throw new UsageError(`--fund requires --from <account>.\n${CREATE_USAGE}`);
  }
  if (fundAmount === undefined && fromValue !== undefined) {
    throw new UsageError(`--from requires --fund <usd>.\n${CREATE_USAGE}`);
  }

  const agents = parseAgents(agentsValue, CREATE_USAGE);
  const roles = parseRoles(rolesValue, CREATE_USAGE);
  const strategy = parseStrategy(parsed.one("--strategy"), CREATE_USAGE);
  const targetsUsd = parseTargets(parsed.one("--targets"), CREATE_USAGE);
  const caps = parseCaps(parsed.one("--caps"), "--caps", CREATE_USAGE);
  const treasuryCaps = parseCaps(parsed.one("--treasury-caps"), "--treasury-caps", CREATE_USAGE);
  const network = parseNetwork(parsed.one("--network"), CREATE_USAGE);
  if (fundAmount !== undefined) assertPositiveCents(fundAmount, "--fund", CREATE_USAGE);
  const from = fromValue === undefined ? undefined : assertWalletName(fromValue);
  const context = await commandContext(dependencies, io);
  const awaitApproval = !parsed.has("--no-wait");
  const setup = await setupSwarm({
    store: context.store,
    secrets: context.secrets,
    apiBase: context.apiBase,
    name,
    surface: "cli",
    awaitApproval,
    ...(agents === undefined ? {} : { agents }),
    ...(roles === undefined ? {} : { roles }),
    ...(strategy === undefined ? {} : { strategy }),
    ...(targetsUsd === undefined ? {} : { targetsUsd }),
    ...(caps === undefined ? {} : { caps }),
    ...(treasuryCaps === undefined ? {} : { treasuryCaps }),
    ...(network === undefined ? {} : { network }),
    ...(parsed.one("--model") === undefined ? {} : { model: parsed.one("--model")! }),
    ...(context.fetchImpl === undefined ? {} : { fetchImpl: context.fetchImpl }),
    ...(dependencies.agentLink?.startDeviceLink === undefined
      ? {}
      : { startDeviceLink: dependencies.agentLink.startDeviceLink }),
    ...(dependencies.agentLink?.pollDeviceLink === undefined
      ? {}
      : { pollDeviceLink: dependencies.agentLink.pollDeviceLink }),
    sleep: referencedSleep,
    env: getEnvironment(dependencies),
    ...(dependencies.hostname === undefined ? {} : { hostname: dependencies.hostname() }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
  const links = await finishSetup(setup, awaitApproval, json, io);
  let fund: Awaited<ReturnType<typeof fundSwarm>> | undefined;
  if (fundAmount !== undefined && from !== undefined) {
    fund = await fundSwarm(
      { name, amountUsd: fundAmount, from, setup: true },
      capitalDependencies(context, dependencies),
    );
    setup.swarm = await readSwarm(context.store.home, name);
  }
  if (json) {
    const { completions: _completions, ...safeSetup } = setup;
    void _completions;
    io.stdout(JSON.stringify({ ...safeSetup, links, ...(fund === undefined ? {} : { fund }) }));
  } else if (fund !== undefined) {
    printCapitalResult(fund, io);
  }
  const linksComplete = links.every((link) => link.linked);
  return linksComplete && (fund === undefined || fundComplete(fund)) ? 0 : 1;
}

async function addCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseArguments(argv, { valueOptions: new Set(), maximumPositionals: 2 });
  const name = requiredPositional(parsed.positionals[0], "<name>", ADD_USAGE);
  const role = requiredPositional(parsed.positionals[1], "<role>", ADD_USAGE);
  if (!SWARM_ROLE_PATTERN.test(role)) {
    throw new UsageError(`Invalid <role>.\n${ADD_USAGE}`);
  }
  const context = await commandContext(dependencies, io);
  const setup = await addSwarmMember({
    store: context.store,
    secrets: context.secrets,
    apiBase: context.apiBase,
    name,
    role,
    surface: "cli",
    ...(context.fetchImpl === undefined ? {} : { fetchImpl: context.fetchImpl }),
    ...(dependencies.agentLink?.startDeviceLink === undefined
      ? {}
      : { startDeviceLink: dependencies.agentLink.startDeviceLink }),
    ...(dependencies.agentLink?.pollDeviceLink === undefined
      ? {}
      : { pollDeviceLink: dependencies.agentLink.pollDeviceLink }),
    sleep: referencedSleep,
    env: getEnvironment(dependencies),
    ...(dependencies.hostname === undefined ? {} : { hostname: dependencies.hostname() }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
  const links = await finishSetup(setup, true, json, io);
  if (json) {
    const { completions: _completions, ...safeSetup } = setup;
    void _completions;
    io.stdout(JSON.stringify({ ...safeSetup, links }));
  }
  return links.every((link) => link.linked) ? 0 : 1;
}

async function removeCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseArguments(argv, { valueOptions: new Set(), maximumPositionals: 2 });
  const name = requiredPositional(parsed.positionals[0], "<name>", REMOVE_USAGE);
  const member = assertWalletName(
    requiredPositional(parsed.positionals[1], "<member>", REMOVE_USAGE),
  );
  const context = await commandContext(dependencies, io);
  const result = await leaveSwarm({ name, member }, capitalDependencies(context, dependencies));
  outputCapital(result, json, io);
  return result.status === "left" ? 0 : 1;
}

async function fundCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--from"]),
    maximumPositionals: 2,
  });
  const name = requiredPositional(parsed.positionals[0], "<name>", FUND_USAGE);
  const amountUsd = requiredPositional(parsed.positionals[1], "<usd>", FUND_USAGE);
  assertPositiveCents(amountUsd, "<usd>", FUND_USAGE);
  const fromValue = parsed.one("--from");
  const context = await commandContext(dependencies, io);
  const result = await fundSwarm(
    {
      name,
      amountUsd,
      ...(fromValue === undefined ? {} : { from: assertWalletName(fromValue) }),
    },
    capitalDependencies(context, dependencies),
  );
  outputCapital(result, json, io);
  return fundComplete(result) ? 0 : 1;
}

async function rebalanceCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--targets"]),
    maximumPositionals: 1,
  });
  const name = requiredPositional(parsed.positionals[0], "<name>", REBALANCE_USAGE);
  const targetsUsd = parseTargets(parsed.one("--targets"), REBALANCE_USAGE);
  const context = await commandContext(dependencies, io);
  const result = await rebalanceSwarm(
    { name, ...(targetsUsd === undefined ? {} : { targetsUsd }) },
    capitalDependencies(context, dependencies),
  );
  outputCapital(result, json, io);
  return result.status === "balanced" ||
    result.status === "sent" ||
    (result.status === "resumed" &&
      result.movement?.legs.every((leg) => leg.status === "sent") === true)
    ? 0
    : 1;
}

async function statusCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseArguments(argv, { valueOptions: new Set(), maximumPositionals: 1 });
  const name = requiredPositional(parsed.positionals[0], "<name>", STATUS_USAGE);
  const context = await commandContext(dependencies, io);
  const result = await swarmStatus({
    store: context.store,
    name,
    config: context.config,
    ...(dependencies.swarm?.balanceReader === undefined
      ? {}
      : { balanceReader: dependencies.swarm.balanceReader }),
    ...(context.fetchImpl === undefined ? {} : { fetchImpl: context.fetchImpl }),
  });
  const runs = await runningSwarmRuns(context.store.home, name, dependencies);
  if (json) io.stdout(JSON.stringify({ ...result, runs }));
  else printStatus(result, io, runs);
  return 0;
}

async function dissolveCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseArguments(argv, { valueOptions: new Set(), maximumPositionals: 1 });
  const name = requiredPositional(parsed.positionals[0], "<name>", DISSOLVE_USAGE);
  const context = await commandContext(dependencies, io);
  const result = await dissolveSwarm({ name }, capitalDependencies(context, dependencies));
  outputCapital(result, json, io);
  return result.status === "dissolved" ? 0 : 1;
}

/**
 * `swarm runs` and `swarm stop` need a known swarm, or one whose file is gone
 * while its runs or railway sandboxes are still tracked here, so a sandbox
 * holding a member key stays reachable after the swarm file is.
 */
async function assertSwarmReachable(home: string, name: string): Promise<void> {
  try {
    await readSwarm(home, name);
  } catch (error) {
    if (!(error instanceof SwarmError && error.code === "swarm_not_found")) throw error;
    const records = await listRunRecords(home, { swarm: name });
    if (records.length > 0) return;
    const sidecars = await listRailwaySidecars(home);
    if (sidecars.some((sidecar) => sidecar.swarm === name)) return;
    throw error;
  }
}

async function runCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set([
      "--mode",
      "--lead",
      "--budget",
      "--draw",
      "--runtime",
      "--result-file",
      "--checkpoint",
    ]),
    booleanOptions: new Set(["--detach", "--allow-remote-key", "--keep-sandbox"]),
    maximumPositionals: 2,
  });
  const name = requiredPositional(parsed.positionals[0], "<name>", RUN_USAGE);
  const task = requiredPositional(parsed.positionals[1], "<task>", RUN_USAGE);
  const mode = parseRunMode(parsed.one("--mode"));
  const leadValue = parsed.one("--lead");
  const budgetUsd = parsed.one("--budget");
  const drawUsd = parsed.one("--draw");
  const runtimeValue = parsed.one("--runtime");
  const resultFile = parsed.one("--result-file");
  const railway = runtimeValue !== undefined && parseRuntimeKind(runtimeValue) === "railway";
  // A railway run is always a background run.
  const detached = parsed.has("--detach") || railway;
  const allowRemoteKey = parsed.has("--allow-remote-key");
  const keepSandbox = parsed.has("--keep-sandbox");
  const checkpointValue = parsed.one("--checkpoint");
  if (budgetUsd !== undefined) assertPositiveCents(budgetUsd, "--budget", RUN_USAGE);
  if (drawUsd !== undefined) assertPositiveCents(drawUsd, "--draw", RUN_USAGE);
  if (runtimeValue !== undefined && !detached) {
    throw new UsageError(`--runtime requires --detach.\n${RUN_USAGE}`);
  }
  if (!railway && (checkpointValue !== undefined || allowRemoteKey || keepSandbox)) {
    throw new UsageError(
      `--checkpoint, --allow-remote-key and --keep-sandbox need --runtime railway.\n${RUN_USAGE}`,
    );
  }
  let checkpoint: RailwayCheckpoint | undefined;
  if (railway) {
    // Refused before any file, key or sandbox is touched.
    if (!allowRemoteKey) {
      throw new RemoteKeyRefusedError(
        "remote_key_not_allowed",
        `The railway runtime sends each member's own private key into its sandbox. ${REMOTE_KEY_WARNING} Pass --allow-remote-key to allow it.`,
      );
    }
    if (mode !== "each") {
      throw new UsageError(`the railway runtime only runs --mode each.\n${RUN_USAGE}`);
    }
    // The export-key kill switch: VAPI_NO_SECRETS or an agent/CI marker refuses
    // every remote key export, even with --allow-remote-key off a terminal.
    const marker = activeAgentMarker(getEnvironment(dependencies));
    if (marker !== undefined) {
      await recordAudit(dependencies, "agent.remote_key_refused", {
        detail: `refused: swarm=${name} ${marker} is set.`,
      });
      throw agentMarkerRefusal(marker);
    }
    const source = checkpointValue === undefined ? "VAPI_RAILWAY_CHECKPOINT" : "--checkpoint";
    const checkpointName = (
      checkpointValue ?? getEnvironment(dependencies).VAPI_RAILWAY_CHECKPOINT
    )?.trim();
    if (checkpointName === undefined || checkpointName === "") {
      throw new UsageError(
        `The railway runtime needs a sandbox checkpoint: pass --checkpoint <name> or set VAPI_RAILWAY_CHECKPOINT.\n${RUN_USAGE}`,
      );
    }
    if (!RAILWAY_CHECKPOINT_PATTERN.test(checkpointName)) {
      throw new UsageError(`${source} must be ${RAILWAY_CHECKPOINT_RULE}.\n${RUN_USAGE}`);
    }
    checkpoint = { name: checkpointName, source };
  }
  if (detached && resultFile !== undefined) {
    throw new UsageError(`--detach and --result-file cannot be used together.\n${RUN_USAGE}`);
  }
  const environment = getEnvironment(dependencies);
  const environmentRunId = environment.VAPI_RUN_ID;
  if (environmentRunId !== undefined && !isRunId(environmentRunId)) {
    throw new UsageError("VAPI_RUN_ID must match run_<24 lowercase hexadecimal characters>.");
  }
  const context = await commandContext(dependencies, io);
  if (detached) {
    const confirmedMembers =
      railway && checkpoint !== undefined
        ? await confirmRemoteMembers(name, checkpoint, context, io, dependencies)
        : undefined;
    const runtime = railway
      ? resolveRuntime("railway", context.store.home, dependencies, {
          ...(checkpoint === undefined ? {} : { checkpoint: checkpoint.name }),
          allowRemoteKey,
          keepSandbox,
          confirmedMembers: confirmedMembers ?? [],
        })
      : resolveRuntime(parseRuntimeKind(runtimeValue), context.store.home, dependencies);
    let useEnvironmentRunId = environmentRunId !== undefined;
    const result = await startDetachedSwarmRun(
      {
        name,
        task,
        mode,
        ...(leadValue === undefined ? {} : { lead: assertWalletName(leadValue) }),
        ...(budgetUsd === undefined ? {} : { budgetUsd }),
        ...(drawUsd === undefined ? {} : { drawUsd }),
      },
      {
        home: context.store.home,
        store: context.store,
        runtime,
        env: environment,
        ...(environmentRunId === undefined
          ? {}
          : {
              newRunId: () => {
                if (!useEnvironmentRunId) return createRunId();
                useEnvironmentRunId = false;
                return environmentRunId;
              },
            }),
        ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      },
    );
    if (json) io.stdout(JSON.stringify(result));
    else printDetachedRunResult(name, result, io);
    return result.runs.length > 0 ? 0 : 1;
  }

  const execute = dependencies.swarm?.runSwarm ?? runSwarm;
  const eventOutput = json ? io.stderr : io.stdout;
  const executed = await execute(
    {
      name,
      task,
      mode,
      ...(leadValue === undefined ? {} : { lead: assertWalletName(leadValue) }),
      ...(budgetUsd === undefined ? {} : { budgetUsd }),
      ...(drawUsd === undefined ? {} : { drawUsd }),
      ...(environmentRunId === undefined ? {} : { runId: environmentRunId }),
    },
    {
      home: context.store.home,
      store: context.store,
      capital: capitalDependencies(context, dependencies),
      async status(statusName) {
        return await swarmStatus({
          store: context.store,
          name: statusName,
          config: context.config,
          ...(dependencies.swarm?.balanceReader === undefined
            ? {}
            : { balanceReader: dependencies.swarm.balanceReader }),
          fetchImpl: context.fetchImpl,
        });
      },
      async depsForMember(member, runOptions) {
        return await buildAgentRunDeps({
          profile: runOptions.profile,
          runId: runOptions.runId,
          budget: runOptions.budget,
          runMeta: runOptions.runMeta,
          approvals: runOptions.approvals,
          onEvent: (event) => {
            const message = formatSwarmEvent(event);
            if (message !== undefined) eventOutput(`${member.account}: ${message}`);
          },
          json,
          io,
          dependencies,
        });
      },
    },
  );
  const result =
    resultFile === undefined ? executed : redactDetachedRunValue(executed, environment);

  const ran = result.members.filter((member) => member.status !== "skipped");
  const exitCode = ran.length > 0 && ran.every((member) => member.status === "finished") ? 0 : 1;
  if (resultFile !== undefined) {
    await writeJsonAtomic(resultFile, { v: 1, exitCode, result }, { mode: 0o600 });
  }
  if (json) io.stdout(JSON.stringify(result));
  else printRunResult(result, io);
  return exitCode;
}

type RailwayCheckpoint = { name: string; source: "--checkpoint" | "VAPI_RAILWAY_CHECKPOINT" };

/**
 * The gate in front of a railway start. Every member the run would start must
 * be remote-safe, policy and live balance both, or nothing starts and no key
 * is read. Then the owner is told what a leaked member key can do and which
 * checkpoint the sandboxes boot, and on a terminal types the swarm name.
 * Returns the confirmed member accounts; the runtime refuses any other, and
 * checks each balance again right before that member's key leaves.
 */
async function confirmRemoteMembers(
  name: string,
  checkpoint: RailwayCheckpoint,
  context: CommandContext,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<string[]> {
  const { store } = context;
  const home = store.home;
  const swarm = await readSwarm(home, name);
  const eligible = (await assessSwarmMembers(swarm, { home, store })).flatMap((assessment) =>
    assessment.eligible ? [assessment.target] : [],
  );
  // With no eligible member the start itself reports it, before any key is read.
  if (eligible.length === 0) return [];

  const readBalance =
    dependencies.swarm?.balanceReader ?? ownerBalanceReader(context.config, context.fetchImpl);
  const refusals: RemoteKeyRefusedError[] = [];
  const lines: string[] = [];
  for (const target of eligible) {
    try {
      await assertRemoteSafeMember({
        home,
        member: {
          swarm: swarm.name,
          account: target.account,
          profile: target.account,
          role: target.role,
        },
        mode: "agent",
        store,
        allowRemoteKey: true,
      });
      const address = await store.readAddress(target.account);
      if (address === undefined) throw new Error(`${target.account} has no address in the vault.`);
      await assertRemoteBalance({
        account: target.account,
        address,
        network: swarm.network,
        swarm: swarm.name,
        readBalance,
      });
    } catch (error) {
      if (!(error instanceof RemoteKeyRefusedError)) throw error;
      refusals.push(error);
      lines.push(`${target.account}: ${error.message}`);
      await recordAudit(dependencies, "agent.remote_key_refused", {
        wallet: target.account,
        detail: `refused: ${error.code} swarm=${name}`,
      });
    }
  }
  if (refusals.length > 0) {
    throw new RemoteKeyRefusedError(
      refusals[0]!.code,
      [
        `Swarm ${name} cannot run on Railway. Nothing was started and no key left this machine.`,
        ...lines,
      ].join("\n"),
    );
  }

  io.stderr(
    [
      `Running swarm ${name} on Railway sends each member's own private key into its own sandbox: ${eligible.map((target) => target.account).join(", ")}.`,
      "The recovery phrase and the treasury key stay on this machine.",
      REMOTE_KEY_WARNING,
      `Checkpoint: ${checkpoint.name} (from ${checkpoint.source})`,
    ].join("\n"),
  );
  if (isStdinInteractive(dependencies)) {
    await confirmWalletName(
      name,
      `Type ${name} to send these member keys to Railway: `,
      "That is not the swarm name. Nothing was started and no key left this machine.",
      dependencies,
    );
  }
  return eligible.map((target) => target.account);
}

async function runsCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseArguments(argv, { valueOptions: new Set(), maximumPositionals: 1 });
  const name = requiredPositional(parsed.positionals[0], "<name>", RUNS_USAGE);
  const context = await commandContext(dependencies, io);
  await assertSwarmReachable(context.store.home, name);
  const records = await refreshedSwarmRecords(context.store.home, name, dependencies);
  const runs = records.map(summarizeRunRecord);
  const sandboxes = (await strandedSandboxes(context.store.home, name, records)).map(
    summarizeSandbox,
  );
  const warnings = runs.filter(
    (run) => (run.state === "starting" || run.state === "running") && run.detail !== undefined,
  );
  if (json) io.stdout(JSON.stringify({ swarm: name, runs, sandboxes }));
  else {
    printRunTable(runs, io);
    if (sandboxes.length > 0) printSandboxTable(sandboxes, io);
    for (const run of warnings) {
      io.stderr(
        run.state === "starting"
          ? `WARNING: ${run.runId} could not finish starting: ${run.detail}`
          : `WARNING: ${run.runId} is still running because cleanup failed: ${run.detail}. Stop it with: vapi swarm stop ${name} ${run.runId}`,
      );
    }
  }
  return warnings.length > 0 ? 1 : 0;
}

async function stopCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(),
    booleanOptions: new Set(["--all", "--confirm-worker-stopped"]),
    maximumPositionals: 2,
  });
  const name = requiredPositional(parsed.positionals[0], "<name>", STOP_USAGE);
  const runId = parsed.positionals[1];
  const all = parsed.has("--all");
  const confirmWorkerStopped = parsed.has("--confirm-worker-stopped");
  if ((runId === undefined) === !all) {
    throw new UsageError(`Provide exactly one of <runId> or --all.\n${STOP_USAGE}`);
  }
  if (all && confirmWorkerStopped) {
    throw new UsageError(`--confirm-worker-stopped requires one <runId>.\n${STOP_USAGE}`);
  }

  const context = await commandContext(dependencies, io);
  const home = context.store.home;
  await assertSwarmReachable(home, name);
  const records = await listRunRecords(home, { swarm: name });
  let targets: RunRecord[];
  if (all) {
    targets = records;
  } else {
    const target = isRunId(runId!) ? records.find((record) => record.runId === runId) : undefined;
    // A run with only a sidecar left (its sandbox orphaned) is still stoppable.
    const sidecar =
      target === undefined && isRunId(runId!)
        ? (await listRailwaySidecars(home)).find(
            (candidate) => candidate.runId === runId && candidate.swarm === name,
          )
        : undefined;
    if (target === undefined && sidecar === undefined) {
      throw new RuntimeError("run_not_found", `Run ${runId} was not found for swarm ${name}.`);
    }
    targets = target === undefined ? [] : [target];
  }

  const environment = getEnvironment(dependencies);
  const stopped: DetachedRunSummary[] = [];
  const unchanged: DetachedRunSummary[] = [];
  const failed: StopFailure[] = [];
  for (const record of targets) {
    if (record.state !== "starting" && record.state !== "running") {
      unchanged.push(summarizeRunRecord(record));
      continue;
    }
    const runtime = resolveRuntime(record.kind, home, dependencies);
    let updated: RunRecord;
    try {
      updated = await stopRun({
        home,
        runtime,
        record,
        ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
        ...(confirmWorkerStopped ? { confirmWorkerStopped: true } : {}),
      });
    } catch (error) {
      // The record stays running; the other runs are still stopped.
      failed.push({
        runId: record.runId,
        member: record.member.account,
        error: redactRunText(error instanceof Error ? error.message : String(error), environment),
      });
      continue;
    }
    (updated.state === "stopped" ? stopped : unchanged).push(summarizeRunRecord(updated));
  }

  // Sandboxes no running record tracks: orphaned, still creating, or kept.
  const stranded = (
    await strandedSandboxes(home, name, await listRunRecords(home, { swarm: name }))
  ).filter((sidecar) => all || sidecar.runId === runId);
  const sandboxes: SandboxDestroyResult[] = [];
  for (const sidecar of stranded) {
    const outcome = await destroyRailwaySidecar(home, sidecar.runId, {
      ...(dependencies.railwayExec === undefined ? {} : { exec: dependencies.railwayExec }),
    });
    sandboxes.push(
      outcome.error === undefined
        ? outcome
        : { ...outcome, error: redactRunText(outcome.error, environment) },
    );
  }

  const result = { swarm: name, stopped, unchanged, failed, sandboxes };
  if (json) io.stdout(JSON.stringify(result));
  else printStopResult(result, io);
  return failed.length > 0 || sandboxes.some((sandbox) => !sandbox.destroyed) ? 1 : 0;
}

type StopFailure = { runId: string; member: string; error: string };
type SandboxDestroyResult = Awaited<ReturnType<typeof destroyRailwaySidecar>>;
type SandboxSummary = {
  runId: string;
  member: string;
  state: "orphaned" | "kept";
  sandboxId?: string;
  destroy: string;
};

/**
 * Railway sidecars of this swarm whose sandbox no running record tracks: kept
 * after a finished run, or orphaned (a failed or interrupted destroy, a create
 * that may have gone through, or a start that never recorded its run).
 */
async function strandedSandboxes(
  home: string,
  name: string,
  records: readonly RunRecord[],
): Promise<RailwaySidecar[]> {
  const running = new Set(
    records.filter((record) => record.state === "running").map((record) => record.runId),
  );
  return (await listRailwaySidecars(home)).filter(
    (sidecar) =>
      sidecar.swarm === name && (sidecar.state === "kept" || !running.has(sidecar.runId)),
  );
}

function summarizeSandbox(sidecar: RailwaySidecar): SandboxSummary {
  return {
    runId: sidecar.runId,
    member: sidecar.account,
    state: sidecar.state === "kept" ? "kept" : "orphaned",
    ...(sidecar.sandboxId === undefined ? {} : { sandboxId: sidecar.sandboxId }),
    destroy:
      sidecar.sandboxId === undefined
        ? "railway sandbox list"
        : `railway sandbox destroy ${sidecar.sandboxId}`,
  };
}

type LinkState = { account: string; linked: boolean; reason?: string };

async function finishSetup(
  result: SwarmSetupResult,
  wait: boolean,
  json: boolean,
  io: CliIo,
): Promise<LinkState[]> {
  if (!json) {
    for (const step of result.next) {
      if (step.kind === "caps") {
        io.stdout(`${step.account}: finish caps in the terminal with ${step.command}`);
      } else {
        io.stdout(
          [
            `${step.account}: enter ${step.userCode} at ${step.verificationUri}`,
            `Open: ${step.verificationUriComplete}`,
          ].join("\n"),
        );
      }
    }
  }

  const approvals = result.next.filter((step) => step.kind === "link");
  if (json && wait && approvals.length > 0) {
    // Waiting can last for the full device-code lifetime. Emit a JSON-lines
    // event first so callers can show the codes while they are still usable;
    // the command emits its final result after every completion settles.
    io.stdout(JSON.stringify({ status: "waiting_for_approval", next: approvals }));
  }

  const outcomes = new Map<string, AccountLinkOutcome>();
  if (wait) {
    const pending = [...result.completions];
    const settled = await Promise.allSettled(pending.map(([, completion]) => completion));
    settled.forEach((outcome, index) => {
      const account = pending[index]![0];
      outcomes.set(
        account,
        outcome.status === "fulfilled"
          ? outcome.value
          : { linked: false, reason: "failed", message: "The account link failed." },
      );
    });
  }

  const links = result.members.map((member): LinkState => {
    const outcome = outcomes.get(member.account);
    if (outcome?.linked === true) return { account: member.account, linked: true };
    if (outcome?.linked === false) {
      return { account: member.account, linked: false, reason: outcome.reason };
    }
    return { account: member.account, linked: member.linked };
  });
  if (!json) {
    for (const link of links) {
      io.stdout(
        `${link.account}: ${link.linked ? "linked" : link.reason === undefined ? "pending" : link.reason}`,
      );
    }
  }
  return links;
}

type CommandContext = {
  store: Awaited<ReturnType<typeof openWalletStore>>;
  secrets: ReturnType<typeof getSecretStore>;
  config: VapiConfig;
  apiBase: string;
  fetchImpl: typeof fetch;
};

async function commandContext(dependencies: CliDependencies, io: CliIo): Promise<CommandContext> {
  const store = await openWalletStore(dependencies);
  const configPath = getVapiPaths(store.home).config;
  let config: VapiConfig;
  try {
    config = await loadConfig(configPath, getEnvironment(dependencies), { notice: io.stderr });
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    config = getDefaultConfig(getEnvironment(dependencies));
  }
  return {
    store,
    secrets: getSecretStore(dependencies),
    config,
    apiBase: registryBaseUrl(config),
    fetchImpl:
      dependencies.fetchImpl ??
      createPublicFetch({ allowPrivateNetwork: config.allowPrivateNetwork ?? false }),
  };
}

function capitalDependencies(
  context: CommandContext,
  dependencies: CliDependencies,
): SwarmCapitalDeps {
  const { runSwarm: _runSwarm, ...capitalSeams } = dependencies.swarm ?? {};
  void _runSwarm;
  return {
    store: context.store,
    secrets: context.secrets,
    apiBase: context.apiBase,
    config: context.config,
    fetchImpl: context.fetchImpl,
    unlock: async (name) => {
      const resolved = context.store.resolve({ name, env: {} });
      const address = await context.store.readAddress(resolved.name);
      return (
        await unlockTarget(
          {
            store: context.store,
            ...resolved,
            ...(address === undefined ? {} : { address }),
          },
          dependencies,
        )
      ).account;
    },
    ...(dependencies.now === undefined ? {} : { now: () => dependencies.now!().getTime() }),
    ...capitalSeams,
    reconcileRuns: async ({ home, name }) => {
      await refreshedSwarmRecords(home, name, dependencies);
    },
  };
}

function outputCapital(result: { message: string }, json: boolean, io: CliIo): void {
  if (json) io.stdout(JSON.stringify(result));
  else printCapitalResult(result, io);
}

function printCapitalResult(result: { message: string }, io: CliIo): void {
  io.stdout(result.message);
  const value = result as {
    fund?: SwarmMovementResult;
    policy?: SwarmMovementResult | { movement?: SwarmMovementResult };
    movement?: SwarmMovementResult;
    movements?: SwarmMovementResult[];
  };
  const movements = [
    value.fund,
    value.policy === undefined
      ? undefined
      : "movementId" in value.policy
        ? value.policy
        : value.policy.movement,
    value.movement,
    ...(value.movements ?? []),
  ].filter((movement): movement is SwarmMovementResult => movement !== undefined);
  const legs = movements.flatMap((movement) => movement.legs);
  if (legs.length > 0) printLegs(legs, io);
}

function printLegs(legs: SwarmLegResult[], io: CliIo): void {
  const headings = ["From", "To", "Amount", "Purpose", "Status", "Transaction or reason"];
  const rows = legs.map((leg) => [
    leg.from,
    leg.to,
    `${leg.amountUsd} USDC`,
    leg.purpose,
    leg.status,
    leg.txHash ?? leg.reason ?? (leg.status === "unknown" ? "outcome unknown" : ""),
  ]);
  const widths = headings.map((heading, index) =>
    Math.max(heading.length, ...rows.map((row) => row[index]!.length)),
  );
  const line = (columns: string[]) =>
    columns
      .map((column, index) => column.padEnd(widths[index]!))
      .join("  ")
      .trimEnd();
  io.stdout(line(headings));
  for (const row of rows) io.stdout(line(row));
}

function printStatus(
  result: Awaited<ReturnType<typeof swarmStatus>>,
  io: CliIo,
  runs: readonly DetachedRunSummary[] = [],
): void {
  io.stdout(`Swarm ${result.swarm} (${result.strategy}, ${result.network})`);
  io.stdout(
    `Treasury ${result.treasury.account}: ${result.treasury.balanceUsd} USDC, ${result.treasury.linked ? "linked" : "not linked"}`,
  );
  for (const member of result.members) {
    io.stdout(
      `${member.account} (${member.role}): ${member.balanceUsd} USDC, ${member.linked ? "linked" : "not linked"}, net ${member.netUsd} USDC`,
    );
    for (const run of runs.filter((candidate) => candidate.member === member.account)) {
      io.stdout(`  running: ${run.runId} (${run.mode}, since ${run.startedAt})`);
    }
  }
  for (const movement of result.openMovements) {
    io.stdout(
      `Open movement ${movement.id}: ${movement.pendingLegs} pending, ${movement.unknownLegs} unknown`,
    );
  }
}

async function refreshedSwarmRecords(
  home: string,
  name: string,
  dependencies: CliDependencies,
): Promise<RunRecord[]> {
  const records = await listRunRecords(home, { swarm: name });
  // Status needs no checkpoint and no flag. A finished railway run's sandbox is
  // destroyed here unless it was started with --keep-sandbox.
  const runtimes = new Map<RunRecord["kind"], ReturnType<typeof resolveRuntime>>();
  const refreshed: RunRecord[] = [];
  for (const record of records) {
    let runtime = runtimes.get(record.kind);
    if (runtime === undefined) {
      runtime = resolveRuntime(record.kind, home, dependencies);
      runtimes.set(record.kind, runtime);
    }
    refreshed.push(
      await refreshRunRecord(home, record, runtime, dependencies.now ?? (() => new Date())),
    );
  }
  return refreshed;
}

async function runningSwarmRuns(
  home: string,
  name: string,
  dependencies: CliDependencies,
): Promise<DetachedRunSummary[]> {
  try {
    return (await refreshedSwarmRecords(home, name, dependencies))
      .filter((record) => record.state === "starting" || record.state === "running")
      .map(summarizeRunRecord);
  } catch {
    return [];
  }
}

function printDetachedRunResult(
  name: string,
  result: Awaited<ReturnType<typeof startDetachedSwarmRun>>,
  io: CliIo,
): void {
  for (const run of result.runs) {
    io.stdout(`${run.member}: ${run.runId} started (${run.kind})`);
  }
  for (const skipped of result.skipped) {
    io.stdout(`${skipped.member}: skipped (${skipped.reason})`);
  }
  io.stdout(`Follow with: vapi swarm runs ${name}`);
  io.stdout(`Stop with: vapi swarm stop ${name} --all`);
}

function printRunTable(runs: readonly DetachedRunSummary[], io: CliIo): void {
  const headings = ["MEMBER", "RUN ID", "MODE", "STATE", "STARTED", "ENDED"];
  const rows = runs.map((run) => [
    run.member,
    run.runId,
    run.mode,
    run.state,
    run.startedAt,
    run.endedAt ?? "—",
  ]);
  const widths = headings.map((heading, index) =>
    Math.max(heading.length, ...rows.map((row) => row[index]!.length)),
  );
  const line = (columns: string[]) =>
    columns
      .map((column, index) => column.padEnd(widths[index]!))
      .join("  ")
      .trimEnd();
  io.stdout(line(headings));
  for (const row of rows) io.stdout(line(row));
}

function printSandboxTable(sandboxes: readonly SandboxSummary[], io: CliIo): void {
  const headings = ["MEMBER", "RUN ID", "STATE", "SANDBOX", "DESTROY WITH"];
  const rows = sandboxes.map((sandbox) => [
    sandbox.member,
    sandbox.runId,
    sandbox.state,
    sandbox.sandboxId ?? "unknown",
    sandbox.destroy,
  ]);
  const widths = headings.map((heading, index) =>
    Math.max(heading.length, ...rows.map((row) => row[index]!.length)),
  );
  const line = (columns: string[]) =>
    columns
      .map((column, index) => column.padEnd(widths[index]!))
      .join("  ")
      .trimEnd();
  io.stdout(line(headings));
  for (const row of rows) io.stdout(line(row));
}

function printStopResult(
  result: {
    stopped: DetachedRunSummary[];
    unchanged: DetachedRunSummary[];
    failed: StopFailure[];
    sandboxes: SandboxDestroyResult[];
  },
  io: CliIo,
): void {
  for (const run of result.stopped) io.stdout(`${run.runId}: stopped`);
  for (const run of result.unchanged) io.stdout(`${run.runId}: unchanged (${run.state})`);
  for (const run of result.failed) {
    io.stdout(`${run.runId}: stop failed, still running (${run.member}): ${run.error}`);
  }
  for (const sandbox of result.sandboxes) {
    const id = sandbox.sandboxId ?? "with unknown id";
    io.stdout(
      sandbox.destroyed
        ? `${sandbox.runId}: sandbox ${id} destroyed`
        : `${sandbox.runId}: sandbox ${id} not destroyed: ${sandbox.error ?? "unknown error"}`,
    );
  }
}

function printRunResult(result: SwarmRunResult, io: CliIo): void {
  for (const member of result.members) {
    io.stdout(
      [
        `${member.member} (${member.role}) — ${member.status}`,
        runMemberDetail(member),
        member.spentUsd === null
          ? `spent unknown of $${runUsd(member.budgetUsd)}`
          : `spent $${runUsd(member.spentUsd)} of $${runUsd(member.budgetUsd)}`,
      ].join("\n"),
    );
  }

  const headings = ["MEMBER", "BALANCE", "ALLOCATED IN", "SWEPT OUT", "NET"];
  const rows = result.net.map((member) => [
    member.member,
    `$${member.balanceUsd}`,
    `$${member.allocatedInUsd}`,
    `$${member.sweptOutUsd}`,
    `$${member.netUsd}`,
  ]);
  const widths = headings.map((heading, index) =>
    Math.max(heading.length, ...rows.map((row) => row[index]!.length)),
  );
  const line = (columns: string[]) =>
    columns
      .map((column, index) => column.padEnd(widths[index]!))
      .join("  ")
      .trimEnd();
  io.stdout(line(headings));
  for (const row of rows) io.stdout(line(row));
  io.stdout(`Draw used $${runUsd(result.drawUsedUsd)} of $${runUsd(result.drawLimitUsd)}`);
  if (result.netError !== undefined) io.stdout(`Note: ${result.netError}`);
}

function runMemberDetail(member: SwarmRunMemberResult): string {
  if (member.status === "finished") return member.answer ?? "Finished without an answer.";
  if (member.status === "skipped") return member.reason ?? "skipped";
  return (
    member.stoppedBecause?.detail ?? member.stoppedBecause?.reason ?? member.reason ?? member.status
  );
}

function runUsd(value: number): string {
  return formatUsdc(BigInt(Math.round(value * 1_000_000)));
}

function formatSwarmEvent(event: AgentEvent): string | undefined {
  if (event.type === "tool") return `→ ${event.summary}`;
  if (event.type === "paid") return `✓ paid $${runUsd(event.amountUsd)} on ${event.network}`;
  if (event.type === "declined") return `✗ declined ${event.ref}: ${event.reason}`;
  return undefined;
}

function fundComplete(result: Awaited<ReturnType<typeof fundSwarm>>): boolean {
  if (result.status === "waiting_for_owner" || result.status === "sent") return true;
  return (
    result.status === "resumed" && result.fund?.legs.every((leg) => leg.status === "sent") === true
  );
}

function parseAgents(value: string | undefined, usage: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new UsageError(`--agents must be a positive integer.\n${usage}`);
  }
  return Number(value);
}

function parseRoles(value: string | undefined, usage: string): string[] | undefined {
  if (value === undefined) return undefined;
  const roles = value.split(",").map((role) => role.trim());
  if (roles.length === 0 || roles.some((role) => !SWARM_ROLE_PATTERN.test(role))) {
    throw new UsageError(`--roles must be a comma-separated list of valid roles.\n${usage}`);
  }
  return roles;
}

function parseStrategy(value: string | undefined, usage: string): SwarmStrategy | undefined {
  if (value === undefined) return undefined;
  if (value !== "targets" && value !== "even" && value !== "weights") {
    throw new UsageError(`--strategy must be targets, even or weights.\n${usage}`);
  }
  return value;
}

function parseRunMode(value: string | undefined): SwarmRunMode {
  if (value === undefined || value === "lead") return "lead";
  if (value === "each") return "each";
  throw new UsageError(`--mode must be lead or each.\n${RUN_USAGE}`);
}

function parseNetwork(
  value: string | undefined,
  usage: string,
): typeof BASE_MAINNET_CAIP2 | typeof ARC_MAINNET_CAIP2 | undefined {
  if (value === undefined) return undefined;
  if (value === "base") return BASE_MAINNET_CAIP2;
  if (value === "arc") return ARC_MAINNET_CAIP2;
  throw new UsageError(`--network must be base or arc.\n${usage}`);
}

function parseTargets(
  value: string | undefined,
  usage: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const targets: Record<string, string> = {};
  for (const raw of value.split(",")) {
    const parts = raw.split("=");
    const role = parts[0]?.trim() ?? "";
    const amount = parts[1]?.trim() ?? "";
    if (
      parts.length !== 2 ||
      !SWARM_ROLE_PATTERN.test(role) ||
      !amount ||
      targets[role] !== undefined
    ) {
      throw new UsageError(`--targets must use unique role=usd pairs.\n${usage}`);
    }
    try {
      usdToAtomic(amount);
    } catch {
      throw new UsageError(`--targets must use unique role=usd pairs.\n${usage}`);
    }
    targets[role] = amount;
  }
  if (Object.keys(targets).length === 0) {
    throw new UsageError(`--targets must use unique role=usd pairs.\n${usage}`);
  }
  return targets;
}

function parseCaps(
  value: string | undefined,
  option: string,
  usage: string,
): { perCallUsd: string; perDayUsd: string } | undefined {
  if (value === undefined) return undefined;
  const parts = value.split("/");
  if (parts.length !== 2 || !parts[0]?.trim() || !parts[1]?.trim()) {
    throw new UsageError(`${option} must use <perCall>/<perDay>.\n${usage}`);
  }
  const perCallUsd = parts[0].trim();
  const perDayUsd = parts[1].trim();
  try {
    if (usdToAtomic(perCallUsd) > usdToAtomic(perDayUsd)) throw new Error("caps");
  } catch {
    throw new UsageError(
      `${option} must use valid USD amounts with per-call at most per-day.\n${usage}`,
    );
  }
  return { perCallUsd, perDayUsd };
}

function assertPositiveCents(value: string, argument: string, usage: string): void {
  if (!/^\d+(?:\.\d{1,2})?$/u.test(value)) {
    throw new UsageError(`${argument} must be a positive USDC amount in whole cents.\n${usage}`);
  }
  const [whole = "0", fraction = ""] = value.split(".");
  if (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0") || "0") <= 0n) {
    throw new UsageError(`${argument} must be a positive USDC amount in whole cents.\n${usage}`);
  }
}

async function referencedSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    if (signal === undefined) return;
    if (signal.aborted) finish();
    else signal.addEventListener("abort", finish, { once: true });
  });
}
