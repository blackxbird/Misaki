import { randomBytes, randomUUID } from "node:crypto";

import { scheduleCeilingSweep, type CeilingSweepHook } from "./ceiling.js";
import type { RunRef } from "./agent-run.js";
import type { SpendCaps, VapiConfig } from "./config.js";
import { getVapiPaths } from "./config.js";
import type { VapiPaymentAccount } from "./keystore.js";
import { assertPublicUrl, createPublicFetch, type LookupFn } from "./net-guard.js";
import { areSamePaymentNetwork, explorerTransactionUrl, formatUsdc } from "./networks.js";
import { appendReceipt, parseReceipt, type Receipt } from "./receipts.js";
import type { PaymentWarning } from "./payment-warning.js";
import { RunBudgetError, type RunBudget } from "./run-budget.js";
import { SpendCapExceededError } from "./spend-cap-exceeded.js";
import { releaseSpend, reserveSpend, SpendCapError } from "./spend-policy.js";
import { VAPI_CLIENT_VERSION } from "./support-report.js";
import type { WalletName } from "./wallet-name.js";
import {
  assertMaxPrice,
  buildCompatibleX402Payment,
  classifySettlement,
  discardBody,
  isSvmPaymentRequirements,
  parse402Response,
  parseSettlementResponse,
  usdToAtomic,
  X402Error,
  type X402NetworkConfig,
  type X402Quote,
  type X402SettlementOutcome,
} from "./x402.js";

export type PayRequestArgs = {
  url: string;
  init: RequestInit;
  account: VapiPaymentAccount;
  wallet: WalletName;
  caps: SpendCaps;
  config: VapiConfig;
  fetchImpl: typeof fetch;
  paths?: { ledgerPath?: string; receiptsPath?: string };
  maxAtomic?: bigint;
  preferNetworks?: string[];
  paymentId?: string;
  now?: Date;
  allowanceExpiresAt?: Date;
  nowMs?: () => number;
  source?: string;
  lookup?: LookupFn;
  /** Optional settled-call hook; omitted or false keeps payment tests and custom SDK flows inert. */
  ceilingSweep?: CeilingSweepHook | false;
  runBudget?: RunBudget;
  run?: RunRef;
};

export type PayRequestResult = {
  response: Response;
  receipt: Receipt;
  warnings?: PaymentWarning[];
};

export type X402PaymentAttempt = {
  response: Response;
  request: Request;
  finish(): void;
  waitFor<T>(operation: Promise<T>, response: Response): Promise<T>;
};

export type X402PossibleSettlement = {
  network: string;
  asset: string;
  amountAtomic: string;
  payTo: string;
  payer: string;
  paymentId?: string;
  authorizationNonce?: string;
  authorizationExpiresAt?: string;
  receipt: unknown | null;
};

export type X402PaymentTrace = {
  phases: {
    quoteMs?: number;
    signMs?: number;
    requestMs?: number;
    settleMs?: number;
  };
  quote?: NonNullable<Receipt["quote"]>;
  payer?: string;
  paymentId?: string;
  authorization?: NonNullable<Receipt["authorization"]>;
  settlement?: NonNullable<Receipt["settlement"]>;
  status?: number;
  capsApplied: boolean;
};

export class X402PaymentError extends Error {
  readonly name = "X402PaymentError";

  constructor(
    public readonly code: "payment_rejected" | "response_unreadable" | "settlement_unknown",
    message: string,
    public readonly possibleSettlement?: X402PossibleSettlement,
    options?: ErrorOptions & {
      paymentRejection?: { httpStatus: number; receipt: unknown };
      confirmedSettlement?: { httpStatus: number; receipt: unknown };
    },
  ) {
    super(message, options);
    this.paymentRejection = options?.paymentRejection;
    this.confirmedSettlement = options?.confirmedSettlement;
  }

  readonly paymentRejection?: { httpStatus: number; receipt: unknown };
  readonly confirmedSettlement?: { httpStatus: number; receipt: unknown };
}

export type CompleteX402PaymentArgs<T = undefined> = {
  challenge: X402PaymentAttempt;
  account: VapiPaymentAccount;
  caps: SpendCaps;
  config: VapiConfig;
  send(request: Request, quote: X402Quote): Promise<X402PaymentAttempt>;
  consumeResponse?: (response: Response) => Promise<T>;
  fetchImpl?: typeof fetch;
  ledgerPath?: string;
  wallet?: WalletName;
  maxAtomic?: bigint;
  maxPriceUsd?: number | string;
  preferNetworks?: string[];
  requiredNetwork?: string;
  expectedPayTo?: string;
  paymentId?: string;
  now?: Date;
  allowanceExpiresAt?: Date;
  nowMs?: () => number;
  quoteStartedMs?: number;
  trace?: X402PaymentTrace;
  /** Runs only after a successful, decisively settled paid result is ready. */
  ceilingSweep?: CeilingSweepHook | false;
  runBudget?: RunBudget;
};

export type CompleteX402PaymentResult<T = undefined> = {
  response: Response;
  request: Request;
  body: T | undefined;
  quote: X402Quote;
  payer: string;
  paymentId?: string;
  paymentProof: string | null;
  settlement: unknown | null;
  settlementOutcome: X402SettlementOutcome;
};

/**
 * Sends one request and, only when it receives HTTP 402, completes the exact
 * x402 payment flow. A non-402 response is returned with a receipt that has no
 * quote, payer, authorization, or settlement fields. The existing receipt
 * vocabulary records a successful unpaid response as `paid`.
 */
export async function payRequest(input: PayRequestArgs): Promise<PayRequestResult> {
  // Snapshot caller-controlled metadata before any asynchronous payment work.
  const args: PayRequestArgs = {
    ...input,
    ...(input.run === undefined ? {} : { run: { ...input.run } }),
    ...(input.now === undefined ? {} : { now: new Date(input.now.getTime()) }),
  };
  const startedAt = args.now ?? new Date();
  assertAllowanceCurrent(startedAt, args.allowanceExpiresAt);
  const nowMs = args.nowMs ?? (() => performance.now());
  const startedMs = nowMs();
  const receiptId = randomUUID();
  const trace: X402PaymentTrace = { phases: {}, capsApplied: false };
  const defaults = getVapiPaths();
  const ledgerPath = args.paths?.ledgerPath ?? defaults.ledger;
  const receiptsPath = args.paths?.receiptsPath ?? defaults.receipts;
  const request = new Request(args.url, { ...args.init, redirect: "manual" });
  parseReceipt({
    id: receiptId,
    timestamp: startedAt.toISOString(),
    resourceUrl: request.url,
    method: request.method,
    wallet: args.wallet,
    source: args.source ?? "direct",
    ...(args.run === undefined ? {} : { run: args.run }),
  });
  const fetchImpl = guardedFetch(args.fetchImpl, {
    allowPrivateNetwork: args.config.allowPrivateNetwork ?? false,
    lookup: args.lookup,
  });
  let response: Response | undefined;
  let paidResponse: Response | undefined;
  let paidRequest: Request | undefined;
  const warnings: PaymentWarning[] = [];
  let receiptRequest = request;
  let outcome: NonNullable<Receipt["outcome"]>;

  try {
    response = await fetchImpl(new Request(request.clone(), { redirect: "manual" }));
    trace.status = response.status;
    if (response.status !== 402) {
      outcome = response.ok ? "paid" : "failed_request";
    } else {
      const completed = await completeX402Payment({
        challenge: directAttempt(response, request),
        account: args.account,
        caps: args.caps,
        config: args.config,
        send: async (requestToPay) => {
          paidRequest = requestToPay;
          paidResponse = await fetchImpl(new Request(requestToPay.clone(), { redirect: "manual" }));
          return directAttempt(paidResponse, requestToPay);
        },
        fetchImpl,
        ledgerPath,
        wallet: args.wallet,
        ...(args.maxAtomic === undefined ? {} : { maxAtomic: args.maxAtomic }),
        ...(args.preferNetworks === undefined ? {} : { preferNetworks: args.preferNetworks }),
        ...(args.paymentId === undefined ? {} : { paymentId: args.paymentId }),
        now: startedAt,
        ...(args.allowanceExpiresAt === undefined
          ? {}
          : { allowanceExpiresAt: args.allowanceExpiresAt }),
        nowMs,
        trace,
        ...(args.runBudget === undefined ? {} : { runBudget: args.runBudget }),
        ...(args.ceilingSweep === undefined ? {} : { ceilingSweep: args.ceilingSweep }),
      });
      response = completed.response;
      receiptRequest = completed.request;
      outcome = completed.settlementOutcome === "succeeded" ? "paid" : "settlement_unknown";
    }
  } catch (error) {
    if (trace.settlement?.outcome === "succeeded" && paidResponse !== undefined) {
      response = paidResponse;
      receiptRequest = paidRequest ?? request;
      outcome = "paid";
      warnings.push({
        code: "payment_followup_unavailable",
        message:
          "Payment settled, but post-payment processing failed. Keep the returned receipt; do not repeat the payment.",
      });
    } else {
      const safeError = sanitizeThrownError(error, requestSecretValues(request.headers));
      const errorReceipt = directReceipt(
        args,
        request,
        trace,
        receiptId,
        startedAt,
        elapsed(nowMs, startedMs),
        {
          outcome: paymentErrorOutcome(safeError),
          error: { code: errorCode(safeError), message: receiptSafeErrorMessage(safeError) },
        },
      );
      await appendReceipt(errorReceipt, receiptsPath, { wallet: args.wallet }).catch(
        () => undefined,
      );
      throw safeError;
    }
  }

  let receipt = directReceipt(
    args,
    receiptRequest,
    trace,
    receiptId,
    startedAt,
    elapsed(nowMs, startedMs),
    {
      outcome,
    },
  );
  try {
    receipt = await appendReceipt(receipt, receiptsPath, { wallet: args.wallet });
  } catch (error) {
    if (trace.settlement?.outcome !== "succeeded") throw error;
    // Never validate the same rejected receipt a second time after settlement.
    // The financial evidence and prevalidated metadata remain available in memory.
    receipt = { ...receipt, wallet: args.wallet };
    warnings.push({
      code: "receipt_unavailable",
      message:
        "Payment settled, but its receipt could not be saved locally. Save the returned receipt; do not repeat the payment.",
    });
  }
  return { response, receipt, ...(warnings.length === 0 ? {} : { warnings }) };
}

/**
 * Completes an already-received HTTP 402 challenge. The transport seam keeps
 * redirect validation and timeout ownership with the caller while this module
 * owns quote selection, policy, signing, paid replay, and settlement handling.
 */
export async function completeX402Payment<T = undefined>(
  args: CompleteX402PaymentArgs<T>,
): Promise<CompleteX402PaymentResult<T>> {
  const paymentTime = args.now ?? new Date();
  assertAllowanceCurrent(paymentTime, args.allowanceExpiresAt);
  const nowMs = args.nowMs ?? (() => performance.now());
  const trace = args.trace;
  const quoteStarted = args.quoteStartedMs ?? nowMs();
  let quote: X402Quote;
  try {
    quote = await selectQuote(args);
  } catch (error) {
    throw sanitizeThrownError(error, requestSecretValues(args.challenge.request.headers));
  } finally {
    if (trace) trace.phases.quoteMs = elapsed(nowMs, quoteStarted);
    args.challenge.finish();
  }
  if (trace) {
    trace.quote = receiptQuote(quote);
  }

  if (new URL(args.challenge.request.url).protocol !== "https:") {
    throw new Error("vAPI will only send a signed x402 payment to an HTTPS endpoint.");
  }
  args.challenge.request.signal.throwIfAborted();
  if (trace) trace.capsApplied = true;
  try {
    assertMaximumAtomic(quote.amountAtomic, args.maxAtomic);
  } catch (error) {
    if (args.maxAtomic !== undefined && isErrorCode(error, "max_price_exceeded")) {
      throw paymentCapError("max_amount", quote.amountAtomic, args.maxAtomic, args, error);
    }
    throw error;
  }
  try {
    assertMaxPrice(quote.amountAtomic, args.maxPriceUsd);
  } catch (error) {
    if (args.maxPriceUsd !== undefined && isErrorCode(error, "max_price_exceeded")) {
      throw paymentCapError(
        "max_price",
        quote.amountAtomic,
        usdToAtomic(args.maxPriceUsd),
        args,
        error,
      );
    }
    throw error;
  }
  const spendReservation = {
    ledgerPath: args.ledgerPath ?? getVapiPaths().ledger,
    now: args.now,
    ...(args.wallet === undefined ? {} : { wallet: args.wallet }),
  };
  let reservationId: string | undefined;
  let reservedOn: string | undefined;
  if (args.runBudget === undefined) {
    try {
      await reserveSpend(quote.amountAtomic, args.caps, spendReservation);
    } catch (error) {
      throw walletCapError(error, quote.amountAtomic, args);
    }
  } else {
    reservationId = args.paymentId ?? `x402_${randomBytes(12).toString("hex")}`;
    let reservation: Awaited<ReturnType<typeof reserveSpend>>;
    try {
      reservation = await reserveSpend(quote.amountAtomic, args.caps, {
        ...spendReservation,
        reservationId,
      });
    } catch (error) {
      throw walletCapError(error, quote.amountAtomic, args);
    }
    reservedOn = reservation.date;
    try {
      args.runBudget.reserve(quote.amountAtomic, reservationId);
    } catch (error) {
      let runSpentAtomic: bigint;
      try {
        runSpentAtomic = args.runBudget.spentAtomic();
      } finally {
        await releaseUnsentReservation(args, quote.amountAtomic, reservationId, reservedOn);
      }
      if (error instanceof RunBudgetError || isErrorCode(error, "run_budget_exceeded")) {
        throw new SpendCapExceededError({
          cap: "run_budget",
          amountUsd: formatUsdc(quote.amountAtomic),
          limitUsd: formatUsdc(args.runBudget.limitAtomic),
          spentUsd: formatUsdc(runSpentAtomic),
          ...(args.wallet === undefined ? {} : { wallet: args.wallet }),
          cause: error,
        });
      }
      throw error;
    }
  }

  const signStarted = nowMs();
  let payment: Awaited<ReturnType<typeof buildCompatibleX402Payment>>;
  try {
    payment = await buildCompatibleX402Payment({
      account: args.account,
      quote,
      fetchImpl:
        args.fetchImpl ??
        createPublicFetch({
          allowPrivateNetwork: args.config.allowPrivateNetwork ?? false,
        }),
      ...(args.now === undefined ? {} : { nowSeconds: Math.floor(args.now.getTime() / 1_000) }),
      ...(args.allowanceExpiresAt === undefined
        ? {}
        : { maximumValidBeforeSeconds: Math.floor(args.allowanceExpiresAt.getTime() / 1_000) }),
      ...(args.paymentId === undefined ? {} : { paymentId: args.paymentId }),
    });
    const payer = isSvmPaymentRequirements(quote.accepted)
      ? (args.account.solana?.address ?? args.account.address)
      : args.account.address;
    if (trace) {
      trace.paymentId = payment.paymentId;
      trace.payer = payer;
      if ("authorization" in payment.payload.payload) {
        const { from, nonce, validBefore } = payment.payload.payload.authorization;
        trace.authorization = { from, nonce, validBefore };
      }
    }
  } catch (error) {
    if (args.runBudget !== undefined && reservationId !== undefined && reservedOn !== undefined) {
      const released = await releaseUnsentReservation(
        args,
        quote.amountAtomic,
        reservationId,
        reservedOn,
      );
      if (released) args.runBudget.release(reservationId);
    }
    throw error;
  } finally {
    if (trace) trace.phases.signMs = elapsed(nowMs, signStarted);
  }

  const payer = isSvmPaymentRequirements(quote.accepted)
    ? (args.account.solana?.address ?? args.account.address)
    : args.account.address;
  const paidHeaders = new Headers(args.challenge.request.headers);
  for (const [name, value] of Object.entries(payment.headers)) {
    paidHeaders.set(name, value);
  }
  const paidBody =
    args.challenge.request.method === "GET" || args.challenge.request.method === "HEAD"
      ? undefined
      : await args.challenge.request.clone().arrayBuffer();
  const paidRequest = new Request(args.challenge.request.url, {
    method: args.challenge.request.method,
    headers: paidHeaders,
    body: paidBody,
    redirect: "manual",
    signal: args.challenge.request.signal,
  });
  const receiptSecrets = paymentSecretValues(args.challenge.request.headers, payment);

  let paidAttempt: X402PaymentAttempt;
  const requestStarted = nowMs();
  try {
    paidAttempt = await args.send(paidRequest, quote);
  } catch (error) {
    if (trace) trace.phases.requestMs = elapsed(nowMs, requestStarted);
    throw settlementUnknown(
      "The paid request lost its response. Do not retry automatically; inspect the authorization and settlement state first.",
      quote,
      payment,
      payer,
      null,
      sanitizeThrownError(error, receiptSecrets),
    );
  }
  if (trace) trace.phases.requestMs = elapsed(nowMs, requestStarted);

  const paidResponse = paidAttempt.response;
  if (trace) trace.status = paidResponse.status;
  const settleStarted = nowMs();
  const settlement = parseSettlementResponse(paidResponse.headers);
  const settlementOutcome = classifySettlement(settlement);
  const receiptSettlement = sanitizeReturnedValue(settlement, receiptSecrets);
  if (trace) {
    const transaction = settlementTransaction(receiptSettlement);
    const explorerUrl = transaction
      ? explorerTransactionUrl(quote.accepted.network, transaction)
      : undefined;
    trace.settlement = {
      outcome: settlementOutcome,
      ...(transaction ? { transaction } : {}),
      ...(explorerUrl ? { explorerUrl } : {}),
      ...(receiptSettlement === null ? {} : { evidence: receiptSettlement }),
    };
    trace.phases.settleMs = elapsed(nowMs, settleStarted);
  }

  try {
    if (settlementOutcome === "rejected") {
      discardBody(paidResponse);
      throw paymentRejected(
        paidResponse.status,
        settlementWithExplorer(receiptSettlement, quote.accepted.network),
      );
    }
    if (isRedirectStatus(paidResponse.status) && settlementOutcome !== "succeeded") {
      discardBody(paidResponse);
      throw settlementUnknown(
        "The paid endpoint returned a redirect. The payment header was not forwarded; do not retry automatically until settlement is checked.",
        quote,
        payment,
        payer,
        receiptSettlement,
      );
    }
    if (paidResponse.status === 402 && settlementOutcome !== "succeeded") {
      let message =
        "The endpoint returned HTTP 402 after receiving the authorization. Settlement is uncertain; do not retry automatically.";
      try {
        const changed = await selectQuote({ ...args, challenge: paidAttempt });
        if (changed.amountAtomic !== quote.amountAtomic) {
          message = `The endpoint returned a changed quote (${quote.amountAtomic} → ${changed.amountAtomic} atomic USDC) after receiving the authorization. Settlement is uncertain; do not retry automatically.`;
        }
      } catch {
        // A repeated response remains ambiguous even when its next quote is invalid.
      }
      throw settlementUnknown(message, quote, payment, payer, receiptSettlement);
    }
    if (!paidResponse.ok && settlementOutcome !== "succeeded") {
      discardBody(paidResponse);
      throw settlementUnknown(
        `The paid endpoint returned HTTP ${paidResponse.status} without decisive settlement evidence. Do not retry automatically.`,
        quote,
        payment,
        payer,
        receiptSettlement,
      );
    }

    let body: T | undefined;
    if (args.consumeResponse) {
      const bodyStarted = nowMs();
      try {
        body = await args.consumeResponse(paidResponse);
      } catch (error) {
        if (settlementOutcome === "succeeded") {
          throw responseUnreadableAfterSettlement(
            paidResponse.status,
            receiptSettlement,
            sanitizeThrownError(error, receiptSecrets),
          );
        }
        throw settlementUnknown(
          "The paid response could not be read. Do not retry automatically; inspect the authorization and settlement state first.",
          quote,
          payment,
          payer,
          receiptSettlement,
          sanitizeThrownError(error, receiptSecrets),
        );
      } finally {
        if (trace) {
          trace.phases.requestMs = (trace.phases.requestMs ?? 0) + elapsed(nowMs, bodyStarted);
        }
      }
      body = sanitizeReturnedValue(body, receiptSecrets) as T;
    }

    const result: CompleteX402PaymentResult<T> = {
      response: paidResponse,
      request: paidAttempt.request,
      body,
      quote,
      payer,
      ...(payment.paymentId ? { paymentId: payment.paymentId } : {}),
      paymentProof: sanitizeReturnedValue(
        paidResponse.headers.get("x-vapi-payment-proof"),
        receiptSecrets,
      ) as string | null,
      settlement: receiptSettlement,
      settlementOutcome,
    };
    if (settlementOutcome === "succeeded" && args.ceilingSweep) {
      scheduleCeilingSweep(args.ceilingSweep);
    }
    return result;
  } finally {
    paidAttempt.finish();
  }
}

function assertAllowanceCurrent(now: Date, expiresAt: Date | undefined): void {
  if (expiresAt === undefined || now.getTime() < expiresAt.getTime()) return;
  throw new Error(
    `Remote allowance expired at ${expiresAt.toISOString()}. Start a new Railway run before paying.`,
  );
}

async function releaseUnsentReservation(
  args: { ledgerPath?: string; wallet?: WalletName; now?: Date },
  amountAtomic: bigint,
  reservationId: string,
  reservedOn: string,
): Promise<boolean> {
  try {
    await releaseSpend(amountAtomic, {
      reservedOn,
      ledgerPath: args.ledgerPath ?? getVapiPaths().ledger,
      now: args.now,
      ...(args.wallet === undefined ? {} : { wallet: args.wallet }),
      reservationId,
    });
    return true;
  } catch {
    return false;
  }
}

async function selectQuote<T>(args: CompleteX402PaymentArgs<T>): Promise<X402Quote> {
  const networks = toX402Networks(args.config.networks);
  const waitFor = args.challenge.waitFor.bind(args.challenge);
  for (const preferred of uniqueNetworks(args.preferNetworks ?? [])) {
    if (args.requiredNetwork && !areSamePaymentNetwork(preferred, args.requiredNetwork)) continue;
    const candidateResponse = args.challenge.response.clone();
    try {
      const quote = await waitFor(
        parse402Response(candidateResponse, networks, preferred, args.expectedPayTo),
        candidateResponse,
      );
      discardBody(args.challenge.response);
      return quote;
    } catch (error) {
      if (!(error instanceof X402Error) || error.code !== "unsupported_challenge") throw error;
    }
  }
  return await waitFor(
    parse402Response(args.challenge.response, networks, args.requiredNetwork, args.expectedPayTo),
    args.challenge.response,
  );
}

function toX402Networks(networks: VapiConfig["networks"]): X402NetworkConfig {
  return Object.fromEntries(
    Object.entries(networks).map(([network, configured]) => [
      network,
      {
        usdc: configured.usdc,
        rpcUrl: configured.rpcUrl,
        enabled: Boolean(configured.rpcUrl.trim()),
        ...(configured.eip712Domain ? { eip712Domain: configured.eip712Domain } : {}),
      },
    ]),
  );
}

function uniqueNetworks(networks: readonly string[]): string[] {
  return networks.filter((network, index) => networks.indexOf(network) === index);
}

function directAttempt(response: Response, request: Request): X402PaymentAttempt {
  return {
    response,
    request,
    finish() {},
    async waitFor<T>(operation: Promise<T>): Promise<T> {
      return await operation;
    },
  };
}

function guardedFetch(
  fetchImpl: typeof fetch,
  options: { allowPrivateNetwork: boolean; lookup?: LookupFn },
): typeof fetch {
  const transport = fetchImpl === globalThis.fetch ? createPublicFetch(options) : fetchImpl;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, { ...init, redirect: "manual" });
    await assertPublicUrl(new URL(request.url), options);
    return await transport(request);
  }) as typeof fetch;
}

function requestSecretValues(headers: Headers): string[] {
  const secrets: string[] = [];
  for (const [name, value] of headers) {
    if (!value || !isCredentialHeader(name)) continue;
    secrets.push(value);
    if (name === "authorization" || name === "proxy-authorization") {
      const credential = /^\S+\s+(.+)$/.exec(value)?.[1];
      if (credential) secrets.push(credential);
    }
  }
  return secrets;
}

function isCredentialHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized === "authorization" ||
    normalized === "proxy-authorization" ||
    normalized === "cookie" ||
    normalized === "set-cookie" ||
    normalized === "payment-signature" ||
    normalized === "x-payment" ||
    normalized === "sign-in-with-x" ||
    normalized.includes("api-key") ||
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("signature")
  );
}

function paymentSecretValues(
  requestHeaders: Headers,
  payment: Awaited<ReturnType<typeof buildCompatibleX402Payment>>,
): string[] {
  const secrets = requestSecretValues(requestHeaders);
  secrets.push(...Object.values(payment.headers));
  if ("signature" in payment.payload.payload) {
    secrets.push(payment.payload.payload.signature);
  } else {
    secrets.push(payment.payload.payload.transaction);
  }
  return secrets;
}

function sanitizeThrownError(error: unknown, secrets: readonly string[]): unknown {
  if (!(error instanceof Error)) return error;
  const message = redactKnownSecrets(error.message, secrets);
  const cause = error.cause === undefined ? undefined : sanitizeThrownError(error.cause, secrets);
  if (error instanceof SpendCapExceededError) {
    return new SpendCapExceededError({
      cap: error.cap,
      amountUsd: error.amountUsd,
      limitUsd: error.limitUsd,
      ...(error.spentUsd === undefined ? {} : { spentUsd: error.spentUsd }),
      ...(error.wallet === undefined ? {} : { wallet: error.wallet }),
      command: error.command,
      message,
      ...(cause === undefined ? {} : { cause }),
    });
  }
  if (message === error.message && cause === error.cause) return error;
  if (error instanceof X402Error) {
    return new X402Error(error.code, message, cause === undefined ? undefined : { cause });
  }
  if (error instanceof SpendCapError) {
    return new SpendCapError(error.code, message);
  }
  if (error instanceof RunBudgetError) {
    return new RunBudgetError(message);
  }
  if (error instanceof X402PaymentError) {
    return new X402PaymentError(error.code, message, error.possibleSettlement, {
      ...(cause === undefined ? {} : { cause }),
      ...(error.paymentRejection ? { paymentRejection: error.paymentRejection } : {}),
      ...(error.confirmedSettlement ? { confirmedSettlement: error.confirmedSettlement } : {}),
    });
  }
  return new Error(message, cause === undefined ? undefined : { cause });
}

function sanitizeReturnedValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactKnownSecrets(value, secrets);
  if (!isPlainReturnedContainer(value)) return value;

  type Node = {
    source: unknown[] | Record<string, unknown>;
    copy: unknown[] | Record<string, unknown>;
    parents: Set<Node>;
    changed: boolean;
  };
  const nodes = new WeakMap<object, Node>();
  const ordered: Node[] = [];
  const nodeFor = (source: unknown[] | Record<string, unknown>): Node => {
    const existing = nodes.get(source);
    if (existing) return existing;
    const copy = Array.isArray(source)
      ? new Array(source.length)
      : Object.create(Object.getPrototypeOf(source) as object | null);
    const node = { source, copy, parents: new Set<Node>(), changed: false };
    nodes.set(source, node);
    ordered.push(node);
    return node;
  };
  const root = nodeFor(value);

  for (let index = 0; index < ordered.length; index += 1) {
    const node = ordered[index]!;
    for (const [key, item] of Object.entries(node.source)) {
      const safeKey = Array.isArray(node.source) ? key : redactKnownSecrets(key, secrets);
      if (safeKey !== key) node.changed = true;
      if (typeof item === "string") {
        const safeItem = redactKnownSecrets(item, secrets);
        defineReturnedProperty(node.copy, safeKey, safeItem);
        if (safeItem !== item) node.changed = true;
      } else if (isPlainReturnedContainer(item)) {
        const child = nodeFor(item);
        child.parents.add(node);
        defineReturnedProperty(node.copy, safeKey, child.copy);
      } else {
        defineReturnedProperty(node.copy, safeKey, item);
      }
    }
  }

  const changed = ordered.filter((node) => node.changed);
  for (let index = 0; index < changed.length; index += 1) {
    for (const parent of changed[index]!.parents) {
      if (parent.changed) continue;
      parent.changed = true;
      changed.push(parent);
    }
  }
  for (const node of ordered) {
    for (const [key, item] of Object.entries(node.source)) {
      if (!isPlainReturnedContainer(item)) continue;
      const safeKey = Array.isArray(node.source) ? key : redactKnownSecrets(key, secrets);
      const child = nodes.get(item)!;
      defineReturnedProperty(node.copy, safeKey, child.changed ? child.copy : item);
    }
  }
  return root.changed ? root.copy : value;
}

function defineReturnedProperty(
  target: unknown[] | Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function isPlainReturnedContainer(value: unknown): value is unknown[] | Record<string, unknown> {
  if (Array.isArray(value)) return true;
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function redactKnownSecrets(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of [...new Set(secrets)].sort((left, right) => right.length - left.length)) {
    if (secret) redacted = redacted.replaceAll(secret, "[redacted]");
  }
  return redacted;
}

function assertMaximumAtomic(amountAtomic: bigint, maxAtomic: bigint | undefined): void {
  if (maxAtomic === undefined) return;
  if (maxAtomic < 0n) throw new Error("maxAtomic must be non-negative.");
  if (amountAtomic > maxAtomic) {
    throw new X402Error(
      "max_price_exceeded",
      `x402 quote ${amountAtomic} atomic USDC exceeds maxAtomic ${maxAtomic}. Refusing to sign.`,
    );
  }
}

function walletCapError(
  error: unknown,
  amountAtomic: bigint,
  args: Pick<CompleteX402PaymentArgs<unknown>, "caps" | "wallet">,
): unknown {
  if (!(error instanceof SpendCapError)) return error;
  if (error.code === "per_call_cap_exceeded") {
    return paymentCapError(
      "per_call",
      amountAtomic,
      error.details?.limitAtomic ?? BigInt(args.caps.perCallAtomic),
      args,
      error,
    );
  }
  if (error.code === "per_day_cap_exceeded") {
    return paymentCapError(
      "per_day",
      amountAtomic,
      error.details?.limitAtomic ?? BigInt(args.caps.perDayAtomic),
      args,
      error,
      error.details?.spentAtomic,
    );
  }
  return error;
}

function paymentCapError(
  cap: "per_call" | "per_day" | "max_price" | "max_amount",
  amountAtomic: bigint,
  limitAtomic: bigint,
  args: Pick<CompleteX402PaymentArgs<unknown>, "wallet" | "caps">,
  cause: unknown,
  spentAtomic?: bigint,
): SpendCapExceededError {
  return new SpendCapExceededError({
    cap,
    amountUsd: formatUsdc(amountAtomic),
    limitUsd: formatUsdc(limitAtomic),
    ...(cap === "per_call" ? { perDayLimitUsd: formatUsdc(BigInt(args.caps.perDayAtomic)) } : {}),
    ...(spentAtomic === undefined ? {} : { spentUsd: formatUsdc(spentAtomic) }),
    ...(args.wallet === undefined ? {} : { wallet: args.wallet }),
    cause,
  });
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
}

function settlementUnknown(
  message: string,
  quote: X402Quote,
  payment: Awaited<ReturnType<typeof buildCompatibleX402Payment>>,
  payer: string,
  receipt: unknown | null,
  cause?: unknown,
): X402PaymentError {
  return new X402PaymentError(
    "settlement_unknown",
    message,
    possibleSettlement(quote, payment, payer, receipt),
    cause === undefined ? undefined : { cause },
  );
}

function possibleSettlement(
  quote: X402Quote,
  payment: Awaited<ReturnType<typeof buildCompatibleX402Payment>>,
  payer: string,
  receipt: unknown | null,
): X402PossibleSettlement {
  return {
    network: quote.accepted.network,
    asset: quote.accepted.asset,
    amountAtomic: quote.amountAtomic.toString(),
    payTo: quote.accepted.payTo,
    payer,
    ...(payment.paymentId ? { paymentId: payment.paymentId } : {}),
    ...(isSvmPaymentRequirements(quote.accepted)
      ? {}
      : "authorization" in payment.payload.payload
        ? {
            authorizationNonce: payment.payload.payload.authorization.nonce,
            authorizationExpiresAt: payment.payload.payload.authorization.validBefore,
          }
        : {}),
    receipt,
  };
}

function paymentRejected(httpStatus: number, receipt: unknown): X402PaymentError {
  return new X402PaymentError(
    "payment_rejected",
    `The paid endpoint reported that x402 settlement was rejected (HTTP ${httpStatus}).`,
    undefined,
    { paymentRejection: { httpStatus, receipt } },
  );
}

function responseUnreadableAfterSettlement(
  httpStatus: number,
  receipt: unknown,
  cause: unknown,
): X402PaymentError {
  return new X402PaymentError(
    "response_unreadable",
    "The paid response could not be read after settlement was confirmed. Do not retry the authorization automatically.",
    undefined,
    { cause, confirmedSettlement: { httpStatus, receipt } },
  );
}

function directReceipt(
  args: PayRequestArgs,
  request: Request,
  trace: X402PaymentTrace,
  receiptId: string,
  startedAt: Date,
  latencyMs: number,
  result: Pick<Receipt, "outcome" | "error">,
): Receipt {
  const settlement = trace.settlement;
  return {
    id: receiptId,
    timestamp: startedAt.toISOString(),
    resourceUrl: request.url,
    method: request.method,
    source: args.source ?? "direct",
    ...(args.run === undefined ? {} : { run: args.run }),
    ...(trace.quote ? { quote: trace.quote } : {}),
    ...(trace.payer && result.outcome !== "declined_policy" ? { payer: trace.payer } : {}),
    ...(trace.paymentId ? { paymentId: trace.paymentId } : {}),
    ...(trace.authorization ? { authorization: trace.authorization } : {}),
    ...(settlement
      ? {
          settlement: {
            outcome: settlement.outcome,
            ...(settlement.transaction ? { transaction: settlement.transaction } : {}),
          },
        }
      : {}),
    ...(trace.status === undefined ? {} : { status: trace.status }),
    latencyMs,
    phases: { ...trace.phases },
    policy: { capsApplied: trace.capsApplied },
    client: { name: "vapi-network", version: VAPI_CLIENT_VERSION },
    ...result,
  };
}

function receiptQuote(quote: X402Quote): NonNullable<Receipt["quote"]> {
  return {
    network: quote.accepted.network,
    asset: quote.accepted.asset,
    amountAtomic: quote.amountAtomic.toString(),
    payTo: quote.accepted.payTo,
  };
}

function paymentErrorOutcome(error: unknown): NonNullable<Receipt["outcome"]> {
  if (
    error instanceof SpendCapExceededError ||
    error instanceof SpendCapError ||
    error instanceof RunBudgetError ||
    (error instanceof X402Error && error.code === "max_price_exceeded")
  ) {
    return "declined_policy";
  }
  if (error instanceof X402PaymentError) {
    if (error.code === "payment_rejected") return "settlement_rejected";
    if (error.code === "settlement_unknown") return "settlement_unknown";
    if (error.confirmedSettlement) return "paid";
  }
  return "failed_request";
}

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    typeof Reflect.get(error, "code") === "string"
  ) {
    return Reflect.get(error, "code") as string;
  }
  return "request_failed";
}

function receiptSafeErrorMessage(error: unknown): string {
  if (
    error instanceof SpendCapExceededError ||
    error instanceof SpendCapError ||
    error instanceof RunBudgetError ||
    error instanceof X402Error ||
    error instanceof X402PaymentError
  ) {
    return error.message;
  }
  return "The x402 request failed before it completed.";
}

function settlementTransaction(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const transaction = Reflect.get(value, "transaction");
  return typeof transaction === "string" && transaction ? transaction : undefined;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function elapsed(nowMs: () => number, started: number): number {
  return Math.max(0, nowMs() - started);
}

/** Adds the chain explorer link for the settled transaction, when the network has one. */
function settlementWithExplorer(value: unknown, network: string): unknown {
  const transaction = settlementTransaction(value);
  const explorerUrl = transaction ? explorerTransactionUrl(network, transaction) : undefined;
  if (
    explorerUrl === undefined ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return value;
  }
  return { ...value, explorerUrl };
}
