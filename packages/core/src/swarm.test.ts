import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createAccount } from "./account-add.js";
import type { DeviceLinkStart, LinkResult } from "./agent-link.js";
import { readAgentProfile, writeAgentProfile } from "./agent-profile.js";
import { DEFAULT_SPEND_CAPS } from "./config.js";
import { FileLockedError } from "./atomic-file.js";
import type { Movement } from "./movement.js";
import type { SecretStore } from "./secret-store.js";
import {
  DEFAULT_SWARM_MODEL,
  SWARM_TREASURY_CAPS,
  addSwarmMember,
  deleteSwarmFile,
  listSwarms,
  readSwarm,
  setupSwarm,
  swarmAccountNames,
  swarmFilePath,
  swarmFileSchema,
  swarmMemberName,
  swarmParentResolver,
  swarmStatus,
  writeSwarm,
  withSwarmLock,
  type SetupSwarmOptions,
  type SwarmFile,
} from "./swarm.js";
import { WalletStore } from "./wallet-store.js";
import { BASE_MAINNET_CAIP2 } from "./x402-networks.js";

const NOW = new Date("2026-09-29T10:00:00.000Z");
const OWNER = "0x1111111111111111111111111111111111111111" as const;
const API_BASE = "https://api.vapinetwork.ai";
const PHRASE = "test test test test test test test test test test test junk";
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

it("preserves a nested lock error without relabeling it as swarm contention", async () => {
  const home = await mkdtemp(join(tmpdir(), "vapi-swarm-nested-lock-"));
  homes.push(home);
  const nested = new FileLockedError("member busy");
  await expect(
    withSwarmLock(home, "team", async () => {
      throw nested;
    }),
  ).rejects.toBe(nested);
});

async function fixture(): Promise<
  SetupSwarmOptions & {
    home: string;
    startDeviceLink: ReturnType<typeof vi.fn<NonNullable<SetupSwarmOptions["startDeviceLink"]>>>;
  }
> {
  const home = await mkdtemp(join(tmpdir(), "vapi-swarm-"));
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
  const store = await WalletStore.open(home, { secrets, env: {}, now: () => NOW });
  await store.create("main", "", { phrase: PHRASE });
  const startDeviceLink = vi.fn<NonNullable<SetupSwarmOptions["startDeviceLink"]>>(async (args) =>
    start(args.label),
  );
  return {
    home,
    store,
    secrets,
    apiBase: API_BASE,
    name: "team",
    surface: "cli",
    env: {},
    hostname: "Test Host",
    now: () => NOW,
    startDeviceLink,
    pollDeviceLink: async () => ({
      owner: OWNER,
      tokens: {
        accessToken: "private-access-token",
        refreshToken: "private-refresh-token",
        expiresAt: NOW.getTime() + 3_600_000,
        scopes: ["mcp:call", "router.use"],
      },
    }),
  };
}

function start(label: string, autoApproved = true): DeviceLinkStart {
  return {
    clientId: `agent_${label}`,
    deviceCode: "private-device-code",
    userCode: "BCDF-GHJK",
    verificationUri: `${API_BASE}/link`,
    verificationUriComplete: `${API_BASE}/link?code=BCDF-GHJK`,
    expiresIn: 600,
    interval: 5,
    autoApproved,
  };
}

async function snapshot(home: string, swarm: SwarmFile): Promise<string[]> {
  return await Promise.all(
    [
      join(home, "vault.json"),
      join(home, "wallets.json"),
      swarmFilePath(home, swarm.name),
      ...swarm.members.map((member) => join(home, "agents", `${member.account}.json`)),
    ].map((path) => readFile(path, "utf8")),
  );
}

describe("swarm setup", () => {
  it("journals the plan first, creates capped treasury and profiles, and is byte-identical on rerun", async () => {
    const opts = await fixture();
    const originalCreate = opts.store.create.bind(opts.store);
    const create = vi.spyOn(opts.store, "create").mockImplementation(async (...args) => {
      const planned = await readSwarm(opts.home, "team");
      expect(swarmAccountNames(planned)).toContain(args[0]);
      return await originalCreate(...args);
    });
    const first = await setupSwarm(opts);
    expect(first.members.map((member) => member.role)).toEqual(["treasury", "lead", "helper"]);
    expect(first.members.every((member) => member.created && member.capped && member.linked)).toBe(
      true,
    );
    expect(first.next).toEqual([]);
    expect(opts.store.entry("team-treasury")).toMatchObject({
      spendCaps: SWARM_TREASURY_CAPS,
      ceilingAtomic: null,
    });
    expect(opts.store.entry("team-lead-1")).toMatchObject({
      spendCaps: DEFAULT_SPEND_CAPS,
      ceilingAtomic: "10000000",
    });
    expect(opts.store.entry("team-helper-1")).toMatchObject({
      spendCaps: DEFAULT_SPEND_CAPS,
      ceilingAtomic: "5000000",
    });
    await expect(stat(join(opts.home, "agents", "team-treasury.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readAgentProfile(opts.home, "team-lead-1")).toMatchObject({
      model: DEFAULT_SWARM_MODEL,
      instructions: expect.stringContaining("lead"),
      tools: ["call.search", "call.inspect", "call.pay"],
      verifiedOnly: true,
      approveAboveUsd: 0.5,
      maxSteps: 12,
      paused: false,
    });
    expect((await stat(swarmFilePath(opts.home, "team"))).mode & 0o777).toBe(0o600);
    const before = await snapshot(opts.home, first.swarm);
    const calls = create.mock.calls.length;
    const second = await setupSwarm(opts);
    expect(await snapshot(opts.home, second.swarm)).toEqual(before);
    expect(create.mock.calls).toHaveLength(calls);
    expect(opts.startDeviceLink).toHaveBeenCalledTimes(3);
    expect(swarmFileSchema.parse(second.swarm)).toEqual(second.swarm);
    expect(JSON.stringify(second)).not.toMatch(
      /private-access-token|private-refresh-token|private-device-code|test test test/u,
    );
  });

  it("rejects another shape, invalid names, and accounts already owned by another swarm", async () => {
    const opts = await fixture();
    const { swarm } = await setupSwarm(opts);
    await expect(setupSwarm({ ...opts, roles: ["helper"] })).rejects.toMatchObject({
      code: "swarm_exists_different_shape",
      message: expect.stringContaining("use swarm add/leave"),
    });
    await expect(setupSwarm({ ...opts, name: "../bad" })).rejects.toMatchObject({
      code: "invalid_swarm",
    });
    await expect(setupSwarm({ ...opts, roles: ["bad-role"] })).rejects.toMatchObject({
      code: "invalid_swarm",
    });
    expect(() => swarmMemberName("abcdefghijklmnop", "abcdefgh", 10000000)).toThrow(
      expect.objectContaining({ code: "name_too_long" }),
    );
    await writeSwarm(opts.home, {
      ...swarm,
      name: "other",
      members: [{ ...swarm.members[0]!, account: "fresh-lead-1" }],
    });
    await expect(setupSwarm({ ...opts, name: "fresh", agents: 1 })).rejects.toMatchObject({
      code: "account_in_other_swarm",
    });
    expect(opts.store.has("fresh-treasury")).toBe(false);
  });

  it("resumes after a creation failure without deriving a completed account again", async () => {
    const opts = await fixture();
    const originalCreate = opts.store.create.bind(opts.store);
    const create = vi.spyOn(opts.store, "create").mockImplementation(async (...args) => {
      if (args[0] === "team-lead-1") throw new Error("simulated creation interruption");
      return await originalCreate(...args);
    });
    await expect(setupSwarm(opts)).rejects.toThrow("simulated creation interruption");
    expect((await readSwarm(opts.home, "team")).treasury.steps).toEqual({
      creating: true,
      created: true,
      capped: true,
      linked: true,
    });
    create.mockImplementation(originalCreate);
    await setupSwarm(opts);
    expect(create.mock.calls.filter(([name]) => name === "team-treasury")).toHaveLength(1);
  });

  it("uses wallet links for partial status and only reoffers unlinked accounts", async () => {
    const opts = await fixture();
    opts.startDeviceLink.mockImplementation(async (args) =>
      start(args.label, args.label !== "team-helper-1"),
    );
    const pending = new Promise<never>(() => undefined);
    const poll = opts.pollDeviceLink!;
    const first = await setupSwarm({
      ...opts,
      pollDeviceLink: async (args) =>
        args.start.clientId === "agent_team-helper-1" ? pending : await poll(args),
    });
    expect(first.next).toEqual([
      {
        kind: "link",
        account: "team-helper-1",
        userCode: "BCDF-GHJK",
        verificationUri: `${API_BASE}/link`,
        verificationUriComplete: `${API_BASE}/link?code=BCDF-GHJK`,
        expiresInSeconds: 600,
      },
    ]);
    expect(first.completions.has("team-helper-1")).toBe(true);
    const status = await swarmStatus({ ...opts, balanceReader: async () => 0n });
    expect(status.members.map((member) => member.linked)).toEqual([true, false]);
    opts.startDeviceLink.mockClear();
    await setupSwarm({ ...opts, pollDeviceLink: async () => pending });
    expect(opts.startDeviceLink.mock.calls.map(([args]) => args.label)).toEqual(["team-helper-1"]);
  });

  it("refuses a foreign account name without changing its caps or ceiling, then caps created accounts once on retry", async () => {
    const opts = await fixture();
    await createAccount({
      store: opts.store,
      name: "team-lead-1",
      caps: { perCallUsd: "0.01", perDayUsd: "0.1" },
    });
    await opts.store.setCeiling("team-lead-1", 123_000n);
    const foreignBefore = JSON.stringify(opts.store.entry("team-lead-1"));
    const setCeiling = vi.spyOn(opts.store, "setCeiling");

    await expect(setupSwarm({ ...opts, surface: "mcp" })).rejects.toMatchObject({
      code: "account_name_taken",
      message: expect.stringContaining("Account team-lead-1 already exists; account name taken"),
    });
    expect(JSON.stringify(opts.store.entry("team-lead-1"))).toBe(foreignBefore);

    await deleteSwarmFile(opts.home, "team");
    await opts.store.remove("team-lead-1", { force: true });
    await opts.store.remove("team-treasury", { force: true });
    setCeiling.mockClear();
    await setupSwarm(opts);
    expect(setCeiling.mock.calls.map(([account]) => account).sort()).toEqual([
      "team-helper-1",
      "team-lead-1",
      "team-treasury",
    ]);
  });

  it("leaves user-lowered caps and ceiling untouched on MCP and CLI reruns and reports terminal steps", async () => {
    const opts = await fixture();
    await setupSwarm({ ...opts, agents: 1 });
    const loweredCaps = { perCallAtomic: "10000", perDayAtomic: "100000" };
    await opts.store.setSpendCaps("team-lead-1", loweredCaps);
    await opts.store.setCeiling("team-lead-1", 1_000_000n);

    for (const surface of ["mcp", "cli"] as const) {
      const result = await setupSwarm({ ...opts, agents: 1, surface });
      expect(opts.store.entry("team-lead-1")).toMatchObject({
        spendCaps: loweredCaps,
        ceilingAtomic: "1000000",
      });
      expect(result.next).toEqual(
        expect.arrayContaining([
          {
            kind: "caps",
            account: "team-lead-1",
            command: "vapi accounts caps team-lead-1 --per-call 0.1 --per-day 1",
          },
          {
            kind: "caps",
            account: "team-lead-1",
            command: "vapi accounts caps team-lead-1 --ceiling 10",
          },
        ]),
      );
    }
  });

  it("does not raise caps or ceiling for a legacy account without the creating ownership marker", async () => {
    const opts = await fixture();
    await setupSwarm({ ...opts, agents: 1 });
    const loweredCaps = { perCallAtomic: "10000", perDayAtomic: "100000" };
    await opts.store.setSpendCaps("team-lead-1", loweredCaps);
    await opts.store.setCeiling("team-lead-1", 1_000_000n);
    const path = swarmFilePath(opts.home, "team");
    const legacy = JSON.parse(await readFile(path, "utf8")) as {
      members: Array<{
        account: string;
        steps: { creating?: boolean; capped: boolean };
      }>;
    };
    const lead = legacy.members.find((member) => member.account === "team-lead-1")!;
    delete lead.steps.creating;
    lead.steps.capped = false;
    await writeFile(path, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
    const setSpendCaps = vi.spyOn(opts.store, "setSpendCaps");
    const setCeiling = vi.spyOn(opts.store, "setCeiling");

    const result = await setupSwarm({ ...opts, agents: 1, surface: "mcp" });

    expect(setSpendCaps.mock.calls.filter(([account]) => account === "team-lead-1")).toHaveLength(
      0,
    );
    expect(setCeiling.mock.calls.filter(([account]) => account === "team-lead-1")).toHaveLength(0);
    expect(opts.store.entry("team-lead-1")).toMatchObject({
      spendCaps: loweredCaps,
      ceilingAtomic: "1000000",
    });
    expect((await readSwarm(opts.home, "team")).members[0]?.steps).toMatchObject({
      creating: false,
      created: true,
      capped: false,
    });
    expect(result.next).toEqual(
      expect.arrayContaining([
        {
          kind: "caps",
          account: "team-lead-1",
          command: "vapi accounts caps team-lead-1 --per-call 0.1 --per-day 1",
        },
        {
          kind: "caps",
          account: "team-lead-1",
          command: "vapi accounts caps team-lead-1 --ceiling 10",
        },
      ]),
    );
  });

  it("resumes after account creation succeeds before it can be journaled and caps exactly once", async () => {
    const opts = await fixture();
    const originalCreate = opts.store.create.bind(opts.store);
    const lowerProvisioningLimits = vi.spyOn(opts.store, "lowerProvisioningLimits");
    vi.spyOn(opts.store, "create").mockImplementationOnce(async (...args) => {
      const created = await originalCreate(...args);
      throw new Error(`crashed after creating ${created.name}`);
    });

    await expect(setupSwarm({ ...opts, agents: 1 })).rejects.toThrow(
      "crashed after creating team-treasury",
    );
    expect((await readSwarm(opts.home, "team")).treasury.steps).toMatchObject({
      creating: true,
      created: false,
      capped: false,
    });

    await setupSwarm({ ...opts, agents: 1 });
    expect(
      lowerProvisioningLimits.mock.calls.filter(([account]) => account === "team-treasury"),
    ).toHaveLength(1);
    expect((await readSwarm(opts.home, "team")).treasury.steps).toMatchObject({
      creating: true,
      created: true,
      capped: true,
    });
  });

  it("keeps stricter caps and ceiling after a crash before the capped marker is written", async () => {
    const opts = await fixture();
    await setupSwarm({ ...opts, agents: 1 });
    const swarm = await readSwarm(opts.home, "team");
    const lead = swarm.members[0]!;
    lead.steps.capped = false;
    await writeSwarm(opts.home, swarm);
    await opts.store.setSpendCaps(lead.account, {
      perCallAtomic: "10000",
      perDayAtomic: "100000",
    });
    await opts.store.setCeiling(lead.account, 1_000_000n);

    const recovered = await setupSwarm({ ...opts, agents: 1, surface: "mcp" });

    expect(opts.store.entry(lead.account)).toMatchObject({
      spendCaps: { perCallAtomic: "10000", perDayAtomic: "100000" },
      ceilingAtomic: "1000000",
    });
    expect((await readSwarm(opts.home, "team")).members[0]?.steps.capped).toBe(true);
    expect(recovered.next).toEqual(
      expect.arrayContaining([
        {
          kind: "caps",
          account: lead.account,
          command: `vapi accounts caps ${lead.account} --per-call 0.1 --per-day 1`,
        },
        {
          kind: "caps",
          account: lead.account,
          command: `vapi accounts caps ${lead.account} --ceiling 10`,
        },
      ]),
    );
  });

  it("preserves an owner reduction that races setup recovery before the registry lock", async () => {
    const opts = await fixture();
    await setupSwarm({ ...opts, agents: 1 });
    const swarm = await readSwarm(opts.home, "team");
    const lead = swarm.members[0]!;
    lead.steps.capped = false;
    await writeSwarm(opts.home, swarm);

    let entered!: () => void;
    const recoveryEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let proceed!: () => void;
    const ownerReduced = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    const atomicName = "lowerProvisioningLimits";
    const atomic = Reflect.get(opts.store, atomicName);
    if (typeof atomic === "function") {
      Reflect.set(opts.store, atomicName, async (...args: unknown[]) => {
        entered();
        await ownerReduced;
        return await Reflect.apply(atomic, opts.store, args);
      });
    } else {
      const setSpendCaps = opts.store.setSpendCaps.bind(opts.store);
      vi.spyOn(opts.store, "setSpendCaps").mockImplementationOnce(async (...args) => {
        entered();
        await ownerReduced;
        return await setSpendCaps(...args);
      });
    }

    const recovery = setupSwarm({ ...opts, agents: 1, surface: "mcp" });
    await recoveryEntered;
    const ownerStore = await WalletStore.open(opts.home, {
      secrets: opts.secrets,
      env: {},
      now: () => NOW,
    });
    await ownerStore.setSpendCaps(lead.account, {
      perCallAtomic: "10000",
      perDayAtomic: "100000",
    });
    await ownerStore.setCeiling(lead.account, 1_000_000n);
    proceed();
    await recovery;
    await opts.store.reload();

    expect(opts.store.entry(lead.account)).toMatchObject({
      spendCaps: { perCallAtomic: "10000", perDayAtomic: "100000" },
      ceilingAtomic: "1000000",
    });
  });

  it("refuses to rename an account referenced by a swarm", async () => {
    const opts = await fixture();
    await setupSwarm({ ...opts, agents: 1 });

    await expect(
      opts.store.rename("team-lead-1", "archived", { secrets: opts.secrets }),
    ).rejects.toThrow(/team-lead-1.*swarm team.*dissolve/i);
    expect(opts.store.has("team-lead-1")).toBe(true);
    expect(opts.store.has("archived")).toBe(false);
  });

  it("returns pending link details without completions or polling when approval is not awaited", async () => {
    const opts = await fixture();
    opts.startDeviceLink.mockImplementation(async (args) => start(args.label, false));
    const sleep = vi.fn(async () => await new Promise<never>(() => undefined));
    const pollDeviceLink = vi.fn(async () => {
      await sleep();
      return opts.pollDeviceLink!({} as never);
    });

    const result = await setupSwarm({
      ...opts,
      agents: 1,
      awaitApproval: false,
      pollDeviceLink,
      sleep,
    });

    expect(result.next).toEqual([
      expect.objectContaining({ kind: "link", account: "team-treasury" }),
      expect.objectContaining({ kind: "link", account: "team-lead-1" }),
    ]);
    expect(result.completions.size).toBe(0);
    expect(pollDeviceLink).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("persists a later approval without losing members added while it was pending", async () => {
    const opts = await fixture();
    opts.startDeviceLink.mockImplementation(async (args) =>
      start(args.label, args.label !== "team-helper-1"),
    );
    let approve!: (result: LinkResult) => void;
    const pending = new Promise<LinkResult>((resolve) => {
      approve = resolve;
    });
    const poll = opts.pollDeviceLink!;
    const first = await setupSwarm({
      ...opts,
      pollDeviceLink: async (args) =>
        args.start.clientId === "agent_team-helper-1" ? pending : await poll(args),
    });
    await addSwarmMember({ ...opts, role: "trader" });
    approve({
      owner: OWNER,
      tokens: {
        accessToken: "private-approved-access",
        refreshToken: "private-approved-refresh",
        expiresAt: NOW.getTime() + 3_600_000,
        scopes: ["mcp:call", "router.use"],
      },
    });
    await expect(first.completions.get("team-helper-1")).resolves.toEqual({
      linked: true,
      owner: OWNER,
    });
    const latest = await readSwarm(opts.home, "team");
    expect(latest.members.map((member) => member.account)).toEqual([
      "team-lead-1",
      "team-helper-1",
      "team-trader-1",
    ]);
    expect(latest.members.find((member) => member.account === "team-helper-1")?.steps.linked).toBe(
      true,
    );
  });

  it("refuses a treasury profile and preserves an existing member profile", async () => {
    const opts = await fixture();
    await writeAgentProfile(opts.home, {
      version: 1,
      name: "team-treasury",
      wallet: "team-treasury",
      model: "custom",
      instructions: "Treasury profile",
      createdAt: NOW.toISOString(),
    });
    await expect(setupSwarm(opts)).rejects.toMatchObject({ code: "invalid_swarm" });
    expect(opts.store.has("team-treasury")).toBe(false);
    await writeAgentProfile(opts.home, {
      version: 1,
      name: "fresh-lead-1",
      wallet: "fresh-lead-1",
      model: "custom",
      instructions: "Keep me",
      createdAt: NOW.toISOString(),
    });
    await setupSwarm({ ...opts, name: "fresh", agents: 1 });
    expect(await readAgentProfile(opts.home, "fresh-lead-1")).toMatchObject({
      model: "custom",
      instructions: "Keep me",
    });
  });

  it("writes role grants into new lead and non-lead profiles", async () => {
    const opts = await fixture();

    await setupSwarm(opts);

    await expect(readAgentProfile(opts.home, "team-lead-1")).resolves.toMatchObject({
      grants: ["read", "delegate", "allocate"],
    });
    await expect(readAgentProfile(opts.home, "team-helper-1")).resolves.toMatchObject({
      grants: ["read"],
    });
  });

  it("does not rewrite an existing member profile to add role grants", async () => {
    const opts = await fixture();
    await writeAgentProfile(opts.home, {
      version: 1,
      name: "team-lead-1",
      wallet: "team-lead-1",
      model: "custom",
      instructions: "Keep this profile byte-for-byte.",
      grants: ["read"],
      createdAt: NOW.toISOString(),
    });
    const path = join(opts.home, "agents", "team-lead-1.json");
    const before = await readFile(path, "utf8");

    await setupSwarm({ ...opts, agents: 1 });

    expect(await readFile(path, "utf8")).toBe(before);
  });
});

describe("swarm members and state", () => {
  it("adds helper-3 with overrides and refuses cross-swarm membership", async () => {
    const opts = await fixture();
    await setupSwarm({ ...opts, roles: ["lead", "helper", "helper"] });
    const added = await addSwarmMember({
      ...opts,
      role: "helper",
      targetUsd: "3.5",
      weight: 4,
      ceilingUsd: null,
    });
    expect(added.members).toHaveLength(5);
    expect(added.members).toContainEqual(
      expect.objectContaining({ account: "team-helper-3", linked: true, profiled: true }),
    );
    expect(added.swarm.members.at(-1)).toMatchObject({
      account: "team-helper-3",
      targetAtomic: "3500000",
      weight: 4,
      ceilingAtomic: null,
    });
    await writeSwarm(opts.home, {
      ...added.swarm,
      name: "other",
      members: [{ ...added.swarm.members[0]!, account: "team-helper-4" }],
    });
    await expect(addSwarmMember({ ...opts, role: "helper" })).rejects.toMatchObject({
      code: "account_in_other_swarm",
    });
    expect((await readSwarm(opts.home, "team")).members).toHaveLength(4);
  });

  it("resumes an added member whose account creation was interrupted", async () => {
    const opts = await fixture();
    await setupSwarm(opts);
    const originalCreate = opts.store.create.bind(opts.store);
    const create = vi.spyOn(opts.store, "create").mockImplementation(async (...args) => {
      if (args[0] === "team-helper-2") throw new Error("simulated add interruption");
      return await originalCreate(...args);
    });

    await expect(addSwarmMember({ ...opts, role: "helper" })).rejects.toThrow(
      "simulated add interruption",
    );
    expect((await readSwarm(opts.home, "team")).members.at(-1)).toMatchObject({
      account: "team-helper-2",
      steps: { created: false },
    });

    create.mockImplementation(originalCreate);
    const resumed = await addSwarmMember({ ...opts, role: "helper" });
    expect(resumed.swarm.members.map((member) => member.account)).toEqual([
      "team-lead-1",
      "team-helper-1",
      "team-helper-2",
    ]);
  });

  it("resumes an added member whose link startup failed", async () => {
    const opts = await fixture();
    await setupSwarm(opts);
    opts.startDeviceLink.mockRejectedValueOnce(new Error("link service unavailable"));

    await expect(addSwarmMember({ ...opts, role: "helper" })).rejects.toMatchObject({
      code: "invalid_swarm",
    });
    expect((await readSwarm(opts.home, "team")).members.at(-1)).toMatchObject({
      account: "team-helper-2",
      steps: { created: true, capped: true, profiled: true, linked: false },
    });

    const resumed = await addSwarmMember({ ...opts, role: "helper" });
    expect(resumed.swarm.members.map((member) => member.account)).toEqual([
      "team-lead-1",
      "team-helper-1",
      "team-helper-2",
    ]);
    expect(resumed.members).toContainEqual(
      expect.objectContaining({ account: "team-helper-2", linked: true }),
    );
  });

  it("skips a retained wallet suffix after the highest-numbered member leaves", async () => {
    const opts = await fixture();
    const setup = await setupSwarm({ ...opts, roles: ["lead", "helper", "helper"] });
    expect(opts.store.has("team-helper-2")).toBe(true);
    setup.swarm.members = setup.swarm.members.filter(
      (member) => member.account !== "team-helper-2",
    );
    await writeSwarm(opts.home, setup.swarm);

    const added = await addSwarmMember({ ...opts, role: "helper" });

    expect(added.swarm.members.map((member) => member.account)).toEqual([
      "team-lead-1",
      "team-helper-1",
      "team-helper-3",
    ]);
    expect(added.swarm.members.at(-1)?.steps).toMatchObject({
      creating: true,
      created: true,
      capped: true,
      profiled: true,
      linked: true,
    });
    expect(opts.store.has("team-helper-2")).toBe(true);
  });

  it("resumes the same added member after approval fails and keeps its recorded overrides", async () => {
    const opts = await fixture();
    await setupSwarm(opts);
    opts.startDeviceLink.mockImplementation(async (args) =>
      start(args.label, args.label !== "team-helper-2"),
    );
    const first = await addSwarmMember({
      ...opts,
      role: "helper",
      targetUsd: "3.5",
      weight: 4,
      ceilingUsd: null,
      pollDeviceLink: async (args) => {
        if (args.start.clientId === "agent_team-helper-2") {
          throw new Error("simulated interrupted approval");
        }
        return await opts.pollDeviceLink!(args);
      },
    });
    await expect(first.completions.get("team-helper-2")).resolves.toMatchObject({
      linked: false,
      reason: "failed",
    });

    const resumed = await addSwarmMember({
      ...opts,
      role: "helper",
      targetUsd: "9",
      weight: 9,
      awaitApproval: false,
    });

    expect(resumed.next).toContainEqual(
      expect.objectContaining({ kind: "link", account: "team-helper-2" }),
    );
    expect(resumed.swarm.members.filter((member) => member.role === "helper")).toHaveLength(2);
    expect(resumed.swarm.members.at(-1)).toMatchObject({
      account: "team-helper-2",
      targetAtomic: "3500000",
      weight: 4,
      ceilingAtomic: null,
    });
    expect(opts.store.has("team-helper-3")).toBe(false);
    await expect(stat(join(opts.home, "swarms", ".team.adding"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports a safe error when linking cannot start", async () => {
    const opts = await fixture();
    opts.startDeviceLink.mockRejectedValue(
      new Error(`link failed with ${PHRASE} and private-device-code`),
    );

    let thrown: unknown;
    try {
      await setupSwarm(opts);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "invalid_swarm",
      message: "Account team-treasury could not be linked. Retry swarm setup.",
    });
    expect(String(thrown)).not.toContain(PHRASE);
    expect(String(thrown)).not.toContain("private-device-code");
  });

  it("redacts link completion failures from returned outcomes", async () => {
    const opts = await fixture();
    opts.startDeviceLink.mockImplementation(async (args) => start(args.label, false));
    const result = await setupSwarm({
      ...opts,
      pollDeviceLink: async () => {
        throw new Error(`poll failed with ${PHRASE} and private-device-code`);
      },
    });

    const outcome = await result.completions.get("team-treasury");
    expect(outcome).toEqual({
      linked: false,
      reason: "failed",
      message: "Account team-treasury could not be linked. Retry swarm setup.",
    });
    expect(JSON.stringify(outcome)).not.toContain(PHRASE);
    expect(JSON.stringify(outcome)).not.toContain("private-device-code");
  });

  it("does not reject a completed link when approval journaling cannot update the swarm", async () => {
    const opts = await fixture();
    opts.startDeviceLink.mockImplementation(async (args) => start(args.label, false));
    let approve!: (result: LinkResult) => void;
    const pending = new Promise<LinkResult>((resolve) => {
      approve = resolve;
    });
    const result = await setupSwarm({ ...opts, agents: 1, pollDeviceLink: async () => pending });
    await writeFile(swarmFilePath(opts.home, "team"), "{ invalid json", "utf8");
    approve({
      owner: OWNER,
      tokens: {
        accessToken: "private-approved-access",
        refreshToken: "private-approved-refresh",
        expiresAt: NOW.getTime() + 3_600_000,
        scopes: ["mcp:call", "router.use"],
      },
    });

    await expect(Promise.all(result.completions.values())).resolves.toEqual([
      { linked: true, owner: OWNER },
      { linked: true, owner: OWNER },
    ]);
  });

  it("requires strict schema fields and created addresses, skips identical writes, and deletes only the file", async () => {
    const opts = await fixture();
    const { swarm } = await setupSwarm(opts);
    expect(swarmFileSchema.safeParse({ ...swarm, token: "secret" }).success).toBe(false);
    expect(
      swarmFileSchema.safeParse({ ...swarm, policy: { ...swarm.policy, token: "secret" } }).success,
    ).toBe(false);
    expect(
      swarmFileSchema.safeParse({ ...swarm, treasury: { ...swarm.treasury, address: undefined } })
        .success,
    ).toBe(false);
    const legacy = structuredClone(swarm) as unknown as {
      treasury: { steps: { creating?: boolean } };
      members: Array<{ steps: { creating?: boolean } }>;
    };
    delete legacy.treasury.steps.creating;
    for (const member of legacy.members) delete member.steps.creating;
    expect(swarmFileSchema.parse(legacy).treasury.steps.creating).toBe(false);
    const before = await stat(swarmFilePath(opts.home, "team"));
    await writeSwarm(opts.home, swarm);
    expect((await stat(swarmFilePath(opts.home, "team"))).ino).toBe(before.ino);
    expect((await listSwarms(opts.home)).map((entry) => entry.name)).toEqual(["team"]);
    await deleteSwarmFile(opts.home, "team");
    expect(await listSwarms(opts.home)).toEqual([]);
    expect(opts.store.has("team-lead-1")).toBe(true);
    expect(await readAgentProfile(opts.home, "team-lead-1")).toBeDefined();
  });
});

describe("swarm status and ceiling parent", () => {
  it("accounts for sent movement legs, ignores other treasuries, and deduplicates open movements", async () => {
    const opts = await fixture();
    await setupSwarm(opts);
    await mkdir(join(opts.home, "movements"));
    const movement: Movement = {
      v: 2,
      id: "mv_swarm001",
      reason: "rebalance",
      from: "team-treasury",
      treasury: "team-treasury",
      network: BASE_MAINNET_CAIP2,
      createdAt: NOW.toISOString(),
      legs: [
        {
          from: "team-treasury",
          to: "team-lead-1",
          amountUsd: "2.00",
          purpose: "send",
          nonce: `0x${"11".repeat(32)}`,
          status: "sent",
        },
        {
          from: "team-lead-1",
          to: "team-treasury",
          amountUsd: "0.50",
          purpose: "sweep",
          nonce: `0x${"22".repeat(32)}`,
          status: "sent",
        },
        {
          from: "team-treasury",
          to: "team-helper-1",
          amountUsd: "9.00",
          purpose: "send",
          nonce: `0x${"33".repeat(32)}`,
          status: "unknown",
        },
        {
          from: "team-helper-1",
          to: "team-treasury",
          amountUsd: "1.00",
          purpose: "sweep",
          nonce: `0x${"44".repeat(32)}`,
          status: "planned",
        },
      ],
    };
    await writeFile(join(opts.home, "movements", `${movement.id}.json`), JSON.stringify(movement));
    await writeFile(
      join(opts.home, "movements", "mv_swarm002.json"),
      JSON.stringify({
        ...movement,
        id: "mv_swarm002",
        treasury: "unrelated",
        legs: movement.legs.slice(0, 1),
      }),
    );
    await writeFile(
      join(opts.home, "movements", "mv_swarm003.json"),
      JSON.stringify({
        ...movement,
        id: "mv_swarm003",
        reason: "send",
        from: "main",
        treasury: undefined,
        legs: [
          {
            ...movement.legs[2],
            from: "main",
            to: "team-treasury",
          },
        ],
      }),
    );
    const balances = vi.fn(async ({ account }: { account: string }) =>
      account === "team-lead-1" ? 250_000n : 3_000_000n,
    );
    const result = await swarmStatus({ ...opts, balanceReader: balances });
    expect(result.members[0]).toMatchObject({
      balanceUsd: "0.25",
      allocatedInUsd: "2.00",
      sweptOutUsd: "0.50",
      netUsd: "-1.25",
      targetUsd: "2.00",
      ceilingUsd: "10.00",
      linked: true,
      profile: true,
    });
    expect(result.members[1]).toMatchObject({
      allocatedInUsd: "0.00",
      sweptOutUsd: "0.00",
      netUsd: "3.00",
    });
    expect(result.openMovements.map((entry) => entry.id)).toEqual([movement.id, "mv_swarm003"]);
    expect(balances).toHaveBeenCalledWith(expect.objectContaining({ network: BASE_MAINNET_CAIP2 }));
  });

  it("resolves members to the treasury, leaving treasuries and other wallets with the owner", async () => {
    const opts = await fixture();
    const resolve = swarmParentResolver(opts.home);
    expect(await resolve("main")).toBeUndefined();
    const { swarm } = await setupSwarm(opts);
    expect(await resolve("team-lead-1")).toEqual({
      account: "team-treasury",
      address: swarm.treasury.address,
    });
    expect(await resolve("team-helper-1")).toEqual({
      account: "team-treasury",
      address: swarm.treasury.address,
    });
    expect(await resolve("team-treasury")).toBeUndefined();
    expect(await resolve("main")).toBeUndefined();
  });

  it("passes the swarm parent resolver at the Router ceiling-sweep call site", async () => {
    const source = await readFile(new URL("./router-client.ts", import.meta.url), "utf8");
    expect(source).toMatch(
      /sweepAboveCeiling\(\{[\s\S]*?resolveParent:\s*swarmParentResolver\(deps\.wallets\.home\)/u,
    );
  });
});
