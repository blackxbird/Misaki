import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { BASE_MAINNET_CAIP2, NETWORKS } from "../packages/core/src/networks.js";

/** Real x402 challenge/payment transport; only the follow-up failure is injected. */
export function purchaseTransport(
  home: string,
  failure: "audit" | "key" | "balance" | "all" | "response" | "receipt" | "key-store",
  routerBase = "https://router.example",
) {
  const calls = { paid: 0, key: 0, balance: 0 };
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === "/api/router/top-up/5") {
      if (!request.headers.has("payment-signature")) {
        return Response.json(
          {
            x402Version: 2,
            resource: { url: url.href, mimeType: "application/json" },
            accepts: [
              {
                scheme: "exact",
                network: BASE_MAINNET_CAIP2,
                amount: "4750000",
                asset: NETWORKS[BASE_MAINNET_CAIP2].usdc,
                payTo: "0x2222222222222222222222222222222222222222",
                maxTimeoutSeconds: 60,
                extra: { name: "USD Coin", version: "2" },
              },
            ],
          },
          { status: 402 },
        );
      }
      calls.paid++;
      if (failure === "receipt") await mkdir(join(home, "receipts.jsonl"));
      if (failure === "audit" || failure === "all") {
        await rm(join(home, "audit.log"), { force: true });
        await mkdir(join(home, "audit.log"));
      }
      return Response.json(
        { status: "accepted" },
        {
          status: failure === "response" ? 503 : 200,
          headers: {
            "payment-response": Buffer.from(
              JSON.stringify({
                success: true,
                network: BASE_MAINNET_CAIP2,
                transaction: `0x${"33".repeat(32)}`,
              }),
            ).toString("base64"),
          },
        },
      );
    }
    if (url.pathname === "/api/agents/self/router-balance-key") {
      calls.key++;
      return failure === "key" || failure === "all"
        ? new Response("private-follow-up-error-must-not-leak", { status: 503 })
        : Response.json({ router_key: "test-balance-key", router_base_url: routerBase });
    }
    if (url.pathname === "/api/agents/self/router") {
      calls.balance++;
      return failure === "balance" || failure === "all"
        ? new Response("private-follow-up-error-must-not-leak", { status: 503 })
        : Response.json({
            compute: {
              allowanceUsd: 0,
              spentTodayUsd: 0,
              remainingTodayUsd: 0,
              resetsAt: "2026-11-07T00:00:00.000Z",
              ownerLimitUsd: 0,
              ownerSpentUsd: 0,
            },
            balance: { purchasedUsd: 5, spentUsd: 0, remainingUsd: 5 },
          });
    }
    // A scheduled ceiling sweep sees zero balances and never sends a transfer.
    const body = (await request.json()) as { id?: number };
    return Response.json({ jsonrpc: "2.0", id: body.id, result: `0x${"0".repeat(64)}` });
  };
  return { fetchImpl, calls };
}
