import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import type { Address } from "viem";

import {
  BASE_MAINNET_CAIP2,
  DEFAULT_WALLET_NAME,
  DocsError,
  ONRAMP_FALLBACK_INSTRUCTIONS,
  ONRAMP_NETWORK,
  STATS_RANGES,
  activeAgentMarker,
  aggregateStats,
  appendAudit,
  assertWalletName,
  checkReceiptSettlement,
  changeKeystorePassphrase,
  createPublicFetch,
  createSupportReport,
  drainCeilingSweeps,
  enableDefaultNetwork,
  filterReceiptsByRange,
  formatLegacyRegistryRewrites,
  formatListingFee,
  formatUsdc,
  fundingPageUrl,
  getArcGasHeadroomAtomic,
  getNetworkDefinition,
  getVapiPaths,
  explorerTransactionUrl,
  isMissingFile,
  isMirroredHit,
  isNetworkConfigured,
  isSolanaNetwork,
  KeystoreError,
  loadOrCreateDeviceKey,
  loadConfig,
  MARKETPLACE_EXECUTION_METHODS,
  listAccounts,
  listUnfinishedMovements,
  lockVault,
  migrateLegacyRegistryConfig,
  migrateLegacyVapiHome,
  promptForSecret,
  readKeystoreVersion,
  readVaultFileUnlocked,
  readReceipts,
  readSearchEvents,
  receiptWallet,
  receiptsToCsv,
  resolvePassphrase,
  resolveRegistryUrl,
  secretStore,
  secretsAllowed,
  SpendCapExceededError,
  spendCapsForWallet,
  staleStoredPassphraseMessage,
  swarmParentResolver,
  sweepAboveCeiling,
  SweepGasError,
  SwarmError,
  TransferError,
  sweepBack,
  unlockProtectedVault,
  usesUsdcGas,
  validatePrivateKey,
  validateRecoveryPhrase,
  VAULT_KEY_ACCOUNT,
  WalletStore,
  writeDefaultConfig,
  writeJsonAtomic,
  withAccountMovementLock,
  type AuditEvent,
  type CeilingBalanceReader,
  type CeilingSiblingsFetcher,
  type CeilingTransfer,
  type DistributeArgs,
  type ListingConformance,
  type ListingHealth,
  type ListingLiveness,
  type ListingVerification,
  type MarketplaceDiscoveryPage,
  type ResolvedPassphrase,
  type SecretStore,
  type SecretsDecision,
  type SpendCaps,
  type SwarmCapitalDeps,
  type StatsRange,
  type AccountInfo,
  type VapiConfig,
  type VapiPaymentAccount,
  type WalletBalanceReader,
  type WalletEntry,
  type WalletInfo,
  type WalletName,
  type TransferArgs,
} from "@vapi-network/core";
import {
  exportKeystoreKeys,
  exportRecoveryPhrase,
  exportVaultAccountKey,
  exportVaultPhrase,
} from "@vapi-network/core/secrets";
// The registry key lives behind its own entry point, like the secrets above:
// no agent and no MCP tool may reach a provider credential.
import {
  API_KEY_ENV,
  apiKeyStatus,
  clearApiKey,
  describeApiKeySource,
  resolveApiKey,
  storeApiKey,
} from "@vapi-network/core/api-key";
import {
  agentFetch,
  type pollDeviceLink,
  type startDeviceLink,
} from "@vapi-network/core/agent-link";
import type {
  buyRouterBalance,
  listRouterModels,
  ownerStake,
  rotateRouterKey,
  routerChat,
  routerCredentials,
  routerUsage,
} from "@vapi-network/core/router-client";
import {
  callInspect,
  callPay,
  callSearch,
  createCallPort,
  getWallet,
  redactRunText,
  redactRunValue,
  runAction,
  RuntimeError,
  VapiCallError,
  startStdioServer,
  type ActionContext,
  type CallPort,
  type CallToolInput,
  type InspectToolInput,
  type MarketplaceSearchInput,
  type Runtime,
  type RuntimeKind,
  type runSwarm,
} from "@vapi-network/mcp";
import { detectColorLevel, renderBanner } from "./brand.js";
import { accountsAddCommand, accountsCapsCommand, accountsCommand } from "./accounts.js";
import { autoUploadBackup, cloudBackupCommand } from "./cloud-backup.js";
import { checkX402, formatCheckReport } from "./check.js";
import { docsCommand } from "./docs.js";
import { dashboardCommand, offerDashboardLink } from "./dashboard.js";
import { agentCommand, type AgentCommandDependencies } from "./agent.js";
import { formatIdentityLines } from "./identity.js";
import { loginCommand, logoutCommand, whoamiCommand } from "./login.js";
import { mcpInstallCommand } from "./mcp-install.js";
import { codeCommand } from "./code.js";
import { claudeCommand, codexCommand } from "./code-launch.js";
import { routerCommand } from "./router.js";
import { sendCommand } from "./send.js";
import { setupCommand } from "./setup.js";
import { stakeCommand } from "./stake.js";
import { TaskCommandError, taskCommand, type TasksCommandDependencies } from "./task.js";
import { statusCommand } from "./status.js";
import { swarmCommand } from "./swarm.js";
import { resolveRuntime, type RuntimeRequest } from "./runtime-local.js";
import { RemoteKeyRefusedError, type RailwayExec } from "./runtime-railway.js";
import { restoreCommand, vaultCommand } from "./vault.js";
import {
  API_KEY_CONSOLE_PATH,
  assertClaimMessage,
  buildPayoutSiweMessage,
  createListingsClient,
  formatProbeSteps,
  listingsUrl,
  LISTING_CATEGORIES,
  PROBE_MODES,
  readProbeOperations,
  readProbeRejection,
  RegistryApiError,
  type CreatedListing,
  type ListingCategory,
  type ListingEndpointInput,
  type ListingsClient,
  type ListingStatusAction,
  type MyListings,
  type ProbeMode,
  type ProbeOperation,
  type ProbeRejection,
  type ProbeResult,
} from "./publish-client.js";
import { CLI_VERSION } from "./version.js";

const HELP_HEADING = "vAPI Network";

export const HELP = `${HELP_HEADING}

Usage:
  vapi init [--networks <base,arc>] [--no-link] [--json]
  vapi setup [--no-cloud-backup] [--accounts <n>] [--json]
  vapi accounts [--all] [--json]
  vapi accounts add <name> [--label <text>] [--no-link] [--json]
  vapi accounts import <name> [--keystore <path> | --key-file <path>] [--label <text>] [--json]
  vapi accounts rename <old> <new> [--json]
  vapi accounts use <name> [--json]
  vapi accounts remove <name> [--force] [--json]
  vapi accounts restore <name> [--json]
  vapi accounts caps <name> [--per-call <usd>] [--per-day <usd>] [--ceiling <usd|off>] [--json]
  vapi accounts distribute <amount> --from <account> [--to <a,b,c>] [--network base|arc] [--json]
  vapi accounts distribute --resume <id> [--replace-expired-restored] [--bind-legacy-addresses] [--json]
  vapi accounts distribute --cancel <id> [--replace-expired-restored] [--json]
  vapi swarm create <name> [--agents <n>|--roles <a,b,c>] [--fund <usd> --from <account>] [--strategy <targets|even|weights>] [--targets <role=usd,...>] [--caps <perCall>/<perDay>] [--treasury-caps <perCall>/<perDay>] [--network <base|arc>] [--model <id>] [--no-wait] [--json]
  vapi swarm add <name> <role> [--json]
  vapi swarm remove <name> <member> [--json]
  vapi swarm fund <name> <usd> [--from <account>] [--json]
  vapi swarm rebalance <name> [--targets <role=usd,...>] [--json]
  vapi swarm status <name> [--json]
  vapi swarm dissolve <name> [--json]
  vapi swarm run <name> "<task>" [--mode lead|each] [--lead <member>] [--budget <usd>] [--draw <usd>] [--detach] [--runtime local|railway] [--result-file <path>] [--json]
  vapi swarm run <name> "<task>" --mode each --runtime railway --checkpoint <name> --allow-remote-key [--budget <usd>] [--keep-sandbox] [--json]
  vapi swarm runs <name> [--json]
  vapi swarm stop <name> [<runId>|--all] [--confirm-worker-stopped] [--json]
  vapi swarm forget-run <name> <runId> --confirm-destroyed [--json]
  vapi send <amount> --from <account> --to <account|owner|0x…> [--network base|arc] [--resume <nonce>] [--json]
  vapi fund [--amount <usd>] [--account <name>] [--json]
  vapi docs "<question>" [--json]
  vapi docs search "<query>" [--json]
  vapi docs read <url-or-path> [--json]
  vapi search [query] [--kind <kind>] [--network <caip2>] [--limit <n>] [--cursor <cursor>] [--include-unverified] [--include-outage] [--json]
  vapi inspect <id> [--endpoint <name>] [--json]
  vapi pay <id-or-url> [--method <method>] [--endpoint <name>] [--body <json>] [--content-type <type>] [--network <caip2>] [--expected-pay-to <address>] [--max <amount>] [--timeout <seconds>] [--account <name>] [--json]
  vapi pay --resume <receipt-id> [--json]
  vapi check <url> [--method <method>] [--json]
  vapi balance [--account <name>] [--json]
  vapi receipts [--limit <n>] [--account <name>] [--all-wallets] [--json]
  vapi receipts export --format <json|csv> [--range <24h|7d|30d>] [--account <name>] [--all-wallets]
  vapi stats [--range <24h|7d|30d>] [--account <name>] [--all-wallets] [--json]
  vapi sweep [<address>] [--network <caip2>] [--account <name>] [--json]
  vapi agent create <name> --model <id> --instructions <file> [--call-budget <usd>] [--max-per-call <usd>] [--router-budget <usd>] [--approve-above <usd>] [--max-per-task <usd>] [--auto-release-below <usd>] [--include-unverified] [--max-steps <n>] [--yes] [--json]
  vapi agent run <name> "<task>" [--budget <usd>] [--detach] [--runtime local] [--result-file <path>] [--json]
  vapi agent run --bundle-env <VAR> ("<task>" | --task-base64url <text>) [--budget <usd>] [--result-file <path>] [--json]
  vapi agent list [--json]
  vapi agent show <name> [--json]
  vapi agent pause <name> [--json]
  vapi agent resume <name> [--json]
  vapi agent revoke <name> [--json]
  vapi dashboard [--account <name>] [--no-browser] [--json]
  vapi login [--account <name>] [--label <name>] [--publish] [--no-browser] [--json]
  vapi logout [--account <name>] [--json]
  vapi whoami [--account <name>] [--json]
  vapi claude [--vapi|--own] [--model <m>] [--use-balance] [--account <name>] [<claude args>...]
  vapi codex [--vapi|--own] [--model <id>] [--use-balance] [--account <name>] [<codex args>...]
  vapi code install [--yes] [--no-alias] [--account <name>] [--json]
  vapi code uninstall [--json]
  vapi router models [--account <name>] [--json]
  vapi router usage [--account <name>] [--json]
  vapi router chat --model <id> [--system <text>] [--max-tokens <n>] "<prompt>" [--account <name>] [--json]
  vapi router buy <1|5|20|50> [--account <name>] [--json]
  vapi router buy --auto <1|5|20|50> --below <usd> [--account <name>] [--json]
  vapi router buy --auto off [--account <name>] [--json]
  vapi router key [--rotate] [--account <name>] [--json]
  vapi stake status [--account <name>] [--json]
  vapi stake open [--account <name>] [--no-browser] [--json]
  vapi task search [--open] [--min <usd>] [--tab trending|new|closing|paid] [--limit <n>] [--json]
  vapi task show <id> [--account <name>] [--json]
  vapi task post --title <text> --brief <file|-> --amount <usd> --deadline <duration|ISO> [--intake proposals|submissions] [--max-awards <k>] [--webhook <https-url>] [--account <name>] [--json]
  vapi task propose <id> --price <usd> --duration <duration> --note <text> [--account <name>] [--json]
  vapi task submit <id> --proof <https-url> [--proof <https-url>...] [--file <path>...] [--account <name>] [--json]
  vapi task award <id> <proposalId> [--account <name>] [--json]
  vapi task sign <id> [--account <name>] [--json]
  vapi task fund <id> [--yes] [--account <name>] [--json]
  vapi task deliver <id> --files <path...> --note <text> [--account <name>] [--json]
  vapi task release <id> [--account <name>] [--json]
  vapi task refund <id> [--account <name>] [--json]
  vapi task dispute <id> --evidence-hash <0x + 64 hex> [--account <name>] [--json]
  vapi task message <id> <text> [--account <name>] [--json]
  vapi task thread <id> [--after <cursor>] [--account <name>] [--json]
  vapi task watch <id> [--until <state>] [--auto-release] [--timeout 7d] [--interval 5s] [--account <name>] [--json]
  vapi task status <id> [--account <name>] [--json]
  vapi export-key [--network <caip2>] [--account <name>] [--json]
  vapi backup [--account <name>] [--cloud [off]] [--json]
  vapi restore [--accounts <n> | --from-owner [--owner <0x…>]] [--json]
  vapi import (--phrase | --key) [--account <name>] [--networks <base,arc>] [--replace] [--force] [--json]
  vapi passphrase [--account <name>] [--json]
  vapi vault protect [--json]
  vapi vault unprotect [--json]
  vapi vault lock [--json]
  vapi vault unlock [--json]
  vapi vault status [--json]
  vapi unlock [--account <name>] [--json]
  vapi lock [--account <name> | --all] [--json]
  vapi report "<what happened>" [--include-addresses] [--send] [--json]
  vapi auth set-key [--json]
  vapi auth status [--json]
  vapi auth clear [--json]
  vapi publish <url> [--method <method>] [--mode <origin|endpoint|openapi>] [--name <text>] [--description <text>] [--category <ai|data|crypto|compute|search>] [--select <names>] [--account <name>] [--yes] [--resume] [--json]
  vapi publish activate <slug> [--json]
  vapi publish verify-request <slug> [--json]
  vapi publish list [--json]
  vapi claim <origin> [--account <name>] [--json]
  vapi mcp [--account <name>] [--json]
  vapi mcp install <claude-code|claude-desktop|cursor|codex> [--home <dir>] [--registry <url>] [--no-link] [--json]
  vapi serve [--json]
  vapi version [--json]
  vapi help [--json]

\`vapi init\`, \`vapi wallet create\` and \`vapi mcp install\` offer to link the wallet to your vAPI dashboard. Use \`--no-link\` to skip the prompt.

Every command that touches a wallet takes \`--account <name>\`, falls back to \`VAPI_WALLET\`, then to the default account set by \`vapi accounts use\`, and names the wallet it used on its first line.

\`vapi search\` answers with vAPI-verified listings plus the mirrored external catalogs. \`--include-unverified\` also returns self-listed APIs that passed vAPI's automated x402 probe but were never reviewed; every result is tagged \`[verified]\`, \`[requested]\`, \`[unverified]\` or \`[external]\`.

Solana listings remain searchable; inspect and pay return \`unsupported_network\`. Solana keys are not part of the device vault yet.

\`vapi docs\` asks the public vAPI documentation assistant; \`vapi docs search\` searches documentation excerpts and \`vapi docs read\` reads one Markdown page. They need no account, wallet or payment.

\`vapi task --help\` lists task options and availability. Task exit codes: 0 ok, 1 error, 2 policy refusal (JSON ok:false with a policy. reason) or invalid usage (JSON error), 3 approval needed in non-interactive mode. Posting moves no money; the current create-order contract does not store amount, deadline, intake, max awards or webhook yet.

\`vapi check <url>\` grades an x402 API's 402 without paying: status, transport, declared version and its required fields, the exact scheme, canonical USDC, payTo, maxTimeoutSeconds, advertised extensions, and the origin's /.well-known/x402. It looks for OpenAPI beside the checked path, at /openapi.json, then through same-origin service-desc links in /.well-known/api-catalog. No wallet, no payment, no registry call. It exits 1 when a rule fails. A 402 that answers with Stripe/Tempo's MPP challenge (WWW-Authenticate: Payment) is recognised and reported as transport mpp; vapi pay cannot pay it.

\`vapi pay --resume <receipt-id>\` answers the one question a lost response leaves: did that payment settle? It reads the signed authorization's state on-chain — settled, expired, or still pending — and never pays.

\`vapi fund\` opens the funding page: card via Coinbase (needs a Coinbase account; US guest checkout), send from MetaMask/Coinbase Wallet/WalletConnect, or bridge from another chain.

\`vapi vault protect\` adds a password to the device vault. \`vapi vault unlock\` opens it on this device for 8 hours; for unattended use, set \`VAPI_VAULT_PASSWORD\`. \`vapi unlock\` and \`vapi lock\` remain aliases for one release.

\`vapi backup\` and \`vapi export-key\` print a secret, so they run only on a real terminal, never for an agent, and ask you to type the wallet name first. \`vapi backup --cloud\` keeps an encrypted vault copy that only the owner can approve for recovery. \`vapi restore\` rebuilds the vault from the phrase and re-derives accounts until five consecutive addresses have no Base USDC, and reports the number scanned. Use \`--accounts <n>\` with restore or setup to recover a fixed count without querying balances. Set \`VAPI_NO_SECRETS=1\` to switch exports off entirely. Every export and every wallet change is logged to ~/.vapi/audit.log.

\`vapi publish <url>\` lists an API you own. vAPI probes the URL — an origin, one endpoint, or an OpenAPI document — you choose which endpoints to list, and your wallet signs one line naming where the payouts go. Listing is permissionless: a listing that passed the probe goes live with \`vapi publish activate <slug>\`, and \`vapi publish verify-request <slug>\` asks for the review that puts it in the default search. Set each endpoint's x402 payTo to the payout wallet you signed with before activation. vAPI Call takes no fee. Providers are paid directly. A catalog of more than 20 endpoints is listed as several listings of up to 20, with one result line per endpoint; \`--resume\` skips every endpoint this key already lists.

\`vapi claim <origin>\` takes ownership of the listings vAPI indexed from your API. The wallet their payments go to signs one line, \`Claim the vAPI Call listings served from <origin>\`; the listings stay paid directly to that wallet, and \`vapi publish list\` shows them.

\`vapi auth set-key\` types the registry API key once, on a terminal, into the same OS secret store as the passphrase. A key is a secret: it is never an argument, \`VAPI_API_KEY\` is the route for CI, and no agent or MCP tool can reach it.

With no command, vapi shows the status screen; vapi help prints this text. The MCP server starts only with \`vapi mcp\`; \`vapi mcp install claude-code\` runs Claude Code's installer, while the other install targets write the client's MCP config.`;

export type CliIo = {
  stdout(message: string): void;
  stderr(message: string): void;
};

/** Every secret the CLI reads is read here, so tests never touch a terminal. */
export type CliPrompts = {
  /** Reads one line from the terminal without echoing it. */
  secret(prompt: string): Promise<string>;
  /**
   * Reads one visible line, for a typed confirmation such as a wallet name.
   * Never used for a secret, so it may echo.
   */
  line?(prompt: string): Promise<string>;
};

export type CliDependencies = {
  fetchImpl?: typeof fetch;
  prompts?: CliPrompts;
  /** Whether a person is watching. Only then is a recovery phrase shown. */
  interactive?: boolean;
  /** Whether stdin is a terminal, independently of redirected stdout. */
  stdinIsTTY?: boolean;
  /** The environment this run sees: wallet selection and agent detection. */
  env?: NodeJS.ProcessEnv;
  /**
   * Runtime adapter selection, injected so CLI tests never spawn real children.
   * A `vapi swarm run --runtime railway` start passes its request as well.
   */
  runtime?: (kind: RuntimeKind, home: string, request?: RuntimeRequest) => Runtime;
  /** The `railway` CLI executor, injected so tests never run the real binary. */
  railwayExec?: RailwayExec;
  /** The OS secret store `vapi unlock` and `vapi lock` act on. */
  secretStore?: SecretStore;
  /** Injected clock, so a signed message is reproducible in a test. */
  now?: () => Date;
  /** Injected hostname, so device naming is reproducible in a test. */
  hostname?: () => string;
  /** Device-link operations, injected so tests never touch the account service. */
  agentLink?: {
    startDeviceLink?: typeof startDeviceLink;
    pollDeviceLink?: typeof pollDeviceLink;
    forgetAgentLink?: typeof import("@vapi-network/core/agent-link").forgetAgentLink;
  };
  /** Router operations, injected so CLI tests never make service requests. */
  router?: {
    listRouterModels?: typeof listRouterModels;
    routerUsage?: typeof routerUsage;
    routerChat?: typeof routerChat;
    buyRouterBalance?: typeof buyRouterBalance;
    rotateRouterKey?: typeof rotateRouterKey;
    ownerStake?: typeof ownerStake;
    routerCredentials?: typeof routerCredentials;
  };
  /** Task transport and chain seams for deterministic commands. */
  tasks?: TasksCommandDependencies;
  /** Status-screen deadlines, injected so timeout behavior is deterministic in tests. */
  status?: { timeoutMs?: number };
  /** Cloud-backup seams, injected so relay and upload tests stay deterministic. */
  cloudBackup?: {
    startRelay?: typeof import("@vapi-network/core/cloud-backup").startRelay;
    awaitRelay?: typeof import("@vapi-network/core/cloud-backup").awaitRelay;
    uploadBackup?: typeof import("@vapi-network/core/cloud-backup").uploadBackup;
    fetchSiblings?: typeof import("@vapi-network/core").fetchSiblings;
    sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
    randomBytes?: (size: number) => Uint8Array;
    uploadTimeoutMs?: number;
  };
  /** Code installer and launcher seams; tests never touch the real HOME or processes. */
  code?: {
    homedir?: string;
    platform?: NodeJS.Platform;
    isExecutable?: (path: string) => Promise<boolean>;
    realpath?: (path: string) => Promise<string>;
    selfPath?: string;
    spawn?: import("./code.js").CodeSpawn;
    usageTimeoutMs?: number;
    processSignals?: import("./code-launch.js").CodeProcessSignals;
    login?: typeof import("./login.js").runLoginFlow;
  };
  /** MCP client locations, injected so installer tests never touch user config. */
  mcpInstall?: {
    platform?: NodeJS.Platform;
    homedir?: string;
    cwd?: string;
    appData?: string;
    runProcess?: import("./mcp-install.js").McpInstallProcessRunner;
  };
  /** Agent profile and run operations, injected so tests stay local and deterministic. */
  agent?: AgentCommandDependencies;
  /** Reads stdin to EOF for `vapi router chat ... -` and scripted vault restores. */
  readStdin?: () => Promise<string>;
  /** Opens one public URL in the platform browser. */
  openUrl?: (url: string) => boolean;
  /** Moves a wallet balance, injected for deterministic sweep command tests. */
  sweepBack?: typeof sweepBack;
  /** Transfer authorization inputs, injected so send tests are deterministic. */
  transfer?: {
    nonce?: TransferArgs["nonce"];
    timeoutMs?: number;
  };
  /** Distribution seams, injected so CLI tests never sign or relay live transfers. */
  distribute?: Pick<
    DistributeArgs,
    | "balanceReader"
    | "siblingsReader"
    | "transfer"
    | "authorizationState"
    | "randomId"
    | "randomNonce"
    | "timeoutMs"
    | "lockTimeoutMs"
  >;
  /** Swarm capital seams, injected so CLI tests never sign or relay live transfers. */
  swarm?: Pick<
    SwarmCapitalDeps,
    | "balanceReader"
    | "transfer"
    | "authorizationState"
    | "addressReader"
    | "randomId"
    | "randomNonce"
    | "unlock"
    | "timeoutMs"
    | "lockTimeoutMs"
  > & { runSwarm?: typeof runSwarm };
  /** Automatic ceiling sweep seams for status and short-lived paid calls. */
  ceiling?: {
    sweepAboveCeiling?: typeof sweepAboveCeiling;
    sweepAllAboveCeiling?: typeof import("@vapi-network/core").sweepAllAboveCeiling;
    drainCeilingSweeps?: typeof drainCeilingSweeps;
    balanceReader?: CeilingBalanceReader;
    fetchSiblingsImpl?: CeilingSiblingsFetcher;
    transfer?: CeilingTransfer;
    timeoutMs?: number;
  };
};

const processIo: CliIo = {
  stdout: (message) => process.stdout.write(`${message}\n`),
  stderr: (message) => process.stderr.write(`${message}\n`),
};

const defaultPrompts: CliPrompts = { secret: (prompt) => promptForSecret(prompt) };

export class UsageError extends Error {}

export function getPrompts(dependencies: CliDependencies): CliPrompts {
  return dependencies.prompts ?? defaultPrompts;
}

export function getEnvironment(dependencies: CliDependencies): NodeJS.ProcessEnv {
  return dependencies.env ?? process.env;
}

/** A recovery phrase is shown only when a person can write it down. */
export function isInteractive(dependencies: CliDependencies): boolean {
  return dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Whether a secret can be typed without being echoed, even when stdout is redirected. */
export function isStdinInteractive(dependencies: CliDependencies): boolean {
  return dependencies.stdinIsTTY ?? dependencies.interactive ?? Boolean(process.stdin.isTTY);
}

/**
 * Reads one visible line. The prompt and the echo go to stderr, so a typed
 * confirmation never lands in the stdout a caller may be capturing.
 */
export async function promptForLine(prompt: string): Promise<string> {
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await reader.question(prompt)).trim();
  } finally {
    reader.close();
  }
}

export function getLinePrompt(dependencies: CliDependencies): (prompt: string) => Promise<string> {
  return getPrompts(dependencies).line ?? promptForLine;
}

const WALLET_OPTION = "--wallet";
const ACCOUNT_OPTION = "--account";
const WALLET_OPTION_DEPRECATION =
  "--wallet is now --account; --wallet keeps working for one release.";
const SOLANA_VAULT_UNAVAILABLE = "Solana keys are not part of the device vault yet.";

/** The one trust switch `vapi search` exposes; see `searchCommand`. */
const INCLUDE_UNVERIFIED_OPTION = "--include-unverified";
const INCLUDE_OUTAGE_OPTION = "--include-outage";

/** The wallet one invocation acts on, resolved before any passphrase is read. */
export type WalletTarget = {
  store: WalletStore;
  name: WalletName;
  path: string;
  entry: WalletEntry;
  address?: string;
};

/** Opens the wallet store for this home, migrating a 0.2.x layout on the way. */
export async function openWalletStore(
  dependencies: CliDependencies,
  home = getVapiPaths().directory,
): Promise<WalletStore> {
  return await WalletStore.open(home, {
    secrets: getSecretStore(dependencies),
    env: getEnvironment(dependencies),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
}

/**
 * `--account`, then `VAPI_WALLET`, then the default in `wallets.json`. An
 * unknown name fails here, before a passphrase prompt can cost anything.
 */
async function selectWallet(
  store: WalletStore,
  parsed: { one(name: string): string | undefined },
  dependencies: CliDependencies,
): Promise<WalletTarget> {
  const requested = parsed.one(WALLET_OPTION);
  const resolved = store.resolve({
    ...(requested === undefined ? {} : { name: requested }),
    env: getEnvironment(dependencies),
  });
  const address = await store.readAddress(resolved.name);
  return { store, ...resolved, ...(address === undefined ? {} : { address }) };
}

/** Opens the store and picks the wallet in one step, for the usual command. */
export async function targetWallet(
  parsed: { one(name: string): string | undefined },
  dependencies: CliDependencies,
  home = getVapiPaths().directory,
): Promise<WalletTarget> {
  return await selectWallet(await openWalletStore(dependencies, home), parsed, dependencies);
}

/** The OS secret store this run uses: the machine's, or the one a test injects. */
export function getSecretStore(dependencies: CliDependencies): SecretStore {
  return dependencies.secretStore ?? secretStore();
}

/**
 * The passphrase for the wallet this command acts on: `VAPI_KEYSTORE_PASSWORD`,
 * then the OS secret store entry `vapi unlock` left behind, then a prompt.
 *
 * The variable is read from the real process environment rather than from the
 * injected one: it belongs to the process, while `dependencies.env` models
 * wallet selection and agent markers.
 */
async function walletPassphrase(
  target: { name: string },
  dependencies: CliDependencies,
  options: { confirm?: boolean } = {},
): Promise<ResolvedPassphrase> {
  const prompts = dependencies.prompts;
  return await resolvePassphrase(target.name, {
    env: process.env,
    store: getSecretStore(dependencies),
    ...(dependencies.interactive === undefined ? {} : { interactive: dependencies.interactive }),
    ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
    prompt: async (prompt, hint) =>
      prompts ? await prompts.secret(prompt) : await promptForSecret(prompt, hint),
  });
}

/**
 * Runs one keystore operation with a resolved passphrase. A passphrase that
 * came out of the secret store and no longer opens the wallet is worth its own
 * sentence: the person has to know which copy went stale, and how to replace it.
 */
async function withResolvedPassphrase<T>(
  resolved: ResolvedPassphrase,
  target: { name: string },
  dependencies: CliDependencies,
  use: (passphrase: string) => Promise<T>,
): Promise<T> {
  try {
    return await use(resolved.passphrase);
  } catch (error) {
    if (resolved.source !== "secret-store" || !(error instanceof KeystoreError)) throw error;
    throw new KeystoreError(
      staleStoredPassphraseMessage(target.name, getSecretStore(dependencies)),
      { cause: error },
    );
  }
}

/** Opens the selected wallet, and keeps the passphrase for callers that need it. */
export async function unlockTarget(
  target: WalletTarget,
  dependencies: CliDependencies,
): Promise<{ account: VapiPaymentAccount; passphrase: string }> {
  if (await target.store.hasVaultAccount(target.name)) {
    return { account: await target.store.unlock(target.name, ""), passphrase: "" };
  }
  const resolved = await walletPassphrase(target, dependencies);
  const account = await withResolvedPassphrase(resolved, target, dependencies, (passphrase) =>
    target.store.unlock(target.name, passphrase),
  );
  return { account, passphrase: resolved.passphrase };
}

function walletHeader(target: { name: string; address?: string }): string {
  return target.address === undefined
    ? `Wallet: ${target.name}`
    : `Wallet: ${target.name} (${target.address})`;
}

/**
 * The shape every wallet-aware command prints: the wallet name first in text
 * mode, and a `wallet` field in `--json`, so a person and an agent always know
 * which key just moved.
 */
function outputForWallet(
  io: CliIo,
  json: boolean,
  target: { name: string; address?: string },
  value: Record<string, unknown>,
  human: string,
): void {
  if (json) {
    io.stdout(JSON.stringify({ wallet: target.name, ...value }));
    return;
  }
  io.stdout(walletHeader(target));
  io.stdout(human);
}

const AGENT_SECRET_REFUSAL =
  "Run this yourself in a terminal; an agent must never see these words.";

/** Whether this run may put a recovery phrase or a private key on the screen. */
function secretsDecision(dependencies: CliDependencies): SecretsDecision {
  const interactive = dependencies.interactive;
  return secretsAllowed(getEnvironment(dependencies), {
    stdinIsTTY: interactive ?? Boolean(process.stdin.isTTY),
    stdoutIsTTY: interactive ?? Boolean(process.stdout.isTTY),
  });
}

/** One audit line. The home is the wallet store's, so `VAPI_HOME` is honoured. */
export async function recordAudit(
  dependencies: CliDependencies,
  event: AuditEvent | "vault.cloud_backup_on" | "vault.cloud_backup_off",
  options: { wallet?: string; detail?: string } = {},
): Promise<void> {
  const marker = activeAgentMarker(getEnvironment(dependencies));
  await appendAudit(getVapiPaths().directory, {
    event: event as AuditEvent,
    ...(options.wallet === undefined ? {} : { wallet: options.wallet }),
    tty: isInteractive(dependencies),
    ...(marker === undefined ? {} : { agentMarker: marker }),
    ...(options.detail === undefined ? {} : { detail: options.detail }),
  });
}

/**
 * The gate in front of `vapi backup` and `vapi export-key`: refuse, log the
 * attempt, and say which stream or which variable decided it. Nothing is
 * printed to stdout, so a caller capturing it gets nothing either way.
 */
export async function requireSecretsAllowed(
  dependencies: CliDependencies,
  event: AuditEvent,
  wallet: string | undefined,
  options: { refusal?: string; forcedReason?: string } = {},
): Promise<void> {
  const decision = secretsDecision(dependencies);
  if (decision.allowed && options.forcedReason === undefined) return;
  const reason = decision.allowed ? options.forcedReason : decision.reason;
  await recordAudit(dependencies, event, {
    ...(wallet === undefined ? {} : { wallet }),
    detail: `refused: ${reason ?? ""}`,
  });
  throw new KeystoreError(`${options.refusal ?? AGENT_SECRET_REFUSAL} ${reason ?? ""}`.trim());
}

/**
 * Printing a secret or trashing a wallet is worth one deliberate act: the
 * person types the wallet's own name. A mismatch stops before anything moves.
 */
export async function confirmWalletName(
  name: string,
  prompt: string,
  refusal: string,
  dependencies: CliDependencies,
): Promise<void> {
  const typed = await getLinePrompt(dependencies)(prompt);
  if (typed.trim() !== name) throw new KeystoreError(refusal);
}

/** Run one CLI invocation and return its process exit code. */
export async function runCli(
  argv = process.argv.slice(2),
  io: CliIo = processIo,
  dependencies: CliDependencies = {},
): Promise<number> {
  const firstArgument = argv.find((argument) => argument !== "--json");
  const codeLaunch = firstArgument === "claude" || firstArgument === "codex";
  let json = argv.includes("--json");
  const taskInvocation = argv.find((argument) => argument !== "--json") === "task";
  const resultFile = runResultFile(argv);
  const runIo =
    resultFile === undefined
      ? io
      : {
          stdout: (message: string) =>
            io.stdout(redactDetachedRunText(message, getEnvironment(dependencies))),
          stderr: (message: string) =>
            io.stderr(redactDetachedRunText(message, getEnvironment(dependencies))),
        };
  try {
    const parsedInvocation = removeJsonFlag(argv, codeLaunch);
    json = parsedInvocation.json;
    const hasWalletOption = !codeLaunch && parsedInvocation.args.includes(WALLET_OPTION);
    const hasAccountOption = parsedInvocation.args.includes(ACCOUNT_OPTION);
    if (hasWalletOption && hasAccountOption) {
      throw new UsageError("--wallet and --account cannot be used together.");
    }
    if (hasWalletOption) io.stderr(WALLET_OPTION_DEPRECATION);
    const args = codeLaunch
      ? parsedInvocation.args
      : parsedInvocation.args.map((argument) =>
          argument === WALLET_OPTION ? ACCOUNT_OPTION : argument,
        );
    const command = args[0];

    if (command === "version" || command === "--version" || command === "-v") {
      requireNoArguments(args.slice(1), "version");
      output(io, json, { command: "version", version: CLI_VERSION }, CLI_VERSION);
      return 0;
    }

    if (command === undefined) {
      await statusCommand(args, json, io, dependencies);
      return 0;
    }

    if (command === "help" || command === "--help" || command === "-h") {
      requireNoArguments(args.slice(1), command);
      output(io, json, { command: "help", help: HELP }, HELP);
      return 0;
    }

    let exitCode: number;
    switch (command) {
      case "init":
        await initCommand(args.slice(1), json, io, dependencies);
        exitCode = 0;
        break;
      case "setup":
        await setupCommand(args.slice(1), json, io, dependencies);
        exitCode = 0;
        break;
      case "wallet":
        await walletCommand(args.slice(1), json, io, dependencies);
        exitCode = 0;
        break;
      case "fund":
        await fundCommand(args.slice(1), json, io, dependencies);
        exitCode = 0;
        break;
      case "docs":
        await docsCommand(args.slice(1), json, io, dependencies);
        exitCode = 0;
        break;
      case "accounts":
        exitCode = await accountsCommand(args.slice(1), json, io, dependencies);
        break;
      case "swarm":
        exitCode = await swarmCommand(args.slice(1), json, runIo, dependencies);
        break;
      case "send":
        exitCode = await sendCommand(args.slice(1), json, io, dependencies);
        break;
      case "search":
        await searchCommand(args.slice(1), json, io, dependencies);
        exitCode = 0;
        break;
      case "inspect":
        await inspectCommand(args.slice(1), json, io, dependencies);
        exitCode = 0;
        break;
      case "pay":
        await payCommand(args.slice(1), json, io, dependencies);
        exitCode = 0;
        break;
      case "balance":
        await balanceCommand(args.slice(1), json, io, dependencies);
        exitCode = 0;
        break;
      case "receipts":
        await receiptsCommand(args.slice(1), json, io, dependencies);
        exitCode = 0;
        break;
      case "stats":
        await statsCommand(args.slice(1), json, io, dependencies);
        exitCode = 0;
        break;
      case "sweep":
        await sweepCommand(args.slice(1), json, io, dependencies);
        exitCode = 0;
        break;
      case "agent":
        exitCode = await agentCommand(args.slice(1), json, runIo, dependencies);
        break;
      case "dashboard":
        await dashboardCommand(args.slice(1), json, io, dependencies);
        exitCode = 0;
        break;
      case "login":
        await loginCommand(args.slice(1), json, io, dependencies);
        exitCode = 0;
        break;
      case "logout":
        await logoutCommand(args.slice(1), json, io, dependencies);
        exitCode = 0;
        break;
      case "whoami":
        await whoamiCommand(args.slice(1), json, io, dependencies);
        exitCode = 0;
        break;
      case "claude":
        exitCode = await claudeCommand(args.slice(1), json, io, dependencies);
        break;
      case "codex":
        exitCode = await codexCommand(args.slice(1), json, io, dependencies);
        break;
      case "code":
        exitCode = await codeCommand(args.slice(1), json, io, dependencies);
        break;
      case "router":
        await routerCommand(args.slice(1), json, io, dependencies);
        exitCode = 0;
        break;
      case "stake":
        await stakeCommand(args.slice(1), json, io, dependencies);
        exitCode = 0;
        break;
      case "task":
        exitCode = (await taskCommand(args.slice(1), json, io, dependencies)) ?? 0;
        break;
      case "export-key":
        await exportKeyCommand(args.slice(1), json, io, dependencies);
        exitCode = 0;
        break;
      case "backup":
        await backupCommand(args.slice(1), json, io, dependencies);
        exitCode = 0;
        break;
      case "restore":
        await restoreCommand(args.slice(1), json, io, dependencies);
        exitCode = 0;
        break;
      case "import":
        await importCommand(args.slice(1), json, io, dependencies);
        exitCode = 0;
        break;
      case "passphrase":
        await passphraseCommand(args.slice(1), json, io, dependencies);
        exitCode = 0;
        break;
      case "vault":
        await vaultCommand(args.slice(1), json, io, dependencies);
        exitCode = 0;
        break;
      case "unlock":
        io.stderr("vapi unlock is now vapi vault unlock; the old name works for one release.");
        if (await fileExists(join(getVapiPaths().directory, "vault.json"))) {
          parseArguments(args.slice(1), {
            valueOptions: new Set([WALLET_OPTION]),
            maximumPositionals: 0,
          });
          await vaultCommand(["unlock"], json, io, dependencies);
        } else {
          await unlockCommand(args.slice(1), json, io, dependencies);
        }
        exitCode = 0;
        break;
      case "lock":
        io.stderr("vapi lock is now vapi vault lock; the old name works for one release.");
        await lockCommand(args.slice(1), json, io, dependencies);
        exitCode = 0;
        break;
      case "report":
        await reportCommand(args.slice(1), json, io, dependencies);
        exitCode = 0;
        break;
      case "auth":
        await authCommand(args.slice(1), json, io, dependencies);
        exitCode = 0;
        break;
      case "publish":
        exitCode = await publishCommand(args.slice(1), json, io, dependencies);
        break;
      case "claim":
        await claimCommand(args.slice(1), json, io, dependencies);
        exitCode = 0;
        break;
      case "check":
        exitCode = await checkCommand(args.slice(1), json, io, dependencies);
        break;
      case "mcp":
        if (args[1] === "install") {
          exitCode = await mcpInstallCommand(args.slice(2), json, io, dependencies);
        } else {
          await mcpCommand(args.slice(1), dependencies);
          exitCode = 0;
        }
        break;
      case "serve":
        outputStub(io, json);
        exitCode = 2;
        break;
      default:
        throw new UsageError(`Unknown command ${JSON.stringify(command)}. Run vapi help.`);
    }
    if ((exitCode === 0 || shouldAutoUploadAfterFailure(args)) && shouldAutoUploadBackup(args)) {
      await autoUploadBackup(io, json, dependencies);
    }
    return exitCode;
  } catch (error) {
    const code = error instanceof UsageError && !taskInvocation ? 2 : 1;
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message =
      resultFile === undefined
        ? rawMessage
        : redactDetachedRunText(rawMessage, getEnvironment(dependencies));
    if (resultFile !== undefined) {
      const errorCode = errorCodeOf(error);
      await writeJsonAtomic(
        resultFile,
        {
          v: 1,
          exitCode: code,
          error: { message, ...(errorCode === undefined ? {} : { code: errorCode }) },
        },
        { mode: 0o600 },
      ).catch(() => undefined);
    }
    if (json) {
      if (error instanceof SpendCapExceededError) {
        runIo.stdout(JSON.stringify({ error: error.toJSON(), exitCode: 1 }));
      } else if (taskInvocation) {
        runIo.stdout(
          JSON.stringify({
            ok: false,
            error: {
              code:
                error instanceof UsageError ? "usage_error" : (errorCodeOf(error) ?? "task_error"),
              message,
            },
          }),
        );
      } else {
        runIo.stdout(
          JSON.stringify({
            error: message,
            exitCode: code,
            ...(error instanceof RuntimeError ||
            (error instanceof SwarmError && error.code === "swarm_workers_active")
              ? { code: error.code }
              : {}),
            ...(error instanceof VapiCallError ? { code: error.code } : {}),
            ...(error instanceof DocsError ? { code: error.code } : {}),
            ...(error instanceof RemoteKeyRefusedError ? { code: error.code } : {}),
            ...(error instanceof TransferError
              ? { code: error.code, moneyMoved: error.moneyMoved }
              : {}),
          }),
        );
      }
    } else {
      const errorCode =
        taskInvocation && error instanceof TaskCommandError && error.prefixCode
          ? errorCodeOf(error)
          : undefined;
      runIo.stderr(
        errorCode !== undefined && !message.startsWith(`${errorCode}: `)
          ? `${errorCode}: ${message}`
          : message,
      );
    }
    if (shouldAutoUploadAfterFailure(argv.filter((argument) => argument !== "--json"))) {
      await autoUploadBackup(io, json, dependencies);
    }
    return code;
  }
}

export function redactDetachedRunValue<T>(value: T, environment: NodeJS.ProcessEnv): T {
  return redactRunValue(value, environment);
}

/** Redacts one output line of a detached child; a JSON line stays valid JSON. */
function redactDetachedRunText(value: string, environment: NodeJS.ProcessEnv): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      return JSON.stringify(redactRunValue(parsed, environment));
    }
  } catch {
    // Not a JSON line: redact it as text.
  }
  return redactRunText(value, environment);
}

function runResultFile(argv: readonly string[]): string | undefined {
  if (!((argv[0] === "agent" && argv[1] === "run") || (argv[0] === "swarm" && argv[1] === "run"))) {
    return undefined;
  }
  const indexes = argv.flatMap((argument, index) => (argument === "--result-file" ? [index] : []));
  if (indexes.length !== 1) return undefined;
  const value = argv[indexes[0]! + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

export function shouldAutoUploadBackup(args: readonly string[]): boolean {
  const command = args[0];
  const subcommand = args[1];
  if (command === "swarm") {
    return ["create", "add", "fund", "rebalance", "remove", "dissolve"].includes(subcommand ?? "");
  }
  if (command === "accounts") {
    return ["add", "import", "rename", "use", "remove", "restore", "caps", "distribute"].includes(
      subcommand ?? "",
    );
  }
  if (command === "wallet") {
    return ["create", "add", "import", "rename", "use", "remove", "restore", "caps"].includes(
      subcommand ?? "",
    );
  }
  if (command === "agent") {
    return ["create", "pause", "resume", "revoke"].includes(subcommand ?? "");
  }
  if (command === "router") {
    return subcommand === "buy" && args.includes("--auto");
  }
  return (
    command === "setup" || command === "import" || command === "login" || command === "restore"
  );
}

export function shouldAutoUploadAfterFailure(args: readonly string[]): boolean {
  if (args[0] === "swarm") {
    return ["create", "add", "fund", "rebalance", "remove", "dissolve"].includes(args[1] ?? "");
  }
  if (args[0] === "accounts") return args[1] === "add" || args[1] === "distribute";
  return args[0] === "wallet" && args[1] === "add";
}

/**
 * Creates the first wallet of a machine, `main`, together with the config. A
 * home that already has wallets is not an error: init says so and lists them,
 * without ever costing a passphrase prompt or touching an existing key.
 */
async function initCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--networks"]),
    booleanOptions: new Set(["--no-link"]),
    maximumPositionals: 0,
  });
  const networks = parseInitNetworks(parsed.one("--networks") ?? "base");
  if (networks.includes("solana")) throw new UsageError(SOLANA_VAULT_UNAVAILABLE);
  const enableArc = networks.includes("arc");
  if (!json) showBanner(io);
  const paths = getVapiPaths();
  if (!process.env.VAPI_HOME?.trim()) {
    await migrateLegacyVapiHome({ targetDirectory: paths.directory, notice: io.stderr });
  }
  // WalletStore.open moves a 0.2.x keystore.json into wallets/main.json, so an
  // upgraded home is never mistaken for an empty one.
  const store = await openWalletStore(dependencies);
  if (store.names().length > 0) {
    await reportExistingWallets(store, json, io, dependencies);
    return;
  }

  if (!json) io.stdout(CUSTODY_NOTICE);
  const created = await store.create(DEFAULT_WALLET_NAME, "");
  await recordAudit(dependencies, "wallet.create", { wallet: created.name });
  const account = created.account;
  // Before any network call: the phrase must survive a registry outage.
  if (!json) await showRecoveryPhrase(created.recoveryPhrase, io, dependencies);
  if (!(await fileExists(paths.config))) {
    await writeDefaultConfig(paths.config, process.env, { networks });
  } else {
    if (enableArc) await enableDefaultNetwork("arc", paths.config);
  }
  const configRewrites = await migrateLegacyRegistryConfig(paths.config);

  const config = await readConfig(paths.config, io);
  const accounts = await listAccounts({
    address: account.address,
    ...(account.solana ? { solanaAddress: account.solana.address } : {}),
    config,
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
  });
  const result = {
    wallet: created.name,
    address: account.address,
    accounts,
    config: paths.config,
    vault: join(paths.directory, "vault.json"),
    ...(configRewrites.length > 0 ? { configRewrites } : {}),
    custody: "self",
    warning: CUSTODY_NOTICE,
    recoveryPhrase: "hidden",
    message: "vAPI wallet created. Its encrypted key stays on this machine.",
    nextSteps: buildNextSteps(account.address),
  };
  if (json) {
    const link = await offerDashboardLink({
      name: created.name,
      json,
      noLink: parsed.has("--no-link"),
      io,
      dependencies,
    });
    io.stdout(JSON.stringify({ ...result, ...link }));
    return;
  }

  if (configRewrites.length > 0) io.stdout(formatLegacyRegistryRewrites(configRewrites));
  io.stdout(walletHeader({ name: created.name, address: account.address }));
  io.stdout(result.message);
  io.stdout(`Address: ${result.address}`);
  io.stdout(
    "Fund the EVM address with USDC and a little ETH for gas on Base mainnet (eip155:8453).",
  );
  if (account.solana) {
    io.stdout(`Solana address: ${account.solana.address}`);
    io.stdout(
      "Fund it with Solana USDC; x402 fees are facilitator-sponsored, while sweeps need a little SOL.",
    );
  }
  io.stdout(`Config: ${paths.config}`);
  io.stdout(`Vault: ${result.vault}`);
  io.stdout(formatAccounts(accounts));
  io.stdout("");
  io.stdout(result.nextSteps.join("\n"));
  await offerDashboardLink({
    name: created.name,
    json,
    noLink: parsed.has("--no-link"),
    io,
    dependencies,
  });
}

const INIT_ALREADY_DONE = "This machine already has a wallet, so vapi init created nothing.";

/** What `vapi init` says on a home that is already set up. */
async function reportExistingWallets(
  store: WalletStore,
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const wallets = await store.list();
  const unlocked = await unlockedWallets(store, wallets, dependencies);
  if (json) {
    io.stdout(
      JSON.stringify({
        ...walletListResult(store, wallets, unlocked),
        message: INIT_ALREADY_DONE,
      }),
    );
    return;
  }
  io.stdout(INIT_ALREADY_DONE);
  io.stdout(formatWalletList(wallets, unlocked));
  io.stdout("");
  io.stdout("Add another account with vapi accounts add <name>.");
}

const WALLET_ALIAS_NOTICE = "vapi wallet is now vapi accounts.";
const WALLET_USAGE =
  "Usage: vapi accounts [list|add|import|rename|use|remove|restore|caps|distribute] …";

/** Hidden compatibility alias for the account manager. */
async function walletCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const subcommand = argv[0];
  const rest = argv.slice(1);
  io.stderr(WALLET_ALIAS_NOTICE);
  if (subcommand === undefined) {
    await accountsCommand([], json, io, dependencies);
    return;
  }
  const mapped = subcommand === "create" ? "add" : subcommand;
  if (!["list", "add", "import", "use", "rename", "remove", "restore", "caps"].includes(mapped)) {
    throw new UsageError(
      `Unknown wallet subcommand ${JSON.stringify(subcommand)}. ${WALLET_USAGE}`,
    );
  }
  if (subcommand === "create") {
    await accountsAddCommand(rest, json, io, dependencies, { link: "offer" });
    return;
  }
  await accountsCommand([mapped, ...rest], json, io, dependencies);
}

/**
 * Which wallets an agent can already pay from without a prompt: the ones whose
 * passphrase is in the OS secret store. Asking never reads the passphrase
 * itself, and a platform or a keyring that cannot answer simply reports none.
 */
async function unlockedWallets(
  walletsStore: WalletStore,
  wallets: readonly { name: string }[],
  dependencies: CliDependencies,
): Promise<Set<string>> {
  const secrets = getSecretStore(dependencies);
  const unlocked = new Set<string>();
  if (!secrets.available) return unlocked;
  try {
    const vaultKeyAvailable = await secrets.has(VAULT_KEY_ACCOUNT);
    for (const wallet of wallets) {
      if (await walletsStore.hasVaultAccount(wallet.name)) {
        if (vaultKeyAvailable) unlocked.add(wallet.name);
      } else if (await secrets.has(wallet.name)) {
        unlocked.add(wallet.name);
      }
    }
  } catch {
    // An unreachable keyring is reported as "not unlocked", never as a
    // failure of the listing itself.
  }
  return unlocked;
}

/**
 * Creates another wallet on this machine, with the same custody notice and
 * the same one-time phrase as `vapi init`.
 * No network call: a fresh wallet has nothing to look up.
 */
export async function walletCreateCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--networks", "--label"]),
    maximumPositionals: 1,
  });
  const name = assertWalletName(
    requiredPositional(
      parsed.positionals[0],
      "<name>",
      "Usage: vapi accounts add <name> [--label <text>] [--no-link] [--json]",
    ),
  );
  const networks = parseInitNetworks(parsed.one("--networks") ?? "base");
  if (networks.includes("solana")) throw new UsageError(SOLANA_VAULT_UNAVAILABLE);
  const enableArc = networks.includes("arc");
  const label = parsed.one("--label");
  const paths = getVapiPaths();
  const store = await openWalletStore(dependencies);
  if (store.has(name)) {
    throw new KeystoreError(`Wallet ${name} already exists. Choose another name.`);
  }

  if (!json) io.stdout(CUSTODY_NOTICE);
  const created = await store.create(name, "", {
    ...(label === undefined ? {} : { label }),
  });
  await recordAudit(dependencies, "wallet.create", { wallet: created.name });
  const account = created.account;
  if (!json) await showRecoveryPhrase(created.recoveryPhrase, io, dependencies);

  if (!(await fileExists(paths.config))) {
    await writeDefaultConfig(paths.config, process.env, { networks });
  } else {
    if (enableArc) await enableDefaultNetwork("arc", paths.config);
  }

  const isDefault = store.defaultName === created.name;
  const result = {
    address: account.address,
    ...(account.solana ? { solanaAddress: account.solana.address } : {}),
    vault: join(paths.directory, "vault.json"),
    ...(label === undefined ? {} : { label }),
    spendCaps: created.entry.spendCaps,
    isDefault,
    custody: "self",
    warning: CUSTODY_NOTICE,
    recoveryPhrase: "hidden",
    message: `Wallet ${created.name} created. Its encrypted key stays on this machine.`,
  };
  outputForWallet(
    io,
    json,
    { name: created.name, address: account.address },
    result,
    [
      result.message,
      `Address: ${account.address}`,
      ...(account.solana ? [`Solana address: ${account.solana.address}`] : []),
      `Vault: ${result.vault}`,
      `Spend caps: ${formatCaps(created.entry.spendCaps)}`,
      isDefault
        ? "It is the default wallet."
        : `Pay from it with vapi pay <ref> --account ${created.name}, or make it the default with vapi accounts use ${created.name}.`,
    ].join("\n"),
  );
}

/** Compatibility export for the agent command while account management moves modules. */
export async function walletCapsCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  await accountsCapsCommand(argv, json, io, dependencies);
}

function capsInUsd(caps: SpendCaps): { perCallUsd: string; perDayUsd: string } {
  return {
    perCallUsd: formatUsdc(BigInt(caps.perCallAtomic)),
    perDayUsd: formatUsdc(BigInt(caps.perDayAtomic)),
  };
}

function formatCaps(caps: SpendCaps): string {
  const usd = capsInUsd(caps);
  return `${usd.perCallUsd} USD per call, ${usd.perDayUsd} USD per day`;
}

function walletListResult(
  store: WalletStore,
  wallets: readonly WalletInfo[],
  unlocked: ReadonlySet<string>,
): { default: string | null; vault: string; wallets: unknown[] } {
  return {
    default: store.defaultName ?? null,
    vault: join(store.home, "vault.json"),
    wallets: wallets.map((wallet) => ({
      name: wallet.name,
      ...(wallet.address === undefined ? {} : { address: wallet.address }),
      ...(wallet.solanaAddress === undefined ? {} : { solanaAddress: wallet.solanaAddress }),
      isDefault: wallet.isDefault,
      unlocked: unlocked.has(wallet.name),
      ...(wallet.label === undefined ? {} : { label: wallet.label }),
      createdAt: wallet.createdAt,
      spendCaps: wallet.spendCaps,
      ...capsInUsd(wallet.spendCaps),
    })),
  };
}

/**
 * One row per wallet: the default marked, the caps in dollars, whether an
 * agent can already unlock it, and the label last.
 */
function formatWalletList(wallets: readonly WalletInfo[], unlocked: ReadonlySet<string>): string {
  if (wallets.length === 0) return "No wallets yet. Run vapi init.";
  return [
    "  NAME\tADDRESS\tPER-CALL USD\tPER-DAY USD\tUNLOCKED\tLABEL",
    ...wallets.map((wallet) => {
      const usd = capsInUsd(wallet.spendCaps);
      return [
        `${wallet.isDefault ? "*" : " "} ${wallet.name}`,
        wallet.address ?? "unreadable",
        usd.perCallUsd,
        usd.perDayUsd,
        unlocked.has(wallet.name) ? "yes" : "no",
        wallet.label ?? "",
      ].join("\t");
    }),
    "",
    "* is the default wallet. Change it with vapi accounts use <name>.",
    "UNLOCKED says whether an agent can pay from it without a prompt; see vapi unlock.",
  ].join("\n");
}

/**
 * The Base USDC balance of an address, read the way `vapi accounts` reads it,
 * so removing a wallet can refuse to walk away from money.
 */
export function baseUsdcBalanceReader(
  config: VapiConfig,
  dependencies: CliDependencies,
): WalletBalanceReader {
  return async (address: string) => {
    const accounts = await listAccounts({
      address,
      config,
      ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
    });
    const base = accounts.find((account) => account.caip2 === BASE_MAINNET_CAIP2);
    if (!base?.usdcBalance) {
      throw new KeystoreError(
        [
          `Could not read the USDC balance of ${address} on Base${base?.error ? `: ${base.error}` : "."}`,
          "Re-run with --force to remove the wallet anyway.",
        ].join("\n"),
      );
    }
    return BigInt(base.usdcBalance.atomic);
  };
}

/**
 * Hand out the hosted funding page. No registry call: the page itself mints the
 * card session when the human clicks, so this works offline and the link never
 * expires in a scrollback.
 */
async function fundCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--amount", WALLET_OPTION]),
    maximumPositionals: 0,
  });
  const amount = optionalUsdAmount(parsed.one("--amount"), "--amount");
  const target = await targetWallet(parsed, dependencies);
  const { account } = await unlockTarget(target, dependencies);
  const url = fundingPageUrl(
    resolveRegistryUrl(),
    account.address,
    amount === undefined ? {} : { amount },
  );
  const opened = Boolean(process.stdout.isTTY) && openInBrowser(url);
  const result = { address: account.address, network: ONRAMP_NETWORK, url };
  outputForWallet(io, json, target, result, formatFund(result.address, url, opened));
}

async function searchCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--kind", "--network", "--limit", "--cursor"]),
    booleanOptions: new Set([INCLUDE_UNVERIFIED_OPTION, INCLUDE_OUTAGE_OPTION]),
    repeatableOptions: new Set(["--kind"]),
    maximumPositionals: 1,
  });
  const limit = optionalPositiveInteger(parsed.one("--limit"), "--limit");
  const config = await readConfig(getVapiPaths().config, io);
  const input: MarketplaceSearchInput = {
    ...(parsed.positionals[0] ? { query: parsed.positionals[0] } : {}),
    ...(parsed.many("--kind").length > 0
      ? { kinds: parsed.many("--kind") as Array<"api" | "service_offer" | "open_request"> }
      : {}),
    ...(parsed.one("--network") ? { network: parsed.one("--network") } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(parsed.one("--cursor") ? { cursor: parsed.one("--cursor") } : {}),
    // Only the opt-in travels: `false` is the registry default.
    ...(parsed.has(INCLUDE_UNVERIFIED_OPTION) ? { includeUnverified: true } : {}),
    ...(parsed.has(INCLUDE_OUTAGE_OPTION) ? { includeOutage: true } : {}),
  };
  const call = createCallPort({
    config,
    fetchImpl: dependencies.fetchImpl,
    searchesPath: getVapiPaths().searches,
    notice: io.stderr,
    resolvePayment: unavailableCliPayment,
  });
  const page = await runAction(
    callSearch,
    actionInputOrFallback(callSearch, input, {}),
    cliActionContext(config, pinSearchInput(call, input), dependencies),
  );
  output(io, json, page, formatSearch(page));
}

async function inspectCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--endpoint"]),
    maximumPositionals: 1,
  });
  const id = requiredPositional(
    parsed.positionals[0],
    "<id>",
    "Usage: vapi inspect <id> [--endpoint <name>]",
  );
  const config = await readConfig(getVapiPaths().config, io);
  const input: InspectToolInput = {
    id,
    ...(parsed.one("--endpoint") ? { endpoint: parsed.one("--endpoint") } : {}),
  };
  const call = createCallPort({
    config,
    fetchImpl: dependencies.fetchImpl,
    resolvePayment: unavailableCliPayment,
  });
  const result = await runAction(
    callInspect,
    actionInputOrFallback(callInspect, input, { id }),
    cliActionContext(config, pinInspectInput(call, input), dependencies),
  );
  output(io, json, result, formatInspect(result));
}

const PAY_USAGE =
  "Usage: vapi pay <id-or-url> [--method <method>] [--endpoint <name>] [--body <json>] [--content-type <type>] [--network <caip2>] [--expected-pay-to <address>] [--max <amount>] [--timeout <seconds>] [--account <name>] [--json]";

async function payCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  if (argv.includes(RESUME_OPTION)) {
    await payResumeCommand(argv, json, io, dependencies);
    return;
  }
  const parsed = parseArguments(argv, {
    valueOptions: new Set([
      "--method",
      "--endpoint",
      "--body",
      "--content-type",
      "--network",
      "--expected-pay-to",
      "--max",
      "--max-price-usd",
      "--timeout",
      WALLET_OPTION,
    ]),
    maximumPositionals: 1,
  });
  const target = requiredPositional(parsed.positionals[0], "<id-or-url>", PAY_USAGE);
  const timeoutSeconds = optionalBoundedInteger(parsed.one("--timeout"), "--timeout", 1, 300);
  const paths = getVapiPaths();
  const config = await readConfig(paths.config, io);
  const wallet = await targetWallet(parsed, dependencies);
  const spendCaps = await spendCapsForWallet(wallet.store, wallet.name);
  const { account } = await unlockTarget(wallet, dependencies);
  const bodyText = parsed.one("--body");
  const maxPriceUsd = aliasedOption(parsed, "--max", "--max-price-usd");
  const input: CallToolInput = {
    ...(isHttpUrl(target) ? { url: target } : { id: target }),
    ...(parsed.one("--method") ? { method: parsed.one("--method") } : {}),
    ...(parsed.one("--endpoint") ? { endpoint: parsed.one("--endpoint") } : {}),
    ...(bodyText === undefined ? {} : { body: parseJson(bodyText, "--body") }),
    ...(parsed.one("--content-type") ? { contentType: parsed.one("--content-type") } : {}),
    ...(parsed.one("--network") ? { network: parsed.one("--network") } : {}),
    ...(parsed.one("--expected-pay-to") ? { expectedPayTo: parsed.one("--expected-pay-to") } : {}),
    ...(maxPriceUsd ? { maxPriceUsd } : {}),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
  };
  const call = createCallPort({
    config,
    fetchImpl: dependencies.fetchImpl,
    resolvePayment: async () => ({
      account,
      wallet: wallet.name,
      spendCaps,
      ledgerPath: paths.ledger,
      receiptsPath: paths.receipts,
      fetchImpl:
        dependencies.fetchImpl ??
        createPublicFetch({ allowPrivateNetwork: config.allowPrivateNetwork ?? false }),
      ceilingSweep: {
        account: wallet.name,
        auditHome: wallet.store.home,
        run: async (signal) =>
          await (dependencies.ceiling?.sweepAboveCeiling ?? sweepAboveCeiling)({
            store: wallet.store,
            secrets: getSecretStore(dependencies),
            apiBase: wallet.entry.link?.apiBase ?? registryBaseUrl(config),
            account: wallet.name,
            config,
            signal,
            resolveParent: swarmParentResolver(wallet.store.home),
            ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
            ...(dependencies.ceiling?.balanceReader === undefined
              ? {}
              : { balanceReader: dependencies.ceiling.balanceReader }),
            ...(dependencies.ceiling?.fetchSiblingsImpl === undefined
              ? {}
              : { fetchSiblingsImpl: dependencies.ceiling.fetchSiblingsImpl }),
            ...(dependencies.ceiling?.transfer === undefined
              ? {}
              : { transfer: dependencies.ceiling.transfer }),
            unlock: async () => account,
            ...(dependencies.ceiling?.timeoutMs === undefined
              ? {}
              : { timeoutMs: dependencies.ceiling.timeoutMs }),
          }),
      },
    }),
  });
  const actionInput = actionInputOrFallback(
    callPay,
    input,
    isHttpUrl(target) ? { url: target } : { id: target },
  );
  const { wallet: _resolvedWallet, ...result } = await runAction(
    callPay,
    actionInput,
    cliActionContext(config, pinPayInput(call, input), dependencies),
  );
  void _resolvedWallet;
  const { hints: _hints, ...humanResult } = result;
  void _hints;
  outputForWallet(
    io,
    json,
    wallet,
    result as unknown as Record<string, unknown>,
    [...verificationNotice(result.verification), JSON.stringify(humanResult, null, 2)].join("\n"),
  );
  await (dependencies.ceiling?.drainCeilingSweeps ?? drainCeilingSweeps)(10_000).catch(
    () => undefined,
  );
}

/**
 * The CLI historically lets the call implementation validate its raw input.
 * Keep that exact error surface while still routing execution and policy
 * through the shared register: runAction parses a harmless fallback when its
 * MCP schema is stricter, while this one-command port forwards the original.
 */
function actionInputOrFallback<I>(
  action: { input: { safeParse(input: unknown): { success: boolean } } },
  input: I,
  fallback: I,
): I {
  return action.input.safeParse(input).success ? input : fallback;
}

function cliActionContext(
  config: VapiConfig,
  call: CallPort,
  dependencies: CliDependencies,
): ActionContext {
  return {
    config,
    ...(dependencies.fetchImpl === undefined ? {} : { fetch: dependencies.fetchImpl }),
    clock: () => new Date(),
    call,
    caller: { surface: "cli" },
  };
}

function pinSearchInput(call: CallPort, input: MarketplaceSearchInput): CallPort {
  return { ...call, search: async () => await call.search(input) };
}

function pinInspectInput(call: CallPort, input: InspectToolInput): CallPort {
  return { ...call, inspect: async () => await call.inspect(input) };
}

function pinPayInput(call: CallPort, input: CallToolInput): CallPort {
  return { ...call, pay: async () => await call.pay(input) };
}

async function unavailableCliPayment(): Promise<never> {
  throw new Error("Payment is unavailable for this CLI action.");
}

const CHECK_USAGE = "Usage: vapi check <url> [--method <method>]";

/**
 * A local x402 conformance doctor for a provider's own API. Returns the exit
 * code itself: a failed rule is a `1` with the whole report, not a thrown error.
 */
async function checkCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--method"]),
    maximumPositionals: 1,
  });
  const url = requiredPositional(parsed.positionals[0], "<url>", CHECK_USAGE);
  if (!isHttpUrl(url)) throw new UsageError(`vapi check takes an http(s) URL. ${CHECK_USAGE}`);
  const method = (parsed.one("--method") ?? "GET").trim().toUpperCase();
  if (!(MARKETPLACE_EXECUTION_METHODS as readonly string[]).includes(method)) {
    throw new UsageError(`--method must be one of ${MARKETPLACE_EXECUTION_METHODS.join(", ")}.`);
  }
  const config = await readConfig(getVapiPaths().config, io);
  const fetchImpl =
    dependencies.fetchImpl ??
    createPublicFetch({ allowPrivateNetwork: config.allowPrivateNetwork ?? false });
  let report: Awaited<ReturnType<typeof checkX402>>;
  try {
    report = await checkX402(new URL(url), { method, fetchImpl });
  } catch (error) {
    throw new Error(
      `Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  output(io, json, report, formatCheckReport(report));
  return report.summary.fail > 0 ? 1 : 0;
}

const RESUME_OPTION = "--resume";

const SETTLEMENT_STATE_WORDS = {
  settled:
    "Settled: the authorization was used on-chain, so the payment went through (or the payer cancelled it, which this client never does). Do not pay again.",
  expired:
    "Expired: the authorization was never used and can no longer settle. Paying again is safe.",
  pending: "Pending: the authorization is unused but can still settle.",
} as const;

/**
 * `vapi pay --resume <receipt-id>`: after a paid call lost its response, asks
 * the chain whether the signed authorization settled before anyone pays again.
 * It reads only — no wallet is unlocked, nothing is signed or paid.
 */
async function payResumeCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set([RESUME_OPTION]),
    maximumPositionals: 0,
  });
  const id = parsed.one(RESUME_OPTION)!;
  const paths = getVapiPaths();
  const receipt = (await readReceipts(paths.receipts)).find((candidate) => candidate.id === id);
  if (receipt === undefined) {
    throw new Error(
      `No receipt ${JSON.stringify(id)} in ${paths.receipts}. vapi receipts lists them.`,
    );
  }
  const config = await readConfig(paths.config, io);
  const check = await checkReceiptSettlement(receipt, config, {
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
  });
  const validBeforeAt = new Date(Number(check.validBefore) * 1_000).toISOString();
  const message =
    check.state === "pending"
      ? `${SETTLEMENT_STATE_WORDS.pending} Wait until ${validBeforeAt}, then run vapi pay --resume ${id} again; paying now could pay twice.`
      : SETTLEMENT_STATE_WORDS[check.state];
  outputForWallet(
    io,
    json,
    { name: receiptWallet(receipt) },
    {
      receipt: id,
      resourceUrl: receipt.resourceUrl,
      ...(receipt.paymentId ? { paymentId: receipt.paymentId } : {}),
      ...check,
      validBeforeAt,
      message,
    },
    [
      `Receipt: ${id} — ${receipt.method ?? "call"} ${receipt.resourceUrl}`,
      ...(receipt.paymentId ? [`Payment id: ${receipt.paymentId}`] : []),
      `Authorization: nonce ${check.nonce} from ${check.authorizer}, USDC ${check.token} on ${check.network}, valid before ${validBeforeAt}`,
      message,
    ].join("\n"),
  );
}

async function balanceCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set([WALLET_OPTION]),
    maximumPositionals: 0,
  });
  const paths = getVapiPaths();
  const config = await readConfig(paths.config, io);
  const target = await targetWallet(parsed, dependencies);
  const { account } = await unlockTarget(target, dependencies);
  const wallet = await getWallet(account, config, dependencies);
  outputForWallet(io, json, target, wallet, formatWallet(wallet));
}

const ALL_WALLETS_OPTION = "--all-wallets";

/**
 * The wallet a ledger view is filtered by, or `undefined` for all of them.
 * A home that has no wallet yet — receipts copied in, or a fresh checkout —
 * reads every row rather than failing, but an explicit `--account` still must
 * name a wallet that exists.
 */
async function ledgerWallet(
  parsed: { one(name: string): string | undefined; has(name: string): boolean },
  dependencies: CliDependencies,
): Promise<WalletTarget | undefined> {
  if (parsed.has(ALL_WALLETS_OPTION)) {
    if (parsed.one(WALLET_OPTION) !== undefined) {
      throw new UsageError(`${ACCOUNT_OPTION} and ${ALL_WALLETS_OPTION} cannot be used together.`);
    }
    return undefined;
  }
  const store = await openWalletStore(dependencies);
  if (parsed.one(WALLET_OPTION) === undefined && store.names().length === 0) return undefined;
  return await selectWallet(store, parsed, dependencies);
}

async function receiptsCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  if (argv[0] === "export") {
    await receiptsExportCommand(argv.slice(1), io, dependencies);
    return;
  }
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--limit", WALLET_OPTION]),
    booleanOptions: new Set([ALL_WALLETS_OPTION]),
    maximumPositionals: 0,
  });
  const limit = optionalNonNegativeInteger(parsed.one("--limit"), "--limit");
  const target = await ledgerWallet(parsed, dependencies);
  const receipts = await readReceipts(getVapiPaths().receipts, {
    ...(limit === undefined ? {} : { limit }),
    ...(target === undefined ? {} : { wallet: target.name }),
  });
  const human = receipts.length === 0 ? "No receipts." : receipts.map(formatReceipt).join("\n");
  if (target === undefined) {
    output(io, json, receipts, human);
    return;
  }
  if (json) {
    io.stdout(JSON.stringify({ wallet: target.name, receipts }));
    return;
  }
  io.stdout(walletHeader(target));
  io.stdout(human);
}

async function receiptsExportCommand(
  argv: string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--format", "--range", WALLET_OPTION]),
    booleanOptions: new Set([ALL_WALLETS_OPTION]),
    maximumPositionals: 0,
  });
  const format = parsed.one("--format");
  if (format !== "json" && format !== "csv") {
    throw new UsageError("--format must be json or csv.");
  }
  const rangeValue = parsed.one("--range");
  const range = rangeValue === undefined ? undefined : parseStatsRange(rangeValue);
  const target = await ledgerWallet(parsed, dependencies);
  const allReceipts = await readReceipts(getVapiPaths().receipts, {
    ...(target === undefined ? {} : { wallet: target.name }),
  });
  const receipts = range ? filterReceiptsByRange(allReceipts, range) : allReceipts;
  io.stdout(format === "json" ? JSON.stringify(receipts) : receiptsToCsv(receipts));
}

async function statsCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--range", WALLET_OPTION]),
    booleanOptions: new Set([ALL_WALLETS_OPTION]),
    maximumPositionals: 0,
  });
  const range = parseStatsRange(parsed.one("--range") ?? "24h");
  const paths = getVapiPaths();
  const target = await ledgerWallet(parsed, dependencies);
  const stats = aggregateStats({
    receipts: await readReceipts(paths.receipts, {
      ...(target === undefined ? {} : { wallet: target.name }),
    }),
    searches: await readSearchEvents(paths.searches),
    range,
  });
  const network = await fetchNetworkStats(dependencies);
  if (target === undefined) {
    output(io, json, { ...stats, network }, formatStats(stats, network));
    return;
  }
  outputForWallet(io, json, target, { ...stats, network }, formatStats(stats, network));
}

const NETWORK_STATS_REQUEST_TIMEOUT_MS = 3_000;
const DECIMAL_STATS_VALUE = /^\d+(\.\d{1,6})?$/u;

type RoutedThroughVapiStats = {
  usd24h: string;
  usd30d: string;
  txCount: number;
};

type NetworkStats = {
  routedThroughVapi: RoutedThroughVapiStats;
};

async function fetchNetworkStats(dependencies: CliDependencies): Promise<NetworkStats | null> {
  try {
    const paths = getVapiPaths();
    const config = await readConfig(paths.config, { stdout: () => {}, stderr: () => {} });
    const baseUrl = registryBaseUrl(config);
    const url = new URL("api/call/stats", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    url.searchParams.set("range", "30d");
    const fetchImpl =
      dependencies.fetchImpl ??
      createPublicFetch({ allowPrivateNetwork: config.allowPrivateNetwork ?? false });
    const signal = AbortSignal.timeout(NETWORK_STATS_REQUEST_TIMEOUT_MS);
    const request = (async (): Promise<NetworkStats | null> => {
      const response = await fetchImpl(url, { signal });
      if (!response.ok) return null;
      const body: unknown = await response.json();
      if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
      const routed = (body as { routedThroughVapi?: unknown }).routedThroughVapi;
      if (routed === null || typeof routed !== "object" || Array.isArray(routed)) return null;
      const values = routed as {
        usd24h?: unknown;
        usd30d?: unknown;
        txCount?: unknown;
      };
      if (
        typeof values.usd24h !== "string" ||
        !DECIMAL_STATS_VALUE.test(values.usd24h) ||
        typeof values.usd30d !== "string" ||
        !DECIMAL_STATS_VALUE.test(values.usd30d) ||
        typeof values.txCount !== "number" ||
        !Number.isSafeInteger(values.txCount) ||
        values.txCount < 0
      ) {
        return null;
      }
      return {
        routedThroughVapi: {
          usd24h: values.usd24h,
          usd30d: values.usd30d,
          txCount: values.txCount,
        },
      };
    })();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), NETWORK_STATS_REQUEST_TIMEOUT_MS);
      });
      return await Promise.race([request, timedOut]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  } catch {
    return null;
  }
}

async function sweepCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--network", WALLET_OPTION]),
    maximumPositionals: 1,
  });
  const requestedNetwork = parsed.one("--network");
  const target = await targetWallet(parsed, dependencies);
  const explicitDestination = parsed.positionals[0];
  const ownerDestination = explicitDestination === undefined ? target.entry.link?.owner : undefined;
  const destination = explicitDestination ?? ownerDestination;
  if (destination === undefined) {
    throw new UsageError(
      `Usage: vapi sweep [<address>] [--network <caip2>]\nNo address was provided and wallet ${target.name} is not linked. Run vapi login first.`,
    );
  }
  const paths = getVapiPaths();
  const config = await readConfig(paths.config, io);
  if (requestedNetwork && !isNetworkConfigured(config.networks, requestedNetwork)) {
    throw new Error(`Network ${requestedNetwork} is not configured.`);
  }
  await withAccountMovementLock(target.store.home, target.name, undefined, async () => {
    await target.store.reload();
    const [unfinished] = await listUnfinishedMovements({
      home: target.store.home,
      from: target.name,
    });
    if (unfinished !== undefined) {
      throw new Error(
        `Account ${target.name} has unfinished movement ${unfinished.id}. Resume it with vapi accounts distribute --resume ${unfinished.id} before sweeping.`,
      );
    }
    if (target.store.ceilingSweepPending(target.name) !== undefined) {
      throw new Error(
        `Account ${target.name} has an unresolved automatic ceiling sweep. Run vapi status to reconcile it before sweeping.`,
      );
    }
    const { account } = await unlockTarget(target, dependencies);
    const results: Array<
      | { network: string; status: "swept"; amountAtomic: string; transaction: string }
      | { network: string; status: "error"; error: string }
    > = [];
    const gasErrors: SweepGasError[] = [];
    for (const network of requestedNetwork ? [requestedNetwork] : Object.keys(config.networks)) {
      try {
        const result = await (dependencies.sweepBack ?? sweepBack)({
          account,
          config,
          network,
          destination,
          ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
        });
        results.push({ ...result, status: "swept" });
      } catch (error) {
        if (requestedNetwork) throw error;
        if (error instanceof SweepGasError) gasErrors.push(error);
        results.push({
          network,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!results.some((result) => result.status === "swept")) {
      if (gasErrors[0]) throw gasErrors[0];
      throw new Error("No configured network had a sweepable USDC balance.");
    }
    outputForWallet(io, json, target, { results }, formatSweepResults(results, ownerDestination));
  });
}

async function reportCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(),
    booleanOptions: new Set(["--include-addresses", "--send"]),
    maximumPositionals: 1,
  });
  const message = requiredPositional(
    parsed.positionals[0],
    '"<what happened>"',
    'Usage: vapi report "<what happened>" [--include-addresses] [--send]',
  );
  const paths = getVapiPaths();
  const result = await createSupportReport({
    message,
    includeAddresses: parsed.has("--include-addresses"),
    send: parsed.has("--send"),
    receiptsPath: paths.receipts,
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
  });
  output(io, json, result, formatSupportReport(result));
}

const AUTH_USAGE = "Usage: vapi auth set-key|status|clear";

/**
 * The registry key a provider publishes with — the only credential this client
 * holds. It is handled like every other secret here: typed by a person on a
 * terminal, kept in the OS secret store when the machine has one, and never an
 * argument. Nothing in `vapi auth` ever prints the key itself.
 *
 * Written as an if-chain so the command's three credential operations stay
 * visibly separate from the top-level dispatcher.
 */
async function authCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const subcommand = argv[0];
  const rest = argv.slice(1);
  if (subcommand === "set-key") {
    await authSetKeyCommand(rest, json, io, dependencies);
    return;
  }
  if (subcommand === "status") {
    await authStatusCommand(rest, json, io, dependencies);
    return;
  }
  if (subcommand === "clear") {
    await authClearCommand(rest, json, io, dependencies);
    return;
  }
  if (subcommand === undefined) throw new UsageError(AUTH_USAGE);
  throw new UsageError(`Unknown auth subcommand ${JSON.stringify(subcommand)}. ${AUTH_USAGE}`);
}

const API_KEY_IN_ARGV =
  "vapi auth set-key reads the key from a prompt. Never pass an API key as an argument: it would stay in the shell history and be visible to every process on the machine.";

const API_KEY_NEEDS_TERMINAL = `Type the API key yourself in a terminal; an agent must never be handed one. In CI, set ${API_KEY_ENV} instead.`;

/** Takes the key on a prompt and hands it to the OS secret store, or to config.json. */
async function authSetKeyCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  if (argv.length > 0) throw new UsageError(API_KEY_IN_ARGV);
  await requireSecretsAllowed(dependencies, "auth.key.set", undefined, {
    refusal: API_KEY_NEEDS_TERMINAL,
  });
  const key = await getPrompts(dependencies).secret("vAPI API key: ");
  const stored = await storeApiKey(key, {
    store: getSecretStore(dependencies),
    configPath: getVapiPaths().config,
  });
  await recordAudit(dependencies, "auth.key.set", { detail: stored.source });
  const message = `The vAPI API key ${stored.masked} is stored in ${stored.location}.`;
  output(
    io,
    json,
    { stored: true, source: stored.source, location: stored.location, key: stored.masked, message },
    [message, "List an API with vapi publish <url>; remove the key with vapi auth clear."].join(
      "\n",
    ),
  );
}

/** Whether this machine has a key, and where it comes from. Never the key itself. */
async function authStatusCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  requireNoArguments(argv, "auth status");
  const paths = getVapiPaths();
  const status = await apiKeyStatus({
    store: getSecretStore(dependencies),
    configPath: paths.config,
  });
  const agentLink = await selectedAgentLink(dependencies);
  const linkLine =
    agentLink === undefined
      ? undefined
      : `Agent link: ${agentLink.label} linked to ${agentLink.owner} (${agentLink.scopes.join(" ")})`;
  if (!status.present) {
    const message = noApiKeyMessage(registryBaseUrl(await readConfig(paths.config, io)));
    output(
      io,
      json,
      {
        present: false,
        message,
        ...(agentLink === undefined ? {} : { agentLink }),
      },
      [message, ...(linkLine === undefined ? [] : [linkLine])].join("\n"),
    );
    return;
  }
  const message = `The vAPI API key ${status.masked} is read from ${status.location}.`;
  output(
    io,
    json,
    {
      present: true,
      source: status.source,
      location: status.location,
      key: status.masked,
      message,
      ...(agentLink === undefined ? {} : { agentLink }),
    },
    [message, ...(linkLine === undefined ? [] : [linkLine])].join("\n"),
  );
}

async function selectedAgentLink(dependencies: CliDependencies): Promise<
  | {
      wallet: WalletName;
      label: string;
      owner: `0x${string}`;
      scopes: string[];
    }
  | undefined
> {
  const store = await openWalletStore(dependencies);
  let resolved: ReturnType<typeof store.resolve>;
  try {
    resolved = store.resolve({ env: getEnvironment(dependencies) });
  } catch (error) {
    if (error instanceof KeystoreError) return undefined;
    throw error;
  }
  const link = resolved.entry.link;
  return link === undefined
    ? undefined
    : {
        wallet: resolved.name,
        label: link.label,
        owner: link.owner,
        scopes: link.scopes,
      };
}

/** Removes the key from everywhere this client put it. */
async function authClearCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  requireNoArguments(argv, "auth clear");
  const store = getSecretStore(dependencies);
  const result = await clearApiKey({ store, configPath: getVapiPaths().config });
  if (result.cleared.length > 0) {
    await recordAudit(dependencies, "auth.key.clear", { detail: result.cleared.join(", ") });
  }
  const message =
    result.cleared.length === 0
      ? "No vAPI API key was stored on this machine."
      : `Removed the vAPI API key from ${result.cleared
          .map((source) => describeApiKeySource(source, store))
          .join(" and ")}.`;
  output(
    io,
    json,
    { cleared: result.cleared, envStillSet: result.envStillSet, message },
    [
      message,
      ...(result.envStillSet
        ? [`${API_KEY_ENV} is still set in this environment; unset it to finish signing out.`]
        : []),
    ].join("\n"),
  );
}

const YES_OPTION = "--yes";

const PUBLISH_USAGE =
  "Usage: vapi publish <url> [--method <method>] [--mode <origin|endpoint|openapi>] [--name <text>] [--description <text>] [--category <ai|data|crypto|compute|search>] [--select <names>] [--account <name>] [--yes] [--resume]";

const PUBLISH_NEEDS_TERMINAL =
  "vapi publish needs a terminal to choose endpoints. Name them with --select <name,name>, or pass --yes to list every endpoint the probe found.";

/**
 * The provider side of the registry. `vapi publish <url>` probes, lets the
 * person choose, signs one payout line with the local wallet and creates the
 * listing; the three subcommands move it afterwards. Returns the exit code
 * itself, because a probe the registry refuses is a `2` with the registry's
 * own words rather than a thrown error.
 */
async function publishCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const subcommand = argv[0];
  if (subcommand === "activate") {
    await publishStatusCommand(
      argv.slice(1),
      "activate",
      "vapi publish activate <slug>",
      json,
      io,
      dependencies,
    );
    return 0;
  }
  if (subcommand === "verify-request") {
    await publishStatusCommand(
      argv.slice(1),
      "request_verification",
      "vapi publish verify-request <slug>",
      json,
      io,
      dependencies,
    );
    return 0;
  }
  if (subcommand === "list") {
    await publishListCommand(argv.slice(1), json, io, dependencies);
    return 0;
  }
  return await publishListingCommand(argv, json, io, dependencies);
}

async function publishListingCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set([
      "--method",
      "--mode",
      "--name",
      "--description",
      "--category",
      "--select",
      WALLET_OPTION,
    ]),
    booleanOptions: new Set([YES_OPTION, RESUME_OPTION]),
    maximumPositionals: 1,
  });
  const url = requiredPositional(parsed.positionals[0], "<url>", PUBLISH_USAGE);
  if (!isHttpUrl(url)) {
    throw new UsageError(
      "vapi publish takes the http(s) URL of the API you own: its origin, one endpoint, or an OpenAPI document.",
    );
  }
  const method = parsed.one("--method");
  const mode = parseProbeMode(parsed.one("--mode"));
  const { client, baseUrl } = await listingsClient(io, dependencies, parsed);

  const probe = await client.probe({
    url,
    ...(method === undefined ? {} : { method }),
    ...(mode === undefined ? {} : { mode }),
  });
  const steps = formatProbeSteps(probe);
  if (!json) {
    io.stdout(`Probe: ${url}`);
    for (const line of steps) io.stdout(line);
  }
  const rejection = readProbeRejection(probe);
  if (rejection) {
    if (json) {
      io.stdout(JSON.stringify({ probe }));
      return 2;
    }
    io.stderr(formatProbeRejection(rejection));
    return 2;
  }

  const operations = readProbeOperations(probe);
  if (operations.length === 0) {
    throw new Error(
      `The probe found no callable endpoint behind ${url}. Point vapi publish at one endpoint, or at an OpenAPI document that describes them.`,
    );
  }
  const interactive = !json && isInteractive(dependencies);
  const selected = await selectOperations(operations, {
    select: parsed.one("--select"),
    all: parsed.has(YES_OPTION),
    interactive,
    io,
    dependencies,
  });
  const asking = interactive && !parsed.has(YES_OPTION);
  const name = await publishField(parsed.one("--name") ?? probeString(probe, ["name", "title"]), {
    asking,
    prompt: "Listing name: ",
    missing: "vapi publish needs a name for the listing: --name <text>.",
    dependencies,
  });
  const description = await publishField(
    parsed.one("--description") ?? probeString(probe, ["description", "summary"]),
    {
      asking,
      prompt: "One-line description: ",
      missing: "vapi publish needs a description: --description <text>.",
      dependencies,
    },
  );
  const category = parseCategory(
    await publishField(parsed.one("--category") ?? probeCategory(probe), {
      asking,
      prompt: `Category (${LISTING_CATEGORIES.join(", ")}): `,
      missing: `vapi publish needs a category: --category <${LISTING_CATEGORIES.join("|")}>.`,
      dependencies,
    }),
  );

  const batches = publishBatches(
    selected.map((operation) => toListingEndpoint(operation, description)),
    name,
  );
  // --resume trusts the registry's own record of what this key already lists,
  // so a run that stopped halfway, for whatever reason, picks up exactly there.
  const listed = parsed.has(RESUME_OPTION)
    ? listedEndpointSlugs(await client.mine())
    : new Map<string, string>();
  const results: PublishedEndpoint[] = [];
  const pending = batches.map((batch) => ({
    name: batch.name,
    endpoints: batch.endpoints.filter((endpoint) => {
      const slug = listed.get(endpointKey(endpoint));
      if (slug !== undefined) results.push(endpointResult(endpoint, "skipped", { slug }));
      return slug === undefined;
    }),
  }));
  const say = (line: string) => {
    if (!json) io.stdout(line);
  };
  if (!json) io.stdout("");
  for (const result of results) say(formatPublishedEndpoint(result));
  if (pending.every((batch) => batch.endpoints.length === 0)) {
    const message = "Every selected endpoint is already listed by this key; nothing was signed.";
    if (json) io.stdout(JSON.stringify({ probe, listings: [], results, message }));
    else io.stdout(message);
    return 0;
  }

  const wallet = await targetWallet(parsed, dependencies);
  const { account } = await unlockTarget(wallet, dependencies);
  const payoutWallet = requireEvmAddress(account.address, wallet.name);
  say(walletHeader(wallet));
  if (batches.length > 1) {
    say(
      `Publishing ${selected.length} endpoints as ${batches.length} listings of up to ${PUBLISH_BATCH_SIZE} each.`,
    );
  }

  // One listing per batch, each with its own nonce and its own signature of
  // the same payout line. A batch the registry refuses on its merits does not
  // stop the next one; a refusal that would repeat (a bad key, a rate limit)
  // or an outage does, and --resume picks up from there.
  const created: CreatedListing[] = [];
  const failures: Error[] = [];
  let stopped = false;
  for (const batch of pending) {
    if (batch.endpoints.length === 0) continue;
    if (stopped) {
      for (const endpoint of batch.endpoints) {
        const result = endpointResult(endpoint, "not_attempted");
        results.push(result);
        say(formatPublishedEndpoint(result));
      }
      continue;
    }
    let listing: CreatedListing;
    try {
      const nonce = await client.payoutNonce(payoutWallet);
      const siweMessage = payoutSiweMessage(nonce, baseUrl, payoutWallet, dependencies);
      const signature = await account.signMessage({ message: siweMessage });
      listing = await client.create({
        name: batch.name,
        description,
        category,
        endpoints: batch.endpoints,
        payoutWallet,
        siweMessage,
        signature,
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      failures.push(failure);
      stopped = !refusedOnItsMerits(failure);
      for (const endpoint of batch.endpoints) {
        const result = endpointResult(endpoint, "failed", { error: failure.message });
        results.push(result);
        say(formatPublishedEndpoint(result));
      }
      continue;
    }
    created.push(listing);
    const slug = listingSlug(listing);
    await recordAudit(dependencies, "listing.publish", {
      wallet: wallet.name,
      detail: slug ?? url,
    });
    for (const endpoint of batch.endpoints) {
      const result = endpointResult(endpoint, "listed", slug === undefined ? {} : { slug });
      results.push(result);
      say(formatPublishedEndpoint(result));
    }
    say(formatCreatedListing(listing, batch.name, payoutWallet, batch.endpoints.length));
  }

  const failed = failures.length > 0;
  const resumeHint = `Run the same vapi publish command with ${RESUME_OPTION} to list the rest; it skips what is already listed.`;

  if (json) {
    io.stdout(
      JSON.stringify({
        wallet: wallet.name,
        probe,
        listings: created,
        results,
        ...(failed
          ? {
              error: [...new Set(failures.map((failure) => failure.message))].join("\n"),
              exitCode: 1,
            }
          : {}),
      }),
    );
    return failed ? 1 : 0;
  }
  if (created.length > 0) {
    for (const line of formatDescriptionWarnings(created[0]!)) io.stdout(line);
    io.stdout("vAPI Call takes no fee. Providers are paid directly.");
    io.stdout(`Set each endpoint's payTo to your payout wallet ${payoutWallet}, then run:`);
    for (const listing of created) {
      io.stdout(`  vapi publish activate ${listingSlug(listing) ?? "<slug>"}`);
    }
  }
  if (!failed) return 0;
  for (const message of new Set(failures.map((failure) => failure.message))) io.stderr(message);
  if (batches.length > 1 || created.length > 0) io.stderr(resumeHint);
  return 1;
}

/** The registry's cap on endpoints per listing; a larger catalog becomes several. */
const PUBLISH_BATCH_SIZE = 20;
/** The registry's cap on a listing name. */
const LISTING_NAME_MAX_LENGTH = 100;

type ListingBatch = { name: string; endpoints: ListingEndpointInput[] };

/**
 * Splits the chosen endpoints, in probe order, into listings of at most
 * {@link PUBLISH_BATCH_SIZE}. A catalog that fits keeps its name; a larger one
 * is numbered `Name (2/4)`. The split depends only on the selection, so a
 * resumed run numbers every batch the way the first run did.
 */
function publishBatches(endpoints: readonly ListingEndpointInput[], name: string): ListingBatch[] {
  const count = Math.ceil(endpoints.length / PUBLISH_BATCH_SIZE);
  return Array.from({ length: count }, (_, index) => {
    const suffix = count === 1 ? "" : ` (${index + 1}/${count})`;
    return {
      name: `${name.slice(0, LISTING_NAME_MAX_LENGTH - suffix.length).trimEnd()}${suffix}`,
      endpoints: endpoints.slice(index * PUBLISH_BATCH_SIZE, (index + 1) * PUBLISH_BATCH_SIZE),
    };
  });
}

/** One endpoint by what makes it callable: its method and its URL. */
function endpointKey(endpoint: { method?: unknown; url?: unknown }): string {
  const method = typeof endpoint.method === "string" ? endpoint.method.toUpperCase() : "GET";
  const url = typeof endpoint.url === "string" ? endpoint.url : "";
  try {
    return `${method} ${new URL(url).href}`;
  } catch {
    return `${method} ${url}`;
  }
}

/** Every endpoint this key already lists, mapped to the slug that lists it. */
function listedEndpointSlugs(mine: MyListings): Map<string, string> {
  const listed = new Map<string, string>();
  for (const listing of Array.isArray(mine.listings) ? mine.listings : []) {
    if (typeof listing !== "object" || listing === null) continue;
    const { slug, endpoints } = listing as { slug?: unknown; endpoints?: unknown };
    if (typeof slug !== "string" || !Array.isArray(endpoints)) continue;
    for (const endpoint of endpoints) {
      if (typeof endpoint === "object" && endpoint !== null) {
        listed.set(endpointKey(endpoint as Record<string, unknown>), slug);
      }
    }
  }
  return listed;
}

/**
 * A refusal of this batch alone — a 4xx about its content — rather than one
 * every later batch would meet too: a rejected key, a rate limit, an outage.
 */
function refusedOnItsMerits(error: Error): boolean {
  return (
    error instanceof RegistryApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 401 &&
    error.status !== 429
  );
}

type PublishedEndpoint = {
  name: string;
  method: string;
  url: string;
  result: "listed" | "skipped" | "failed" | "not_attempted";
  slug?: string;
  error?: string;
};

function endpointResult(
  endpoint: ListingEndpointInput,
  result: PublishedEndpoint["result"],
  detail: { slug?: string; error?: string } = {},
): PublishedEndpoint {
  return { name: endpoint.name, method: endpoint.method, url: endpoint.url, result, ...detail };
}

function formatPublishedEndpoint(endpoint: PublishedEndpoint): string {
  const detail =
    endpoint.result === "listed"
      ? (endpoint.slug ?? "")
      : endpoint.result === "skipped"
        ? `already listed as ${endpoint.slug ?? "?"}`
        : endpoint.result === "failed"
          ? (endpoint.error?.split("\n")[0] ?? "")
          : "not attempted";
  const label = endpoint.result === "not_attempted" ? "pending" : endpoint.result;
  return `  ${label.padEnd(7)} ${endpoint.name}\t${endpoint.method} ${endpoint.url}\t${detail}`;
}

/** Moves one listing through the registry's states: live, or up for review. */
async function publishStatusCommand(
  argv: string[],
  action: ListingStatusAction,
  usage: string,
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, { valueOptions: new Set(), maximumPositionals: 1 });
  const slug = requiredPositional(parsed.positionals[0], "<slug>", `Usage: ${usage}`);
  const { client } = await listingsClient(io, dependencies);
  const result = await client.status(slug, action);
  await recordAudit(dependencies, "listing.status", { detail: `${slug} ${action}` });
  output(io, json, result, formatListingStatus(slug, action, result));
}

/** Every listing this key owns, whatever state it is in. */
async function publishListCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  requireNoArguments(argv, "publish list");
  const { client } = await listingsClient(io, dependencies);
  const result = await client.mine();
  output(io, json, result, formatMyListings(result));
}

/**
 * The registry write API, ready to call: the base URL this install already
 * talks to, plus an API key or linked agent bearer. Credential failures and an
 * unreadable config happen here, before anything is probed or signed.
 */
async function listingsClient(
  io: CliIo,
  dependencies: CliDependencies,
  selection: { one(name: string): string | undefined } = { one: () => undefined },
): Promise<{ client: ListingsClient; baseUrl: string }> {
  const paths = getVapiPaths();
  const config = await readConfig(paths.config, io);
  const baseUrl = registryBaseUrl(config);
  // The variable belongs to the process, like VAPI_KEYSTORE_PASSWORD; the
  // injected environment models wallet selection and agent markers.
  const resolved = await resolveApiKey({
    env: process.env,
    store: getSecretStore(dependencies),
    configPath: paths.config,
  });
  if (resolved !== undefined) {
    return {
      baseUrl,
      client: createListingsClient({
        baseUrl,
        apiKey: resolved.key,
        allowPrivateNetwork: config.allowPrivateNetwork ?? false,
        ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
      }),
    };
  }

  let target: WalletTarget;
  try {
    target = await targetWallet(selection, dependencies);
  } catch (error) {
    if (error instanceof KeystoreError) throw new Error(noApiKeyMessage(baseUrl));
    throw error;
  }
  const link = target.entry.link;
  if (
    link === undefined ||
    !link.scopes.includes("call.publish") ||
    !sameOrigin(link.apiBase, baseUrl)
  ) {
    throw new Error(noApiKeyMessage(baseUrl));
  }
  const guardedFetch =
    dependencies.fetchImpl ??
    createPublicFetch({ allowPrivateNetwork: config.allowPrivateNetwork ?? false });
  const authenticatedFetch: typeof fetch = async (input, init) =>
    await agentFetch(
      {
        secrets: getSecretStore(dependencies),
        wallets: target.store,
        wallet: target.name,
        fetchImpl: guardedFetch,
      },
      requestUrl(input),
      init,
    );
  return {
    baseUrl,
    client: createListingsClient({
      baseUrl,
      authenticatedFetch,
      allowPrivateNetwork: config.allowPrivateNetwork ?? false,
    }),
  };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function noApiKeyMessage(baseUrl: string): string {
  return [
    "No vAPI API key on this machine.",
    `Create one in the console at ${listingsUrl(baseUrl, API_KEY_CONSOLE_PATH).href}, then store it with vapi auth set-key.`,
    `In CI, set ${API_KEY_ENV} instead.`,
  ].join("\n");
}

const DISCOVERY_PATH = "/api/call/discovery";

/**
 * The registry behind the configured discovery URLs. `VAPI_REGISTRY_URL` has
 * already moved those by the time the config is loaded, so deriving the base
 * from them follows the env override, a self-hosted registry and a mount
 * prefix alike. A hand-edited discovery URL falls back to the shipped default.
 */
export function registryBaseUrl(config: VapiConfig): string {
  try {
    const url = new URL(config.marketplaceDiscoveryUrl);
    const path = url.pathname.replace(/\/+$/, "");
    if (!path.endsWith(DISCOVERY_PATH)) return resolveRegistryUrl();
    url.search = "";
    url.hash = "";
    url.pathname = path.slice(0, path.length - DISCOVERY_PATH.length) || "/";
    return url.href;
  } catch {
    return resolveRegistryUrl();
  }
}

/** Which endpoints of the probed API this listing offers. */
async function selectOperations(
  operations: readonly ProbeOperation[],
  args: {
    select: string | undefined;
    all: boolean;
    interactive: boolean;
    io: CliIo;
    dependencies: CliDependencies;
  },
): Promise<ProbeOperation[]> {
  if (args.select !== undefined) return pickOperations(operations, args.select);
  if (args.all) return [...operations];
  if (!args.interactive) throw new UsageError(PUBLISH_NEEDS_TERMINAL);
  args.io.stdout("");
  args.io.stdout("Endpoints found:");
  for (const [index, operation] of operations.entries()) {
    args.io.stdout(formatOperation(index + 1, operation));
  }
  const answer = await getLinePrompt(args.dependencies)(
    "Endpoints to list (numbers or names, comma separated; blank for all): ",
  );
  return answer.trim().length === 0 ? [...operations] : pickOperations(operations, answer);
}

function pickOperations(
  operations: readonly ProbeOperation[],
  selection: string,
): ProbeOperation[] {
  const wanted = selection
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (wanted.length === 0) throw new UsageError("--select needs at least one endpoint name.");
  const picked: ProbeOperation[] = [];
  for (const value of wanted) {
    const byIndex = /^\d+$/.test(value) ? operations[Number(value) - 1] : undefined;
    const match =
      byIndex ??
      operations.find((operation) => operation.name.toLowerCase() === value.toLowerCase());
    if (match === undefined) {
      throw new UsageError(
        `No endpoint named ${JSON.stringify(value)}. The probe found ${operations
          .map((operation) => operation.name)
          .join(", ")}.`,
      );
    }
    if (!picked.includes(match)) picked.push(match);
  }
  return picked;
}

/** A field the listing needs: the option, what the probe knew, or a question. */
async function publishField(
  supplied: string | undefined,
  args: { asking: boolean; prompt: string; missing: string; dependencies: CliDependencies },
): Promise<string> {
  const value = supplied?.trim();
  if (value) return value;
  if (!args.asking) throw new UsageError(args.missing);
  const typed = (await getLinePrompt(args.dependencies)(args.prompt)).trim();
  if (typed.length === 0) throw new UsageError(args.missing);
  return typed;
}

function parseCategory(value: string): ListingCategory {
  const normalized = value.trim().toLowerCase();
  if ((LISTING_CATEGORIES as readonly string[]).includes(normalized)) {
    return normalized as ListingCategory;
  }
  throw new UsageError(`--category must be one of ${LISTING_CATEGORIES.join(", ")}.`);
}

function parseProbeMode(value: string | undefined): ProbeMode | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if ((PROBE_MODES as readonly string[]).includes(normalized)) return normalized as ProbeMode;
  throw new UsageError(`--mode must be one of ${PROBE_MODES.join(", ")}.`);
}

/** Payouts are an EVM transfer, so a wallet without an EVM key cannot receive them. */
function requireEvmAddress(
  address: string | undefined,
  wallet: string,
  retry = "vapi publish <url> --account <name>",
): Address {
  if (address === undefined || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(
      `Wallet ${wallet} has no EVM account, so it cannot receive vAPI Call payouts. Use a wallet that has one: ${retry}.`,
    );
  }
  return address as Address;
}

/**
 * The line the wallet signs. The registry may send its own message, which is
 * then signed verbatim; otherwise the client builds the canonical EIP-4361
 * message so both sides agree byte for byte.
 */
function payoutSiweMessage(
  nonce: { nonce?: unknown; message?: unknown },
  baseUrl: string,
  address: Address,
  dependencies: CliDependencies,
): string {
  const supplied = typeof nonce.message === "string" ? nonce.message.trim() : "";
  if (supplied.length > 0) return supplied;
  const value = typeof nonce.nonce === "string" ? nonce.nonce.trim() : "";
  if (value.length === 0) {
    throw new Error("The registry returned no payout nonce, so there is nothing to sign.");
  }
  return buildPayoutSiweMessage({
    baseUrl,
    address,
    nonce: value,
    issuedAt: (dependencies.now?.() ?? new Date()).toISOString(),
  });
}

function toListingEndpoint(
  operation: ProbeOperation,
  fallbackDescription: string,
): ListingEndpointInput {
  const url = typeof operation.url === "string" ? operation.url.trim() : "";
  if (!isHttpUrl(url)) {
    throw new Error(
      `The probe returned no callable URL for endpoint ${operation.name}, so it cannot be listed.`,
    );
  }
  const method = typeof operation.method === "string" ? operation.method.trim() : "";
  const description = typeof operation.description === "string" ? operation.description.trim() : "";
  return {
    name: operation.name,
    method: (method || "GET").toUpperCase(),
    url,
    description: description || fallbackDescription,
    ...optionalStringField(operation, "operationId"),
    ...optionalStringField(operation, "requestContentType"),
    ...(operation.requestSchema === undefined ? {} : { requestSchema: operation.requestSchema }),
    ...optionalStringField(operation, "responseContentType"),
    ...optionalStringField(operation, "pathTemplate"),
    ...(operation.pathParameters === undefined ? {} : { pathParameters: operation.pathParameters }),
    ...optionalStringField(operation, "metadataEvidence"),
  };
}

function optionalStringField<Key extends keyof ListingEndpointInput>(
  operation: ProbeOperation,
  key: Key,
): Partial<Record<Key, string>> {
  const value = operation[key as string];
  return typeof value === "string" && value.trim().length > 0
    ? ({ [key]: value.trim() } as Partial<Record<Key, string>>)
    : {};
}

function probeString(probe: ProbeResult, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = probe[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/** A category the probe guessed, used only when it is one the registry accepts. */
function probeCategory(probe: ProbeResult): string | undefined {
  const value = probeString(probe, ["category"])?.toLowerCase();
  return value !== undefined && (LISTING_CATEGORIES as readonly string[]).includes(value)
    ? value
    : undefined;
}

function listingSlug(created: CreatedListing): string | undefined {
  const slug = created.listing?.slug;
  return typeof slug === "string" && slug.trim().length > 0 ? slug.trim() : undefined;
}

function formatProbeRejection(rejection: ProbeRejection): string {
  const code = typeof rejection.code === "string" ? rejection.code : "rejected";
  return [
    `Probe rejected: ${code}`,
    ...(typeof rejection.message === "string" ? [rejection.message] : []),
    ...(typeof rejection.hint === "string" ? [`Hint: ${rejection.hint}`] : []),
  ].join("\n");
}

function formatOperation(index: number, operation: ProbeOperation): string {
  const method = typeof operation.method === "string" ? operation.method.toUpperCase() : "GET";
  const url = typeof operation.url === "string" ? operation.url : "";
  const description = typeof operation.description === "string" ? operation.description.trim() : "";
  return [
    `  ${index}  ${operation.name}\t${method}\t${url}`,
    ...(description.length > 0 ? [`     ${description}`] : []),
  ].join("\n");
}

function formatCreatedListing(
  created: CreatedListing,
  name: string,
  payoutWallet: string,
  endpoints: number,
): string {
  const slug = listingSlug(created) ?? "(no slug returned)";
  const status = typeof created.listing?.status === "string" ? created.listing.status : "unknown";
  const verification =
    typeof created.listing?.verification === "string" ? created.listing.verification : "none";
  return [
    `Listed ${name} as ${slug} with ${endpoints} endpoint${endpoints === 1 ? "" : "s"}.`,
    `Status: ${status} · verification: ${verification}`,
    `Payout wallet: ${payoutWallet}`,
  ].join("\n");
}

/**
 * The registry grades the description agents read when they choose a listing:
 * what one call does, what it takes, when to use something else. The findings
 * never block, and every batch shares one description, so they print once.
 */
function formatDescriptionWarnings(created: CreatedListing): string[] {
  const warnings = Array.isArray(created.descriptionWarnings) ? created.descriptionWarnings : [];
  const lines = warnings.flatMap((warning: unknown) => {
    if (typeof warning !== "object" || warning === null) return [];
    const { message, hint } = warning as { message?: unknown; hint?: unknown };
    if (typeof message !== "string") return [];
    return [`- ${message}${typeof hint === "string" ? ` ${hint}` : ""}`];
  });
  return lines.length === 0
    ? []
    : ["Description check (the listing is published either way):", ...lines];
}

function formatListingStatus(
  slug: string,
  action: ListingStatusAction,
  result: { status?: unknown; verification?: unknown },
): string {
  const status = typeof result.status === "string" ? result.status : "unknown";
  const verification = typeof result.verification === "string" ? result.verification : undefined;
  const lines = [
    `Listing ${slug}: ${status}${verification === undefined ? "" : ` · verification: ${verification}`}`,
  ];
  if (action === "activate") {
    lines.push(
      `It answers searches that pass --include-unverified. Ask for review with vapi publish verify-request ${slug}.`,
    );
  }
  if (action === "request_verification") {
    lines.push(
      "vAPI reviews it; until then it stays out of the default search and is tagged [requested].",
    );
  }
  return lines.join("\n");
}

function formatMyListings(result: { listings?: readonly unknown[] }): string {
  const listings = Array.isArray(result.listings) ? result.listings : [];
  if (listings.length === 0) return "No listings yet. Create one with vapi publish <url>.";
  return [
    "SLUG\tSTATUS\tVERIFICATION\tNAME",
    ...listings.map((listing) => {
      const record = (typeof listing === "object" && listing !== null ? listing : {}) as Record<
        string,
        unknown
      >;
      return [
        typeof record.slug === "string" ? record.slug : "—",
        typeof record.status === "string" ? record.status : "—",
        typeof record.verification === "string" ? record.verification : "none",
        typeof record.name === "string" ? record.name : "",
      ].join("\t");
    }),
  ].join("\n");
}

const CLAIM_USAGE = "Usage: vapi claim <origin> [--account <name>]";

/**
 * `vapi claim <origin>`: the owner of an API vAPI indexed from a public
 * catalog takes the listings over. The registry sends an EIP-4361 message; the
 * wallet the listings already pay signs it on the same path \`vapi publish\`
 * signs its payout line, and the registry recovers the signer to match it
 * against their payTo. Nothing is paid and the payout path does not change. A
 * human act, like publishing: there is no MCP tool for it.
 */
async function claimCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set([WALLET_OPTION]),
    maximumPositionals: 1,
  });
  const origin = claimOrigin(requiredPositional(parsed.positionals[0], "<origin>", CLAIM_USAGE));
  const { client, baseUrl } = await listingsClient(io, dependencies, parsed);
  const wallet = await targetWallet(parsed, dependencies);
  const { account } = await unlockTarget(wallet, dependencies);
  const address = requireEvmAddress(
    account.address,
    wallet.name,
    `vapi claim ${origin} --account <name>`,
  );
  const nonce = await client.claimNonce(origin, address);
  const message = typeof nonce.message === "string" ? nonce.message : "";
  assertClaimMessage(message, { baseUrl, origin, address });
  const signature = await account.signMessage({ message });
  const result = await client.claim({ origin, message, signature });
  const claimed = (Array.isArray(result.claimed) ? result.claimed : []).filter(
    (slug): slug is string => typeof slug === "string",
  );
  await recordAudit(dependencies, "listing.claim", {
    wallet: wallet.name,
    detail: `${origin} ${claimed.join(",")}`.trim(),
  });
  outputForWallet(io, json, wallet, { origin, claimed }, formatClaimed(origin, claimed));
}

/** An https origin, and nothing more: a claim covers every listing served from it. */
function claimOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`${CLAIM_USAGE}. ${JSON.stringify(value)} is not a URL.`);
  }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new UsageError(
      `vapi claim takes an https origin such as https://api.example, not ${JSON.stringify(value)}.`,
    );
  }
  return url.origin;
}

function formatClaimed(origin: string, claimed: readonly string[]): string {
  if (claimed.length === 0) return `Nothing was claimed from ${origin}.`;
  return [
    `Claimed ${claimed.length} listing${claimed.length === 1 ? "" : "s"} served from ${origin}:`,
    ...claimed.map((slug) => `  ${slug}`),
    "They are still paid directly to this wallet, with no vAPI fee. vapi publish list shows them; vapi publish verify-request <slug> asks for review.",
  ].join("\n");
}

const EXPORT_KEY_WARNING =
  "Anyone with this key can spend the wallet. Never paste it into a website or chat.";

/** The device vault key, read the one way every CLI key export reads it. */
export async function deviceVaultKey(
  store: Pick<WalletStore, "home">,
  dependencies: CliDependencies,
): Promise<{ path: string; key: Uint8Array }> {
  const path = join(store.home, "vault.json");
  const metadata = await readVaultFileUnlocked(path);
  const secrets = getSecretStore(dependencies);
  const key = metadata.protected
    ? await unlockProtectedVault({
        path,
        secrets,
        env: getEnvironment(dependencies),
        ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      })
    : await loadOrCreateDeviceKey({ secrets });
  return { path, key };
}

/**
 * Prints the private key of one wallet, to a person, on a terminal. The agent
 * gate runs before the passphrase is read, and the person types the wallet name
 * first, so a key never appears because a tool call asked for it.
 */
async function exportKeyCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--network", WALLET_OPTION]),
    maximumPositionals: 0,
  });
  const network = parsed.one("--network") ?? BASE_MAINNET_CAIP2;
  const solana = isSolanaNetwork(network);
  if (!solana && !network.startsWith("eip155:")) {
    throw new UsageError("--network must be an eip155:<chainId> or Solana network identifier.");
  }
  const target = await targetWallet(parsed, dependencies);
  const vaultAccount = await target.store.hasVaultAccount(target.name);
  if (vaultAccount && solana) throw new UsageError(SOLANA_VAULT_UNAVAILABLE);
  await requireSecretsAllowed(dependencies, "secret.export.key", target.name);
  await confirmWalletName(
    target.name,
    `Type ${target.name} to print its private key: `,
    "That is not the wallet name. Nothing was printed.",
    dependencies,
  );
  let address: string;
  let privateKey: string;
  if (vaultAccount) {
    const { path, key } = await deviceVaultKey(target.store, dependencies);
    try {
      address = target.address ?? (await target.store.readAddress(target.name)) ?? "";
      privateKey = await exportVaultAccountKey({ path, key, name: target.name });
    } finally {
      key.fill(0);
    }
  } else {
    const resolved = await walletPassphrase(target, dependencies);
    const keys = await withResolvedPassphrase(resolved, target, dependencies, (passphrase) =>
      exportKeystoreKeys(passphrase, target.path),
    );
    if (solana && !keys.solana) {
      throw new Error(
        `No Solana key is enabled in ${target.path}. Run vapi accounts --enable solana first.`,
      );
    }
    const selected = solana && keys.solana ? keys.solana : keys.evm;
    address = selected.address;
    privateKey = "secretKey" in selected ? selected.secretKey : selected.privateKey;
  }
  const result = {
    network,
    address,
    privateKey,
  };
  await recordAudit(dependencies, "secret.export.key", { wallet: target.name, detail: network });
  io.stderr(EXPORT_KEY_WARNING);
  if (json) {
    io.stdout(JSON.stringify({ wallet: target.name, ...result }));
    return;
  }
  io.stdout(walletHeader(target));
  io.stdout(result.privateKey);
}

const BACKUP_WARNING =
  "Anyone with these words can spend the wallet. Never type them into a website or chat.";

/**
 * Prints the recovery phrase of one wallet, to a person, on a terminal. The
 * same gate and the same typed confirmation as `vapi export-key`.
 */
async function backupCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  if (argv.includes("--cloud")) {
    await cloudBackupCommand(argv, json, io, dependencies);
    return;
  }
  const parsed = parseArguments(argv, {
    valueOptions: new Set([WALLET_OPTION]),
    maximumPositionals: 0,
  });
  if (!isInteractive(dependencies)) {
    await recordAudit(dependencies, "secret.export.phrase", {
      detail: "refused: not a terminal",
    });
    throw new KeystoreError(
      "vapi backup prints your recovery phrase and only works in a terminal.",
    );
  }
  const target = await targetWallet(parsed, dependencies);
  const vaultAccount = await target.store.hasVaultAccount(target.name);
  if (vaultAccount) {
    const vault = await readVaultFileUnlocked(join(target.store.home, "vault.json"));
    if (
      vault.accounts.some((account) => account.name === target.name && account.kind === "imported")
    ) {
      throw new KeystoreError(
        `Account ${target.name} was imported and is not recoverable from the vault phrase. Back it up with vapi export-key --account ${target.name}.`,
      );
    }
  }
  await requireSecretsAllowed(dependencies, "secret.export.phrase", target.name);
  await confirmWalletName(
    target.name,
    `Type ${target.name} to print its recovery phrase: `,
    "That is not the wallet name. Nothing was printed.",
    dependencies,
  );
  io.stderr(BACKUP_WARNING);
  let recoveryPhrase: string;
  if (vaultAccount) {
    const { path, key } = await deviceVaultKey(target.store, dependencies);
    try {
      recoveryPhrase = await exportVaultPhrase({ path, key });
    } finally {
      key.fill(0);
    }
  } else {
    const resolved = await walletPassphrase(target, dependencies);
    try {
      recoveryPhrase = await withResolvedPassphrase(resolved, target, dependencies, (passphrase) =>
        exportRecoveryPhrase(passphrase, target.path),
      );
    } catch (error) {
      const version = await readKeystoreVersion(target.path);
      if (version === undefined || version === 3) throw error;
      throw new Error(
        [
          error instanceof Error ? error.message : String(error),
          `Back up ${target.path} together with the passphrase that opens it, or print the key itself with vapi export-key.`,
        ].join("\n"),
      );
    }
  }
  await recordAudit(dependencies, vaultAccount ? "vault.backup_shown" : "secret.export.phrase", {
    wallet: target.name,
  });
  if (json) {
    io.stdout(JSON.stringify({ wallet: target.name, recoveryPhrase }));
    return;
  }
  io.stdout(walletHeader(target));
  io.stdout(formatRecoveryPhrase(recoveryPhrase));
}

/**
 * Restores a wallet from words or a private key the person types in. The secret
 * never comes from argv, where a shell history would keep it, and an existing
 * wallet is moved to the trash rather than overwritten.
 */
async function importCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set(["--networks", WALLET_OPTION]),
    booleanOptions: new Set(["--phrase", "--key", "--replace", "--force"]),
    maximumPositionals: 24,
  });
  if (parsed.positionals.length > 0) {
    throw new UsageError(
      "vapi import reads the secret from a prompt. Never pass a recovery phrase or a private key as an argument.",
    );
  }
  const fromPhrase = parsed.has("--phrase");
  if (fromPhrase === parsed.has("--key")) {
    throw new UsageError("vapi import needs exactly one of --phrase or --key.");
  }
  const networks = parseInitNetworks(parsed.one("--networks") ?? "base");
  if (networks.includes("solana")) throw new UsageError(SOLANA_VAULT_UNAVAILABLE);
  const enableArc = networks.includes("arc");

  const paths = getVapiPaths();
  const store = await openWalletStore(dependencies);
  const name = importWalletName(store, parsed, dependencies);
  const existed = store.has(name);
  if (existed && !parsed.has("--replace")) {
    const address = await store.readAddress(name);
    const location = (await store.hasVaultAccount(name))
      ? join(store.home, "vault.json")
      : store.pathFor(name);
    throw new Error(
      [
        `Wallet ${name} already exists at ${location}.`,
        ...(address ? [`Address: ${address}`] : []),
        "Write its recovery phrase down with vapi backup first, then re-run with --replace.",
      ].join("\n"),
    );
  }

  const prompts = getPrompts(dependencies);
  const secret = fromPhrase
    ? validateRecoveryPhrase(await prompts.secret("Recovery phrase: "))
    : validatePrivateKey(await prompts.secret("Private key: "));
  // Only now, with the secret in hand, is the existing wallet moved: a failed
  // prompt must never leave the machine without the wallet it had.
  let previousKeystore: string | undefined;
  if (existed) {
    const config = await readConfig(paths.config, io);
    const trashed = await store.remove(name, {
      force: parsed.has("--force"),
      balanceReader: baseUsdcBalanceReader(config, dependencies),
      allowDefault: true,
    });
    await recordAudit(dependencies, "wallet.remove", {
      wallet: trashed.name,
      detail: "replaced by vapi import",
    });
    previousKeystore = trashed.path;
  }
  const imported = fromPhrase
    ? await store.create(name, "", { phrase: secret })
    : await store.importKey(name, "", secret);
  await recordAudit(dependencies, "wallet.import", { wallet: imported.name });
  const account = imported.account;

  if (!(await fileExists(paths.config))) {
    await writeDefaultConfig(paths.config, process.env, { networks });
  } else {
    if (enableArc) await enableDefaultNetwork("arc", paths.config);
  }
  const result = {
    address: account.address,
    ...(account.solana ? { solanaAddress: account.solana.address } : {}),
    vault: join(paths.directory, "vault.json"),
    ...(previousKeystore ? { previousKeystore } : {}),
    message: "Wallet imported. Its encrypted key stays on this machine.",
  };
  outputForWallet(
    io,
    json,
    { name: imported.name, address: account.address },
    result,
    [
      result.message,
      `Address: ${result.address}`,
      ...(account.solana ? [`Solana address: ${account.solana.address}`] : []),
      `Vault: ${result.vault}`,
      ...(previousKeystore ? [`Previous keystore moved to ${previousKeystore}`] : []),
    ].join("\n"),
  );
}

/**
 * `main` only on a machine that has no wallet yet. Once one exists, an import
 * has to say which wallet it is writing, so it can never quietly land on top of
 * the one that holds the money.
 */
function importWalletName(
  store: WalletStore,
  parsed: { one(name: string): string | undefined },
  dependencies: CliDependencies,
): WalletName {
  const requested =
    parsed.one(WALLET_OPTION)?.trim() || getEnvironment(dependencies).VAPI_WALLET?.trim();
  if (requested !== undefined && requested.length > 0) return assertWalletName(requested);
  if (store.names().length === 0) return DEFAULT_WALLET_NAME;
  throw new Error(
    [
      `This machine already has ${store.names().sort().join(", ")}.`,
      "Name the wallet to import with vapi import --account <name>.",
    ].join("\n"),
  );
}

/** Re-encrypts the same wallet under a new passphrase; the addresses stay. */
async function passphraseCommand(
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
  if (await target.store.hasVaultAccount(target.name)) {
    throw new KeystoreError(
      "Vault accounts have no passphrase. Protect the whole vault instead with vapi vault protect.",
    );
  }
  const prompts = getPrompts(dependencies);
  const resolved = await walletPassphrase(target, dependencies);
  const current = resolved.passphrase;
  const next = await prompts.secret("New passphrase: ");
  if (next.length === 0) throw new KeystoreError("Keystore passphrase cannot be empty.");
  if (next === current) {
    throw new KeystoreError("The new passphrase must differ from the current one.");
  }
  if ((await prompts.secret("Confirm new passphrase: ")) !== next) {
    throw new KeystoreError("Passphrases do not match.");
  }
  const account = await withResolvedPassphrase(resolved, target, dependencies, (passphrase) =>
    changeKeystorePassphrase(passphrase, next, target.path),
  );
  await recordAudit(dependencies, "passphrase.change", { wallet: target.name });
  await retireStoredPassphrase(target, dependencies, io);
  if (process.env.VAPI_KEYSTORE_PASSWORD !== undefined) {
    io.stderr(
      "VAPI_KEYSTORE_PASSWORD still holds the old passphrase. Update it before the next run.",
    );
  }
  const result = {
    address: account.address,
    ...(account.solana ? { solanaAddress: account.solana.address } : {}),
    keystore: target.path,
    message: "Passphrase changed. The wallet and its addresses are unchanged.",
  };
  outputForWallet(
    io,
    json,
    target,
    result,
    [result.message, `Address: ${result.address}`, `Keystore: ${target.path}`].join("\n"),
  );
}

const UNLOCK_NEEDS_TERMINAL =
  "Type the passphrase yourself in a terminal; an agent must never be handed one.";

/**
 * Hands one wallet's passphrase to the OS secret store, so an agent can pay
 * from it without the passphrase sitting in an editor's configuration file.
 * The passphrase is typed by a person, on a terminal, and is verified against
 * the keystore before anything is stored: a typo must not be kept.
 */
async function unlockCommand(
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
  if (await target.store.hasVaultAccount(target.name)) {
    const message = `${target.name} lives in the device vault, which the OS secret store opens; nothing to unlock.`;
    output(io, json, { wallet: target.name, unlocked: true, message }, message);
    return;
  }
  await requireSecretsAllowed(dependencies, "wallet.unlock", target.name, {
    refusal: UNLOCK_NEEDS_TERMINAL,
  });
  const store = getSecretStore(dependencies);
  if (!store.available) {
    throw new KeystoreError(NO_SECRET_STORE);
  }

  const passphrase = await getPrompts(dependencies).secret(`Passphrase for ${target.name}: `);
  if (passphrase.length === 0) throw new KeystoreError("Keystore passphrase cannot be empty.");
  try {
    await target.store.unlock(target.name, passphrase);
  } catch (error) {
    await recordAudit(dependencies, "wallet.unlock", {
      wallet: target.name,
      detail: "refused: the passphrase did not open the wallet",
    });
    throw error;
  }
  await store.set(target.name, passphrase);
  await recordAudit(dependencies, "wallet.unlock", {
    wallet: target.name,
    detail: store.description,
  });
  const message = `Wallet ${target.name} is unlocked for agents. Its passphrase is in ${store.description}.`;
  outputForWallet(
    io,
    json,
    target,
    { unlocked: true, store: store.description, message },
    [
      message,
      `Drop VAPI_KEYSTORE_PASSWORD from your MCP configuration; take the passphrase back out with vapi lock --account ${target.name}.`,
    ].join("\n"),
  );
}

/**
 * Takes a passphrase back out of the OS secret store. Nothing about the wallet
 * changes: the keystore, its addresses and its passphrase are untouched, and
 * the next run asks for the passphrase again.
 */
async function lockCommand(
  argv: string[],
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set([WALLET_OPTION]),
    booleanOptions: new Set([ALL_WALLETS_FLAG]),
    maximumPositionals: 0,
  });
  const all = parsed.has(ALL_WALLETS_FLAG);
  if (all && parsed.one(WALLET_OPTION) !== undefined) {
    throw new UsageError(`${ACCOUNT_OPTION} and ${ALL_WALLETS_FLAG} cannot be used together.`);
  }
  const walletStore = await openWalletStore(dependencies);
  const target = all ? undefined : await selectWallet(walletStore, parsed, dependencies);
  const store = getSecretStore(dependencies);
  if (!store.available) {
    throw new KeystoreError(NO_SECRET_STORE);
  }
  if (target && (await walletStore.hasVaultAccount(target.name))) {
    const vaultLocked = await lockVault({ secrets: store });
    if (vaultLocked) {
      await recordAudit(dependencies, "wallet.lock", {
        wallet: target.name,
        detail: "protected vault session",
      });
    }
    const message = vaultLocked
      ? "Locked the protected device vault."
      : `${target.name} lives in the device vault, which has no active protected session to lock.`;
    output(io, json, { wallet: target.name, locked: [], vaultLocked, message }, message);
    return;
  }
  const names = target ? [target.name] : walletStore.names();
  const hasVaultAccounts = (
    await Promise.all(names.map(async (name) => await walletStore.hasVaultAccount(name)))
  ).some(Boolean);
  const vaultLocked = all && hasVaultAccounts ? await lockVault({ secrets: store }) : false;
  if (vaultLocked) {
    await recordAudit(dependencies, "wallet.lock", { detail: "protected vault session" });
  }

  const locked: string[] = [];
  for (const name of names) {
    if (await walletStore.hasVaultAccount(name)) continue;
    if (!(await store.remove(name))) continue;
    locked.push(name);
    await recordAudit(dependencies, "wallet.lock", { wallet: name, detail: store.description });
  }

  const message =
    vaultLocked && locked.length === 0
      ? "Locked the protected device vault."
      : locked.length === 0
        ? `No passphrase was stored in ${store.description}${target ? ` for ${target.name}` : ""}.`
        : `${vaultLocked ? "Locked the protected device vault. " : ""}Locked ${locked.join(", ")}. ${locked.length === 1 ? "Its passphrase is" : "Their passphrases are"} no longer in ${store.description}.`;
  if (target) {
    outputForWallet(io, json, target, { locked, store: store.description, message }, message);
    return;
  }
  output(
    io,
    json,
    { wallet: null, locked, vaultLocked, store: store.description, message },
    message,
  );
}

/** Every wallet on the machine, for `vapi lock`. */
const ALL_WALLETS_FLAG = "--all";

const NO_SECRET_STORE = "No OS secret store on this platform yet; use VAPI_KEYSTORE_PASSWORD.";

/**
 * A new passphrase makes the stored copy wrong, so `vapi passphrase` retires
 * it. An entry that no longer opens its wallet is the one failure an agent
 * cannot do anything about.
 */
async function retireStoredPassphrase(
  target: WalletTarget,
  dependencies: CliDependencies,
  io: CliIo,
): Promise<void> {
  const store = getSecretStore(dependencies);
  if (!store.available) return;
  let removed: boolean;
  try {
    removed = await store.remove(target.name);
  } catch {
    // A keyring that will not answer is not a reason to fail a passphrase
    // change that already succeeded.
    return;
  }
  if (!removed) return;
  await recordAudit(dependencies, "wallet.lock", {
    wallet: target.name,
    detail: "passphrase changed",
  });
  io.stderr(
    `The old passphrase was removed from ${store.description}. Run vapi unlock --account ${target.name} to store the new one.`,
  );
}

async function mcpCommand(argv: string[], dependencies: CliDependencies): Promise<void> {
  const parsed = parseArguments(argv, {
    valueOptions: new Set([WALLET_OPTION]),
    maximumPositionals: 0,
  });
  const paths = getVapiPaths();
  const store = await openWalletStore(dependencies);
  if (store.names().length === 0) {
    await startStdioServer({
      env: getEnvironment(dependencies),
      ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
    });
    return;
  }
  const config = await loadConfig(paths.config);
  // Resolving the wallet prints nothing: an MCP server owns stdout.
  const target = await targetWallet(parsed, dependencies);
  // Read the passphrase and unlock before connecting stdio, so a prompt can
  // never corrupt MCP frames and a wrong passphrase fails now rather than at
  // the first payment. The server keeps it as the last resort for whichever
  // wallet a tool call names, behind VAPI_KEYSTORE_PASSWORD and the entries
  // vapi unlock left in the OS secret store.
  const { account, passphrase } = await unlockTarget(target, dependencies);
  await startStdioServer({
    account,
    config,
    store: target.store,
    wallet: target.name,
    env: getEnvironment(dependencies),
    passphrase: () => passphrase,
    secretStore: getSecretStore(dependencies),
    ledgerPath: paths.ledger,
    receiptsPath: paths.receipts,
    searchesPath: paths.searches,
    runtime: resolveRuntime("local", paths.directory, dependencies),
    runtimeForStop: (kind) => resolveRuntime(kind, paths.directory, dependencies),
  });
}

/** Loads the config and reports any retired registry URL it had to repair. */
export async function readConfig(path: string, io: CliIo): Promise<VapiConfig> {
  return await loadConfig(path, process.env, { notice: io.stderr });
}

export function output(io: CliIo, json: boolean, value: unknown, human: string): void {
  io.stdout(json ? JSON.stringify(value) : human);
}

function outputStub(io: CliIo, json: boolean): void {
  const message = "gateway daemon lands in 0.3";
  if (json) io.stdout(JSON.stringify({ error: message, exitCode: 2 }));
  else io.stderr(message);
}

/**
 * The short word for how far a listing got through vAPI review. A mirrored
 * external row is called `external` rather than `unverified`: vAPI reviewed
 * nothing it merely mirrored, and saying "unverified" would read as a verdict
 * on a catalog vAPI never claimed to judge.
 */
export function verificationTag(listing: {
  verification?: ListingVerification;
  external?: boolean;
}): "verified" | "requested" | "unverified" | "external" {
  if (listing.external) return "external";
  if (listing.verification === "verified") return "verified";
  return listing.verification === "requested" ? "requested" : "unverified";
}

/**
 * One block per listing. The group tag is the shortest honest answer to "whose
 * API is this", the verification tag is how far vAPI reviewed it, and the fee
 * label includes the percentage computed from the registry's basis points.
 * A group that already says `external` is not repeated by the verification tag.
 */
function formatSearch(page: MarketplaceDiscoveryPage): string {
  if (page.items.length === 0) return "No listings found.";
  return page.items
    .map((item) => {
      const tags = [
        ...(item.group ? [item.group] : []),
        verificationTag({ verification: item.verification, external: isMirroredHit(item) }),
      ];
      const prefix = [...new Set(tags)].map((tag) => `[${tag}] `).join("");
      const health =
        item.kind === "api" && item.health
          ? `${item.health.state}${
              item.health.latencyP50Ms === null ? "" : ` ${Math.round(item.health.latencyP50Ms)}ms`
            }`
          : "-";
      return [
        `${item.ref}\t${item.kind}\t${health}\t${prefix}${item.card.title}`,
        `  ${item.card.summary}`,
        ...(item.fee ? [`  Fee: ${formatListingFee(item.fee)}`] : []),
        ...(item.kind === "api" && item.alternatives
          ? [
              `  Alternatives: ${item.alternatives
                .map((alternative) => `${alternative.ref} (${alternative.reason})`)
                .join(", ")}`,
            ]
          : []),
      ].join("\n");
    })
    .join("\n");
}

/**
 * `inspect` answers with the whole record, so the disclosures a human decides
 * on — how far vAPI reviewed this listing, what network fee is already inside
 * the price, and how the listing has behaved lately — are said in words above
 * it. Liveness, conformance, and identity are said only when the registry sent them.
 */
function formatInspect(result: Awaited<ReturnType<typeof callInspect.run>>): string {
  const { hints: _hints, ...humanResult } = result;
  void _hints;
  return [
    `Verification: ${verificationTag({
      verification: result.verification,
      external: result.group === "external",
    })}`,
    ...(result.fee ? [`Fee: ${formatListingFee(result.fee)}`] : []),
    ...(result.health ? [formatHealth(result.health)] : []),
    ...(result.exampleRequest ? [`Example request: ${JSON.stringify(result.exampleRequest)}`] : []),
    ...(result.liveness ? [formatLiveness(result.liveness)] : []),
    ...(result.conformance ? [formatConformance(result.conformance)] : []),
    ...(result.identity ? formatIdentityLines(result.identity) : []),
    JSON.stringify(humanResult, null, 2),
  ].join("\n");
}

function formatHealth(health: ListingHealth): string {
  return [
    `Health: ${health.state}`,
    ...(health.uptime7d === null
      ? [`(${health.checks7d} checks)`]
      : [`${(health.uptime7d * 100).toFixed(1)}% up over 7 days (${health.checks7d} checks)`]),
    ...(health.latencyP50Ms === null ? [] : [`p50 ${Math.round(health.latencyP50Ms)} ms`]),
    ...(health.latencyP95Ms === null ? [] : [`p95 ${Math.round(health.latencyP95Ms)} ms`]),
  ].join(" · ");
}

function formatLiveness(liveness: ListingLiveness): string {
  const checks = `${liveness.checks7d} check${liveness.checks7d === 1 ? "" : "s"}`;
  return [
    `Liveness: ${(liveness.uptime7d * 100).toFixed(1)}% up over 7 days (${checks})`,
    ...(liveness.latencyP50Ms === null ? [] : [`p50 ${Math.round(liveness.latencyP50Ms)} ms`]),
    ...(liveness.latencyP95Ms === null ? [] : [`p95 ${Math.round(liveness.latencyP95Ms)} ms`]),
  ].join(" · ");
}

const OFFER_TRANSPORT_WORDS = {
  body: "offer in the JSON body",
  header: "offer in the PAYMENT-REQUIRED header only",
  both: "offer in header and body",
} as const;

function formatConformance(conformance: ListingConformance): string {
  return [
    `Conformance: ${
      conformance.declaredVersion === null
        ? "no x402 version declared"
        : `x402 v${conformance.declaredVersion}`
    }, ${conformance.versionConformant ? "conformant" : "not conformant"}, ${
      OFFER_TRANSPORT_WORDS[conformance.offerTransport]
    }`,
    ...(conformance.issues.length === 0 ? [] : [`issues: ${conformance.issues.join(", ")}`]),
  ].join(" · ");
}

/**
 * One line, above the result, when the listing that was just paid is not
 * vAPI-verified. It never blocks and never prompts: the payment has already
 * happened, and the point is that the next one is an informed choice.
 */
export function verificationNotice(verification: ListingVerification | undefined): string[] {
  if (verification === undefined || verification === "verified") return [];
  const state =
    verification === "requested"
      ? "requested — vAPI review is pending"
      : "unverified — vAPI has not reviewed this listing";
  return [`Verification: ${state}. Check its request contract and its price with vapi inspect.`];
}

function formatWallet(wallet: Awaited<ReturnType<typeof getWallet>>): string {
  return [`Address: ${wallet.address}`, ...formatBalanceLines(wallet)].join("\n");
}

function formatBalanceLines(wallet: Awaited<ReturnType<typeof getWallet>>): string[] {
  return wallet.balances.map((entry) =>
    entry.error
      ? `${entry.name} (${entry.network}): unavailable — ${entry.error}`
      : `${entry.name} (${entry.network}): ${entry.usdc} USDC (${entry.usdcAtomic} atomic)`,
  );
}

function formatFund(address: string, url: string, opened: boolean): string {
  return [
    `Address: ${address}`,
    `Fund: ${url}`,
    ...(opened ? ["Opened in your default browser."] : []),
    "The page takes a card via Coinbase (needs a Coinbase account; US guest checkout), a transfer from MetaMask/Coinbase Wallet/WalletConnect, or a bridge from another chain. vAPI never holds your funds.",
    ONRAMP_FALLBACK_INSTRUCTIONS,
  ].join("\n");
}

/**
 * Open a funding URL without ever failing the command: a headless or locked-down
 * machine simply keeps the printed link.
 */
export function openInBrowser(url: string): boolean {
  const opener =
    process.platform === "darwin"
      ? { command: "open", args: [url] }
      : process.platform === "win32"
        ? { command: "cmd", args: ["/c", "start", "", url] }
        : { command: "xdg-open", args: [url] };
  try {
    const child = spawn(opener.command, opener.args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export const CUSTODY_NOTICE = [
  "This wallet is yours. vAPI has no copy of the key and cannot recover it.",
  "If you lose this machine and your recovery phrase, the funds are gone.",
].join("\n");

const PHRASE_GATE = "Write these 12 words down, then press Enter.";
const PHRASE_HIDDEN = "Recovery phrase: run vapi backup yourself in a terminal to see it.";

/**
 * The phrase is shown once, to a person, and waits until they say they have it.
 * A script, a piped run or anything an agent drives gets the pointer to
 * `vapi backup` instead: the wallet is still created, but nothing here may end
 * up in a transcript or a log file.
 */
export async function showRecoveryPhrase(
  phrase: string,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  if (!secretsDecision(dependencies).allowed) {
    io.stdout(PHRASE_HIDDEN);
    return;
  }
  io.stdout("");
  io.stdout("Recovery phrase. These 12 words restore this wallet, and nothing else does:");
  io.stdout(formatRecoveryPhrase(phrase));
  io.stdout("");
  await getPrompts(dependencies).secret(`${PHRASE_GATE} `);
}

/** One numbered word per line: the shape people copy onto paper without slips. */
function formatRecoveryPhrase(phrase: string): string {
  return phrase
    .split(" ")
    .map((word, index) => `${String(index + 1).padStart(2, " ")}. ${word}`)
    .join("\n");
}

function buildNextSteps(address: string): string[] {
  return [
    formatNextStep("Address", address, "(copy this to fund it)"),
    formatNextStep("Back up", "vapi backup", "(write the 12 words down; vAPI cannot recover them)"),
    formatNextStep("Fund", "vapi fund", "(card via Coinbase, a wallet transfer, or a bridge)"),
    formatNextStep("Search", 'vapi search "weather"'),
    formatNextStep("Pay", "vapi pay <ref> --max 0.02"),
    formatNextStep(
      "Agent",
      'add {"command":"npx","args":["-y","vapi-network@latest","mcp"]} to your MCP config',
    ),
  ];
}

function formatNextStep(label: string, value: string, note?: string): string {
  const step = `${label.padEnd(10)}${value}`;
  return note === undefined ? step : `${step.padEnd(52)} ${note}`;
}

/** Print the welcome banner once; it adapts to the terminal's width and colour support. */
function showBanner(io: CliIo): void {
  io.stdout(
    renderBanner({
      version: CLI_VERSION,
      colorLevel: detectColorLevel(),
      columns: process.stdout.columns,
    }),
  );
}

function formatAccounts(accounts: readonly AccountInfo[]): string {
  if (accounts.length === 0) return "No configured network accounts.";
  return accounts
    .map((account) => {
      const lines = [`${account.name} (${account.caip2})`, `  Address: ${account.address}`];
      lines.push(
        account.usdcBalance
          ? `  USDC: ${account.usdcBalance.formatted} (${account.usdcBalance.atomic} atomic)`
          : "  USDC: unavailable",
      );
      if (account.gasTokenBalance) {
        lines.push(
          `  ${account.gasTokenBalance.symbol}: ${account.gasTokenBalance.formatted} (${account.gasTokenBalance.atomic} atomic)`,
        );
      }
      if (account.depositUrl) lines.push(`  Deposit: ${account.depositUrl}`);
      if (account.depositInstructions) lines.push(`  ${account.depositInstructions}`);
      if (account.error) lines.push(`  Balance error: ${account.error}`);
      return lines.join("\n");
    })
    .join("\n");
}

function formatSupportReport(result: Awaited<ReturnType<typeof createSupportReport>>): string {
  return [
    `Report: ${result.path}`,
    `GitHub: ${result.issueUrl}`,
    ...(result.responseCode === undefined ? [] : [`Send response: HTTP ${result.responseCode}`]),
  ].join("\n");
}

function formatReceipt(receipt: Awaited<ReturnType<typeof readReceipts>>[number]): string {
  const status =
    receipt.settlement?.outcome ?? (receipt.error ? "error" : (receipt.status ?? "recorded"));
  const explorerUrl =
    receipt.settlement?.explorerUrl ??
    (receipt.quote?.network && receipt.settlement?.transaction
      ? explorerTransactionUrl(receipt.quote.network, receipt.settlement.transaction)
      : undefined);
  return `${receipt.timestamp}\t${status}\t${receipt.method ?? "GET"} ${receipt.resourceUrl}${explorerUrl ? ` (${explorerUrl})` : ""}`;
}

function formatStats(
  stats: ReturnType<typeof aggregateStats>,
  network: NetworkStats | null = null,
): string {
  const lines = [
    `Metrics (${stats.range}, generated ${stats.generatedAt})`,
    "TOTALS\tVALUE",
    `Spend (USD)\t${stats.totals.spendUsd}`,
    `Calls\t${stats.totals.calls}`,
    `Unique APIs\t${stats.totals.uniqueApis}`,
    `Policy declines\t${stats.totals.policyDeclines}`,
    "",
    "OUTCOME\tCOUNT\tRATE",
    ...Object.entries(stats.outcomes).map(
      ([outcome, value]) => `${outcome}\t${value.count}\t${formatRate(value.rate)}`,
    ),
    "",
    "LATENCY\tP50 MS\tP95 MS",
    `total\t${formatLatency(stats.latency.total.p50Ms)}\t${formatLatency(stats.latency.total.p95Ms)}`,
    ...Object.entries(stats.latency.phases).map(
      ([phase, value]) => `${phase}\t${formatLatency(value.p50Ms)}\t${formatLatency(value.p95Ms)}`,
    ),
    "",
    "TOP BY SPEND\tUSD\tCALLS",
    ...stats.topServices.bySpend.map(
      (service) => `${service.name}\t${service.spendUsd}\t${service.calls}`,
    ),
    "",
    "TOP BY CALLS\tCALLS\tUSD",
    ...stats.topServices.byCalls.map(
      (service) => `${service.name}\t${service.calls}\t${service.spendUsd}`,
    ),
    "",
    "SEARCH\tVALUE",
    `Count\t${stats.search.count}`,
    `Zero-result rate\t${formatRate(stats.search.zeroResultRate)}`,
    "SOURCE\tSEARCHES\tP95 MS",
    ...Object.entries(stats.search.sources).map(
      ([source, value]) => `${source}\t${value.count}\t${formatLatency(value.p95Ms)}`,
    ),
    ...(network === null
      ? []
      : [
          "",
          "NETWORK (all vAPI clients)\tVALUE",
          `Routed through vAPI (24h, USD)\t${network.routedThroughVapi.usd24h}`,
          `Routed through vAPI (30d, USD)\t${network.routedThroughVapi.usd30d}`,
          `Routed through vAPI (30d, tx)\t${network.routedThroughVapi.txCount}`,
        ]),
  ];
  return lines.join("\n");
}

function formatRate(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatLatency(value: number | null): string {
  return value === null ? "—" : String(value);
}

function formatSweepResults(
  results: Array<
    | { network: string; status: "swept"; amountAtomic: string; transaction: string }
    | { network: string; status: "error"; error: string }
  >,
  ownerDestination?: string,
): string {
  return results
    .map((result) => {
      const name = getNetworkDefinition(result.network).name;
      if (result.status === "error") return `${name}: ${result.error}`;
      const retained = usesUsdcGas(result.network)
        ? ` (retained ${formatUsdc(getArcGasHeadroomAtomic())} USDC for gas)`
        : "";
      const explorerUrl = explorerTransactionUrl(result.network, result.transaction);
      const transaction = explorerUrl
        ? `${result.transaction} (${explorerUrl})`
        : result.transaction;
      const destination =
        ownerDestination === undefined ? "" : ` to your owner wallet ${ownerDestination}`;
      return `${name}: swept ${formatUsdc(BigInt(result.amountAtomic))} USDC${destination} in ${transaction}${retained}`;
    })
    .join("\n");
}

type ArgumentSpec = {
  valueOptions: Set<string>;
  booleanOptions?: Set<string>;
  repeatableOptions?: Set<string>;
  maximumPositionals: number;
};

export function parseArguments(argv: string[], spec: ArgumentSpec) {
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  const flags = new Set<string>();
  const acceptsAccountAlias = spec.valueOptions.has(WALLET_OPTION);
  let sawWalletOption = false;
  let sawAccountOption = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    if (spec.booleanOptions?.has(argument)) {
      if (flags.has(argument)) throw new UsageError(`${argument} may only be provided once.`);
      flags.add(argument);
      continue;
    }
    if (acceptsAccountAlias && argument === WALLET_OPTION) sawWalletOption = true;
    if (acceptsAccountAlias && argument === ACCOUNT_OPTION) sawAccountOption = true;
    if (sawWalletOption && sawAccountOption) {
      throw new UsageError("--wallet and --account cannot be used together.");
    }
    const option = acceptsAccountAlias && argument === ACCOUNT_OPTION ? WALLET_OPTION : argument;
    if (!spec.valueOptions.has(option)) throw new UsageError(`Unknown option ${argument}.`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new UsageError(`Expected ${argument} <value>.`);
    index += 1;
    const previous = options.get(option) ?? [];
    if (previous.length > 0 && !spec.repeatableOptions?.has(option)) {
      throw new UsageError(`${argument} may only be provided once.`);
    }
    options.set(option, [...previous, value]);
  }
  if (positionals.length > spec.maximumPositionals) {
    throw new UsageError("Too many positional arguments.");
  }
  return {
    positionals,
    one: (name: string) => options.get(name)?.[0],
    many: (name: string) => options.get(name) ?? [],
    has: (name: string) => flags.has(name),
  };
}

function removeJsonFlag(
  argv: string[],
  preserveForwarded = false,
): { args: string[]; json: boolean } {
  let json = false;
  const args: string[] = [];
  let forwarding = false;
  for (const argument of argv) {
    if (preserveForwarded && argument === "--") forwarding = true;
    if (argument !== "--json" || forwarding) {
      args.push(argument);
      continue;
    }
    if (json) throw new UsageError("--json may only be provided once.");
    json = true;
  }
  return { args, json };
}

function requireNoArguments(argv: string[], command: string): void {
  if (argv.length > 0) throw new UsageError(`${command} does not accept arguments.`);
}

export function requiredPositional(
  value: string | undefined,
  argument: string,
  usage: string,
): string {
  if (!value) throw new UsageError(`Missing ${argument}.\n${usage}`);
  return value;
}

function optionalPositiveInteger(value: string | undefined, option: string): number | undefined {
  const result = optionalNonNegativeInteger(value, option);
  if (result === 0) throw new UsageError(`${option} must be a positive integer.`);
  return result;
}

function optionalBoundedInteger(
  value: string | undefined,
  option: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new UsageError(`${option} must be an integer from ${minimum} to ${maximum}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new UsageError(`${option} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function optionalUsdAmount(value: string | undefined, option: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) {
    throw new UsageError(`${option} must be a US dollar amount such as 20 or 19.99.`);
  }
  const parsed = Number(value);
  if (parsed <= 0) throw new UsageError(`${option} must be greater than zero.`);
  if (parsed > 100_000) throw new UsageError(`${option} must be at most 100000.`);
  return parsed;
}

function optionalNonNegativeInteger(value: string | undefined, option: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new UsageError(`${option} must be a non-negative integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new UsageError(`${option} is too large.`);
  return parsed;
}

function parseStatsRange(value: string): StatsRange {
  if ((STATS_RANGES as readonly string[]).includes(value)) return value as StatsRange;
  throw new UsageError(`--range must be one of ${STATS_RANGES.join(", ")}.`);
}

function parseJson(value: string, option: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new UsageError(`${option} must contain valid JSON.`);
  }
}

function aliasedOption(
  parsed: { one(name: string): string | undefined },
  preferred: string,
  legacy: string,
): string | undefined {
  const preferredValue = parsed.one(preferred);
  const legacyValue = parsed.one(legacy);
  if (preferredValue !== undefined && legacyValue !== undefined) {
    throw new UsageError(`${preferred} and ${legacy} cannot be used together.`);
  }
  return preferredValue ?? legacyValue;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

function parseInitNetworks(value: string): string[] {
  const networks = value
    .split(",")
    .map((network) => network.trim().toLowerCase())
    .filter(Boolean);
  if (networks.length === 0 || new Set(networks).size !== networks.length) {
    throw new UsageError("--networks must be a comma-separated list without duplicates.");
  }
  for (const network of networks) {
    if (network !== "base" && network !== "arc" && network !== "solana") {
      throw new UsageError("--networks supports base and arc; Solana vault setup is unavailable.");
    }
  }
  return networks;
}
