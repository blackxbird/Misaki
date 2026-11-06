import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stdin, stderr } from "node:process";

import {
  createKeyPairSignerFromPrivateKeyBytes,
  getBase58Decoder,
  getBase58Encoder,
  type KeyPairSigner,
} from "@solana/kit";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import type { Hex } from "viem";

import { getVapiPaths, isMissingFile, migrateLegacyVapiHome } from "./config.js";
import { KeystoreError } from "./keystore-error.js";
import {
  deriveEvmPrivateKey,
  deriveSolanaPrivateKey,
  entropyToPhrase,
  EVM_DERIVATION_PATH,
  generateRecoveryPhrase,
  phraseToEntropy,
  phraseToSeed,
  SOLANA_DERIVATION_PATH,
  validateRecoveryPhrase,
} from "./hd.js";

export { KeystoreError } from "./keystore-error.js";

const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const AUTH_TAG_LENGTH = 16;

const cryptoSchema = z.object({
  cipher: z.literal("aes-256-gcm"),
  ciphertext: z.string(),
  iv: z.string(),
  authTag: z.string(),
  kdf: z.literal("scrypt"),
  salt: z.string(),
  kdfParams: z.object({
    n: z.literal(SCRYPT_N),
    r: z.literal(SCRYPT_R),
    p: z.literal(SCRYPT_P),
    dkLen: z.literal(KEY_LENGTH),
  }),
});

const legacyKeystoreSchema = z.object({
  version: z.literal(1),
  address: z.string(),
  crypto: cryptoSchema,
});

const keystoreSchema = z.object({
  version: z.literal(2),
  address: z.string(),
  keys: z.object({
    evm: z.object({
      type: z.literal("secp256k1"),
      address: z.string(),
    }),
    solana: z
      .object({
        type: z.literal("ed25519"),
        address: z.string(),
      })
      .optional(),
  }),
  crypto: cryptoSchema,
});

const keystoreV3Schema = z.object({
  version: z.literal(3),
  address: z.string(),
  keys: z.object({
    evm: z.object({
      type: z.literal("secp256k1"),
      address: z.string(),
      path: z.string(),
    }),
    solana: z
      .object({
        type: z.literal("ed25519"),
        address: z.string(),
        path: z.string(),
      })
      .optional(),
  }),
  crypto: cryptoSchema,
});

export type VapiKeystore = z.infer<typeof keystoreSchema>;
/** Keystore version 3: one BIP-39 recovery phrase behind both accounts. */
export type VapiKeystoreV3 = z.infer<typeof keystoreV3Schema>;
export type LegacyVapiKeystore = z.infer<typeof legacyKeystoreSchema>;
/** @deprecated Use VapiKeystore. */
export type AgentCashKeystore = VapiKeystore;

export type VapiPaymentAccount = ReturnType<typeof privateKeyToAccount> & {
  readonly solana?: KeyPairSigner;
};

/** Published only for in-package use and deliberately absent from index.ts. */
export type SealedBytes = { nonce: Buffer; ciphertext: Buffer; tag: Buffer };

type AnyVapiKeystore = VapiKeystore | LegacyVapiKeystore | VapiKeystoreV3;

const encryptedKeysSchema = z.object({
  keys: z.object({
    evm: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    solana: z.string().optional(),
  }),
});

const encryptedEntropySchema = z.object({ entropy: z.string() });

type EncryptedKeys = z.infer<typeof encryptedKeysSchema>["keys"];

/**
 * What a passphrase opens: the usable private keys, plus the BIP-39 entropy for
 * a version 3 file so the phrase can be shown again. Callers zero the entropy.
 */
type UnlockedKeystore = { keys: EncryptedKeys; entropy?: Buffer };

export type CreateKeystoreOptions = {
  enableSolana?: boolean;
  /** Restore an existing wallet instead of generating a new phrase. */
  phrase?: string;
};

/**
 * AES-256-GCM encryption with a fresh 12-byte nonce and a 16-byte tag.
 * Published only for in-package use and deliberately absent from index.ts.
 */
export function encryptWithKey(key: Uint8Array, plaintext: Uint8Array): SealedBytes {
  if (key.byteLength !== KEY_LENGTH) {
    throw new Error(`Expected a ${KEY_LENGTH}-byte AES-256-GCM key.`);
  }
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, ciphertext, tag: cipher.getAuthTag() };
}

/**
 * Decrypts bytes produced by encryptWithKey and rejects invalid AES-GCM parameters.
 * Published only for in-package use and deliberately absent from index.ts.
 */
export function decryptWithKey(key: Uint8Array, sealed: SealedBytes): Buffer {
  if (key.byteLength !== KEY_LENGTH) {
    throw new Error(`Expected a ${KEY_LENGTH}-byte AES-256-GCM key.`);
  }
  if (sealed.nonce.byteLength !== 12) {
    throw new Error("Expected a 12-byte AES-GCM nonce.");
  }
  if (sealed.tag.byteLength !== AUTH_TAG_LENGTH) {
    throw new Error(`Expected a ${AUTH_TAG_LENGTH}-byte AES-GCM authentication tag.`);
  }
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.nonce, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
}

/**
 * Derives the keystore's 32-byte scrypt key with its fixed cost parameters.
 * Published only for in-package use and deliberately absent from index.ts.
 */
export async function deriveScryptKey(passphrase: string, salt: Uint8Array): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    scrypt(
      passphrase,
      salt,
      KEY_LENGTH,
      {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        maxmem: SCRYPT_MAX_MEMORY,
      },
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(derivedKey);
      },
    );
  });
}

export async function encryptPrivateKey(
  privateKey: Hex,
  passphrase: string,
): Promise<VapiKeystore> {
  return await encryptKeys({ evm: privateKey }, passphrase);
}

async function encryptKeys(keys: EncryptedKeys, passphrase: string): Promise<VapiKeystore> {
  const crypto = await sealPlaintext(JSON.stringify({ keys }), passphrase);
  const account = privateKeyToAccount(keys.evm as Hex);
  const solana = keys.solana
    ? await createSolanaSigner(Buffer.from(keys.solana, "base64"))
    : undefined;

  return {
    version: 2,
    address: account.address,
    keys: {
      evm: { type: "secp256k1", address: account.address },
      ...(solana ? { solana: { type: "ed25519", address: solana.address } } : {}),
    },
    crypto,
  };
}

/**
 * Version 3 stores the BIP-39 entropy, never the derived keys: one phrase backs
 * up both accounts and `vapi backup` can show the words again. The addresses
 * are derived here so the file names the wallet without the passphrase.
 */
async function encryptEntropy(
  entropy: Uint8Array,
  passphrase: string,
  options: { enableSolana?: boolean } = {},
): Promise<VapiKeystoreV3> {
  if (entropy.byteLength !== 16 && entropy.byteLength !== 32) {
    throw new KeystoreError("A recovery phrase carries either 16 or 32 bytes of entropy.");
  }
  const seed = phraseToSeed(entropyToPhrase(entropy));
  let evmAddress: string;
  let solanaAddress: string | undefined;
  try {
    evmAddress = privateKeyToAccount(deriveEvmPrivateKey(seed, EVM_DERIVATION_PATH)).address;
    if (options.enableSolana) {
      // createSolanaSigner zeroes the seed it is handed.
      solanaAddress = (
        await createSolanaSigner(deriveSolanaPrivateKey(seed, SOLANA_DERIVATION_PATH))
      ).address;
    }
  } finally {
    seed.fill(0);
  }

  const crypto = await sealPlaintext(
    JSON.stringify({ entropy: Buffer.from(entropy).toString("base64") }),
    passphrase,
  );

  return {
    version: 3,
    address: evmAddress,
    keys: {
      evm: { type: "secp256k1", address: evmAddress, path: EVM_DERIVATION_PATH },
      ...(solanaAddress
        ? {
            solana: {
              type: "ed25519" as const,
              address: solanaAddress,
              path: SOLANA_DERIVATION_PATH,
            },
          }
        : {}),
    },
    crypto,
  };
}

async function sealPlaintext(
  plaintext: string,
  passphrase: string,
): Promise<VapiKeystore["crypto"]> {
  if (passphrase.length === 0) {
    throw new KeystoreError("Keystore passphrase cannot be empty.");
  }

  const salt = randomBytes(32);
  const key = await deriveScryptKey(passphrase, salt);
  try {
    const sealed = encryptWithKey(key, Buffer.from(plaintext, "utf8"));
    return {
      cipher: "aes-256-gcm",
      ciphertext: sealed.ciphertext.toString("base64"),
      iv: sealed.nonce.toString("base64"),
      authTag: sealed.tag.toString("base64"),
      kdf: "scrypt",
      salt: salt.toString("base64"),
      kdfParams: {
        n: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        dkLen: KEY_LENGTH,
      },
    };
  } finally {
    key.fill(0);
  }
}

/** Published only through `@vapi-network/core/secrets`. */
export async function decryptPrivateKey(
  keystore: VapiKeystore | VapiKeystoreV3 | LegacyVapiKeystore,
  passphrase: string,
): Promise<Hex> {
  return (await decryptKeys(keystore, passphrase)).evm as Hex;
}

async function decryptKeys(keystore: AnyVapiKeystore, passphrase: string): Promise<EncryptedKeys> {
  const unlocked = await decryptSecret(keystore, passphrase);
  unlocked.entropy?.fill(0);
  return unlocked.keys;
}

async function decryptSecret(
  keystore: AnyVapiKeystore,
  passphrase: string,
): Promise<UnlockedKeystore> {
  const parsed = parseAnyKeystore(keystore);
  const salt = Buffer.from(parsed.crypto.salt, "base64");
  const iv = Buffer.from(parsed.crypto.iv, "base64");
  const authTag = Buffer.from(parsed.crypto.authTag, "base64");
  const ciphertext = Buffer.from(parsed.crypto.ciphertext, "base64");
  const key = await deriveScryptKey(passphrase, salt);
  let unlocked: UnlockedKeystore | undefined;

  try {
    const plaintext = decryptWithKey(key, {
      nonce: iv,
      ciphertext,
      tag: authTag,
    }).toString("utf8");
    unlocked =
      parsed.version === 3
        ? keysFromEntropy(parsed, plaintext)
        : {
            keys:
              parsed.version === 1
                ? ({ evm: `0x${plaintext}` } satisfies EncryptedKeys)
                : encryptedKeysSchema.parse(JSON.parse(plaintext)).keys,
          };
    const keys = unlocked.keys;
    const account = privateKeyToAccount(keys.evm as Hex);
    if (account.address.toLowerCase() !== parsed.address.toLowerCase()) {
      throw new Error("Decrypted key does not match the stored address.");
    }
    if (
      parsed.version !== 1 &&
      parsed.keys.evm.address.toLowerCase() !== account.address.toLowerCase()
    ) {
      throw new Error("Decrypted EVM key does not match the stored key metadata.");
    }
    if (parsed.version !== 1 && Boolean(parsed.keys.solana) !== Boolean(keys.solana)) {
      throw new Error("Encrypted Solana key does not match the stored key metadata.");
    }
    if (keys.solana) {
      const signer = await createSolanaSigner(Buffer.from(keys.solana, "base64"));
      if (parsed.version !== 1 && parsed.keys.solana?.address !== signer.address) {
        throw new Error("Decrypted Solana key does not match the stored key metadata.");
      }
    }
    return unlocked;
  } catch (error) {
    unlocked?.entropy?.fill(0);
    throw new KeystoreError("Unable to unlock keystore: wrong passphrase or corrupt file.", {
      cause: error,
    });
  } finally {
    key.fill(0);
  }
}

/**
 * Rebuilds both private keys from the stored BIP-39 entropy. Nothing derived
 * here outlives the unlock: the seed is zeroed before the keys are returned.
 */
function keysFromEntropy(keystore: VapiKeystoreV3, plaintext: string): UnlockedKeystore {
  const entropy = Buffer.from(
    encryptedEntropySchema.parse(JSON.parse(plaintext)).entropy,
    "base64",
  );
  if (entropy.byteLength !== 16 && entropy.byteLength !== 32) {
    throw new Error("Stored recovery entropy must contain 16 or 32 bytes.");
  }
  const seed = phraseToSeed(entropyToPhrase(Uint8Array.from(entropy)));
  try {
    const keys: EncryptedKeys = { evm: deriveEvmPrivateKey(seed, keystore.keys.evm.path) };
    if (keystore.keys.solana) {
      const solanaSeed = deriveSolanaPrivateKey(seed, keystore.keys.solana.path);
      keys.solana = Buffer.from(solanaSeed).toString("base64");
      solanaSeed.fill(0);
    }
    return { keys, entropy };
  } finally {
    seed.fill(0);
  }
}

/**
 * Creates a version 3 keystore: both accounts come from one BIP-39 recovery
 * phrase, so the wallet can be restored in MetaMask, Rabby or Phantom from the
 * words alone. The phrase is returned once and never written anywhere.
 *
 * Published only through `@vapi-network/core/secrets`.
 */
export async function createKeystoreWithPhrase(
  passphrase: string,
  path = getVapiPaths().keystore,
  options: CreateKeystoreOptions = {},
): Promise<{ account: VapiPaymentAccount; recoveryPhrase: string }> {
  await refuseExistingKeystore(path);

  const recoveryPhrase =
    options.phrase === undefined
      ? generateRecoveryPhrase()
      : validateRecoveryPhrase(options.phrase);
  const entropy = phraseToEntropy(recoveryPhrase);
  let keystore: VapiKeystoreV3;
  try {
    keystore = await encryptEntropy(entropy, passphrase, {
      enableSolana: options.enableSolana === true,
    });
  } finally {
    entropy.fill(0);
  }
  await writeKeystore(path, keystore, true);
  return {
    account: await paymentAccountFromKeys(await decryptKeys(keystore, passphrase)),
    recoveryPhrase,
  };
}

/** A new keystore may never overwrite the wallet a passphrase already opens. */
async function refuseExistingKeystore(path: string): Promise<void> {
  if (!process.env.VAPI_HOME?.trim() && path === getVapiPaths().keystore) {
    await migrateLegacyVapiHome({ targetDirectory: getVapiPaths().directory });
  }
  try {
    await stat(path);
    throw new KeystoreError(
      `Keystore already exists at ${path}. Refusing to replace the local payment key.`,
    );
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
}

/**
 * Wraps a private key the user already holds in a version 2 keystore, for
 * `vapi import --key`. Such a wallet has no recovery phrase, so `vapi backup`
 * keeps pointing at `vapi export-key` for it.
 */
export async function createKeystoreFromPrivateKey(
  passphrase: string,
  path = getVapiPaths().keystore,
  options: { privateKey: string },
): Promise<VapiPaymentAccount> {
  const privateKey = validatePrivateKey(options.privateKey);
  await refuseExistingKeystore(path);
  const keys: EncryptedKeys = { evm: privateKey };
  await writeKeystore(path, await encryptKeys(keys, passphrase), true);
  return await paymentAccountFromKeys(keys);
}

/** The shape every wallet import accepts: 0x and 32 bytes of hexadecimal. */
export function validatePrivateKey(value: string): Hex {
  const normalized = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/u.test(normalized)) {
    throw new KeystoreError(
      "A private key is 0x followed by 64 hexadecimal characters. Check for a missing character.",
    );
  }
  return normalized as Hex;
}

/**
 * Re-seals the keystore under a new passphrase: fresh salt and IV, the same
 * keys, the same addresses, and the same atomic write as every other keystore
 * change. A version 1 file becomes version 2, the upgrade `unlockKeystore`
 * already performs.
 */
export async function changeKeystorePassphrase(
  oldPassphrase: string,
  newPassphrase: string,
  path = getVapiPaths().keystore,
): Promise<VapiPaymentAccount> {
  if (newPassphrase.length === 0) {
    throw new KeystoreError("Keystore passphrase cannot be empty.");
  }
  const existing = await readStoredKeystore(path);
  const unlocked = await decryptSecret(existing, oldPassphrase);
  try {
    const resealed =
      existing.version === 3
        ? await encryptEntropy(unlocked.entropy!, newPassphrase, {
            enableSolana: Boolean(existing.keys.solana),
          })
        : await encryptKeys(unlocked.keys, newPassphrase);
    const previousSolana = existing.version === 1 ? undefined : existing.keys.solana?.address;
    if (resealed.address !== existing.address || resealed.keys.solana?.address !== previousSolana) {
      throw new KeystoreError(
        "Re-encrypting the keystore would change its addresses. Nothing was written.",
      );
    }
    await writeKeystore(path, resealed, false);
    return await paymentAccountFromKeys(unlocked.keys);
  } finally {
    unlocked.entropy?.fill(0);
  }
}

/** `createKeystoreWithPhrase` for callers that do not show the phrase. */
export async function createKeystore(
  passphrase: string,
  path = getVapiPaths().keystore,
  options: CreateKeystoreOptions = {},
): Promise<VapiPaymentAccount> {
  return (await createKeystoreWithPhrase(passphrase, path, options)).account;
}

export async function unlockKeystore(
  passphrase: string,
  path = getVapiPaths().keystore,
): Promise<VapiPaymentAccount> {
  if (!process.env.VAPI_HOME?.trim() && path === getVapiPaths().keystore) {
    await migrateLegacyVapiHome({ targetDirectory: getVapiPaths().directory });
  }
  const keystore = await readStoredKeystore(path);
  const unlocked = await decryptSecret(keystore, passphrase);
  try {
    if (keystore.version === 1) {
      await writeKeystore(path, await encryptKeys(unlocked.keys, passphrase), false);
    }
    return await paymentAccountFromKeys(unlocked.keys);
  } finally {
    unlocked.entropy?.fill(0);
  }
}

async function readStoredKeystore(path: string): Promise<AnyVapiKeystore> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      throw new KeystoreError(`No vAPI keystore found at ${path}. Run vapi init.`);
    }
    throw error;
  }
  return parseAnyKeystore(JSON.parse(raw));
}

/**
 * The stored address, read without the passphrase. Only the encrypted key
 * material needs the passphrase, so `vapi init` can name the wallet it refuses
 * to replace. Returns undefined for a missing or unreadable keystore.
 */
export async function readKeystoreAddress(
  path = getVapiPaths().keystore,
): Promise<string | undefined> {
  const field = await readKeystoreField(path, "address");
  return typeof field === "string" ? field : undefined;
}

/**
 * The stored format version, read without the passphrase, so a command can say
 * why a version 1 or 2 wallet has no recovery phrase. Undefined for a missing
 * or unreadable keystore.
 */
export async function readKeystoreVersion(
  path = getVapiPaths().keystore,
): Promise<number | undefined> {
  const field = await readKeystoreField(path, "version");
  return typeof field === "number" ? field : undefined;
}

async function readKeystoreField(path: string, field: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, field) : undefined;
}

export type ExportedVapiKeys = {
  evm: { address: string; privateKey: Hex };
  solana?: { address: string; secretKey: string };
};

/**
 * Decrypts the keystore into the formats other wallets import: 0x-prefixed hex
 * for the EVM key, and the base58 64-byte Ed25519 secret key for Solana. Only
 * `vapi export-key` may call this, and it must never write the result anywhere
 * but the caller's stdout.
 *
 * Published only through `@vapi-network/core/secrets`.
 */
export async function exportKeystoreKeys(
  passphrase: string,
  path = getVapiPaths().keystore,
): Promise<ExportedVapiKeys> {
  const keys = await decryptKeys(await readStoredKeystore(path), passphrase);
  const evmPrivateKey = keys.evm as Hex;
  const exported: ExportedVapiKeys = {
    evm: { address: privateKeyToAccount(evmPrivateKey).address, privateKey: evmPrivateKey },
  };
  if (!keys.solana) return exported;

  const seed = Uint8Array.from(Buffer.from(keys.solana, "base64"));
  // createSolanaSigner zeroes the buffer it is handed, so it gets a copy.
  const signer = await createSolanaSigner(Uint8Array.from(seed));
  const publicKey = Uint8Array.from(getBase58Encoder().encode(signer.address));
  const secretKey = new Uint8Array(seed.length + publicKey.length);
  secretKey.set(seed);
  secretKey.set(publicKey, seed.length);
  const encoded = getBase58Decoder().decode(secretKey);
  seed.fill(0);
  secretKey.fill(0);
  return { ...exported, solana: { address: signer.address, secretKey: encoded } };
}

/**
 * Adds the Solana account. A version 3 wallet derives it from the recovery
 * phrase it already has; older files get a locally generated Ed25519 seed,
 * which the EVM key never replaces.
 */
export async function enableSolanaKey(
  passphrase: string,
  path = getVapiPaths().keystore,
): Promise<VapiPaymentAccount> {
  const existing = await readStoredKeystore(path);
  const unlocked = await decryptSecret(existing, passphrase);
  try {
    if (existing.version === 3) {
      if (unlocked.keys.solana) {
        return await paymentAccountFromKeys(unlocked.keys);
      }
      const updated = await encryptEntropy(unlocked.entropy!, passphrase, { enableSolana: true });
      await writeKeystore(path, updated, false);
      return await paymentAccountFromKeys(await decryptKeys(updated, passphrase));
    }

    const keys = unlocked.keys;
    if (!keys.solana) {
      const seed = randomBytes(32);
      keys.solana = seed.toString("base64");
      seed.fill(0);
      await writeKeystore(path, await encryptKeys(keys, passphrase), false);
    } else if (existing.version === 1) {
      await writeKeystore(path, await encryptKeys(keys, passphrase), false);
    }
    return await paymentAccountFromKeys(keys);
  } finally {
    unlocked.entropy?.fill(0);
  }
}

/**
 * The 12 or 24 words behind a version 3 wallet, for `vapi backup`. Callers must
 * print it to the user and nowhere else. Older keystores have no phrase.
 *
 * Published only through `@vapi-network/core/secrets`.
 */
export async function exportRecoveryPhrase(
  passphrase: string,
  path = getVapiPaths().keystore,
): Promise<string> {
  const keystore = await readStoredKeystore(path);
  if (keystore.version !== 3) {
    throw new KeystoreError(
      `This wallet was created before recovery phrases (keystore version ${keystore.version}), so it has no words to write down. Back it up with vapi export-key instead.`,
    );
  }
  const unlocked = await decryptSecret(keystore, passphrase);
  try {
    return entropyToPhrase(Uint8Array.from(unlocked.entropy!));
  } finally {
    unlocked.entropy?.fill(0);
  }
}

export function parseAnyKeystore(value: unknown): AnyVapiKeystore {
  const version =
    typeof value === "object" && value !== null ? Reflect.get(value, "version") : undefined;
  if (version === 1) return legacyKeystoreSchema.parse(value);
  if (version === 3) return keystoreV3Schema.parse(value);
  return keystoreSchema.parse(value);
}

async function paymentAccountFromKeys(keys: EncryptedKeys): Promise<VapiPaymentAccount> {
  const account = privateKeyToAccount(keys.evm as Hex) as VapiPaymentAccount;
  if (keys.solana) {
    const solana = await createSolanaSigner(Buffer.from(keys.solana, "base64"));
    Object.defineProperty(account, "solana", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: solana,
    });
  }
  return account;
}

async function createSolanaSigner(seed: Uint8Array): Promise<KeyPairSigner> {
  if (seed.byteLength !== 32) {
    throw new Error("Stored Solana Ed25519 seed must contain exactly 32 bytes.");
  }
  const privateKey = new Uint8Array(seed);
  try {
    return await createKeyPairSignerFromPrivateKeyBytes(privateKey);
  } finally {
    privateKey.fill(0);
    seed.fill(0);
  }
}

async function writeKeystore(
  path: string,
  keystore: VapiKeystore | VapiKeystoreV3,
  exclusive: boolean,
) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(keystore, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  if (exclusive) {
    try {
      await stat(path);
      throw new KeystoreError(
        `Keystore already exists at ${path}. Refusing to replace the local payment key.`,
      );
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
  await rename(temporaryPath, path);
}

export async function getKeystorePassphrase(options?: { confirm?: boolean }): Promise<string> {
  const fromEnvironment = process.env.VAPI_KEYSTORE_PASSWORD;
  if (fromEnvironment !== undefined) {
    if (fromEnvironment.length === 0) {
      throw new KeystoreError("VAPI_KEYSTORE_PASSWORD cannot be empty.");
    }
    return fromEnvironment;
  }

  const first = await promptForSecret("Keystore passphrase: ", "Set VAPI_KEYSTORE_PASSWORD.");
  if (!first) {
    throw new KeystoreError("Keystore passphrase cannot be empty.");
  }
  if (options?.confirm) {
    const second = await promptForSecret("Confirm passphrase: ", "Set VAPI_KEYSTORE_PASSWORD.");
    if (first !== second) {
      throw new KeystoreError("Passphrases do not match.");
    }
  }
  return first;
}

/**
 * Reads one line from the terminal without echoing it, for passphrases,
 * recovery phrases, and private keys. The prompt goes to stderr so stdout stays
 * a clean channel, and the secret never reaches the terminal's scrollback.
 */
export async function promptForSecret(prompt: string, noTerminalHint?: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new KeystoreError(
      `No interactive terminal is available for the keystore prompt.${
        noTerminalHint === undefined ? "" : ` ${noTerminalHint}`
      }`,
    );
  }

  stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          reject(new KeystoreError("Passphrase prompt cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") {
          value += character;
        }
      }
    };
    stdin.on("data", onData);
  });
}
