import { listUnfinishedMovements, readMovement, type Movement } from "./movement.js";
import { readSwarm, type SwarmFile } from "./swarm.js";

/** Legacy member legs need no per-call classification: recorded intent guards every outgoing leg. */
export function isSwarmDissolutionMovement(movement: Movement, swarm: SwarmFile): boolean {
  return (
    movement.dissolution === swarm.name ||
    (movement.reason === "sweep" &&
      movement.treasury === swarm.treasury.account &&
      movement.legs.some(
        (leg) =>
          (leg.from === swarm.treasury.account && leg.to === "owner") ||
          (swarm.members.some((member) => member.account === leg.from) &&
            leg.to === swarm.treasury.account),
      ))
  );
}

/** Pre-marker member sweeps conservatively establish intent too, even without a swarm flag. */
export async function hasSwarmDissolveIntent(home: string, name: string): Promise<boolean> {
  const swarm = await readSwarm(home, name);
  if (swarm.dissolving === true) return true;
  for (const summary of await listUnfinishedMovements({ home })) {
    if (isSwarmDissolutionMovement(await readMovement(home, summary.id), swarm)) return true;
  }
  return false;
}

/** A remote member must not start until recorded dissolution has been completed. */
export async function assertSwarmNotDissolving(home: string, name: string): Promise<void> {
  if (await hasSwarmDissolveIntent(home, name)) {
    throw new Error(
      `Swarm ${name} has recorded dissolve intent or an unfinished dissolution movement. Resolve it with vapi swarm dissolve ${name} before starting Railway.`,
    );
  }
}
