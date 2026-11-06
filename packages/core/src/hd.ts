import { createHmac } from "node:crypto";

import {
  entropyToMnemonic,
  mnemonicToEntropy,
  mnemonicToSeedSync,
  validateMnemonic,
} from "@scure/bip39";
import { english, generateMnemonic, HDKey } from "viem/accounts";
import type { Hex } from "viem";

import { KeystoreError } from "./keystore-error.js";

/** BIP-44 first account on Base and every other EVM chain. */
export const EVM_DERIVATION_PATH = "m/44'/60'/0'/0/0";
/** SLIP-0010 ed25519 path Phantom and Solflare use for the first account. */
export const SOLANA_DERIVATION_PATH = "m/44'/501'/0'/0'";

const HARDENED_OFFSET = 0x80000000;
const ED25519_MASTER_KEY = "ed25519 seed";
const RECOVERY_PHRASE_LENGTHS = new Set([12, 24]);

/** A fresh 12-word English BIP-39 phrase. The only place new wallets start. */
export function generateRecoveryPhrase(): string {
  return generateMnemonic(english);
}

/**
 * Normalises spacing and case, then checks the BIP-39 checksum. Returns the
 * canonical phrase so callers store and derive from one spelling. The phrase
 * itself never appears in the error.
 */
export function validateRecoveryPhrase(phrase: string): string {
  const normalized = phrase.normalize("NFKD").trim().toLowerCase().split(/\s+/u).join(" ");
  const words = normalized.length === 0 ? [] : normalized.split(" ");
  if (!RECOVERY_PHRASE_LENGTHS.has(words.length)) {
    throw new KeystoreError(
      `A recovery phrase has 12 or 24 words; this one has ${words.length}. Check for a missing or repeated word.`,
    );
  }
  if (!validateMnemonic(normalized, english)) {
    throw new KeystoreError(
      "That recovery phrase is not valid. Check the spelling and the order of the words.",
    );
  }
  return normalized;
}

/** The 64-byte BIP-39 seed, with an empty BIP-39 passphrase. */
export function phraseToSeed(phrase: string): Uint8Array {
  return mnemonicToSeedSync(validateRecoveryPhrase(phrase), "");
}

/** The BIP-39 entropy behind a phrase: 16 bytes for 12 words, 32 for 24. */
export function phraseToEntropy(phrase: string): Uint8Array {
  return mnemonicToEntropy(validateRecoveryPhrase(phrase), english);
}

/** The phrase that produced this entropy, so a wallet can be shown again. */
export function entropyToPhrase(entropy: Uint8Array): string {
  return entropyToMnemonic(entropy, english);
}

/** secp256k1 key for the EVM account, BIP-32 over the BIP-39 seed. */
export function deriveEvmPrivateKey(seed: Uint8Array, path = EVM_DERIVATION_PATH): Hex {
  const node = HDKey.fromMasterSeed(seed).derive(path);
  const privateKey = node.privateKey;
  if (!privateKey || privateKey.length !== 32) {
    throw new KeystoreError(`Derivation path ${path} did not produce an EVM private key.`);
  }
  return `0x${Buffer.from(privateKey).toString("hex")}` as Hex;
}

/** 32-byte ed25519 seed for the Solana account, SLIP-0010 over the BIP-39 seed. */
export function deriveSolanaPrivateKey(
  seed: Uint8Array,
  path = SOLANA_DERIVATION_PATH,
): Uint8Array {
  return deriveEd25519Path(seed, path).privateKey;
}

/**
 * SLIP-0010 for the ed25519 curve: HMAC-SHA512 from the master key
 * "ed25519 seed", hardened children only. Returns the chain code as well so the
 * specification's test vectors can check every step.
 */
export function deriveEd25519Path(
  seed: Uint8Array,
  path: string,
): { privateKey: Uint8Array; chainCode: Uint8Array } {
  const master = createHmac("sha512", ED25519_MASTER_KEY).update(seed).digest();
  let privateKey = Uint8Array.from(master.subarray(0, 32));
  let chainCode = Uint8Array.from(master.subarray(32));
  master.fill(0);

  for (const index of parseEd25519Path(path)) {
    const data = new Uint8Array(1 + 32 + 4);
    data.set(privateKey, 1);
    new DataView(data.buffer).setUint32(33, index, false);
    const child = createHmac("sha512", chainCode).update(data).digest();
    data.fill(0);
    privateKey.fill(0);
    chainCode.fill(0);
    privateKey = Uint8Array.from(child.subarray(0, 32));
    chainCode = Uint8Array.from(child.subarray(32));
    child.fill(0);
  }

  return { privateKey, chainCode };
}

function parseEd25519Path(path: string): number[] {
  const segments = path.split("/");
  if (segments.shift() !== "m") {
    throw new KeystoreError(`Derivation path ${path} must start with m.`);
  }
  return segments.map((segment) => {
    const hardened = /^\d+['h]$/u.test(segment);
    if (!hardened) {
      throw new KeystoreError(`Ed25519 derivation supports hardened path segments only: ${path}.`);
    }
    const value = Number(segment.slice(0, -1));
    if (!Number.isSafeInteger(value) || value >= HARDENED_OFFSET) {
      throw new KeystoreError(`Derivation path ${path} has an out-of-range segment.`);
    }
    return value + HARDENED_OFFSET;
  });
}
