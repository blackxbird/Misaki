import { bytesToHex, getAddress, type Address, type Hex } from "viem";
import { ExactSvmScheme } from "@x402/svm/exact/client";

import { createPublicFetch } from "./net-guard.js";
import { discardBody } from "./http-response.js";
import { isSolanaAddress } from "./svm.js";
import {
  areSamePaymentNetwork,
  SOLANA_MAINNET_CAIP2,
  SOLANA_MAINNET_USDC,
  X402_SOLANA_MAINNET_CAIP2,
} from "./networks.js";
import { getCanonicalX402Usdc, type X402NetworkConfig } from "./x402-networks.js";

export type { Address, Hex } from "viem";
export { discardBody } from "./http-response.js";

export {
  ARC_MAINNET_CAIP2,
  ARC_TESTNET_CAIP2,
  BASE_MAINNET_CAIP2,
  BROWSER_ENABLED_X402_NETWORK_CONFIG,
  CANONICAL_X402_USDC_NETWORKS,
  SOLANA_MAINNET_CAIP2,
  SOLANA_MAINNET_USDC,
  X402_SOLANA_MAINNET_CAIP2,
  getCanonicalX402Usdc,
  type CanonicalX402UsdcIdentity,
  type CanonicalX402UsdcNetwork,
  type X402NetworkConfig,
  type X402TokenDomain,
} from "./x402-networks.js";

const MAX_CHALLENGE_BYTES = 1_048_576;
const MAX_UINT256 = (1n << 256n) - 1n;
// Discovery metadata (Bazaar schemas, examples) is legitimately deep and wide;
// these caps only bound memory, they are not a validity rule.
const MAX_METADATA_DEPTH = 32;
const MAX_METADATA_ENTRIES = 4096;
const MAX_METADATA_KEYS_PER_OBJECT = 64;
const MAX_METADATA_ARRAY_LENGTH = 64;
const MAX_METADATA_STRING_LENGTH = 16_384;
const BUILDER_CODE_PATTERN = /^[a-z0-9_]{1,32}$/;
const PAYMENT_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export const VAPI_BUILDER_CODE = "vapi";

export const EIP3009_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export type X402Resource = {
  url: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
};

export type EvmX402PaymentRequirements = {
  scheme: "exact";
  network: `eip155:${number}`;
  asset: Address;
  amount: string;
  payTo: Address;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown> & { name: string; version: string };
};

export type SvmX402PaymentRequirements = {
  scheme: "exact";
  network: `solana:${string}`;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown> & { feePayer: string };
};

export type X402PaymentRequirements = EvmX402PaymentRequirements | SvmX402PaymentRequirements;

export type X402Quote = {
  x402Version: 2;
  amountAtomic: bigint;
  resource: X402Resource;
  accepted: X402PaymentRequirements;
  extensions?: Record<string, unknown>;
  /** Local-only RPC route; never serialized into the payment payload. */
  rpcUrl?: string;
};

export type Eip3009Authorization = {
  from: Address;
  to: Address;
  value: string;
  validAfter: "0";
  validBefore: string;
  nonce: Hex;
};

export type X402TypedData = {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Address;
  };
  types: typeof EIP3009_AUTHORIZATION_TYPES;
  primaryType: "TransferWithAuthorization";
  message: {
    from: Address;
    to: Address;
    value: bigint;
    validAfter: 0n;
    validBefore: bigint;
    nonce: Hex;
  };
};

export type X402Signer = {
  address: Address;
  signTypedData(typedData: X402TypedData): Promise<Hex>;
  solana?: ConstructorParameters<typeof ExactSvmScheme>[0];
};

/** Durable public evidence recorded before any signature can exist. */
export type X402SigningEvidence = {
  network: string;
  token: string;
  amountAtomic: string;
  authorization?: Eip3009Authorization;
};

export type X402PaymentPayload = {
  x402Version: 2;
  resource: X402Resource;
  accepted: X402PaymentRequirements;
  payload: { signature: Hex; authorization: Eip3009Authorization } | { transaction: string };
  extensions?: Record<string, unknown>;
};

export type X402PaymentHeaders = {
  "PAYMENT-SIGNATURE": string;
};

export type X402CompatiblePaymentHeaders = X402PaymentHeaders & {
  "X-PAYMENT": string;
};

export type X402SettlementOutcome = "succeeded" | "rejected" | "unknown";

export class X402Error extends Error {
  constructor(
    public readonly code: "invalid_challenge" | "unsupported_challenge" | "max_price_exceeded",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "X402Error";
  }
}

/** Returns whether a value is a valid x402 payment-identifier id. */
export function isValidPaymentId(value: unknown): value is string {
  return typeof value === "string" && PAYMENT_ID_PATTERN.test(value);
}

/** Creates a fresh x402 payment-identifier id from 16 random bytes. */
export function createPaymentId(
  randomBytes: (bytes: Uint8Array<ArrayBuffer>) => void = fillRandomBytes,
): string {
  const bytes = new Uint8Array(16);
  randomBytes(bytes);
  return `pay_${bytesToHex(bytes).slice(2)}`;
}

/**
 * Builds the extensions sent in a payment payload without mutating the
 * server-declared extensions. A payment id is required only when the server
 * advertised payment-identifier.
 */
export function buildPaymentExtensions(
  serverExtensions: Readonly<Record<string, unknown>> | undefined,
  options: Readonly<{ paymentId?: string }> = {},
): Record<string, unknown> {
  const declaredBuilderCode = serverExtensions?.["builder-code"];
  const builderInfo = isRecord(declaredBuilderCode) ? declaredBuilderCode.info : undefined;
  const serverBuilderInfo = isRecord(builderInfo) ? builderInfo : undefined;
  const declaredServerCodes = serverBuilderInfo?.s;
  const serverCodes =
    typeof declaredServerCodes === "string"
      ? [declaredServerCodes]
      : Array.isArray(declaredServerCodes)
        ? declaredServerCodes
        : undefined;
  const validServerCodes: string[] = [];
  if (serverCodes) {
    for (const code of serverCodes) {
      if (
        typeof code === "string" &&
        BUILDER_CODE_PATTERN.test(code) &&
        code !== VAPI_BUILDER_CODE &&
        !validServerCodes.includes(code) &&
        validServerCodes.length < 5
      ) {
        validServerCodes.push(code);
      }
    }
  }
  const appCode = serverBuilderInfo?.a;
  // Facilitators read attribution from `extensions["builder-code"].info`
  // (`BuilderCodeFacilitatorExtension` in @x402/extensions), so the codes go in
  // `info`, and the server's declared `schema` is echoed alongside, the same
  // shape the reference client produces after merging with the 402.
  const builderCode = {
    info: {
      ...(typeof appCode === "string" && BUILDER_CODE_PATTERN.test(appCode) ? { a: appCode } : {}),
      s: [VAPI_BUILDER_CODE, ...validServerCodes],
    },
    ...(isRecord(declaredBuilderCode) && declaredBuilderCode.schema !== undefined
      ? { schema: declaredBuilderCode.schema }
      : {}),
  };

  const paymentIdentifier = serverExtensions?.["payment-identifier"];
  if (!isRecord(paymentIdentifier)) {
    return { ...serverExtensions, "builder-code": builderCode };
  }
  if (!isValidPaymentId(options.paymentId)) {
    throw new X402Error(
      "invalid_challenge",
      "paymentId must be 16-128 characters containing only letters, digits, underscores, or hyphens.",
    );
  }
  const paymentInfo = isRecord(paymentIdentifier.info) ? paymentIdentifier.info : {};
  return {
    ...serverExtensions,
    "builder-code": builderCode,
    "payment-identifier": {
      schema: paymentIdentifier.schema,
      info: { ...paymentInfo, id: options.paymentId },
    },
  };
}

export function parse402Challenge(
  challenge: unknown,
  configuredNetworks: X402NetworkConfig,
  fallbackResourceUrl = "",
  requiredNetwork?: string,
  expectedPayTo?: string,
): X402Quote {
  if (!isRecord(challenge) || !Array.isArray(challenge.accepts)) {
    throw new X402Error("invalid_challenge", "x402 challenge has no accepts array.");
  }
  if (challenge.x402Version !== undefined && challenge.x402Version !== 2) {
    throw new X402Error(
      "unsupported_challenge",
      `Unsupported x402 version: ${String(challenge.x402Version)}.`,
    );
  }

  const candidates = challenge.accepts.filter(isRecord);
  const accepted = candidates.find((candidate) => {
    const network = readString(candidate, "network");
    const scheme = readString(candidate, "scheme");
    if (
      scheme !== "exact" ||
      !network ||
      (requiredNetwork && !areSamePaymentNetwork(network, requiredNetwork))
    ) {
      return false;
    }
    const configured = configuredX402Network(configuredNetworks, network);
    if (!configured || configured.enabled === false) {
      return false;
    }
    const asset = readString(candidate, "asset");
    const payTo = readString(candidate, "payTo");
    const amount = readAmount(candidate);
    const maxTimeoutSeconds = readPositiveInteger(candidate.maxTimeoutSeconds);
    const extra = readBoundedJsonRecord(candidate.extra);
    if (isSupportedSolanaNetwork(network)) {
      const feePayer = extra ? readString(extra, "feePayer") : null;
      return Boolean(
        asset === SOLANA_MAINNET_USDC &&
        configured.usdc === SOLANA_MAINNET_USDC &&
        payTo &&
        isSolanaAddress(payTo) &&
        (!expectedPayTo || payTo === expectedPayTo) &&
        amount !== null &&
        maxTimeoutSeconds !== null &&
        feePayer &&
        isSolanaAddress(feePayer),
      );
    }
    const name = extra ? readString(extra, "name") : null;
    const version = extra ? readString(extra, "version") : null;
    const tokenDomain = canonicalTokenDomain(network, configured);
    if (
      !asset ||
      !payTo ||
      amount === null ||
      maxTimeoutSeconds === null ||
      !extra ||
      !name ||
      !version ||
      !tokenDomain ||
      name !== tokenDomain.name ||
      version !== tokenDomain.version ||
      (extra.assetTransferMethod !== undefined && extra.assetTransferMethod !== "eip3009")
    ) {
      return false;
    }
    // An EIP-3009 authorization is signed for the token contract itself. An
    // offer naming another verifying contract (Circle Gateway's batched
    // wallet, for one) wants a different payment flow, so it is not payable here.
    const verifyingContract = readString(extra, "verifyingContract");
    try {
      return (
        getAddress(asset) === getAddress(configured.usdc) &&
        (verifyingContract === null || getAddress(verifyingContract) === getAddress(asset)) &&
        (!expectedPayTo || getAddress(payTo) === getAddress(expectedPayTo))
      );
    } catch {
      return false;
    }
  });
  if (!accepted) {
    const offered = candidates
      .map(
        (candidate) =>
          `${readString(candidate, "scheme") ?? "?"}/${readString(candidate, "network") ?? "?"}`,
      )
      .join(", ");
    const expected = requiredNetwork
      ? `required network ${requiredNetwork} and its configured USDC asset`
      : "a configured network and USDC asset";
    throw new X402Error(
      "unsupported_challenge",
      `No exact x402 payment option matches ${expected}${offered ? ` (offered: ${offered})` : ""}.`,
    );
  }

  const network = readString(accepted, "network");
  const asset = readString(accepted, "asset");
  const payTo = readString(accepted, "payTo");
  const amountAtomic = readAmount(accepted);
  const maxTimeoutSeconds = readPositiveInteger(accepted.maxTimeoutSeconds);
  const extra = readBoundedJsonRecord(accepted.extra);
  if (
    !network ||
    !asset ||
    !payTo ||
    amountAtomic === null ||
    maxTimeoutSeconds === null ||
    !extra
  ) {
    throw new X402Error(
      "invalid_challenge",
      "x402 exact payment option is missing amount, asset, payTo, maxTimeoutSeconds, or scheme metadata.",
    );
  }

  let resource = readResource(challenge.resource, fallbackResourceUrl);
  if (!resource.url) resource = readResource(accepted.resource, fallbackResourceUrl);
  if (!resource.url) {
    throw new X402Error("invalid_challenge", "x402 challenge is missing its resource URL.");
  }
  // A challenge whose extensions exceed the bounded-JSON limits is still
  // payable. Preserve bounded payment extensions even when unrelated metadata
  // is too large, because builder-code and payment-identifier affect the
  // payment payload itself.
  const extensions = readChallengeExtensions(challenge.extensions);

  try {
    const configured = configuredX402Network(configuredNetworks, network);
    if (isSupportedSolanaNetwork(network)) {
      const feePayer = readString(extra, "feePayer");
      if (
        !feePayer ||
        !isSolanaAddress(asset) ||
        !isSolanaAddress(payTo) ||
        !isSolanaAddress(feePayer)
      ) {
        throw new Error("Invalid Solana exact-payment address.");
      }
      return {
        x402Version: 2,
        amountAtomic,
        resource,
        accepted: {
          scheme: "exact",
          network: network as `solana:${string}`,
          asset,
          amount: amountAtomic.toString(),
          payTo,
          maxTimeoutSeconds,
          extra: { ...extra, feePayer },
        },
        ...(extensions ? { extensions } : {}),
        ...(configured?.rpcUrl ? { rpcUrl: configured.rpcUrl } : {}),
      };
    }
    const name = readString(extra, "name");
    const version = readString(extra, "version");
    if (!name || !version) throw new Error("Missing EIP-712 domain fields.");
    parseEip155ChainId(network);
    return {
      x402Version: 2,
      amountAtomic,
      resource,
      accepted: {
        scheme: "exact",
        network: network as `eip155:${number}`,
        asset: getAddress(asset),
        amount: amountAtomic.toString(),
        payTo: getAddress(payTo),
        maxTimeoutSeconds,
        extra: { ...extra, name, version },
      },
      ...(extensions ? { extensions } : {}),
      ...(configured?.rpcUrl ? { rpcUrl: configured.rpcUrl } : {}),
    };
  } catch (error) {
    if (error instanceof X402Error) throw error;
    throw new X402Error(
      "invalid_challenge",
      "x402 challenge contains an invalid network or address.",
      { cause: error },
    );
  }
}

/** Decodes a `PAYMENT-REQUIRED` header: base64 of the JSON payment offer. Throws when it is not. */
export function decodePaymentRequiredHeader(value: string): unknown {
  return decodeBase64Json(value);
}

export async function parse402Response(
  response: Response,
  configuredNetworks: X402NetworkConfig,
  requiredNetwork?: string,
  expectedPayTo?: string,
): Promise<X402Quote> {
  const header = response.headers.get("payment-required");
  let headerError: unknown;
  if (header) {
    try {
      const quote = parse402Challenge(
        decodePaymentRequiredHeader(header),
        configuredNetworks,
        response.url,
        requiredNetwork,
        expectedPayTo,
      );
      discardBody(response);
      return quote;
    } catch (error) {
      headerError = error;
    }
  }
  try {
    return parse402Challenge(
      await readBoundedJson(response, MAX_CHALLENGE_BYTES),
      configuredNetworks,
      response.url,
      requiredNetwork,
      expectedPayTo,
    );
  } catch (error) {
    if (headerError instanceof X402Error) throw headerError;
    if (error instanceof X402Error) throw error;
    throw new X402Error(
      "invalid_challenge",
      "x402 402 response has neither a valid payment-required header nor a JSON accepts[] body.",
      { cause: error },
    );
  }
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  if (!response.body) throw new Error("x402 response body is empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error(`x402 response exceeds ${maximumBytes} bytes.`);
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

const MAX_AUTHORIZATION_WINDOW_SECONDS = 600;

export function buildEip3009TypedData(args: {
  from: Address;
  quote: X402Quote;
  nonce: Hex;
  nowSeconds: number;
  maximumValidBeforeSeconds?: number;
}): { authorization: Eip3009Authorization; typedData: X402TypedData } {
  if (!/^0x[0-9a-fA-F]{64}$/.test(args.nonce)) {
    throw new Error("EIP-3009 nonce must be a random 32-byte hex value.");
  }
  if (!Number.isSafeInteger(args.nowSeconds) || args.nowSeconds < 0) {
    throw new Error("nowSeconds must be a non-negative integer.");
  }
  if (
    args.maximumValidBeforeSeconds !== undefined &&
    (!Number.isSafeInteger(args.maximumValidBeforeSeconds) ||
      args.maximumValidBeforeSeconds <= args.nowSeconds)
  ) {
    throw new Error("The payment allowance has expired; no authorization was signed.");
  }
  if (!isEvmPaymentRequirements(args.quote.accepted)) {
    throw new Error("EIP-3009 typed data can only be built for an EVM x402 quote.");
  }
  const accepted = args.quote.accepted;
  const windowSeconds = Math.min(MAX_AUTHORIZATION_WINDOW_SECONDS, accepted.maxTimeoutSeconds);
  const validBefore = Math.min(
    args.nowSeconds + windowSeconds,
    args.maximumValidBeforeSeconds ?? Number.MAX_SAFE_INTEGER,
  );
  const authorization: Eip3009Authorization = {
    from: getAddress(args.from),
    to: accepted.payTo,
    value: args.quote.amountAtomic.toString(),
    validAfter: "0",
    validBefore: validBefore.toString(),
    nonce: args.nonce,
  };
  return {
    authorization,
    typedData: {
      domain: {
        name: accepted.extra.name,
        version: accepted.extra.version,
        chainId: parseEip155ChainId(accepted.network),
        verifyingContract: accepted.asset,
      },
      types: EIP3009_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: 0n,
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
    },
  };
}

export async function buildX402Payment(args: {
  signer: X402Signer;
  quote: X402Quote;
  nowSeconds?: number;
  maximumValidBeforeSeconds?: number;
  nonce?: Hex;
  fetchImpl?: typeof fetch;
  paymentId?: string;
  beforeSign?: (evidence: X402SigningEvidence) => Promise<void>;
}): Promise<{
  payload: X402PaymentPayload;
  headers: X402PaymentHeaders;
  paymentId?: string;
}> {
  const advertisesPaymentIdentifier = isRecord(args.quote.extensions?.["payment-identifier"]);
  const paymentId = advertisesPaymentIdentifier ? (args.paymentId ?? createPaymentId()) : undefined;
  const extensions = buildPaymentExtensions(args.quote.extensions, { paymentId });
  if (isSvmPaymentRequirements(args.quote.accepted)) {
    if (!args.signer.solana) {
      throw new X402Error(
        "unsupported_challenge",
        "Solana is not enabled in this keystore. Run vapi accounts --enable solana first.",
      );
    }
    if (!args.quote.rpcUrl) {
      throw new X402Error(
        "unsupported_challenge",
        `Solana RPC is not configured for ${args.quote.accepted.network}.`,
      );
    }
    const helperRequirements =
      args.quote.accepted.network === SOLANA_MAINNET_CAIP2
        ? { ...args.quote.accepted, network: X402_SOLANA_MAINNET_CAIP2 }
        : args.quote.accepted;
    await args.beforeSign?.({
      network: args.quote.accepted.network,
      token: args.quote.accepted.asset,
      amountAtomic: args.quote.amountAtomic.toString(),
    });
    const created = await withGuardedSvmFetch(
      args.fetchImpl ?? createPublicFetch({ allowPrivateNetwork: false }),
      async () => {
        const helper = new ExactSvmScheme(args.signer.solana!, { rpcUrl: args.quote.rpcUrl });
        return await helper.createPaymentPayload(
          2,
          helperRequirements as Parameters<ExactSvmScheme["createPaymentPayload"]>[1],
        );
      },
    );
    const payload: X402PaymentPayload = {
      x402Version: 2,
      resource: args.quote.resource,
      accepted: args.quote.accepted,
      payload: created.payload as { transaction: string },
      extensions,
    };
    return {
      payload,
      headers: { "PAYMENT-SIGNATURE": encodeBase64Json(payload) },
      ...(paymentId ? { paymentId } : {}),
    };
  }
  const nonce = args.nonce ?? randomNonce();
  const { authorization, typedData } = buildEip3009TypedData({
    from: args.signer.address,
    quote: args.quote,
    nonce,
    nowSeconds: args.nowSeconds ?? Math.floor(Date.now() / 1_000),
    ...(args.maximumValidBeforeSeconds === undefined
      ? {}
      : { maximumValidBeforeSeconds: args.maximumValidBeforeSeconds }),
  });
  await args.beforeSign?.({
    network: args.quote.accepted.network,
    token: args.quote.accepted.asset,
    amountAtomic: args.quote.amountAtomic.toString(),
    authorization,
  });
  const signature = await args.signer.signTypedData(typedData);
  const payload: X402PaymentPayload = {
    x402Version: 2,
    resource: args.quote.resource,
    accepted: args.quote.accepted,
    payload: { signature, authorization },
    extensions,
  };
  return {
    payload,
    headers: {
      "PAYMENT-SIGNATURE": encodeBase64Json(payload),
    },
    ...(paymentId ? { paymentId } : {}),
  };
}

/** Adds the older X-PAYMENT header while keeping PAYMENT-SIGNATURE canonical. */
export async function buildCompatibleX402Payment(args: {
  account: X402Signer;
  quote: X402Quote;
  nowSeconds?: number;
  maximumValidBeforeSeconds?: number;
  nonce?: Hex;
  fetchImpl?: typeof fetch;
  paymentId?: string;
  beforeSign?: (evidence: X402SigningEvidence) => Promise<void>;
}): Promise<{
  payload: X402PaymentPayload;
  headers: X402CompatiblePaymentHeaders;
  paymentId?: string;
}> {
  const payment = await buildX402Payment({
    signer: args.account,
    quote: args.quote,
    ...(args.nowSeconds === undefined ? {} : { nowSeconds: args.nowSeconds }),
    ...(args.maximumValidBeforeSeconds === undefined
      ? {}
      : { maximumValidBeforeSeconds: args.maximumValidBeforeSeconds }),
    ...(args.nonce === undefined ? {} : { nonce: args.nonce }),
    ...(args.beforeSign === undefined ? {} : { beforeSign: args.beforeSign }),
    ...(args.fetchImpl === undefined ? {} : { fetchImpl: args.fetchImpl }),
    ...(args.paymentId === undefined ? {} : { paymentId: args.paymentId }),
  });
  return {
    payload: payment.payload,
    headers: {
      ...payment.headers,
      "X-PAYMENT": JSON.stringify({
        x402Version: 2,
        scheme: args.quote.accepted.scheme,
        network: args.quote.accepted.network,
        payload: payment.payload.payload,
        extensions: payment.payload.extensions,
      }),
    },
    ...(payment.paymentId ? { paymentId: payment.paymentId } : {}),
  };
}

export function assertMaxPrice(amountAtomic: bigint, maxPriceUsd: number | string | undefined) {
  if (maxPriceUsd === undefined) return;
  const maxAtomic = usdToAtomic(maxPriceUsd);
  if (amountAtomic > maxAtomic) {
    throw new X402Error(
      "max_price_exceeded",
      `x402 quote ${amountAtomic} atomic USDC exceeds maxPriceUsd ${maxPriceUsd} (${maxAtomic} atomic). Refusing to sign.`,
    );
  }
}

export function usdToAtomic(value: number | string): bigint {
  const normalized = typeof value === "number" ? String(value) : value.trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(normalized)) {
    throw new Error("maxPriceUsd must be a non-negative USD amount with at most 6 decimals.");
  }
  const [whole = "0", fraction = ""] = normalized.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

export function parseSettlementResponse(headers: Headers): unknown | null {
  const encoded = headers.get("payment-response");
  if (encoded) {
    try {
      return decodeBase64Json(encoded);
    } catch {
      return null;
    }
  }
  const compatible = headers.get("x-payment-response");
  if (!compatible) return null;
  try {
    return JSON.parse(compatible) as unknown;
  } catch {
    try {
      return decodeBase64Json(compatible);
    } catch {
      return null;
    }
  }
}

export function classifySettlement(value: unknown): X402SettlementOutcome {
  if (!isRecord(value) || typeof value.success !== "boolean") {
    return "unknown";
  }
  return value.success ? "succeeded" : "rejected";
}

export function isSvmPaymentRequirements(
  requirements: X402PaymentRequirements,
): requirements is SvmX402PaymentRequirements {
  return requirements.network.startsWith("solana:");
}

export function isEvmPaymentRequirements(
  requirements: X402PaymentRequirements,
): requirements is EvmX402PaymentRequirements {
  return requirements.network.startsWith("eip155:");
}

function isSupportedSolanaNetwork(network: string): boolean {
  return network === SOLANA_MAINNET_CAIP2 || network === X402_SOLANA_MAINNET_CAIP2;
}

function configuredX402Network(
  configuredNetworks: X402NetworkConfig,
  network: string,
): X402NetworkConfig[string] | undefined {
  const direct = configuredNetworks[network];
  if (direct) return direct;
  if (network === SOLANA_MAINNET_CAIP2) {
    return configuredNetworks[X402_SOLANA_MAINNET_CAIP2];
  }
  if (network === X402_SOLANA_MAINNET_CAIP2) {
    return configuredNetworks[SOLANA_MAINNET_CAIP2];
  }
  return undefined;
}

let svmFetchQueue = Promise.resolve();

/** @x402/svm 2.25 accepts an RPC URL but not a fetch transport. */
async function withGuardedSvmFetch<T>(fetchImpl: typeof fetch, operation: () => Promise<T>) {
  const previous = svmFetchQueue;
  let release!: () => void;
  svmFetchQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await operation();
  } finally {
    globalThis.fetch = originalFetch;
    release();
  }
}

function parseEip155ChainId(network: string): number {
  const match = /^eip155:(\d+)$/.exec(network);
  const chainId = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error(`Invalid EIP-155 network identifier: ${network}.`);
  }
  return chainId;
}

function randomNonce(): Hex {
  const bytes = new Uint8Array(32);
  fillRandomBytes(bytes);
  return bytesToHex(bytes);
}

function fillRandomBytes(bytes: Uint8Array<ArrayBuffer>): void {
  globalThis.crypto.getRandomValues(bytes);
}

function readAmount(value: Record<string, unknown>): bigint | null {
  const raw = value.amount ?? value.maxAmountRequired;
  let parsed: bigint;
  if (typeof raw === "string") {
    if (raw.length === 0 || raw.length > 78 || !/^\d+$/.test(raw)) return null;
    parsed = BigInt(raw);
  } else if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) {
    parsed = BigInt(raw);
  } else if (typeof raw === "bigint" && raw > 0n) {
    parsed = raw;
  } else {
    return null;
  }
  if (parsed === 0n || parsed > MAX_UINT256) return null;
  return parsed;
}

function readPositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function canonicalTokenDomain(
  network: string,
  configured: X402NetworkConfig[string],
): Readonly<{ name: string; version: string }> | null {
  const canonical = getCanonicalX402Usdc(network);
  try {
    if (canonical) {
      return getAddress(configured.usdc) === canonical.usdc ? canonical.eip712Domain : null;
    }
  } catch {
    return null;
  }
  const configuredDomain = configured.eip712Domain;
  if (!configuredDomain?.name || !configuredDomain.version) return null;
  return configuredDomain;
}

function readBoundedJsonRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const seen = new WeakSet<object>();
  const budget = { entries: 0 };

  try {
    const cloned = cloneBoundedJson(value, 0, seen, budget);
    return isRecord(cloned) ? cloned : null;
  } catch {
    return null;
  }
}

function readChallengeExtensions(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const extensions = readBoundedJsonRecord(value);
  if (extensions) return extensions;
  if (!isRecord(value)) return undefined;

  const paymentExtensions: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const name of ["builder-code", "payment-identifier"] as const) {
    const extension = readBoundedJsonRecord(value[name]);
    if (extension) paymentExtensions[name] = extension;
  }
  return Object.keys(paymentExtensions).length === 0 ? undefined : paymentExtensions;
}

function cloneBoundedJson(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  budget: { entries: number },
): unknown {
  if (depth > MAX_METADATA_DEPTH || budget.entries >= MAX_METADATA_ENTRIES) {
    throw new Error("x402 metadata exceeds its structural limit.");
  }
  budget.entries += 1;

  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > MAX_METADATA_STRING_LENGTH) {
      throw new Error("x402 metadata string is too long.");
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("x402 metadata number must be finite.");
    return value;
  }
  if (typeof value !== "object") {
    throw new Error("x402 metadata must be JSON-compatible.");
  }
  if (seen.has(value)) throw new Error("x402 metadata must not contain cycles.");
  seen.add(value);

  if (Array.isArray(value)) {
    if (value.length > MAX_METADATA_ARRAY_LENGTH) {
      throw new Error("x402 metadata array is too long.");
    }
    return value.map((item) => cloneBoundedJson(item, depth + 1, seen, budget));
  }

  const keys = Object.keys(value);
  if (keys.length > MAX_METADATA_KEYS_PER_OBJECT) {
    throw new Error("x402 metadata object has too many keys.");
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (key.length > 256) throw new Error("x402 metadata key is too long.");
    result[key] = cloneBoundedJson(
      (value as Record<string, unknown>)[key],
      depth + 1,
      seen,
      budget,
    );
  }
  return result;
}

function readResource(value: unknown, fallbackUrl: string): X402Resource {
  if (typeof value === "string") return { url: value };
  if (!isRecord(value)) return { url: fallbackUrl };
  const url = readString(value, "url") ?? fallbackUrl;
  return {
    url,
    ...(readString(value, "description") ? { description: readString(value, "description")! } : {}),
    ...(readString(value, "mimeType") ? { mimeType: readString(value, "mimeType")! } : {}),
    ...(readString(value, "serviceName") ? { serviceName: readString(value, "serviceName")! } : {}),
    ...(Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === "string")
      ? { tags: value.tags as string[] }
      : {}),
    ...(readString(value, "iconUrl") ? { iconUrl: readString(value, "iconUrl")! } : {}),
  };
}

function readString(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBase64Json(value: string): unknown {
  const bytes = Uint8Array.from(globalThis.atob(value), (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function encodeBase64Json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return globalThis.btoa(binary);
}
