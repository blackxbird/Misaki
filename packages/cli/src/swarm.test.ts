import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";

import {
  AGENT_MARKER_VARIABLES,
  ARC_MAINNET_CAIP2,
  ARC_TESTNET_CAIP2,
  BASE_MAINNET_CAIP2,
  WalletStore,
  getVapiPaths,
  loadOrCreateDeviceKey,
  readSwarm,
  usdToAtomic,
  writeAgentProfile,
  writeSwarm,
  type ChatResult,
  type MovementTransfer,
  type SecretStore,
  type SweepAboveCeilingArgs,
  type TransferResult,
} from "@vapi-network/core";
import {
  agentSecretAccounts,
  type DeviceLinkStart,
  type LinkResult,
  type pollDeviceLink,
  type startDeviceLink,
} from "@vapi-network/core/agent-link";
import {
  createAgentRunDeps,
  listRunRecords,
  runSwarm,
  SwarmRunError,
  writeRunRecord,
  type Runtime,
  type RuntimeStatus,
  type SwarmRunMemberResult,
  type SwarmRunResult,
  type runAgent,
} from "@vapi-network/mcp";
import { exportMemberKey } from "@vapi-network/core/secrets";

import { HELP, runCli, type CliDependencies, type CliIo } from "./cli.js";
import type { RuntimeRequest } from "./runtime-local.js";
import type { RailwayExec, RailwayExecResult, RailwaySidecar } from "./runtime-railway.js";

const API_BASE = "https://api.vapinetwork.ai";
const OWNER = "0x1111111111111111111111111111111111111111" as const;
const RECOVERY_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PRIVATE_KEY = `0x${"42".repeat(32)}`;
const API_KEY = "vapi_sk_1234567890abcdef";
const PASSPHRASE = "passphrase-that-must-stay-secret";
const START: DeviceLinkStart = {
  clientId: "agent_swarm",
  deviceCode: "device-code-that-must-stay-secret",
  userCode: "SWARM-CODE",
  verificationUri: `${API_BASE}/link`,
  verificationUriComplete: `${API_BASE}/link?code=SWARM-CODE`,
  expiresIn: 600,
  interval: 5,
  autoApproved: false,
};
const LINK_RESULT: LinkResult = {
  tokens: {
    accessToken: "access-token-that-must-stay-secret",
    refreshToken: "refresh-token-that-must-stay-secret",
    expiresAt: Number.MAX_SAFE_INTEGER,
    scopes: ["mcp:call", "router.use"],
  },
  owner: OWNER,
  routerKey: "router-key-that-must-stay-secret",
  routerBaseUrl: "https://router.vapinetwork.ai",
};

const originalHome = process.env.VAPI_HOME;
const homes: string[] = [];
const stores = new Map<string, SecretStore>();

afterEach(async () => {
  if (originalHome === undefined) delete process.env.VAPI_HOME;
  else process.env.VAPI_HOME = originalHome;
  stores.clear();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("vapi swarm help alignment", () => {
  it("documents every swarm subcommand dispatched by swarmCommand", async () => {
    const source = await readFile(new URL("./swarm.ts", import.meta.url), "utf8");
    const dispatched = new Set(
      [...source.matchAll(/^ {4}case "([a-z-]+)":$/gmu)].map((match) => match[1]!),
    );
    const documented = new Set(
      [...HELP.matchAll(/^ {2}vapi swarm ([a-z-]+)/gmu)].map((match) => match[1]!),
    );

    expect([...documented].sort()).toEqual([...dispatched].sort());
  });
});

describe("vapi swarm JSON and exit codes", () => {
  it("creates a swarm, waits for every account link, and emits one JSON-safe result", async () => {
    await initializedHome("vapi-swarm-create-");
    const start = vi.fn<typeof startDeviceLink>(async () => START);
    const poll = vi.fn<typeof pollDeviceLink>(async () => LINK_RESULT);
    const captured = captureIo();

    expect(
      await run(
        [
          "swarm",
          "create",
          "team",
          "--roles",
          "lead,helper",
          "--caps",
          "0.10/1",
          "--treasury-caps",
          "5/20",
          "--network",
          "base",
          "--model",
          "router/test",
          "--json",
        ],
        captured.io,
        {
          ...dependencies(),
          agentLink: { startDeviceLink: start, pollDeviceLink: poll },
        },
      ),
    ).toBe(0);

    expect(captured.stderr).toEqual([]);
    expect(captured.stdout).toHaveLength(2);
    expect(JSON.parse(captured.stdout[0]!)).toMatchObject({
      status: "waiting_for_approval",
      next: [
        { account: "team-treasury", userCode: START.userCode },
        { account: "team-lead-1", userCode: START.userCode },
        { account: "team-helper-1", userCode: START.userCode },
      ],
    });
    const result = JSON.parse(captured.stdout[1]!) as Record<string, unknown>;
    expect(result).not.toHaveProperty("completions");
    expect(result).toMatchObject({
      swarm: {
        name: "team",
        network: BASE_MAINNET_CAIP2,
        policy: { strategy: "targets" },
      },
      members: [
        { account: "team-treasury", role: "treasury" },
        { account: "team-lead-1", role: "lead" },
        { account: "team-helper-1", role: "helper" },
      ],
      next: [
        { kind: "link", account: "team-treasury", userCode: START.userCode },
        { kind: "link", account: "team-lead-1", userCode: START.userCode },
        { kind: "link", account: "team-helper-1", userCode: START.userCode },
      ],
      links: [
        { account: "team-treasury", linked: true },
        { account: "team-lead-1", linked: true },
        { account: "team-helper-1", linked: true },
      ],
    });
    expect(captured.stdout.join("\n")).not.toContain(START.deviceCode);
    expect(captured.stdout.join("\n")).not.toContain(LINK_RESULT.tokens.accessToken);
    expect(start).toHaveBeenCalledTimes(3);
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it("emits JSON approval codes before the default wait finishes", async () => {
    await initializedHome("vapi-swarm-json-approval-");
    const captured = captureIo();
    let approve!: (result: LinkResult) => void;
    const pending = new Promise<LinkResult>((resolve) => {
      approve = resolve;
    });

    const running = run(["swarm", "create", "team", "--agents", "1", "--json"], captured.io, {
      ...dependencies(),
      agentLink: {
        startDeviceLink: async () => START,
        pollDeviceLink: async () => await pending,
      },
    });
    await vi.waitFor(() => expect(captured.stdout).toHaveLength(1), { timeout: 10_000 });
    expect(JSON.parse(captured.stdout[0]!)).toMatchObject({
      status: "waiting_for_approval",
      next: [
        { account: "team-treasury", userCode: START.userCode },
        { account: "team-lead-1", userCode: START.userCode },
      ],
    });

    approve(LINK_RESULT);
    await expect(running).resolves.toBe(0);
    expect(captured.stdout).toHaveLength(2);
    expect(JSON.parse(captured.stdout[1]!)).toMatchObject({
      links: [
        { account: "team-treasury", linked: true },
        { account: "team-lead-1", linked: true },
      ],
    });
  });

  it("returns the core status shape as JSON and always exits zero on success", async () => {
    await linkedSwarm("vapi-swarm-status-");
    const captured = captureIo();

    expect(
      await run(["swarm", "status", "team", "--json"], captured.io, {
        ...dependencies(),
        swarm: { balanceReader: async () => 0n },
      }),
    ).toBe(0);

    expect(JSON.parse(captured.stdout[0]!)).toMatchObject({
      swarm: "team",
      network: BASE_MAINNET_CAIP2,
      strategy: "targets",
      treasury: { account: "team-treasury", linked: true, balanceAtomic: "0" },
      members: [
        { account: "team-lead-1", role: "lead", linked: true, profile: true },
        { account: "team-helper-1", role: "helper", linked: true, profile: true },
      ],
      openMovements: [],
    });
  });

  it("returns waiting_for_owner funding instructions as complete CLI work", async () => {
    await linkedSwarm("vapi-swarm-owner-fund-");
    const captured = captureIo();

    expect(await run(["swarm", "fund", "team", "2.50", "--json"], captured.io)).toBe(0);

    expect(JSON.parse(captured.stdout[0]!)).toMatchObject({
      status: "waiting_for_owner",
      treasury: {
        account: "team-treasury",
        address: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/u),
      },
      network: BASE_MAINNET_CAIP2,
      amountUsd: "2.50",
      skipped: [],
    });
  });

  it("funds from a local account with one sent movement leg", async () => {
    await linkedSwarm("vapi-swarm-local-fund-");
    const transfer = vi.fn<MovementTransfer>(async (args) => transferResult(args, "sent"));
    const captured = captureIo();

    expect(
      await run(
        ["swarm", "fund", "team", "1.00", "--from", "main", "--json"],
        captured.io,
        movementDependencies(transfer, async () => 0n),
      ),
    ).toBe(0);

    expect(JSON.parse(captured.stdout[0]!)).toMatchObject({
      status: "sent",
      treasury: { account: "team-treasury" },
      network: BASE_MAINNET_CAIP2,
      amountUsd: "1.00",
      fund: {
        reason: "send",
        complete: true,
        legs: [
          {
            from: "main",
            to: "team-treasury",
            amountUsd: "1.00",
            purpose: "send",
            status: "sent",
          },
        ],
      },
    });
    expect(transfer).toHaveBeenCalledOnce();
  });

  it("runs create --fund twice but debits the funding account only once", async () => {
    await initializedHome("vapi-swarm-create-fund-once-");
    const balances = new Map<string, bigint>([
      ["main", 10_000_000n],
      ["team-treasury", 0n],
      ["team-lead-1", 0n],
    ]);
    const transfer = vi.fn<MovementTransfer>(async (args) => {
      const amount = usdToAtomic(args.amountUsd);
      balances.set(args.from, (balances.get(args.from) ?? 0n) - amount);
      balances.set(args.to, (balances.get(args.to) ?? 0n) + amount);
      return transferResult(args, "sent");
    });
    let movementId = 0;
    let nonce = 0;
    const deps = {
      ...dependencies(),
      agentLink: {
        startDeviceLink: async () => START,
        pollDeviceLink: async () => LINK_RESULT,
      },
      swarm: {
        transfer,
        balanceReader: async ({ account }) => balances.get(account) ?? 0n,
        randomId: () => `mv_cli_setup_${String(++movementId).padStart(8, "0")}`,
        randomNonce: () => `0x${(++nonce).toString(16).padStart(64, "0")}` as Hex,
      },
    } satisfies CliDependencies;
    const argv = [
      "swarm",
      "create",
      "team",
      "--agents",
      "1",
      "--strategy",
      "even",
      "--fund",
      "5",
      "--from",
      "main",
      "--json",
    ];

    const first = captureIo();
    const second = captureIo();
    expect(await run(argv, first.io, deps)).toBe(0);
    expect(await run(argv, second.io, deps)).toBe(0);

    expect(transfer.mock.calls.filter(([args]) => args.from === "main")).toHaveLength(1);
    expect(balances.get("main")).toBe(5_000_000n);
    expect(JSON.parse(second.stdout.at(-1)!)).toMatchObject({
      fund: { status: "sent", amountUsd: "5.00" },
    });
  });

  it("rebalances target deficits and returns the movement shape", async () => {
    await linkedSwarm("vapi-swarm-rebalance-");
    const transfer = vi.fn<MovementTransfer>(async (args) => transferResult(args, "sent"));
    const captured = captureIo();

    expect(
      await run(
        ["swarm", "rebalance", "team", "--targets", "lead=2,helper=1", "--json"],
        captured.io,
        movementDependencies(transfer, async ({ account }) =>
          account === "team-treasury" ? 3_000_000n : 0n,
        ),
      ),
    ).toBe(0);

    const result = JSON.parse(captured.stdout[0]!) as {
      status: string;
      movement: { reason: string; complete: boolean; legs: unknown[] };
      blocked: unknown[];
      skipped: unknown[];
    };
    expect(result).toMatchObject({
      status: "sent",
      movement: { reason: "rebalance", complete: true },
      blocked: [],
      skipped: [],
    });
    expect(result.movement.legs).toHaveLength(2);
    expect(transfer).toHaveBeenCalledTimes(2);
  });

  it("removes a zero-balance member and dissolves a zero-balance swarm as JSON", async () => {
    await linkedSwarm("vapi-swarm-remove-dissolve-");
    const deps = {
      ...dependencies(),
      swarm: { balanceReader: async () => 0n },
    } satisfies CliDependencies;
    const removed = captureIo();

    expect(
      await run(["swarm", "remove", "team", "team-helper-1", "--json"], removed.io, deps),
    ).toBe(0);
    expect(JSON.parse(removed.stdout[0]!)).toEqual({
      status: "left",
      member: "team-helper-1",
      message: "Removed team-helper-1 from swarm team; its balance was below one cent.",
    });

    const dissolved = captureIo();
    expect(await run(["swarm", "dissolve", "team", "--json"], dissolved.io, deps)).toBe(0);
    expect(JSON.parse(dissolved.stdout[0]!)).toEqual({
      status: "dissolved",
      movements: [],
      message:
        "Dissolved swarm team; its accounts and profiles remain on this device. A deposit arriving at the treasury after dissolve stays on the treasury account, which is kept on this device.",
    });
    await expect(readSwarm(process.env.VAPI_HOME!, "team")).rejects.toMatchObject({
      code: "swarm_not_found",
    });
  });

  it("exits one for a pending no-wait link and an unknown movement leg", async () => {
    await initializedHome("vapi-swarm-incomplete-");
    const pending = captureIo();
    const never = new Promise<LinkResult>(() => undefined);

    expect(
      await run(["swarm", "create", "team", "--no-wait", "--json"], pending.io, {
        ...dependencies(),
        agentLink: {
          startDeviceLink: async () => START,
          pollDeviceLink: async () => await never,
        },
      }),
    ).toBe(1);
    expect(JSON.parse(pending.stdout[0]!)).toMatchObject({
      links: [
        { account: "team-treasury", linked: false },
        { account: "team-lead-1", linked: false },
        { account: "team-helper-1", linked: false },
      ],
    });

    const transfer = vi.fn<MovementTransfer>(async (args) => transferResult(args, "unknown"));
    const incomplete = captureIo();
    expect(
      await run(
        ["swarm", "fund", "team", "1.00", "--from", "main", "--json"],
        incomplete.io,
        movementDependencies(transfer, async () => 0n),
      ),
    ).toBe(1);
    expect(JSON.parse(incomplete.stdout[0]!)).toMatchObject({
      status: "incomplete",
      fund: { complete: false, legs: [{ status: "unknown" }] },
    });
  });

  it("returns no-wait JSON link codes without starting polling or sleep", async () => {
    await initializedHome("vapi-swarm-no-wait-");
    const captured = captureIo();
    const sleep = vi.fn(async () => await new Promise<never>(() => undefined));
    const poll = vi.fn<typeof pollDeviceLink>(async () => {
      await sleep();
      return LINK_RESULT;
    });

    await expect(
      run(["swarm", "create", "team", "--agents", "1", "--no-wait", "--json"], captured.io, {
        ...dependencies(),
        agentLink: { startDeviceLink: async () => START, pollDeviceLink: poll },
      }),
    ).resolves.toBe(1);

    expect(poll).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(JSON.parse(captured.stdout[0]!)).toMatchObject({
      next: [
        {
          account: "team-treasury",
          userCode: START.userCode,
          verificationUri: START.verificationUri,
        },
        {
          account: "team-lead-1",
          userCode: START.userCode,
          verificationUri: START.verificationUri,
        },
      ],
    });
    expect(captured.stdout.join("\n")).not.toContain(START.deviceCode);
    expect(captured.stdout.join("\n")).not.toContain(LINK_RESULT.tokens.accessToken);
  });

  it("returns exit two for swarm usage errors", async () => {
    await initializedHome("vapi-swarm-usage-");
    for (const argv of [
      ["swarm", "create", "team", "--agents", "2", "--roles", "lead,helper"],
      ["swarm", "create", "team", "--fund", "1"],
      ["swarm", "create", "team", "--caps", "1/bad"],
      ["swarm", "unknown"],
    ]) {
      const captured = captureIo();
      expect(await run(argv, captured.io)).toBe(2);
      expect(captured.stdout).toEqual([]);
      expect(captured.stderr).toHaveLength(1);
    }
  });
});

describe("vapi swarm run", () => {
  it("passes defaults and requested flags to the runSwarm seam", async () => {
    await initializedHome("vapi-swarm-run-options-");
    const execute = vi.fn<typeof runSwarm>(async () => swarmRunResult());
    const defaults = captureIo();

    expect(
      await run(["swarm", "run", "team", "Research", "--json"], defaults.io, {
        ...dependencies(),
        swarm: { runSwarm: execute },
      }),
    ).toBe(0);
    expect(execute.mock.calls[0]![0]).toEqual({
      name: "team",
      task: "Research",
      mode: "lead",
    });
    expect(execute.mock.calls[0]![0]).not.toHaveProperty("drawUsd");
    expect(JSON.parse(onlyLine(defaults.stdout))).toEqual(swarmRunResult());

    const requested = captureIo();
    expect(
      await run(
        [
          "swarm",
          "run",
          "team",
          "Compare",
          "--mode",
          "each",
          "--lead",
          "team-lead-1",
          "--budget",
          "0.75",
          "--draw",
          "1.50",
          "--json",
        ],
        requested.io,
        { ...dependencies(), swarm: { runSwarm: execute } },
      ),
    ).toBe(0);
    expect(execute.mock.calls[1]![0]).toEqual({
      name: "team",
      task: "Compare",
      mode: "each",
      lead: "team-lead-1",
      budgetUsd: "0.75",
      drawUsd: "1.50",
    });
  });

  it("prompts for a lead treasury draw on a TTY and accepts yes", async () => {
    await linkedSwarm("vapi-swarm-run-lead-approval-");
    const line = vi.fn(async (_prompt: string) => "y");
    const transfer = vi.fn<MovementTransfer>(async (args) => transferResult(args, "sent"));
    const replies = [
      swarmToolReply("allocate", "swarm_allocate", {
        amount_usd: "0.75",
        reason: "Complete the task",
      }),
      swarmToolReply("finish", "finish", { answer: "Allocation approved." }),
    ];
    const routerChat = vi.fn(async (): Promise<ChatResult> => {
      const reply = replies.shift();
      if (reply === undefined) throw new Error("The CLI approval test has no reply left.");
      return reply;
    });
    const captured = captureIo();

    expect(
      await run(["swarm", "run", "team", "Allocate", "--draw", "0.75"], captured.io, {
        ...movementDependencies(transfer, async ({ account }) =>
          account === "team-treasury" ? 5_000_000n : 0n,
        ),
        interactive: true,
        prompts: { secret: async () => "", line },
        router: { routerChat },
      }),
    ).toBe(0);

    expect(line).toHaveBeenCalledOnce();
    expect(line.mock.calls[0]?.[0]).toContain("Pay $0.75 to swarm treasury → team-lead-1?");
    expect(transfer).toHaveBeenCalledOnce();
    expect(captured.stdout.join("\n")).toContain("Allocation approved.");
  });

  it("declines a lead treasury draw off-TTY without prompting", async () => {
    await linkedSwarm("vapi-swarm-run-lead-no-tty-");
    const line = vi.fn(async (_prompt: string) => "y");
    const transfer = vi.fn<MovementTransfer>(async (args) => transferResult(args, "sent"));
    const replies = [
      swarmToolReply("allocate", "swarm_allocate", {
        amount_usd: "0.75",
        reason: "Complete the task",
      }),
      swarmToolReply("finish", "finish", { answer: "Allocation declined." }),
    ];
    const routerChat = vi.fn(async (): Promise<ChatResult> => {
      const reply = replies.shift();
      if (reply === undefined) throw new Error("The CLI approval test has no reply left.");
      return reply;
    });
    const captured = captureIo();

    expect(
      await run(["swarm", "run", "team", "Allocate", "--draw", "0.75"], captured.io, {
        ...movementDependencies(transfer, async ({ account }) =>
          account === "team-treasury" ? 5_000_000n : 0n,
        ),
        interactive: false,
        prompts: { secret: async () => "", line },
        router: { routerChat },
      }),
    ).toBe(0);

    expect(line).not.toHaveBeenCalled();
    expect(transfer).not.toHaveBeenCalled();
    expect(captured.stdout.join("\n")).toContain("declined swarm.allocate");
  });

  it("declines each-mode owner approval on a TTY without prompting", async () => {
    const home = await linkedSwarm("vapi-swarm-run-each-approval-", ["lead"]);
    const store = await WalletStore.open(home, { secrets: stores.get(home)! });
    await store.setSpendCaps("team-lead-1", {
      perCallAtomic: "1000000",
      perDayAtomic: "2000000",
    });
    const line = vi.fn(async (_prompt: string) => "y");
    const replies = [
      swarmToolReply("search", "call_search", { query: "premium", network: null }),
      swarmToolReply("pay", "call_pay", { ref: "premium", body: null, max_usd: 0.75 }),
      swarmToolReply("finish", "finish", { answer: "Payment declined." }),
    ];
    const routerChat = vi.fn(async (): Promise<ChatResult> => {
      const reply = replies.shift();
      if (reply === undefined) throw new Error("The CLI approval test has no reply left.");
      return reply;
    });
    const fetchImpl = listingAndBalanceFetch();
    const captured = captureIo();

    expect(
      await run(
        ["swarm", "run", "team", "Check premium", "--mode", "each", "--budget", "1.00"],
        captured.io,
        {
          ...dependencies(fetchImpl),
          interactive: true,
          prompts: { secret: async () => "", line },
          router: { routerChat },
        },
      ),
    ).toBe(0);

    expect(line).not.toHaveBeenCalled();
    expect(captured.stdout.join("\n")).toContain("declined premium");
    expect(
      vi
        .mocked(fetchImpl)
        .mock.calls.some(([input]) =>
          String(input instanceof Request ? input.url : input).includes("premium.example"),
        ),
    ).toBe(false);
  });

  it.each([
    ["one member stopped", [runMember({ status: "stopped" })], 1],
    ["only skipped members", [runMember({ status: "skipped", runId: null })], 1],
    ["all members finished", [runMember(), runMember({ member: "team-helper-1" })], 0],
  ] as const)("returns the expected exit code when %s", async (_label, members, exitCode) => {
    await initializedHome(`vapi-swarm-run-exit-${exitCode}-`);
    const execute = vi.fn<typeof runSwarm>(async () => swarmRunResult({ members: [...members] }));

    expect(
      await run(["swarm", "run", "team", "Research", "--json"], captureIo().io, {
        ...dependencies(),
        swarm: { runSwarm: execute },
      }),
    ).toBe(exitCode);
  });

  it("returns one and a JSON error for a no-lead SwarmRunError", async () => {
    await initializedHome("vapi-swarm-run-no-lead-");
    const execute = vi.fn<typeof runSwarm>(async () => {
      throw new SwarmRunError("no_lead", "Swarm team has no lead member.");
    });
    const captured = captureIo();

    expect(
      await run(["swarm", "run", "team", "Research", "--json"], captured.io, {
        ...dependencies(),
        swarm: { runSwarm: execute },
      }),
    ).toBe(1);
    expect(JSON.parse(onlyLine(captured.stdout))).toEqual({
      error: "Swarm team has no lead member.",
      exitCode: 1,
    });
  });

  it("writes a success envelope, honours VAPI_RUN_ID, and keeps secrets out", async () => {
    const home = await initializedHome("vapi-swarm-run-result-");
    const runId = "run_333333333333333333333333";
    const resultFile = join(home, "runs", `${runId}.result.json`);
    const execute = vi.fn<typeof runSwarm>(async () =>
      swarmRunResult({
        runId,
        members: [
          runMember({
            answer: `Done. ${RECOVERY_PHRASE} ${PRIVATE_KEY} ${PASSPHRASE} ${API_KEY} ${LINK_RESULT.tokens.accessToken} ${START.deviceCode} ${LINK_RESULT.routerKey}`,
          }),
        ],
      }),
    );
    const captured = captureIo();

    expect(
      await run(
        ["swarm", "run", "team", "Research", "--result-file", resultFile, "--json"],
        captured.io,
        {
          ...dependencies(),
          env: {
            VAPI_RUN_ID: runId,
            VAPI_RECOVERY_PHRASE: RECOVERY_PHRASE,
            VAPI_PRIVATE_KEY: PRIVATE_KEY,
            VAPI_VAULT_PASSWORD: PASSPHRASE,
            VAPI_API_KEY: API_KEY,
            VAPI_ACCESS_TOKEN: LINK_RESULT.tokens.accessToken,
            VAPI_DEVICE_CODE: START.deviceCode,
            VAPI_ROUTER_KEY: LINK_RESULT.routerKey,
          },
          swarm: { runSwarm: execute },
        },
      ),
    ).toBe(0);

    expect(execute.mock.calls[0]![0]).toMatchObject({ runId });
    const printed = JSON.parse(onlyLine(captured.stdout)) as Record<string, unknown>;
    expect(printed).toMatchObject({ runId });
    const envelope = JSON.parse(await readFile(resultFile, "utf8")) as Record<string, unknown>;
    expect(envelope).toEqual({ v: 1, exitCode: 0, result: printed });
    expectNoRunSecrets(`${captured.stdout.join("\n")}\n${JSON.stringify(envelope)}`);
  });

  it("writes a thrown failure envelope with the returned exit code", async () => {
    const home = await initializedHome("vapi-swarm-run-failure-result-");
    const resultFile = join(home, "runs", "failure.result.json");
    const execute = vi.fn<typeof runSwarm>(async () => {
      throw new SwarmRunError(
        "no_lead",
        `Swarm team has no lead member. Internal credential: ${PRIVATE_KEY}`,
      );
    });
    const captured = captureIo();

    expect(
      await run(
        ["swarm", "run", "team", "Research", "--result-file", resultFile, "--json"],
        captured.io,
        { ...dependencies(), swarm: { runSwarm: execute } },
      ),
    ).toBe(1);

    expect(JSON.parse(onlyLine(captured.stdout))).toEqual({
      error: "Swarm team has no lead member. Internal credential: [redacted private key]",
      exitCode: 1,
    });
    expect(JSON.parse(await readFile(resultFile, "utf8"))).toEqual({
      v: 1,
      exitCode: 1,
      error: {
        message: "Swarm team has no lead member. Internal credential: [redacted private key]",
        code: "no_lead",
      },
    });
  });

  it("refuses an invalid VAPI_RUN_ID with exit two and a result envelope", async () => {
    const home = await initializedHome("vapi-swarm-run-invalid-id-");
    const resultFile = join(home, "runs", "invalid.result.json");
    const captured = captureIo();

    expect(
      await run(
        ["swarm", "run", "team", "Research", "--result-file", resultFile, "--json"],
        captured.io,
        { ...dependencies(), env: { VAPI_RUN_ID: "invalid" } },
      ),
    ).toBe(2);

    const printed = JSON.parse(onlyLine(captured.stdout)) as { error: string; exitCode: number };
    expect(printed).toEqual({
      error: "VAPI_RUN_ID must match run_<24 lowercase hexadecimal characters>.",
      exitCode: 2,
    });
    expect(JSON.parse(await readFile(resultFile, "utf8"))).toEqual({
      v: 1,
      exitCode: 2,
      error: { message: printed.error },
    });
  });

  it("prints member blocks, the net table, draw usage and a net note", async () => {
    await initializedHome("vapi-swarm-run-human-");
    const execute = vi.fn<typeof runSwarm>(async () =>
      swarmRunResult({ netError: "Balance unavailable." }),
    );
    const captured = captureIo();

    expect(
      await run(["swarm", "run", "team", "Research"], captured.io, {
        ...dependencies(),
        swarm: { runSwarm: execute },
      }),
    ).toBe(0);
    const output = captured.stdout.join("\n");
    expect(output).toContain("team-lead-1 (lead) — finished\nDone.\nspent $0 of $1");
    expect(output).toContain("MEMBER");
    expect(output).toContain("ALLOCATED IN");
    expect(output).toContain("team-lead-1");
    expect(output).toContain("Draw used $0 of $2");
    expect(output).toContain("Note: Balance unavailable.");
  });

  it("prints unknown spending when an interrupted delegation has no final record", async () => {
    await initializedHome("vapi-swarm-run-unknown-spend-");
    const execute = vi.fn<typeof runSwarm>(async () =>
      swarmRunResult({
        members: [
          runMember({
            status: "error",
            answer: null,
            spentUsd: null,
            budgetUsd: 0.25,
            stoppedBecause: {
              reason: "error",
              detail: "Spending and remaining budget are unknown.",
            },
          }),
        ],
      }),
    );
    const captured = captureIo();

    expect(
      await run(["swarm", "run", "team", "Research"], captured.io, {
        ...dependencies(),
        swarm: { runSwarm: execute },
      }),
    ).toBe(1);
    expect(captured.stdout.join("\n")).toContain(
      "Spending and remaining budget are unknown.\nspent unknown of $0.25",
    );
  });

  it.each([
    ["bad mode", ["swarm", "run", "team", "Research", "--mode", "all"]],
    ["bad draw", ["swarm", "run", "team", "Research", "--draw", "1.001"]],
    ["bad budget", ["swarm", "run", "team", "Research", "--budget", "0"]],
    ["missing task", ["swarm", "run", "team"]],
  ] as const)("returns usage for %s", async (_label, argv) => {
    await initializedHome("vapi-swarm-run-usage-");
    const captured = captureIo();

    expect(await run([...argv], captured.io)).toBe(2);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toHaveLength(1);
    expect(captured.stderr[0]).toContain(
      'Usage: vapi swarm run <name> "<task>" [--mode lead|each] [--lead <member>] [--budget <usd>] [--draw <usd>] [--detach] [--runtime local|railway] [--result-file <path>] [--json]',
    );
  });
});

describe("vapi swarm detached runs", () => {
  it("starts the requested lead and returns the detached JSON shape without registry secrets", async () => {
    const home = await homeWithRuntimeSwarm("vapi-swarm-detached-lead-");
    const fake = fakeRuntime();
    const captured = captureIo();
    const task = `Research ${RECOVERY_PHRASE} ${PRIVATE_KEY} ${PASSPHRASE} ${API_KEY} ${LINK_RESULT.tokens.accessToken} ${START.deviceCode} ${LINK_RESULT.routerKey}`;

    expect(
      await run(
        [
          "swarm",
          "run",
          "team",
          task,
          "--mode",
          "lead",
          "--lead",
          "team-lead-1",
          "--budget",
          "0.75",
          "--draw",
          "1.50",
          "--detach",
          "--json",
        ],
        captured.io,
        runtimeDependencies(fake.runtime),
      ),
    ).toBe(0);

    const result = JSON.parse(onlyLine(captured.stdout)) as {
      detached: boolean;
      runId: string;
      mode: string;
      kind: string;
      runs: Array<{ member: string; runId: string; mode: string; state: string }>;
      skipped: Array<{ member: string; reason: string }>;
    };
    expect(result).toMatchObject({
      detached: true,
      mode: "lead",
      kind: "local",
      runs: [{ member: "team-lead-1", mode: "lead", state: "running" }],
      skipped: [{ member: "team-observer-1", reason: "not_linked" }],
    });
    expect(fake.start).toHaveBeenCalledOnce();
    expect(fake.start.mock.calls[0]![0]).toEqual({
      swarm: "team",
      account: "team-lead-1",
      profile: "team-lead-1",
      role: "lead",
    });
    expect(fake.start.mock.calls[0]![1]).toMatchObject({
      runId: result.runId,
      mode: "lead",
      budgetUsd: "0.75",
      drawUsd: "1.50",
    });
    // The child runs the task exactly as typed; only the stored registry copy is scrubbed.
    expect(fake.start.mock.calls[0]![1].task).toBe(task);
    const registry = (
      await Promise.all(
        (await readdir(join(home, "runs")))
          .filter((file) => file.endsWith(".json"))
          .map(async (file) => await readFile(join(home, "runs", file), "utf8")),
      )
    ).join("\n");
    expectNoRunSecrets(registry);
  });

  it("starts each eligible member with a parent run id and skips an unlinked member", async () => {
    await homeWithRuntimeSwarm("vapi-swarm-detached-each-");
    const fake = fakeRuntime();
    const captured = captureIo();

    expect(
      await run(
        [
          "swarm",
          "run",
          "team",
          "Compare",
          "--mode",
          "each",
          "--budget",
          "0.40",
          "--detach",
          "--json",
        ],
        captured.io,
        runtimeDependencies(fake.runtime),
      ),
    ).toBe(0);

    const result = JSON.parse(onlyLine(captured.stdout)) as {
      runId: string;
      runs: Array<{ member: string; runId: string; parentRunId: string }>;
      skipped: Array<{ member: string; reason: string }>;
    };
    expect(result.runs.map(({ member }) => member)).toEqual(["team-lead-1", "team-helper-1"]);
    expect(result.runs.every(({ parentRunId }) => parentRunId === result.runId)).toBe(true);
    expect(result.skipped).toContainEqual({
      member: "team-observer-1",
      role: "observer",
      reason: "not_linked",
    });
    expect(fake.start).toHaveBeenCalledTimes(2);
    for (const [, memberRun] of fake.start.mock.calls) {
      expect(memberRun).toMatchObject({
        task: "Compare",
        mode: "agent",
        budgetUsd: "0.40",
        parentRunId: result.runId,
      });
    }
  });

  it("prints started, skipped, follow, and stop lines for a detached swarm", async () => {
    await homeWithRuntimeSwarm("vapi-swarm-detached-human-");
    const fake = fakeRuntime();
    const captured = captureIo();

    expect(
      await run(
        ["swarm", "run", "team", "Research", "--lead", "team-lead-1", "--detach"],
        captured.io,
        runtimeDependencies(fake.runtime),
      ),
    ).toBe(0);
    expect(captured.stdout[0]).toMatch(/^team-lead-1: run_[0-9a-f]{24} started \(local\)$/u);
    expect(captured.stdout).toContain("team-observer-1: skipped (not_linked)");
    expect(captured.stdout.at(-2)).toBe("Follow with: vapi swarm runs team");
    expect(captured.stdout.at(-1)).toBe("Stop with: vapi swarm stop team --all");
  });

  it("refuses a busy lead, then permits it after the runtime reports finished", async () => {
    await homeWithRuntimeSwarm("vapi-swarm-detached-busy-lead-");
    const fake = fakeRuntime();
    const deps = runtimeDependencies(fake.runtime);
    const first = captureIo();
    expect(
      await run(
        ["swarm", "run", "team", "First", "--lead", "team-lead-1", "--detach", "--json"],
        first.io,
        deps,
      ),
    ).toBe(0);
    const runId = (JSON.parse(onlyLine(first.stdout)) as { runId: string }).runId;

    const busy = captureIo();
    expect(
      await run(
        ["swarm", "run", "team", "Second", "--lead", "team-lead-1", "--detach", "--json"],
        busy.io,
        deps,
      ),
    ).toBe(1);
    expect(JSON.parse(onlyLine(busy.stdout))).toMatchObject({
      code: "member_busy",
      exitCode: 1,
    });

    fake.states.set(runId, { state: "finished", exitCode: 0 });
    expect(
      await run(
        ["swarm", "run", "team", "Third", "--lead", "team-lead-1", "--detach", "--json"],
        captureIo().io,
        deps,
      ),
    ).toBe(0);
    expect(fake.start).toHaveBeenCalledTimes(2);
  });

  it("reports busy members as skipped in each mode and retries them after completion", async () => {
    await homeWithRuntimeSwarm("vapi-swarm-detached-busy-each-");
    const fake = fakeRuntime();
    const deps = runtimeDependencies(fake.runtime);
    const first = captureIo();
    expect(
      await run(
        [
          "swarm",
          "run",
          "team",
          "First",
          "--mode",
          "each",
          "--budget",
          "0.40",
          "--detach",
          "--json",
        ],
        first.io,
        deps,
      ),
    ).toBe(0);
    const firstResult = JSON.parse(onlyLine(first.stdout)) as { runs: Array<{ runId: string }> };

    const busy = captureIo();
    expect(
      await run(
        [
          "swarm",
          "run",
          "team",
          "Second",
          "--mode",
          "each",
          "--budget",
          "0.40",
          "--detach",
          "--json",
        ],
        busy.io,
        deps,
      ),
    ).toBe(1);
    const busyResult = JSON.parse(onlyLine(busy.stdout)) as {
      runs: unknown[];
      skipped: Array<{ member: string; reason: string }>;
    };
    expect(busyResult.runs).toEqual([]);
    expect(busyResult.skipped).toEqual(
      expect.arrayContaining([
        { member: "team-lead-1", role: "lead", reason: "member_busy" },
        { member: "team-helper-1", role: "helper", reason: "member_busy" },
      ]),
    );

    for (const { runId } of firstResult.runs) fake.states.set(runId, { state: "finished" });
    expect(
      await run(
        [
          "swarm",
          "run",
          "team",
          "Third",
          "--mode",
          "each",
          "--budget",
          "0.40",
          "--detach",
          "--json",
        ],
        captureIo().io,
        deps,
      ),
    ).toBe(0);
    expect(fake.start).toHaveBeenCalledTimes(4);
  });

  it("refuses railway without --allow-remote-key before writing a registry record and rejects runtime without detach", async () => {
    const home = await homeWithRuntimeSwarm("vapi-swarm-detached-runtime-");
    const railway = captureIo();
    expect(
      await run(
        ["swarm", "run", "team", "Research", "--detach", "--runtime", "railway", "--json"],
        railway.io,
      ),
    ).toBe(1);
    expect(JSON.parse(onlyLine(railway.stdout))).toMatchObject({
      exitCode: 1,
      code: "remote_key_not_allowed",
    });
    await expect(readdir(join(home, "runs"))).rejects.toMatchObject({ code: "ENOENT" });

    const attached = captureIo();
    expect(
      await run(["swarm", "run", "team", "Research", "--runtime", "local", "--json"], attached.io),
    ).toBe(2);
    expect(JSON.parse(onlyLine(attached.stdout))).toMatchObject({ exitCode: 2 });
  });

  it("lists records with refreshed status in JSON and in a human table", async () => {
    await homeWithRuntimeSwarm("vapi-swarm-detached-list-");
    const fake = fakeRuntime();
    const deps = runtimeDependencies(fake.runtime);
    const started = captureIo();
    expect(
      await run(
        ["swarm", "run", "team", "Research", "--lead", "team-lead-1", "--detach", "--json"],
        started.io,
        deps,
      ),
    ).toBe(0);
    const runId = (JSON.parse(onlyLine(started.stdout)) as { runId: string }).runId;
    fake.states.set(runId, { state: "finished", exitCode: 0 });

    const json = captureIo();
    expect(await run(["swarm", "runs", "team", "--json"], json.io, deps)).toBe(0);
    expect(JSON.parse(onlyLine(json.stdout))).toMatchObject({
      swarm: "team",
      runs: [{ member: "team-lead-1", runId, state: "finished", exitCode: 0 }],
    });

    const human = captureIo();
    expect(await run(["swarm", "runs", "team"], human.io, deps)).toBe(0);
    expect(human.stdout[0]).toContain("MEMBER");
    expect(human.stdout.join("\n")).toContain(runId);
    expect(human.stdout.join("\n")).toContain("finished");
  });

  it("shows an actionable fix when a starting reservation cannot be reconciled", async () => {
    const home = await homeWithRuntimeSwarm("vapi-swarm-detached-stale-starting-");
    const fake = fakeRuntime();
    const deps = runtimeDependencies(fake.runtime);
    const runId = "run_999999999999999999999998";
    await writeRunRecord(home, {
      v: 1,
      runId,
      kind: "local",
      member: {
        swarm: "team",
        account: "team-lead-1",
        profile: "team-lead-1",
        role: "lead",
      },
      run: { runId, task: "Research", mode: "lead" },
      handle: {
        runId,
        kind: "local",
        member: {
          swarm: "team",
          account: "team-lead-1",
          profile: "team-lead-1",
          role: "lead",
        },
        startedAt: "2026-09-30T08:00:00.000Z",
        ref: "",
      },
      startedAt: "2026-09-30T08:00:00.000Z",
      state: "starting",
    });

    const json = captureIo();
    expect(await run(["swarm", "runs", "team", "--json"], json.io, deps)).toBe(1);
    expect(JSON.parse(onlyLine(json.stdout))).toMatchObject({
      runs: [
        {
          runId,
          state: "starting",
          detail: `Launch reference is still unavailable. Confirm the worker is stopped, then run vapi swarm stop team ${runId} --confirm-worker-stopped.`,
        },
      ],
    });

    const human = captureIo();
    expect(await run(["swarm", "runs", "team"], human.io, deps)).toBe(1);
    expect(human.stderr).toEqual([
      `WARNING: ${runId} could not finish starting: Launch reference is still unavailable. Confirm the worker is stopped, then run vapi swarm stop team ${runId} --confirm-worker-stopped.`,
    ]);

    const refused = captureIo();
    expect(await run(["swarm", "stop", "team", runId, "--json"], refused.io, deps)).toBe(1);
    expect(JSON.parse(onlyLine(refused.stdout))).toMatchObject({
      failed: [
        {
          runId,
          error: expect.stringContaining(`--confirm-worker-stopped`),
        },
      ],
    });

    const cleared = captureIo();
    expect(
      await run(
        ["swarm", "stop", "team", runId, "--confirm-worker-stopped", "--json"],
        cleared.io,
        deps,
      ),
    ).toBe(0);
    expect(JSON.parse(onlyLine(cleared.stdout))).toMatchObject({
      stopped: [{ runId, state: "stopped" }],
    });
  });

  it("warns and exits non-zero when Railway cleanup leaves a run reported as running", async () => {
    await homeWithRuntimeSwarm("vapi-swarm-detached-cleanup-warning-");
    const fake = fakeRuntime();
    const deps = runtimeDependencies(fake.runtime);
    const started = captureIo();
    expect(
      await run(
        ["swarm", "run", "team", "Research", "--lead", "team-lead-1", "--detach", "--json"],
        started.io,
        deps,
      ),
    ).toBe(0);
    const runId = (JSON.parse(onlyLine(started.stdout)) as { runId: string }).runId;
    fake.states.set(runId, {
      state: "running",
      detail: "finished; sandbox destroy failed: railway timed out",
    });

    const json = captureIo();
    expect(await run(["swarm", "runs", "team", "--json"], json.io, deps)).toBe(1);
    expect(JSON.parse(onlyLine(json.stdout))).toMatchObject({
      runs: [
        {
          runId,
          state: "running",
          detail: "finished; sandbox destroy failed: railway timed out",
        },
      ],
    });

    const human = captureIo();
    expect(await run(["swarm", "runs", "team"], human.io, deps)).toBe(1);
    expect(human.stderr).toEqual([
      `WARNING: ${runId} is still running because cleanup failed: finished; sandbox destroy failed: railway timed out. Stop it with: vapi swarm stop team ${runId}`,
    ]);
  });

  it("stops only running records with their registry handles", async () => {
    await homeWithRuntimeSwarm("vapi-swarm-detached-stop-");
    const fake = fakeRuntime();
    const deps = runtimeDependencies(fake.runtime);
    const started = captureIo();
    expect(
      await run(
        [
          "swarm",
          "run",
          "team",
          "Compare",
          "--mode",
          "each",
          "--budget",
          "0.40",
          "--detach",
          "--json",
        ],
        started.io,
        deps,
      ),
    ).toBe(0);
    const runs = (JSON.parse(onlyLine(started.stdout)) as { runs: Array<{ runId: string }> }).runs;
    fake.states.set(runs[1]!.runId, { state: "finished", exitCode: 0 });

    const stopped = captureIo();
    expect(await run(["swarm", "stop", "team", "--all", "--json"], stopped.io, deps)).toBe(0);
    const result = JSON.parse(onlyLine(stopped.stdout)) as {
      stopped: Array<{ runId: string; state: string }>;
      unchanged: Array<{ runId: string; state: string }>;
    };
    expect(result.stopped).toEqual([
      expect.objectContaining({ runId: runs[0]!.runId, state: "stopped" }),
    ]);
    expect(result.unchanged).toEqual([
      expect.objectContaining({ runId: runs[1]!.runId, state: "finished" }),
    ]);
    expect(fake.stop).toHaveBeenCalledOnce();
    expect(fake.stop.mock.calls[0]![0].ref).toBe(`handle:${runs[0]!.runId}`);
  });

  it("returns run_not_found for a registry record owned by another swarm", async () => {
    const home = await homeWithRuntimeSwarm("vapi-swarm-detached-other-");
    const fake = fakeRuntime();
    const runId = "run_999999999999999999999999";
    await writeRunRecord(home, {
      v: 1,
      runId,
      kind: "local",
      member: { swarm: "other", account: "other-lead-1", profile: "other-lead-1" },
      run: { runId, task: "Other task", mode: "lead" },
      handle: {
        runId,
        kind: "local",
        member: { swarm: "other", account: "other-lead-1", profile: "other-lead-1" },
        startedAt: "2026-09-30T08:00:00.000Z",
        ref: "handle:other",
      },
      startedAt: "2026-09-30T08:00:00.000Z",
      state: "running",
    });
    const captured = captureIo();

    expect(
      await run(
        ["swarm", "stop", "team", runId, "--json"],
        captured.io,
        runtimeDependencies(fake.runtime),
      ),
    ).toBe(1);
    expect(JSON.parse(onlyLine(captured.stdout))).toEqual({
      error: `Run ${runId} was not found for swarm team.`,
      exitCode: 1,
      code: "run_not_found",
    });
    expect(fake.stop).not.toHaveBeenCalled();
  });

  it("returns run_not_found for an invalid run id", async () => {
    await homeWithRuntimeSwarm("vapi-swarm-detached-invalid-run-");
    const fake = fakeRuntime();
    const captured = captureIo();

    expect(
      await run(
        ["swarm", "stop", "team", "not-a-run-id", "--json"],
        captured.io,
        runtimeDependencies(fake.runtime),
      ),
    ).toBe(1);
    expect(JSON.parse(onlyLine(captured.stdout))).toEqual({
      error: "Run not-a-run-id was not found for swarm team.",
      exitCode: 1,
      code: "run_not_found",
    });
    expect(fake.stop).not.toHaveBeenCalled();
  });

  it("requires exactly one run id or --all when stopping", async () => {
    await homeWithRuntimeSwarm("vapi-swarm-detached-stop-usage-");
    for (const argv of [
      ["swarm", "stop", "team", "--json"],
      ["swarm", "stop", "team", "run_999999999999999999999999", "--all", "--json"],
    ]) {
      const captured = captureIo();
      expect(await run(argv, captured.io)).toBe(2);
      expect(JSON.parse(onlyLine(captured.stdout))).toMatchObject({ exitCode: 2 });
    }
  });

  it("shows a running detached run in swarm status JSON and human output", async () => {
    await homeWithRuntimeSwarm("vapi-swarm-detached-status-");
    const fake = fakeRuntime();
    const deps = runtimeDependencies(fake.runtime);
    const started = captureIo();
    expect(
      await run(
        ["swarm", "run", "team", "Research", "--lead", "team-lead-1", "--detach", "--json"],
        started.io,
        deps,
      ),
    ).toBe(0);
    const runId = (JSON.parse(onlyLine(started.stdout)) as { runId: string }).runId;

    const json = captureIo();
    expect(await run(["swarm", "status", "team", "--json"], json.io, deps)).toBe(0);
    expect(JSON.parse(onlyLine(json.stdout))).toMatchObject({
      runs: [{ member: "team-lead-1", runId, state: "running" }],
    });

    const human = captureIo();
    expect(await run(["swarm", "status", "team"], human.io, deps)).toBe(0);
    expect(human.stdout.join("\n")).toContain(`  running: ${runId} (lead, since `);
  });
});

describe("vapi swarm railway runs", () => {
  beforeEach(() => {
    // The railway adapter also reads process.env for agent markers; the shell
    // running these tests may set one. Empty counts as unset.
    for (const name of AGENT_MARKER_VARIABLES) vi.stubEnv(name, "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const railwayArgs = [
    "swarm",
    "run",
    "team",
    "Compare",
    "--mode",
    "each",
    "--runtime",
    "railway",
    "--budget",
    "0.40",
  ];

  it("refuses a run without --allow-remote-key before touching anything", async () => {
    const home = await homeWithRailwaySwarm("vapi-swarm-railway-flag-");
    const fake = fakeRailwayExec();
    const captured = captureIo();

    expect(
      await run(
        [...railwayArgs, "--checkpoint", "vapi-cli", "--json"],
        captured.io,
        railwayDependencies(fake.exec),
      ),
    ).toBe(1);

    const error = JSON.parse(onlyLine(captured.stdout)) as { error: string; code: string };
    expect(error.code).toBe("remote_key_not_allowed");
    expect(error.error).toContain("--allow-remote-key");
    expect(fake.exec).not.toHaveBeenCalled();
    await expect(readdir(join(home, "runs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses with VAPI_NO_SECRETS or an agent marker even with --allow-remote-key", async () => {
    const home = await homeWithRailwaySwarm("vapi-swarm-railway-marker-");
    const fake = fakeRailwayExec();
    for (const marker of ["VAPI_NO_SECRETS", "CLAUDECODE"]) {
      const captured = captureIo();
      expect(
        await run(
          [...railwayArgs, "--checkpoint", "vapi-cli", "--allow-remote-key", "--json"],
          captured.io,
          railwayDependencies(fake.exec, { [marker]: "1" }),
        ),
      ).toBe(1);
      const error = JSON.parse(onlyLine(captured.stdout)) as { error: string; code: string };
      expect(error.code).toBe("agent_marker");
      expect(error.error).toContain(`${marker} is set`);
    }
    expect(fake.exec).not.toHaveBeenCalled();
    await expect(readdir(join(home, "runs"))).rejects.toMatchObject({ code: "ENOENT" });
    const audit = await auditText(home);
    expect(audit).toContain('"detail":"refused: swarm=team VAPI_NO_SECRETS is set."');
    expect(audit).toContain('"agentMarker":"CLAUDECODE"');
  });

  it("audits an agent-marker refusal as refused, never as an export", async () => {
    const home = await homeWithRailwaySwarm("vapi-swarm-railway-refused-");
    const fake = fakeRailwayExec();
    const captured = captureIo();

    expect(
      await run(
        [...railwayArgs, "--checkpoint", "vapi-cli", "--allow-remote-key", "--json"],
        captured.io,
        railwayDependencies(fake.exec, { CI: "1" }),
      ),
    ).toBe(1);

    const lines = (await auditText(home))
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { event: string; agentMarker?: string; detail?: string })
      .filter((line) => line.event.startsWith("agent.remote_key_"));
    expect(lines).toEqual([
      expect.objectContaining({
        event: "agent.remote_key_refused",
        agentMarker: "CI",
        detail: "refused: swarm=team CI is set.",
      }),
    ]);
    expect(fake.exec).not.toHaveBeenCalled();
    await expectNoMemberSecrets(home, [await auditText(home)]);
  });

  it("refuses lead mode, a missing checkpoint and railway flags on the local runtime", async () => {
    const home = await homeWithRailwaySwarm("vapi-swarm-railway-usage-");
    const fake = fakeRailwayExec();
    for (const argv of [
      [
        "swarm",
        "run",
        "team",
        "Compare",
        "--runtime",
        "railway",
        "--checkpoint",
        "vapi-cli",
        "--allow-remote-key",
      ],
      [
        "swarm",
        "run",
        "team",
        "Compare",
        "--mode",
        "lead",
        "--runtime",
        "railway",
        "--checkpoint",
        "vapi-cli",
        "--allow-remote-key",
      ],
    ]) {
      const captured = captureIo();
      expect(await run([...argv, "--json"], captured.io, railwayDependencies(fake.exec))).toBe(2);
      expect((JSON.parse(onlyLine(captured.stdout)) as { error: string }).error).toContain(
        "the railway runtime only runs --mode each",
      );
    }

    const missing = captureIo();
    expect(
      await run(
        [...railwayArgs, "--allow-remote-key", "--json"],
        missing.io,
        railwayDependencies(fake.exec),
      ),
    ).toBe(2);
    expect((JSON.parse(onlyLine(missing.stdout)) as { error: string }).error).toContain(
      "VAPI_RAILWAY_CHECKPOINT",
    );

    for (const flag of [["--keep-sandbox"], ["--allow-remote-key"], ["--checkpoint", "vapi-cli"]]) {
      for (const runtime of [["--runtime", "local"], []]) {
        const local = captureIo();
        expect(
          await run(
            ["swarm", "run", "team", "Compare", "--mode", "each", "--detach", ...runtime, ...flag],
            local.io,
            railwayDependencies(fake.exec),
          ),
        ).toBe(2);
        expect(local.stderr.join("\n")).toContain("need --runtime railway");
      }
    }
    expect(fake.exec).not.toHaveBeenCalled();
    await expect(readdir(join(home, "runs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses the whole run when one member is over the remote limits", async () => {
    const home = await homeWithRailwaySwarm("vapi-swarm-railway-limit-", {
      helperCeilingAtomic: 5_000_000n,
    });
    const fake = fakeRailwayExec();
    const captured = captureIo();

    expect(
      await run(
        [...railwayArgs, "--checkpoint", "vapi-cli", "--allow-remote-key"],
        captured.io,
        railwayDependencies(fake.exec),
      ),
    ).toBe(1);

    const message = captured.stderr.join("\n");
    expect(message).toContain("Nothing was started and no key left this machine.");
    expect(message).toContain("team-helper-1:");
    expect(message).toContain("vapi accounts caps team-helper-1 --ceiling 2");
    expect(message).not.toContain("team-lead-1:");
    expect(fake.exec).not.toHaveBeenCalled();
    await expect(readdir(join(home, "runs"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await auditText(home)).not.toContain("agent.remote_key_exported");
  });

  it("refuses the whole run before any key leaves when a later member holds too much", async () => {
    const home = await homeWithRailwaySwarm("vapi-swarm-railway-preflight-balance-");
    const helper = await walletAddress(home, "team-helper-1");
    const fake = fakeRailwayExec();
    const reads: string[] = [];
    const captured = captureIo();

    expect(
      await run(
        [...railwayArgs, "--checkpoint", "vapi-cli", "--allow-remote-key", "--json"],
        captured.io,
        {
          ...railwayDependencies(fake.exec),
          swarm: {
            balanceReader: async ({ account, address, network }) => {
              reads.push(`${account}@${network}`);
              if (network !== BASE_MAINNET_CAIP2) return 0n;
              return address === helper ? 5_000_000n : 500_000n;
            },
          },
        },
      ),
    ).toBe(1);

    const error = JSON.parse(onlyLine(captured.stdout)) as { error: string; code?: string };
    expect(error.code).toBe("balance_too_high");
    expect(error.error).toContain("Nothing was started and no key left this machine.");
    expect(error.error).toContain("team-helper-1:");
    expect(error.error).toContain("vapi swarm rebalance team");
    expect(reads).toEqual([
      `team-lead-1@${BASE_MAINNET_CAIP2}`,
      `team-lead-1@${ARC_MAINNET_CAIP2}`,
      `team-lead-1@${ARC_TESTNET_CAIP2}`,
      `team-helper-1@${BASE_MAINNET_CAIP2}`,
    ]);
    // No sandbox was created, so no member key reached one.
    expect(fake.exec).not.toHaveBeenCalled();
    await expect(readdir(join(home, "runs"))).rejects.toMatchObject({ code: "ENOENT" });
    const audit = await auditText(home);
    expect(audit).not.toContain("agent.remote_key_exported");
    expect(audit).toContain("refused: balance_too_high");
  });

  it("refuses the whole run, fail closed, when a member's balance cannot be read", async () => {
    const home = await homeWithRailwaySwarm("vapi-swarm-railway-preflight-unreadable-");
    const fake = fakeRailwayExec();
    const captured = captureIo();

    expect(
      await run(
        [...railwayArgs, "--checkpoint", "vapi-cli", "--allow-remote-key", "--json"],
        captured.io,
        {
          ...railwayDependencies(fake.exec),
          swarm: {
            balanceReader: async ({ account }) => {
              if (account === "team-helper-1") {
                throw new Error("fetch failed: https://base.example/rpc?apikey=SECRET");
              }
              return 0n;
            },
          },
        },
      ),
    ).toBe(1);

    const error = JSON.parse(onlyLine(captured.stdout)) as { error: string; code?: string };
    expect(error.code).toBe("balance_unreadable");
    expect(error.error).not.toContain("SECRET");
    expect(fake.exec).not.toHaveBeenCalled();
    await expect(readdir(join(home, "runs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("aborts on a terminal when the swarm name is not typed, and starts when it is", async () => {
    const home = await homeWithRailwaySwarm("vapi-swarm-railway-tty-");
    const fake = fakeRailwayExec();
    const line = vi.fn(async () => "not-the-swarm");
    const declined = captureIo();

    expect(
      await run([...railwayArgs, "--checkpoint", "vapi-cli", "--allow-remote-key"], declined.io, {
        ...railwayDependencies(fake.exec),
        interactive: true,
        prompts: { secret: async () => "", line },
      }),
    ).toBe(1);
    expect(line).toHaveBeenCalledOnce();
    expect(line.mock.calls[0]).toEqual(["Type team to send these member keys to Railway: "]);
    expect(declined.stderr.join("\n")).toContain(REMOTE_WARNING);
    expect(declined.stderr.at(-1)).toBe(
      "That is not the swarm name. Nothing was started and no key left this machine.",
    );
    expect(fake.exec).not.toHaveBeenCalled();
    await expect(readdir(join(home, "runs"))).rejects.toMatchObject({ code: "ENOENT" });

    const confirmed = captureIo();
    expect(
      await run(
        [...railwayArgs, "--checkpoint", "vapi-cli", "--allow-remote-key", "--json"],
        confirmed.io,
        {
          ...railwayDependencies(fake.exec),
          interactive: true,
          prompts: { secret: async () => "", line: async () => "team" },
        },
      ),
    ).toBe(0);
    expect(fake.creates()).toHaveLength(2);
  });

  it("starts one sandbox per eligible member off a terminal, from the env checkpoint", async () => {
    const home = await homeWithRailwaySwarm("vapi-swarm-railway-start-");
    const fake = fakeRailwayExec();
    const captured = captureIo();

    expect(
      await run(
        [...railwayArgs, "--allow-remote-key", "--json"],
        captured.io,
        railwayDependencies(fake.exec, { VAPI_RAILWAY_CHECKPOINT: "vapi-cli-env" }),
      ),
    ).toBe(0);

    const result = JSON.parse(onlyLine(captured.stdout)) as {
      detached: boolean;
      kind: string;
      runId: string;
      runs: Array<{ member: string; runId: string; kind: string; state: string }>;
      skipped: Array<{ member: string; reason: string }>;
    };
    expect(result).toMatchObject({ detached: true, kind: "railway", mode: "each" });
    expect(result.runs.map(({ member, kind, state }) => ({ member, kind, state }))).toEqual([
      { member: "team-lead-1", kind: "railway", state: "running" },
      { member: "team-helper-1", kind: "railway", state: "running" },
    ]);
    expect(result.runs.every(({ runId }) => /^run_[0-9a-f]{24}$/u.test(runId))).toBe(true);
    expect(result.skipped).toContainEqual({
      member: "team-observer-1",
      role: "observer",
      reason: "not_linked",
    });
    expect(captured.stderr.join("\n")).toContain(REMOTE_WARNING);

    const creates = fake.creates();
    expect(creates).toHaveLength(2);
    for (const args of creates) {
      expect(args.slice(0, 4)).toEqual(["sandbox", "create", "--checkpoint", "vapi-cli-env"]);
    }
    const detaches = fake.calls.filter((args) => args[1] === "exec" && args.includes("--detach"));
    expect(detaches.map((args) => args[2])).toEqual(["sbx_1", "sbx_2"]);
    for (const args of detaches) {
      expect(args).toEqual(expect.arrayContaining(["--bundle-env", "VAPI_MEMBER_BUNDLE"]));
      expect(args).toEqual(expect.arrayContaining(["--budget", "0.40"]));
    }
    expect(fake.envFiles).toHaveLength(2);
    expect(fake.envFiles.every((text) => text.startsWith("VAPI_MEMBER_BUNDLE="))).toBe(true);

    const audit = await auditText(home);
    expect(audit.match(/agent\.remote_key_exported/gu)).toHaveLength(2);
    await expectNoMemberSecrets(home, [
      captured.stdout.join("\n"),
      captured.stderr.join("\n"),
      JSON.stringify(fake.calls),
      await registryText(home),
      audit,
    ]);
  });

  it("confirmation retires an id-less stale sidecar before the member starts again", async () => {
    const home = await homeWithRailwaySwarm("vapi-swarm-railway-confirm-stale-start-");
    const runId = CREATING_RUN;
    const member = {
      swarm: "team",
      account: "team-lead-1",
      profile: "team-lead-1",
      role: "lead",
    };
    await writeRunRecord(home, {
      v: 1,
      runId,
      kind: "railway",
      member,
      run: { runId, task: "Research", mode: "agent" },
      handle: {
        runId,
        kind: "railway",
        member,
        startedAt: "2026-09-30T08:00:00.000Z",
        ref: "",
      },
      startedAt: "2026-09-30T08:00:00.000Z",
      state: "starting",
    });
    await writeSidecarFile(home, {
      runId,
      account: member.account,
      state: "creating",
    });
    const fake = fakeRailwayExec();
    const deps = railwayDependencies(fake.exec);

    const confirmed = captureIo();
    expect(
      await run(
        ["swarm", "stop", "team", runId, "--confirm-worker-stopped", "--json"],
        confirmed.io,
        deps,
      ),
    ).toBe(0);
    expect(JSON.parse(onlyLine(confirmed.stdout))).toMatchObject({
      stopped: [{ runId, member: member.account, state: "stopped" }],
      sandboxes: [],
    });
    expect((await listRunRecords(home, { swarm: "team" }))[0]).toMatchObject({
      runId,
      state: "stopped",
    });
    expect(await readdir(join(home, "runs"))).not.toContain(`${runId}.railway.json`);

    const restarted = captureIo();
    expect(
      await run(
        [...railwayArgs, "--checkpoint", "vapi-cli", "--allow-remote-key", "--json"],
        restarted.io,
        deps,
      ),
    ).toBe(0);
    expect(JSON.parse(onlyLine(restarted.stdout))).toMatchObject({
      runs: expect.arrayContaining([expect.objectContaining({ member: member.account })]),
    });
    expect(fake.creates()).toHaveLength(2);
  });

  it("lists railway runs, destroys a finished sandbox, and stops the rest", async () => {
    const home = await homeWithRailwaySwarm("vapi-swarm-railway-lifecycle-");
    const fake = fakeRailwayExec();
    const deps = railwayDependencies(fake.exec);
    const started = captureIo();
    expect(
      await run(
        [...railwayArgs, "--checkpoint", "vapi-cli", "--allow-remote-key", "--json"],
        started.io,
        deps,
      ),
    ).toBe(0);
    const runs = (JSON.parse(onlyLine(started.stdout)) as { runs: Array<{ runId: string }> }).runs;

    fake.finished.add("sbx_1");
    const listed = captureIo();
    expect(await run(["swarm", "runs", "team", "--json"], listed.io, deps)).toBe(0);
    // Both runs share one pinned startedAt, so the registry order follows the random run ids.
    const listedResult = JSON.parse(onlyLine(listed.stdout)) as {
      swarm: string;
      runs: Array<{ member: string; runId: string; kind: string; state: string }>;
    };
    expect(listedResult.swarm).toBe("team");
    expect(listedResult.runs).toHaveLength(2);
    expect(listedResult.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          member: "team-lead-1",
          runId: runs[0]!.runId,
          kind: "railway",
          state: "finished",
        }),
        expect.objectContaining({
          member: "team-helper-1",
          runId: runs[1]!.runId,
          kind: "railway",
          state: "running",
        }),
      ]),
    );
    expect(fake.destroyed).toEqual(["sbx_1"]);

    const stopped = captureIo();
    expect(await run(["swarm", "stop", "team", "--all", "--json"], stopped.io, deps)).toBe(0);
    const result = JSON.parse(onlyLine(stopped.stdout)) as {
      stopped: Array<{ runId: string }>;
      unchanged: Array<{ runId: string; state: string }>;
    };
    expect(result.stopped.map(({ runId }) => runId)).toEqual([runs[1]!.runId]);
    expect(result.unchanged).toEqual([
      expect.objectContaining({ runId: runs[0]!.runId, state: "finished" }),
    ]);
    expect(fake.destroyed).toEqual(["sbx_1", "sbx_2"]);

    await expectNoMemberSecrets(home, [
      listed.stdout.join("\n"),
      stopped.stdout.join("\n"),
      JSON.stringify(fake.calls),
      await registryText(home),
    ]);
  });

  it("keeps a finished sandbox with --keep-sandbox", async () => {
    await homeWithRailwaySwarm("vapi-swarm-railway-keep-");
    const fake = fakeRailwayExec();
    const deps = railwayDependencies(fake.exec);
    expect(
      await run(
        [...railwayArgs, "--checkpoint", "vapi-cli", "--allow-remote-key", "--keep-sandbox"],
        captureIo().io,
        deps,
      ),
    ).toBe(0);

    fake.finished.add("sbx_1");
    fake.finished.add("sbx_2");
    const listed = captureIo();
    expect(await run(["swarm", "runs", "team", "--json"], listed.io, deps)).toBe(0);
    const runs = (JSON.parse(onlyLine(listed.stdout)) as { runs: Array<{ state: string }> }).runs;
    expect(runs.map(({ state }) => state)).toEqual(["finished", "finished"]);
    expect(fake.destroyed).toEqual([]);
  });

  it("refuses an invalid checkpoint from --checkpoint or VAPI_RAILWAY_CHECKPOINT as a usage error", async () => {
    const home = await homeWithRailwaySwarm("vapi-swarm-railway-checkpoint-name-");
    const fake = fakeRailwayExec();
    const bad = ["-env-file", "../etc", "vapi cli", "a".repeat(65), "x;rm"];
    for (const checkpoint of bad) {
      for (const source of ["flag", "env"] as const) {
        const captured = captureIo();
        expect(
          await run(
            [
              ...railwayArgs,
              ...(source === "flag" ? ["--checkpoint", checkpoint] : []),
              "--allow-remote-key",
              "--json",
            ],
            captured.io,
            railwayDependencies(
              fake.exec,
              source === "env" ? { VAPI_RAILWAY_CHECKPOINT: checkpoint } : {},
            ),
          ),
        ).toBe(2);
        const error = JSON.parse(onlyLine(captured.stdout)) as { error: string };
        expect(error.error).toContain(
          source === "flag" ? "--checkpoint" : "VAPI_RAILWAY_CHECKPOINT",
        );
        expect(error.error).toContain("letters, digits");
      }
    }
    expect(fake.exec).not.toHaveBeenCalled();
    await expect(readdir(join(home, "runs"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await auditText(home)).not.toContain("agent.remote_key_exported");
  });

  it("shows the checkpoint and where it came from before the typed confirmation", async () => {
    await homeWithRailwaySwarm("vapi-swarm-railway-checkpoint-shown-");
    for (const [argv, env, line] of [
      [["--checkpoint", "vapi-cli"], {}, "Checkpoint: vapi-cli (from --checkpoint)"],
      [
        [],
        { VAPI_RAILWAY_CHECKPOINT: "vapi-cli-env" },
        "Checkpoint: vapi-cli-env (from VAPI_RAILWAY_CHECKPOINT)",
      ],
    ] as const) {
      const fake = fakeRailwayExec();
      const captured = captureIo();
      let shownBeforePrompt = false;
      expect(
        await run([...railwayArgs, ...argv, "--allow-remote-key"], captured.io, {
          ...railwayDependencies(fake.exec, { ...env }),
          interactive: true,
          prompts: {
            secret: async () => "",
            line: async () => {
              shownBeforePrompt = captured.stderr.join("\n").includes(line);
              return "not-the-swarm";
            },
          },
        }),
      ).toBe(1);
      expect(shownBeforePrompt).toBe(true);
      expect(fake.exec).not.toHaveBeenCalled();
    }
  });

  it("hands the railway runtime exactly the members the owner confirmed", async () => {
    await homeWithRailwaySwarm("vapi-swarm-railway-confirmed-");
    const requests: Array<RuntimeRequest | undefined> = [];
    const starts: string[] = [];
    const runtime: Runtime = {
      kind: "railway",
      start: async (member, runRequest) => {
        starts.push(member.account);
        return {
          runId: runRequest.runId,
          kind: "railway",
          member,
          startedAt: "2026-09-30T09:00:00.000Z",
          ref: `sbx_${starts.length}`,
        };
      },
      stop: async () => undefined,
      status: async () => ({ state: "running" }),
    };
    const captured = captureIo();
    expect(
      await run(
        [...railwayArgs, "--checkpoint", "vapi-cli", "--allow-remote-key", "--json"],
        captured.io,
        {
          ...railwayDependencies(fakeRailwayExec().exec),
          runtime: (_kind, _home, request) => {
            requests.push(request);
            return runtime;
          },
        },
      ),
    ).toBe(0);
    expect(requests).toEqual([
      {
        checkpoint: "vapi-cli",
        allowRemoteKey: true,
        keepSandbox: false,
        confirmedMembers: ["team-lead-1", "team-helper-1"],
      },
    ]);
    expect(starts).toEqual(["team-lead-1", "team-helper-1"]);
  });

  it("destroys the first member's sandbox when the second member's create fails", async () => {
    const home = await homeWithRailwaySwarm("vapi-swarm-railway-all-or-nothing-");
    const fake = fakeRailwayExec({
      create: (count) =>
        count === 2 ? { code: 1, stdout: "", stderr: "Error: quota exceeded\n" } : undefined,
    });
    const captured = captureIo();
    expect(
      await run(
        [...railwayArgs, "--checkpoint", "vapi-cli", "--allow-remote-key", "--json"],
        captured.io,
        railwayDependencies(fake.exec),
      ),
    ).toBe(1);
    const error = JSON.parse(onlyLine(captured.stdout)) as { error: string };
    expect(error.error).toContain("team-helper-1");
    expect(error.error).toContain("quota exceeded");
    expect(error.error).toContain("Stopped team-lead-1");
    expect(fake.destroyed).toEqual(["sbx_1"]);
    const records = await listRunRecords(home, { swarm: "team" });
    expect(records.map(({ member, state }) => [member.account, state])).toEqual([
      ["team-lead-1", "stopped"],
    ]);
    await expectNoMemberSecrets(home, [captured.stdout.join("\n"), await registryText(home)]);
  });

  it("lists orphaned sandboxes of this swarm in swarm runs, as JSON and as a table", async () => {
    const home = await homeWithRailwaySwarm("vapi-swarm-railway-orphan-list-");
    await writeSidecarFile(home, { runId: ORPHAN_RUN, sandboxId: "sbx_9" });
    await writeSidecarFile(home, {
      runId: CREATING_RUN,
      account: "team-lead-1",
      state: "creating",
    });
    await writeSidecarFile(home, { runId: OTHER_RUN, swarm: "other", sandboxId: "sbx_8" });
    const deps = railwayDependencies(fakeRailwayExec().exec);

    const json = captureIo();
    expect(await run(["swarm", "runs", "team", "--json"], json.io, deps)).toBe(0);
    expect(JSON.parse(onlyLine(json.stdout))).toEqual({
      swarm: "team",
      runs: [],
      sandboxes: [
        {
          runId: ORPHAN_RUN,
          member: "team-helper-1",
          state: "orphaned",
          sandboxId: "sbx_9",
          destroy: "railway sandbox destroy sbx_9",
        },
        {
          runId: CREATING_RUN,
          member: "team-lead-1",
          state: "orphaned",
          destroy: "railway sandbox list",
        },
      ],
    });

    const human = captureIo();
    expect(await run(["swarm", "runs", "team"], human.io, deps)).toBe(0);
    const text = human.stdout.join("\n");
    const orphanRow = human.stdout.find((row) => row.includes(ORPHAN_RUN));
    expect(orphanRow).toContain("team-helper-1");
    expect(orphanRow).toContain("orphaned");
    expect(orphanRow).toContain("railway sandbox destroy sbx_9");
    expect(human.stdout.find((row) => row.includes(CREATING_RUN))).toContain(
      "railway sandbox list",
    );
    expect(text).not.toContain(OTHER_RUN);
  });

  it("stop --all destroys an orphaned sandbox and deletes its sidecar", async () => {
    const home = await homeWithRailwaySwarm("vapi-swarm-railway-orphan-stop-");
    await writeSidecarFile(home, { runId: ORPHAN_RUN, sandboxId: "sbx_9" });
    await writeSidecarFile(home, { runId: OTHER_RUN, swarm: "other", sandboxId: "sbx_8" });
    const fake = fakeRailwayExec();
    const captured = captureIo();

    expect(
      await run(
        ["swarm", "stop", "team", "--all", "--json"],
        captured.io,
        railwayDependencies(fake.exec),
      ),
    ).toBe(0);
    expect(JSON.parse(onlyLine(captured.stdout))).toMatchObject({
      swarm: "team",
      stopped: [],
      unchanged: [],
      sandboxes: [{ runId: ORPHAN_RUN, sandboxId: "sbx_9", destroyed: true }],
    });
    expect(fake.destroyed).toEqual(["sbx_9"]);
    expect(await readdir(join(home, "runs"))).toEqual([`${OTHER_RUN}.railway.json`]);
  });

  it("stop --all keeps the sidecar and exits one when the destroy fails", async () => {
    const home = await homeWithRailwaySwarm("vapi-swarm-railway-orphan-fail-");
    await writeSidecarFile(home, { runId: ORPHAN_RUN, sandboxId: "sbx_9" });
    const fake = fakeRailwayExec({
      destroy: () => ({ code: 1, stdout: "", stderr: "Error: request timed out\n" }),
    });
    const captured = captureIo();

    expect(
      await run(
        ["swarm", "stop", "team", "--all", "--json"],
        captured.io,
        railwayDependencies(fake.exec),
      ),
    ).toBe(1);
    const result = JSON.parse(onlyLine(captured.stdout)) as {
      sandboxes: Array<{ runId: string; sandboxId?: string; destroyed: boolean; error?: string }>;
    };
    expect(result.sandboxes).toEqual([
      expect.objectContaining({ runId: ORPHAN_RUN, sandboxId: "sbx_9", destroyed: false }),
    ]);
    expect(result.sandboxes[0]!.error).toContain("railway sandbox destroy sbx_9");
    expect(await readdir(join(home, "runs"))).toEqual([`${ORPHAN_RUN}.railway.json`]);
    const human = captureIo();
    expect(
      await run(["swarm", "stop", "team", "--all"], human.io, railwayDependencies(fake.exec)),
    ).toBe(1);
    expect(human.stdout.join("\n")).toContain("railway sandbox destroy sbx_9");
  });

  it("stop <runId> destroys a sandbox that only has a sidecar", async () => {
    const home = await homeWithRailwaySwarm("vapi-swarm-railway-orphan-one-");
    await writeSidecarFile(home, { runId: ORPHAN_RUN, sandboxId: "sbx_9" });
    await writeSidecarFile(home, { runId: OTHER_RUN, swarm: "other", sandboxId: "sbx_8" });
    const fake = fakeRailwayExec();

    const other = captureIo();
    expect(
      await run(
        ["swarm", "stop", "team", OTHER_RUN, "--json"],
        other.io,
        railwayDependencies(fake.exec),
      ),
    ).toBe(1);
    expect(JSON.parse(onlyLine(other.stdout))).toMatchObject({ code: "run_not_found" });

    const captured = captureIo();
    expect(
      await run(
        ["swarm", "stop", "team", ORPHAN_RUN, "--json"],
        captured.io,
        railwayDependencies(fake.exec),
      ),
    ).toBe(0);
    expect(JSON.parse(onlyLine(captured.stdout))).toMatchObject({
      stopped: [],
      unchanged: [],
      sandboxes: [{ runId: ORPHAN_RUN, sandboxId: "sbx_9", destroyed: true }],
    });
    expect(fake.destroyed).toEqual(["sbx_9"]);
    expect(await readdir(join(home, "runs"))).toEqual([`${OTHER_RUN}.railway.json`]);
  });

  it("refuses to dissolve while a railway sandbox of the swarm is tracked", async () => {
    const home = await homeWithRailwaySwarm("vapi-swarm-railway-dissolve-sidecar-");
    await writeSidecarFile(home, { runId: ORPHAN_RUN, sandboxId: "sbx_9" });
    const deps = {
      ...railwayDependencies(fakeRailwayExec().exec),
      swarm: { balanceReader: async () => 0n },
    };

    const captured = captureIo();
    expect(await run(["swarm", "dissolve", "team", "--json"], captured.io, deps)).toBe(1);
    const error = JSON.parse(onlyLine(captured.stdout)) as { error: string };
    expect(error.error).toContain("sbx_9");
    expect(error.error).toContain("vapi swarm stop team --all");
    // The swarm is kept, so runs and stop still reach the sandbox.
    const runs = captureIo();
    expect(await run(["swarm", "runs", "team", "--json"], runs.io, deps)).toBe(0);
    expect(JSON.parse(onlyLine(runs.stdout))).toMatchObject({
      sandboxes: [{ runId: ORPHAN_RUN, sandboxId: "sbx_9", state: "orphaned" }],
    });
  });

  it("refuses to dissolve while a railway run of the swarm is running", async () => {
    await homeWithRailwaySwarm("vapi-swarm-railway-dissolve-running-");
    const fake = fakeRailwayExec();
    const deps = { ...railwayDependencies(fake.exec), swarm: { balanceReader: async () => 0n } };
    expect(
      await run(
        [...railwayArgs, "--checkpoint", "vapi-cli", "--allow-remote-key", "--json"],
        captureIo().io,
        deps,
      ),
    ).toBe(0);

    const captured = captureIo();
    expect(await run(["swarm", "dissolve", "team", "--json"], captured.io, deps)).toBe(1);
    const error = JSON.parse(onlyLine(captured.stdout)) as { error: string };
    expect(error.error).toContain("sbx_1");
    expect(error.error).toContain("sbx_2");
    expect(error.error).toContain("vapi swarm stop team --all");
    expect(fake.destroyed).toEqual([]);

    // Once stopped, the swarm dissolves.
    expect(await run(["swarm", "stop", "team", "--all", "--json"], captureIo().io, deps)).toBe(0);
    const dissolved = captureIo();
    expect(await run(["swarm", "dissolve", "team", "--json"], dissolved.io, deps)).toBe(0);
    expect(JSON.parse(onlyLine(dissolved.stdout))).toMatchObject({ status: "dissolved" });
  });

  it("guards direct sweep even when a custom sweep transport is injected", async () => {
    const home = await homeWithStoredSwarm("vapi-cli-direct-sweep-guard-");
    await writeSwarm(home, { ...(await readSwarm(home, "team")), dissolving: true });
    await writeSidecarFile(home, { runId: ORPHAN_RUN, sandboxId: "sbx_9" });
    const sweepBack = vi.fn<NonNullable<CliDependencies["sweepBack"]>>(async ({ network }) => ({
      network,
      amountAtomic: "1000000",
      transaction: "0xpaid",
    }));
    const captured = captureIo();
    expect(
      await run(
        ["sweep", OWNER, "--wallet", "team-lead-1", "--network", BASE_MAINNET_CAIP2, "--json"],
        captured.io,
        { ...dependencies(), sweepBack },
      ),
    ).toBe(1);
    expect(onlyLine(captured.stdout)).toContain("vapi swarm stop team --all");
    expect(sweepBack).not.toHaveBeenCalled();
  });

  it("guards legacy dissolution through accounts distribute --resume", async () => {
    const home = await homeWithRailwaySwarm("vapi-cli-distribute-guard-");
    const transfer = vi.fn<MovementTransfer>(async (args) => ({
      status: "unknown",
      from: args.from,
      to: OWNER,
      toName: args.to,
      toKind: "account",
      amountUsd: String(args.amountUsd),
      amountAtomic: usdToAtomic(args.amountUsd).toString(),
      network: BASE_MAINNET_CAIP2,
      txHash: null,
      nonce: (args.nonce ?? args.resume)!,
      replayed: false,
    }));
    const deps = {
      ...railwayDependencies(fakeRailwayExec().exec),
      swarm: { transfer, balanceReader: async () => 1_000_000n },
      distribute: { transfer },
    };
    const initial = captureIo();
    expect(await run(["swarm", "dissolve", "team", "--json"], initial.io, deps)).toBe(1);
    const id = (
      JSON.parse(onlyLine(initial.stdout)) as { movements: Array<{ movementId: string }> }
    ).movements[0]!.movementId;
    const path = join(home, "movements", `${id}.json`);
    const legacy = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    delete legacy.dissolution;
    await writeFile(path, JSON.stringify(legacy));
    await writeSidecarFile(home, { runId: ORPHAN_RUN, sandboxId: "sbx_9" });
    transfer.mockClear();
    const resumed = captureIo();
    expect(await run(["accounts", "distribute", "--resume", id, "--json"], resumed.io, deps)).toBe(
      1,
    );
    expect(onlyLine(resumed.stdout)).toContain("vapi swarm stop team --all");
    expect(transfer).not.toHaveBeenCalled();
  });

  it("still lists and destroys the sandboxes of a swarm whose file is gone", async () => {
    const home = await homeWithRailwaySwarm("vapi-swarm-railway-dissolved-sidecar-");
    await writeSidecarFile(home, { runId: ORPHAN_RUN, sandboxId: "sbx_9" });
    await rm(join(home, "swarms", "team.json"));
    const fake = fakeRailwayExec();
    const deps = railwayDependencies(fake.exec);

    const runs = captureIo();
    expect(await run(["swarm", "runs", "team", "--json"], runs.io, deps)).toBe(0);
    expect(JSON.parse(onlyLine(runs.stdout))).toMatchObject({
      sandboxes: [{ runId: ORPHAN_RUN, sandboxId: "sbx_9", state: "orphaned" }],
    });
    const stopped = captureIo();
    expect(await run(["swarm", "stop", "team", "--all", "--json"], stopped.io, deps)).toBe(0);
    expect(fake.destroyed).toEqual(["sbx_9"]);
    expect(await readdir(join(home, "runs"))).toEqual([]);

    // With nothing left of it, the name is unknown again.
    const unknown = captureIo();
    expect(await run(["swarm", "runs", "team", "--json"], unknown.io, deps)).toBe(1);
    expect(onlyLine(unknown.stdout)).toContain("No swarm named team");
  });

  it("lists kept sandboxes and destroys them with stop --all", async () => {
    const home = await homeWithRailwaySwarm("vapi-swarm-railway-kept-stop-");
    const fake = fakeRailwayExec();
    const deps = railwayDependencies(fake.exec);
    expect(
      await run(
        [...railwayArgs, "--checkpoint", "vapi-cli", "--allow-remote-key", "--keep-sandbox"],
        captureIo().io,
        deps,
      ),
    ).toBe(0);
    fake.finished.add("sbx_1");
    fake.finished.add("sbx_2");

    const listed = captureIo();
    expect(await run(["swarm", "runs", "team", "--json"], listed.io, deps)).toBe(0);
    const sandboxes = (
      JSON.parse(onlyLine(listed.stdout)) as {
        sandboxes: Array<{ member: string; state: string; sandboxId?: string; destroy: string }>;
      }
    ).sandboxes;
    expect(
      sandboxes.map(({ member, state, sandboxId, destroy }) => ({
        member,
        state,
        sandboxId,
        destroy,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          member: "team-lead-1",
          state: "kept",
          sandboxId: "sbx_1",
          destroy: "railway sandbox destroy sbx_1",
        },
        {
          member: "team-helper-1",
          state: "kept",
          sandboxId: "sbx_2",
          destroy: "railway sandbox destroy sbx_2",
        },
      ]),
    );
    expect(sandboxes).toHaveLength(2);
    expect(fake.destroyed).toEqual([]);

    const stopped = captureIo();
    expect(await run(["swarm", "stop", "team", "--all", "--json"], stopped.io, deps)).toBe(0);
    const result = JSON.parse(onlyLine(stopped.stdout)) as {
      sandboxes: Array<{ sandboxId?: string; destroyed: boolean }>;
    };
    expect(
      result.sandboxes.map(({ sandboxId, destroyed }) => [sandboxId, destroyed]).sort(),
    ).toEqual([
      ["sbx_1", true],
      ["sbx_2", true],
    ]);
    expect([...fake.destroyed].sort()).toEqual(["sbx_1", "sbx_2"]);
    expect(
      (await readdir(join(home, "runs"))).filter((file) => file.endsWith(".railway.json")),
    ).toEqual([]);
  });

  it("stop --all reports a failing stop, keeps that run running and stops the rest", async () => {
    const home = await homeWithRailwaySwarm("vapi-swarm-railway-stop-fail-");
    const fake = fakeRailwayExec({
      destroy: (id) =>
        id === "sbx_1"
          ? { code: 1, stdout: "", stderr: "Error: railway API unavailable\n" }
          : undefined,
    });
    const deps = railwayDependencies(fake.exec);
    const started = captureIo();
    expect(
      await run(
        [...railwayArgs, "--checkpoint", "vapi-cli", "--allow-remote-key", "--json"],
        started.io,
        deps,
      ),
    ).toBe(0);
    const runs = (JSON.parse(onlyLine(started.stdout)) as { runs: Array<{ runId: string }> }).runs;

    const stopped = captureIo();
    expect(await run(["swarm", "stop", "team", "--all", "--json"], stopped.io, deps)).toBe(1);
    const result = JSON.parse(onlyLine(stopped.stdout)) as {
      stopped: Array<{ runId: string }>;
      failed: Array<{ runId: string; member: string; error: string }>;
      sandboxes: unknown[];
    };
    expect(result.stopped.map(({ runId }) => runId)).toEqual([runs[1]!.runId]);
    expect(result.failed).toEqual([
      expect.objectContaining({ runId: runs[0]!.runId, member: "team-lead-1" }),
    ]);
    expect(result.failed[0]!.error).toContain("railway API unavailable");
    expect(result.sandboxes).toEqual([]);
    const records = await listRunRecords(home, { swarm: "team" });
    expect(records.find(({ runId }) => runId === runs[0]!.runId)?.state).toBe("running");
    expect(fake.destroyed).toEqual(["sbx_2"]);
    await expectNoMemberSecrets(home, [stopped.stdout.join("\n")]);
  });
});

describe("swarm ceiling parents", () => {
  it("passes a working swarm parent resolver to CLI pay and agent-run ceiling sweeps", async () => {
    const home = await homeWithStoredSwarm("vapi-swarm-ceiling-");
    const configPath = getVapiPaths(home).config;
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    config.allowPrivateNetwork = true;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const resolved: unknown[] = [];
    const sweep = vi.fn(async (args: SweepAboveCeilingArgs) => {
      resolved.push(await args.resolveParent?.(args.account));
      return { account: args.account, status: "skipped" as const, reason: "below_ceiling" };
    });
    const pay = captureIo();

    expect(
      await run(["pay", "https://127.0.0.1/paid", "--account", "team-lead-1", "--json"], pay.io, {
        ...dependencies(paidFetch()),
        ceiling: { sweepAboveCeiling: sweep },
      }),
    ).toBe(0);
    expect(resolved).toEqual([
      {
        account: "team-treasury",
        address: await walletAddress(home, "team-treasury"),
      },
    ]);

    let ceilingSweep: Parameters<typeof createAgentRunDeps>[0]["ceilingSweep"];
    const createDeps = vi.fn<typeof createAgentRunDeps>((input) => {
      ceilingSweep = input.ceilingSweep;
      return createAgentRunDeps(input);
    });
    const execute = vi.fn<typeof runAgent>(async () => ({
      runId: "run_111111111111111111111111",
      answer: "done",
      stoppedBecause: { type: "stopped", reason: "finished" },
      paidUsd: 0,
      steps: 1,
    }));
    const agent = captureIo();
    sweep.mockClear();
    resolved.length = 0;

    expect(
      await run(["agent", "run", "team-lead-1", "Check the swarm"], agent.io, {
        ...dependencies(),
        ceiling: { sweepAboveCeiling: sweep },
        agent: { createAgentRunDeps: createDeps, runAgent: execute },
      }),
    ).toBe(0);
    if (!ceilingSweep) throw new Error("Missing agent ceiling sweep.");
    await ceilingSweep.run(new AbortController().signal);
    expect(resolved).toEqual([
      {
        account: "team-treasury",
        address: await walletAddress(home, "team-treasury"),
      },
    ]);
    expect(sweep).toHaveBeenCalledOnce();
  });
});

async function initializedHome(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  homes.push(home);
  process.env.VAPI_HOME = home;
  stores.set(home, secretStore());
  expect(await run(["init", "--json"], captureIo().io)).toBe(0);
  return home;
}

function swarmRunResult(overrides: Partial<SwarmRunResult> = {}): SwarmRunResult {
  return {
    runId: "run_swarm_cli_123456789012",
    mode: "lead",
    members: [runMember()],
    drawUsedUsd: 0,
    drawLimitUsd: 2,
    net: [
      {
        member: "team-lead-1",
        balanceUsd: "1.00",
        allocatedInUsd: "0.00",
        sweptOutUsd: "0.00",
        netUsd: "0.00",
      },
    ],
    ...overrides,
  };
}

function runMember(overrides: Partial<SwarmRunMemberResult> = {}): SwarmRunMemberResult {
  return {
    member: "team-lead-1",
    role: "lead",
    runId: "run_swarm_cli_123456789012",
    answer: "Done.",
    stoppedBecause: { reason: "finished" },
    spentUsd: 0,
    budgetUsd: 1,
    status: "finished",
    ...overrides,
  };
}

function onlyLine(lines: string[]): string {
  expect(lines).toHaveLength(1);
  return lines[0]!;
}

function expectNoRunSecrets(text: string): void {
  for (const secret of [
    RECOVERY_PHRASE,
    PRIVATE_KEY,
    PASSPHRASE,
    API_KEY,
    LINK_RESULT.tokens.accessToken,
    START.deviceCode,
    LINK_RESULT.routerKey,
  ]) {
    expect(text).not.toContain(secret);
  }
}

async function linkedSwarm(prefix: string, roles?: string[]): Promise<string> {
  const home = await initializedHome(prefix);
  const captured = captureIo();
  expect(
    await run(
      [
        "swarm",
        "create",
        "team",
        ...(roles === undefined ? [] : ["--roles", roles.join(",")]),
        "--json",
      ],
      captured.io,
      {
        ...dependencies(),
        agentLink: {
          startDeviceLink: async () => START,
          pollDeviceLink: async () => LINK_RESULT,
        },
      },
    ),
  ).toBe(0);
  return home;
}

async function homeWithStoredSwarm(prefix: string): Promise<string> {
  const home = await initializedHome(prefix);
  const store = await WalletStore.open(home, { secrets: stores.get(home)! });
  const treasury = await store.create("team-treasury", "");
  const member = await store.create("team-lead-1", "");
  await writeSwarm(home, {
    v: 1,
    name: "team",
    device: "test-device",
    network: BASE_MAINNET_CAIP2,
    createdAt: "2026-09-29T12:00:00.000Z",
    treasury: {
      account: "team-treasury",
      address: treasury.account.address,
      steps: { creating: true, created: true, capped: true, linked: false },
    },
    members: [
      {
        account: "team-lead-1",
        address: member.account.address,
        role: "lead",
        weight: 2,
        targetAtomic: "2000000",
        ceilingAtomic: "10000000",
        steps: {
          creating: true,
          created: true,
          capped: true,
          profiled: true,
          linked: false,
        },
      },
    ],
    policy: {
      strategy: "targets",
      treasuryCaps: { perCallAtomic: "5000000", perDayAtomic: "20000000" },
    },
  });
  await writeAgentProfile(home, {
    version: 1,
    name: "team-lead-1",
    wallet: "team-lead-1",
    model: "router/test",
    instructions: "Lead the team.",
    tools: [],
    verifiedOnly: true,
    approveAboveUsd: 0.5,
    maxSteps: 2,
    paused: false,
    createdAt: "2026-09-29T12:00:00.000Z",
  });
  return home;
}

async function homeWithRuntimeSwarm(prefix: string): Promise<string> {
  const home = await initializedHome(prefix);
  const store = await WalletStore.open(home, { secrets: stores.get(home)! });
  const treasury = await store.create("team-treasury", "");
  const lead = await store.create("team-lead-1", "");
  const helper = await store.create("team-helper-1", "");
  const observer = await store.create("team-observer-1", "");
  await store.setLink("team-lead-1", runtimeLink("team-lead-1"));
  await store.setLink("team-helper-1", runtimeLink("team-helper-1"));
  await writeSwarm(home, {
    v: 1,
    name: "team",
    device: "test-device",
    network: BASE_MAINNET_CAIP2,
    createdAt: "2026-09-29T12:00:00.000Z",
    treasury: {
      account: "team-treasury",
      address: treasury.account.address,
      steps: { creating: true, created: true, capped: true, linked: false },
    },
    members: [
      runtimeMember("team-lead-1", lead.account.address, "lead", true),
      runtimeMember("team-helper-1", helper.account.address, "helper", true),
      runtimeMember("team-observer-1", observer.account.address, "observer", false),
    ],
    policy: {
      strategy: "targets",
      treasuryCaps: { perCallAtomic: "5000000", perDayAtomic: "20000000" },
    },
  });
  await writeAgentProfile(home, runtimeProfile("team-lead-1", "Lead the team."));
  await writeAgentProfile(home, runtimeProfile("team-helper-1", "Help the team."));
  return home;
}

function runtimeMember(account: string, address: `0x${string}`, role: string, linked: boolean) {
  return {
    account,
    address,
    role,
    weight: 1,
    targetAtomic: "1000000",
    ceilingAtomic: "10000000",
    steps: {
      creating: true,
      created: true,
      capped: true,
      profiled: true,
      linked,
    },
  };
}

function runtimeProfile(name: string, instructions: string) {
  return {
    version: 1 as const,
    name,
    wallet: name,
    model: "router/test",
    instructions,
    tools: [],
    grants: [],
    verifiedOnly: true,
    approveAboveUsd: 0.5,
    maxSteps: 2,
    paused: false,
    createdAt: "2026-09-29T12:00:00.000Z",
  };
}

function runtimeLink(label: string) {
  return {
    apiBase: API_BASE,
    clientId: `agent_${label}`,
    owner: OWNER,
    label,
    scopes: ["mcp:call", "router.use"],
    linkedAt: "2026-09-29T12:00:00.000Z",
  };
}

function fakeRuntime(): {
  runtime: Runtime;
  start: ReturnType<typeof vi.fn<Runtime["start"]>>;
  stop: ReturnType<typeof vi.fn<Runtime["stop"]>>;
  status: ReturnType<typeof vi.fn<Runtime["status"]>>;
  states: Map<string, RuntimeStatus>;
} {
  const states = new Map<string, RuntimeStatus>();
  const start = vi.fn<Runtime["start"]>(async (member, run) => {
    states.set(run.runId, { state: "running" });
    return {
      runId: run.runId,
      kind: "local",
      member,
      startedAt: "2026-09-30T08:00:00.000Z",
      ref: `handle:${run.runId}`,
    };
  });
  const stop = vi.fn<Runtime["stop"]>(async (handle) => {
    states.set(handle.runId, { state: "stopped" });
  });
  const status = vi.fn<Runtime["status"]>(async (handle) =>
    Promise.resolve(states.get(handle.runId) ?? { state: "unknown" }),
  );
  return { runtime: { kind: "local", start, stop, status }, start, stop, status, states };
}

function runtimeDependencies(runtime: Runtime): CliDependencies {
  return {
    ...dependencies(),
    env: {
      VAPI_RECOVERY_PHRASE: RECOVERY_PHRASE,
      VAPI_PRIVATE_KEY: PRIVATE_KEY,
      VAPI_VAULT_PASSWORD: PASSPHRASE,
      VAPI_API_KEY: API_KEY,
      VAPI_ACCESS_TOKEN: LINK_RESULT.tokens.accessToken,
      VAPI_DEVICE_CODE: START.deviceCode,
      VAPI_ROUTER_KEY: LINK_RESULT.routerKey,
    },
    now: () => new Date("2026-09-30T09:00:00.000Z"),
    runtime: (kind) => {
      if (kind !== "local") throw new Error(`Unexpected runtime ${kind}.`);
      return runtime;
    },
  };
}

function movementDependencies(
  transfer: MovementTransfer,
  balanceReader: NonNullable<NonNullable<CliDependencies["swarm"]>["balanceReader"]>,
): CliDependencies {
  let nonceIndex = 0;
  return {
    ...dependencies(),
    swarm: {
      transfer,
      balanceReader,
      randomId: () => "mv_swarm_cli_test_1234",
      randomNonce: () => `0x${(++nonceIndex).toString(16).padStart(64, "0")}` as Hex,
    },
  };
}

function transferResult(
  args: Parameters<MovementTransfer>[0],
  status: "sent" | "unknown",
): TransferResult {
  return {
    status,
    from: args.from,
    to: "0x2222222222222222222222222222222222222222",
    toName: args.to,
    toKind: args.to === "owner" ? "owner" : "account",
    amountUsd: String(args.amountUsd),
    amountAtomic: usdToAtomic(args.amountUsd).toString(),
    network: BASE_MAINNET_CAIP2,
    txHash: status === "sent" ? (`0x${"34".repeat(32)}` as Hex) : null,
    nonce: (args.nonce ?? args.resume)!,
    replayed: false,
  };
}

function dependencies(fetchImpl: typeof fetch = zeroBalanceRpc()): CliDependencies {
  return {
    interactive: false,
    env: {},
    fetchImpl,
    hostname: () => "swarm-test-device",
    status: { timeoutMs: 1_000 },
  };
}

async function run(
  argv: string[],
  io: CliIo,
  deps: CliDependencies = dependencies(),
): Promise<number> {
  const home = process.env.VAPI_HOME;
  if (home === undefined) throw new Error("A swarm test must set VAPI_HOME first.");
  const secrets = deps.secretStore ?? stores.get(home) ?? secretStore();
  stores.set(home, secrets);
  return await runCli(argv, io, { ...deps, secretStore: secrets });
}

function secretStore(): SecretStore {
  const values: Record<string, string> = {};
  return {
    available: true,
    platform: "darwin",
    description: "the test secret store",
    get: async (name) => values[name],
    has: async (name) => values[name] !== undefined,
    set: async (name, value) => {
      values[name] = value;
    },
    remove: async (name) => {
      if (values[name] === undefined) return false;
      delete values[name];
      return true;
    },
  };
}

function captureIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
  };
}

function swarmToolReply(id: string, name: string, args: Record<string, unknown>): ChatResult {
  return {
    content: null,
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
    model: "router/test",
    keyUsed: "stake",
  };
}

function zeroBalanceRpc(): typeof fetch {
  return vi.fn<typeof fetch>(async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { id: number; method: string };
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result: request.method === "eth_call" ? `0x${"0".repeat(64)}` : "0x0",
    });
  });
}

function paidFetch(): typeof fetch {
  let calls = 0;
  return vi.fn<typeof fetch>(async () => {
    calls += 1;
    if (calls === 1) {
      return Response.json(
        {
          x402Version: 2,
          resource: {
            url: "https://127.0.0.1/paid",
            description: "Fixture endpoint",
            mimeType: "application/json",
          },
          accepts: [
            {
              scheme: "exact",
              network: BASE_MAINNET_CAIP2,
              amount: "2500",
              asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              payTo: OWNER,
              maxTimeoutSeconds: 60,
              extra: { name: "USD Coin", version: "2" },
            },
          ],
        },
        { status: 402 },
      );
    }
    const settlement = {
      success: true,
      transaction: `0x${"44".repeat(32)}`,
    };
    return Response.json(
      { paid: true },
      {
        headers: {
          "payment-response": Buffer.from(JSON.stringify(settlement), "utf8").toString("base64"),
        },
      },
    );
  });
}

function listingAndBalanceFetch(): typeof fetch {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/api/call/discovery") {
      return Response.json({
        protocol: "vapi.marketplace.discovery/1",
        items: [
          {
            ref: "premium",
            kind: "api",
            provenance: "self_listed",
            verification: "verified",
            execution: { mode: "direct" },
            card: {
              title: "Premium listing",
              summary: "An expensive test listing.",
              badges: [],
              facts: [{ label: "Price", value: "$0.75" }],
            },
            action: { type: "invoke_api", href: "/call/premium" },
          },
        ],
        nextCursor: null,
        unavailableKinds: [],
        rankingVersion: "marketplace-ranking-v1",
      });
    }
    if (url.pathname === "/api/call/services") {
      return Response.json({
        services: [
          {
            id: "premium",
            name: "Premium listing",
            description: "An expensive test listing.",
            category: "data",
            tier: "verified",
            verification: "verified",
            verified: true,
            wrapped: false,
            price: "$0.75",
            networks: [BASE_MAINNET_CAIP2],
            endpoints: [
              {
                name: "call",
                method: "POST",
                url: "https://premium.example/call",
                price: "$0.75",
                description: "Run the premium listing.",
              },
            ],
          },
        ],
      });
    }
    const body = init?.body ?? (input instanceof Request ? await input.clone().text() : "");
    const request = JSON.parse(String(body)) as { id: number; method: string };
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result: request.method === "eth_call" ? `0x${"0".repeat(64)}` : "0x0",
    });
  });
}

async function walletAddress(home: string, name: string): Promise<string> {
  const address = await (
    await WalletStore.open(home, { secrets: stores.get(home)! })
  ).readAddress(name);
  if (address === undefined) throw new Error(`Missing address for ${name}.`);
  return address;
}

const REMOTE_WARNING =
  "A leaked member key can spend that member's whole balance. Revoking the link stops Router and relays, but not x402 payments the key signs itself.";
const RAILWAY_MEMBERS = ["team-lead-1", "team-helper-1"] as const;

async function homeWithRailwaySwarm(
  prefix: string,
  options: { helperCeilingAtomic?: bigint } = {},
): Promise<string> {
  const home = await homeWithRuntimeSwarm(prefix);
  const secrets = stores.get(home)!;
  const store = await WalletStore.open(home, { secrets });
  for (const name of RAILWAY_MEMBERS) {
    await store.setCeiling(
      name,
      name === "team-helper-1" ? (options.helperCeilingAtomic ?? 2_000_000n) : 2_000_000n,
    );
    const names = agentSecretAccounts(name);
    await secrets.set(names.tokens, JSON.stringify(LINK_RESULT.tokens));
    await secrets.set(names.routerStake, LINK_RESULT.routerKey!);
  }
  return home;
}

/** A fake `railway` binary. Every call is recorded; nothing real ever runs. */
function fakeRailwayExec(
  handlers: {
    create?: (count: number) => RailwayExecResult | undefined;
    destroy?: (id: string) => RailwayExecResult | undefined;
  } = {},
) {
  const calls: string[][] = [];
  const envFiles: string[] = [];
  const finished = new Set<string>();
  const destroyed: string[] = [];
  let created = 0;
  const ok = { code: 0, stdout: "", stderr: "" };
  const exec = vi.fn<RailwayExec>(async (file, args) => {
    expect(file).toBe("railway");
    calls.push([...args]);
    const [group, verb, id] = args;
    expect(group).toBe("sandbox");
    if (verb === "create") {
      envFiles.push(await readFile(args[args.indexOf("--env-file") + 1]!, "utf8"));
      created += 1;
      const override = handlers.create?.(created);
      if (override !== undefined) return override;
      return { code: 0, stdout: `${JSON.stringify({ id: `sbx_${created}` })}\n`, stderr: "" };
    }
    if (verb === "exec" && args.includes("--detach")) return ok;
    if (verb === "exec" && args.at(-1) === "true") return ok;
    if (verb === "exec") {
      return finished.has(id!)
        ? {
            code: 0,
            stdout: JSON.stringify({ v: 1, exitCode: 0, result: { answer: "Done." } }),
            stderr: "",
          }
        : {
            code: 1,
            stdout: "",
            stderr: "cat: /tmp/vapi-result.json: No such file or directory\n",
          };
    }
    if (verb === "destroy") {
      const override = handlers.destroy?.(id!);
      if (override !== undefined) return override;
      destroyed.push(id!);
      return ok;
    }
    throw new Error(`unexpected railway call: ${args.join(" ")}`);
  });
  return {
    exec,
    calls,
    envFiles,
    finished,
    destroyed,
    creates: () => calls.filter((args) => args[1] === "create"),
  };
}

function railwayDependencies(exec: RailwayExec, env: NodeJS.ProcessEnv = {}): CliDependencies {
  return {
    ...dependencies(),
    env,
    now: () => new Date("2026-09-30T09:00:00.000Z"),
    railwayExec: exec,
    swarm: { balanceReader: async () => 0n },
  };
}

const ORPHAN_RUN = `run_${"a".repeat(24)}`;
const CREATING_RUN = `run_${"b".repeat(24)}`;
const OTHER_RUN = `run_${"c".repeat(24)}`;

/** A sidecar as the railway adapter leaves it; no key or credential is ever in one. */
async function writeSidecarFile(
  home: string,
  sidecar: Partial<RailwaySidecar> & { runId: string },
): Promise<void> {
  await mkdir(join(home, "runs"), { recursive: true, mode: 0o700 });
  const value: RailwaySidecar = {
    v: 1,
    account: "team-helper-1",
    swarm: "team",
    state: "orphaned",
    checkpoint: "vapi-cli",
    keepSandbox: false,
    ...sidecar,
  };
  await writeFile(join(home, "runs", `${sidecar.runId}.railway.json`), JSON.stringify(value), {
    mode: 0o600,
  });
}

async function auditText(home: string): Promise<string> {
  return await readFile(join(home, "audit.log"), "utf8").catch(() => "");
}

async function registryText(home: string): Promise<string> {
  const directory = join(home, "runs");
  const files = await readdir(directory);
  return (
    await Promise.all(files.map(async (file) => await readFile(join(directory, file), "utf8")))
  ).join("\n");
}

/** No member private key, link token or Router key in any captured text. */
async function expectNoMemberSecrets(home: string, texts: string[]): Promise<void> {
  const key = await loadOrCreateDeviceKey({ secrets: stores.get(home)! });
  const forbidden: string[] = [
    LINK_RESULT.tokens.accessToken,
    LINK_RESULT.tokens.refreshToken!,
    LINK_RESULT.routerKey!,
    RECOVERY_PHRASE,
  ];
  for (const name of RAILWAY_MEMBERS) {
    const privateKey = await exportMemberKey({ path: join(home, "vault.json"), key, name });
    forbidden.push(privateKey, privateKey.slice(2));
  }
  for (const text of texts) {
    for (const secret of forbidden) expect(text).not.toContain(secret);
    expect(text).not.toContain("VAPI_MEMBER_BUNDLE=");
  }
}
