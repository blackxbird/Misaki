import type { SecretStore, VapiConfig, VapiPaymentAccount, WalletStore } from "@vapi-network/core";
import { spendCapsForWallet, walletNameSchema } from "@vapi-network/core";
import {
  buyRouterBalance,
  listRouterModels,
  ownerStake,
  routerChat,
  routerUsage,
  routerPurchaseSummary,
  type AgentRouterUsage,
  type RouterClientDeps,
} from "@vapi-network/core/router-client";
import { z } from "zod";

import type { WalletSession } from "../wallet-session.js";

const walletArgument = {
  wallet: walletNameSchema
    .optional()
    .describe(
      "Wallet name. Without it: the session's active wallet, then VAPI_WALLET, then the machine default.",
    ),
};

const usageSchema = z.object({
  prompt_tokens: z.number(),
  completion_tokens: z.number(),
  total_tokens: z.number(),
});

const routerUsageSchema = {
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
};

const chatMessageSchema = z.strictObject({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

const routerChatInputShape = {
  model: z.string().min(1).max(200),
  messages: z.array(chatMessageSchema).min(1).max(50),
  max_tokens: z.number().int().min(1).max(4096).optional(),
  ...walletArgument,
};

const routerChatInputSchema = z.strictObject(routerChatInputShape);

const routerBuyInputShape = {
  usd: z.union([z.literal(1), z.literal(5), z.literal(20), z.literal(50)]),
  ...walletArgument,
};

const routerBuyInputSchema = z.strictObject(routerBuyInputShape);

const KEY_SAFETY_DESCRIPTION = "The Router key stays in the OS secret store and is never returned.";

export const routerModelsTool = {
  description: `List model ids available from vAPI Router. ${KEY_SAFETY_DESCRIPTION}`,
  inputSchema: {},
  outputSchema: z.object({ models: z.array(z.string()) }),
};

export const routerUsageTool = {
  description: `Show this linked wallet's vAPI Router usage and its owner's stake-funded Compute. ${KEY_SAFETY_DESCRIPTION}`,
  inputSchema: { ...walletArgument },
  outputSchema: z.object({
    ...routerUsageSchema,
    stake: z.object({
      owner: z.string(),
      stake: z.string(),
      computeTodayUsd: z.number(),
    }),
  }),
};

export const routerChatTool = {
  description: `Send a text conversation through vAPI Router. Tool calls are not accepted. ${KEY_SAFETY_DESCRIPTION}`,
  inputSchema: routerChatInputShape,
  strictInput: true,
  outputSchema: z.object({
    content: z.string().nullable(),
    model: z.string(),
    usage: usageSchema.optional(),
  }),
};

export const routerBuyTool = {
  description: `Buy prepaid vAPI Router balance with the selected local wallet, subject to that wallet's daily spend cap. ${KEY_SAFETY_DESCRIPTION}`,
  inputSchema: routerBuyInputShape,
  strictInput: true,
  outputSchema: z.object({
    receipt: z.object({
      id: z.string(),
      amountUsd: z.number().nullable(),
      network: z.string(),
      transaction: z.string().optional(),
    }),
    balance: routerUsageSchema.balance,
  }),
};

export type RouterCoreOverrides = {
  listRouterModels?: typeof listRouterModels | undefined;
  routerUsage?: typeof routerUsage | undefined;
  routerChat?: typeof routerChat | undefined;
  ownerStake?: typeof ownerStake | undefined;
  buyRouterBalance?: typeof buyRouterBalance | undefined;
};

export type RouterToolsOptions = RouterCoreOverrides & {
  session: WalletSession;
  secrets: SecretStore;
  wallets?: WalletStore | undefined;
  fetchImpl: typeof fetch;
  apiBase: string;
  account: VapiPaymentAccount;
  config: VapiConfig;
  ledgerPath?: string | undefined;
  receiptsPath?: string | undefined;
};

type ToolResult = {
  structuredContent: Record<string, unknown>;
  content: Array<{ type: "text"; text: string }>;
};

export function createRouterTools(options: RouterToolsOptions): {
  models(input: Record<string, never>): Promise<ToolResult>;
  usage(input: { wallet?: string }): Promise<ToolResult>;
  chat(input: z.infer<typeof routerChatInputSchema>): Promise<ToolResult>;
  buy(input: z.infer<typeof routerBuyInputSchema>): Promise<ToolResult>;
} {
  const listModels = options.listRouterModels ?? listRouterModels;
  const readUsage = options.routerUsage ?? routerUsage;
  const chat = options.routerChat ?? routerChat;
  const readStake = options.ownerStake ?? ownerStake;
  const buyBalance = options.buyRouterBalance ?? buyRouterBalance;
  // `options.account` was unlocked before stdio started. Keep its original
  // wallet identity: `wallet.use` may move the active session later, and chat
  // must never unlock a different wallet merely to attempt an automatic refill.
  const unlockedWallet = options.session.resolve().name;

  return {
    async models() {
      const models = await listModels({ apiBase: options.apiBase, fetchImpl: options.fetchImpl });
      return toolResult({ models: models.map((model) => model.id) });
    },

    async usage(input) {
      await options.session.resolveLatest(input.wallet);
      const deps = routerDeps(options, input.wallet);
      const [usage, stake] = await Promise.all([readUsage(deps), readStake(deps)]);
      return toolResult({
        ...publicUsage(usage),
        stake: {
          owner: stake.owner,
          stake: stake.stake,
          computeTodayUsd: stake.computeTodayUsd,
        },
      });
    },

    async chat(input) {
      const parsed = routerChatInputSchema.parse(input);
      await options.session.resolveLatest(parsed.wallet);
      const result = await chat(routerDeps(options, parsed.wallet, unlockedWallet), {
        model: parsed.model,
        messages: parsed.messages,
        ...(parsed.max_tokens === undefined ? {} : { max_tokens: parsed.max_tokens }),
      });
      return toolResult({
        content: result.content,
        model: result.model,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      });
    },

    async buy(input) {
      const parsed = routerBuyInputSchema.parse(input);
      if (options.wallets === undefined) {
        throw new Error("No wallet store is available, so no linked wallet can be selected.");
      }
      await options.wallets.reload();
      const wallet = options.session.resolve(parsed.wallet);
      const caps = options.wallets.entry(wallet.name)?.spendCaps;
      const requiredAtomic = BigInt(parsed.usd) * 1_000_000n;
      if (
        caps === undefined ||
        BigInt(caps.perDayAtomic) === 0n ||
        BigInt(caps.perDayAtomic) < requiredAtomic
      ) {
        throw new Error(
          `Wallet ${wallet.name} needs a daily spend cap of at least $${parsed.usd} before it can buy Router balance. Set it with vapi wallet caps ${wallet.name} --per-day ${parsed.usd}.`,
        );
      }

      const selected = await options.session.payment(wallet.name);
      if (selected.spendCaps === undefined) {
        throw new Error(
          `Wallet ${wallet.name} has no resolved spend caps. Set them with vapi wallet caps ${wallet.name}.`,
        );
      }
      const result = await buyBalance(
        {
          ...routerDeps(options, wallet.name),
          account: selected.account,
          config: options.config,
          caps: selected.spendCaps,
          ...(options.ledgerPath === undefined && options.receiptsPath === undefined
            ? {}
            : {
                paths: {
                  ...(options.ledgerPath === undefined ? {} : { ledgerPath: options.ledgerPath }),
                  ...(options.receiptsPath === undefined
                    ? {}
                    : { receiptsPath: options.receiptsPath }),
                },
              }),
        },
        parsed.usd,
      );
      const { amountUsd, network } = routerPurchaseSummary(result.receipt);
      return toolResult({
        receipt: {
          id: result.receipt.id,
          amountUsd,
          network,
          ...(result.receipt.settlement?.transaction === undefined
            ? {}
            : { transaction: result.receipt.settlement.transaction }),
        },
        balance: publicBalance(result.balance),
      });
    },
  };
}

function publicUsage(usage: AgentRouterUsage): AgentRouterUsage {
  return {
    compute: {
      allowanceUsd: usage.compute.allowanceUsd,
      spentTodayUsd: usage.compute.spentTodayUsd,
      remainingTodayUsd: usage.compute.remainingTodayUsd,
      resetsAt: usage.compute.resetsAt,
      ownerLimitUsd: usage.compute.ownerLimitUsd,
      ownerSpentUsd: usage.compute.ownerSpentUsd,
    },
    balance:
      usage.balance === null
        ? null
        : {
            purchasedUsd: usage.balance.purchasedUsd,
            spentUsd: usage.balance.spentUsd,
            remainingUsd: usage.balance.remainingUsd,
          },
  };
}

function publicBalance(usage: AgentRouterUsage["balance"]): AgentRouterUsage["balance"] {
  return usage === null
    ? null
    : {
        purchasedUsd: usage.purchasedUsd,
        spentUsd: usage.spentUsd,
        remainingUsd: usage.remainingUsd,
      };
}

function routerDeps(
  options: RouterToolsOptions,
  wallet?: string,
  unlockedWallet?: string,
): RouterClientDeps {
  if (options.wallets === undefined) {
    throw new Error("No wallet store is available, so no linked wallet can be selected.");
  }
  const selected = options.session.resolve(wallet);
  const caps = options.wallets.entry(selected.name)?.spendCaps;
  return {
    secrets: options.secrets,
    wallets: options.wallets,
    wallet: selected.name,
    fetchImpl: options.fetchImpl,
    ...(unlockedWallet === selected.name && caps !== undefined
      ? {
          refill: {
            account: options.account,
            config: options.config,
            caps: async () => {
              await options.wallets!.reload();
              return await spendCapsForWallet(options.wallets!, selected.name);
            },
            ...(options.ledgerPath === undefined && options.receiptsPath === undefined
              ? {}
              : {
                  paths: {
                    ...(options.ledgerPath === undefined ? {} : { ledgerPath: options.ledgerPath }),
                    ...(options.receiptsPath === undefined
                      ? {}
                      : { receiptsPath: options.receiptsPath }),
                  },
                }),
          },
        }
      : {}),
  };
}

function toolResult(value: Record<string, unknown>): ToolResult {
  return {
    structuredContent: value,
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}
