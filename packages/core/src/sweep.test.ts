import { readFile, readdir } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

import {
  calculateSweepAmount,
  getArcGasHeadroomAtomic,
  SweepGasError,
  sweepBack,
} from "./sweep.js";
import { ARC_MAINNET_CAIP2, BASE_MAINNET_CAIP2, usesUsdcGas } from "./networks.js";

const SWEEP_ACCOUNT = privateKeyToAccount(
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);
const SWEEP_DESTINATION = "0x2222222222222222222222222222222222222222";
const SWEEP_CONFIG = {
  discoveryUrl: "https://api.vapinetwork.ai",
  marketplaceDiscoveryUrl: "https://api.vapinetwork.ai",
  networks: {
    [BASE_MAINNET_CAIP2]: {
      rpcUrl: "https://rpc.example",
      usdc: "0x3600000000000000000000000000000000000000",
    },
    [ARC_MAINNET_CAIP2]: {
      rpcUrl: "https://rpc.example",
      usdc: "0x3600000000000000000000000000000000000000",
    },
    "eip155:1": {
      rpcUrl: "https://rpc.example",
      usdc: "0x3600000000000000000000000000000000000000",
    },
  },
  spendCaps: { perCallAtomic: "100000", perDayAtomic: "1000000" },
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sweep amount math", () => {
  it("sweeps a full Base USDC balance when headroom is zero", () => {
    expect(calculateSweepAmount(2_500_000n, 0n)).toBe(2_500_000n);
  });

  it("leaves Arc's default 0.05 USDC gas headroom", () => {
    vi.stubEnv("VAPI_ARC_GAS_HEADROOM_USDC", "");
    expect(getArcGasHeadroomAtomic()).toBe(50_000n);
    expect(calculateSweepAmount(2_500_000n, 50_000n)).toBe(2_450_000n);
    expect(calculateSweepAmount(40_000n, 50_000n)).toBe(0n);
    expect(usesUsdcGas(ARC_MAINNET_CAIP2)).toBe(true);
    expect(calculateSweepAmount(2_500_000n, usesUsdcGas(ARC_MAINNET_CAIP2) ? 50_000n : 0n)).toBe(
      2_450_000n,
    );
  });

  it("parses configured Arc gas headroom as atomic USDC", () => {
    vi.stubEnv("VAPI_ARC_GAS_HEADROOM_USDC", "1.234567");
    expect(getArcGasHeadroomAtomic()).toBe(1_234_567n);
  });

  it("preserves the Arc gas headroom validation error", () => {
    vi.stubEnv("VAPI_ARC_GAS_HEADROOM_USDC", "1.2345678");
    expect(() => getArcGasHeadroomAtomic()).toThrow(
      "VAPI_ARC_GAS_HEADROOM_USDC must be a non-negative USDC amount with at most 6 decimals.",
    );
  });
});

describe("sweep gas errors", () => {
  it.each(["gas required exceeds allowance (0)", "insufficient funds for gas * price + value"])(
    "turns %j into a friendly Base gas error",
    async (message) => {
      const error = await sweepBack({
        account: SWEEP_ACCOUNT,
        config: SWEEP_CONFIG,
        network: BASE_MAINNET_CAIP2,
        destination: SWEEP_DESTINATION,
        fetchImpl: noGasSweepRpc(message, "0x2105"),
      }).catch((caught: unknown) => caught);

      const friendly =
        `This wallet has no ETH on Base to pay the gas for the sweep. Send a little ETH on Base ` +
        `(a few cents) to ${SWEEP_ACCOUNT.address}, then run vapi sweep again.`;
      expect(error).toBeInstanceOf(SweepGasError);
      expect(error).toMatchObject({ address: SWEEP_ACCOUNT.address, message: friendly });
      expect((error as SweepGasError).cause).toBeDefined();
    },
  );

  it("keeps Arc's insufficient-funds error as a normal error", async () => {
    const error = await sweepBack({
      account: SWEEP_ACCOUNT,
      config: SWEEP_CONFIG,
      network: ARC_MAINNET_CAIP2,
      destination: SWEEP_DESTINATION,
      fetchImpl: noGasSweepRpc("insufficient funds for gas * price + value", "0x13b2"),
    }).catch((caught: unknown) => caught);

    expect(error).not.toBeInstanceOf(SweepGasError);
  });

  it("does not call a non-Base EVM gas error a Base gas error", async () => {
    const error = await sweepBack({
      account: SWEEP_ACCOUNT,
      config: SWEEP_CONFIG,
      network: "eip155:1",
      destination: SWEEP_DESTINATION,
      fetchImpl: noGasSweepRpc("insufficient funds for gas * price + value", "0x1"),
    }).catch((caught: unknown) => caught);

    expect(error).not.toBeInstanceOf(SweepGasError);
  });
});

function noGasSweepRpc(message: string, chainId: string) {
  return vi.fn<typeof fetch>(async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { id: number; method: string };
    if (request.method === "eth_estimateGas" || request.method === "eth_sendRawTransaction") {
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message },
      });
    }
    const result =
      request.method === "eth_call"
        ? `0x${(1_000_000).toString(16).padStart(64, "0")}`
        : request.method === "eth_chainId"
          ? chainId
          : "0x0";
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  });
}

it("keeps raw sweep broadcasting private to the guarded transfer module", async () => {
  const transfer = await import("./transfer.js");
  expect(transfer).not.toHaveProperty("broadcastSweep");
  expect(transfer).not.toHaveProperty("performTransfer");
  const sweepSource = await readFile(new URL("./sweep.ts", import.meta.url), "utf8");
  expect(sweepSource).not.toContain(".writeContract(");
  for (const name of await readdir(new URL(".", import.meta.url))) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    const source = await readFile(new URL(name, import.meta.url), "utf8");
    expect(source, name).not.toMatch(
      /(?:import|export)\s+(?:type\s+)?\{[^}]*\b(?:broadcastSweep|performTransfer)\b/s,
    );
  }
});
