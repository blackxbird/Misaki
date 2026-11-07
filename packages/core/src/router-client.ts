import { randomUUID } from "node:crypto";

import { z } from "zod";
import { encodeFunctionData } from "viem";

import {
  AGENT_LINK_REVOKED_MESSAGE,
  AgentLinkError,
  agentAccessToken,
  agentFetch,
  agentSecretAccounts,
  withAgentCredentialLock,
} from "./agent-link.js";
import type { RunRef } from "./agent-run.js";
import { FileLockedError } from "./atomic-file.js";
import { appendAudit } from "./audit.js";
import { sweepAboveCeiling } from "./ceiling.js";
import type { SpendCaps, VapiConfig } from "./config.js";
import { getVapiPaths, loadConfig } from "./config.js";
import type { VapiPaymentAccount } from "./keystore.js";
import { createPublicFetch } from "./net-guard.js";
import { explorerAddressUrl, formatUsdc, getNetworkDefinition, requireRpcUrl } from "./networks.js";
import { readReceipts, type Receipt } from "./receipts.js";
import type { PaymentWarning } from "./payment-warning.js";
import type { RunBudget } from "./run-budget.js";
import type { SecretStore } from "./secret-store.js";
import { SpendCapExceededError } from "./spend-cap-exceeded.js";
import { SpendCapError } from "./spend-policy.js";
import { swarmParentResolver } from "./swarm.js";
import {
  ROUTER_TOPUP_TIERS,
  type AgentLink,
  type RouterTopupTier,
  type RouterPendingPurchase,
  type WalletName,
  type WalletStore,
} from "./wallet-store.js";
import { payRequest } from "./x402-pay.js";

export { ROUTER_TOPUP_TIERS, type RouterRefill, type RouterTopupTier } from "./wallet-store.js";

export type RouterModel = { id: string; [k: string]: unknown };

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  tools?: unknown[];
  tool_choice?: unknown;
};

export type ChatResult = {
  /** A successful or recovered purchase, including any post-payment warnings. */
  refill?: RouterPurchaseResult;
  content: string | null;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  model: string;
  keyUsed: "stake" | "balance";
};

export type AgentRouterUsage = {
  compute: {
    allowanceUsd: number;
    spentTodayUsd: number;
    remainingTodayUsd: number;
    resetsAt: string;
    ownerLimitUsd: number;
    ownerSpentUsd: number;
  };
  balance: { purchasedUsd: number; spentUsd: number; remainingUsd: number } | null;
};

export class RouterClientError extends Error {
  constructor(
    readonly code:
      | "not_linked"
      | "no_router_key"
      | "budget_exhausted"
      | "rate_limited"
      | "http"
      | "refill_pending",
    message: string,
    readonly status?: number,
    /** A prior purchase awaiting recovery/confirmation. Never repeat its payment. */
    readonly refill?: RouterPurchaseResult,
  ) {
    super(message);
    this.name = "RouterClientError";
  }

  /** Public payment evidence for CLI/MCP errors, without credential or provider fields. */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.refill === undefined ? {} : { refill: routerPurchaseView(this.refill) }),
    };
  }
}

export const ROUTER_KEY_REVOKED_MESSAGE =
  "The Router key was revoked. Run vapi login to link again, or vapi router key --rotate if the link is still active.";

export type RouterClientDeps = {
  secrets: SecretStore;
  wallets: WalletStore;
  wallet: WalletName;
  fetchImpl?: typeof fetch;
  refill?: {
    account: VapiPaymentAccount | (() => Promise<VapiPaymentAccount>);
    config: VapiConfig;
    caps: SpendCaps | (() => Promise<SpendCaps>);
    paths?: { ledgerPath?: string; receiptsPath?: string };
    now?: Date | (() => Date);
    allowanceExpiresAt?: Date;
    runBudget?: RunBudget;
    run?: RunRef;
  };
};

export const DEFAULT_ROUTER_BASE_URL = "https://router.vapinetwork.ai";

const publicFetch = createPublicFetch({ allowPrivateNetwork: false });

const routerModelSchema = z.object({ id: z.string() }).passthrough();
const routerModelsResponseSchema = z.object({ models: z.array(routerModelSchema) });

const routerUsageSchema: z.ZodType<AgentRouterUsage> = z.object({
  compute: z.object({
    allowanceUsd: z.number(),
    spentTodayUsd: z.number(),
    remainingTodayUsd: z.number(),
    resetsAt: z.string(),
    ownerLimitUsd: z.number(),
    ownerSpentUsd: z.number(),
  }),
  balance: z
    .object({
      purchasedUsd: z.number(),
      spentUsd: z.number(),
      remainingUsd: z.number(),
    })
    .nullable(),
});

const routerKeyResponseSchema = z.object({
  router_key: z.string().min(1),
  router_base_url: z.string().min(1),
});

const ownerStakeResponseSchema = z.object({
  owner: z.string(),
  epoch: z.number(),
  stake: z.string().regex(/^\d+$/u),
  computeTodayUsd: z.number(),
  stakeUrl: z.string(),
});

const chatResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                type: z.literal("function"),
                function: z.object({ name: z.string(), arguments: z.string() }),
              }),
            )
            .optional(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      total_tokens: z.number(),
    })
    .optional(),
  model: z.string().optional(),
});

export async function listRouterModels(deps: {
  apiBase: string;
  fetchImpl?: typeof fetch;
}): Promise<RouterModel[]> {
  const fetchImpl = deps.fetchImpl ?? publicFetch;
  let response: Response;
  try {
    response = await fetchImpl(`${trimTrailingSlashes(deps.apiBase)}/api/router/models`, {
      method: "GET",
    });
  } catch {
    throw new RouterClientError("http", "The vAPI Router model request failed.");
  }
  if (!response.ok) {
    throw new RouterClientError(
      "http",
      `The vAPI Router model request returned HTTP ${response.status}.`,
      response.status,
    );
  }
  const parsed = routerModelsResponseSchema.safeParse(await responseJson(response));
  if (!parsed.success) {
    throw new RouterClientError("http", "The vAPI Router model response was invalid.");
  }
  return parsed.data.models;
}

export async function routerUsage(deps: RouterClientDeps): Promise<AgentRouterUsage> {
  const response = await consoleRequest(
    deps,
    "/api/agents/self/router",
    { method: "GET" },
    "The vAPI Router usage request failed.",
  );
  if (!response.ok) {
    throw new RouterClientError(
      "http",
      `The vAPI Router usage request returned HTTP ${response.status}.`,
      response.status,
    );
  }
  const parsed = routerUsageSchema.safeParse(await responseJson(response));
  if (!parsed.success) {
    throw new RouterClientError("http", "The vAPI Router usage response was invalid.");
  }
  return parsed.data;
}

/** Public facts about a completed purchase, without guessing from its requested tier. */
export function routerPurchaseSummary(receipt: Receipt): {
  amountUsd: number | null;
  network: string;
} {
  const atomic = receipt.quote?.amountAtomic;
  const amount =
    atomic !== undefined && /^\d+$/u.test(atomic) ? Number(formatUsdc(BigInt(atomic))) : null;
  const settlement = z
    .object({ network: z.string().trim().min(1) })
    .safeParse(receipt.settlement?.evidence);
  return {
    amountUsd: amount !== null && Number.isFinite(amount) ? amount : null,
    network:
      receipt.quote?.network?.trim() || (settlement.success ? settlement.data.network : "unknown"),
  };
}

export type RouterPurchaseWarning = PaymentWarning;

export type RouterPurchaseResult = {
  receipt: Receipt;
  balance: AgentRouterUsage["balance"];
  /** Post-payment failures; the receipt remains authoritative. Never retry the purchase for these. */
  warnings?: RouterPurchaseWarning[];
};

/** Public CLI/MCP payment evidence; never includes credentials or provider data. */
export function routerPurchaseView(result: RouterPurchaseResult) {
  return {
    receipt: {
      id: result.receipt.id,
      ...routerPurchaseSummary(result.receipt),
      ...(result.receipt.settlement?.transaction === undefined
        ? {}
        : { transaction: result.receipt.settlement.transaction }),
    },
    balance:
      result.balance === null
        ? null
        : {
            purchasedUsd: result.balance.purchasedUsd,
            spentUsd: result.balance.spentUsd,
            remainingUsd: result.balance.remainingUsd,
          },
    ...(result.warnings === undefined
      ? {}
      : {
          warnings: result.warnings.map(({ code, message }) => ({ code, message })),
        }),
  };
}

type RouterBuyDeps = RouterClientDeps & {
  account: VapiPaymentAccount;
  config: VapiConfig;
  caps: SpendCaps;
  paths?: { ledgerPath?: string; receiptsPath?: string };
  now?: Date;
  allowanceExpiresAt?: Date;
  runBudget?: RunBudget;
  run?: RunRef;
};

export async function buyRouterBalance(
  deps: RouterBuyDeps,
  tierUsd: RouterTopupTier,
): Promise<RouterPurchaseResult> {
  return (await purchaseRouterBalance(deps, tierUsd))!;
}

async function withPurchaseLock<T>(
  deps: Pick<RouterClientDeps, "wallets" | "wallet">,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await deps.wallets.withRouterPurchaseLock(deps.wallet, operation);
  } catch (error) {
    if (!(error instanceof FileLockedError)) throw error;
    throw new RouterClientError(
      "refill_pending",
      "Another Router purchase is in progress. Retry chat after it completes; do not repeat the purchase.",
    );
  }
}

async function purchaseRouterBalance(
  deps: RouterBuyDeps,
  tierUsd: RouterTopupTier,
  decision?: { belowUsd: number; completedReceiptId: string | undefined },
): Promise<RouterPurchaseResult | undefined> {
  return await withPurchaseLock(deps, () => purchaseRouterBalanceLocked(deps, tierUsd, decision));
}

async function purchaseRouterBalanceLocked(
  deps: RouterBuyDeps,
  tierUsd: RouterTopupTier,
  decision?: { belowUsd: number; completedReceiptId: string | undefined },
): Promise<RouterPurchaseResult | undefined> {
  if (!isRouterTopupTier(tierUsd)) {
    throw new RouterClientError("http", "Router balance must use a $1, $5, $20, or $50 tier.");
  }
  const previous = await recoverPendingPurchaseLocked(
    deps,
    deps.paths?.receiptsPath,
    deps.config,
    deps.now,
  );
  if (previous !== undefined) return previous.purchase;
  const { link, accessToken } = await purchaseCredentialSnapshot(deps);
  const prepared: RouterPendingPurchase = {
    receiptId: randomUUID(),
    status: "prepared",
    createdAt: (deps.now ?? new Date()).toISOString(),
    tierUsd,
    link,
  };
  const reserved = await deps.wallets.setRouterPendingPurchase(deps.wallet, prepared);
  if (reserved.routerPendingPurchase?.receiptId !== prepared.receiptId) {
    const competing = await recoverPendingPurchaseLocked(
      deps,
      deps.paths?.receiptsPath,
      deps.config,
      deps.now,
    );
    if (competing !== undefined) return competing.purchase;
    // A concurrent purchase finished between the reservation and the read. This
    // request must not turn that successful recovery into another purchase.
    throw new RouterClientError(
      "refill_pending",
      "Another Router purchase completed. Retry chat to use its balance; do not repeat the purchase.",
    );
  }
  if (decision !== undefined) {
    try {
      // A stale decision from another process must not become another payment,
      // even when its successful top-up is smaller than the refill threshold.
      const balance = (await routerUsage(deps)).balance;
      const completed = await deps.wallets.routerCompletedPurchase(deps.wallet);
      if (
        completed !== decision.completedReceiptId ||
        (balance?.remainingUsd ?? 0) >= decision.belowUsd
      ) {
        await deps.wallets.setRouterPendingPurchase(deps.wallet, null, prepared.receiptId);
        return undefined;
      }
    } catch (error) {
      await deps.wallets.setRouterPendingPurchase(deps.wallet, null, prepared.receiptId);
      throw error;
    }
  }
  let current = prepared;
  let paid: Awaited<ReturnType<typeof payRequest>>;
  try {
    paid = await payRequest({
      url: `${trimTrailingSlashes(link.apiBase)}/api/router/top-up/${tierUsd}`,
      init: {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      },
      account: deps.account,
      wallet: deps.wallet,
      caps: deps.caps,
      config: deps.config,
      fetchImpl: deps.fetchImpl ?? publicFetch,
      paths: {
        ledgerPath: deps.paths?.ledgerPath ?? getVapiPaths(deps.wallets.home).ledger,
        receiptsPath: deps.paths?.receiptsPath ?? getVapiPaths(deps.wallets.home).receipts,
      },
      receiptId: prepared.receiptId,
      paymentId: prepared.receiptId,
      beforeSign: async ({ network, token, amountAtomic, authorization }) => {
        current = {
          ...prepared,
          status: authorization === undefined ? "unknown" : "signed",
          network,
          amountAtomic,
          ...(authorization === undefined
            ? {}
            : {
                authorization: {
                  token,
                  from: authorization.from,
                  nonce: authorization.nonce,
                  validBefore: authorization.validBefore,
                },
              }),
        };
        const saved = await deps.wallets.setRouterPendingPurchase(
          deps.wallet,
          current,
          prepared.receiptId,
        );
        if (
          saved.routerPendingPurchase?.status !== current.status ||
          saved.routerPendingPurchase?.receiptId !== prepared.receiptId
        ) {
          throw new RouterClientError(
            "refill_pending",
            "The Router purchase reservation changed before signing.",
          );
        }
      },
      maxAtomic: BigInt(tierUsd) * 1_000_000n,
      preferNetworks: ["eip155:8453"],
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(deps.allowanceExpiresAt === undefined
        ? {}
        : { allowanceExpiresAt: deps.allowanceExpiresAt }),
      ...(deps.runBudget === undefined ? {} : { runBudget: deps.runBudget }),
      ...(deps.run === undefined ? {} : { run: deps.run }),
      source: "router.topup",
      ceilingSweep: {
        account: deps.wallet,
        auditHome: deps.wallets.home,
        run: async (signal) =>
          await sweepAboveCeiling({
            store: deps.wallets,
            secrets: deps.secrets,
            apiBase: link.apiBase,
            account: deps.wallet,
            config: deps.config,
            signal,
            resolveParent: swarmParentResolver(deps.wallets.home),
            ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
            unlock: async () => deps.account,
          }),
      },
    });
  } catch (error) {
    await releaseUnpaidPurchase(deps, current, deps.paths?.receiptsPath).catch(() => undefined);
    throw error;
  }
  const { response, receipt, warnings: paymentWarnings } = paid;
  const warnings: RouterPurchaseWarning[] = [...(paymentWarnings ?? [])];
  if (receipt.settlement?.outcome === "succeeded") {
    try {
      current = settledPendingPurchase(current, receipt);
      await deps.wallets.setRouterPendingPurchase(deps.wallet, current, prepared.receiptId);
    } catch {
      warnings.push({
        code: "payment_followup_unavailable",
        message:
          "Payment settled, but its local purchase record could not be updated. Keep the returned receipt; retry chat without repeating the purchase.",
      });
    }
  } else if (receipt.payer === undefined && receipt.authorization === undefined) {
    await deps.wallets.setRouterPendingPurchase(deps.wallet, null, prepared.receiptId);
  }
  if (!response.ok && receipt.settlement?.outcome !== "succeeded") {
    if (response.status === 401) await verifyAgentLink(deps);
    throw new RouterClientError(
      "http",
      `The Router balance purchase returned HTTP ${response.status}.`,
      response.status,
    );
  }

  if (!response.ok)
    warnings.push({
      code: "purchase_response_unavailable",
      message:
        "Payment succeeded, but the Router purchase response was unsuccessful. Keep the returned receipt and check vapi router usage; do not repeat the purchase.",
    });
  try {
    const purchase = routerPurchaseSummary(receipt);
    await appendAudit(
      deps.wallets.home,
      {
        event: "router.buy",
        wallet: deps.wallet,
        owner: link.owner,
        tty: Boolean(process.stderr.isTTY),
        detail: `${purchase.amountUsd === null ? "amount unknown" : `$${purchase.amountUsd}`} on ${purchase.network}`,
      },
      deps.now === undefined ? {} : { now: () => deps.now! },
    );
  } catch {
    warnings.push({
      code: "audit_unavailable",
      message:
        "Payment succeeded, but the local purchase audit could not be written. Keep the returned receipt; do not repeat the purchase.",
    });
  }

  try {
    await ensureBalanceRouterKey(deps, link);
    if (receipt.settlement?.outcome === "succeeded") {
      await completePendingPurchase(deps, current);
    }
  } catch {
    warnings.push({
      code: "router_key_unavailable",
      message:
        "Payment succeeded, but its Router balance key could not be fetched or stored. Retry chat to fetch the key; do not repeat the purchase.",
    });
  }

  let balance: AgentRouterUsage["balance"] = null;
  try {
    balance = (await routerUsage(deps)).balance;
  } catch {
    warnings.push({
      code: "balance_unavailable",
      message:
        "Payment succeeded, but the Router balance is unavailable. Retry chat to recover access; do not repeat the purchase.",
    });
  }
  return { receipt, balance, ...(warnings.length === 0 ? {} : { warnings }) };
}

type PendingRouterPurchase = { pending: RouterPendingPurchase; purchase: RouterPurchaseResult };

async function purchaseReceipt(
  deps: RouterClientDeps,
  pending: RouterPendingPurchase,
  receiptsPath?: string,
): Promise<Receipt | undefined> {
  const receipts = await readReceipts(
    receiptsPath ?? deps.refill?.paths?.receiptsPath ?? getVapiPaths(deps.wallets.home).receipts,
    { wallet: deps.wallet },
  );
  return receipts.find((receipt) => receipt.id === pending.receiptId);
}

function pendingReceipt(deps: RouterClientDeps, pending: RouterPendingPurchase): Receipt {
  return {
    id: pending.receiptId,
    timestamp: pending.createdAt,
    wallet: deps.wallet,
    resourceUrl: `${trimTrailingSlashes(pending.link.apiBase)}/api/router/top-up/${pending.tierUsd}`,
    method: "POST",
    source: "router.topup",
    outcome: pending.status === "settled" ? "paid" : "settlement_unknown",
    ...(pending.amountAtomic === undefined
      ? {}
      : {
          quote: { network: pending.network ?? "unknown", amountAtomic: pending.amountAtomic },
        }),
    settlement: {
      outcome: pending.status === "settled" ? "succeeded" : "unknown",
      ...(pending.transaction === undefined ? {} : { transaction: pending.transaction }),
      ...(pending.network === undefined ? {} : { evidence: { network: pending.network } }),
    },
  };
}

function settledPendingPurchase(
  pending: RouterPendingPurchase,
  receipt: Receipt,
): RouterPendingPurchase {
  return {
    ...pending,
    status: "settled",
    createdAt: receipt.timestamp,
    network: routerPurchaseSummary(receipt).network,
    ...(receipt.quote?.amountAtomic === undefined
      ? {}
      : { amountAtomic: receipt.quote.amountAtomic }),
    ...(receipt.settlement?.transaction === undefined
      ? {}
      : { transaction: receipt.settlement.transaction }),
  };
}

function definitelyUnpaid(receipt: Receipt): boolean {
  return (
    receipt.settlement === undefined &&
    receipt.payer === undefined &&
    receipt.authorization === undefined &&
    (receipt.outcome === "declined_policy" || receipt.outcome === "failed_request")
  );
}

async function releaseUnpaidPurchase(
  deps: RouterClientDeps,
  pending: RouterPendingPurchase,
  receiptsPath?: string,
): Promise<void> {
  const receipt = await purchaseReceipt(deps, pending, receiptsPath);
  if (pending.status === "prepared" && (receipt === undefined || definitelyUnpaid(receipt))) {
    await deps.wallets.setRouterPendingPurchase(deps.wallet, null, pending.receiptId);
  }
}

async function completePendingPurchase(
  deps: RouterClientDeps,
  pending: RouterPendingPurchase,
): Promise<RouterBalanceCredentials> {
  const link = await linkedWallet(deps);
  if (!sameAgentLink(link, pending.link)) {
    throw new RouterClientError("http", "The agent link changed after the Router purchase.");
  }
  const credentials = await routerBalanceCredentialSnapshot(deps);
  if (credentials === undefined) {
    throw new RouterClientError("no_router_key", "The Router balance key is not yet available.");
  }
  // Also leave a durable completion marker when settlement came from the ledger.
  await deps.wallets.setRouterPendingPurchase(
    deps.wallet,
    { ...pending, status: "settled" },
    pending.receiptId,
  );
  await deps.wallets.setRouterPendingPurchase(deps.wallet, null, pending.receiptId);
  return credentials;
}

async function recoverPendingPurchase(
  deps: RouterClientDeps,
): Promise<(PendingRouterPurchase & { credentials: RouterBalanceCredentials }) | undefined> {
  return await withPurchaseLock(deps, () => recoverPendingPurchaseLocked(deps));
}

async function recoverPendingPurchaseLocked(
  deps: RouterClientDeps,
  receiptsPath?: string,
  config?: VapiConfig,
  now?: Date,
): Promise<(PendingRouterPurchase & { credentials: RouterBalanceCredentials }) | undefined> {
  await deps.wallets.refreshRegistry();
  let pending = deps.wallets.snapshot().wallets[deps.wallet]?.routerPendingPurchase;
  if (pending === undefined) return undefined;
  const resolution = await resolveRouterPendingPurchase(deps, pending, {
    ...(receiptsPath === undefined ? {} : { receiptsPath }),
    ...(config === undefined ? {} : { config }),
    ...(now === undefined ? {} : { now }),
  });
  if (resolution.state === "unpaid") {
    await deps.wallets.setRouterPendingPurchase(deps.wallet, null, pending.receiptId);
    return undefined;
  }
  if (resolution.state === "waiting") {
    throw new RouterClientError(
      "refill_pending",
      `The Router authorization can still settle. Retry after ${resolution.resolvesAt} to check its nonce; do not repeat the purchase.`,
      undefined,
      { receipt: pendingReceipt(deps, pending), balance: null },
    );
  }
  if (resolution.state === "unavailable") throw unresolvedPurchaseError(deps, pending);
  const purchase: RouterPurchaseResult = { receipt: resolution.receipt, balance: null };
  pending = settledPendingPurchase(pending, purchase.receipt);
  try {
    await deps.wallets.setRouterPendingPurchase(deps.wallet, pending, pending.receiptId);
    const link = await linkedWallet(deps);
    if (!sameAgentLink(link, pending.link)) {
      throw new RouterClientError("http", "The agent link changed after the Router purchase.");
    }
    await ensureBalanceRouterKey(deps, pending.link);
    const credentials = await completePendingPurchase(deps, pending);
    return { pending, purchase, credentials };
  } catch (error) {
    throw pendingPurchaseError(purchase, false, error);
  }
}

export type RouterPendingResolution =
  | { state: "unpaid" }
  | { state: "settled"; receipt: Receipt }
  | { state: "waiting"; resolvesAt: string }
  | { state: "unavailable" };

/** Shared authoritative check for recovery and CLI clearing. Caller holds the purchase lock. */
export async function resolveRouterPendingPurchase(
  deps: RouterClientDeps,
  pending: RouterPendingPurchase,
  options: { receiptsPath?: string; config?: VapiConfig; now?: Date } = {},
): Promise<RouterPendingResolution> {
  const recorded = await purchaseReceipt(deps, pending, options.receiptsPath).catch(
    () => undefined,
  );
  // A receipt takes precedence over both the journal state and the chain check.
  if (recorded?.settlement?.outcome === "succeeded") return { state: "settled", receipt: recorded };
  if (pending.status === "settled")
    return { state: "settled", receipt: pendingReceipt(deps, pending) };
  if (pending.status === "prepared" && (recorded === undefined || definitelyUnpaid(recorded)))
    return { state: "unpaid" };
  if (pending.authorization === undefined || pending.network === undefined)
    return { state: "unavailable" };
  let used: boolean;
  try {
    const config =
      options.config ??
      deps.refill?.config ??
      (await loadConfig(getVapiPaths(deps.wallets.home).config));
    used = await authorizationUsed(deps, pending, config);
  } catch {
    return { state: "unavailable" };
  }
  if (used)
    return { state: "settled", receipt: pendingReceipt(deps, { ...pending, status: "settled" }) };
  const expires = BigInt(pending.authorization.validBefore) + 30n;
  const clock =
    options.now ??
    (typeof deps.refill?.now === "function" ? deps.refill.now() : deps.refill?.now) ??
    new Date();
  if (BigInt(Math.floor(clock.getTime() / 1000)) > expires) return { state: "unpaid" };
  return { state: "waiting", resolvesAt: new Date(Number(expires + 1n) * 1000).toISOString() };
}

const authorizationStateAbi = [
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ name: "used", type: "bool" }],
  },
] as const;

async function authorizationUsed(
  deps: RouterClientDeps,
  pending: RouterPendingPurchase,
  config: VapiConfig,
): Promise<boolean> {
  const authorization = pending.authorization;
  const network = pending.network;
  if (
    authorization === undefined ||
    network === undefined ||
    getNetworkDefinition(network).family !== "evm"
  )
    throw new Error("Authorization state unavailable");
  const configured = config.networks[network];
  if (
    configured === undefined ||
    configured.usdc.toLowerCase() !== authorization.token.toLowerCase()
  )
    throw new Error("Token RPC unavailable");
  const response = await (deps.fetchImpl ?? publicFetch)(requireRpcUrl(network, configured), {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [
        {
          to: authorization.token,
          data: encodeFunctionData({
            abi: authorizationStateAbi,
            functionName: "authorizationState",
            args: [authorization.from as `0x${string}`, authorization.nonce as `0x${string}`],
          }),
        },
        "latest",
      ],
    }),
  });
  if (!response.ok) throw new Error("Authorization RPC failed");
  const body = (await response.json()) as { result?: unknown };
  if (body.result === `0x${"0".repeat(64)}`) return false;
  if (body.result === `0x${"0".repeat(63)}1`) return true;
  throw new Error("Authorization state unavailable");
}

/** Public evidence for the explicit CLI-only unpaid confirmation. */
export function routerPendingEvidence(pending: RouterPendingPurchase) {
  const token = pending.authorization?.token;
  const explorer =
    pending.network === undefined || token === undefined
      ? undefined
      : explorerAddressUrl(pending.network, token);
  return {
    receiptId: pending.receiptId,
    status: pending.status,
    createdAt: pending.createdAt,
    tierUsd: pending.tierUsd,
    network: pending.network ?? "unknown",
    ...(pending.amountAtomic === undefined ? {} : { amountAtomic: pending.amountAtomic }),
    ...(pending.authorization === undefined ? {} : { authorization: pending.authorization }),
    ...(pending.transaction === undefined ? {} : { transaction: pending.transaction }),
    instructions: `Check the receipt and token contract authorizationState(from, nonce) on the network's explorer${explorer === undefined ? "" : `: ${explorer}#readContract`}. A used nonce must be treated as paid; never clear it. Confirm that the authorization cannot settle before clearing.`,
  };
}

function unresolvedPurchaseError(
  deps: RouterClientDeps,
  pending: RouterPendingPurchase,
): RouterClientError {
  return new RouterClientError(
    "refill_pending",
    `The Router purchase cannot yet be verified. Check its public evidence with vapi router clear-pending --account ${deps.wallet}, then, only after verifying it cannot settle, use vapi router clear-pending --confirm-unpaid --account ${deps.wallet}.`,
    undefined,
    { receipt: pendingReceipt(deps, pending), balance: null },
  );
}

function pendingPurchaseError(
  purchase: RouterPurchaseResult,
  balanceKeyAvailable = false,
  cause?: unknown,
): RouterClientError {
  const payment =
    purchase.receipt.settlement?.outcome === "succeeded"
      ? "Payment settled"
      : "The Router purchase is awaiting confirmation";
  return new RouterClientError(
    "refill_pending",
    purchase.receipt.settlement?.outcome !== "succeeded"
      ? `${payment}. Keep the receipt reference and verify settlement; do not repeat the purchase.`
      : balanceKeyAvailable
        ? `${payment}, but chat could not complete. Retry chat; do not repeat the purchase.`
        : `${payment}, but the Router balance key is not yet available. It will be fetched on the next request. Retry chat; do not repeat the purchase.`,
    cause instanceof RouterClientError ? cause.status : undefined,
    purchase,
  );
}

export async function routerChat(
  deps: RouterClientDeps,
  request: ChatRequest,
): Promise<ChatResult> {
  // Recovery precedes all credential reads, usage checks and refill decisions,
  // and is independent of the automatic-refill setting or payment account.
  const recovered = await recoverPendingPurchase(deps);
  if (recovered !== undefined) {
    try {
      const result = await sendRouterChat(
        deps,
        recovered.credentials.routerBaseUrl,
        recovered.credentials.routerKey,
        request,
        "balance",
      );
      return { ...result, refill: recovered.purchase };
    } catch (error) {
      if (
        error instanceof RouterClientError &&
        error.code === "no_router_key" &&
        error.status === 401
      ) {
        await removeRejectedBalanceKey(deps, recovered.credentials).catch(() => undefined);
      }
      throw pendingPurchaseError(recovered.purchase, true, error);
    }
  }
  const { routerBaseUrl, routerKey } = await routerCredentialSnapshot(deps);
  try {
    return await sendRouterChat(deps, routerBaseUrl, routerKey, request, "stake");
  } catch (error) {
    if (
      error instanceof RouterClientError &&
      error.code === "no_router_key" &&
      error.status === 401
    ) {
      await verifyAgentLink(deps);
    }
    if (!(error instanceof RouterClientError) || error.code !== "budget_exhausted") throw error;

    const completedReceiptId = await deps.wallets.routerCompletedPurchase(deps.wallet);
    let usage: AgentRouterUsage | undefined;
    try {
      usage = await routerUsage(deps);
    } catch {
      // Unknown balance is allowed to try a stored key; the Router remains authoritative.
    }
    const resetsAt = usage?.compute.resetsAt ?? "00:00 UTC";
    let balance = usage?.balance;
    let purchase: RouterPurchaseResult | undefined;
    const refill = deps.wallets.entry(deps.wallet)?.routerRefill;

    if (
      usage !== undefined &&
      refill !== undefined &&
      deps.refill !== undefined &&
      (balance?.remainingUsd ?? 0) < refill.belowUsd
    ) {
      try {
        const [account, caps] = await Promise.all([
          resolveRefillValue(deps.refill.account),
          resolveRefillValue(deps.refill.caps),
        ]);
        purchase = await purchaseRouterBalance(
          {
            ...deps,
            account,
            config: deps.refill.config,
            caps,
            ...(deps.refill.paths === undefined ? {} : { paths: deps.refill.paths }),
            ...(deps.refill.now === undefined
              ? {}
              : {
                  now: typeof deps.refill.now === "function" ? deps.refill.now() : deps.refill.now,
                }),
            ...(deps.refill.allowanceExpiresAt === undefined
              ? {}
              : { allowanceExpiresAt: deps.refill.allowanceExpiresAt }),
            ...(deps.refill.runBudget === undefined ? {} : { runBudget: deps.refill.runBudget }),
            ...(deps.refill.run === undefined ? {} : { run: deps.refill.run }),
          },
          refill.tierUsd,
          { belowUsd: refill.belowUsd, completedReceiptId },
        );
        balance = purchase === undefined ? (await routerUsage(deps)).balance : purchase.balance;
      } catch (refillError) {
        if (refillError instanceof RouterClientError && refillError.code === "refill_pending")
          throw refillError;
        await appendAudit(deps.wallets.home, {
          event: "router.refill.declined",
          wallet: deps.wallet,
          ...(deps.wallets.entry(deps.wallet)?.link?.owner === undefined
            ? {}
            : { owner: deps.wallets.entry(deps.wallet)!.link!.owner }),
          tty: Boolean(process.stderr.isTTY),
          detail: refillDeclinedDetail(refillError),
        });
        if (isRunBudgetError(refillError)) throw refillError;
      }
    }

    let balanceKeyAvailable = false;
    try {
      const mayHaveBalance =
        usage === undefined || purchase !== undefined || (balance?.remainingUsd ?? 0) > 0;
      if (mayHaveBalance) {
        let balanceCredentials = await routerBalanceCredentialSnapshot(deps);
        // A prior paid refill may not have stored its key. Recover it without a
        // purchase on the next chat request; credential-only SDK reads stay local.
        if (balanceCredentials === undefined && purchase === undefined) {
          try {
            await ensureBalanceRouterKey(deps, await linkedWallet(deps));
            balanceCredentials = await routerBalanceCredentialSnapshot(deps);
          } catch {
            // Without a pending receipt there is no evidence of a prior payment.
            // Preserve the original allowance error if legacy key recovery fails.
          }
        }
        if (balanceCredentials !== undefined) {
          balanceKeyAvailable = true;
          try {
            const result = await sendRouterChat(
              deps,
              balanceCredentials.routerBaseUrl,
              balanceCredentials.routerKey,
              request,
              "balance",
            );
            return { ...result, ...(purchase === undefined ? {} : { refill: purchase }) };
          } catch (balanceError) {
            if (
              balanceError instanceof RouterClientError &&
              balanceError.code === "budget_exhausted"
            ) {
              throw budgetExhaustedError(resetsAt, error.status);
            }
            if (
              balanceError instanceof RouterClientError &&
              balanceError.code === "no_router_key" &&
              balanceError.status === 401
            ) {
              await removeRejectedBalanceKey(deps, balanceCredentials).catch(() => undefined);
            }
            throw balanceError;
          }
        }
      }
      throw budgetExhaustedError(resetsAt, error.status);
    } catch (followupError) {
      if (purchase === undefined) throw followupError;
      throw pendingPurchaseError(purchase, balanceKeyAvailable, followupError);
    }
  }
}

async function sendRouterChat(
  deps: RouterClientDeps,
  routerBaseUrl: string,
  routerKey: string,
  request: ChatRequest,
  keyUsed: ChatResult["keyUsed"],
): Promise<ChatResult> {
  const fetchImpl = deps.fetchImpl ?? publicFetch;
  let response: Response;
  try {
    response = await fetchImpl(`${routerBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${routerKey}`,
        "content-type": "application/json",
      },
      redirect: "error",
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        ...(request.max_tokens === undefined ? {} : { max_tokens: request.max_tokens }),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.tools === undefined ? {} : { tools: request.tools }),
        ...(request.tool_choice === undefined ? {} : { tool_choice: request.tool_choice }),
      }),
    });
  } catch {
    throw new RouterClientError("http", "The vAPI Router request failed.");
  }

  const body = await responseText(response);
  if (!response.ok) {
    if (/budget (?:has been )?exceeded|exceededbudget/iu.test(body)) {
      throw new RouterClientError(
        "budget_exhausted",
        "The Router key has no remaining budget.",
        response.status,
      );
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after")?.trim();
      const retrySeconds =
        retryAfter !== undefined && /^\d+$/u.test(retryAfter) ? Number(retryAfter) : undefined;
      throw new RouterClientError(
        "rate_limited",
        `The vAPI Router is rate limited. ${retrySeconds !== undefined && Number.isFinite(retrySeconds) ? `Retry after ${retrySeconds} seconds.` : "Wait and retry shortly."}`,
        response.status,
      );
    }
    if (response.status === 401) {
      throw new RouterClientError(
        "no_router_key",
        keyUsed === "stake"
          ? ROUTER_KEY_REVOKED_MESSAGE
          : "The Router balance key was rejected. Buy Router balance again to refresh it.",
        401,
      );
    }
    throw new RouterClientError(
      "http",
      `vAPI Router returned HTTP ${response.status}.`,
      response.status,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new RouterClientError("http", "The vAPI Router response was invalid.", response.status);
  }
  const parsed = chatResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RouterClientError("http", "The vAPI Router response was invalid.", response.status);
  }
  const message = parsed.data.choices[0]!.message;
  return {
    content: message.content,
    toolCalls: (message.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    })),
    ...(parsed.data.usage === undefined ? {} : { usage: parsed.data.usage }),
    model: parsed.data.model ?? request.model,
    keyUsed,
  };
}

async function ensureBalanceRouterKey(deps: RouterClientDeps, paidLink: AgentLink): Promise<void> {
  if (!deps.secrets.available) {
    throw new RouterClientError(
      "http",
      "No OS secret store is available, so the Router balance key cannot be stored safely.",
    );
  }
  // Token refresh uses the link's credential lock. Serialize balance-key minting
  // on a separate lock so a 401 can refresh without trying to reacquire this lock.
  await withAgentCredentialLock(
    deps.wallets,
    `${paidLink.clientId}:router-balance-key`,
    async () => {
      const link = await linkedWallet(deps);
      if (!sameAgentLink(link, paidLink)) {
        throw new RouterClientError(
          "http",
          "The agent link changed while fetching the Router balance key.",
        );
      }
      const account = agentSecretAccounts(deps.wallet).routerBalance;
      let existing: string | undefined;
      try {
        existing = await deps.secrets.get(account);
      } catch {
        throw new RouterClientError("http", "The Router balance key could not be read safely.");
      }
      if (existing !== undefined && existing.length > 0) return;

      const response = await consoleRequest(
        deps,
        "/api/agents/self/router-balance-key",
        { method: "POST" },
        "The Router balance key request failed after payment.",
        link,
      );
      if (!response.ok) {
        throw new RouterClientError(
          "http",
          `The Router balance key request returned HTTP ${response.status} after payment.`,
          response.status,
        );
      }
      const parsed = routerKeyResponseSchema.safeParse(await responseJson(response));
      if (!parsed.success) {
        throw new RouterClientError("http", "The Router balance key response was invalid.");
      }
      const currentLink = await linkedWallet(deps);
      if (!sameAgentLink(currentLink, paidLink)) {
        throw new RouterClientError(
          "http",
          "The agent link changed while fetching the Router balance key.",
        );
      }
      const returnedBase = validRouterBaseUrl(parsed.data.router_base_url);
      const expectedBase = validRouterBaseUrl(link.routerBaseUrl ?? DEFAULT_ROUTER_BASE_URL);
      if (returnedBase !== expectedBase) {
        throw new RouterClientError(
          "http",
          "The Router balance key response named an unexpected Router base URL.",
        );
      }
      try {
        await deps.secrets.set(account, parsed.data.router_key);
      } catch {
        throw new RouterClientError("http", "The Router balance key could not be stored safely.");
      }
    },
  );
}

type RouterBalanceCredentials = {
  clientId: string;
  routerBaseUrl: string;
  routerKey: string;
};

async function routerBalanceCredentialSnapshot(
  deps: RouterClientDeps,
): Promise<RouterBalanceCredentials | undefined> {
  const observedLink = await linkedWallet(deps);
  try {
    return await withAgentCredentialLock(deps.wallets, observedLink.clientId, async () => {
      const link = await linkedWallet(deps);
      if (link.clientId !== observedLink.clientId) {
        throw new RouterClientError(
          "http",
          "The agent link changed while reading Router balance credentials.",
        );
      }
      if (!deps.secrets.available) return undefined;
      let routerKey: string | undefined;
      try {
        routerKey = await deps.secrets.get(agentSecretAccounts(deps.wallet).routerBalance);
      } catch {
        throw new RouterClientError("http", "The Router balance key could not be read safely.");
      }
      if (routerKey === undefined || routerKey.length === 0) return undefined;
      return {
        clientId: link.clientId,
        routerBaseUrl: validRouterBaseUrl(link.routerBaseUrl ?? DEFAULT_ROUTER_BASE_URL),
        routerKey,
      };
    });
  } catch (error) {
    if (error instanceof RouterClientError) throw error;
    if (error instanceof AgentLinkError && error.code === "not_linked") {
      throw linkStatusError(error);
    }
    throw new RouterClientError("http", "The Router balance credentials could not be read safely.");
  }
}

async function removeRejectedBalanceKey(
  deps: RouterClientDeps,
  rejected: RouterBalanceCredentials,
): Promise<void> {
  if (!deps.secrets.available) return;
  await withAgentCredentialLock(deps.wallets, rejected.clientId, async () => {
    const link = await linkedWallet(deps);
    if (link.clientId !== rejected.clientId) return;
    const account = agentSecretAccounts(deps.wallet).routerBalance;
    if ((await deps.secrets.get(account)) === rejected.routerKey) {
      await deps.secrets.remove(account);
    }
  });
}

async function routerAccessToken(deps: RouterClientDeps): Promise<string> {
  try {
    return await agentAccessToken({
      secrets: deps.secrets,
      wallets: deps.wallets,
      wallet: deps.wallet,
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    });
  } catch (error) {
    if (error instanceof AgentLinkError && error.code === "not_linked") {
      throw linkStatusError(error);
    }
    if (error instanceof AgentLinkError) {
      throw new RouterClientError("http", error.message);
    }
    throw new RouterClientError("http", "The agent access token could not be read safely.");
  }
}

async function purchaseCredentialSnapshot(
  deps: RouterClientDeps,
): Promise<{ link: AgentLink; accessToken: string }> {
  const before = await linkedWallet(deps);
  const accessToken = await routerAccessToken(deps);
  const after = await linkedWallet(deps);
  if (!sameAgentLink(before, after)) {
    throw new RouterClientError(
      "http",
      "The agent link changed while preparing the Router balance purchase.",
    );
  }
  return { link: after, accessToken };
}

async function resolveRefillValue<T>(value: T | (() => Promise<T>)): Promise<T> {
  return typeof value === "function" ? await (value as () => Promise<T>)() : value;
}

function budgetExhaustedError(resetsAt: string, status?: number): RouterClientError {
  return new RouterClientError(
    "budget_exhausted",
    `Today's Router allowance is used up. It resets at ${resetsAt}. Buy Router balance with vapi router buy 5.`,
    status,
  );
}

function refillDeclinedDetail(error: unknown): string {
  if (error instanceof SpendCapExceededError) return `${error.name}: ${error.cap}`;
  if (error instanceof SpendCapError) return `${error.name}: ${error.code}`;
  if (isRunBudgetError(error)) {
    return error.code === "spend_cap_exceeded"
      ? "SpendCapExceededError: run_budget"
      : `RunBudgetError: ${error.code}`;
  }
  if (error instanceof RouterClientError) {
    return `${error.name}: ${error.code}${error.status === undefined ? "" : ` (${error.status})`}`;
  }
  return "Error: Router balance refill failed.";
}

function isRunBudgetError(
  error: unknown,
): error is { code: "run_budget_exceeded" } | { code: "spend_cap_exceeded"; cap: "run_budget" } {
  return (
    typeof error === "object" &&
    error !== null &&
    (Reflect.get(error, "code") === "run_budget_exceeded" ||
      (Reflect.get(error, "code") === "spend_cap_exceeded" &&
        Reflect.get(error, "cap") === "run_budget"))
  );
}

function isRouterTopupTier(value: unknown): value is RouterTopupTier {
  return ROUTER_TOPUP_TIERS.some((tier) => tier === value);
}

export async function rotateRouterKey(deps: RouterClientDeps): Promise<void> {
  const link = await linkedWallet(deps);
  if (!deps.secrets.available) {
    throw new Error(
      "No OS secret store is available on this machine, so the Router key cannot be stored safely.",
    );
  }
  const response = await consoleRequest(
    deps,
    "/api/agents/self/router-key",
    { method: "POST" },
    "The vAPI Router key rotation request failed.",
    link,
  );
  if (!response.ok) {
    throw new RouterClientError(
      "http",
      `The vAPI Router key rotation request returned HTTP ${response.status}.`,
      response.status,
    );
  }
  const parsed = routerKeyResponseSchema.safeParse(await responseJson(response));
  if (!parsed.success) {
    throw new RouterClientError("http", "The vAPI Router key rotation response was invalid.");
  }
  validRouterBaseUrl(parsed.data.router_base_url);

  try {
    await withAgentCredentialLock(deps.wallets, link.clientId, async () => {
      const currentLink = await linkedWallet(deps);
      if (!sameAgentLink(currentLink, link)) {
        throw new RouterClientError("http", "The agent link changed during Router key rotation.");
      }
      const account = agentSecretAccounts(deps.wallet).routerStake;
      let previousKey: string | undefined;
      try {
        previousKey = await deps.secrets.get(account);
        await deps.secrets.set(account, parsed.data.router_key);
      } catch {
        throw new RouterClientError("http", "The Router key could not be stored safely.");
      }
      try {
        await deps.wallets.setLink(deps.wallet, {
          ...currentLink,
          routerBaseUrl: parsed.data.router_base_url,
        });
      } catch {
        try {
          if (previousKey === undefined) await deps.secrets.remove(account);
          else await deps.secrets.set(account, previousKey);
        } catch {
          await deps.wallets.clearLink(deps.wallet).catch(() => undefined);
        }
        throw new RouterClientError("http", "The Router key could not be stored safely.");
      }
    });
  } catch (error) {
    if (error instanceof RouterClientError) throw error;
    throw new RouterClientError("http", "The Router key could not be stored safely.");
  }
}

export async function ownerStake(deps: RouterClientDeps): Promise<{
  owner: string;
  stake: string;
  computeTodayUsd: number;
  stakeUrl: string;
}> {
  const response = await consoleRequest(
    deps,
    "/api/agents/self/stake",
    { method: "GET" },
    "The vAPI stake request failed.",
  );
  if (!response.ok) {
    throw new RouterClientError(
      "http",
      `The vAPI stake request returned HTTP ${response.status}.`,
      response.status,
    );
  }
  const parsed = ownerStakeResponseSchema.safeParse(await responseJson(response));
  if (!parsed.success) {
    throw new RouterClientError("http", "The vAPI stake response was invalid.");
  }
  return {
    owner: parsed.data.owner,
    stake: parsed.data.stake,
    computeTodayUsd: parsed.data.computeTodayUsd,
    stakeUrl: parsed.data.stakeUrl,
  };
}

/** For the SDK (plan 029): base URL + key for OpenAI-compatible frameworks. Never exposed via MCP. */
export async function routerCredentials(
  deps: RouterClientDeps,
  options: { funding?: "compute" | "balance" } = {},
): Promise<{ baseURL: string; apiKey: string }> {
  const credentials =
    options.funding === "balance"
      ? await routerBalanceCredentialSnapshot(deps)
      : await routerCredentialSnapshot(deps);
  if (credentials === undefined) {
    throw new RouterClientError(
      "no_router_key",
      "No Router balance key is stored for this wallet.",
    );
  }
  const { routerBaseUrl, routerKey } = credentials;
  return { baseURL: `${routerBaseUrl}/v1`, apiKey: routerKey };
}

async function routerCredentialSnapshot(
  deps: RouterClientDeps,
): Promise<{ routerBaseUrl: string; routerKey: string }> {
  const observedLink = await linkedWallet(deps);
  try {
    return await withAgentCredentialLock(deps.wallets, observedLink.clientId, async () => {
      const link = await linkedWallet(deps);
      if (link.clientId !== observedLink.clientId) {
        throw new RouterClientError(
          "http",
          "The agent link changed while reading Router credentials.",
        );
      }
      return {
        routerBaseUrl: validRouterBaseUrl(link.routerBaseUrl ?? DEFAULT_ROUTER_BASE_URL),
        routerKey: await storedRouterKey(deps),
      };
    });
  } catch (error) {
    if (error instanceof RouterClientError) throw error;
    if (error instanceof AgentLinkError && error.code === "not_linked") {
      throw linkStatusError(error);
    }
    if (error instanceof AgentLinkError) {
      throw new RouterClientError("http", error.message);
    }
    throw new RouterClientError("http", "The Router credentials could not be read safely.");
  }
}

async function linkedWallet(deps: RouterClientDeps): Promise<AgentLink> {
  try {
    await deps.wallets.reload();
  } catch {
    throw new RouterClientError("http", "The wallet link could not be read.");
  }
  const link = deps.wallets.entry(deps.wallet)?.link;
  if (link === undefined) throw notLinkedError();
  return link;
}

async function storedRouterKey(deps: RouterClientDeps): Promise<string> {
  if (!deps.secrets.available) throw noRouterKeyError();
  let key: string | undefined;
  try {
    key = await deps.secrets.get(agentSecretAccounts(deps.wallet).routerStake);
  } catch {
    throw new RouterClientError("http", "The Router key could not be read safely.");
  }
  if (key === undefined || key.length === 0) throw noRouterKeyError();
  return key;
}

function sameAgentLink(left: AgentLink, right: AgentLink): boolean {
  return (
    left.apiBase === right.apiBase &&
    left.clientId === right.clientId &&
    left.owner === right.owner &&
    left.label === right.label &&
    left.linkedAt === right.linkedAt &&
    left.routerBaseUrl === right.routerBaseUrl &&
    left.scopes.length === right.scopes.length &&
    left.scopes.every((scope, index) => scope === right.scopes[index])
  );
}

async function consoleRequest(
  deps: RouterClientDeps,
  path: string,
  init: RequestInit,
  failureMessage: string,
  knownLink?: AgentLink,
): Promise<Response> {
  const link = knownLink ?? (await linkedWallet(deps));
  try {
    return await agentFetch(
      {
        secrets: deps.secrets,
        wallets: deps.wallets,
        wallet: deps.wallet,
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      },
      `${trimTrailingSlashes(link.apiBase)}${path}`,
      init,
    );
  } catch (error) {
    if (error instanceof AgentLinkError && error.code === "not_linked") {
      throw linkStatusError(error);
    }
    throw new RouterClientError("http", failureMessage);
  }
}

async function verifyAgentLink(deps: RouterClientDeps): Promise<void> {
  const link = await linkedWallet(deps);
  try {
    await agentFetch(
      {
        secrets: deps.secrets,
        wallets: deps.wallets,
        wallet: deps.wallet,
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      },
      `${trimTrailingSlashes(link.apiBase)}/api/agents/self/router`,
      { method: "GET" },
    );
  } catch (error) {
    if (error instanceof AgentLinkError && error.code === "not_linked") {
      throw linkStatusError(error);
    }
  }
}

function validRouterBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidRouterBaseUrlError();
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw invalidRouterBaseUrlError();
  }
  return trimTrailingSlashes(value);
}

function invalidRouterBaseUrlError(): RouterClientError {
  return new RouterClientError("http", "The vAPI Router base URL is invalid.");
}

function notLinkedError(): RouterClientError {
  return new RouterClientError("not_linked", "Not linked. Run vapi login.");
}

function revokedLinkError(): RouterClientError {
  return new RouterClientError("not_linked", AGENT_LINK_REVOKED_MESSAGE);
}

function linkStatusError(error: AgentLinkError): RouterClientError {
  return error.message === AGENT_LINK_REVOKED_MESSAGE ? revokedLinkError() : notLinkedError();
}

function noRouterKeyError(): RouterClientError {
  return new RouterClientError(
    "no_router_key",
    "No Router key is stored for this wallet. Run vapi router key --rotate.",
  );
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, "");
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function responseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
