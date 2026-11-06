import { executeTransfer } from "./transfer.js";
import type { SweepBackArgs, SweepResult } from "./sweep-support.js";

export {
  calculateSweepAmount,
  getArcGasHeadroomAtomic,
  readUsdcBalance,
  ERC20_ABI,
  SweepGasError,
  type SweepBackArgs,
  type SweepResult,
} from "./sweep-support.js";

export async function sweepBack(args: SweepBackArgs): Promise<SweepResult> {
  return await executeTransfer({ ...args, kind: "direct-sweep" });
}
