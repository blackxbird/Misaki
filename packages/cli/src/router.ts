import {
  SpendCapError,
  SpendCapExceededError,
  getNetworkDefinition,
  getVapiPaths,
  loadConfig,
  spendCapsForWallet,
} from "@vapi-network/core";
import {
  ROUTER_TOPUP_TIERS,
  RouterClientError,
  buyRouterBalance,
  listRouterModels,
  rotateRouterKey,
  routerChat,
  routerCredentials,
  routerUsage,
  routerPurchaseView,
  routerPendingEvidence,
  resolveRouterPendingPurchase,
  type RouterClientDeps,
  type RouterTopupTier,
} from "@vapi-network/core/router-client";
import { AGENT_LINK_REVOKED_MESSAGE } from "@vapi-network/core/agent-link";

import {
  UsageError,
  getSecretStore,
  parseArguments,
  recordAudit,
  registryBaseUrl,
  requireSecretsAllowed,
  targetWallet,
  unlockTarget,
  type CliDependencies,
  type CliIo,
  type WalletTarget,
} from "./cli.js";

const WALLET_OPTION = "--wallet";
const CHAT_USAGE =
  'Usage: vapi router chat --model <id> [--system <text>] [--max-tokens <n>] "<prompt>".';
const BUY_USAGE =
  "Usage: vapi router buy <1|5|20|50> [--account <name>], vapi router buy --auto <1|5|20|50> --below <usd> [--account <name>], or vapi router buy --auto off [--account <name>].";

export async function routerCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const subcommand = argv[0];
  switch (subcommand) {
    case "models":
      await modelsCommand(argv.slice(1), json, io, dependencies);
      return;
    case "usage":
      await usageCommand(argv.slice(1), json, io, dependencies);
      return;
    case "chat":
      await chatCommand(argv.slice(1), json, io, dependencies);
      return;
    case "buy":
      await buyCommand(argv.slice(1), json, io, dependencies);
      return;
    case "clear-pending":
      await clearPendingCommand(argv.slice(1), json, io, dependencies);
      return;
    case "key":
      await keyCommand(argv.slice(1), json, io, dependencies);
      return;
    default:
      throw new UsageError("Usage: vapi router <models|usage|chat|key|buy|clear-pending>.");
  }
}

async function clearPendingCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set([WALLET_OPTION]),
    booleanOptions: new Set(["--confirm-unpaid"]),
    maximumPositionals: 0,
  });
  const target = await targetWallet(parsed, dependencies);
  await target.store.withRouterPurchaseLock(target.name, async () => {
    await target.store.refreshRegistry();
    const pending = target.store.entry(target.name)?.routerPendingPurchase;
    const evidence = pending === undefined ? null : routerPendingEvidence(pending);
    const confirmed = parsed.has("--confirm-unpaid");
    let confirmation: string | undefined;
    if (confirmed && pending !== undefined) {
      const resolution = await resolveRouterPendingPurchase(
        routerDeps(target, dependencies),
        pending,
        {
          ...(dependencies.now === undefined ? {} : { now: dependencies.now() }),
        },
      );
      if (resolution.state === "settled") {
        throw new Error(
          "Payment settled; retry chat to recover the key. This purchase cannot be confirmed unpaid.",
        );
      }
      if (resolution.state === "waiting") {
        throw new Error(
          `The Router authorization can still settle. Retry after ${resolution.resolvesAt}; this purchase cannot yet be cleared.`,
        );
      }
      if (resolution.state === "unavailable")
        confirmation = "Human confirmed unpaid without chain evidence.";
      await target.store.setRouterPendingPurchase(target.name, null, pending.receiptId);
    }
    if (json)
      io.stdout(
        JSON.stringify({
          wallet: target.name,
          pending: evidence,
          cleared: confirmed && pending !== undefined,
          ...(confirmation === undefined ? {} : { confirmation }),
        }),
      );
    else if (evidence === null) io.stdout("No pending Router purchase.");
    else {
      io.stdout(JSON.stringify(evidence, null, 2));
      io.stdout(
        confirmed
          ? `${confirmation ?? "Verified unpaid."} Cleared the pending Router purchase.`
          : "After verifying this payment cannot settle, run vapi router clear-pending --confirm-unpaid with the same account.",
      );
    }
  });
}

async function modelsCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set([WALLET_OPTION]),
    maximumPositionals: 0,
  });
  await targetWallet(parsed, dependencies);
  const config = await loadConfig(getVapiPaths().config, process.env, { notice: io.stderr });
  const list = dependencies.router?.listRouterModels ?? listRouterModels;
  const models = await withRouterError(() =>
    list({
      apiBase: registryBaseUrl(config),
      ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
    }),
  );
  if (json) {
    io.stdout(JSON.stringify(models.map(({ id }) => id)));
    return;
  }
  for (const { id } of models) io.stdout(id);
}

async function usageCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set([WALLET_OPTION]),
    maximumPositionals: 0,
  });
  const target = await targetWallet(parsed, dependencies);
  const readUsage = dependencies.router?.routerUsage ?? routerUsage;
  const usage = await withRouterError(() => readUsage(routerDeps(target, dependencies)));
  if (json) {
    io.stdout(JSON.stringify(usage));
    return;
  }
  io.stdout(
    `Compute today: $${money(usage.compute.spentTodayUsd)} of $${money(
      usage.compute.allowanceUsd,
    )} (resets ${utcTime(usage.compute.resetsAt)} UTC)`,
  );
  io.stdout(
    `Owner's Compute: $${money(usage.compute.ownerSpentUsd)} of $${money(
      usage.compute.ownerLimitUsd,
    )}`,
  );
  io.stdout(
    usage.balance === null
      ? "Router balance: none bought yet"
      : `Router balance: $${money(usage.balance.remainingUsd)} (bought $${money(
          usage.balance.purchasedUsd,
        )}, used $${money(usage.balance.spentUsd)})`,
  );
}

async function chatCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set([WALLET_OPTION, "--model", "--system", "--max-tokens"]),
    maximumPositionals: 1,
  });
  const model = parsed.one("--model");
  if (model === undefined) throw new UsageError(`Missing --model <id>.\n${CHAT_USAGE}`);
  const promptArgument = parsed.positionals[0];
  if (promptArgument === undefined) throw new UsageError(`Missing <prompt>.\n${CHAT_USAGE}`);
  const target = await targetWallet(parsed, dependencies);
  const prompt =
    promptArgument === "-" ? await (dependencies.readStdin ?? readProcessStdin)() : promptArgument;
  const system = parsed.one("--system");
  const maxTokens = positiveInteger(parsed.one("--max-tokens"), "--max-tokens");
  const request = {
    model,
    messages: [
      ...(system === undefined ? [] : [{ role: "system" as const, content: system }]),
      { role: "user" as const, content: prompt },
    ],
    ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
  };
  const chat = dependencies.router?.routerChat ?? routerChat;
  const refill = await configuredRefill(target, io, dependencies);
  const result = await withRouterError(() =>
    chat(
      {
        ...routerDeps(target, dependencies),
        ...(refill === undefined ? {} : { refill }),
      },
      request,
    ),
  );
  if (json) {
    io.stdout(
      JSON.stringify({
        model: result.model,
        content: result.content,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
        ...(result.refill === undefined ? {} : { refill: routerPurchaseView(result.refill) }),
      }),
    );
    return;
  }
  io.stdout(result.content ?? "");
  if (result.refill !== undefined) {
    io.stderr(`Receipt: ${result.refill.receipt.id}`);
    if (result.refill.receipt.settlement?.transaction !== undefined)
      io.stderr(`Transaction: ${result.refill.receipt.settlement.transaction}`);
  }
  for (const warning of result.refill?.warnings ?? []) io.stderr(warning.message);
}

async function buyCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set([WALLET_OPTION, "--auto", "--below"]),
    maximumPositionals: 1,
  });
  const auto = parsed.one("--auto");
  const below = parsed.one("--below");
  const tierArgument = parsed.positionals[0];
  const target = await targetWallet(parsed, dependencies);

  if (auto !== undefined) {
    if (tierArgument !== undefined) throw new UsageError(BUY_USAGE);
    if (auto === "off") {
      if (below !== undefined) throw new UsageError("--below cannot be used with --auto off.");
      await target.store.setRouterRefill(target.name, null);
      io.stdout(
        json
          ? JSON.stringify({ wallet: target.name, routerRefill: null })
          : "Automatic Router refill is off.",
      );
      return;
    }
    const tierUsd = routerTier(auto);
    if (below === undefined) throw new UsageError("--auto requires --below <usd>.");
    const belowUsd = nonNegativeUsd(below, "--below");
    const routerRefill = { tierUsd, belowUsd };
    await target.store.setRouterRefill(target.name, routerRefill);
    io.stdout(
      json
        ? JSON.stringify({ wallet: target.name, routerRefill })
        : `Automatic Router refill: buy $${tierUsd.toFixed(2)} when the balance is below $${belowUsd.toFixed(2)}.`,
    );
    return;
  }

  if (below !== undefined || tierArgument === undefined) throw new UsageError(BUY_USAGE);
  const tierUsd = routerTier(tierArgument);
  const paths = getVapiPaths();
  const config = await loadConfig(paths.config, process.env, { notice: io.stderr });
  const caps = await spendCapsForWallet(target.store, target.name);
  const { account } = await unlockTarget(target, dependencies);
  const buy = dependencies.router?.buyRouterBalance ?? buyRouterBalance;
  let result: Awaited<ReturnType<typeof buyRouterBalance>>;
  try {
    result = await withRouterError(() =>
      buy(
        {
          ...routerDeps(target, dependencies),
          account,
          config,
          caps,
          paths: { ledgerPath: paths.ledger, receiptsPath: paths.receipts },
          ...(dependencies.now === undefined ? {} : { now: dependencies.now() }),
        },
        tierUsd,
      ),
    );
  } catch (error) {
    // The shared error already carries the cap, amounts, wallet, and exact remedy
    // that the top-level CLI serializes. Keep that structured context intact.
    if (error instanceof SpendCapExceededError) throw error;
    if (error instanceof SpendCapError) {
      throw new Error(
        `Router balance purchase refused by the wallet spend policy: ${error.message} Review or change it with vapi accounts caps ${target.name}.`,
      );
    }
    throw error;
  }

  const summary = { tierUsd, ...routerPurchaseView(result) };
  const { amountUsd, network } = summary.receipt;
  if (json) {
    io.stdout(JSON.stringify(summary));
    return;
  }
  const networkName = networkDisplayName(network);
  const payment =
    amountUsd === null
      ? `Payment succeeded on ${networkName}; charged amount unknown.`
      : `Paid $${amountUsd.toFixed(2)} USDC on ${networkName}.`;
  io.stdout(
    result.balance === null
      ? `${payment} Router balance is not visible yet.`
      : `${payment} Router balance: $${money(result.balance.remainingUsd)}.`,
  );
  io.stdout(`Receipt: ${summary.receipt.id}`);
  if (summary.receipt.transaction !== undefined)
    io.stdout(`Transaction: ${summary.receipt.transaction}`);
  for (const warning of result.warnings ?? []) io.stderr(warning.message);
}

async function keyCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set([WALLET_OPTION]),
    booleanOptions: new Set(["--rotate"]),
    maximumPositionals: 0,
  });
  const target = await targetWallet(parsed, dependencies);
  const deps = routerDeps(target, dependencies);
  if (parsed.has("--rotate")) {
    const rotate = dependencies.router?.rotateRouterKey ?? rotateRouterKey;
    await withRouterError(() => rotate(deps));
    io.stdout(
      json ? JSON.stringify({ wallet: target.name, rotated: true }) : "New Router key stored.",
    );
    return;
  }

  await requireSecretsAllowed(
    dependencies,
    "secret.export.key",
    target.name,
    json ? { forcedReason: "Router keys are never printed as JSON." } : {},
  );
  const credentials = dependencies.router?.routerCredentials ?? routerCredentials;
  const result = await withRouterError(() => credentials(deps));
  await recordAudit(dependencies, "secret.export.key", {
    wallet: target.name,
    detail: "router",
  });
  io.stdout(result.apiKey);
}

export function routerDeps(target: WalletTarget, dependencies: CliDependencies): RouterClientDeps {
  return {
    secrets: getSecretStore(dependencies),
    wallets: target.store,
    wallet: target.name,
    ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
  };
}

async function configuredRefill(
  target: WalletTarget,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<RouterClientDeps["refill"] | undefined> {
  if (target.entry.routerRefill === undefined) return undefined;
  try {
    const paths = getVapiPaths();
    const config = await loadConfig(paths.config, process.env, { notice: io.stderr });
    return {
      account: async () =>
        (await unlockTarget(target, { ...dependencies, interactive: false })).account,
      config,
      caps: async () => {
        await target.store.refreshRegistry();
        return await spendCapsForWallet(target.store, target.name);
      },
      paths: { ledgerPath: paths.ledger, receiptsPath: paths.receipts },
      ...(dependencies.now === undefined ? {} : { now: dependencies.now() }),
    };
  } catch {
    return undefined;
  }
}

async function withRouterError<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RouterClientError && error.code === "not_linked") {
      throw new Error(
        error.message === AGENT_LINK_REVOKED_MESSAGE
          ? AGENT_LINK_REVOKED_MESSAGE
          : "Not linked. Run vapi login.",
      );
    }
    throw error;
  }
}

function money(value: number): string {
  return value.toFixed(2);
}

function routerTier(value: string): RouterTopupTier {
  const tier = ROUTER_TOPUP_TIERS.find((candidate) => String(candidate) === value);
  if (tier === undefined) {
    throw new UsageError("Router balance tier must be 1, 5, 20, or 50.");
  }
  return tier;
}

function nonNegativeUsd(value: string, option: string): number {
  if (!/^\d+(?:\.\d{1,2})?$/u.test(value)) {
    throw new UsageError(`${option} must be a non-negative US dollar amount such as 0.25 or 10.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed > 100_000) {
    throw new UsageError(`${option} must be at most 100000.`);
  }
  return parsed;
}

function networkDisplayName(network: string): string {
  try {
    return getNetworkDefinition(network).name.replace(/ mainnet$/iu, "");
  } catch {
    return network;
  }
}

function utcTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("The vAPI Router usage reset time was invalid.");
  }
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(
    2,
    "0",
  )}`;
}

function positiveInteger(value: string | undefined, option: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) throw new UsageError(`${option} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new UsageError(`${option} must be a positive integer.`);
  }
  return parsed;
}

async function readProcessStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  return input;
}
