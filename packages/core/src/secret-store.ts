import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join, win32 } from "node:path";

import { KeystoreError } from "./keystore.js";

/**
 * The OS secret store, so an agent never needs a passphrase in plain text.
 *
 * A wallet's passphrase is kept by the operating system's own credential
 * store — the macOS Keychain, Windows Data Protection, or libsecret on Linux —
 * under the service `vapi-network` and the wallet's name as the account. The
 * unlock command puts it there, the lock command takes it out, and every unlock
 * path reads it from there before falling back to a prompt.
 *
 * There is no dependency: the store is driven through the OS binaries with
 * `spawn` and an argument array, never a shell string, so nothing a wallet
 * name or a passphrase contains can be read as a command. The passphrase
 * itself is written to the binary's stdin and never appears in an argument,
 * where `ps` would show it to every process on the machine.
 */

/** The service name every vAPI entry is filed under. */
export const SECRET_STORE_SERVICE = "vapi-network";

/** The macOS binary, by absolute path: a credential store is not worth a PATH lookup. */
const SECURITY_BINARY = "/usr/bin/security";
const SECRET_TOOL_BINARY = "secret-tool";
const WINDOWS_POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-Command", "-"] as const;

/** `security` says 44 when the keychain holds no such item. */
const SECURITY_ITEM_NOT_FOUND = 44;
/** PowerShell exit codes used by every Windows secret-store script. */
const WINDOWS_SECRET_SUCCESS = 0;
const WINDOWS_SECRET_NOT_FOUND = 2;

const UNSUPPORTED_PLATFORM = "No OS secret store on this platform yet; use VAPI_KEYSTORE_PASSWORD.";

const SECRET_TOOL_MISSING = [
  "secret-tool is not installed, so the passphrase cannot be kept in the OS secret store.",
  "Install libsecret-tools (Debian, Ubuntu) or libsecret (Fedora, Arch), or use VAPI_KEYSTORE_PASSWORD.",
].join(" ");

const POWERSHELL_MISSING = [
  "Windows PowerShell (powershell.exe) was not found, so the passphrase cannot be kept in the OS secret store.",
  "Use VAPI_KEYSTORE_PASSWORD.",
].join(" ");

/** What one run of an OS binary produced. A runner never throws for a non-zero exit. */
export type SecretStoreOutcome = {
  /** The exit code, or null when the binary could not be run at all. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** The binary is not installed on this machine. */
  notFound?: boolean;
};

/**
 * Runs one OS binary. Injected by the tests, which assert the command line
 * rather than touching a real keychain.
 */
export type SecretStoreRunner = (
  file: string,
  args: readonly string[],
  input?: string,
) => Promise<SecretStoreOutcome>;

export type SecretStore = {
  /** Whether this platform has a store vAPI can drive at all. */
  available: boolean;
  platform: NodeJS.Platform;
  /** How to name this store to a person, such as "the macOS Keychain". */
  description: string;
  /** The stored passphrase of a wallet, or undefined when there is none. */
  get(name: string): Promise<string | undefined>;
  /** Whether a wallet has a stored passphrase, without reading the secret. */
  has(name: string): Promise<boolean>;
  set(name: string, passphrase: string): Promise<void>;
  /** Removes the entry; false when there was nothing to remove. */
  remove(name: string): Promise<boolean>;
  /**
   * The wallet names this store holds, where the platform can answer it
   * without handing back the secrets themselves. Neither platform can today,
   * so callers list the wallets they know and ask `has` about each.
   */
  list?(): Promise<string[]>;
};

export type SecretStoreOptions = {
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform | undefined;
  /** Defaults to running the real binary. */
  run?: SecretStoreRunner | undefined;
  /** Defaults to `process.env`; the Windows store reads `SystemRoot` and the PATH scan reads `PATH` from it. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Whether a binary is on this machine; decides `available`. Defaults to an `existsSync` / PATH scan. */
  installed?: ((file: string) => boolean) | undefined;
};

/** The secret store of this machine, or one that refuses on every call. */
export function secretStore(options: SecretStoreOptions = {}): SecretStore {
  const platform = options.platform ?? process.platform;
  const run: SecretStoreRunner =
    options.run ?? (async (file, args, input) => await spawnRunner(platform, file, args, input));
  const env = options.env ?? process.env;
  const installed = options.installed ?? ((file: string) => binaryInstalled(file, env));
  if (platform === "darwin") return keychainStore(platform, run);
  if (platform === "win32") return windowsDataProtectionStore(platform, run, env, installed);
  if (platform === "linux") return libsecretStore(platform, run, installed);
  return unsupportedStore(platform);
}

/**
 * A secret store held in a `Map`, for tests and for a process that is handed
 * its credentials rather than reading them from the OS. It never runs a
 * binary and forgets everything when the process ends.
 */
export function memorySecretStore(initial: Record<string, string> = {}): SecretStore {
  const entries = new Map<string, string>(Object.entries(initial));
  return {
    available: true,
    platform: process.platform,
    description: "an in-memory store",
    async get(name) {
      return entries.get(name);
    },
    async has(name) {
      return entries.has(name);
    },
    async set(name, passphrase) {
      entries.set(name, passphrase);
    },
    async remove(name) {
      return entries.delete(name);
    },
    async list() {
      return [...entries.keys()].sort();
    },
  };
}

/**
 * macOS. The passphrase goes in over stdin: `security add-generic-password`
 * with a bare `-w` asks for the password and its confirmation on stdin, which
 * keeps it out of the argument list that `ps` publishes. `-U` updates the
 * entry when the wallet already has one.
 */
function keychainStore(platform: NodeJS.Platform, run: SecretStoreRunner): SecretStore {
  const find = async (account: string, withPassword: boolean): Promise<SecretStoreOutcome> =>
    await run(SECURITY_BINARY, [
      "find-generic-password",
      "-a",
      account,
      "-s",
      SECRET_STORE_SERVICE,
      ...(withPassword ? ["-w"] : []),
    ]);

  const read = async (account: string, what: string): Promise<string | undefined> => {
    const result = await find(account, true);
    if (result.code === SECURITY_ITEM_NOT_FOUND) return undefined;
    requireSuccess(result, what);
    const value = withoutTrailingNewline(result.stdout);
    return value.length === 0 ? undefined : value;
  };

  const write = async (account: string, value: string, what: string): Promise<void> => {
    const result = await run(
      SECURITY_BINARY,
      [
        "add-generic-password",
        "-a",
        account,
        "-s",
        SECRET_STORE_SERVICE,
        "-l",
        `${SECRET_STORE_SERVICE} ${account}`,
        "-U",
        "-w",
      ],
      // `security` asks for the password and then for its confirmation.
      `${value}\n${value}\n`,
    );
    requireSuccess(result, what);
  };

  const erase = async (account: string, what: string): Promise<boolean> => {
    const result = await run(SECURITY_BINARY, [
      "delete-generic-password",
      "-a",
      account,
      "-s",
      SECRET_STORE_SERVICE,
    ]);
    if (result.code === SECURITY_ITEM_NOT_FOUND) return false;
    requireSuccess(result, what);
    return true;
  };

  /** Deletes the parts after `keep`, until the first one that is not there. */
  const erasePartsAfter = async (account: string, keep: number, what: string): Promise<void> => {
    for (let part = keep + 1; part <= MAX_KEYCHAIN_PARTS; part += 1) {
      if (!(await erase(keychainPart(account, part), what))) return;
    }
  };

  return {
    available: true,
    platform,
    description: "the macOS Keychain",
    async get(name) {
      const account = accountFor(name);
      const what = `read the passphrase of ${name} from the macOS Keychain`;
      const value = await read(account, what);
      const parts = value === undefined ? undefined : chunkedPartCount(value);
      if (value === undefined || parts === undefined) return value;
      let joined = "";
      for (let part = 1; part <= parts; part += 1) {
        const chunk = await read(keychainPart(account, part), what);
        if (chunk === undefined) {
          throw new KeystoreError(
            `The stored secret ${name} is incomplete in the macOS Keychain. Store it again.`,
          );
        }
        joined += chunk;
      }
      return joined;
    },
    async has(name) {
      const result = await find(accountFor(name), false);
      if (result.code === SECURITY_ITEM_NOT_FOUND) return false;
      requireSuccess(result, `look up ${name} in the macOS Keychain`);
      return true;
    },
    async set(name, passphrase) {
      requirePassphrase(passphrase);
      const account = accountFor(name);
      const what = `store the passphrase of ${name} in the macOS Keychain`;
      if (passphrase.length <= KEYCHAIN_PROMPT_LIMIT) {
        await write(account, passphrase, what);
        return;
      }
      // `security -w` reads at most 128 characters from its prompt and drops
      // the rest without an error, so a longer value is stored in parts.
      const chunks: string[] = [];
      for (let index = 0; index < passphrase.length; index += KEYCHAIN_CHUNK) {
        chunks.push(passphrase.slice(index, index + KEYCHAIN_CHUNK));
      }
      if (chunks.length > MAX_KEYCHAIN_PARTS) {
        throw new KeystoreError(`The secret ${name} is too long for the macOS Keychain.`);
      }
      for (const [index, chunk] of chunks.entries()) {
        await write(keychainPart(account, index + 1), chunk, what);
      }
      await erasePartsAfter(account, chunks.length, what);
      await write(account, `${CHUNKED_MARKER}${chunks.length}`, what);
    },
    async remove(name) {
      const account = accountFor(name);
      const what = `remove the passphrase of ${name} from the macOS Keychain`;
      const found = await find(account, true);
      if (found.code === SECURITY_ITEM_NOT_FOUND) return false;
      requireSuccess(found, what);
      if (chunkedPartCount(withoutTrailingNewline(found.stdout)) !== undefined) {
        await erasePartsAfter(account, 0, what);
      }
      return await erase(account, what);
    },
  };
}

/** The longest value `security -w` accepts from its prompt. */
const KEYCHAIN_PROMPT_LIMIT = 128;
const KEYCHAIN_CHUNK = 120;
const MAX_KEYCHAIN_PARTS = 32;
const CHUNKED_MARKER = "vapi-chunked:v1:";

function keychainPart(account: string, part: number): string {
  return `${account}#${part}`;
}

function chunkedPartCount(value: string): number | undefined {
  if (!value.startsWith(CHUNKED_MARKER)) return undefined;
  const parts = Number(value.slice(CHUNKED_MARKER.length));
  return Number.isInteger(parts) && parts > 0 && parts <= MAX_KEYCHAIN_PARTS ? parts : undefined;
}

/**
 * Maps an account to its Windows secret filename without case-insensitive
 * collisions. Only `[a-z0-9._#-]` is emitted verbatim; every other UTF-16 code
 * unit becomes an uppercase `%XXXX` escape. Encoding code units also keeps
 * malformed Unicode strings distinct. The resulting alphabet is safe to embed
 * in a single-quoted PowerShell literal.
 */
export function windowsSecretFileName(account: string): string {
  let encoded = "";
  for (let index = 0; index < account.length; index += 1) {
    const character = account[index]!;
    if (/^[a-z0-9._#-]$/u.test(character)) {
      encoded += character;
      continue;
    }
    encoded += `%${account.charCodeAt(index).toString(16).toUpperCase().padStart(4, "0")}`;
  }
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(encoded)) {
    encoded = `%${encoded.charCodeAt(0).toString(16).toUpperCase()}${encoded.slice(1)}`;
  }
  return `${encoded}.bin`;
}

/** Windows, through per-user DPAPI blobs driven by Windows PowerShell. */
function windowsDataProtectionStore(
  platform: NodeJS.Platform,
  run: SecretStoreRunner,
  env: NodeJS.ProcessEnv,
  installed: (file: string) => boolean,
): SecretStore {
  const powershell = `${env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

  const fileDetails = (name: string): { file: string; account: string } => {
    const file = windowsSecretFileName(accountFor(name));
    return { file, account: file.slice(0, -".bin".length) };
  };

  const script = (file: string, operations: readonly string[]): string =>
    [
      "$ErrorActionPreference = 'Stop'",
      "try {",
      "  Add-Type -AssemblyName System.Security",
      "  $dir = Join-Path $env:LOCALAPPDATA 'vapi-network\\secrets'",
      `  $path = Join-Path $dir '${file}'`,
      ...operations.map((operation) => `  ${operation}`),
      "} catch {",
      "  [Console]::Error.WriteLine($_.Exception.Message)",
      "  exit 1",
      "}",
    ].join("\n");

  const execute = async (script: string): Promise<SecretStoreOutcome> => {
    // PowerShell reads stdin like a prompt: a multi-line block only runs once a
    // blank line closes it. Without one it exits 0 and has done nothing.
    const result = await run(powershell, WINDOWS_POWERSHELL_ARGS, `${script}\n\n`);
    requirePowerShell(result);
    return result;
  };

  return {
    available: installed(powershell),
    platform,
    description: "Windows Data Protection (DPAPI)",
    async get(name) {
      const { file, account } = fileDetails(name);
      const result = await execute(
        script(file, [
          `if (-not (Test-Path -LiteralPath $path)) { [Console]::Error.WriteLine('No stored secret for ${account}.'); exit ${WINDOWS_SECRET_NOT_FOUND} }`,
          "$blob = [System.IO.File]::ReadAllBytes($path)",
          "$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
          "[Console]::Out.Write([Convert]::ToBase64String($bytes))",
          `exit ${WINDOWS_SECRET_SUCCESS}`,
        ]),
      );
      if (result.code === WINDOWS_SECRET_NOT_FOUND) return undefined;
      requireSuccess(result, `read the passphrase of ${name} from Windows Data Protection`);
      const value = Buffer.from(result.stdout.trim(), "base64").toString("utf8");
      return value.length === 0 ? undefined : value;
    },
    async has(name) {
      const { file, account } = fileDetails(name);
      const result = await execute(
        script(file, [
          `if (Test-Path -LiteralPath $path) { exit ${WINDOWS_SECRET_SUCCESS} }`,
          `[Console]::Error.WriteLine('No stored secret for ${account}.')`,
          `exit ${WINDOWS_SECRET_NOT_FOUND}`,
        ]),
      );
      if (result.code === WINDOWS_SECRET_SUCCESS) return true;
      if (result.code === WINDOWS_SECRET_NOT_FOUND) return false;
      requireSuccess(result, `look up ${name} in Windows Data Protection`);
      return false;
    },
    async set(name, passphrase) {
      requirePassphrase(passphrase);
      const { file } = fileDetails(name);
      const value = Buffer.from(passphrase, "utf8").toString("base64");
      const result = await execute(
        script(file, [
          "[void][System.IO.Directory]::CreateDirectory($dir)",
          `$bytes = [Convert]::FromBase64String('${value}')`,
          "$blob = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
          "[System.IO.File]::WriteAllBytes($path, $blob)",
          `exit ${WINDOWS_SECRET_SUCCESS}`,
        ]),
      );
      requireSuccess(result, `store the passphrase of ${name} in Windows Data Protection`);
    },
    async remove(name) {
      const { file, account } = fileDetails(name);
      const result = await execute(
        script(file, [
          `if (-not (Test-Path -LiteralPath $path)) { [Console]::Error.WriteLine('No stored secret for ${account}.'); exit ${WINDOWS_SECRET_NOT_FOUND} }`,
          "Remove-Item -LiteralPath $path -Force",
          `exit ${WINDOWS_SECRET_SUCCESS}`,
        ]),
      );
      if (result.code === WINDOWS_SECRET_NOT_FOUND) return false;
      requireSuccess(result, `remove the passphrase of ${name} from Windows Data Protection`);
      return true;
    },
  };
}

/**
 * Linux, through libsecret's `secret-tool`. `store` reads the passphrase from
 * stdin; `lookup` prints it and exits non-zero when there is nothing to find.
 */
function libsecretStore(
  platform: NodeJS.Platform,
  run: SecretStoreRunner,
  installed: (file: string) => boolean,
): SecretStore {
  const lookup = async (name: string): Promise<string | undefined> => {
    const result = await run(SECRET_TOOL_BINARY, [
      "lookup",
      "service",
      SECRET_STORE_SERVICE,
      "account",
      accountFor(name),
    ]);
    requireBinary(result);
    const value = withoutTrailingNewline(result.stdout);
    if (result.code === 0) return value.length === 0 ? undefined : value;
    // secret-tool exits 1 with nothing to say when the item is absent; only a
    // message on stderr means something actually went wrong.
    if (result.stderr.trim().length === 0) return undefined;
    requireSuccess(result, `read the passphrase of ${name} from the secret service`);
    return undefined;
  };

  return {
    available: installed(SECRET_TOOL_BINARY),
    platform,
    description: "the libsecret keyring",
    get: lookup,
    async has(name) {
      return (await lookup(name)) !== undefined;
    },
    async set(name, passphrase) {
      requirePassphrase(passphrase);
      const account = accountFor(name);
      const result = await run(
        SECRET_TOOL_BINARY,
        [
          "store",
          `--label=${SECRET_STORE_SERVICE} ${account}`,
          "service",
          SECRET_STORE_SERVICE,
          "account",
          account,
        ],
        `${passphrase}\n`,
      );
      requireBinary(result);
      requireSuccess(result, `store the passphrase of ${name} in the secret service`);
    },
    async remove(name) {
      // `secret-tool clear` exits 1 with nothing on stderr when the item is
      // absent on some libsecret builds, so — like `lookup` above — only a
      // message on stderr means something actually went wrong. The lookup is
      // what tells a person their passphrase was really there.
      const existed = (await lookup(name)) !== undefined;
      const result = await run(SECRET_TOOL_BINARY, [
        "clear",
        "service",
        SECRET_STORE_SERVICE,
        "account",
        accountFor(name),
      ]);
      requireBinary(result);
      if (result.code === 0) return existed;
      if (result.stderr.trim().length === 0) return existed;
      requireSuccess(result, `remove the passphrase of ${name} from the secret service`);
      return existed;
    },
  };
}

/** Platforms without a supported native store use the environment variable. */
function unsupportedStore(platform: NodeJS.Platform): SecretStore {
  const refuse = (): never => {
    throw new KeystoreError(UNSUPPORTED_PLATFORM);
  };
  return {
    available: false,
    platform,
    description: "no OS secret store",
    get: async () => refuse(),
    has: async () => refuse(),
    set: async () => refuse(),
    remove: async () => refuse(),
  };
}

/** The account a wallet is filed under. Wallet names are already path-safe. */
function accountFor(name: string): string {
  const account = name.trim();
  if (account.length === 0) {
    throw new KeystoreError("A wallet name is needed to reach the OS secret store.");
  }
  return account;
}

function requirePassphrase(passphrase: string): void {
  if (passphrase.length === 0) {
    throw new KeystoreError("Keystore passphrase cannot be empty.");
  }
}

function requireBinary(result: SecretStoreOutcome): void {
  if (result.notFound === true) throw new KeystoreError(SECRET_TOOL_MISSING);
}

function requirePowerShell(result: SecretStoreOutcome): void {
  if (result.notFound === true) throw new KeystoreError(POWERSHELL_MISSING);
}

function binaryInstalled(file: string, env: NodeJS.ProcessEnv): boolean {
  if (isAbsolute(file) || win32.isAbsolute(file)) return existsSync(file);
  return (env.PATH ?? "").split(delimiter).some((directory) => existsSync(join(directory, file)));
}

/** Turns a failed run into one sentence. The passphrase is never in it. */
function requireSuccess(result: SecretStoreOutcome, what: string): void {
  if (result.code === 0) return;
  const detail = result.stderr.trim() || result.stdout.trim();
  throw new KeystoreError(
    `Could not ${what}${result.code === null ? "" : ` (exit ${result.code})`}.${
      detail.length === 0 ? "" : ` ${detail}`
    }`,
  );
}

function withoutTrailingNewline(value: string): string {
  return value.replace(/\r?\n$/u, "");
}

/**
 * Runs the binary with an argument array; the passphrase goes in over stdin.
 *
 * `detached` puts the child in its own session, without a controlling
 * terminal. macOS `security -w` reads the value from `/dev/tty` whenever the
 * process has one, and only falls back to stdin when it does not; without this
 * flag an interactive `vapi unlock` or `vapi login` would stop at the keychain
 * tool's own "password data for new item" prompt and store whatever the user
 * typed there instead of the value the client wrote to the pipe.
 *
 * Windows has no controlling terminal to escape, and there the flag starts the
 * child with no console: PowerShell then exits 0 without running its script.
 */
const spawnRunner = async (
  platform: NodeJS.Platform,
  file: string,
  args: readonly string[],
  input?: string,
): Promise<SecretStoreOutcome> =>
  await new Promise<SecretStoreOutcome>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (outcome: SecretStoreOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const child = spawn(file, [...args], {
      detached: platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({
        code: null,
        stdout,
        stderr,
        ...(error.code === "ENOENT" ? { notFound: true } : {}),
      });
    });
    child.on("close", (code) => finish({ code, stdout, stderr }));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input ?? "");
  });
