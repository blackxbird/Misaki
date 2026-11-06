import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type KeyPairSigner,
} from "@solana/kit";
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from "@solana-program/token";

import type { LookupFn } from "./net-guard.js";
import { discardBody } from "./http-response.js";
import { createPublicFetch } from "./net-guard.js";
import type { ConfiguredNetwork } from "./networks.js";
import { requireRpcUrl, SOLANA_MAINNET_USDC, USDC_DECIMALS } from "./networks.js";

const MAX_RPC_RESPONSE_BYTES = 4 * 1024 * 1024;
const TOKEN_ACCOUNT_BYTES = 165;
const BASE_TRANSACTION_FEE_LAMPORTS = 5_000;

type SolanaTokenAccount = {
  address: string;
  amountAtomic: bigint;
};

type SolanaRpcOptions = {
  allowPrivateNetwork?: boolean;
  fetchImpl?: typeof fetch;
  lookup?: LookupFn;
};

export function isSolanaAddress(value: string): boolean {
  try {
    address(value);
    return true;
  } catch {
    return false;
  }
}

export async function readSolanaUsdcBalance(
  args: {
    network: string;
    configured: ConfiguredNetwork;
    address: string;
  } & SolanaRpcOptions,
): Promise<bigint> {
  const accounts = await readSolanaUsdcAccounts(args);
  return accounts.reduce((total, account) => total + account.amountAtomic, 0n);
}

export async function readSolanaGasBalance(
  args: {
    network: string;
    configured: ConfiguredNetwork;
    address: string;
  } & SolanaRpcOptions,
): Promise<bigint> {
  if (!isSolanaAddress(args.address)) {
    throw new Error(`Invalid Solana address: ${args.address}.`);
  }
  const lamports = await solanaRpcCall<number>(
    requireRpcUrl(args.network, args.configured),
    "getBalance",
    [args.address, { commitment: "confirmed" }],
    rpcOptionsFrom(args),
  );
  if (!Number.isSafeInteger(lamports) || lamports < 0) {
    throw new Error("Solana RPC returned an invalid SOL balance.");
  }
  return BigInt(lamports);
}

export async function sweepSolanaUsdc(
  args: {
    network: string;
    configured: ConfiguredNetwork;
    signer: KeyPairSigner;
    destination: string;
  } & SolanaRpcOptions,
): Promise<{ amountAtomic: bigint; transaction: string }> {
  const owner = args.signer.address;
  const destination = address(args.destination);
  const mint = address(SOLANA_MAINNET_USDC);
  const rpcUrl = requireRpcUrl(args.network, args.configured);
  const rpcOptions = rpcOptionsFrom(args);
  const lamports = await solanaRpcCall<number>(rpcUrl, "getBalance", [owner], rpcOptions);
  if (!Number.isSafeInteger(lamports) || lamports <= 0) {
    throw new Error(
      "Solana sweep requires a small SOL balance in the local Solana account for transaction fees and possible destination-account rent.",
    );
  }

  const accounts = await readSolanaUsdcAccounts({ ...args, address: owner });
  const nonzero = accounts.filter((account) => account.amountAtomic > 0n);
  const amountAtomic = nonzero.reduce((total, account) => total + account.amountAtomic, 0n);
  if (amountAtomic === 0n) {
    throw new Error(`No USDC is available to sweep on ${args.network}.`);
  }

  const [destinationAta] = await findAssociatedTokenPda({
    mint,
    owner: destination,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const destinationAccount = await solanaRpcCall<unknown | null>(
    rpcUrl,
    "getAccountInfo",
    [
      destinationAta,
      { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "confirmed" },
    ],
    rpcOptions,
  );
  const rentLamports =
    destinationAccount === null
      ? await solanaRpcCall<number>(
          rpcUrl,
          "getMinimumBalanceForRentExemption",
          [TOKEN_ACCOUNT_BYTES, { commitment: "confirmed" }],
          rpcOptions,
        )
      : 0;
  const requiredLamports = rentLamports + BASE_TRANSACTION_FEE_LAMPORTS;
  if (!Number.isSafeInteger(rentLamports) || rentLamports < 0 || lamports < requiredLamports) {
    throw new Error(
      `Solana sweep requires at least ${requiredLamports} lamports in the local Solana account for transaction fees${rentLamports > 0 ? " and destination-account rent" : ""}.`,
    );
  }
  const instructions = [
    getCreateAssociatedTokenIdempotentInstruction({
      payer: args.signer,
      ata: destinationAta,
      owner: destination,
      mint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    }),
    ...nonzero.map((account) =>
      getTransferCheckedInstruction({
        source: address(account.address),
        mint,
        destination: destinationAta,
        authority: args.signer,
        amount: account.amountAtomic,
        decimals: USDC_DECIMALS,
      }),
    ),
  ];
  const latest = await solanaRpcCall<{ blockhash: string; lastValidBlockHeight: number }>(
    rpcUrl,
    "getLatestBlockhash",
    [{ commitment: "confirmed" }],
    rpcOptions,
  );
  if (!Number.isSafeInteger(latest.lastValidBlockHeight) || latest.lastValidBlockHeight < 0) {
    throw new Error("Solana RPC returned an invalid blockhash lifetime.");
  }
  const lifetime = {
    blockhash: blockhash(latest.blockhash),
    lastValidBlockHeight: BigInt(latest.lastValidBlockHeight),
  };
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (transaction) => setTransactionMessageFeePayerSigner(args.signer, transaction),
    (transaction) => setTransactionMessageLifetimeUsingBlockhash(lifetime, transaction),
    (transaction) => appendTransactionMessageInstructions(instructions, transaction),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const encoded = getBase64EncodedWireTransaction(signed);
  let transaction: string;
  try {
    transaction = await solanaRpcCall<string>(
      rpcUrl,
      "sendTransaction",
      [encoded, { encoding: "base64", preflightCommitment: "confirmed" }],
      rpcOptions,
    );
  } catch (error) {
    throw new Error(
      "Solana sweep failed to submit. Ensure the local Solana account has a small SOL balance for fees and possible destination-account rent.",
      { cause: error },
    );
  }
  return { amountAtomic, transaction };
}

async function readSolanaUsdcAccounts(
  args: {
    network: string;
    configured: ConfiguredNetwork;
    address: string;
  } & SolanaRpcOptions,
): Promise<SolanaTokenAccount[]> {
  if (!isSolanaAddress(args.address)) {
    throw new Error(`Invalid Solana address: ${args.address}.`);
  }
  const rpcUrl = requireRpcUrl(args.network, args.configured);
  const value = await solanaRpcCall<
    Array<{
      pubkey: string;
      account: {
        data: {
          parsed: {
            info: {
              mint: string;
              owner: string;
              tokenAmount: { amount: string; decimals: number };
            };
          };
        };
      };
    }>
  >(
    rpcUrl,
    "getTokenAccountsByOwner",
    [
      args.address,
      { mint: args.configured.usdc },
      { encoding: "jsonParsed", commitment: "confirmed" },
    ],
    rpcOptionsFrom(args),
  );
  return value.map((entry) => {
    const info = entry.account.data.parsed.info;
    if (
      !isSolanaAddress(entry.pubkey) ||
      info.mint !== args.configured.usdc ||
      info.owner !== args.address ||
      info.tokenAmount.decimals !== USDC_DECIMALS ||
      !/^\d+$/.test(info.tokenAmount.amount)
    ) {
      throw new Error("Solana RPC returned a malformed USDC token account.");
    }
    return { address: entry.pubkey, amountAtomic: BigInt(info.tokenAmount.amount) };
  });
}

async function solanaRpcCall<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
  options: SolanaRpcOptions,
): Promise<T> {
  const fetchImpl =
    options.fetchImpl ??
    createPublicFetch({
      allowPrivateNetwork: options.allowPrivateNetwork ?? false,
      ...(options.lookup ? { lookup: options.lookup } : {}),
    });
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    redirect: "manual",
  });
  if (!response.ok) {
    discardBody(response);
    const rateLimit = response.status === 429 ? " (public RPC rate limit)" : "";
    throw new Error(`Solana RPC ${method} failed with HTTP ${response.status}${rateLimit}.`);
  }
  const envelope = await readBoundedRpcJson(response);
  if (!isRecord(envelope) || envelope.jsonrpc !== "2.0") {
    throw new Error(`Solana RPC ${method} returned an invalid JSON-RPC envelope.`);
  }
  if (envelope.error !== undefined) {
    throw new Error(`Solana RPC ${method} failed: ${JSON.stringify(envelope.error)}.`);
  }
  const result = envelope.result;
  if (isRecord(result) && "value" in result) return result.value as T;
  return result as T;
}

async function readBoundedRpcJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Solana RPC response body is empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > MAX_RPC_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(`Solana RPC response exceeds ${MAX_RPC_RESPONSE_BYTES} bytes.`);
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function rpcOptionsFrom(options: SolanaRpcOptions): SolanaRpcOptions {
  return {
    allowPrivateNetwork: options.allowPrivateNetwork,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.lookup ? { lookup: options.lookup } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
