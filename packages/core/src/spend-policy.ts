import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import { getVapiPaths, isMissingFile, type SpendCaps } from "./config.js";
import { DEFAULT_WALLET_NAME, walletNameSchema, type WalletName } from "./wallet-name.js";

const ledgerSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  spentAtomic: z.string().regex(/^\d+$/),
});

const spendReservationSchema = z.object({
  id: z.string().min(1),
  amountAtomic: z.string().regex(/^\d+$/),
  kind: z.enum(["payment", "escrow-funding", "dispute-fee"]).optional(),
  taskKey: z.string().optional(),
});

/**
 * One day's spend for one wallet. A row without a wallet was written before
 * named wallets and belongs to `main`.
 */
const ledgerRowSchema = ledgerSchema.extend({
  wallet: walletNameSchema.optional(),
  reservations: z.array(spendReservationSchema).optional(),
});

/**
 * The file holds either a single legacy row, or rows for multiple wallets and
 * days. A single row for `main` keeps being written in the legacy shape.
 */
const ledgerFileSchema = z.union([
  z.object({ version: z.literal(1), rows: z.array(ledgerRowSchema) }),
  ledgerRowSchema,
]);

export type SpendLedger = z.infer<typeof ledgerSchema>;
export type SpendKind = "payment" | "escrow-funding" | "dispute-fee";
export type SpendLedgerRow = SpendLedger & { wallet: WalletName };
type StoredSpendLedgerRow = SpendLedgerRow & {
  reservations?: Array<z.infer<typeof spendReservationSchema>>;
};

export class SpendCapError extends Error {
  constructor(
    public readonly code:
      "per_call_cap_exceeded" | "per_task_cap_exceeded" | "per_day_cap_exceeded",
    message: string,
    public readonly details?: {
      amountAtomic: bigint;
      limitAtomic: bigint;
      spentAtomic?: bigint;
      wallet?: WalletName;
    },
  ) {
    super(message);
    this.name = "SpendCapError";
  }
}

export function utcDateKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Today's spend for one wallet. Other wallets and older days read as zero. */
export async function readSpendLedger(
  path = getVapiPaths().ledger,
  now = new Date(),
  wallet: WalletName = DEFAULT_WALLET_NAME,
): Promise<SpendLedger> {
  const rows = await readSpendLedgerRows(path, now);
  const row = rows.find((candidate) => candidate.wallet === wallet);
  return { date: utcDateKey(now), spentAtomic: row?.spentAtomic ?? "0" };
}

/** Read-only funding headroom; never creates directories, writes, or takes a lock. */
export async function escrowFundingDayRemainingAtomic(input: {
  caps: SpendCaps;
  ledgerPath: string;
  now: Date;
  wallet: WalletName;
  reservationId?: string;
}): Promise<bigint> {
  const perDayAtomic = parseAtomicCap(input.caps.perDayAtomic, "per-day");
  const rows = await readStoredSpendLedgerRows(input.ledgerPath, input.now);
  const row = rows.find((candidate) => candidate.wallet === input.wallet);
  const reserved = input.reservationId
    ? row?.reservations?.find((candidate) => candidate.id === input.reservationId)
    : undefined;
  const remaining =
    perDayAtomic - BigInt(row?.spentAtomic ?? "0") + BigInt(reserved?.amountAtomic ?? "0");
  return remaining > 0n ? remaining : 0n;
}

/** Read-only task spend across all stored days, excluding a reservation being retried. */
export async function taskReservedAtomic(input: {
  ledgerPath: string;
  wallet: WalletName;
  taskKey: string;
  now: Date;
  excludeReservationId?: string;
}): Promise<bigint> {
  const rows = await readStoredSpendLedgerRows(input.ledgerPath, input.now, true);
  return sumTaskReservations(rows, input.wallet, input.taskKey, input.excludeReservationId);
}

function sumTaskReservations(
  rows: readonly StoredSpendLedgerRow[],
  wallet: WalletName,
  taskKey: string,
  excludeReservationId?: string,
): bigint {
  let total = 0n;
  for (const row of rows) {
    if (row.wallet !== wallet) continue;
    for (const reservation of row.reservations ?? []) {
      if (reservation.taskKey === taskKey && reservation.id !== excludeReservationId)
        total += BigInt(reservation.amountAtomic);
    }
  }
  return total;
}

/** Today's spend of every wallet that has spent today. */
export async function readSpendLedgerRows(
  path = getVapiPaths().ledger,
  now = new Date(),
): Promise<SpendLedgerRow[]> {
  return (await readStoredSpendLedgerRows(path, now)).map(({ date, spentAtomic, wallet }) => ({
    date,
    spentAtomic,
    wallet,
  }));
}

async function readStoredSpendLedgerRows(
  path: string,
  now: Date,
  allDays = false,
): Promise<StoredSpendLedgerRow[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  const parsed = ledgerFileSchema.parse(JSON.parse(raw));
  const rows = "rows" in parsed ? parsed.rows : [parsed];
  const today = utcDateKey(now);
  return rows
    .filter((row) => allDays || row.date === today)
    .map((row) => ({
      date: row.date,
      spentAtomic: row.spentAtomic,
      wallet: row.wallet ?? DEFAULT_WALLET_NAME,
      ...(row.reservations === undefined ? {} : { reservations: row.reservations }),
    }));
}

/**
 * Reserves one payment or escrow funding against the caps of one wallet.
 * Per-day totals are kept per wallet, so an agent wallet cannot spend the
 * owner's daily allowance.
 * Task-linked calls without a reservation id return a generated id for rollback.
 */
export async function reserveSpend(
  amountAtomic: bigint,
  caps: SpendCaps,
  options?: {
    ledgerPath?: string;
    now?: Date;
    wallet?: WalletName;
    reservationId?: string;
    kind?: SpendKind;
    taskKey?: string;
    maxPerTaskAtomic?: bigint;
    reuseExistingEscrowReservation?: boolean;
    resumeEscrowReservation?: {
      id: string;
      wallet: WalletName;
      amountAtomic: string;
      date: string;
      exposed?: boolean;
      invalidated?: boolean;
    };
  },
): Promise<SpendLedger & { reservationReused?: boolean; reservationId?: string }> {
  if (amountAtomic < 0n) {
    throw new Error("Spend amount cannot be negative.");
  }

  const kind = options?.kind ?? "payment";
  let perDayAtomic: bigint;
  if (kind === "escrow-funding" || kind === "dispute-fee") {
    const maxPerTaskAtomic = options?.maxPerTaskAtomic;
    if (maxPerTaskAtomic === undefined || maxPerTaskAtomic < 0n) {
      throw new Error("Escrow funding requires a non-negative per-task cap.");
    }
    if (amountAtomic > maxPerTaskAtomic) {
      throw new SpendCapError(
        "per_task_cap_exceeded",
        `Escrow funding ${amountAtomic} atomic USDC exceeds the per-task cap ${maxPerTaskAtomic}. Refusing to sign.`,
      );
    }
    perDayAtomic = parseAtomicCap(caps.perDayAtomic, "per-day");
  } else {
    const perCallAtomic = parseAtomicCap(caps.perCallAtomic, "per-call");
    perDayAtomic = parseAtomicCap(caps.perDayAtomic, "per-day");
    if (amountAtomic > perCallAtomic) {
      throw new SpendCapError(
        "per_call_cap_exceeded",
        `Payment quote ${amountAtomic} atomic USDC exceeds the per-call cap ${perCallAtomic}. Refusing to sign.`,
        { amountAtomic, limitAtomic: perCallAtomic, wallet: options?.wallet },
      );
    }
  }

  const ledgerPath = options?.ledgerPath ?? getVapiPaths().ledger;
  const now = options?.now ?? new Date();
  const wallet = options?.wallet ?? DEFAULT_WALLET_NAME;
  return await withLedgerLock(ledgerPath, async () => {
    const rows = await readStoredSpendLedgerRows(ledgerPath, now, true);
    const today = utcDateKey(now);
    const current = rows.find((row) => row.wallet === wallet && row.date === today);
    if ((kind === "escrow-funding" || kind === "dispute-fee") && options?.taskKey !== undefined) {
      const taskTotal =
        sumTaskReservations(
          rows,
          wallet,
          options.taskKey,
          options.reuseExistingEscrowReservation || options.resumeEscrowReservation
            ? options.reservationId
            : undefined,
        ) + amountAtomic;
      if (taskTotal > options.maxPerTaskAtomic!)
        throw new SpendCapError(
          "per_task_cap_exceeded",
          `New spend ${amountAtomic} atomic USDC would raise the running total for task ${options.taskKey} and wallet ${wallet} to ${taskTotal}, above the per-task cap ${options.maxPerTaskAtomic}. Refusing to sign.`,
        );
    }
    if (options?.reservationId !== undefined) {
      const existing = current?.reservations?.find(
        (reservation) => reservation.id === options.reservationId,
      );
      if (existing && options.reuseExistingEscrowReservation) {
        if (
          (kind !== "escrow-funding" && kind !== "dispute-fee") ||
          existing.kind !== kind ||
          existing.amountAtomic !== amountAtomic.toString() ||
          (existing.taskKey !== undefined && existing.taskKey !== options.taskKey)
        )
          throw new Error(
            `Spend reservation ${options.reservationId} does not match this funding.`,
          );
        if (existing.taskKey === undefined && options.taskKey !== undefined) {
          existing.taskKey = options.taskKey;
          await writeLedgerAtomically(ledgerPath, rows);
        }
        return {
          date: current!.date,
          spentAtomic: current!.spentAtomic,
          reservationReused: true,
        };
      }
      if (existing) {
        throw new Error(`Spend reservation ${options.reservationId} already exists.`);
      }
      if (options.resumeEscrowReservation) {
        const resumed = options.resumeEscrowReservation;
        const historical = rows.find((row) => row.wallet === wallet && row.date === resumed.date);
        const stored = historical?.reservations?.find(
          (reservation) => reservation.id === resumed.id,
        );
        if (
          (kind !== "escrow-funding" && kind !== "dispute-fee") ||
          resumed.id !== options.reservationId ||
          resumed.wallet !== wallet ||
          resumed.amountAtomic !== amountAtomic.toString() ||
          resumed.date >= utcDateKey(now) ||
          resumed.exposed !== true ||
          resumed.invalidated === true ||
          (stored !== undefined &&
            (stored.kind !== kind ||
              stored.amountAtomic !== amountAtomic.toString() ||
              (stored.taskKey !== undefined && stored.taskKey !== options.taskKey)))
        )
          throw new Error(
            `Spend reservation ${options.reservationId} does not match this funding.`,
          );
        if (stored?.taskKey === undefined && options.taskKey !== undefined) {
          if (stored) stored.taskKey = options.taskKey;
          else {
            const reservation = {
              id: resumed.id,
              amountAtomic: resumed.amountAtomic,
              kind,
              taskKey: options.taskKey,
            };
            if (historical)
              historical.reservations = [...(historical.reservations ?? []), reservation];
            else
              rows.push({
                date: resumed.date,
                spentAtomic: resumed.amountAtomic,
                wallet,
                reservations: [reservation],
              });
          }
          await writeLedgerAtomically(ledgerPath, rows);
        }
        return {
          date: resumed.date,
          spentAtomic: current?.spentAtomic ?? "0",
          reservationReused: true,
        };
      }
    }
    const spentAtomic = current?.spentAtomic ?? "0";
    const nextSpent = BigInt(spentAtomic) + amountAtomic;
    if (nextSpent > perDayAtomic) {
      throw new SpendCapError(
        "per_day_cap_exceeded",
        `${kind === "escrow-funding" ? "Escrow funding" : "Payment quote"} ${amountAtomic} atomic USDC would raise today's spend to ${nextSpent} for wallet ${wallet}, above the per-day cap ${perDayAtomic}. Refusing to sign.`,
        { amountAtomic, limitAtomic: perDayAtomic, spentAtomic: BigInt(spentAtomic), wallet },
      );
    }
    const reservationId =
      options?.reservationId ??
      (options?.taskKey === undefined ? undefined : randomBytes(16).toString("hex"));
    const nextRow: StoredSpendLedgerRow = {
      date: utcDateKey(now),
      spentAtomic: nextSpent.toString(),
      wallet,
      ...((current?.reservations?.length ?? 0) === 0 && reservationId === undefined
        ? {}
        : {
            reservations: [
              ...(current?.reservations ?? []),
              ...(reservationId === undefined
                ? []
                : [
                    {
                      id: reservationId,
                      amountAtomic: amountAtomic.toString(),
                      ...(kind !== "payment" ? { kind } : {}),
                      ...(options?.taskKey === undefined ? {} : { taskKey: options.taskKey }),
                    },
                  ]),
            ],
          }),
    };
    const otherRows = rows
      .filter((row) => row.wallet !== wallet || row.date !== today)
      .map((row) => {
        if (
          row.wallet !== wallet ||
          !options?.reuseExistingEscrowReservation ||
          options.reservationId === undefined
        )
          return row;
        const previous = row.reservations?.find(
          (reservation) => reservation.id === options.reservationId,
        );
        if (!previous) return row;
        if (
          (kind !== "escrow-funding" && kind !== "dispute-fee") ||
          previous.kind !== kind ||
          previous.amountAtomic !== amountAtomic.toString() ||
          (previous.taskKey !== undefined && previous.taskKey !== options.taskKey)
        )
          throw new Error(
            `Spend reservation ${options.reservationId} does not match this funding.`,
          );
        // An unexposed prior-day reservation is booked today before a new
        // signature. Move its record so the task total counts the intent once.
        return {
          ...row,
          reservations: row.reservations!.filter(
            (reservation) => reservation.id !== options.reservationId,
          ),
        };
      });
    const nextRows = [...otherRows, nextRow].sort(
      (a, b) => a.wallet.localeCompare(b.wallet) || a.date.localeCompare(b.date),
    );
    await writeLedgerAtomically(ledgerPath, nextRows);
    return {
      date: nextRow.date,
      spentAtomic: nextRow.spentAtomic,
      ...(options?.reservationId === undefined && reservationId !== undefined
        ? { reservationId }
        : {}),
    };
  });
}

/**
 * Releases an identified reservation on its original UTC day, including task
 * accounting. Unidentified releases only affect today's daily budget.
 */
export async function releaseSpend(
  amountAtomic: bigint,
  options: {
    reservedOn: string;
    ledgerPath?: string;
    now?: Date;
    wallet?: WalletName;
    reservationId?: string;
  },
): Promise<SpendLedger> {
  if (amountAtomic < 0n) {
    throw new Error("Spend amount cannot be negative.");
  }

  const ledgerPath = options.ledgerPath ?? getVapiPaths().ledger;
  const now = options.now ?? new Date();
  const wallet = options.wallet ?? DEFAULT_WALLET_NAME;
  return await withLedgerLock(ledgerPath, async () => {
    const today = utcDateKey(now);
    const rows = await readStoredSpendLedgerRows(ledgerPath, now, true);
    const current = rows.find((row) => row.wallet === wallet && row.date === today);
    if (options.reservedOn !== today && options.reservationId === undefined) {
      return { date: today, spentAtomic: current?.spentAtomic ?? "0" };
    }
    const reserved = rows.find((row) => row.wallet === wallet && row.date === options.reservedOn);

    const reservation =
      options.reservationId === undefined
        ? undefined
        : reserved?.reservations?.find((candidate) => candidate.id === options.reservationId);
    if (options.reservationId !== undefined && reservation === undefined) {
      return { date: today, spentAtomic: current?.spentAtomic ?? "0" };
    }
    if (reservation !== undefined && reservation.amountAtomic !== amountAtomic.toString()) {
      throw new Error(`Spend reservation ${options.reservationId} has a different amount.`);
    }

    const spentAtomic = BigInt(reserved?.spentAtomic ?? "0");
    const releasedAmount =
      reservation === undefined ? amountAtomic : BigInt(reservation.amountAtomic);
    const nextSpent = spentAtomic > releasedAmount ? spentAtomic - releasedAmount : 0n;
    const remainingReservations = reserved?.reservations?.filter(
      (candidate) => candidate.id !== options.reservationId,
    );
    const nextRow: StoredSpendLedgerRow = {
      date: options.reservedOn,
      spentAtomic: nextSpent.toString(),
      wallet,
      ...(remainingReservations === undefined || remainingReservations.length === 0
        ? {}
        : { reservations: remainingReservations }),
    };
    const nextRows = [
      ...rows.filter((row) => row.wallet !== wallet || row.date !== options.reservedOn),
      nextRow,
    ].sort((a, b) => a.wallet.localeCompare(b.wallet) || a.date.localeCompare(b.date));
    await writeLedgerAtomically(ledgerPath, nextRows);
    return {
      date: today,
      spentAtomic:
        options.reservedOn === today ? nextRow.spentAtomic : (current?.spentAtomic ?? "0"),
    };
  });
}

function parseAtomicCap(value: string, label: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid ${label} spend cap ${JSON.stringify(value)}.`);
  }
  return BigInt(value);
}

async function writeLedgerAtomically(path: string, rows: readonly StoredSpendLedgerRow[]) {
  const ledger =
    rows.length === 1 && rows[0]!.wallet === DEFAULT_WALLET_NAME
      ? {
          date: rows[0]!.date,
          spentAtomic: rows[0]!.spentAtomic,
          ...(rows[0]!.reservations === undefined ? {} : { reservations: rows[0]!.reservations }),
        }
      : { version: 1 as const, rows };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(ledger, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporaryPath, path);
}

async function withLedgerLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + 2_000;
  let handle: FileHandle | undefined;

  while (!handle) {
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
      await removeStaleLock(lockPath);
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for the spend ledger lock.");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  try {
    return await operation();
  } finally {
    await handle.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

async function removeStaleLock(path: string) {
  try {
    const metadata = await stat(path);
    if (Date.now() - metadata.mtimeMs > 30_000) {
      await unlink(path);
    }
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
}
