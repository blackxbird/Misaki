import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { isMissingFile } from "./config.js";
import { swarmAccountNames, type SwarmFile } from "./swarm.js";

// Read only worker ownership and lifecycle metadata. Runtime adapters own the
// full records and may reconcile them before this final, fail-closed check.
const runSchema = z.object({
  v: z.literal(1),
  runId: z.string(),
  kind: z.enum(["local", "railway"]),
  member: z.object({ swarm: z.string().optional(), account: z.string() }),
  handle: z.object({ ref: z.string() }),
  state: z.enum(["starting", "running", "unknown", "finished", "failed", "stopped"]),
});
const sidecarSchema = z.object({
  v: z.literal(1),
  swarm: z.string().optional(),
  account: z.string().optional(),
  sandboxId: z.string().optional(),
});

/** No money may move while a remote worker may still hold a swarm member key. */
export async function assertSwarmWorkersStopped(home: string, swarm: SwarmFile): Promise<void> {
  const directory = join(home, "runs");
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  const accounts = new Set(swarmAccountNames(swarm));
  const belongs = (name: string | undefined, account: string | undefined): boolean =>
    name === swarm.name || accounts.has(account ?? "") || (!name && !account);
  const runs = new Map<string, z.infer<typeof runSchema>>();
  const blockers: string[] = [];
  for (const file of files.sort()) {
    const match = /^(run_[0-9a-f]{24})\.json$/u.exec(file);
    if (match === null) continue;
    const value = await readWorkerFile(join(directory, file));
    if (value === undefined) continue; // Removed by a concurrent stop.
    const parsed = runSchema.safeParse(value);
    if (!parsed.success || parsed.data.runId !== match[1]) {
      blockers.push(`unresolved run ${match[1]}`);
      continue;
    }
    const record = parsed.data;
    runs.set(record.runId, record);
    if (
      record.kind === "railway" &&
      belongs(record.member.swarm, record.member.account) &&
      (record.state === "starting" || record.state === "running" || record.state === "unknown")
    ) {
      blockers.push(
        `${record.member.account} (run ${record.runId}, sandbox ${record.handle.ref || "id unknown"})`,
      );
    }
  }
  for (const file of files) {
    const match = /^(run_[0-9a-f]{24})\.railway\.json$/u.exec(file);
    if (match === null) continue;
    const value = await readWorkerFile(join(directory, file));
    if (value === undefined) continue;
    const parsed = sidecarSchema.safeParse(value);
    if (!parsed.success) {
      blockers.push(`unresolved Railway sidecar ${match[1]}`);
      continue;
    }
    const sidecar = parsed.data;
    const run = runs.get(match[1]!);
    const owners = [sidecar, ...(run === undefined ? [] : [run.member])].filter(
      (owner) => owner.swarm || owner.account,
    );
    if (owners.length > 0 && !owners.some((owner) => belongs(owner.swarm, owner.account))) continue;
    blockers.push(
      `${sidecar.account || run?.member.account || "a member"} (run ${match[1]}, sandbox ${sidecar.sandboxId ?? "id unknown"})`,
    );
  }
  if (blockers.length > 0) {
    throw new Error(
      [
        `Swarm ${swarm.name} still has Railway sandboxes or unresolved workers that may hold a member key: ${blockers.join(", ")}.`,
        `Stop them first with: vapi swarm stop ${swarm.name} --all`,
        "Then dissolve again. Nothing was moved.",
      ].join("\n"),
    );
  }
}

async function readWorkerFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    // Corrupt or unreadable state cannot establish that the worker is gone.
    return null;
  }
}
