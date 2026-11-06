import { getAddress } from "viem";

import type { AgentCashConfig } from "./config.js";
import type { VapiPaymentAccount } from "./keystore.js";
import {
  createNetworkPublicClient,
  DEFAULT_ARC_GAS_HEADROOM_ATOMIC,
  getNetworkDefinition,
  isSolanaNetwork,
  usesUsdcGas,
} from "./networks.js";
import type { LookupFn } from "./net-guard.js";
import { readSolanaUsdcBalance } from "./svm.js";
import { usdToAtomic } from "./x402.js";

export const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
] as const;

export type SweepResult = {
  network: string;
  amountAtomic: string;
  transaction: string;
};

export class SweepGasError extends Error {
  readonly address: string;

  constructor(address: string, cause: unknown) {
    super(
      `This wallet has no ETH on Base to pay the gas for the sweep. Send a little ETH on Base (a few cents) to ${address}, then run vapi sweep again.`,
      { cause },
    );
    this.name = "SweepGasError";
    this.address = address;
  }
}

export function calculateSweepAmount(balanceAtomic: bigint, gasHeadroomAtomic: bigint): bigint {
  if (balanceAtomic < 0n || gasHeadroomAtomic < 0n) {
    throw new Error("Sweep balance and gas headroom cannot be negative.");
  }
  return balanceAtomic > gasHeadroomAtomic ? balanceAtomic - gasHeadroomAtomic : 0n;
}

export function getArcGasHeadroomAtomic(): bigint {
  const configured = process.env.VAPI_ARC_GAS_HEADROOM_USDC?.trim();
  if (!configured) {
    return DEFAULT_ARC_GAS_HEADROOM_ATOMIC;
  }
  try {
    return usdToAtomic(configured);
  } catch {
    throw new Error(
      "VAPI_ARC_GAS_HEADROOM_USDC must be a non-negative USDC amount with at most 6 decimals.",
    );
  }
}

export async function readUsdcBalance(args: {
  network: string;
  configured: AgentCashConfig["networks"][string];
  address: string;
  allowPrivateNetwork?: boolean;
  fetchImpl?: typeof fetch;
  lookup?: LookupFn;
}): Promise<bigint> {
  if (isSolanaNetwork(args.network)) {
    return await readSolanaUsdcBalance({
      network: args.network,
      configured: args.configured,
      address: args.address,
      allowPrivateNetwork: args.allowPrivateNetwork,
      ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
      ...(args.lookup ? { lookup: args.lookup } : {}),
    });
  }
  const client = createNetworkPublicClient(args.network, args.configured, {
    allowPrivateNetwork: args.allowPrivateNetwork,
    ...(args.fetchImpl ? { fetch: args.fetchImpl } : {}),
    ...(args.lookup ? { lookup: args.lookup } : {}),
  });
  return await client.readContract({
    address: getAddress(
      usesUsdcGas(args.network) ? getNetworkDefinition(args.network).usdc : args.configured.usdc,
    ),
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [getAddress(args.address)],
  });
}

export type SweepBackArgs = {
  account: VapiPaymentAccount;
  config: AgentCashConfig;
  network: string;
  destination: string;
  /** Configuration home used to bind the signer to any owning swarm. Defaults to VAPI_HOME. */
  home?: string;
  arcGasHeadroomAtomic?: bigint;
  fetchImpl?: typeof fetch;
  lookup?: LookupFn;
};
