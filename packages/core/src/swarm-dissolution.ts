import {
  listUnfinishedMovements,
  readMovement,
  type Movement,
  type MovementPlan,
} from "./movement.js";
import { listSwarms, readSwarm, type SwarmFile } from "./swarm.js";

function isDissolution(movement: Movement | MovementPlan, swarm: SwarmFile): boolean {
  return (
    movement.dissolution === swarm.name ||
    (movement.reason === "sweep" &&
      movement.treasury === swarm.treasury.account &&
      movement.legs.some(
        (leg) => (leg.from ?? movement.from) === swarm.treasury.account && leg.to === "owner",
      ))
  );
}

/** Also recognizes treasury-to-owner sweeps written before the lifecycle marker. */
export async function dissolutionSwarm(
  home: string,
  movement: Movement | MovementPlan,
): Promise<SwarmFile | undefined> {
  if (movement.dissolution !== undefined) return await readSwarm(home, movement.dissolution);
  if (
    movement.reason !== "sweep" ||
    movement.treasury === undefined ||
    !movement.legs.some((leg) => leg.to === "owner")
  )
    return undefined;
  return (await listSwarms(home)).find((swarm) => isDissolution(movement, swarm));
}

/** A remote member must not start until every pending dissolution leg is resolved. */
export async function assertSwarmNotDissolving(home: string, name: string): Promise<void> {
  const swarm = await readSwarm(home, name);
  for (const summary of await listUnfinishedMovements({ home })) {
    const movement = await readMovement(home, summary.id);
    if (isDissolution(movement, swarm)) {
      throw new Error(
        `Swarm ${name} has unfinished dissolution movement ${movement.id}. Resolve it with vapi swarm dissolve ${name} before starting Railway.`,
      );
    }
  }
}
