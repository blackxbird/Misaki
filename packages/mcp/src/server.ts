import { createInterface, type Interface } from "node:readline";
import {
  ARC_MAINNET_CAIP2,
  BASE_MAINNET_CAIP2,
  DocsError,
  MovementError,
  ONRAMP_NETWORK,
  STATS_RANGES,
  SpendCapExceededError,
  SWARM_NAME_PATTERN,
  RUN_ID_PATTERN,
  SwarmError,
  TransferError,
  VAPI_CLIENT_VERSION,
  addSwarmMember,
  aggregateStats,
  createPublicFetch,
  createSupportReport,
  dissolveSwarm,
  formatUsdc,
  fundSwarm,
  fundingPageUrl,
  getVapiPaths,
  leaveSwarm,
  loadConfig,
  listAccounts,
  readSwarm,
  readReceipts,
  readSearchEvents,
  rebalanceSwarm,
  resolveRegistryUrl,
  secretStore,
  setupSwarm,
  spendCapsForWallet,
  sweepAboveCeiling,
  swarmParentResolver,
  swarmStatus,
  walletNameSchema,
  type SecretStore,
  type SpendCaps,
  type SwarmCapitalDeps,
  type SwarmFundResult,
  type SwarmSetupResult,
  type StatsRange,
  type VapiPaymentAccount,
  type VapiConfig,
  type WalletStore,
} from "@vapi-network/core";
import { routerChat as coreRouterChat } from "@vapi-network/core/router-client";
import { z } from "zod";

import { accountsSend } from "./actions/accounts.js";
import { createCallPort, walletArgument } from "./actions/call.js";
import type { ActionContext, SwarmPort } from "./actions/context.js";
import type { Action } from "./actions/define.js";
import { actions, runAction } from "./actions/register.js";
import { swarmAgentActions, detachedRunSummarySchema } from "./actions/swarm-agent.js";
import { swarmActions, type SwarmSetupOutput } from "./actions/swarm.js";
import { createAgentRunDeps } from "./agent/deps.js";
import {
  listRunRecords,
  refreshRunRecord,
  RuntimeError,
  stopRun,
  redactRunText,
  startDetachedSwarmRun,
  summarizeRunRecord,
  type Runtime,
} from "./agent/runtime.js";
import { runSwarm, SwarmRunError } from "./agent/swarm-run.js";
import {
  VapiCallError,
  callService,
  type CallToolInput,
  type CallToolResult,
} from "./tools/call.js";
import {
  accountsAddTool,
  accountsCapsTool,
  accountsSendTool,
  createAccountsPort,
  createAccountsTools,
  type AccountsToolOverrides,
  type AccountsToolsOptions,
} from "./tools/accounts.js";
import {
  authLinkTool,
  authStatusTool,
  createAuthTools,
  type AuthAgentLinkOverrides,
} from "./tools/auth.js";
import {
  createRouterTools,
  routerBuyTool,
  routerChatTool,
  routerModelsTool,
  routerUsageTool,
  type RouterCoreOverrides,
} from "./tools/router.js";
import {
  createTasksTools,
  tasksSearchTool,
  tasksShowTool,
  tasksPostTool,
  tasksProposeTool,
  tasksSubmitTool,
  tasksAwardTool,
  tasksSignTool,
  tasksFundTool,
  tasksDeliverTool,
  tasksReleaseTool,
  tasksRefundTool,
  tasksDisputeTool,
  tasksCounterEvidenceTool,
  tasksResolveUnmatchedTool,
  tasksMessageTool,
  tasksThreadTool,
  tasksWatchTool,
  tasksStatusTool,
  tasksErrorResult,
  type TasksOverrides,
} from "./tools/tasks.js";
import {
  createStatusTools,
  vapiAccountsTool,
  vapiStatusTool,
  type StatusCoreOverrides,
} from "./tools/status.js";
import { createSiblingsTool, vapiSiblingsTool } from "./tools/siblings.js";
import { getWallet, type WalletBalance } from "./tools/wallet.js";
import { createDocsTools, docsReadTool, docsSearchTool } from "./tools/docs.js";
import { SERVER_ICONS, withPresentation, type ToolPresentation } from "./tool-presentation.js";
import { WalletSession, type SessionWalletInfo } from "./wallet-session.js";
import {
  MCP_APP_VIEWS,
  VIEW_RESOURCE_META,
  createViewLoader,
  type ViewLoader,
  type ViewName,
} from "./views.js";

export { callService, type CallToolInput, type CallToolResult };

export type VapiServerOptions = {
  /** The account opened before stdio was connected. */
  account?: VapiPaymentAccount;
  config?: VapiConfig;
  fetchImpl?: typeof fetch;
  ledgerPath?: string;
  receiptsPath?: string;
  searchesPath?: string;
  reportsDirectory?: string;
  /** The accounts on this machine. Without it the server has exactly one. */
  store?: WalletStore | undefined;
  /** The account the session starts on; `VAPI_WALLET` and the default follow. */
  wallet?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** The passphrase for a legacy 0.5 keystore that has not been migrated yet. */
  passphrase?: (() => string | Promise<string>) | undefined;
  /** The OS secret store used by the vault and any legacy keystore entries. */
  secretStore?: SecretStore | undefined;
  /** Device-link functions and API base overridden by deterministic tests. */
  agentLink?: AuthAgentLinkOverrides | undefined;
  /** Core Router functions overridden by deterministic tests. */
  router?: RouterCoreOverrides | undefined;
  /** Task transport, chain adapter and clocks overridden by deterministic tests. */
  tasks?: TasksOverrides | undefined;
  /** Status probes and clock overridden by deterministic tests. */
  status?: StatusCoreOverrides | undefined;
  /** Account-link functions, device identity and clock overridden by deterministic tests. */
  accounts?: AccountsToolOverrides | undefined;
  /** Swarm capital seams overridden by deterministic tests. */
  swarm?:
    Pick<SwarmCapitalDeps, "balanceReader" | "transfer" | "randomId" | "randomNonce"> | undefined;
  /** Background runtime used by detached swarm runs. */
  runtime?: Runtime | undefined;
  /** Stop-only adapter resolution; it never enables remote startup over MCP. */
  runtimeForStop?: (kind: Runtime["kind"]) => Runtime;
};

const allWalletsArgument = {
  allWallets: z
    .boolean()
    .optional()
    .describe("Read every account's rows instead of one account's."),
};

const balanceSchema = z.object({
  network: z.string(),
  name: z.string(),
  usdcAtomic: z.string().nullable(),
  usdc: z.string().nullable(),
  error: z.string().optional(),
});

const walletToolResultSchema = z.object({
  wallet: z.string(),
  address: z.string(),
  balances: z.array(balanceSchema),
});

const walletListToolResultSchema = z.object({
  wallet: z.string().nullable(),
  default: z.string().nullable(),
  wallets: z.array(
    z.object({
      name: z.string(),
      address: z.string().optional(),
      solanaAddress: z.string().optional(),
      label: z.string().optional(),
      isDefault: z.boolean(),
      isActive: z.boolean(),
      spendCaps: z.object({
        perCallAtomic: z.string(),
        perDayAtomic: z.string(),
        perCallUsd: z.string(),
        perDayUsd: z.string(),
      }),
      balances: z.array(balanceSchema),
      balanceError: z.string().optional(),
    }),
  ),
});

const walletUseToolResultSchema = z.object({
  wallet: z.string(),
  active: z.string(),
  address: z.string().optional(),
  previous: z.string().nullable(),
  scope: z.literal("session"),
});

const fundingToolResultSchema = z.object({
  wallet: z.string(),
  address: z.string(),
  network: z.string(),
  url: z.url(),
  instructions: z.string(),
});

/** What an agent should do with the funding link: only a human can finish the payment. */
const FUNDING_PAGE_INSTRUCTIONS =
  "Give this link to your human; only they can complete the payment. USDC lands on Base at the address above, usually within a few minutes.";

const accountInfoSchema = z.object({
  caip2: z.string(),
  name: z.string(),
  address: z.string(),
  usdcBalance: z.object({ atomic: z.string(), formatted: z.string() }).nullable(),
  gasTokenBalance: z
    .object({ symbol: z.string(), atomic: z.string(), formatted: z.string() })
    .nullable()
    .optional(),
  depositUrl: z.string().optional(),
  depositInstructions: z.string().optional(),
  error: z.string().optional(),
});

const supportReportResultSchema = z.object({
  path: z.string(),
  issueUrl: z.string(),
  responseCode: z.number().int().optional(),
  report: z.object({
    message: z.string(),
    clientVersion: z.string(),
    os: z.object({ platform: z.string(), release: z.string(), arch: z.string() }),
    node: z.string(),
    receiptIds: z.array(z.string()),
    receiptAddresses: z
      .array(
        z.object({
          receiptId: z.string(),
          payer: z.string().optional(),
          payTo: z.string().optional(),
        }),
      )
      .optional(),
  }),
});

const latencyPercentilesSchema = z.object({
  p50Ms: z.number().nullable(),
  p95Ms: z.number().nullable(),
});
const outcomeValueSchema = z.object({ count: z.number().int(), rate: z.number() });
const serviceStatsSchema = z.object({
  name: z.string(),
  resourceUrl: z.string(),
  providerHost: z.string().optional(),
  spendUsd: z.string(),
  calls: z.number().int(),
});
const statsToolResultSchema = z.object({
  wallet: z.string().nullable(),
  range: z.enum(STATS_RANGES),
  generatedAt: z.string(),
  totals: z.object({
    spendUsd: z.string(),
    calls: z.number().int(),
    uniqueApis: z.number().int(),
    policyDeclines: z.number().int(),
  }),
  outcomes: z.object({
    paid: outcomeValueSchema,
    signed_in: outcomeValueSchema,
    declined_policy: outcomeValueSchema,
    failed_request: outcomeValueSchema,
    settlement_rejected: outcomeValueSchema,
    settlement_unknown: outcomeValueSchema,
  }),
  latency: z.object({
    total: latencyPercentilesSchema,
    phases: z.object({
      discover: latencyPercentilesSchema,
      quote: latencyPercentilesSchema,
      sign: latencyPercentilesSchema,
      request: latencyPercentilesSchema,
      settle: latencyPercentilesSchema,
    }),
  }),
  topServices: z.object({
    bySpend: z.array(serviceStatsSchema),
    byCalls: z.array(serviceStatsSchema),
  }),
  search: z.object({
    count: z.number().int(),
    zeroResultRate: z.number(),
    sources: z.record(
      z.string(),
      z.object({ count: z.number().int(), p95Ms: z.number().nullable() }),
    ),
  }),
});

type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: "text"; text: string }>;
};

type ToolDefinition<Shape extends z.ZodRawShape> = {
  title?: string;
  annotations?: ToolPresentation["annotations"];
  description?: string;
  deprecatedReplacement?: string;
  inputSchema: Shape;
  strictInput?: boolean;
  outputSchema?: z.ZodType;
};

type StoredTool = {
  title: string;
  annotations: ToolPresentation["annotations"];
  description?: string;
  deprecatedReplacement?: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  outputSchema?: z.ZodType;
  handler(input: unknown): Promise<ToolResult>;
};

type ListedTool = {
  name: string;
  title: string;
  annotations: ToolPresentation["annotations"];
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  _meta?: { ui: { resourceUri: string }; "ui/resourceUri": string };
};

/** Minimal MCP server implementation for stdio and deterministic in-memory tests. */

/**
 * MCP hosts (Claude Desktop) validate `outputSchema.type === "object"`; a union
 * output (oneOf/anyOf) is legal JSON Schema but is rejected, so it is omitted.
 */
function objectOutputSchema(schema: z.ZodType | undefined): { outputSchema?: unknown } {
  if (!schema) return {};
  const json = z.toJSONSchema(schema) as { type?: unknown };
  return json.type === "object" ? { outputSchema: json } : {};
}

function appViewForTool(name: string) {
  return Object.hasOwn(MCP_APP_VIEWS, name)
    ? MCP_APP_VIEWS[name as keyof typeof MCP_APP_VIEWS]
    : undefined;
}

function appViewResource({ view, uri }: { view: ViewName; uri: string }, origin: string) {
  return {
    uri,
    name: `vapi-${view}`,
    ...VIEW_RESOURCE_META[view],
    mimeType: "text/html;profile=mcp-app",
    _meta: {
      ui: {
        csp: {
          connectDomains: [origin],
          resourceDomains: ["https://assets.claude.ai", origin],
        },
        prefersBorder: view === "call-inspect",
      },
    },
  };
}

export class VapiMcpServer {
  readonly #tools = new Map<string, StoredTool>();
  readonly #onClose: (() => void) | undefined;
  #stdio: Interface | undefined;
  #views: ViewLoader | undefined;
  #viewSequence = 0;

  constructor(onClose?: () => void) {
    this.#onClose = onClose;
  }

  useViews(loader: ViewLoader): void {
    this.#views = loader;
  }

  #resources() {
    const loader = this.#views;
    return loader
      ? [MCP_APP_VIEWS["call.search"], MCP_APP_VIEWS["call.inspect"]].map((view) =>
          appViewResource(view, loader.origin),
        )
      : [];
  }

  registerTool<Shape extends z.ZodRawShape>(
    name: string,
    definition: ToolDefinition<Shape>,
    handler: (input: z.infer<z.ZodObject<Shape>>) => Promise<ToolResult>,
  ): void {
    const presentation =
      definition.title !== undefined && definition.annotations !== undefined
        ? { title: definition.title, annotations: definition.annotations }
        : withPresentation({ name, ...definition });
    const inputSchema = definition.strictInput
      ? z.strictObject(definition.inputSchema)
      : z.object(definition.inputSchema);
    this.#tools.set(name, {
      title: presentation.title,
      annotations: presentation.annotations,
      ...(definition.description ? { description: definition.description } : {}),
      ...(definition.deprecatedReplacement
        ? { deprecatedReplacement: definition.deprecatedReplacement }
        : {}),
      inputSchema,
      ...(definition.outputSchema ? { outputSchema: definition.outputSchema } : {}),
      handler: async (input) => await handler(inputSchema.parse(input ?? {})),
    });
  }

  async listTools(): Promise<{ tools: ListedTool[] }> {
    return {
      tools: [...this.#tools].map(([name, tool]) => {
        const view = appViewForTool(name);
        const uri = view && this.#views?.get(view.view) !== undefined ? view.uri : undefined;
        return {
          name,
          title: tool.title,
          annotations: tool.annotations,
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema: z.toJSONSchema(tool.inputSchema),
          ...objectOutputSchema(tool.outputSchema),
          ...(uri === undefined
            ? {}
            : { _meta: { ui: { resourceUri: uri }, "ui/resourceUri": uri } }),
        };
      }),
    };
  }

  async callTool(request: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<ToolResult> {
    const tool = this.#tools.get(request.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool ${JSON.stringify(request.name)}.` }],
      };
    }
    try {
      let result = await tool.handler(request.arguments ?? {});
      if (!result.isError && appViewForTool(request.name)) {
        result = {
          ...result,
          structuredContent: {
            ...result.structuredContent,
            _view: { createdAt: Date.now(), seq: ++this.#viewSequence },
          },
        };
      }
      return tool.deprecatedReplacement
        ? withDeprecation(result, tool.deprecatedReplacement)
        : result;
    } catch (error) {
      const result = request.name.startsWith("tasks.") ? tasksErrorResult(error) : toolError(error);
      return tool.deprecatedReplacement
        ? withDeprecation(result, tool.deprecatedReplacement)
        : result;
    }
  }

  #output: { write(chunk: string): unknown } = process.stdout;

  /**
   * Serves JSON-RPC lines from `input` and answers on `output`. The desktop
   * app hands in a socket; the CLI hands in stdio through connectStdio().
   */
  connect(input: NodeJS.ReadableStream, output: { write(chunk: string): unknown }): void {
    if (this.#stdio) return;
    this.#output = output;
    this.#stdio = createInterface({ input, crlfDelay: Infinity });
    this.#stdio.on("line", (line) => {
      void this.#handleLine(line);
    });
    this.#stdio.on("close", () => {
      this.#stdio = undefined;
      this.#onClose?.();
    });
  }

  connectStdio(): void {
    this.connect(process.stdin, process.stdout);
  }

  async close(): Promise<void> {
    this.#stdio?.close();
    this.#stdio = undefined;
    this.#onClose?.();
  }

  async #handleLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let request: Record<string, unknown>;
    try {
      request = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.#write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    const response = await this.handleRequest(request);
    if (response !== undefined) this.#write(response);
  }

  async handleRequest(request: Record<string, unknown>): Promise<
    | {
        jsonrpc: "2.0";
        id: unknown;
        result?: unknown;
        error?: { code: number; message: string };
      }
    | undefined
  > {
    const id = request.id;
    const method = request.method;
    if (typeof method !== "string" || id === undefined) return;
    try {
      let result: unknown;
      if (method === "initialize") {
        await this.#views?.warm();
        const params = asRecord(request.params);
        result = {
          protocolVersion:
            typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-11-25",
          capabilities: { tools: {}, ...(this.#views ? { resources: {} } : {}) },
          serverInfo: {
            name: "@vapi-network/mcp",
            title: "vAPI Network",
            version: VAPI_CLIENT_VERSION,
            websiteUrl: "https://vapinetwork.ai",
            icons: SERVER_ICONS,
          },
        };
      } else if (method === "resources/list") {
        result = { resources: this.#resources() };
      } else if (method === "resources/read") {
        const params = asRecord(request.params);
        const view = Object.values(MCP_APP_VIEWS).find((view) => view.uri === params?.uri);
        if (!this.#views || !view) {
          return { jsonrpc: "2.0", id, error: { code: -32002, message: "resource not found" } };
        }
        const html = await this.#views.load(view.view);
        if (html === undefined) throw new Error(`view ${view.view} is unavailable`);
        const resource = appViewResource(view, this.#views.origin);
        result = {
          contents: [
            { uri: resource.uri, mimeType: resource.mimeType, text: html, _meta: resource._meta },
          ],
        };
      } else if (method === "tools/list") {
        result = await this.listTools();
      } else if (method === "tools/call") {
        const params = asRecord(request.params);
        result = await this.callTool({
          name: typeof params?.name === "string" ? params.name : "",
          arguments: asRecord(params?.arguments),
        });
      } else if (method === "ping") {
        result = {};
      } else {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
      }
      return { jsonrpc: "2.0", id, result };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  #write(message: unknown): void {
    this.#output.write(`${JSON.stringify(message)}\n`);
  }
}

export function createVapiServer(options: VapiServerOptions = {}) {
  const accountsLifecycle = new AbortController();
  const server = new VapiMcpServer(() => accountsLifecycle.abort());
  const docs = createDocsTools({
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  server.registerTool("docs.search", docsSearchTool, async (input) =>
    asStructuredToolResult(() => docs.search(input)),
  );
  server.registerTool("docs.read", docsReadTool, async (input) =>
    asStructuredToolResult(() => docs.read(input)),
  );
  if (options.account === undefined || options.config === undefined) return server;
  const account = options.account;
  const config = options.config;
  const secrets = options.secretStore ?? secretStore();
  const session = new WalletSession({
    account,
    store: options.store,
    wallet: options.wallet,
    env: options.env,
    passphrase: options.passphrase,
    secretStore: secrets,
  });
  const guardedFetch =
    options.fetchImpl ??
    createPublicFetch({ allowPrivateNetwork: config.allowPrivateNetwork ?? false });
  const apiBase = options.agentLink?.apiBase ?? agentApiBase(config, options.env);
  server.useViews(createViewLoader({ registryUrl: apiBase, fetchImpl: guardedFetch }));
  const auth = createAuthTools({
    session,
    secrets,
    wallets: options.store,
    fetchImpl: guardedFetch,
    apiBase,
    ...(options.agentLink?.startDeviceLink
      ? { startDeviceLink: options.agentLink.startDeviceLink }
      : {}),
    ...(options.agentLink?.pollDeviceLink
      ? { pollDeviceLink: options.agentLink.pollDeviceLink }
      : {}),
    ...(options.agentLink?.saveAgentLink ? { saveAgentLink: options.agentLink.saveAgentLink } : {}),
    ...(options.agentLink?.now ? { now: options.agentLink.now } : {}),
  });

  server.registerTool("auth.link", authLinkTool, auth.link);
  server.registerTool("auth.status", authStatusTool, auth.status);

  const emptyStore = options.store !== undefined && options.store.defaultName === undefined;
  const routerSession = emptyStore
    ? new WalletSession({
        account,
        wallet: options.wallet,
        env: options.env,
        passphrase: options.passphrase,
        secretStore: secrets,
      })
    : session;
  const router = createRouterTools({
    session: routerSession,
    secrets,
    wallets: emptyStore ? undefined : options.store,
    fetchImpl: guardedFetch,
    apiBase,
    account,
    config,
    ...(options.ledgerPath === undefined ? {} : { ledgerPath: options.ledgerPath }),
    ...(options.receiptsPath === undefined ? {} : { receiptsPath: options.receiptsPath }),
    ...(options.router?.listRouterModels
      ? { listRouterModels: options.router.listRouterModels }
      : {}),
    ...(options.router?.routerUsage ? { routerUsage: options.router.routerUsage } : {}),
    ...(options.router?.routerChat ? { routerChat: options.router.routerChat } : {}),
    ...(options.router?.ownerStake ? { ownerStake: options.router.ownerStake } : {}),
    ...(options.router?.buyRouterBalance
      ? { buyRouterBalance: options.router.buyRouterBalance }
      : {}),
  });
  server.registerTool("router.models", routerModelsTool, router.models);
  server.registerTool("router.usage", routerUsageTool, router.usage);
  server.registerTool("router.chat", routerChatTool, router.chat);
  server.registerTool("router.buy", routerBuyTool, router.buy);

  const tasks = createTasksTools({
    session,
    secrets,
    wallets: options.store,
    fetchImpl: guardedFetch,
    apiBase,
    ...(options.ledgerPath === undefined ? {} : { ledgerPath: options.ledgerPath }),
    ...options.tasks,
  });
  server.registerTool("tasks.search", tasksSearchTool, tasks.search);
  server.registerTool("tasks.show", tasksShowTool, tasks.show);
  server.registerTool("tasks.post", tasksPostTool, tasks.post);
  server.registerTool("tasks.propose", tasksProposeTool, tasks.propose);
  server.registerTool("tasks.submit", tasksSubmitTool, tasks.submit);
  server.registerTool("tasks.award", tasksAwardTool, tasks.award);
  server.registerTool("tasks.sign", tasksSignTool, tasks.sign);
  server.registerTool("tasks.fund", tasksFundTool, tasks.fund);
  server.registerTool("tasks.deliver", tasksDeliverTool, tasks.deliver);
  server.registerTool("tasks.release", tasksReleaseTool, tasks.release);
  server.registerTool("tasks.refund", tasksRefundTool, tasks.refund);
  server.registerTool("tasks.dispute", tasksDisputeTool, tasks.dispute);
  server.registerTool("tasks.counter-evidence", tasksCounterEvidenceTool, tasks.counterEvidence);
  server.registerTool("tasks.resolve-unmatched", tasksResolveUnmatchedTool, tasks.resolveUnmatched);
  server.registerTool("tasks.message", tasksMessageTool, tasks.message);
  server.registerTool("tasks.thread", tasksThreadTool, tasks.thread);
  server.registerTool("tasks.watch", tasksWatchTool, tasks.watch);
  server.registerTool("tasks.status", tasksStatusTool, tasks.status);

  const status = createStatusTools({
    version: VAPI_CLIENT_VERSION,
    home: session.home,
    registry: apiBase.replace(/\/+$/u, ""),
    wallets: options.store,
    secrets,
    env: options.env,
    fetchImpl: guardedFetch,
    config,
    ...(options.router?.routerUsage === undefined
      ? {}
      : { routerClientUsage: options.router.routerUsage }),
    ...(options.status?.usdcBalance ? { usdcBalance: options.status.usdcBalance } : {}),
    ...(options.status?.routerUsage ? { routerUsage: options.status.routerUsage } : {}),
    ...(options.status?.linkStatus ? { linkStatus: options.status.linkStatus } : {}),
    ...(options.status?.timeoutMs === undefined ? {} : { timeoutMs: options.status.timeoutMs }),
    ...(options.status?.now ? { now: options.status.now } : {}),
  });
  server.registerTool("vapi.status", vapiStatusTool, status.status);
  server.registerTool("vapi.accounts", vapiAccountsTool, status.accounts);
  server.registerTool(
    "vapi.siblings",
    vapiSiblingsTool,
    createSiblingsTool({
      wallets: options.store,
      secrets,
      fetchImpl: guardedFetch,
      now: options.status?.now,
    }),
  );
  const accountsOptions: AccountsToolsOptions = {
    session,
    secrets,
    wallets: options.store,
    fetchImpl: guardedFetch,
    apiBase,
    env: options.env,
    signal: accountsLifecycle.signal,
    ...(options.accounts?.configPath === undefined
      ? {}
      : { configPath: options.accounts.configPath }),
    ...(options.accounts?.hostname === undefined ? {} : { hostname: options.accounts.hostname }),
    ...(options.accounts?.now === undefined ? {} : { now: options.accounts.now }),
    ...(options.accounts?.sleep === undefined ? {} : { sleep: options.accounts.sleep }),
    ...(options.accounts?.startDeviceLink === undefined
      ? {}
      : { startDeviceLink: options.accounts.startDeviceLink }),
    ...(options.accounts?.pollDeviceLink === undefined
      ? {}
      : { pollDeviceLink: options.accounts.pollDeviceLink }),
    ...(options.accounts?.saveAgentLink === undefined
      ? {}
      : { saveAgentLink: options.accounts.saveAgentLink }),
    ...(options.accounts?.scopes === undefined ? {} : { scopes: options.accounts.scopes }),
    ...(options.accounts?.nonce === undefined ? {} : { nonce: options.accounts.nonce }),
  };
  const accounts = createAccountsTools(accountsOptions);
  const accountsPort = createAccountsPort(accountsOptions);
  const swarmLinkOptions = {
    home: session.home,
    store: options.store!,
    secrets,
    apiBase,
    surface: "mcp" as const,
    fetchImpl: guardedFetch,
    signal: accountsLifecycle.signal,
    ...(accountsOptions.configPath === undefined ? {} : { configPath: accountsOptions.configPath }),
    ...(accountsOptions.env === undefined ? {} : { env: accountsOptions.env }),
    ...(accountsOptions.hostname === undefined ? {} : { hostname: accountsOptions.hostname }),
    ...(accountsOptions.now === undefined ? {} : { now: () => new Date(accountsOptions.now!()) }),
    ...(accountsOptions.sleep === undefined ? {} : { sleep: accountsOptions.sleep }),
    ...(accountsOptions.startDeviceLink === undefined
      ? {}
      : { startDeviceLink: accountsOptions.startDeviceLink }),
    ...(accountsOptions.pollDeviceLink === undefined
      ? {}
      : { pollDeviceLink: accountsOptions.pollDeviceLink }),
    ...(accountsOptions.saveAgentLink === undefined
      ? {}
      : { saveAgentLink: accountsOptions.saveAgentLink }),
  };
  const swarmCapitalDependencies = (): SwarmCapitalDeps => ({
    home: session.home,
    store: options.store!,
    secrets,
    apiBase,
    config,
    fetchImpl: guardedFetch,
    ...(options.ledgerPath === undefined ? {} : { ledgerPath: options.ledgerPath }),
    ...(accountsOptions.now === undefined ? {} : { now: accountsOptions.now }),
    ...options.swarm,
    reconcileRuns: async ({ home, name }) => {
      const records = await listRunRecords(home, { swarm: name });
      for (const record of records) {
        await refreshRunRecord(home, record, options.runtime);
      }
    },
    unlock: async (account) => {
      const selected = await session.payment(account);
      return {
        address: selected.account.address,
        signTypedData: async (typedData) => await selected.account.signTypedData(typedData),
      };
    },
  });
  const swarmPort: SwarmPort | undefined =
    options.store === undefined
      ? undefined
      : {
          async setup(input) {
            const { fundUsd, from, network, ...setup } = input;
            const result = await setupSwarm({
              ...swarmLinkOptions,
              ...setup,
              ...(network === undefined
                ? {}
                : { network: network === "base" ? BASE_MAINNET_CAIP2 : ARC_MAINNET_CAIP2 }),
            });
            const fund =
              fundUsd === undefined
                ? undefined
                : await fundSwarm(
                    { name: input.name, amountUsd: fundUsd, from: from!, setup: true },
                    swarmCapitalDependencies(),
                  );
            if (fund !== undefined) result.swarm = await readSwarm(session.home, input.name);
            return publicSwarmSetupResult(result, "setup", fund);
          },
          async add(input) {
            const result = await addSwarmMember({ ...swarmLinkOptions, ...input });
            return publicSwarmSetupResult(result, "add");
          },
          async leave(input) {
            return await leaveSwarm(input, swarmCapitalDependencies());
          },
          async fund(input) {
            return await fundSwarm(input, swarmCapitalDependencies());
          },
          async rebalance(input) {
            return await rebalanceSwarm(input, swarmCapitalDependencies());
          },
          async status(input) {
            return await swarmStatus({
              ...input,
              home: session.home,
              store: options.store!,
              config,
              fetchImpl: guardedFetch,
            });
          },
          async dissolve(input) {
            return await dissolveSwarm(input, swarmCapitalDependencies());
          },
        };

  const callPort = createCallPort({
    config,
    fetchImpl: guardedFetch,
    ...(options.searchesPath === undefined ? {} : { searchesPath: options.searchesPath }),
    cacheMarketplaceHits: true,
    async resolvePayment(wallet) {
      // Resolve and unlock at call time: wallet.use must be able to move the
      // session, and the next payment must use that account and its caps.
      const selected = await session.payment(wallet);
      return {
        account: selected.account,
        fetchImpl: guardedFetch,
        ledgerPath: options.ledgerPath ?? getVapiPaths().ledger,
        receiptsPath: options.receiptsPath ?? getVapiPaths().receipts,
        wallet: selected.wallet.name,
        ...(selected.spendCaps ? { spendCaps: selected.spendCaps } : {}),
        ...(options.store === undefined
          ? {}
          : {
              ceilingSweep: {
                account: selected.wallet.name,
                auditHome: session.home,
                run: async (signal: AbortSignal) =>
                  await sweepAboveCeiling({
                    store: options.store!,
                    secrets,
                    apiBase,
                    account: selected.wallet.name,
                    config,
                    fetchImpl: guardedFetch,
                    signal,
                    unlock: async () => selected.account,
                    resolveParent: swarmParentResolver(options.store!.home),
                  }),
              },
            }),
      };
    },
  });
  const actionContext: ActionContext = {
    config,
    fetch: guardedFetch,
    clock: () => new Date(),
    call: callPort,
    accounts: accountsPort,
    swarm: swarmPort,
    ...(options.store === undefined
      ? {}
      : {
          swarmRun: {
            async run(input) {
              if (input.detach === true) {
                if (options.runtime === undefined) {
                  throw new Error("detached runs are not available in this MCP server");
                }
                // A remote runtime exports a member key; that stays a CLI act by the owner.
                if (options.runtime.kind !== "local") {
                  throw new Error(
                    "Only the local runtime is available over MCP; run remote members from the CLI.",
                  );
                }
                return await startDetachedSwarmRun(
                  { ...input, mode: input.mode ?? "lead" },
                  {
                    home: session.home,
                    store: options.store!,
                    runtime: options.runtime,
                    ...(options.ledgerPath === undefined ? {} : { ledgerPath: options.ledgerPath }),
                  },
                );
              }
              return await runSwarm(
                { ...input, mode: input.mode ?? "lead" },
                {
                  home: session.home,
                  store: options.store!,
                  capital: swarmCapitalDependencies(),
                  async status(name) {
                    return await swarmStatus({
                      name,
                      home: session.home,
                      store: options.store!,
                      config,
                      fetchImpl: guardedFetch,
                    });
                  },
                  async depsForMember(member, runOpts) {
                    const selected = await session.payment(member.account);
                    const spendCaps =
                      selected.spendCaps ??
                      (await spendCapsForWallet(options.store!, selected.wallet.name));
                    const paths = getVapiPaths(session.home);
                    const chatRequest = options.router?.routerChat ?? coreRouterChat;
                    const chat = async (request: Parameters<typeof coreRouterChat>[1]) =>
                      await chatRequest(
                        {
                          secrets,
                          wallets: options.store!,
                          wallet: selected.wallet.name,
                          fetchImpl: guardedFetch,
                          refill: {
                            account: selected.account,
                            config,
                            caps: async () => {
                              await options.store!.reload();
                              return await spendCapsForWallet(options.store!, selected.wallet.name);
                            },
                            paths: {
                              ledgerPath: options.ledgerPath ?? paths.ledger,
                              receiptsPath: options.receiptsPath ?? paths.receipts,
                            },
                            run: { id: runOpts.runId, ...runOpts.runMeta },
                            runBudget: runOpts.budget,
                          },
                        },
                        request,
                      );
                    return createAgentRunDeps({
                      profile: runOpts.profile,
                      config,
                      home: session.home,
                      account: selected.account,
                      wallet: selected.wallet.name,
                      spendCaps,
                      currentSpendCaps: async () => {
                        await options.store!.reload();
                        return await spendCapsForWallet(options.store!, selected.wallet.name);
                      },
                      chat,
                      approve: async () => false,
                      tty: false,
                      fetchImpl: guardedFetch,
                      ...(options.ledgerPath === undefined
                        ? {}
                        : { ledgerPath: options.ledgerPath }),
                      ...(options.receiptsPath === undefined
                        ? {}
                        : { receiptsPath: options.receiptsPath }),
                      ceilingSweep: {
                        account: selected.wallet.name,
                        auditHome: session.home,
                        run: async (signal: AbortSignal) =>
                          await sweepAboveCeiling({
                            store: options.store!,
                            secrets,
                            apiBase,
                            account: selected.wallet.name,
                            config,
                            fetchImpl: guardedFetch,
                            signal,
                            unlock: async () => selected.account,
                            resolveParent: swarmParentResolver(options.store!.home),
                          }),
                      },
                      budget: runOpts.budget,
                      runId: runOpts.runId,
                      runMeta: runOpts.runMeta,
                    });
                  },
                  ...(options.ledgerPath === undefined ? {} : { ledgerPath: options.ledgerPath }),
                },
              );
            },
          },
          swarmRuns: {
            async list(input) {
              await readSwarm(session.home, input.name);
              const records = await listRunRecords(session.home, { swarm: input.name });
              const refreshed = await Promise.all(
                records.map(
                  async (record) => await refreshRunRecord(session.home, record, options.runtime),
                ),
              );
              return { swarm: input.name, runs: refreshed.map(summarizeRunRecord) };
            },
          },
        }),
    caller: { surface: "mcp" },
  };
  server.registerTool("accounts.add", accountsAddTool, accounts.add);
  server.registerTool("accounts.caps", accountsCapsTool, accounts.caps);
  server.registerTool("accounts.send", accountsSendTool, async (input) =>
    asStructuredToolResult(
      () => runAction(accountsSend, input, actionContext),
      accountsSendErrorResult,
    ),
  );
  const actionAliases: Record<string, string> = {
    "call.search": "search",
    "call.inspect": "inspect",
    "call.pay": "call",
  };
  for (const action of actions) {
    if (action.name === accountsSend.name || action.name.startsWith("swarm.")) continue;
    const registeredAction = action as Action<unknown, object>;
    const tool = {
      description: action.description,
      inputSchema: action.input.shape,
      outputSchema:
        appViewForTool(action.name) && action.output instanceof z.ZodObject
          ? action.output.extend({
              _view: z.object({ createdAt: z.number(), seq: z.number().int() }).optional(),
            })
          : action.output,
    };
    const handler = async (input: unknown) =>
      asStructuredToolResult(() => runAction(registeredAction, input, actionContext));
    server.registerTool(action.name, tool, handler);
    const alias = actionAliases[action.name];
    if (alias) server.registerTool(alias, deprecatedTool(tool, action.name), handler);
  }

  const balance = async (input: { wallet?: string }) =>
    asStructuredToolResult(async () => {
      const { wallet, ...addresses } = await session.addressesFor(input.wallet);
      return {
        wallet: wallet.name,
        ...(await getWallet(addresses, config, {
          fetchImpl: guardedFetch,
        })),
      };
    });
  server.registerTool(
    "wallet.address",
    {
      description: "Show the address of a local non-custodial account.",
      inputSchema: { ...walletArgument },
      outputSchema: z.object({ wallet: z.string(), address: z.string() }),
    },
    async (input) =>
      asStructuredToolResult(async () => {
        const { wallet, address } = await session.addressesFor(input.wallet);
        return { wallet: wallet.name, address };
      }),
  );
  server.registerTool(
    "wallet.balance",
    {
      description: "Show a local account's address and USDC balances on configured networks.",
      inputSchema: { ...walletArgument },
      outputSchema: walletToolResultSchema,
    },
    balance,
  );
  server.registerTool(
    "wallet.accounts",
    {
      description:
        "List configured network accounts, USDC and gas balances, and local deposit instructions for one local account.",
      inputSchema: { ...walletArgument },
      outputSchema: z.object({ wallet: z.string(), accounts: z.array(accountInfoSchema) }),
    },
    async (input) =>
      asStructuredToolResult(async () => {
        const { wallet, address, solana } = await session.addressesFor(input.wallet);
        return {
          wallet: wallet.name,
          accounts: await listAccounts({
            address,
            ...(solana ? { solanaAddress: solana.address } : {}),
            config,
            fetchImpl: guardedFetch,
          }),
        };
      }),
  );
  server.registerTool(
    "wallet.list",
    {
      description:
        "List every account on this machine with its address, spend caps and USDC balances, and say which one this session pays from. Read-only and never needs a passphrase or an unlocked vault.",
      inputSchema: {},
      outputSchema: walletListToolResultSchema,
    },
    async () =>
      asStructuredToolResult(async () => {
        // list() re-reads wallets.json, so read the default after it.
        const accounts = await session.list();
        return {
          wallet: session.activeName ?? null,
          default: session.store?.defaultName ?? session.activeName ?? null,
          wallets: await Promise.all(
            accounts.map((info) => describeWallet(info, config, guardedFetch)),
          ),
        };
      }),
  );
  server.registerTool(
    "wallet.use",
    {
      description:
        "Point this MCP session at another account for the rest of the process. Session-only: it never writes wallets.json and never changes the default your human set, so their terminal keeps using their own account. Renaming, removing, backing up and restoring accounts stay with a human at the CLI.",
      inputSchema: {
        name: walletNameSchema.describe("Name of an existing account, as shown by wallet.list."),
      },
      outputSchema: walletUseToolResultSchema,
    },
    async (input) =>
      asStructuredToolResult(async () => {
        const used = await session.use(input.name);
        return { wallet: used.active, scope: "session" as const, ...used };
      }),
  );
  server.registerTool(
    "wallet.fund",
    {
      description:
        "Return the hosted funding page for a local account so you can hand the link to your human. The page takes a card via Coinbase (needs a Coinbase account; US guest checkout), a transfer from MetaMask/Coinbase Wallet/WalletConnect, or a bridge from another chain. No network call, no expiring link, and vAPI never holds the funds.",
      inputSchema: {
        ...walletArgument,
        amountUsd: z
          .number()
          .positive()
          .max(100_000)
          .optional()
          .describe("Fiat amount in USD to prefill on the funding page."),
      },
      outputSchema: fundingToolResultSchema,
    },
    async (input) =>
      asStructuredToolResult(async () => {
        const { wallet, address } = await session.addressesFor(input.wallet);
        return {
          wallet: wallet.name,
          address,
          network: ONRAMP_NETWORK,
          url: fundingPageUrl(
            resolveRegistryUrl(),
            address,
            input.amountUsd === undefined ? {} : { amount: input.amountUsd },
          ),
          instructions: FUNDING_PAGE_INSTRUCTIONS,
        };
      }),
  );
  server.registerTool(
    "wallet",
    deprecatedTool(
      {
        description: "Show a local account's address and USDC balances on configured networks.",
        inputSchema: { ...walletArgument },
        outputSchema: walletToolResultSchema,
      },
      "wallet.balance",
    ),
    balance,
  );

  /** The wallet a ledger view is filtered by, or null for every wallet. */
  const ledgerWallet = async (input: {
    wallet?: string;
    allWallets?: boolean;
  }): Promise<string | null> =>
    input.allWallets === true ? null : (await session.resolveLatest(input.wallet)).name;

  server.registerTool(
    "receipts.list",
    {
      description:
        "List local append-only x402 call receipts for one account, newest entries last.",
      inputSchema: {
        ...walletArgument,
        ...allWalletsArgument,
        limit: z.number().int().min(0).max(1_000).optional(),
      },
      outputSchema: z.object({ wallet: z.string().nullable(), receipts: z.array(z.unknown()) }),
    },
    async (input) =>
      asStructuredToolResult(async () => {
        const wallet = await ledgerWallet(input);
        return {
          wallet,
          receipts: await readReceipts(options.receiptsPath ?? getVapiPaths().receipts, {
            ...(input.limit === undefined ? {} : { limit: input.limit }),
            ...(wallet === null ? {} : { wallet }),
          }),
        };
      }),
  );
  server.registerTool(
    "receipts.stats",
    {
      description: "Aggregate local call and search metrics for one account. No data is uploaded.",
      inputSchema: {
        ...walletArgument,
        ...allWalletsArgument,
        range: z.enum(STATS_RANGES).optional(),
      },
      outputSchema: statsToolResultSchema,
    },
    async (input) =>
      asStructuredToolResult(async () => {
        const paths = getVapiPaths();
        const wallet = await ledgerWallet(input);
        return {
          wallet,
          ...aggregateStats({
            receipts: await readReceipts(options.receiptsPath ?? paths.receipts, {
              ...(wallet === null ? {} : { wallet }),
            }),
            searches: await readSearchEvents(options.searchesPath ?? paths.searches),
            range: (input.range ?? "24h") as StatsRange,
          }),
        };
      }),
  );
  server.registerTool(
    "support.report",
    {
      description:
        "Write a privacy-preserving bug report locally. Upload only when send is explicitly true.",
      inputSchema: {
        message: z.string().trim().min(1).max(10_000),
        includeAddresses: z.boolean().optional(),
        send: z.boolean().optional(),
      },
      outputSchema: supportReportResultSchema,
    },
    async (input) =>
      asStructuredToolResult(() =>
        createSupportReport({
          message: input.message,
          includeAddresses: input.includeAddresses,
          send: input.send,
          receiptsPath: options.receiptsPath ?? getVapiPaths().receipts,
          ...(options.reportsDirectory ? { reportsDirectory: options.reportsDirectory } : {}),
          fetchImpl: guardedFetch,
          allowPrivateNetwork: config.allowPrivateNetwork,
        }),
      ),
  );

  const stopInput = z
    .strictObject({
      name: z.string().regex(SWARM_NAME_PATTERN),
      runId: z.string().regex(RUN_ID_PATTERN).optional(),
      all: z.boolean().optional(),
    })
    .refine((input) => (input.runId !== undefined) !== (input.all === true), {
      message: "Provide exactly one of runId or all: true.",
    });
  server.registerTool(
    "swarm.stop",
    {
      description:
        "Stop one or all tracked workers of a swarm, including unknown runs. A successful stop confirms destruction or absence; failed stops remain unresolved. Does not move money or start workers.",
      inputSchema: stopInput.shape,
      strictInput: true,
      outputSchema: z.object({
        swarm: z.string(),
        stopped: z.array(detachedRunSummarySchema),
        unchanged: z.array(detachedRunSummarySchema),
        failed: z.array(
          z.object({ runId: z.string(), member: z.string(), code: z.string(), error: z.string() }),
        ),
      }),
    },
    async (rawInput) => {
      const result = await asStructuredToolResult(
        async () => {
          const input = stopInput.parse(rawInput);
          await readSwarm(session.home, input.name);
          const records = await listRunRecords(session.home, { swarm: input.name });
          const targets =
            input.all === true ? records : records.filter((record) => record.runId === input.runId);
          if (input.runId !== undefined && targets.length === 0)
            throw new RuntimeError(
              "run_not_found",
              `Run ${input.runId} was not found for swarm ${input.name}.`,
            );
          const stopped: ReturnType<typeof summarizeRunRecord>[] = [];
          const unchanged: ReturnType<typeof summarizeRunRecord>[] = [];
          const failed: Array<{ runId: string; member: string; code: string; error: string }> = [];
          for (const record of targets) {
            if (
              record.state === "finished" ||
              record.state === "failed" ||
              record.state === "stopped"
            ) {
              unchanged.push(summarizeRunRecord(record));
              continue;
            }
            try {
              const runtime = options.runtimeForStop?.(record.kind) ?? options.runtime;
              if (runtime?.kind !== record.kind)
                throw new RuntimeError(
                  "runtime_unavailable",
                  `Runtime ${record.kind} is unavailable. Stop it with: vapi swarm stop ${input.name} --all`,
                );
              const updated = await stopRun({ home: session.home, runtime, record });
              (updated.state === "stopped" ? stopped : unchanged).push(summarizeRunRecord(updated));
            } catch (error) {
              failed.push({
                runId: record.runId,
                member: record.member.account,
                code: error instanceof RuntimeError ? error.code : "runtime_stop_failed",
                error: redactRunText(
                  error instanceof Error ? error.message : String(error),
                  options.env ?? process.env,
                ),
              });
            }
          }
          return { swarm: input.name, stopped, unchanged, failed };
        },
        (error) =>
          error instanceof RuntimeError
            ? {
                isError: true as const,
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({ code: error.code, message: error.message }),
                  },
                ],
              }
            : swarmErrorResult(error),
      );
      return "structuredContent" in result &&
        Array.isArray(result.structuredContent.failed) &&
        result.structuredContent.failed.length > 0
        ? { ...result, isError: true as const }
        : result;
    },
  );

  for (const action of swarmActions) {
    const registeredAction = action as Action<unknown, object>;
    server.registerTool(
      action.name,
      {
        description: action.description,
        inputSchema: action.input.shape,
        outputSchema: action.output,
      },
      async (input) =>
        asStructuredToolResult(
          () => runAction(registeredAction, input, actionContext),
          swarmErrorResult,
        ),
    );
  }

  for (const action of swarmAgentActions) {
    const registeredAction = action as Action<unknown, object>;
    server.registerTool(
      action.name,
      {
        description: action.description,
        inputSchema: action.input.shape,
        outputSchema: action.output,
      },
      async (input) =>
        asStructuredToolResult(
          () => runAction(registeredAction, input, actionContext),
          swarmErrorResult,
        ),
    );
  }

  return server;
}

function publicSwarmSetupResult(
  result: SwarmSetupResult,
  operation: "setup" | "add",
  fund?: SwarmFundResult,
): SwarmSetupOutput {
  const next = result.next.map((step) =>
    step.kind === "caps"
      ? step
      : {
          kind: step.kind,
          account: step.account,
          userCode: step.userCode,
          verificationUri: step.verificationUri,
          expiresInSeconds: step.expiresInSeconds,
        },
  );
  const message =
    next.length === 0
      ? operation === "setup"
        ? `Swarm ${result.swarm.name} is set up.`
        : `The swarm member is ready in ${result.swarm.name}.`
      : `Complete ${next.length} next ${next.length === 1 ? "step" : "steps"}, then rerun swarm.${operation}.`;
  return {
    swarm: result.swarm,
    members: result.members,
    next,
    ...(fund === undefined ? {} : { fund }),
    message,
  };
}

const MARKETPLACE_DISCOVERY_PATH = "/api/call/discovery";

/** Derive the API origin from the same configured discovery endpoint the CLI uses. */
function agentApiBase(config: VapiConfig, env: NodeJS.ProcessEnv | undefined): string {
  try {
    const url = new URL(config.marketplaceDiscoveryUrl);
    const path = url.pathname.replace(/\/+$/u, "");
    if (!path.endsWith(MARKETPLACE_DISCOVERY_PATH)) return resolveRegistryUrl(env);
    url.search = "";
    url.hash = "";
    url.pathname = path.slice(0, path.length - MARKETPLACE_DISCOVERY_PATH.length) || "/";
    return url.href;
  } catch {
    return resolveRegistryUrl(env);
  }
}

/**
 * One `wallet.list` row: what the registry knows, the caps in both atomic USDC
 * and US dollars, and the balances. A wallet whose RPC call fails reports it in
 * `balanceError` and does not take the rest of the list down with it.
 */
async function describeWallet(
  info: SessionWalletInfo,
  config: VapiConfig,
  fetchImpl: typeof fetch,
): Promise<{
  name: string;
  address?: string;
  solanaAddress?: string;
  label?: string;
  isDefault: boolean;
  isActive: boolean;
  spendCaps: {
    perCallAtomic: string;
    perDayAtomic: string;
    perCallUsd: string;
    perDayUsd: string;
  };
  balances: WalletBalance[];
  balanceError?: string;
}> {
  const caps = info.spendCaps ?? config.spendCaps;
  const row = {
    name: info.name,
    ...(info.address === undefined ? {} : { address: info.address }),
    ...(info.solanaAddress === undefined ? {} : { solanaAddress: info.solanaAddress }),
    ...(info.label === undefined ? {} : { label: info.label }),
    isDefault: info.isDefault,
    isActive: info.isActive,
    spendCaps: capsInBothUnits(caps),
  };
  if (info.address === undefined) {
    return {
      ...row,
      balances: [],
      balanceError: `Account ${info.name} records no address; its legacy keystore is missing or unreadable.`,
    };
  }
  try {
    const wallet = await getWallet(
      {
        address: info.address as `0x${string}`,
        ...(info.solanaAddress ? { solana: { address: info.solanaAddress } } : {}),
      },
      config,
      { fetchImpl },
    );
    // One wallet's unreachable RPC must not take the whole list down, so the
    // failure is reported on its row and the other wallets still answer.
    const failed = wallet.balances.filter((entry) => entry.error !== undefined);
    return {
      ...row,
      balances: wallet.balances,
      ...(failed.length > 0 && failed.length === wallet.balances.length
        ? { balanceError: failed[0]?.error ?? "No balance could be read." }
        : {}),
    };
  } catch (error) {
    return {
      ...row,
      balances: [],
      balanceError: error instanceof Error ? error.message : String(error),
    };
  }
}

function capsInBothUnits(caps: SpendCaps): {
  perCallAtomic: string;
  perDayAtomic: string;
  perCallUsd: string;
  perDayUsd: string;
} {
  return {
    perCallAtomic: caps.perCallAtomic,
    perDayAtomic: caps.perDayAtomic,
    perCallUsd: formatUsdc(BigInt(caps.perCallAtomic)),
    perDayUsd: formatUsdc(BigInt(caps.perDayAtomic)),
  };
}

function deprecatedTool<T extends { description?: string }>(
  tool: T,
  replacement: string,
): T & { deprecatedReplacement: string } {
  return {
    ...tool,
    description: `Deprecated: use ${replacement}. ${tool.description ?? ""}`.trim(),
    deprecatedReplacement: replacement,
  };
}

function withDeprecation<T extends { content: Array<{ type: "text"; text: string }> }>(
  result: T,
  replacement: string,
): T {
  const [first, ...rest] = result.content;
  const notice = `DEPRECATED: use ${replacement}; this alias will be removed in a later release.`;
  return {
    ...result,
    content: [{ type: "text", text: first ? `${notice}\n${first.text}` : notice }, ...rest],
  };
}

async function asStructuredToolResult<T extends object>(
  operation: () => Promise<T>,
  onError: (error: unknown) => ReturnType<typeof toolError> = toolError,
) {
  try {
    const value = await operation();
    return {
      structuredContent: value as Record<string, unknown>,
      content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    };
  } catch (error) {
    return onError(error);
  }
}

function accountsSendErrorResult(error: unknown) {
  if (!(error instanceof TransferError)) return toolError(error);
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ code: error.code, message: error.message }),
      },
    ],
  };
}

function swarmErrorResult(error: unknown) {
  if (
    !(error instanceof SwarmError) &&
    !(error instanceof SwarmRunError) &&
    !(error instanceof MovementError) &&
    !(error instanceof TransferError)
  ) {
    return toolError(error);
  }
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ code: error.code, message: error.message }),
      },
    ],
  };
}

export async function startStdioServer(options: VapiServerOptions) {
  const server = createVapiServer(options);
  server.connectStdio();
  return server;
}

export async function loadServerConfig() {
  return await loadConfig();
}

export function toolError(error: unknown) {
  const spendCapError = serializeSpendCapError(error);
  const text =
    spendCapError !== undefined
      ? JSON.stringify(spendCapError, null, 2)
      : error instanceof VapiCallError
        ? JSON.stringify(
            {
              error: error.message,
              code: error.code,
              ...(error.possibleSettlement
                ? {
                    possibleSettlement: Object.fromEntries(
                      Object.entries(error.possibleSettlement).filter(
                        ([key]) => key !== "authorizationTransaction",
                      ),
                    ),
                  }
                : {}),
              ...(error.paymentRejection ? { paymentRejection: error.paymentRejection } : {}),
              ...(error.confirmedSettlement
                ? { confirmedSettlement: error.confirmedSettlement }
                : {}),
            },
            null,
            2,
          )
        : error instanceof DocsError
          ? JSON.stringify({ error: error.message, code: error.code }, null, 2)
          : error instanceof Error
            ? error.message
            : String(error);
  return {
    isError: true as const,
    content: [{ type: "text" as const, text }],
  };
}

function serializeSpendCapError(error: unknown): Record<string, unknown> | undefined {
  const record = asRecord(error);
  if (
    !(error instanceof SpendCapExceededError) &&
    (record === undefined || record.code !== "spend_cap_exceeded")
  ) {
    return undefined;
  }
  const value = error as SpendCapExceededError;
  if (typeof value.amountUsd !== "string" || typeof value.limitUsd !== "string") return undefined;
  if (
    value.cap !== "per_call" &&
    value.cap !== "per_day" &&
    value.cap !== "max_price" &&
    value.cap !== "max_amount" &&
    value.cap !== "run_budget"
  ) {
    return undefined;
  }
  const message = typeof value.message === "string" ? value.message : "A spend cap was exceeded.";
  return {
    error: message,
    code: "spend_cap_exceeded",
    cap: value.cap,
    amountUsd: value.amountUsd,
    limitUsd: value.limitUsd,
    ...(typeof value.spentUsd === "string" ? { spentUsd: value.spentUsd } : {}),
    ...(typeof value.wallet === "string" ? { wallet: value.wallet } : {}),
    command: typeof value.command === "string" ? value.command : null,
    retryable: false,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
