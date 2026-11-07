import { SWARM_NAME_PATTERN, walletNameSchema } from "@vapi-network/core";
import { z } from "zod";

import type { DetachedRunSummary } from "../agent/runtime.js";
import type {
  SwarmRunActionInput,
  SwarmRunActionResult,
  SwarmRunsInput,
  SwarmRunsResult,
} from "./context.js";
import { defineAction } from "./define.js";

export type { SwarmRunInput, SwarmRunResult } from "../agent/swarm-run.js";
export type {
  SwarmRunActionInput,
  SwarmRunActionResult,
  SwarmRunsInput,
  SwarmRunsResult,
} from "./context.js";

export const swarmRunInputSchema = z.object({
  name: z.string().regex(SWARM_NAME_PATTERN).describe("Name of the swarm to run."),
  task: z.string().min(1).max(4000).describe("Task for the swarm members to complete."),
  mode: z
    .enum(["lead", "each"])
    .optional()
    .describe("Run the lead with delegation, or run every eligible member independently."),
  lead: walletNameSchema.optional().describe("Lead member account to use in lead mode."),
  budgetUsd: z.string().optional().describe("Per-member USDC run budget in positive whole cents."),
  drawUsd: z
    .string()
    .optional()
    .describe("Shared USDC treasury draw limit in positive whole cents."),
  detach: z
    .boolean()
    .optional()
    .describe("Start the run in the configured background runtime and return immediately."),
});

export const attachedSwarmRunOutputSchema = z.object({
  runId: z.string(),
  mode: z.enum(["lead", "each"]),
  members: z.array(
    z.object({
      member: z.string(),
      role: z.string(),
      runId: z.string().nullable(),
      parentRunId: z.string().optional(),
      answer: z.string().nullable(),
      stoppedBecause: z.object({ reason: z.string(), detail: z.string().optional() }).nullable(),
      spentUsd: z.number().nullable(),
      budgetUsd: z.number(),
      status: z.enum(["finished", "stopped", "error", "skipped"]),
      reason: z.string().optional(),
    }),
  ),
  drawUsedUsd: z.number(),
  drawLimitUsd: z.number(),
  net: z.array(
    z.object({
      member: z.string(),
      balanceUsd: z.string(),
      allocatedInUsd: z.string(),
      sweptOutUsd: z.string(),
      netUsd: z.string(),
    }),
  ),
  netError: z.string().optional(),
});

export const detachedRunSummarySchema: z.ZodType<DetachedRunSummary> = z.object({
  member: z.string(),
  role: z.string().optional(),
  swarm: z.string().optional(),
  runId: z.string(),
  kind: z.enum(["local", "railway"]),
  mode: z.enum(["agent", "lead"]),
  state: z.enum([
    "starting",
    "running",
    "finished",
    "failed",
    "stopped",
    "unknown",
    "orphaned",
    "forgotten",
  ]),
  forgottenAt: z.iso.datetime().optional(),
  confirmedBy: z.literal("cli").optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  exitCode: z.number().int().optional(),
  parentRunId: z.string().optional(),
  detail: z.string().optional(),
});

export const detachedSwarmRunOutputSchema = z.object({
  detached: z.literal(true),
  runId: z.string(),
  mode: z.enum(["lead", "each"]),
  kind: z.enum(["local", "railway"]),
  runs: z.array(detachedRunSummarySchema),
  skipped: z.array(
    z.object({
      member: z.string(),
      role: z.string(),
      reason: z.string(),
    }),
  ),
});

export const swarmRunOutputSchema: z.ZodType<SwarmRunActionResult> = z.union([
  attachedSwarmRunOutputSchema,
  detachedSwarmRunOutputSchema,
]);

export const swarmRunsInputSchema = z.object({
  name: z.string().regex(SWARM_NAME_PATTERN).describe("Name of the swarm whose runs to list."),
});

export const swarmRunsOutputSchema: z.ZodType<SwarmRunsResult> = z.object({
  swarm: z.string(),
  runs: z.array(detachedRunSummarySchema),
});

export const swarmAllocateInputSchema = z.object({
  amountUsd: z.string().describe('USDC amount in whole cents, for example "0.50".'),
  reason: z.string().max(200).optional(),
  requestId: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe("Idempotency key. Retrying with the same key never moves treasury money twice."),
});

export const swarmAllocateOutputSchema = z.object({
  status: z.enum(["sent", "incomplete", "blocked", "resumed"]),
  movementId: z.string().nullable(),
  sentUsd: z.string(),
  blocked: z.array(
    z.object({
      to: z.string(),
      amountUsd: z.string(),
      reason: z.string(),
    }),
  ),
});

export const swarmDelegateInputSchema = z.object({
  member: walletNameSchema,
  task: z.string().min(1).max(4000),
  budgetUsd: z.string(),
  requestId: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe("Idempotency key. Retrying with the same key never moves treasury money twice."),
});

export const swarmDelegateOutputSchema = z.object({
  member: z.string(),
  runId: z.string().nullable(),
  answer: z.string().nullable(),
  stoppedBecause: z
    .object({
      reason: z.string(),
      detail: z.string().optional(),
    })
    .nullable(),
  spentUsd: z.number().nullable(),
  budgetUsd: z.number(),
});

export type SwarmAllocateResult = z.infer<typeof swarmAllocateOutputSchema>;
export type SwarmDelegateResult = z.infer<typeof swarmDelegateOutputSchema>;

export const swarmRun = defineAction<SwarmRunActionInput, SwarmRunActionResult>({
  name: "swarm.run",
  money: "spends",
  grant: "delegate",
  description:
    "Run a task across a swarm in lead or independent-member mode, with bounded member budgets and a shared treasury draw limit.",
  input: swarmRunInputSchema,
  output: swarmRunOutputSchema,
  async run(input, ctx) {
    if (ctx.swarmRun === undefined) {
      throw new Error("swarm.run is not available in this action context.");
    }
    return await ctx.swarmRun.run(input);
  },
});

export const swarmRuns = defineAction<SwarmRunsInput, SwarmRunsResult>({
  name: "swarm.runs",
  money: "none",
  grant: "read",
  description: "List background runs for a swarm with their latest known runtime status.",
  input: swarmRunsInputSchema,
  output: swarmRunsOutputSchema,
  async run(input, ctx) {
    if (ctx.swarmRuns === undefined) {
      throw new Error("swarm.runs is not available in this action context.");
    }
    return await ctx.swarmRuns.list(input);
  },
});

export const swarmAllocate = defineAction<
  z.infer<typeof swarmAllocateInputSchema>,
  SwarmAllocateResult
>({
  name: "swarm.allocate",
  money: "moves",
  grant: "allocate",
  description:
    "Request USDC from this run's swarm treasury for the current member, within the run draw limit and agent approval policy.",
  input: swarmAllocateInputSchema,
  output: swarmAllocateOutputSchema,
  async run() {
    throw new Error("swarm.allocate only works inside a swarm run.");
  },
});

export const swarmDelegate = defineAction<
  z.infer<typeof swarmDelegateInputSchema>,
  SwarmDelegateResult
>({
  name: "swarm.delegate",
  money: "moves",
  grant: "delegate",
  description:
    "Give another member of the current swarm a subtask and treasury-funded USDC budget, then return that member's run result.",
  input: swarmDelegateInputSchema,
  output: swarmDelegateOutputSchema,
  async run() {
    throw new Error("swarm.delegate only works inside a swarm run.");
  },
});

export const swarmAgentActions = [swarmRun, swarmAllocate, swarmDelegate, swarmRuns] as const;
