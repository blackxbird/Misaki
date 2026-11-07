import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

import { getDefaultConfig } from "./config.js";
import { memorySecretStore } from "./secret-store.js";
import { withCapitalLocks } from "./swarm-lock-context.js";
import { writeSwarm, type SwarmFile } from "./swarm.js";
import { executeTransfer, type TransferArgs, type TransferResult } from "./transfer.js";
import { WalletStore } from "./wallet-store.js";
import { BASE_MAINNET_CAIP2 } from "./x402-networks.js";

const MAIN_KEY = `0x${"12".repeat(32)}` as const;
const MEMBER_KEY = `0x${"34".repeat(32)}` as const;
const TREASURY_KEY = `0x${"56".repeat(32)}` as const;
const DESTINATION = "0x1111111111111111111111111111111111111111";
const NONCE = `0x${"78".repeat(32)}` as const;
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

const cases = [
  {
    name: "ordinary wallet beside an unrelated incomplete swarm",
    sender: "main",
    partial: true,
    worker: "active",
    intent: true,
    blocked: false,
  },
  {
    name: "known member in a partial swarm with an active worker and no intent",
    sender: "member",
    partial: true,
    worker: "active",
    blocked: true,
  },
  {
    name: "known member in a partial swarm with an unresolved worker and no intent",
    sender: "member",
    partial: true,
    worker: "unresolved",
    blocked: true,
  },
  {
    name: "known member with dissolve intent and no worker",
    sender: "member",
    intent: true,
    blocked: true,
  },
  {
    name: "addressless member resolved by its wallet key reference",
    sender: "member",
    partial: true,
    intent: true,
    blocked: true,
  },
  {
    name: "member resolved by address rather than its wallet name",
    sender: "member",
    reference: "journal-member",
    worker: "active",
    blocked: true,
  },
  {
    name: "ordinary same-key aliases planned before the outer lock",
    sender: "main",
    alias: true,
    partial: true,
    blocked: false,
  },
  {
    name: "same-key alias of an active swarm member",
    sender: "member",
    alias: true,
    partial: true,
    worker: "active",
    blocked: true,
  },
  {
    name: "every owning swarm checked when only the second is unsafe",
    sender: "member",
    secondOwner: true,
    blocked: true,
  },
  {
    name: "known idle member without dissolve intent",
    sender: "member",
    partial: true,
    blocked: false,
  },
] as const;

describe.each(["direct", "relay"] as const)(
  "%s guarded broadcasts use sender ownership",
  (mode) => {
    it.each(cases)("$name", async (input) => {
      const options: {
        sender: string;
        partial?: boolean;
        worker?: string;
        intent?: boolean;
        blocked: boolean;
        alias?: boolean;
        reference?: string;
        secondOwner?: boolean;
      } = input;
      const home = await mkdtemp(join(tmpdir(), "vapi-sender-ownership-"));
      homes.push(home);
      const secrets = memorySecretStore();
      const store = await WalletStore.open(home, { secrets, env: {} });
      await store.importKey("main", "", MAIN_KEY);
      await store.importKey("member", "", MEMBER_KEY);
      await store.importKey("treasury", "", TREASURY_KEY);
      const key = options.sender === "main" ? MAIN_KEY : MEMBER_KEY;
      const account = privateKeyToAccount(key);
      const selected = options.alias ? "alias" : options.sender;
      if (options.alias) await store.importKey("alias", "", key);
      const swarm: SwarmFile = {
        v: 1,
        name: "team",
        device: "test-device",
        network: BASE_MAINNET_CAIP2,
        createdAt: "2026-09-29T10:00:00.000Z",
        ...(options.intent ? { dissolving: true } : {}),
        treasury: {
          account: "treasury",
          address: privateKeyToAccount(TREASURY_KEY).address,
          steps: { creating: true, created: true, capped: true, linked: true },
        },
        members: [
          {
            account: options.reference ?? "member",
            ...(options.partial ? {} : { address: privateKeyToAccount(MEMBER_KEY).address }),
            role: "lead",
            weight: 1,
            targetAtomic: "1000000",
            ceilingAtomic: "10000000",
            steps: {
              creating: true,
              created: !options.partial,
              capped: false,
              profiled: false,
              linked: false,
            },
          },
        ],
        policy: {
          strategy: "targets",
          treasuryCaps: { perCallAtomic: "5000000", perDayAtomic: "10000000" },
        },
      };
      await writeSwarm(home, swarm);
      if (options.secondOwner) {
        await store.importKey("other-member", "", MEMBER_KEY);
        await store.importKey("other-treasury", "", `0x${"9a".repeat(32)}`);
        await writeSwarm(home, {
          ...swarm,
          name: "zulu",
          treasury: {
            ...swarm.treasury,
            account: "other-treasury",
            address: await store.readAddress("other-treasury"),
          },
          members: [{ ...swarm.members[0]!, account: "other-member" }],
        });
      }
      if (options.worker || options.secondOwner) {
        await mkdir(join(home, "runs"), { recursive: true });
        await writeFile(
          join(home, "runs", "run_0123456789abcdef01234567.railway.json"),
          options.worker === "unresolved"
            ? "{unresolved"
            : JSON.stringify({
                v: 1,
                swarm: options.secondOwner ? "zulu" : "team",
                sandboxId: "sbx_ownership",
              }),
        );
      }
      const broadcast = vi.fn(async () => {
        if (options.alias) {
          await expect(
            stat(join(home, "movements", `.${options.sender}.lock`)),
          ).resolves.toBeDefined();
          await expect(stat(join(home, "movements", ".alias.lock"))).resolves.toBeDefined();
        }
        return { network: BASE_MAINNET_CAIP2, amountAtomic: "1000000", transaction: "0xswept" };
      });
      const relay = vi.fn(async (args: TransferArgs): Promise<TransferResult> => {
        await broadcast();
        return {
          status: "sent",
          from: args.from,
          to: DESTINATION,
          toName: "owner",
          toKind: "owner",
          amountUsd: "1.00",
          amountAtomic: "1000000",
          network: BASE_MAINNET_CAIP2,
          txHash: null,
          nonce: NONCE,
          replayed: false,
        };
      });
      const operation = async () =>
        mode === "direct"
          ? await executeTransfer(
              {
                kind: "direct-sweep",
                home,
                account,
                config: getDefaultConfig(),
                network: BASE_MAINNET_CAIP2,
                destination: DESTINATION,
              },
              broadcast,
            )
          : await executeTransfer(
              {
                store,
                secrets,
                apiBase: "https://api.vapinetwork.ai",
                from: selected,
                to: "owner",
                amountUsd: 1,
                nonce: NONCE,
              },
              relay,
            );
      const result = options.alias
        ? withCapitalLocks(home, { accounts: [selected] }, operation)
        : operation();
      if (options.blocked) {
        await expect(result).rejects.toThrow(
          options.intent && !options.worker ? /dissolv/i : /worker|sandbox|stop/i,
        );
        expect(broadcast).not.toHaveBeenCalled();
      } else {
        await expect(result).resolves.toMatchObject({ amountAtomic: "1000000" });
        expect(broadcast).toHaveBeenCalledOnce();
      }
    });
  },
);
