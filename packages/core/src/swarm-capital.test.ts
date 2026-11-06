import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress, type Hex } from "viem";

import type { DeviceLinkStart } from "./agent-link.js";
import { readAgentProfile } from "./agent-profile.js";
import { parseUsdCents } from "./allocation.js";
import { exportBackupSource, restoreFromBackup, type BackupPlaintextV2 } from "./backup.js";
import {
  executeMovement,
  readMovement,
  reconcileUnresolvedMovementsForAccountLocked,
} from "./movement.js";
import { withSwarmAccountMovementLocks } from "./account-movement-lock.js";
import { sweepBack } from "./sweep.js";
import { getDefaultConfig } from "./config.js";
import { sweepAboveCeiling } from "./ceiling.js";
import * as workerGuard from "./swarm-workers.js";
import { memorySecretStore, type SecretStore } from "./secret-store.js";
import {
  dissolveSwarm,
  fundSwarm,
  leaveSwarm,
  rebalanceSwarm,
  type SwarmCapitalDeps,
} from "./swarm-capital.js";
import { readSwarm, setupSwarm, type SwarmFile } from "./swarm.js";
import {
  TransferError,
  transferBetweenAccounts,
  executeTransfer,
  type TransferArgs,
  type TransferNetwork,
  type TransferResult,
} from "./transfer.js";
import { WalletStore } from "./wallet-store.js";
import { __setAtomicFileTestHooks } from "./atomic-file.js";
import { ARC_MAINNET_CAIP2, BASE_MAINNET_CAIP2 } from "./x402-networks.js";

const NOW = Date.parse("2026-09-29T10:00:00.000Z");
const OWNER = "0x1111111111111111111111111111111111111111" as const;
const API_BASE = "https://api.vapinetwork.ai";
const PHRASE = "test test test test test test test test test test test junk";
const homes: string[] = [];

afterEach(async () => {
  __setAtomicFileTestHooks(undefined);
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("swarm funding", () => {
  it("acquires the complete lock set canonically for concurrent A-to-B and B-to-A funding", async () => {
    const fixture = await capitalFixture();
    await setupSwarm({
      store: fixture.store,
      secrets: fixture.deps.secrets,
      apiBase: API_BASE,
      name: "other",
      roles: ["lead"],
      surface: "cli",
      env: {},
      hostname: "Test Host",
      now: () => new Date(NOW),
      startDeviceLink: async (args) => linkStart(args.label),
      pollDeviceLink: async () => ({
        owner: OWNER,
        tokens: {
          accessToken: "test-access",
          refreshToken: "test-refresh",
          expiresAt: NOW + 3_600_000,
          scopes: ["mcp:call", "router.use"],
        },
      }),
    });
    fixture.balances.set("team-treasury", 10_000_000n);
    fixture.balances.set("other-treasury", 10_000_000n);
    const operation = new AsyncLocalStorage<string>();
    const order = new Map<string, string[]>();
    let release!: () => void;
    const ready = new Promise<void>((done) => {
      release = done;
    });
    __setAtomicFileTestHooks({
      async beforeLockAttempt(path) {
        const name = path.endsWith("/.team.lock")
          ? "team"
          : path.endsWith("/.other.lock")
            ? "other"
            : undefined;
        const id = operation.getStore();
        if (name === undefined || id === undefined) return;
        const seen = order.get(id) ?? [];
        if (!seen.includes(name)) seen.push(name);
        order.set(id, seen);
        if (order.size === 2) release();
        await ready;
      },
    });
    const outcomes = await Promise.allSettled([
      operation.run(
        "A-to-B",
        async () =>
          await fundSwarm({ name: "team", from: "other-treasury", amountUsd: 1 }, fixture.deps),
      ),
      operation.run(
        "B-to-A",
        async () =>
          await fundSwarm({ name: "other", from: "team-treasury", amountUsd: 1 }, fixture.deps),
      ),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(2);
    expect([...order.values()]).toEqual([
      ["other", "team"],
      ["other", "team"],
    ]);
  }, 10_000);

  it("waits for the owner with treasury details and creates no movement", async () => {
    const fixture = await capitalFixture();

    const result = await fundSwarm({ name: "team", amountUsd: "2.50" }, fixture.deps);

    expect(result).toMatchObject({
      status: "waiting_for_owner",
      treasury: {
        account: fixture.swarm.treasury.account,
        address: fixture.swarm.treasury.address,
      },
      network: BASE_MAINNET_CAIP2,
      amountUsd: "2.50",
      skipped: [],
    });
    expect(await movementFiles(fixture.home)).toEqual([]);
  });

  it("funds from one local account with one send movement to the treasury", async () => {
    const fixture = await capitalFixture();

    const result = await fundSwarm({ name: "team", amountUsd: 2.5, from: "main" }, fixture.deps);

    expect(result).toMatchObject({
      status: "sent",
      fund: {
        reason: "send",
        resumed: false,
        complete: true,
        legs: [
          {
            from: "main",
            to: fixture.swarm.treasury.account,
            amountUsd: "2.50",
            purpose: "send",
            status: "sent",
          },
        ],
      },
    });
    const files = await movementFiles(fixture.home);
    expect(files).toHaveLength(1);
    await expect(readMovement(fixture.home, result.fund!.movementId)).resolves.toMatchObject({
      reason: "send",
      from: "main",
      treasury: "team-treasury",
      legs: [{ to: fixture.swarm.treasury.account }],
    });
  });

  it("splits funding above the relay per-transfer maximum into durable legs", async () => {
    const fixture = await capitalFixture();

    const result = await fundSwarm(
      { name: "team", amountUsd: "120.50", from: "main" },
      fixture.deps,
    );

    expect(result.fund?.legs.map((leg) => leg.amountUsd)).toEqual(["50.00", "50.00", "20.50"]);
    await expect(readMovement(fixture.home, result.fund!.movementId)).resolves.toMatchObject({
      legs: [
        { amountUsd: "50.00", status: "sent" },
        { amountUsd: "50.00", status: "sent" },
        { amountUsd: "20.50", status: "sent" },
      ],
    });
  });

  it("resumes split funding without sending its completed first leg again", async () => {
    const fixture = await capitalFixture();
    let crash = true;
    fixture.transfer.mockImplementation(async (args) => {
      if (String(args.amountUsd) === "50.00" && fixture.transfer.mock.calls.length === 2 && crash) {
        crash = false;
        throw new Error("simulated split funding crash");
      }
      return await fixture.send(args);
    });

    await expect(
      fundSwarm({ name: "team", amountUsd: "120.50", from: "main" }, fixture.deps),
    ).rejects.toThrow("simulated split funding crash");
    const [file] = await movementFiles(fixture.home);
    await expect(readMovement(fixture.home, file!.slice(0, -5))).resolves.toMatchObject({
      legs: [{ amountUsd: "50.00", status: "sent" }, { status: "planned" }, { status: "planned" }],
    });

    const resumed = await fundSwarm(
      { name: "team", amountUsd: "120.50", from: "main" },
      fixture.deps,
    );

    expect(resumed).toMatchObject({ status: "resumed", fund: { complete: true } });
    expect(
      fixture.transfer.mock.calls.filter(([args]) => String(args.amountUsd) === "50.00"),
    ).toHaveLength(3);
  });

  it("records setup funding in swarm state and reports it without funding twice", async () => {
    const fixture = await capitalFixture({ strategy: "even" });

    const first = await fundSwarm(
      { name: "team", amountUsd: "4.50", from: "main", setup: true },
      fixture.deps,
    );
    const filesAfterFirst = await movementFiles(fixture.home);
    const transfersAfterFirst = fixture.transfer.mock.calls.length;
    await writeFile(
      join(fixture.home, "swarms", ".team.funding"),
      `${JSON.stringify({
        v: 1,
        name: "team",
        from: "main",
        amountUsd: "4.50",
        applyPolicy: true,
        fundMovementId: first.fund!.movementId,
      })}\n`,
      "utf8",
    );

    const second = await fundSwarm(
      { name: "team", amountUsd: "4.50", from: "main", setup: true },
      fixture.deps,
    );

    expect(first.status).toBe("sent");
    expect(second).toMatchObject({
      status: "sent",
      fund: { movementId: first.fund!.movementId, complete: true },
    });
    expect(await movementFiles(fixture.home)).toEqual(filesAfterFirst);
    expect(fixture.transfer).toHaveBeenCalledTimes(transfersAfterFirst);
    expect(await readSwarm(fixture.home, "team")).toMatchObject({
      setupFunding: {
        amountUsd: "4.50",
        from: "main",
        movementId: first.fund!.movementId,
        status: "sent",
        policy: { strategy: "even", status: "sent" },
      },
    });
    expect(await readdir(join(fixture.home, "swarms"))).not.toContain(".team.funding");
  });

  it("adopts a legacy setup journal after funding was sent without sending funding twice", async () => {
    const fixture = await capitalFixture({ strategy: "even" });
    const movementId = "mv_legacyfund01";
    await writeMovementFixture(fixture.home, {
      id: movementId,
      reason: "send",
      from: "main",
      legs: [{ from: "main", to: "team-treasury", status: "sent" }],
    });
    fixture.balances.set("team-treasury", 1_000_000n);
    await writeFile(
      join(fixture.home, "swarms", ".team.funding"),
      `${JSON.stringify(
        {
          v: 1,
          name: "team",
          from: "main",
          amountUsd: "1.00",
          applyPolicy: true,
          fundMovementId: movementId,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await fundSwarm(
      { name: "team", amountUsd: "1.00", from: "main", setup: true },
      fixture.deps,
    );

    expect(result).toMatchObject({
      status: "sent",
      fund: { movementId, resumed: true, complete: true },
      policy: { reason: "allocate", complete: true },
    });
    expect(fixture.transfer.mock.calls.filter(([args]) => args.from === "main")).toHaveLength(0);
    expect(await readSwarm(fixture.home, "team")).toMatchObject({
      setupFunding: {
        amountUsd: "1.00",
        from: "main",
        movementId,
        status: "sent",
        policy: { strategy: "even", status: "sent" },
      },
    });
    expect(await readdir(join(fixture.home, "swarms"))).not.toContain(".team.funding");
  });

  it("refuses a recorded setup movement that sends outside the swarm", async () => {
    const fixture = await capitalFixture({ strategy: "even" });
    const movementId = "mv_outsidefund1";
    await writeMovementFixture(fixture.home, {
      id: movementId,
      reason: "send",
      from: "main",
      legs: [{ from: "main", to: "outside", status: "planned" }],
    });
    const swarm = await readRawSwarm(fixture.home);
    swarm.setupFunding = {
      amountUsd: "1.00",
      from: "main",
      movementId,
      status: "planned",
      policy: { strategy: "even", status: "planned" },
    };
    await writeRawSwarm(fixture.home, swarm);

    await expect(
      fundSwarm({ name: "team", amountUsd: "1.00", from: "main", setup: true }, fixture.deps),
    ).rejects.toMatchObject({
      code: "invalid_swarm",
      message: expect.stringContaining(movementId),
    });
    expect(fixture.transfer).not.toHaveBeenCalled();
  });

  it("refuses a recorded setup policy movement that sends outside the swarm", async () => {
    const fixture = await capitalFixture({ strategy: "even" });
    const fundMovementId = "mv_safefunding1";
    const policyMovementId = "mv_outpolicy01";
    await writeMovementFixture(fixture.home, {
      id: fundMovementId,
      reason: "send",
      from: "main",
      legs: [{ from: "main", to: "team-treasury", status: "sent" }],
    });
    await writeMovementFixture(fixture.home, {
      id: policyMovementId,
      reason: "allocate",
      from: "team-treasury",
      treasury: "team-treasury",
      legs: [{ from: "team-treasury", to: "outside", status: "planned" }],
    });
    const swarm = await readRawSwarm(fixture.home);
    swarm.setupFunding = {
      amountUsd: "1.00",
      from: "main",
      movementId: fundMovementId,
      status: "sent",
      policy: { strategy: "even", movementId: policyMovementId, status: "planned" },
    };
    await writeRawSwarm(fixture.home, swarm);

    await expect(
      fundSwarm({ name: "team", amountUsd: "1.00", from: "main", setup: true }, fixture.deps),
    ).rejects.toMatchObject({
      code: "invalid_swarm",
      message: expect.stringContaining(policyMovementId),
    });
    expect(fixture.transfer).not.toHaveBeenCalled();
  });

  it("refuses changed setup funding arguments and directs the user to swarm fund", async () => {
    const fixture = await capitalFixture({ strategy: "even" });
    await fundSwarm({ name: "team", amountUsd: "3.00", from: "main", setup: true }, fixture.deps);
    const transfers = fixture.transfer.mock.calls.length;

    await expect(
      fundSwarm({ name: "team", amountUsd: "4.00", from: "main", setup: true }, fixture.deps),
    ).rejects.toMatchObject({
      code: "invalid_swarm",
      message: expect.stringContaining("use vapi swarm fund"),
    });
    expect(fixture.transfer).toHaveBeenCalledTimes(transfers);
  });

  it("refuses setup funding when its referenced movement file is missing", async () => {
    const fixture = await capitalFixture({ strategy: "even" });
    const movementId = "mv_recordedfund01";
    const swarm = await readRawSwarm(fixture.home);
    swarm.setupFunding = {
      amountUsd: "3.00",
      from: "main",
      movementId,
      status: "planned",
      policy: { strategy: "even", status: "planned" },
    };
    await writeRawSwarm(fixture.home, swarm);

    await expect(
      fundSwarm({ name: "team", amountUsd: "3.00", from: "main", setup: true }, fixture.deps),
    ).rejects.toMatchObject({
      code: "invalid_swarm",
      message: expect.stringContaining("vapi swarm status team"),
    });
    await expect(
      fundSwarm({ name: "team", amountUsd: "3.00", from: "main", setup: true }, fixture.deps),
    ).rejects.toMatchObject({
      message: expect.stringContaining("vapi swarm fund team"),
    });
    expect(await movementFiles(fixture.home)).toEqual([]);
    expect(fixture.transfer).not.toHaveBeenCalled();
  });

  it("refuses setup allocation when its referenced movement file is missing", async () => {
    const fixture = await capitalFixture({ strategy: "even" });
    const first = await fundSwarm(
      { name: "team", amountUsd: "4.50", from: "main", setup: true },
      fixture.deps,
    );
    const swarm = await readSwarm(fixture.home, "team");
    const policyMovementId = swarm.setupFunding?.policy?.movementId;
    expect(first.status).toBe("sent");
    expect(policyMovementId).toBeDefined();
    await rm(join(fixture.home, "movements", `${policyMovementId}.json`));
    const transfers = fixture.transfer.mock.calls.length;

    await expect(
      fundSwarm({ name: "team", amountUsd: "4.50", from: "main", setup: true }, fixture.deps),
    ).rejects.toMatchObject({
      code: "invalid_swarm",
      message: expect.stringContaining("vapi swarm status team"),
    });
    await expect(
      fundSwarm({ name: "team", amountUsd: "4.50", from: "main", setup: true }, fixture.deps),
    ).rejects.toMatchObject({
      message: expect.stringContaining("vapi swarm fund team"),
    });
    expect(fixture.transfer).toHaveBeenCalledTimes(transfers);
    expect((await readSwarm(fixture.home, "team")).setupFunding?.policy?.movementId).toBe(
      policyMovementId,
    );
  });

  it("does not sign again when a completed setup reference survives backup and restore", async () => {
    const fixture = await capitalFixture({ strategy: "even" });
    await fundSwarm({ name: "team", amountUsd: "4.50", from: "main", setup: true }, fixture.deps);
    const encodedVaultKey = await fixture.deps.secrets.get("vault-key");
    if (encodedVaultKey === undefined) throw new Error("Expected the fixture vault key.");
    const vaultKey = Buffer.from(encodedVaultKey, "base64");
    const source = await exportBackupSource({ store: fixture.store, vaultKey });
    expect(source.movements).toEqual([]);
    expect(source.swarms[0]?.setupFunding?.movementId).toBeDefined();

    const restoredHome = await mkdtemp(join(tmpdir(), "vapi-swarm-restored-"));
    homes.push(restoredHome);
    const { skipped, ...plaintextSource } = source;
    expect(skipped).toBeUndefined();
    const plaintext: BackupPlaintextV2 = { v: 2, ...plaintextSource };
    await restoreFromBackup({
      plaintext,
      home: restoredHome,
      vaultKey,
      device: "restored-device",
    });
    const restoredSecrets = memorySecretStore({ "vault-key": encodedVaultKey });
    const restoredStore = await WalletStore.open(restoredHome, {
      secrets: restoredSecrets,
      env: {},
    });
    const transfer = vi.fn<(args: TransferArgs) => Promise<TransferResult>>(async (args) =>
      transferResult(args, "sent"),
    );

    await expect(
      fundSwarm(
        { name: "team", amountUsd: "4.50", from: "main", setup: true },
        {
          home: restoredHome,
          store: restoredStore,
          secrets: restoredSecrets,
          apiBase: API_BASE,
          transfer,
        },
      ),
    ).rejects.toMatchObject({
      code: "invalid_swarm",
      message: expect.stringContaining("vapi swarm status team"),
    });
    expect(transfer).not.toHaveBeenCalled();
  });

  it.each(["sent", "incomplete"] as const)(
    "does not create funding for a terminal setup record without a movement id (%s)",
    async (status) => {
      const fixture = await capitalFixture({ strategy: "even" });
      const swarm = await readRawSwarm(fixture.home);
      swarm.setupFunding = { amountUsd: "3.00", from: "main", status };
      await writeRawSwarm(fixture.home, swarm);

      const result = await fundSwarm(
        { name: "team", amountUsd: "3.00", from: "main", setup: true },
        fixture.deps,
      );

      expect(result.status).toBe(status);
      expect(result.fund).toBeUndefined();
      expect(await movementFiles(fixture.home)).toEqual([]);
      expect(fixture.transfer).not.toHaveBeenCalled();
    },
  );

  it("refuses planned setup funding without a recorded movement id", async () => {
    const fixture = await capitalFixture({ strategy: "even" });
    const swarm = await readRawSwarm(fixture.home);
    swarm.setupFunding = { amountUsd: "3.00", from: "main", status: "planned" };
    await writeRawSwarm(fixture.home, swarm);

    await expect(
      fundSwarm({ name: "team", amountUsd: "3.00", from: "main", setup: true }, fixture.deps),
    ).rejects.toMatchObject({
      code: "invalid_swarm",
      message: expect.stringContaining("without a movement id"),
    });
    expect(await movementFiles(fixture.home)).toEqual([]);
    expect(fixture.transfer).not.toHaveBeenCalled();
  });

  it("resumes an unknown setup funding leg without creating a second funding movement", async () => {
    const fixture = await capitalFixture({ strategy: "even" });
    let fundingAttempts = 0;
    fixture.transfer.mockImplementation(async (args) => {
      if (args.from === "main" && fundingAttempts++ === 0) return transferResult(args, "unknown");
      return await fixture.send(args);
    });

    const first = await fundSwarm(
      { name: "team", amountUsd: "3.00", from: "main", setup: true },
      fixture.deps,
    );
    const second = await fundSwarm(
      { name: "team", amountUsd: "3.00", from: "main", setup: true },
      fixture.deps,
    );

    expect(first).toMatchObject({ status: "incomplete", fund: { complete: false } });
    expect(second).toMatchObject({
      status: "sent",
      fund: { movementId: first.fund!.movementId, resumed: true, complete: true },
    });
    expect(await movementsWithReason(fixture.home, "send")).toHaveLength(1);
  });

  it("resumes unfinished explicit funding and does not start the new request", async () => {
    const fixture = await capitalFixture();
    let attempts = 0;
    fixture.transfer.mockImplementation(async (args) =>
      attempts++ === 0 ? transferResult(args, "unknown") : await fixture.send(args),
    );
    const first = await fundSwarm({ name: "team", amountUsd: "1.00", from: "main" }, fixture.deps);

    const second = await fundSwarm({ name: "team", amountUsd: "9.00", from: "main" }, fixture.deps);

    expect(second).toMatchObject({
      status: "resumed",
      fund: { movementId: first.fund!.movementId, resumed: true },
    });
    expect(await movementsWithReason(fixture.home, "send")).toHaveLength(1);
    expect(fixture.transfer.mock.calls.map(([args]) => args.amountUsd)).toEqual(["1.00", "1.00"]);
  });

  it("funds and applies the targets policy through one rebalance movement", async () => {
    const fixture = await capitalFixture({ strategy: "targets" });
    fixture.balances.set("team-lead-1", 500_000n);
    fixture.balances.set("team-helper-1", 0n);
    await fixture.store.clearLink("team-trader-1");

    const result = await fundSwarm(
      { name: "team", amountUsd: "4.00", from: "main", setup: true },
      fixture.deps,
    );

    expect(result).toMatchObject({
      status: "sent",
      fund: { reason: "send", complete: true },
      policy: {
        status: "sent",
        movement: { reason: "rebalance", complete: true },
      },
      skipped: [{ account: "team-trader-1", reason: "not_linked" }],
    });
    const reasons = await Promise.all(
      (await movementFiles(fixture.home)).map(
        async (file) => (await readMovement(fixture.home, file.slice(0, -5))).reason,
      ),
    );
    expect(reasons).toEqual(["send", "rebalance"]);
  });

  it("resumes policy application without funding twice after a balance read fails", async () => {
    const fixture = await capitalFixture({ strategy: "targets" });
    const readBalance = fixture.deps.balanceReader!;
    let failTreasuryRead = true;
    fixture.deps.balanceReader = async (input) => {
      if (input.account === "team-treasury" && failTreasuryRead) {
        throw new Error("balance temporarily unavailable");
      }
      return await readBalance(input);
    };

    await expect(
      fundSwarm({ name: "team", amountUsd: "4.00", from: "main", setup: true }, fixture.deps),
    ).rejects.toThrow("balance temporarily unavailable");
    expect(fixture.transfer.mock.calls.filter(([args]) => args.from === "main")).toHaveLength(1);

    failTreasuryRead = false;
    const result = await fundSwarm(
      { name: "team", amountUsd: "4.00", from: "main", setup: true },
      fixture.deps,
    );

    expect(result).toMatchObject({
      status: "sent",
      fund: { resumed: true, complete: true },
      policy: { status: "sent", movement: { reason: "rebalance", complete: true } },
    });
    expect(fixture.transfer.mock.calls.filter(([args]) => args.from === "main")).toHaveLength(1);
    expect(await movementFiles(fixture.home)).toHaveLength(2);
  });

  it("replans recorded setup intent from current members and ceilings before creating allocation", async () => {
    const fixture = await capitalFixture({ strategy: "weights" });
    const readBalance = fixture.deps.balanceReader!;
    fixture.deps.balanceReader = async ({ account, ...rest }) => {
      if (account === "team-treasury") throw new Error("stop before allocation creation");
      return await readBalance({ account, ...rest });
    };

    await expect(
      fundSwarm({ name: "team", amountUsd: "4.50", from: "main", setup: true }, fixture.deps),
    ).rejects.toThrow("stop before allocation creation");
    const journaled = await readRawSwarm(fixture.home);
    expect(journaled.setupFunding).toMatchObject({
      amountUsd: "4.50",
      status: "sent",
      policy: { strategy: "weights", status: "planned" },
    });
    if (journaled.setupFunding?.policy === undefined) {
      throw new Error("Expected setup funding policy intent.");
    }
    expect(journaled.setupFunding.policy).not.toHaveProperty("movementId");

    journaled.members = journaled.members.filter((member) => member.account !== "team-lead-1");
    await writeRawSwarm(fixture.home, journaled);
    await fixture.store.setCeiling("team-helper-1", 500_000n);
    fixture.deps.balanceReader = readBalance;

    const result = await fundSwarm(
      { name: "team", amountUsd: "4.50", from: "main", setup: true },
      fixture.deps,
    );

    expect(result.policy).toMatchObject({ reason: "allocate", complete: true });
    if (result.policy === undefined || !("legs" in result.policy)) {
      throw new Error("Expected a recorded allocation movement.");
    }
    expect(result.policy.legs.some((leg) => leg.to === "team-lead-1")).toBe(false);
    expect(result.policy.legs).toContainEqual(
      expect.objectContaining({ to: "team-helper-1", amountUsd: "1.00" }),
    );
    expect(fixture.transfer.mock.calls.filter(([args]) => args.from === "main")).toHaveLength(1);
  });

  it.each([
    ["even", ["2.25", "2.25"]],
    ["weights", ["3.00", "1.50"]],
  ] as const)(
    "funds and applies the %s policy over linked members only",
    async (strategy, expectedAmounts) => {
      const fixture = await capitalFixture({ strategy });
      await fixture.store.clearLink("team-trader-1");

      const result = await fundSwarm(
        { name: "team", amountUsd: "4.50", from: "main", setup: true },
        fixture.deps,
      );

      expect(result.status).toBe("sent");
      expect(result.policy).toMatchObject({ reason: "allocate", complete: true });
      if (result.policy === undefined || !("legs" in result.policy)) {
        throw new Error("Expected an allocation movement result.");
      }
      expect(result.policy.legs.map((leg) => leg.to)).toEqual(["team-lead-1", "team-helper-1"]);
      expect(result.policy.legs.map((leg) => leg.amountUsd)).toEqual(expectedAmounts);
      expect(result.skipped).toEqual([{ account: "team-trader-1", reason: "not_linked" }]);
      const movements = await movementFiles(fixture.home);
      expect(movements).toHaveLength(2);
      const allocation = await readMovement(fixture.home, result.policy.movementId);
      expect(allocation).toMatchObject({
        reason: "allocate",
        from: "team-treasury",
        treasury: "team-treasury",
      });
    },
  );

  it("uses the even planner's first-member remainder while enforcing ceilings", async () => {
    const fixture = await capitalFixture({ strategy: "even" });
    fixture.balances.set("team-lead-1", 9_800_000n);

    const result = await fundSwarm(
      { name: "team", amountUsd: "1.01", from: "main", setup: true },
      fixture.deps,
    );

    expect(result.policy).toBeDefined();
    if (result.policy === undefined || !("legs" in result.policy)) {
      throw new Error("Expected an allocation movement result.");
    }
    expect(result.policy.legs.map((leg) => leg.amountUsd)).toEqual(["0.20", "0.33", "0.33"]);
    expect(result.blocked).toContainEqual({
      to: "team-lead-1",
      amountUsd: "0.15",
      reason: "recipient_ceiling",
    });
  });

  it("blocks funded weighted shares at each recipient's live ceiling", async () => {
    const fixture = await capitalFixture({ strategy: "weights" });
    fixture.balances.set("team-helper-1", 5_000_000n);

    const result = await fundSwarm(
      { name: "team", amountUsd: "4.00", from: "main", setup: true },
      fixture.deps,
    );

    expect(result.status).toBe("incomplete");
    expect(result.policy).toMatchObject({ complete: true });
    if (result.policy === undefined || !("legs" in result.policy)) {
      throw new Error("Expected an allocation movement result.");
    }
    expect(result.policy.legs.some((leg) => leg.to === "team-helper-1")).toBe(false);
    expect(fixture.transfer.mock.calls.some(([args]) => args.to === "team-helper-1")).toBe(false);
  });

  it("records a ceiling-blocked setup allocation as final and recommends rebalance", async () => {
    const fixture = await capitalFixture({ strategy: "weights" });
    fixture.balances.set("team-helper-1", 5_000_000n);

    const first = await fundSwarm(
      { name: "team", amountUsd: "4.00", from: "main", setup: true },
      fixture.deps,
    );
    const filesAfterFirst = await movementFiles(fixture.home);
    const transfersAfterFirst = fixture.transfer.mock.calls.length;
    const second = await fundSwarm(
      { name: "team", amountUsd: "4.00", from: "main", setup: true },
      fixture.deps,
    );

    expect(first).toMatchObject({
      status: "incomplete",
      blocked: [{ to: "team-helper-1", amountUsd: "1.00", reason: "recipient_ceiling" }],
      message: expect.stringContaining("vapi swarm rebalance"),
    });
    expect(second).toMatchObject({
      status: "incomplete",
      blocked: first.blocked,
      message: expect.stringContaining("vapi swarm rebalance"),
    });
    expect(await movementFiles(fixture.home)).toEqual(filesAfterFirst);
    expect(fixture.transfer).toHaveBeenCalledTimes(transfersAfterFirst);
    expect(await readSwarm(fixture.home, "team")).toMatchObject({
      setupFunding: {
        status: "sent",
        policy: {
          status: "incomplete",
          blocked: [{ to: "team-helper-1", amountUsd: "1.00", reason: "recipient_ceiling" }],
        },
      },
    });
  });

  it("records failed setup allocation legs as blocked and never retries them", async () => {
    const fixture = await capitalFixture({ strategy: "even" });
    fixture.transfer.mockImplementation(async (args) => {
      if (args.to === "team-helper-1") {
        throw new TransferError("relay_failed", "allocation refused", {
          reservationReleased: true,
        });
      }
      return await fixture.send(args);
    });

    const first = await fundSwarm(
      { name: "team", amountUsd: "3.00", from: "main", setup: true },
      fixture.deps,
    );
    const transfers = fixture.transfer.mock.calls.length;
    const second = await fundSwarm(
      { name: "team", amountUsd: "3.00", from: "main", setup: true },
      fixture.deps,
    );

    expect(first).toMatchObject({
      status: "incomplete",
      blocked: [{ to: "team-helper-1", amountUsd: "1.00", reason: "relay_failed" }],
      message: expect.stringContaining("vapi accounts distribute --resume"),
    });
    expect(second.blocked).toEqual(first.blocked);
    expect(fixture.transfer).toHaveBeenCalledTimes(transfers);
  });

  it("resolves an unknown setup leg without retrying or retaining stale state for a failed leg", async () => {
    const fixture = await capitalFixture({ strategy: "even" });
    fixture.transfer.mockImplementation(async (args) => {
      if (args.to === "team-helper-1") {
        throw new TransferError("relay_failed", "allocation refused", {
          reservationReleased: true,
        });
      }
      if (args.to === "team-trader-1" && args.resume === undefined) {
        return transferResult(args, "unknown");
      }
      return await fixture.send(args);
    });

    const first = await fundSwarm(
      { name: "team", amountUsd: "3.00", from: "main", setup: true },
      fixture.deps,
    );
    const helperAttempts = () =>
      fixture.transfer.mock.calls.filter(([args]) => args.to === "team-helper-1").length;
    expect(first).toMatchObject({
      status: "incomplete",
      policy: {
        legs: expect.arrayContaining([
          expect.objectContaining({ to: "team-helper-1", status: "failed" }),
          expect.objectContaining({ to: "team-trader-1", status: "unknown" }),
        ]),
      },
      blocked: [{ to: "team-helper-1", amountUsd: "1.00", reason: "relay_failed" }],
    });
    expect(helperAttempts()).toBe(1);

    const second = await fundSwarm(
      { name: "team", amountUsd: "3.00", from: "main", setup: true },
      fixture.deps,
    );
    const transfersAfterResolution = fixture.transfer.mock.calls.length;
    const third = await fundSwarm(
      { name: "team", amountUsd: "3.00", from: "main", setup: true },
      fixture.deps,
    );

    expect(second).toMatchObject({
      status: "incomplete",
      policy: {
        legs: expect.arrayContaining([
          expect.objectContaining({ to: "team-helper-1", status: "failed" }),
          expect.objectContaining({ to: "team-trader-1", status: "sent" }),
        ]),
      },
      blocked: [{ to: "team-helper-1", amountUsd: "1.00", reason: "relay_failed" }],
    });
    expect(third.blocked).toEqual(second.blocked);
    expect(helperAttempts()).toBe(1);
    expect(fixture.transfer).toHaveBeenCalledTimes(transfersAfterResolution);
    expect(await readSwarm(fixture.home, "team")).toMatchObject({
      setupFunding: {
        policy: {
          status: "incomplete",
          blocked: [{ to: "team-helper-1", amountUsd: "1.00", reason: "relay_failed" }],
        },
      },
    });
  });
});

describe("swarm rebalancing", () => {
  it("refuses a new leg while the sender's automatic ceiling sweep remains unknown", async () => {
    const fixture = await capitalFixture({ strategy: "targets" });
    const member = fixture.swarm.members[0]!;
    fixture.balances.set(member.account, 20_000_000n);
    await fixture.store.updateCeilingSweepPending(member.account, () => ({
      owner: OWNER,
      target: fixture.swarm.treasury.address!,
      amountAtomic: "10000000",
      nonce: `0x${"99".repeat(32)}`,
      createdAt: new Date(NOW).toISOString(),
      status: "unknown",
    }));
    const deps = fixture.deps;
    deps.reconcileCeilingSweep = vi.fn<NonNullable<SwarmCapitalDeps["reconcileCeilingSweep"]>>(
      async (account) => ({ account, status: "unknown" }),
    );

    await expect(
      rebalanceSwarm({ name: "team", targetsUsd: { lead: "10.00" } }, deps),
    ).rejects.toMatchObject({
      code: "ceiling_sweep_pending",
      message: expect.stringContaining("vapi status"),
    });
    expect(fixture.transfer).not.toHaveBeenCalled();
    expect(await movementFiles(fixture.home)).toEqual([]);
  });

  it("refuses capital movement when a recorded swarm address differs from the local account", async () => {
    const fixture = await capitalFixture({ strategy: "targets" });
    const raw = await readRawSwarm(fixture.home);
    const lead = raw.members.find((member) => member.account === "team-lead-1")!;
    lead.address = "0x9999999999999999999999999999999999999999";
    await writeRawSwarm(fixture.home, raw);
    fixture.balances.set("team-treasury", 1_000_000n);

    await expect(rebalanceSwarm({ name: "team" }, fixture.deps)).rejects.toMatchObject({
      code: "account_address_mismatch",
      message: expect.stringMatching(/team-lead-1.*swarm team.*restore/i),
    });
    expect(fixture.transfer).not.toHaveBeenCalled();
  });

  it("refuses to resume a swarm movement after an account address changes", async () => {
    const fixture = await capitalFixture({ strategy: "targets" });
    const movementId = "mv_address001";
    await writeMovementFixture(fixture.home, {
      id: movementId,
      reason: "rebalance",
      from: "team-treasury",
      treasury: "team-treasury",
      legs: [{ from: "team-treasury", to: "team-lead-1", status: "planned" }],
    });
    const raw = await readRawSwarm(fixture.home);
    const lead = raw.members.find((member) => member.account === "team-lead-1")!;
    lead.address = "0x9999999999999999999999999999999999999999";
    await writeRawSwarm(fixture.home, raw);

    await expect(rebalanceSwarm({ name: "team" }, fixture.deps)).rejects.toMatchObject({
      code: "account_address_mismatch",
      message: expect.stringContaining("team-lead-1"),
    });
    expect(fixture.transfer).not.toHaveBeenCalled();
    await expect(readMovement(fixture.home, movementId)).resolves.toMatchObject({
      legs: [{ status: "planned" }],
    });
  });

  it("plans mixed target overrides and reports unlinked members without persisting overrides", async () => {
    const fixture = await capitalFixture({ strategy: "targets" });
    fixture.balances.set("team-treasury", 10_000_000n);
    fixture.balances.set("team-lead-1", 500_000n);
    fixture.balances.set("team-helper-1", 2_000_000n);
    await fixture.store.clearLink("team-trader-1");

    const result = await rebalanceSwarm(
      {
        name: "team",
        targetsUsd: { lead: "1.50", "team-helper-1": "1.50" },
      },
      fixture.deps,
    );

    expect(result).toMatchObject({
      status: "sent",
      movement: {
        reason: "rebalance",
        complete: true,
        legs: [
          {
            from: "team-helper-1",
            to: "team-treasury",
            amountUsd: "0.50",
            purpose: "sweep",
          },
          {
            from: "team-treasury",
            to: "team-lead-1",
            amountUsd: "1.00",
            purpose: "send",
          },
        ],
      },
      blocked: [],
      skipped: [{ account: "team-trader-1", reason: "not_linked" }],
    });
    expect(
      (await readSwarm(fixture.home, "team")).members.map(({ account, targetAtomic }) => ({
        account,
        targetAtomic,
      })),
    ).toEqual([
      { account: "team-lead-1", targetAtomic: "2000000" },
      { account: "team-helper-1", targetAtomic: "1000000" },
      { account: "team-trader-1", targetAtomic: "1000000" },
    ]);
  });

  it("resumes one qualifying rebalance exactly once without double-sending its sent leg", async () => {
    const fixture = await capitalFixture({ strategy: "targets" });
    fixture.balances.set("team-treasury", 10_000_000n);
    fixture.balances.set("team-lead-1", 500_000n);
    fixture.balances.set("team-helper-1", 2_000_000n);
    await fixture.store.clearLink("team-trader-1");
    let crash = true;
    fixture.transfer.mockImplementation(async (args) => {
      if (args.to === "team-lead-1" && crash) {
        crash = false;
        throw new Error("simulated rebalance crash");
      }
      return fixture.send(args);
    });

    await expect(rebalanceSwarm({ name: "team" }, fixture.deps)).rejects.toThrow(
      "simulated rebalance crash",
    );
    const [file] = await movementFiles(fixture.home);
    expect(file).toBeDefined();
    const movementId = file!.slice(0, -5);
    await expect(readMovement(fixture.home, movementId)).resolves.toMatchObject({
      reason: "rebalance",
      treasury: "team-treasury",
      legs: [
        {
          from: "team-helper-1",
          to: "team-treasury",
          amountUsd: "1.00",
          purpose: "sweep",
          status: "sent",
        },
        {
          from: "team-treasury",
          to: "team-lead-1",
          amountUsd: "1.50",
          purpose: "send",
          status: "planned",
        },
      ],
    });

    const result = await rebalanceSwarm({ name: "team" }, fixture.deps);

    expect(result).toMatchObject({
      status: "resumed",
      movement: { movementId, resumed: true, complete: true },
      blocked: [],
      skipped: [],
      message: expect.stringContaining(`Resumed unfinished movement ${movementId}`),
    });
    expect(await movementFiles(fixture.home)).toEqual([`${movementId}.json`]);
    expect(
      fixture.transfer.mock.calls.filter(([args]) => args.from === "team-helper-1"),
    ).toHaveLength(1);
    expect(fixture.transfer.mock.calls.filter(([args]) => args.to === "team-lead-1")).toHaveLength(
      2,
    );
  });

  it("uses the wallet's current ceiling and reports the blocked target as incomplete", async () => {
    const fixture = await capitalFixture({ strategy: "targets" });
    await fixture.store.setCeiling("team-lead-1", 3_000_000n);
    fixture.balances.set("team-treasury", 4_000_000n);
    fixture.balances.set("team-helper-1", 1_000_000n);
    fixture.balances.set("team-trader-1", 1_000_000n);

    const result = await rebalanceSwarm(
      { name: "team", targetsUsd: { lead: "4.00" } },
      fixture.deps,
    );

    expect(result).toMatchObject({
      status: "incomplete",
      movement: { complete: true, legs: [{ to: "team-lead-1", amountUsd: "3.00" }] },
      blocked: [{ to: "team-lead-1", amountUsd: "1.00", reason: "recipient_ceiling" }],
    });
  });

  it("splits an oversized member rebalance sweep at the relay maximum", async () => {
    const fixture = await capitalFixture({ strategy: "targets" });
    fixture.balances.set("team-lead-1", 60_000_000n);
    fixture.balances.set("team-helper-1", 1_000_000n);
    fixture.balances.set("team-trader-1", 1_000_000n);

    const result = await rebalanceSwarm({ name: "team" }, fixture.deps);

    expect(result).toMatchObject({
      status: "sent",
      movement: {
        legs: [
          { from: "team-lead-1", amountUsd: "50.00", purpose: "sweep", status: "sent" },
          { from: "team-lead-1", amountUsd: "8.00", purpose: "sweep", status: "sent" },
        ],
      },
    });
  });

  it("reports incomplete when every required target leg is blocked", async () => {
    const fixture = await capitalFixture({ strategy: "targets" });

    const result = await rebalanceSwarm({ name: "team" }, fixture.deps);

    expect(result).toMatchObject({
      status: "incomplete",
      blocked: expect.arrayContaining([
        expect.objectContaining({ reason: "insufficient_balance" }),
      ]),
      message: expect.stringContaining("every required leg is blocked"),
    });
    expect(result.movement).toBeUndefined();
  });

  it("serializes balance planning so concurrent rebalances do not duplicate a deficit", async () => {
    const fixture = await capitalFixture({ strategy: "targets" });
    fixture.balances.set("team-treasury", 2_000_000n);
    fixture.balances.set("team-helper-1", 1_000_000n);
    fixture.balances.set("team-trader-1", 1_000_000n);
    const readBalance = fixture.deps.balanceReader!;
    let releaseFirstRead!: () => void;
    const firstReadReleased = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    let notifyFirstRead!: () => void;
    const firstReadStarted = new Promise<void>((resolve) => {
      notifyFirstRead = resolve;
    });
    let held = false;
    fixture.deps.balanceReader = async (input) => {
      if (input.account === "team-treasury" && !held) {
        held = true;
        notifyFirstRead();
        await firstReadReleased;
      }
      return await readBalance(input);
    };

    const first = rebalanceSwarm({ name: "team" }, fixture.deps);
    await firstReadStarted;
    const second = rebalanceSwarm({ name: "team" }, fixture.deps);
    releaseFirstRead();
    const results = await Promise.all([first, second]);

    expect(results.map((result) => result.status).sort()).toEqual(["balanced", "sent"]);
    expect(fixture.transfer.mock.calls.filter(([args]) => args.to === "team-lead-1")).toHaveLength(
      1,
    );
  });

  it.each([
    [
      "fund",
      async (fixture: CapitalFixture) =>
        await fundSwarm({ name: "team", amountUsd: "1.00", from: "main" }, fixture.deps),
    ],
    [
      "rebalance",
      async (fixture: CapitalFixture) => await rebalanceSwarm({ name: "team" }, fixture.deps),
    ],
    [
      "leave",
      async (fixture: CapitalFixture) =>
        await leaveSwarm({ name: "team", member: "team-lead-1" }, fixture.deps),
    ],
    [
      "dissolve",
      async (fixture: CapitalFixture) => await dissolveSwarm({ name: "team" }, fixture.deps),
    ],
  ])("blocks %s when an unrelated unfinished movement touches a member", async (_name, run) => {
    const fixture = await capitalFixture();
    const movementId = "mv_unrelated01";
    const path = await writeMovementFixture(fixture.home, {
      id: movementId,
      reason: "distribute",
      from: "main",
      legs: [{ from: "main", to: "team-lead-1", status: "planned" }],
    });
    const before = await readFile(path, "utf8");

    await expect(run(fixture)).rejects.toMatchObject({
      code: "movement_unfinished",
      message: `Movement ${movementId} touches swarm team and is unfinished; resume it with vapi accounts distribute --resume ${movementId}.`,
    });

    expect(await readFile(path, "utf8")).toBe(before);
    expect(fixture.transfer).not.toHaveBeenCalled();
  });

  it("blocks a treasury-tagged movement with a leg to an outside account", async () => {
    const fixture = await capitalFixture();
    const movementId = "mv_outside001";
    await writeMovementFixture(fixture.home, {
      id: movementId,
      reason: "rebalance",
      from: "team-treasury",
      treasury: "team-treasury",
      legs: [{ from: "team-treasury", to: "main", status: "planned" }],
    });

    await expect(rebalanceSwarm({ name: "team" }, fixture.deps)).rejects.toMatchObject({
      code: "movement_unfinished",
      message: expect.stringContaining(movementId),
    });
    expect(fixture.transfer).not.toHaveBeenCalled();
  });

  it("blocks a treasury-tagged member sweep that sends directly to the owner", async () => {
    const fixture = await capitalFixture();
    const movementId = "mv_memberowner1";
    await writeMovementFixture(fixture.home, {
      id: movementId,
      reason: "sweep",
      from: "team-lead-1",
      treasury: "team-treasury",
      legs: [{ from: "team-lead-1", to: "owner", status: "planned", purpose: "sweep" }],
    });

    await expect(rebalanceSwarm({ name: "team" }, fixture.deps)).rejects.toMatchObject({
      code: "movement_unfinished",
      message: expect.stringContaining(movementId),
    });
    expect(fixture.transfer).not.toHaveBeenCalled();
  });

  it("blocks a treasury-tagged movement from a different network", async () => {
    const fixture = await capitalFixture();
    const movementId = "mv_network001";
    await writeMovementFixture(fixture.home, {
      id: movementId,
      reason: "rebalance",
      from: "team-treasury",
      treasury: "team-treasury",
      network: ARC_MAINNET_CAIP2,
      legs: [{ from: "team-treasury", to: "team-lead-1", status: "planned" }],
    });

    await expect(rebalanceSwarm({ name: "team" }, fixture.deps)).rejects.toMatchObject({
      code: "movement_unfinished",
      message: expect.stringContaining(movementId),
    });
    expect(fixture.transfer).not.toHaveBeenCalled();
  });
});

describe("leaving a swarm", () => {
  it("resumes a qualifying movement and stops before removing the member", async () => {
    const fixture = await capitalFixture();
    const movementId = "mv_leave_resume";
    await writeMovementFixture(fixture.home, {
      id: movementId,
      reason: "allocate",
      from: "team-treasury",
      treasury: "team-treasury",
      legs: [
        {
          from: "team-treasury",
          to: "team-lead-1",
          fromAddress: fixture.swarm.treasury.address,
          toAddress: fixture.swarm.members.find(({ account }) => account === "team-lead-1")!
            .address,
          status: "planned",
        },
      ],
    });

    const result = await leaveSwarm({ name: "team", member: "team-lead-1" }, fixture.deps);

    expect(result).toMatchObject({
      status: "resumed",
      member: "team-lead-1",
      movement: { movementId, complete: true },
    });
    expect((await readSwarm(fixture.home, "team")).members.map(({ account }) => account)).toContain(
      "team-lead-1",
    );
  });

  it("sweeps a whole-cent balance before removing the member", async () => {
    const fixture = await capitalFixture();
    fixture.balances.set("team-lead-1", 1_234_567n);

    const result = await leaveSwarm({ name: "team", member: "team-lead-1" }, fixture.deps);

    expect(result).toMatchObject({
      status: "left",
      member: "team-lead-1",
      movement: {
        reason: "sweep",
        complete: true,
        legs: [
          {
            from: "team-lead-1",
            to: "team-treasury",
            amountUsd: "1.23",
            purpose: "sweep",
            status: "sent",
          },
        ],
      },
    });
    expect(
      (await readSwarm(fixture.home, "team")).members.map(({ account }) => account),
    ).not.toContain("team-lead-1");
    expect(fixture.store.has("team-lead-1")).toBe(true);
    await expect(readAgentProfile(fixture.home, "team-lead-1")).resolves.toBeDefined();
  });

  it.each(["failed", "unknown"] as const)(
    "keeps the member when its sweep is %s",
    async (outcome) => {
      const fixture = await capitalFixture();
      fixture.balances.set("team-lead-1", 1_230_000n);
      fixture.transfer.mockImplementation(async (args) => {
        if (outcome === "failed") {
          throw new TransferError("relay_failed", "relay refused", {
            reservationReleased: true,
          });
        }
        return transferResult(args, "unknown");
      });

      const result = await leaveSwarm({ name: "team", member: "team-lead-1" }, fixture.deps);

      expect(result).toMatchObject({
        status: "kept",
        member: "team-lead-1",
        movement: { complete: false, legs: [{ status: outcome }] },
      });
      expect(
        (await readSwarm(fixture.home, "team")).members.map(({ account }) => account),
      ).toContain("team-lead-1");
    },
  );

  it("removes a sub-cent member without creating a movement", async () => {
    const fixture = await capitalFixture();
    fixture.balances.set("team-lead-1", 9_999n);

    const result = await leaveSwarm({ name: "team", member: "team-lead-1" }, fixture.deps);

    expect(result).toMatchObject({ status: "left", member: "team-lead-1" });
    expect(result.movement).toBeUndefined();
    expect(await movementFiles(fixture.home)).toEqual([]);
    expect(
      (await readSwarm(fixture.home, "team")).members.map(({ account }) => account),
    ).not.toContain("team-lead-1");
  });

  it("refuses to remove the treasury and directs the caller to dissolve", async () => {
    const fixture = await capitalFixture();

    await expect(
      leaveSwarm({ name: "team", member: "team-treasury" }, fixture.deps),
    ).rejects.toMatchObject({
      code: "treasury_refused",
      message: expect.stringContaining("use swarm dissolve"),
    });
    expect(await movementFiles(fixture.home)).toEqual([]);
  });

  it("refuses to remove a member while a resumed allocation leg stays unknown", async () => {
    const fixture = await capitalFixture();
    const movementId = "mv_unknown001";
    await writeMovementFixture(fixture.home, {
      id: movementId,
      reason: "allocate",
      from: "team-treasury",
      treasury: "team-treasury",
      legs: [
        {
          from: "team-treasury",
          to: "team-lead-1",
          fromAddress: fixture.swarm.treasury.address,
          toAddress: fixture.swarm.members.find(({ account }) => account === "team-lead-1")!
            .address,
          status: "unknown",
        },
      ],
    });
    fixture.transfer.mockImplementation(async (args) => transferResult(args, "unknown"));
    fixture.deps.authorizationState = vi.fn(async () => "pending" as const);

    await expect(
      leaveSwarm({ name: "team", member: "team-lead-1" }, fixture.deps),
    ).rejects.toMatchObject({
      code: "movement_unfinished",
      message: expect.stringContaining(movementId),
    });
    expect((await readSwarm(fixture.home, "team")).members.map(({ account }) => account)).toContain(
      "team-lead-1",
    );
    await expect(readMovement(fixture.home, movementId)).resolves.toMatchObject({
      legs: [{ status: "unknown" }],
    });
  });

  it("serializes a concurrent rebalance behind the full leave operation", async () => {
    const fixture = await capitalFixture();
    fixture.balances.set("team-lead-1", 1_230_000n);
    fixture.balances.set("team-helper-1", 1_000_000n);
    fixture.balances.set("team-trader-1", 1_000_000n);
    const readBalance = fixture.deps.balanceReader!;
    const reads: string[] = [];
    let releaseLeave!: () => void;
    const leaveReleased = new Promise<void>((resolve) => {
      releaseLeave = resolve;
    });
    let notifyLeaveRead!: () => void;
    const leaveReadStarted = new Promise<void>((resolve) => {
      notifyLeaveRead = resolve;
    });
    let notifyRebalanceRead!: () => void;
    const rebalanceReadStarted = new Promise<void>((resolve) => {
      notifyRebalanceRead = resolve;
    });
    let held = false;
    fixture.deps.balanceReader = async (input) => {
      reads.push(input.account);
      if (input.account === "team-treasury") notifyRebalanceRead();
      if (input.account === "team-lead-1" && !held) {
        held = true;
        notifyLeaveRead();
        await leaveReleased;
      }
      return await readBalance(input);
    };

    const leave = leaveSwarm({ name: "team", member: "team-lead-1" }, fixture.deps);
    await leaveReadStarted;
    const rebalance = rebalanceSwarm({ name: "team" }, fixture.deps);
    const plannedBeforeLeaveFinished = await Promise.race([
      rebalanceReadStarted.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);

    expect(plannedBeforeLeaveFinished).toBe(false);
    expect(reads).toEqual(["team-lead-1"]);

    releaseLeave();
    const [leaveResult, rebalanceResult] = await Promise.all([leave, rebalance]);
    expect(leaveResult.status).toBe("left");
    expect(rebalanceResult.status).toBe("balanced");
  });
});

describe("dissolving a swarm", () => {
  it("fails closed for a member-only legacy journal with both new markers absent", async () => {
    const fixture = await capitalFixture();
    fixture.balances.set("team-lead-1", 1_000_000n);
    fixture.transfer.mockImplementationOnce(async (args) => transferResult(args, "unknown"));
    const initial = await dissolveSwarm({ name: "team" }, fixture.deps);
    const id = initial.movements[0]!.movementId;
    const movement = await readMovement(fixture.home, id);
    const { dissolution: _movementMarker, ...legacy } = movement;
    void _movementMarker;
    await writeFile(join(fixture.home, "movements", `${id}.json`), JSON.stringify(legacy));
    const { dissolving: _swarmMarker, ...oldSwarm } = await readSwarm(fixture.home, "team");
    void _swarmMarker;
    await writeRawSwarm(fixture.home, oldSwarm);
    await mkdir(join(fixture.home, "runs"), { recursive: true });
    await writeFile(
      join(fixture.home, "runs", "run_0123456789abcdef01234567.railway.json"),
      JSON.stringify({ v: 1, swarm: "team", sandboxId: "sbx_legacy" }),
    );
    fixture.transfer.mockClear();
    await expect(executeMovement({ resume: id }, fixture.deps)).rejects.toThrow(
      "vapi swarm stop team --all",
    );
    expect(fixture.transfer).not.toHaveBeenCalled();
  });

  it("guards a direct sweep by signer address before any RPC", async () => {
    const fixture = await capitalFixture();
    await writeRawSwarm(fixture.home, { ...fixture.swarm, dissolving: true });
    await mkdir(join(fixture.home, "runs"), { recursive: true });
    await writeFile(
      join(fixture.home, "runs", "run_0123456789abcdef01234567.railway.json"),
      JSON.stringify({ v: 1, swarm: "team", sandboxId: "sbx_direct" }),
    );
    vi.stubEnv("VAPI_HOME", fixture.home);
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("Unexpected RPC");
    });
    try {
      await expect(
        sweepBack({
          account: await fixture.store.unlock("team-lead-1", ""),
          config: getDefaultConfig(),
          network: BASE_MAINNET_CAIP2,
          destination: OWNER,
          fetchImpl,
        }),
      ).rejects.toThrow("vapi swarm stop team --all");
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("guards a new executor caller even with a custom transfer implementation", async () => {
    const fixture = await capitalFixture();
    const swarm = await readSwarm(fixture.home, "team");
    await writeRawSwarm(fixture.home, { ...swarm, dissolving: true });
    await mkdir(join(fixture.home, "runs"), { recursive: true });
    await writeFile(
      join(fixture.home, "runs", "run_0123456789abcdef01234567.railway.json"),
      JSON.stringify({ v: 1, swarm: "team", sandboxId: "sbx_new" }),
    );
    const futureFeature = async () =>
      await executeTransfer(
        {
          store: fixture.store,
          secrets: fixture.deps.secrets,
          apiBase: API_BASE,
          from: "team-lead-1",
          to: "team-treasury",
          amountUsd: 1,
        },
        fixture.transfer,
      );
    await expect(futureFeature()).rejects.toThrow("vapi swarm stop team --all");
    expect(fixture.transfer).not.toHaveBeenCalled();
  });

  it.each([
    "fund",
    "setup-fund",
    "rebalance",
    "leave",
    "distribute-resume",
    "ceiling-reconcile",
    "paid-call-ceiling",
    "new-sdk-caller",
  ] as const)(
    "guards legacy member legs at the shared transfer boundary through %s",
    async (entry) => {
      const fixture = await capitalFixture();
      fixture.balances.set("team-lead-1", 1_000_000n);
      fixture.transfer.mockImplementationOnce(async (args) => transferResult(args, "unknown"));
      const initial = await dissolveSwarm({ name: "team" }, fixture.deps);
      const id = initial.movements[0]!.movementId;
      const movement = await readMovement(fixture.home, id);
      // Simulate a pre-marker member-to-treasury sweep after dissolve intent was recorded.
      const { dissolution: _marker, ...legacy } = movement;
      void _marker;
      await writeFile(join(fixture.home, "movements", `${id}.json`), JSON.stringify(legacy));
      await mkdir(join(fixture.home, "runs"), { recursive: true });
      await writeFile(
        join(fixture.home, "runs", "run_0123456789abcdef01234567.railway.json"),
        JSON.stringify({ v: 1, swarm: "team", account: "team-lead-1", sandboxId: "sbx_remote" }),
      );
      const originalCheck = workerGuard.assertSwarmWorkersStopped;
      const checked = vi
        .spyOn(workerGuard, "assertSwarmWorkersStopped")
        .mockImplementation(async (home, swarm) => {
          await expect(stat(join(home, "swarms", `.${swarm.name}.lock`))).resolves.toBeDefined();
          return await originalCheck(home, swarm);
        });
      fixture.transfer.mockClear();
      const fetchImpl = vi.fn<typeof fetch>(async () => {
        throw new Error("No outbound request is permitted");
      });
      const operation = () =>
        entry === "fund"
          ? fundSwarm({ name: "team", amountUsd: 1, from: "main" }, fixture.deps)
          : entry === "setup-fund"
            ? fundSwarm({ name: "team", amountUsd: 1, from: "main", setup: true }, fixture.deps)
            : entry === "rebalance"
              ? rebalanceSwarm({ name: "team" }, fixture.deps)
              : entry === "leave"
                ? leaveSwarm({ name: "team", member: "team-lead-1" }, fixture.deps)
                : entry === "ceiling-reconcile"
                  ? withSwarmAccountMovementLocks(
                      fixture.home,
                      ["team-lead-1"],
                      undefined,
                      async () =>
                        await reconcileUnresolvedMovementsForAccountLocked(
                          fixture.home,
                          "team-lead-1",
                          fixture.deps,
                        ),
                    )
                  : entry === "paid-call-ceiling"
                    ? sweepAboveCeiling({
                        store: fixture.store,
                        secrets: fixture.deps.secrets,
                        apiBase: API_BASE,
                        account: "team-lead-1",
                        transfer: fixture.transfer,
                        balanceReader: async () => 0n,
                        fetchImpl,
                      })
                    : entry === "new-sdk-caller"
                      ? transferBetweenAccounts({
                          store: fixture.store,
                          secrets: fixture.deps.secrets,
                          apiBase: API_BASE,
                          from: "team-lead-1",
                          to: "owner",
                          amountUsd: 1,
                          fetchImpl,
                          now: () => NOW,
                        })
                      : executeMovement({ resume: id }, fixture.deps);
      await operation().catch(() => undefined);
      expect(checked, `${entry} must reach the same worker guard`).toHaveBeenCalled();
      expect(fixture.transfer).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect((await readMovement(fixture.home, id)).legs[0]?.status).toBe("unknown");
    },
  );

  it.each(
    (["fund", "setup-fund", "rebalance", "leave", "executor"] as const).flatMap((command) => [
      { command, sender: "team-treasury" },
      { command, sender: "team-lead-1" },
    ]),
  )(
    "guards an incomplete $sender dissolution resumed through $command",
    async ({ command, sender }) => {
      const fixture = await capitalFixture();
      fixture.balances.set(sender, 1_000_000n);
      fixture.transfer.mockImplementationOnce(async () => {
        throw new TransferError("relay_failed", "retry later", { reservationReleased: true });
      });
      const initial = await dissolveSwarm({ name: "team" }, fixture.deps);
      expect(initial.status).toBe("incomplete");
      const id = initial.movements[0]!.movementId;
      expect((await readMovement(fixture.home, id)).dissolution).toBe("team");
      await mkdir(join(fixture.home, "runs"), { recursive: true });
      await writeFile(
        join(fixture.home, "runs", "run_0123456789abcdef01234567.railway.json"),
        JSON.stringify({ v: 1, swarm: "team", account: "team-lead-1", sandboxId: "sbx_remote" }),
      );
      fixture.transfer.mockClear();
      const resume = () =>
        command === "fund"
          ? fundSwarm({ name: "team", amountUsd: 1, from: "main" }, fixture.deps)
          : command === "setup-fund"
            ? fundSwarm({ name: "team", amountUsd: 1, from: "main", setup: true }, fixture.deps)
            : command === "rebalance"
              ? rebalanceSwarm({ name: "team" }, fixture.deps)
              : command === "leave"
                ? leaveSwarm({ name: "team", member: "team-lead-1" }, fixture.deps)
                : executeMovement({ resume: id }, fixture.deps);
      await expect(resume()).rejects.toThrow("vapi swarm stop team --all");
      expect(fixture.transfer).not.toHaveBeenCalled();
      await rm(join(fixture.home, "runs"), { recursive: true });
      await expect(resume()).resolves.toBeDefined();
      expect(fixture.transfer).toHaveBeenCalled();
    },
  );

  it.each([
    {
      label: "orphaned sidecar",
      suffix: ".railway.json",
      contents: {
        v: 1,
        swarm: "team",
        account: "team-lead-1",
        state: "orphaned",
        sandboxId: "sbx_1",
      },
    },
    {
      label: "kept sidecar",
      suffix: ".railway.json",
      contents: { v: 1, swarm: "team", account: "team-lead-1", state: "kept", sandboxId: "sbx_1" },
    },
    {
      label: "unattributed legacy sidecar",
      suffix: ".railway.json",
      contents: { v: 1, checkpoint: "test", keepSandbox: true, sandboxId: "sbx_1" },
    },
    { label: "unreadable run record", suffix: ".json", contents: null },
  ])("refuses a tracked $label before moving money", async ({ suffix, contents }) => {
    const fixture = await capitalFixture();
    fixture.balances.set("team-lead-1", 1_000_000n);
    const runs = join(fixture.home, "runs");
    await mkdir(runs, { recursive: true });
    await writeFile(join(runs, `run_0123456789abcdef01234567${suffix}`), JSON.stringify(contents));
    const reconcileCeilingSweep = vi.fn<NonNullable<SwarmCapitalDeps["reconcileCeilingSweep"]>>();
    fixture.deps.reconcileCeilingSweep = reconcileCeilingSweep;

    await expect(dissolveSwarm({ name: "team" }, fixture.deps)).rejects.toThrow(
      "vapi swarm stop team --all",
    );

    expect(reconcileCeilingSweep).not.toHaveBeenCalled();
    expect(fixture.transfer).not.toHaveBeenCalled();
    expect(await movementFiles(fixture.home)).toEqual([]);
    await expect(readSwarm(fixture.home, "team")).resolves.toBeDefined();
  });

  it("reconciles worker state before checking dissolution eligibility", async () => {
    const fixture = await capitalFixture();
    const path = join(fixture.home, "runs", "run_0123456789abcdef01234567.railway.json");
    await mkdir(join(fixture.home, "runs"), { recursive: true });
    await writeFile(path, JSON.stringify({ v: 1, swarm: "team", sandboxId: "sbx_1" }));
    const reconcileRuns = vi.fn(async () => {
      await rm(path);
    });
    fixture.deps.reconcileRuns = reconcileRuns;

    await expect(dissolveSwarm({ name: "team" }, fixture.deps)).resolves.toMatchObject({
      status: "dissolved",
    });

    expect(reconcileRuns).toHaveBeenCalledWith({ home: fixture.home, name: "team" });
  });

  it.each([
    { kind: "local", swarm: "team", account: "team-lead-1", state: "running" },
    { kind: "railway", swarm: "other", account: "other-lead-1", state: "running" },
    { kind: "railway", swarm: "team", account: "team-lead-1", state: "stopped" },
  ])(
    "allows dissolution with a $kind $state run of $swarm that holds no remote swarm key",
    async (record) => {
      const fixture = await capitalFixture();
      const runId = "run_0123456789abcdef01234567";
      await mkdir(join(fixture.home, "runs"), { recursive: true });
      await writeFile(
        join(fixture.home, "runs", `${runId}.json`),
        JSON.stringify({
          v: 1,
          runId,
          kind: record.kind,
          state: record.state,
          member: { swarm: record.swarm, account: record.account },
          handle: { ref: "sbx_1" },
        }),
      );
      // Other swarms' sidecars must not block this swarm either.
      await writeFile(
        join(fixture.home, "runs", "run_1123456789abcdef01234567.railway.json"),
        JSON.stringify({
          v: 1,
          swarm: "other",
          account: "other-lead-1",
          sandboxId: "sbx_other",
        }),
      );

      await expect(dissolveSwarm({ name: "team" }, fixture.deps)).resolves.toMatchObject({
        status: "dissolved",
      });
    },
  );

  it("resumes a qualifying movement and stops before dissolving the swarm", async () => {
    const fixture = await capitalFixture();
    const movementId = "mv_dissolve_resume";
    await writeMovementFixture(fixture.home, {
      id: movementId,
      reason: "allocate",
      from: "team-treasury",
      treasury: "team-treasury",
      legs: [
        {
          from: "team-treasury",
          to: "team-lead-1",
          fromAddress: fixture.swarm.treasury.address,
          toAddress: fixture.swarm.members.find(({ account }) => account === "team-lead-1")!
            .address,
          status: "planned",
        },
      ],
    });

    const result = await dissolveSwarm({ name: "team" }, fixture.deps);

    expect(result).toMatchObject({
      status: "resumed",
      movements: [{ movementId, complete: true }],
    });
    await expect(readSwarm(fixture.home, "team")).resolves.toBeDefined();
  });

  it("sweeps members to treasury, sweeps treasury to owner, and preserves accounts and profiles", async () => {
    const fixture = await capitalFixture();
    fixture.balances.set("team-treasury", 250_000n);
    fixture.balances.set("team-lead-1", 1_230_000n);
    fixture.balances.set("team-helper-1", 500_000n);
    fixture.balances.set("team-trader-1", 9_999n);
    const walletsBefore = await readFile(join(fixture.home, "wallets.json"), "utf8");

    const result = await dissolveSwarm({ name: "team" }, fixture.deps);

    expect(result).toMatchObject({
      status: "dissolved",
      movements: [
        {
          reason: "sweep",
          complete: true,
          legs: [
            { from: "team-lead-1", to: "team-treasury", amountUsd: "1.23" },
            { from: "team-helper-1", to: "team-treasury", amountUsd: "0.50" },
          ],
        },
        {
          reason: "sweep",
          complete: true,
          legs: [{ from: "team-treasury", to: "owner", amountUsd: "1.98" }],
        },
      ],
    });
    await expect(readSwarm(fixture.home, "team")).rejects.toMatchObject({
      code: "swarm_not_found",
    });
    expect(await readFile(join(fixture.home, "wallets.json"), "utf8")).toBe(walletsBefore);
    await expect(
      readMovement(fixture.home, result.movements[1]!.movementId),
    ).resolves.toMatchObject({
      treasury: "team-treasury",
      legs: [{ from: "team-treasury", to: "owner" }],
    });
    for (const member of fixture.swarm.members) {
      expect(fixture.store.has(member.account)).toBe(true);
      await expect(readAgentProfile(fixture.home, member.account)).resolves.toBeDefined();
    }
  });

  it("splits a treasury sweep above the relay per-transfer maximum", async () => {
    const fixture = await capitalFixture();
    fixture.balances.set("team-treasury", 60_000_000n);

    const result = await dissolveSwarm({ name: "team" }, fixture.deps);

    expect(result.status).toBe("dissolved");
    expect(result.movements.at(-1)?.legs.map((leg) => leg.amountUsd)).toEqual(["50.00", "10.00"]);
    expect(
      fixture.transfer.mock.calls
        .map(([args]) => String(args.amountUsd))
        .every((amount) => parseUsdCents(amount) <= 5_000n),
    ).toBe(true);
  });

  it("keeps swarm state and does not sweep the owner after a failed member leg", async () => {
    const fixture = await capitalFixture();
    fixture.balances.set("team-treasury", 250_000n);
    fixture.balances.set("team-lead-1", 1_230_000n);
    fixture.balances.set("team-helper-1", 500_000n);
    fixture.transfer.mockImplementation(async (args) => {
      if (args.from === "team-helper-1") {
        throw new TransferError("relay_failed", "relay refused", {
          reservationReleased: true,
        });
      }
      return fixture.send(args);
    });

    const result = await dissolveSwarm({ name: "team" }, fixture.deps);

    expect(result).toMatchObject({
      status: "incomplete",
      movements: [{ complete: false, legs: [{ status: "sent" }, { status: "failed" }] }],
    });
    await expect(readSwarm(fixture.home, "team")).resolves.toBeDefined();
    expect(fixture.transfer.mock.calls.some(([args]) => args.to === "owner")).toBe(false);
    expect(await movementFiles(fixture.home)).toHaveLength(1);
  });
});

type CapitalFixture = {
  home: string;
  store: WalletStore;
  swarm: SwarmFile;
  balances: Map<string, bigint>;
  transfer: ReturnType<typeof vi.fn<(args: TransferArgs) => Promise<TransferResult>>>;
  send: (args: TransferArgs) => Promise<TransferResult>;
  deps: SwarmCapitalDeps;
};

async function capitalFixture(
  options: { strategy?: "targets" | "even" | "weights" } = {},
): Promise<CapitalFixture> {
  const home = await mkdtemp(join(tmpdir(), "vapi-swarm-capital-"));
  homes.push(home);
  const values = new Map<string, string>();
  const secrets: SecretStore = {
    available: true,
    platform: "darwin",
    description: "test store",
    get: async (name) => values.get(name),
    has: async (name) => values.has(name),
    set: async (name, value) => {
      values.set(name, value);
    },
    remove: async (name) => values.delete(name),
  };
  const store = await WalletStore.open(home, { secrets, env: {}, now: () => new Date(NOW) });
  await store.create("main", "", { phrase: PHRASE });
  const setup = await setupSwarm({
    home,
    store,
    secrets,
    apiBase: API_BASE,
    name: "team",
    roles: ["lead", "helper", "trader"],
    strategy: options.strategy ?? "targets",
    surface: "cli",
    env: {},
    hostname: "Test Host",
    now: () => new Date(NOW),
    startDeviceLink: async (args) => linkStart(args.label),
    pollDeviceLink: async () => ({
      owner: OWNER,
      tokens: {
        accessToken: "private-access-token",
        refreshToken: "private-refresh-token",
        expiresAt: NOW + 3_600_000,
        scopes: ["mcp:call", "router.use"],
      },
    }),
  });
  const balances = new Map<string, bigint>(
    ["main", ...swarmAccounts(setup.swarm)].map((account) => [account, 0n]),
  );
  const send = async (args: TransferArgs): Promise<TransferResult> => {
    const amountAtomic = parseUsdCents(args.amountUsd) * 10_000n;
    balances.set(args.from, (balances.get(args.from) ?? 0n) - amountAtomic);
    if (args.to !== "owner") balances.set(args.to, (balances.get(args.to) ?? 0n) + amountAtomic);
    return transferResult(args, "sent");
  };
  const transfer = vi.fn<(args: TransferArgs) => Promise<TransferResult>>(send);
  let id = 0;
  let nonce = 0;
  const deps: SwarmCapitalDeps = {
    home,
    store,
    secrets,
    apiBase: API_BASE,
    balanceReader: async ({ account }) => balances.get(account) ?? 0n,
    transfer,
    now: () => NOW,
    randomId: () => `mv_capital${String((id += 1)).padStart(2, "0")}`,
    randomNonce: () => `0x${(nonce += 1).toString(16).padStart(64, "0")}` as Hex,
  };
  return { home, store, swarm: setup.swarm, balances, transfer, send, deps };
}

function linkStart(label: string): DeviceLinkStart {
  return {
    clientId: `agent_${label}`,
    deviceCode: "private-device-code",
    userCode: "BCDF-GHJK",
    verificationUri: `${API_BASE}/link`,
    verificationUriComplete: `${API_BASE}/link?code=BCDF-GHJK`,
    expiresIn: 600,
    interval: 5,
    autoApproved: true,
  };
}

function swarmAccounts(swarm: SwarmFile): string[] {
  return [swarm.treasury.account, ...swarm.members.map((member) => member.account)];
}

function transferResult(args: TransferArgs, status: "sent" | "unknown"): TransferResult {
  const nonce = args.resume ?? args.nonce;
  if (nonce === undefined) throw new Error("A test transfer requires a nonce.");
  return {
    status,
    from: args.from,
    to: getAddress("0x2222222222222222222222222222222222222222"),
    toName: args.to,
    toKind: args.to === "owner" ? "owner" : "account",
    amountUsd: String(args.amountUsd),
    amountAtomic: (parseUsdCents(args.amountUsd) * 10_000n).toString(),
    network: args.network as TransferNetwork,
    txHash: status === "sent" ? (`0x${"ab".repeat(32)}` as const) : null,
    nonce,
    replayed: args.resume !== undefined,
  };
}

async function movementFiles(home: string): Promise<string[]> {
  try {
    return (await readdir(join(home, "movements"))).filter((file) => file.endsWith(".json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function movementsWithReason(home: string, reason: string) {
  return await Promise.all(
    (await movementFiles(home))
      .map((file) => file.slice(0, -5))
      .map(async (id) => await readMovement(home, id)),
  ).then((movements) => movements.filter((movement) => movement.reason === reason));
}

type RawSwarmState = {
  setupFunding?: {
    amountUsd: string;
    from: string;
    movementId?: string;
    status: "planned" | "sent" | "incomplete";
    policy?: {
      strategy: "targets" | "even" | "weights";
      movementId?: string;
      status: "planned" | "sent" | "incomplete";
    };
  };
  members: Array<{ account: string; address?: string; [key: string]: unknown }>;
  [key: string]: unknown;
};

async function readRawSwarm(home: string): Promise<RawSwarmState> {
  return JSON.parse(await readFile(join(home, "swarms", "team.json"), "utf8")) as RawSwarmState;
}

async function writeRawSwarm(home: string, swarm: unknown): Promise<void> {
  await writeFile(join(home, "swarms", "team.json"), `${JSON.stringify(swarm, null, 2)}\n`, "utf8");
}

async function writeMovementFixture(
  home: string,
  input: {
    id: string;
    reason: "distribute" | "allocate" | "rebalance" | "sweep" | "send";
    from: string;
    treasury?: string;
    network?: TransferNetwork;
    legs: Array<{
      from: string;
      to: string;
      fromAddress?: string;
      toAddress?: string;
      status: "planned" | "sent" | "failed" | "unknown";
      purpose?: "send" | "sweep";
    }>;
  },
): Promise<string> {
  const directory = join(home, "movements");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${input.id}.json`);
  await writeFile(
    path,
    `${JSON.stringify(
      {
        v: 2,
        id: input.id,
        reason: input.reason,
        from: input.from,
        ...(input.treasury === undefined ? {} : { treasury: input.treasury }),
        network: input.network ?? BASE_MAINNET_CAIP2,
        createdAt: new Date(NOW).toISOString(),
        legs: input.legs.map((leg, index) => ({
          ...leg,
          amountUsd: "1.00",
          purpose: leg.purpose ?? "send",
          nonce: `0x${(index + 1).toString(16).padStart(64, "0")}`,
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return path;
}
