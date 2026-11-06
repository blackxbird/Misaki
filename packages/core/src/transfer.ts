import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import { bytesToHex, getAddress, isAddress, type Address, type Hex } from "viem";
import { z } from "zod";

import { AgentLinkError, agentFetch, withAgentCredentialLock } from "./agent-link.js";
import { withSwarmAccountLocks } from "./swarm-lock-context.js";
import { listSwarms, swarmAccountNames } from "./swarm.js";
import { hasSwarmDissolveIntent } from "./swarm-dissolution.js";
import { assertSwarmWorkersStopped } from "./swarm-workers.js";
import { getVapiPaths } from "./config.js";
import { explorerTransactionUrl } from "./networks.js";
import { appendReceipt, readReceipts, type Receipt } from "./receipts.js";
import type { SecretStore } from "./secret-store.js";
import { fetchSiblings, SiblingsError, type Sibling } from "./siblings.js";
import { releaseSpend, reserveSpend, SpendCapError } from "./spend-policy.js";
import { spendCapsForWallet, type WalletName, type WalletStore } from "./wallet-store.js";
import {
  buildEip3009TypedData,
  type Eip3009Authorization,
  type X402Quote,
  type X402TypedData,
} from "./x402.js";
import {
  ARC_MAINNET_CAIP2,
  BASE_MAINNET_CAIP2,
  getCanonicalX402Usdc,
  type CanonicalX402UsdcIdentity,
} from "./x402-networks.js";

export type TransferPurpose = "send" | "sweep";
export type TransferNetwork = typeof BASE_MAINNET_CAIP2 | typeof ARC_MAINNET_CAIP2;
export type TransferSigner = {
  address: `0x${string}`;
  signTypedData: (typedData: X402TypedData) => Promise<`0x${string}`>;
};
export type TransferArgs = {
  store: WalletStore;
  secrets: SecretStore;
  apiBase: string;
  from: WalletName;
  to: string;
  amountUsd: string | number;
  network?: "base" | "arc" | TransferNetwork;
  purpose?: TransferPurpose;
  sweepParent?: `0x${string}`;
  expectedFromAddress?: string;
  expectedToAddress?: string;
  unlock?: (account: WalletName) => Promise<TransferSigner>;
  resume?: `0x${string}`;
  fetchImpl?: typeof fetch;
  now?: () => number;
  nonce?: `0x${string}`;
  timeoutMs?: number;
  /** Cancels discovery/signing/relay work owned by a bounded best-effort caller. */
  signal?: AbortSignal;
  ledgerPath?: string;
  home?: string;
  /** Reconcile worker records before the shared executor checks dissolution eligibility. */
  reconcileRuns?: (input: { home: string; name: string }) => Promise<void>;
};
export type TransferResult = {
  status: "sent" | "unknown";
  from: WalletName;
  to: `0x${string}`;
  toName: string;
  toKind: "owner" | "account";
  amountUsd: string;
  amountAtomic: string;
  network: TransferNetwork;
  txHash: `0x${string}` | null;
  nonce: `0x${string}`;
  replayed: boolean;
};
export type TransferErrorCode =
  | "invalid_amount"
  | "invalid_network"
  | "not_linked"
  | "unsupported"
  | "recipient_not_allowed"
  | "ambiguous_recipient"
  | "sweep_not_owner"
  | "per_call_cap_exceeded"
  | "per_day_cap_exceeded"
  | "payer_mismatch"
  | "payee_not_allowed"
  | "authorization_invalid"
  | "relay_limit"
  | "relay_failed"
  | "temporarily_unavailable"
  | "network_error"
  | "resume_not_found"
  | "resume_mismatch"
  | "signer_mismatch"
  | "account_address_mismatch"
  | "signing_failed";

export class TransferError extends Error {
  readonly moneyMoved = false as const;
  readonly reservationReleased: boolean;
  readonly resetsAt?: string;
  readonly addresses?: string[];

  constructor(
    readonly code: TransferErrorCode,
    message: string,
    options: { reservationReleased?: boolean; resetsAt?: string; addresses?: string[] } = {},
  ) {
    super(message);
    this.name = "TransferError";
    this.reservationReleased = options.reservationReleased ?? false;
    if (options.resetsAt !== undefined) this.resetsAt = options.resetsAt;
    if (options.addresses !== undefined) this.addresses = [...options.addresses];
  }
}

type ResolvedRecipient = {
  address: Address;
  toName: string;
  toKind: "owner" | "account";
};

type TransferContext = {
  args: TransferArgs;
  fromAddress: Address;
  recipient: ResolvedRecipient;
  amountUsd: string;
  amountAtomic: bigint;
  network: TransferNetwork;
  identity: CanonicalX402UsdcIdentity;
  relayUrl: string;
  ledgerPath: string;
  receiptsPath: string;
  now: () => number;
};

type RelayRequest = {
  network: TransferNetwork;
  authorization: Eip3009Authorization;
  signature: Hex;
};

type RelayErrorCode =
  | "payer_mismatch"
  | "payee_not_allowed"
  | "in_progress"
  | "authorization_used"
  | "authorization_invalid"
  | "relay_limit"
  | "relay_failed"
  | "temporarily_unavailable"
  | "unsupported";

const NONCE_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const DEFAULT_TIMEOUT_MS = 30_000;

const relayAddressSchema = z
  .string()
  .refine((value) => isAddress(value, { strict: false }))
  .transform((value) => getAddress(value));

const relayResponseSchema = z.object({
  txHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/)
    .nullable(),
  network: z.enum([BASE_MAINNET_CAIP2, ARC_MAINNET_CAIP2]),
  from: relayAddressSchema,
  to: relayAddressSchema,
  value: z.string().regex(/^\d+$/),
  replayed: z.boolean(),
});

export function parseTransferAmount(value: string | number): {
  amountUsd: string;
  amountAtomic: bigint;
} {
  const raw = String(value);
  if (!/^\d+(?:\.\d{1,6})?$/.test(raw)) {
    throw transferError("invalid_amount");
  }
  const [whole = "0", fraction = ""] = raw.split(".");
  const amountAtomic = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0") || "0");
  if (amountAtomic <= 0n) throw transferError("invalid_amount");
  return { amountUsd: formatTransferAmount(amountAtomic), amountAtomic };
}

/** One guarded boundary for signatures and rebroadcasts, including injected transports. */
export async function executeTransfer(
  args: TransferArgs,
  transport?: (args: TransferArgs) => Promise<TransferResult>,
): Promise<TransferResult> {
  args.signal?.throwIfAborted();
  const home = args.home ?? args.store.home;
  return await withSwarmAccountLocks(home, [args.from], async () => {
    for (const swarm of await listSwarms(home)) {
      if (
        !swarmAccountNames(swarm).includes(args.from) ||
        !(await hasSwarmDissolveIntent(home, swarm.name))
      )
        continue;
      await args.reconcileRuns?.({ home, name: swarm.name });
      await assertSwarmWorkersStopped(home, swarm);
    }
    args.signal?.throwIfAborted();
    return await (
      transport === undefined || transport === transferBetweenAccounts ? performTransfer : transport
    )(args);
  });
}

export async function transferBetweenAccounts(args: TransferArgs): Promise<TransferResult> {
  return await executeTransfer(args);
}

async function performTransfer(args: TransferArgs): Promise<TransferResult> {
  args.signal?.throwIfAborted();
  const { amountUsd, amountAtomic } = parseTransferAmount(args.amountUsd);
  const { network, identity } = resolveNetwork(args.network);
  const now = args.now ?? Date.now;

  await args.store.reload();
  const fromEntry = args.store.entry(args.from);
  const apiOrigin = safeOrigin(args.apiBase);
  const linkOrigin = safeOrigin(fromEntry?.link?.apiBase);
  if (fromEntry?.link === undefined || apiOrigin === undefined || linkOrigin !== apiOrigin) {
    throw transferError("not_linked");
  }
  const rawFromAddress = await args.store.readAddress(args.from);
  if (rawFromAddress === undefined || !isAddress(rawFromAddress, { strict: false })) {
    throw transferError("not_linked");
  }
  const fromAddress = getAddress(rawFromAddress);
  if (
    args.expectedFromAddress !== undefined &&
    (!isAddress(args.expectedFromAddress, { strict: false }) ||
      !sameAddress(fromAddress, args.expectedFromAddress))
  ) {
    throw transferError("account_address_mismatch");
  }

  let siblingResult: Awaited<ReturnType<typeof fetchSiblings>>;
  try {
    siblingResult = await fetchSiblings({
      apiBase: args.apiBase,
      account: args.from,
      secrets: args.secrets,
      wallets: args.store,
      ...(args.fetchImpl === undefined ? {} : { fetchImpl: args.fetchImpl }),
      now,
      ...(args.signal === undefined ? {} : { signal: args.signal }),
      timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof SiblingsError) {
      if (error.code === "not_linked") throw transferError("not_linked");
      if (error.code === "unsupported") {
        throw new TransferError(
          "unsupported",
          "This vAPI server does not list sibling accounts yet. No money moved.",
        );
      }
    }
    throw transferError("network_error");
  }

  const recipient = await resolveRecipient({
    store: args.store,
    fromAddress,
    requested: args.to,
    owner: siblingResult.owner,
    siblings: siblingResult.siblings,
  });
  if (
    args.expectedToAddress !== undefined &&
    (!isAddress(args.expectedToAddress, { strict: false }) ||
      !sameAddress(recipient.address, args.expectedToAddress))
  ) {
    throw transferError("account_address_mismatch");
  }
  const purpose = args.purpose ?? "send";
  const isSweepTarget =
    recipient.toKind === "owner" ||
    (recipient.toKind === "account" &&
      args.sweepParent !== undefined &&
      isAddress(args.sweepParent, { strict: false }) &&
      getAddress(args.sweepParent) === getAddress(recipient.address));
  if (purpose === "sweep" && !isSweepTarget) {
    throw transferError("sweep_not_owner");
  }

  const home = args.home ?? args.store.home;
  const paths = getVapiPaths(home);
  const context: TransferContext = {
    args,
    fromAddress,
    recipient,
    amountUsd,
    amountAtomic,
    network,
    identity,
    relayUrl: new URL("/api/agents/relay-transfer", linkOrigin).toString(),
    ledgerPath: args.ledgerPath ?? paths.ledger,
    receiptsPath: paths.receipts,
    now,
  };

  if (args.resume !== undefined) {
    return await resumeTransfer(context, args.resume);
  }

  const nonce = args.nonce ?? bytesToHex(randomBytes(32));
  if (!NONCE_PATTERN.test(nonce)) {
    throw new TransferError(
      "authorization_invalid",
      "The transfer nonce is invalid. No money moved.",
    );
  }

  let reservedOn: string | undefined;
  if (purpose === "send") {
    try {
      const reservation = await reserveSpend(
        amountAtomic,
        await spendCapsForWallet(args.store, args.from),
        {
          ledgerPath: context.ledgerPath,
          now: new Date(now()),
          wallet: args.from,
          reservationId: nonce.toLowerCase(),
        },
      );
      reservedOn = reservation.date;
    } catch (error) {
      if (error instanceof SpendCapError && isTransferErrorCode(error.code)) {
        throw transferError(error.code);
      }
      throw transferError("network_error");
    }
  }

  let request: RelayRequest;
  try {
    args.signal?.throwIfAborted();
    const signer = await (args.unlock ?? (async (account) => await args.store.unlock(account, "")))(
      args.from,
    );
    args.signal?.throwIfAborted();
    if (!sameAddress(signer.address, fromAddress)) {
      throw transferError("signer_mismatch");
    }
    const quote = transferQuote(context);
    const { authorization, typedData } = buildEip3009TypedData({
      from: fromAddress,
      quote,
      nonce,
      nowSeconds: Math.floor(now() / 1_000),
    });
    const signature = await signer.signTypedData(typedData);
    args.signal?.throwIfAborted();
    request = {
      network,
      authorization,
      signature,
    };
  } catch (error) {
    const reservationReleased = await releaseReservation(context, reservedOn, nonce);
    if (error instanceof TransferError) {
      throw new TransferError(error.code, error.message, { reservationReleased });
    }
    throw new TransferError(
      "signing_failed",
      "The transfer authorization could not be signed. No money moved.",
      { reservationReleased },
    );
  }

  const receiptId = randomUUID();
  let authorizationPersisted = false;
  try {
    args.signal?.throwIfAborted();
    return await withTransferLock(context, nonce, async () => {
      const existing = await findTransferReceipt(context, nonce);
      if (existing !== undefined && existing.transfer?.status !== "failed") {
        throw transferError("authorization_invalid");
      }
      await appendTransferReceipt(context, request, {
        receiptId,
        status: "unknown",
        txHash: null,
        replayed: false,
        reservedOn,
      });
      authorizationPersisted = true;
      args.signal?.throwIfAborted();
      return await postRelay(context, request, { receiptId, reservedOn, resumed: false });
    });
  } catch (error) {
    if (authorizationPersisted) throw error;
    const reservationReleased = await releaseReservation(context, reservedOn, nonce);
    if (error instanceof TransferError) {
      throw new TransferError(error.code, error.message, {
        reservationReleased,
        ...(error.resetsAt === undefined ? {} : { resetsAt: error.resetsAt }),
        ...(error.addresses === undefined ? {} : { addresses: error.addresses }),
      });
    }
    throw new TransferError(
      "network_error",
      "The transfer authorization could not be saved before relay. No money moved.",
      { reservationReleased },
    );
  }
}

async function resolveRecipient(args: {
  store: WalletStore;
  fromAddress: Address;
  requested: string;
  owner: Address | null;
  siblings: readonly Sibling[];
}): Promise<ResolvedRecipient> {
  const requested = args.requested.trim();
  const owner = args.owner === null ? null : getAddress(args.owner);
  const siblings = args.siblings.filter((sibling) => !sibling.self);

  if (requested === "owner") {
    if (owner === null || sameAddress(owner, args.fromAddress)) {
      throw transferError("recipient_not_allowed");
    }
    return { address: owner, toName: "owner", toKind: "owner" };
  }

  if (isAddress(requested, { strict: false })) {
    const address = getAddress(requested);
    if (sameAddress(address, args.fromAddress)) throw transferError("recipient_not_allowed");
    if (owner !== null && sameAddress(address, owner)) {
      return { address: owner, toName: "owner", toKind: "owner" };
    }
    const sibling = siblings.find((candidate) => sameAddress(candidate.address, address));
    if (sibling === undefined || sibling.status !== "active") {
      throw transferError("recipient_not_allowed");
    }
    return { address, toName: sibling.name, toKind: "account" };
  }

  const matches = siblings.filter((sibling) => sibling.name === requested);
  if (matches.length > 1) {
    const addresses = matches.map((sibling) => sibling.address);
    throw new TransferError(
      "ambiguous_recipient",
      `More than one sibling is named ${requested}: ${addresses.join(", ")}. No money moved.`,
      { addresses },
    );
  }

  if (args.store.has(requested)) {
    const localAddress = await args.store.readAddress(requested);
    if (
      localAddress === undefined ||
      !isAddress(localAddress, { strict: false }) ||
      sameAddress(localAddress, args.fromAddress)
    ) {
      throw transferError("recipient_not_allowed");
    }
    const address = getAddress(localAddress);
    if (owner !== null && sameAddress(address, owner)) {
      return { address: owner, toName: requested, toKind: "owner" };
    }
    const sibling = siblings.find((candidate) => sameAddress(candidate.address, address));
    if (sibling === undefined || sibling.status !== "active") {
      throw transferError("recipient_not_allowed");
    }
    return { address, toName: requested, toKind: "account" };
  }

  if (matches.length === 0) throw transferError("recipient_not_allowed");
  const [sibling] = matches;
  if (sibling === undefined || sibling.status !== "active") {
    throw transferError("recipient_not_allowed");
  }
  return { address: sibling.address, toName: sibling.name, toKind: "account" };
}

async function resumeTransfer(
  context: TransferContext,
  nonce: `0x${string}`,
): Promise<TransferResult> {
  if (!NONCE_PATTERN.test(nonce)) throw transferError("resume_not_found");
  return await withTransferLock(context, nonce, async () => {
    return await resumeTransferLocked(context, nonce);
  });
}

async function resumeTransferLocked(
  context: TransferContext,
  nonce: `0x${string}`,
): Promise<TransferResult> {
  const receipts = await readReceipts(context.receiptsPath, { wallet: context.args.from });
  const receipt = [...receipts]
    .reverse()
    .find((candidate) => candidate.transfer?.nonce.toLowerCase() === nonce.toLowerCase());
  const transfer = receipt?.transfer;
  if (receipt === undefined || transfer === undefined) throw transferError("resume_not_found");
  if (
    !sameAddress(transfer.to, context.recipient.address) ||
    transfer.amountAtomic !== context.amountAtomic.toString() ||
    transfer.network !== context.network
  ) {
    throw transferError("resume_mismatch");
  }

  const resumedContext: TransferContext = {
    ...context,
    recipient: {
      address: context.recipient.address,
      toName: transfer.toName,
      toKind: transfer.toKind,
    },
  };
  if (transfer.status === "sent") {
    return transferResult(resumedContext, {
      status: "sent",
      txHash: transfer.txHash as Hex | null,
      nonce: transfer.nonce as Hex,
      replayed: transfer.replayed,
    });
  }
  if (transfer.status === "failed") {
    const reservationReleased = await releaseReservation(
      context,
      transfer.reservedOn,
      transfer.nonce as Hex,
    );
    const code = isTransferErrorCode(receipt.error?.code) ? receipt.error.code : "resume_not_found";
    const error = transferError(code, { reservationReleased });
    throw error;
  }
  if (transfer.status !== "unknown" || transfer.request === undefined) {
    throw transferError("resume_not_found");
  }
  const request: RelayRequest = {
    network: context.network,
    authorization: {
      from: getAddress(transfer.request.authorization.from),
      to: getAddress(transfer.request.authorization.to),
      value: transfer.request.authorization.value,
      validAfter: "0",
      validBefore: transfer.request.authorization.validBefore,
      nonce: transfer.request.authorization.nonce as Hex,
    },
    signature: transfer.request.signature as Hex,
  };
  if (
    transfer.request.authorization.validAfter !== "0" ||
    !sameAddress(request.authorization.from, context.fromAddress) ||
    !sameAddress(request.authorization.to, context.recipient.address) ||
    request.authorization.value !== context.amountAtomic.toString() ||
    request.authorization.nonce.toLowerCase() !== nonce.toLowerCase()
  ) {
    throw transferError("resume_mismatch");
  }
  return await postRelay(resumedContext, request, {
    receiptId: receipt.id,
    reservedOn: transfer.reservedOn,
    resumed: true,
  });
}

async function postRelay(
  context: TransferContext,
  request: RelayRequest,
  options: { receiptId: string; reservedOn?: string; resumed: boolean },
): Promise<TransferResult> {
  const timeout = AbortSignal.timeout(context.args.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const deadline =
    context.args.signal === undefined ? timeout : AbortSignal.any([timeout, context.args.signal]);
  let response: Response;
  try {
    response = await withAgentCredentialLock(
      context.args.store,
      `wallet:${context.args.from}`,
      async () => {
        await context.args.store.reload();
        const link = context.args.store.entry(context.args.from)?.link;
        if (link === undefined || safeOrigin(link.apiBase) !== safeOrigin(context.args.apiBase)) {
          throw transferError("not_linked");
        }
        return await agentFetch(
          {
            secrets: context.args.secrets,
            wallets: context.args.store,
            wallet: context.args.from,
            ...(context.args.fetchImpl === undefined ? {} : { fetchImpl: context.args.fetchImpl }),
            now: context.now,
          },
          context.relayUrl,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
            signal: deadline,
          },
        );
      },
    );
  } catch (error) {
    if (deadline.aborted) {
      return await recordUnknown(context, request, options.receiptId, options.reservedOn);
    }
    const code: TransferErrorCode =
      error instanceof TransferError && error.code === "not_linked"
        ? "not_linked"
        : error instanceof AgentLinkError && error.code === "not_linked"
          ? "not_linked"
          : "network_error";
    // Once the request may have left the process, the relay may have submitted
    // the authorization: keep the reservation and hand back the nonce.
    if (code === "network_error" || options.resumed) {
      return await recordUnknown(context, request, options.receiptId, options.reservedOn);
    }
    return await failTransfer(context, request, options.receiptId, options.reservedOn, code);
  }

  if (response.status === 200) {
    const body = relayResponseSchema.safeParse(await readResponseJson(response));
    if (
      !body.success ||
      body.data.network !== request.network ||
      !sameAddress(body.data.from, request.authorization.from) ||
      !sameAddress(body.data.to, request.authorization.to) ||
      body.data.value !== request.authorization.value
    ) {
      return await recordUnknown(
        context,
        request,
        options.receiptId,
        options.reservedOn,
        response.status,
      );
    }
    const txHash = body.data.txHash as Hex | null;
    await appendTransferReceipt(context, request, {
      receiptId: options.resumed ? randomUUID() : options.receiptId,
      status: "sent",
      txHash,
      replayed: body.data.replayed,
      httpStatus: response.status,
    });
    return transferResult(context, {
      status: "sent",
      txHash,
      nonce: request.authorization.nonce,
      replayed: body.data.replayed,
    });
  }

  const payload = await readResponseJson(response);
  const code = relayErrorCode(response.status, payload);
  if (code === "in_progress" || (code === "authorization_used" && !options.resumed)) {
    return await recordUnknown(
      context,
      request,
      options.receiptId,
      options.reservedOn,
      response.status,
    );
  }
  if (code === "authorization_used" && options.resumed) {
    await appendTransferReceipt(context, request, {
      receiptId: randomUUID(),
      status: "sent",
      txHash: null,
      replayed: true,
      httpStatus: response.status,
    });
    return transferResult(context, {
      status: "sent",
      txHash: null,
      nonce: request.authorization.nonce,
      replayed: true,
    });
  }
  if (
    code === "payer_mismatch" ||
    code === "payee_not_allowed" ||
    code === "authorization_invalid" ||
    code === "relay_limit" ||
    code === "relay_failed" ||
    code === "unsupported"
  ) {
    const resetsAt = code === "relay_limit" ? responseString(payload, "resetsAt") : undefined;
    return await failTransfer(
      context,
      request,
      options.resumed ? randomUUID() : options.receiptId,
      options.reservedOn,
      code,
      response.status,
      resetsAt,
    );
  }
  return await recordUnknown(
    context,
    request,
    options.receiptId,
    options.reservedOn,
    response.status,
  );
}

async function recordUnknown(
  context: TransferContext,
  request: RelayRequest,
  receiptId: string,
  reservedOn?: string,
  httpStatus?: number,
): Promise<TransferResult> {
  await appendTransferReceipt(context, request, {
    receiptId,
    status: "unknown",
    txHash: null,
    replayed: false,
    reservedOn,
    httpStatus,
  });
  return transferResult(context, {
    status: "unknown",
    txHash: null,
    nonce: request.authorization.nonce,
    replayed: false,
  });
}

async function failTransfer(
  context: TransferContext,
  request: RelayRequest,
  receiptId: string,
  reservedOn: string | undefined,
  code: TransferErrorCode,
  httpStatus?: number,
  resetsAt?: string,
): Promise<never> {
  const reservationReleased = await releaseReservation(
    context,
    reservedOn,
    request.authorization.nonce,
  );
  const error = transferError(code, { reservationReleased, resetsAt });
  await appendTransferReceipt(context, request, {
    receiptId,
    status: "failed",
    txHash: null,
    replayed: false,
    reservedOn,
    httpStatus,
    error,
  }).catch(() => undefined);
  throw error;
}

async function releaseReservation(
  context: TransferContext,
  reservedOn: string | undefined,
  reservationId: string,
): Promise<boolean> {
  if (reservedOn === undefined) return false;
  try {
    await releaseSpend(context.amountAtomic, {
      reservedOn,
      ledgerPath: context.ledgerPath,
      now: new Date(context.now()),
      wallet: context.args.from,
      reservationId: reservationId.toLowerCase(),
    });
    return true;
  } catch {
    return false;
  }
}

async function findTransferReceipt(
  context: TransferContext,
  nonce: string,
): Promise<Receipt | undefined> {
  const receipts = await readReceipts(context.receiptsPath, { wallet: context.args.from });
  return [...receipts]
    .reverse()
    .find((candidate) => candidate.transfer?.nonce.toLowerCase() === nonce.toLowerCase());
}

async function withTransferLock<T>(
  context: TransferContext,
  nonce: string,
  operation: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(context.receiptsPath), { recursive: true, mode: 0o700 });
  const lockPath = `${context.receiptsPath}.${context.args.from}.${nonce.toLowerCase()}.transfer.lock`;
  const requestTimeout = Math.max(0, context.args.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const deadline = Date.now() + Math.max(5_000, requestTimeout + 5_000);
  const staleAfterMs = Math.max(120_000, requestTimeout * 2 + 10_000);
  let handle: FileHandle | undefined;

  while (!handle) {
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      await removeStaleTransferLock(lockPath, staleAfterMs);
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for the transfer lock.");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  try {
    return await operation();
  } finally {
    await handle.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

async function removeStaleTransferLock(path: string, staleAfterMs: number): Promise<void> {
  try {
    const metadata = await stat(path);
    if (Date.now() - metadata.mtimeMs > staleAfterMs) await unlink(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

async function appendTransferReceipt(
  context: TransferContext,
  request: RelayRequest,
  details: {
    receiptId: string;
    status: "sent" | "unknown" | "failed";
    txHash: Hex | null;
    replayed: boolean;
    reservedOn?: string;
    httpStatus?: number;
    error?: TransferError;
  },
): Promise<Receipt> {
  const explorerUrl =
    details.txHash === null ? undefined : explorerTransactionUrl(context.network, details.txHash);
  const settlement: NonNullable<Receipt["settlement"]> =
    details.status === "sent"
      ? {
          outcome: "succeeded",
          ...(details.txHash === null ? {} : { transaction: details.txHash }),
          ...(explorerUrl === undefined ? {} : { explorerUrl }),
        }
      : { outcome: details.status === "unknown" ? "unknown" : "rejected" };
  const receipt: Receipt = {
    id: details.receiptId,
    timestamp: new Date(context.now()).toISOString(),
    kind: "transfer",
    wallet: context.args.from,
    resourceUrl: context.relayUrl,
    method: "POST",
    quote: {
      network: context.network,
      asset: context.identity.usdc,
      amountAtomic: context.amountAtomic.toString(),
      payTo: context.recipient.address,
    },
    payer: context.fromAddress,
    transfer: {
      to: context.recipient.address,
      toName: context.recipient.toName,
      toKind: context.recipient.toKind,
      amountAtomic: context.amountAtomic.toString(),
      network: context.network,
      nonce: request.authorization.nonce,
      status: details.status,
      txHash: details.txHash,
      replayed: details.replayed,
      ...(details.reservedOn === undefined ? {} : { reservedOn: details.reservedOn }),
      ...(details.status === "unknown"
        ? {
            request: {
              authorization: { ...request.authorization },
              signature: request.signature,
            },
          }
        : {}),
    },
    settlement,
    ...(details.httpStatus === undefined ? {} : { status: details.httpStatus }),
    ...(details.error === undefined
      ? {}
      : { error: { code: details.error.code, message: details.error.message } }),
  };
  return await appendReceipt(receipt, context.receiptsPath, { wallet: context.args.from });
}

function transferResult(
  context: TransferContext,
  details: Pick<TransferResult, "status" | "txHash" | "nonce" | "replayed">,
): TransferResult {
  return {
    status: details.status,
    from: context.args.from,
    to: context.recipient.address,
    toName: context.recipient.toName,
    toKind: context.recipient.toKind,
    amountUsd: context.amountUsd,
    amountAtomic: context.amountAtomic.toString(),
    network: context.network,
    txHash: details.txHash,
    nonce: details.nonce,
    replayed: details.replayed,
  };
}

function transferQuote(context: TransferContext): X402Quote {
  return {
    x402Version: 2,
    amountAtomic: context.amountAtomic,
    resource: { url: context.relayUrl },
    accepted: {
      scheme: "exact",
      network: context.network,
      asset: context.identity.usdc,
      amount: context.amountAtomic.toString(),
      payTo: context.recipient.address,
      maxTimeoutSeconds: 600,
      extra: { ...context.identity.eip712Domain },
    },
  };
}

function resolveNetwork(value: TransferArgs["network"]): {
  network: TransferNetwork;
  identity: CanonicalX402UsdcIdentity;
} {
  const network =
    value === undefined || value === "base"
      ? BASE_MAINNET_CAIP2
      : value === "arc"
        ? ARC_MAINNET_CAIP2
        : value;
  if (network !== BASE_MAINNET_CAIP2 && network !== ARC_MAINNET_CAIP2) {
    throw transferError("invalid_network");
  }
  const identity = getCanonicalX402Usdc(network);
  if (identity === undefined) throw transferError("invalid_network");
  return { network, identity };
}

function relayErrorCode(status: number, payload: unknown): RelayErrorCode | undefined {
  const declared = responseString(payload, "error") ?? responseString(payload, "code");
  if (
    declared === "payer_mismatch" ||
    declared === "payee_not_allowed" ||
    declared === "in_progress" ||
    declared === "authorization_used" ||
    declared === "authorization_invalid" ||
    declared === "relay_limit" ||
    declared === "relay_failed" ||
    declared === "temporarily_unavailable"
  ) {
    return declared;
  }
  if (status === 403) return "payee_not_allowed";
  if (status === 409) return "in_progress";
  if (status === 422) return "authorization_invalid";
  if (status === 429) return "relay_limit";
  if (status === 502) return "relay_failed";
  if (status === 503) return "temporarily_unavailable";
  if (status === 404) return "unsupported";
  return undefined;
}

async function readResponseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function responseString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const field = Reflect.get(value, key);
  return typeof field === "string" ? field : undefined;
}

function safeOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function formatTransferAmount(amountAtomic: bigint): string {
  const whole = amountAtomic / 1_000_000n;
  let fraction = (amountAtomic % 1_000_000n).toString().padStart(6, "0");
  while (fraction.length > 2 && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  return `${whole}.${fraction}`;
}

function isTransferErrorCode(value: unknown): value is TransferErrorCode {
  return (
    typeof value === "string" &&
    [
      "invalid_amount",
      "invalid_network",
      "not_linked",
      "unsupported",
      "recipient_not_allowed",
      "ambiguous_recipient",
      "sweep_not_owner",
      "per_call_cap_exceeded",
      "per_day_cap_exceeded",
      "payer_mismatch",
      "payee_not_allowed",
      "authorization_invalid",
      "relay_limit",
      "relay_failed",
      "temporarily_unavailable",
      "network_error",
      "resume_not_found",
      "resume_mismatch",
      "signer_mismatch",
      "account_address_mismatch",
      "signing_failed",
    ].includes(value)
  );
}

function transferError(
  code: TransferErrorCode,
  options: { reservationReleased?: boolean; resetsAt?: string } = {},
): TransferError {
  const messages: Record<TransferErrorCode, string> = {
    invalid_amount:
      "Enter a positive USDC amount with no more than six decimal places. No money moved.",
    invalid_network: "Choose the Base or Arc transfer network. No money moved.",
    not_linked: "The sending account is not linked to this vAPI server. No money moved.",
    unsupported: "This vAPI server does not relay transfers yet. No money moved.",
    recipient_not_allowed:
      "The recipient is not the owner or an active sibling account. No money moved.",
    ambiguous_recipient: "The sibling account name is ambiguous. No money moved.",
    sweep_not_owner: "A sweep can only send funds to the owner or its treasury. No money moved.",
    per_call_cap_exceeded: "The amount exceeds the sending account's per-call cap. No money moved.",
    per_day_cap_exceeded:
      "The amount exceeds the sending account's remaining daily cap. No money moved.",
    payer_mismatch: "The relay rejected the sending account. No money moved.",
    payee_not_allowed: "The relay rejected the recipient. No money moved.",
    authorization_invalid: "The relay rejected the transfer authorization. No money moved.",
    relay_limit: "The relay transfer limit was reached. No money moved.",
    relay_failed: "The vAPI relay failed. No money moved.",
    temporarily_unavailable: "The vAPI relay is temporarily unavailable. No money moved.",
    network_error: "The vAPI transfer request failed. No money moved.",
    resume_not_found: "No resumable transfer was found for that nonce. No money moved.",
    resume_mismatch: "The resumed transfer does not match the original request. No money moved.",
    signer_mismatch: "The unlocked signer does not match the sending account. No money moved.",
    account_address_mismatch:
      "The sending or recipient account no longer matches the address recorded by its movement. No money moved.",
    signing_failed: "The transfer authorization could not be signed. No money moved.",
  };
  return new TransferError(code, messages[code], options);
}
