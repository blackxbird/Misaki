import { z } from "zod";

import {
  AGENT_LINK_REVOKED_MESSAGE,
  AgentLinkError,
  agentAccessToken,
  agentFetch,
  agentSecretAccounts,
  withAgentCredentialLock,
} from "./agent-link.js";
import type { RunRef } from "./agent-run.js";
import { appendAudit } from "./audit.js";
import { sweepAboveCeiling } from "./ceiling.js";
import type { SpendCaps, VapiConfig } from "./config.js";
import type { VapiPaymentAccount } from "./keystore.js";
import { createPublicFetch } from "./net-guard.js";
import { formatUsdc } from "./networks.js";
import type { Receipt } from "./receipts.js";
import type { RunBudget } from "./run-budget.js";
import type { SecretStore } from "./secret-store.js";
import { SpendCapExceededError } from "./spend-cap-exceeded.js";
import { SpendCapError } from "./spend-policy.js";
import { swarmParentResolver } from "./swarm.js";
import {
  ROUTER_TOPUP_TIERS,
  type AgentLink,
  type RouterTopupTier,
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
    readonly code: "not_linked" | "no_router_key" | "budget_exhausted" | "rate_limited" | "http",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "RouterClientError";
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

export async function buyRouterBalance(
  deps: RouterClientDeps & {
    account: VapiPaymentAccount;
    config: VapiConfig;
    caps: SpendCaps;
    paths?: { ledgerPath?: string; receiptsPath?: string };
    now?: Date;
    allowanceExpiresAt?: Date;
    runBudget?: RunBudget;
    run?: RunRef;
  },
  tierUsd: RouterTopupTier,
): Promise<{ receipt: Receipt; balance: AgentRouterUsage["balance"] }> {
  if (!isRouterTopupTier(tierUsd)) {
    throw new RouterClientError("http", "Router balance must use a $1, $5, $20, or $50 tier.");
  }
  const { link, accessToken } = await purchaseCredentialSnapshot(deps);
  const { response, receipt } = await payRequest({
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
    ...(deps.paths === undefined ? {} : { paths: deps.paths }),
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
  if (!response.ok) {
    if (response.status === 401) await verifyAgentLink(deps);
    throw new RouterClientError(
      "http",
      `The Router balance purchase returned HTTP ${response.status}.`,
      response.status,
    );
  }

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

  try {
    await ensureBalanceRouterKey(deps, link);
  } catch {
    throw new RouterClientError(
      "http",
      "The Router balance payment went through, but its key could not be fetched or stored. It can be fetched on the next chat/buy.",
    );
  }

  return { receipt, balance: (await routerUsage(deps)).balance };
}

export async function routerChat(
  deps: RouterClientDeps,
  request: ChatRequest,
): Promise<ChatResult> {
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

    let usage: AgentRouterUsage | undefined;
    try {
      usage = await routerUsage(deps);
    } catch {
      // Unknown balance is allowed to try a stored key; the Router remains authoritative.
    }
    const resetsAt = usage?.compute.resetsAt ?? "00:00 UTC";
    let balance = usage?.balance;
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
        balance = (
          await buyRouterBalance(
            {
              ...deps,
              account,
              config: deps.refill.config,
              caps,
              ...(deps.refill.paths === undefined ? {} : { paths: deps.refill.paths }),
              ...(deps.refill.now === undefined
                ? {}
                : {
                    now:
                      typeof deps.refill.now === "function" ? deps.refill.now() : deps.refill.now,
                  }),
              ...(deps.refill.allowanceExpiresAt === undefined
                ? {}
                : { allowanceExpiresAt: deps.refill.allowanceExpiresAt }),
              ...(deps.refill.runBudget === undefined ? {} : { runBudget: deps.refill.runBudget }),
              ...(deps.refill.run === undefined ? {} : { run: deps.refill.run }),
            },
            refill.tierUsd,
          )
        ).balance;
      } catch (refillError) {
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

    const mayHaveBalance = usage === undefined || (balance?.remainingUsd ?? 0) > 0;
    if (mayHaveBalance) {
      const balanceCredentials = await routerBalanceCredentialSnapshot(deps);
      if (balanceCredentials !== undefined) {
        try {
          return await sendRouterChat(
            deps,
            balanceCredentials.routerBaseUrl,
            balanceCredentials.routerKey,
            request,
            "balance",
          );
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
