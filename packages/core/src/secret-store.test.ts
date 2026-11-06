import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  memorySecretStore,
  secretStore,
  type SecretStoreOutcome,
  type SecretStoreRunner,
  windowsSecretFileName,
} from "./secret-store.js";

type Run = { file: string; args: string[]; input?: string };

/** A runner that answers from a script and records every command line. */
function recordingRunner(answers: Array<Partial<SecretStoreOutcome>>): {
  run: SecretStoreRunner;
  runs: Run[];
} {
  const runs: Run[] = [];
  const queue = [...answers];
  const run: SecretStoreRunner = async (file, args, input) => {
    runs.push({ file, args: [...args], ...(input === undefined ? {} : { input }) });
    const answer = queue.shift() ?? {};
    return { code: 0, stdout: "", stderr: "", ...answer };
  };
  return { run, runs };
}

describe("the macOS keychain store", () => {
  it("stores the passphrase over stdin, never in an argument", async () => {
    const { run, runs } = recordingRunner([{ code: 0 }]);
    const store = secretStore({ platform: "darwin", run });

    await store.set("agent-claude", "test-only-passphrase");

    expect(store.available).toBe(true);
    expect(runs).toEqual([
      {
        file: "/usr/bin/security",
        args: [
          "add-generic-password",
          "-a",
          "agent-claude",
          "-s",
          "vapi-network",
          "-l",
          "vapi-network agent-claude",
          "-U",
          "-w",
        ],
        input: "test-only-passphrase\ntest-only-passphrase\n",
      },
    ]);
    expect(runs[0]!.args).not.toContain("test-only-passphrase");
  });

  it("reads the passphrase back without its trailing newline", async () => {
    const { run, runs } = recordingRunner([{ code: 0, stdout: "test-only-passphrase\n" }]);

    const value = await secretStore({ platform: "darwin", run }).get("main");

    expect(value).toBe("test-only-passphrase");
    expect(runs[0]).toEqual({
      file: "/usr/bin/security",
      args: ["find-generic-password", "-a", "main", "-s", "vapi-network", "-w"],
      input: undefined,
    });
  });

  it("reports a missing item as no passphrase rather than an error", async () => {
    const { run } = recordingRunner([
      { code: 44, stderr: "security: SecKeychainSearchCopyNext: The specified item could not" },
    ]);

    await expect(secretStore({ platform: "darwin", run }).get("main")).resolves.toBeUndefined();
  });

  it("asks whether an entry exists without reading the secret", async () => {
    const { run, runs } = recordingRunner([{ code: 0, stdout: "attributes:\n" }, { code: 44 }]);
    const store = secretStore({ platform: "darwin", run });

    expect(await store.has("main")).toBe(true);
    expect(await store.has("agent")).toBe(false);
    expect(runs[0]!.args).not.toContain("-w");
    expect(runs[0]!.args).toEqual(["find-generic-password", "-a", "main", "-s", "vapi-network"]);
  });

  it("removes an entry and says when there was none", async () => {
    const { run, runs } = recordingRunner([
      { code: 0, stdout: "test-only-passphrase\n" },
      { code: 0 },
      { code: 44 },
    ]);
    const store = secretStore({ platform: "darwin", run });

    expect(await store.remove("main")).toBe(true);
    expect(await store.remove("main")).toBe(false);
    expect(runs[1]!.args).toEqual(["delete-generic-password", "-a", "main", "-s", "vapi-network"]);
  });

  it("splits a value longer than the prompt limit over several items and joins it back", async () => {
    // `security -w` reads at most 128 characters from its prompt and silently
    // drops the rest, so a long value is stored in parts.
    const value = `{"accessToken":"${"a".repeat(60)}","refreshToken":"${"r".repeat(60)}","expiresAt":1,"scopes":["mcp:call","router.use"]}`;
    const items = new Map<string, string>();
    const run: SecretStoreRunner = async (_file, args, input) => {
      const account = args[args.indexOf("-a") + 1]!;
      if (args[0] === "add-generic-password") {
        const typed = input!.split("\n")[0]!;
        items.set(account, typed.slice(0, 128));
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "find-generic-password") {
        const stored = items.get(account);
        return stored === undefined
          ? { code: 44, stdout: "", stderr: "" }
          : { code: 0, stdout: `${stored}\n`, stderr: "" };
      }
      if (args[0] === "delete-generic-password") {
        return items.delete(account)
          ? { code: 0, stdout: "", stderr: "" }
          : { code: 44, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    const store = secretStore({ platform: "darwin", run });

    await store.set("vapi.agent.main.tokens", value);
    expect([...items.values()].every((item) => item.length <= 128)).toBe(true);
    expect(await store.get("vapi.agent.main.tokens")).toBe(value);

    await store.set("vapi.agent.main.tokens", `${value}${"x".repeat(200)}`);
    expect(await store.get("vapi.agent.main.tokens")).toBe(`${value}${"x".repeat(200)}`);
    await store.set("vapi.agent.main.tokens", value);
    expect(await store.get("vapi.agent.main.tokens")).toBe(value);
    expect([...items.keys()].filter((key) => key.includes("#"))).toHaveLength(2);

    expect(await store.remove("vapi.agent.main.tokens")).toBe(true);
    expect(items.size).toBe(0);
  });

  it("turns any other failure into one sentence without the passphrase", async () => {
    const { run } = recordingRunner([{ code: 51, stderr: "User interaction is not allowed." }]);

    await expect(
      secretStore({ platform: "darwin", run }).set("main", "test-only-passphrase"),
    ).rejects.toThrow(
      "Could not store the passphrase of main in the macOS Keychain (exit 51). User interaction is not allowed.",
    );
  });
});

describe("the Windows DPAPI store", () => {
  const env = { SystemRoot: "C:\\Windows" };
  const installed = () => true;
  const powershellArgs = ["-NoProfile", "-NonInteractive", "-Command", "-"];

  it("stores the value through a PowerShell script on stdin, never in an argument", async () => {
    const { run, runs } = recordingRunner([{ code: 0 }]);
    const store = secretStore({ platform: "win32", run, env, installed });
    const value = "test-only-passphrase";
    const encoded = Buffer.from(value, "utf8").toString("base64");

    await store.set("agent-claude", value);

    expect(store.available).toBe(true);
    expect(store.description).toBe("Windows Data Protection (DPAPI)");
    expect(runs[0]!.file).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(runs[0]!.args).toEqual(powershellArgs);
    expect(runs[0]!.args.join(" ")).not.toContain(value);
    expect(runs[0]!.args.join(" ")).not.toContain(encoded);
    expect(runs[0]!.input).toContain("ProtectedData]::Protect(");
    expect(runs[0]!.input).toContain("CurrentUser");
    expect(runs[0]!.input).toContain("vapi-network\\secrets");
    expect(runs[0]!.input).toContain("'agent-claude.bin'");
    expect(runs[0]!.input).toContain(encoded);
    expect(runs[0]!.input).not.toContain(value);
  });

  it("ends every script with a blank line, without which PowerShell never runs it", async () => {
    const { run, runs } = recordingRunner([]);
    const store = secretStore({ platform: "win32", run, env, installed });

    await store.get("main");
    await store.has("main");
    await store.set("main", "test-only-passphrase");
    await store.remove("main");

    expect(runs).toHaveLength(4);
    for (const { input } of runs) expect(input).toMatch(/\}\n\n$/u);
  });

  it("reads the value back by decoding the script's base64 output", async () => {
    const value = "pässwörd ✓";
    const encoded = Buffer.from(value, "utf8").toString("base64");
    const { run, runs } = recordingRunner([{ code: 0, stdout: `${encoded}\r\n` }]);

    await expect(secretStore({ platform: "win32", run, env, installed }).get("main")).resolves.toBe(
      value,
    );
    expect(runs[0]!.args).toEqual(powershellArgs);
    expect(runs[0]!.input).toContain("ProtectedData]::Unprotect(");
    expect(runs[0]!.input).toContain("'main.bin'");
  });

  it("treats a missing file as no value, not an error", async () => {
    const { run } = recordingRunner([{ code: 2, stderr: "No stored secret for main.\r\n" }]);

    await expect(
      secretStore({ platform: "win32", run, env, installed }).get("main"),
    ).resolves.toBeUndefined();
  });

  it("asks whether a value exists without reading it", async () => {
    const { run, runs } = recordingRunner([
      { code: 0 },
      { code: 2, stderr: "No stored secret for agent.\r\n" },
    ]);
    const store = secretStore({ platform: "win32", run, env, installed });

    await expect(store.has("main")).resolves.toBe(true);
    await expect(store.has("agent")).resolves.toBe(false);
    expect(runs[0]!.input).not.toContain("Unprotect");
    expect(runs[1]!.input).not.toContain("Unprotect");
  });

  it("removes the file and says when there was none", async () => {
    const { run, runs } = recordingRunner([{ code: 0 }, { code: 2 }]);
    const store = secretStore({ platform: "win32", run, env, installed });

    await expect(store.remove("main")).resolves.toBe(true);
    await expect(store.remove("main")).resolves.toBe(false);
    expect(runs[0]!.input).toContain("Remove-Item -LiteralPath");
    expect(runs[1]!.input).toContain("Remove-Item -LiteralPath");
  });

  it("makes file-operation failures terminate every PowerShell script", async () => {
    const encoded = Buffer.from("test-only-passphrase", "utf8").toString("base64");
    const { run, runs } = recordingRunner([
      { code: 0 },
      { code: 0, stdout: encoded },
      { code: 0 },
      { code: 0 },
    ]);
    const store = secretStore({ platform: "win32", run, env, installed });

    await store.set("main", "test-only-passphrase");
    await store.get("main");
    await store.has("main");
    await store.remove("main");

    for (const { input } of runs) {
      expect(input).toMatch(/try \{[\s\S]*\} catch \{/u);
      expect(input).toContain("exit 0");
      expect(input).toContain("[Console]::Error.WriteLine($_.Exception.Message)");
      expect(input).toMatch(/\} catch \{[\s\S]*exit 1\s*\}/u);
    }
  });

  it("turns any other failure into one sentence without the value", async () => {
    const { run } = recordingRunner([{ code: 1, stderr: "Access to the path is denied.\r\n" }]);

    await expect(
      secretStore({ platform: "win32", run, env, installed }).set("main", "test-only-passphrase"),
    ).rejects.toThrow(
      "Could not store the passphrase of main in Windows Data Protection (exit 1). Access to the path is denied.",
    );
  });

  it("names PowerShell when it is missing", async () => {
    const { run } = recordingRunner([{ code: null, notFound: true }]);
    const store = secretStore({ platform: "win32", run, env, installed: () => false });

    expect(store.available).toBe(false);
    await expect(store.get("main")).rejects.toThrow(/powershell/iu);
  });

  it("files accounts under names that never collide, even on a case-insensitive filesystem", () => {
    const accounts = [
      "main",
      "Main",
      "MAIN",
      "agent-claude",
      "agent claude",
      "agent/claude",
      "agent%claude",
      "agent%25claude",
      "a.b",
      "a%2Eb",
      "vapi.agent.main.tokens",
      "con",
      "CON",
      "com1",
      "nul.backup",
      "héllo",
      "h%C3%A9llo",
      "\ud800",
      "\ud801",
      "�",
    ];
    const files = accounts.map(windowsSecretFileName);

    for (const file of files) expect(file).toMatch(/^[a-z0-9._#%A-F-]+\.bin$/u);
    expect(new Set(files.map((file) => file.toLowerCase())).size).toBe(accounts.length);
    expect(windowsSecretFileName("main")).toBe("main.bin");
    expect(windowsSecretFileName("con")).toBe("%63on.bin");
    expect(windowsSecretFileName("nul.backup")).toBe("%6Eul.backup.bin");
  });
});

describe("the libsecret store", () => {
  it("stores the passphrase over stdin under the vapi-network service", async () => {
    const { run, runs } = recordingRunner([{ code: 0 }]);

    await secretStore({ platform: "linux", run }).set("agent-claude", "test-only-passphrase");

    expect(runs).toEqual([
      {
        file: "secret-tool",
        args: [
          "store",
          "--label=vapi-network agent-claude",
          "service",
          "vapi-network",
          "account",
          "agent-claude",
        ],
        input: "test-only-passphrase\n",
      },
    ]);
  });

  it("looks a passphrase up and treats a silent non-zero exit as absent", async () => {
    const { run, runs } = recordingRunner([
      { code: 0, stdout: "test-only-passphrase\n" },
      { code: 1 },
    ]);
    const store = secretStore({ platform: "linux", run });

    expect(await store.get("main")).toBe("test-only-passphrase");
    expect(await store.get("agent")).toBeUndefined();
    expect(runs[0]).toEqual({
      file: "secret-tool",
      args: ["lookup", "service", "vapi-network", "account", "main"],
      input: undefined,
    });
  });

  it("clears an entry and reports whether one was there", async () => {
    const { run, runs } = recordingRunner([
      { code: 0, stdout: "test-only-passphrase\n" },
      { code: 0 },
      { code: 1 },
      // Real secret-tool exits 1 with empty stderr when `clear` matches
      // nothing; that is still a successful removal of an absent entry.
      { code: 1 },
    ]);
    const store = secretStore({ platform: "linux", run });

    expect(await store.remove("main")).toBe(true);
    expect(await store.remove("main")).toBe(false);
    expect(runs[1]).toEqual({
      file: "secret-tool",
      args: ["clear", "service", "vapi-network", "account", "main"],
      input: undefined,
    });
  });

  it("still reports a clear failure that came with a message", async () => {
    const { run } = recordingRunner([
      { code: 0, stdout: "test-only-passphrase\n" },
      { code: 1, stderr: "Cannot autolaunch D-Bus" },
    ]);

    await expect(secretStore({ platform: "linux", run }).remove("main")).rejects.toThrow(
      "Could not remove the passphrase of main from the secret service (exit 1). Cannot autolaunch D-Bus",
    );
  });

  it("names the package to install when secret-tool is missing", async () => {
    const { run } = recordingRunner([{ code: null, notFound: true }]);

    await expect(secretStore({ platform: "linux", run }).get("main")).rejects.toThrow(
      /libsecret-tools/u,
    );
  });

  it("is unavailable when secret-tool is not installed", () => {
    const { run } = recordingRunner([]);

    expect(secretStore({ platform: "linux", run, installed: () => false }).available).toBe(false);
    expect(secretStore({ platform: "linux", run, installed: () => true }).available).toBe(true);
  });

  it("finds secret-tool on the injected PATH by default", () => {
    const directory = mkdtempSync(join(tmpdir(), "vapi-secret-tool-"));
    const emptyDirectory = mkdtempSync(join(tmpdir(), "vapi-no-secret-tool-"));
    try {
      writeFileSync(join(directory, "secret-tool"), "");

      expect(secretStore({ platform: "linux", env: { PATH: directory } }).available).toBe(true);
      expect(secretStore({ platform: "linux", env: { PATH: emptyDirectory } }).available).toBe(
        false,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(emptyDirectory, { recursive: true, force: true });
    }
  });

  it("reports a failure that came with a message", async () => {
    const { run } = recordingRunner([{ code: 1, stderr: "Cannot autolaunch D-Bus" }]);

    await expect(
      secretStore({ platform: "linux", run }).set("main", "test-only-passphrase"),
    ).rejects.toThrow(
      "Could not store the passphrase of main in the secret service (exit 1). Cannot autolaunch D-Bus",
    );
  });
});

describe("every other platform", () => {
  it("says there is no store and points at the environment variable", async () => {
    const { run, runs } = recordingRunner([]);
    const store = secretStore({ platform: "freebsd", run });

    expect(store.available).toBe(false);
    expect(store.platform).toBe("freebsd");
    const message = "No OS secret store on this platform yet; use VAPI_KEYSTORE_PASSWORD.";
    await expect(store.get("main")).rejects.toThrow(message);
    await expect(store.has("main")).rejects.toThrow(message);
    await expect(store.set("main", "test-only-passphrase")).rejects.toThrow(message);
    await expect(store.remove("main")).rejects.toThrow(message);
    expect(runs).toEqual([]);
  });
});

describe("the wallet name it files an entry under", () => {
  it("refuses an empty name rather than reaching for a nameless entry", async () => {
    const { run } = recordingRunner([]);

    await expect(secretStore({ platform: "darwin", run }).get("  ")).rejects.toThrow(
      "A wallet name is needed to reach the OS secret store.",
    );
  });
});

describe("the in-memory secret store", () => {
  it("gets, has, sets, removes and lists entries without running a binary", async () => {
    const store = memorySecretStore({ beta: "beta-secret" });

    expect(store).toMatchObject({ available: true, description: "an in-memory store" });
    expect(store.platform).toBe(process.platform);
    await expect(store.get("alpha")).resolves.toBeUndefined();
    await expect(store.has("alpha")).resolves.toBe(false);

    await store.set("alpha", "alpha-secret");
    await expect(store.get("alpha")).resolves.toBe("alpha-secret");
    await expect(store.has("alpha")).resolves.toBe(true);
    await expect(store.list?.()).resolves.toEqual(["alpha", "beta"]);

    await store.set("alpha", "alpha-rotated");
    await expect(store.get("alpha")).resolves.toBe("alpha-rotated");

    await expect(store.remove("alpha")).resolves.toBe(true);
    await expect(store.remove("alpha")).resolves.toBe(false);
    await expect(store.get("alpha")).resolves.toBeUndefined();
    await expect(store.list?.()).resolves.toEqual(["beta"]);
  });

  it("does not share entries between stores or with its initial record", async () => {
    const initial = { alpha: "alpha-secret" };
    const first = memorySecretStore(initial);
    const second = memorySecretStore(initial);

    await first.set("alpha", "changed");
    await first.remove("alpha");

    expect(initial).toEqual({ alpha: "alpha-secret" });
    await expect(second.get("alpha")).resolves.toBe("alpha-secret");
    await expect(memorySecretStore().list?.()).resolves.toEqual([]);
  });
});
