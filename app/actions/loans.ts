"use server"

import { and, desc, eq, isNull, sql } from "drizzle-orm"
import type { z } from "zod"
import type { ActionResult } from "@/lib/action-result"
import { withRlsContext, type DatabaseTransaction } from "@/lib/db/client"
import { lockLibrary } from "@/lib/db/library"
import { copies, editions, loans } from "@/lib/db/schema"
import { databaseErrorCode, DomainError } from "@/lib/domain-errors"
import { getRequiredUserId } from "@/lib/server-user"
import { domainMutation } from "@/lib/server-action"
import { LOAN_LIMITS, type LoanOpenResult, type LoanReturnResult } from "@/lib/product/reading-loans"
import { deleteLoanSchema, isOwnLoanOpenRetry, isOwnLoanReturnRetry, LOAN_CHANGED, loanIdSchema, openLoanSchema, returnLoanSchema, updateLoanSchema, type LoanRecord } from "@/lib/loans"

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new DomainError("INVALID_INPUT", parsed.error.issues[0]?.message ?? "Revisa los datos del préstamo.")
  return parsed.data
}

async function result<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  return domainMutation(async () => {
    try { return await work() } catch (error) {
      if (error instanceof DomainError) throw error
      const code = databaseErrorCode(error)
      if (code === "BP001") throw new DomainError("LIMIT_EXCEEDED", `Se ha alcanzado el límite de préstamos (${LOAN_LIMITS.perCopy} por ejemplar y ${LOAN_LIMITS.perAccount} por cuenta).`)
      if (code === "23514" || code === "22023") throw new DomainError("INVALID_INPUT", "Revisa el alias y las fechas del préstamo: la devolución y el vencimiento no pueden ser anteriores a la salida.")
      if (code === "23505") throw new DomainError("CONFLICT", "Este ejemplar ya está prestado. Recarga los préstamos.")
      if (code === "23503") throw new DomainError("NOT_FOUND", "El ejemplar ya no está disponible.")
      throw error
    }
  })
}

async function requireCopy(tx: DatabaseTransaction, userId: string, copyId: string) {
  const [copy] = await tx.select({ id: copies.id }).from(copies).where(and(eq(copies.id, copyId), eq(copies.userId, userId))).limit(1)
  if (!copy) throw new DomainError("NOT_FOUND", "El ejemplar ya no está disponible.")
}

const fields = {
  id: loans.id, copyId: loans.copyId, title: editions.title, borrowerLabel: loans.borrowerLabel,
  loanedOn: loans.loanedOn, dueOn: loans.dueOn, returnedOn: loans.returnedOn, note: loans.note, version: loans.version,
}
type Row = Omit<LoanRecord, "dueOn" | "returnedOn" | "note"> & { dueOn: string | null; returnedOn: string | null; note: string | null }
function dto(row: Row): LoanRecord {
  const { dueOn, returnedOn, note, ...rest } = row
  return { ...rest, ...(dueOn !== null ? { dueOn } : {}), ...(returnedOn !== null ? { returnedOn } : {}), ...(note !== null ? { note } : {}) }
}

async function readLoan(tx: DatabaseTransaction, userId: string, id: string): Promise<LoanRecord> {
  const [row] = await tx.select(fields).from(loans).innerJoin(copies, and(eq(copies.id, loans.copyId), eq(copies.userId, loans.userId)))
    .innerJoin(editions, and(eq(editions.id, copies.editionId), eq(editions.userId, copies.userId)))
    .where(and(eq(loans.userId, userId), eq(loans.id, id))).limit(1)
  if (!row) throw new DomainError("NOT_FOUND", "El préstamo ya no está disponible.")
  return dto(row)
}

export async function getCopyLoansAction(copyId: unknown): Promise<ActionResult<LoanRecord[]>> {
  return result(async () => {
    const userId = await getRequiredUserId()
    const id = parse(loanIdSchema, copyId)
    return withRlsContext(userId, async (tx) => {
      await requireCopy(tx, userId, id)
      const rows = await tx.select(fields).from(loans).innerJoin(copies, and(eq(copies.id, loans.copyId), eq(copies.userId, loans.userId)))
        .innerJoin(editions, and(eq(editions.id, copies.editionId), eq(editions.userId, copies.userId)))
        .where(and(eq(loans.userId, userId), eq(loans.copyId, id))).orderBy(desc(loans.loanedOn), desc(loans.createdAt), desc(loans.id)).limit(LOAN_LIMITS.perCopy)
      return rows.map(dto)
    })
  })
}

export async function listActiveLoansAction(): Promise<ActionResult<LoanRecord[]>> {
  return result(async () => {
    const userId = await getRequiredUserId()
    return withRlsContext(userId, async (tx) => {
      const rows = await tx.select(fields).from(loans).innerJoin(copies, and(eq(copies.id, loans.copyId), eq(copies.userId, loans.userId)))
        .innerJoin(editions, and(eq(editions.id, copies.editionId), eq(editions.userId, copies.userId)))
        .where(and(eq(loans.userId, userId), isNull(loans.returnedOn))).orderBy(loans.dueOn, desc(loans.loanedOn), loans.id).limit(LOAN_LIMITS.perAccount)
      return rows.map(dto)
    })
  })
}

export async function getLoanCountAction(): Promise<ActionResult<number>> {
  return result(async () => {
    const userId = await getRequiredUserId()
    return withRlsContext(userId, async (tx) => {
      const [row] = await tx.select({ count: sql<number>`count(*)::int` }).from(loans).where(and(eq(loans.userId, userId), isNull(loans.returnedOn)))
      return row.count
    })
  })
}

export async function openLoanAction(input: unknown): Promise<ActionResult<LoanRecord>> {
  return result(async () => {
    const userId = await getRequiredUserId()
    const value = parse(openLoanSchema, input)
    return withRlsContext(userId, async (tx) => {
      await lockLibrary(tx)
      const [row] = await tx.execute<{ result: LoanOpenResult }>(sql`select biblib.loan_open(${value.copyId}::uuid, ${value.borrowerLabel}, ${value.loanedOn}::date, ${value.dueOn}::date, ${value.note}) as result`)
      const opened = row.result
      if (opened.status === "not_found") throw new DomainError("NOT_FOUND", "El ejemplar ya no está disponible.")
      if (opened.status === "active" && !isOwnLoanOpenRetry(opened, value)) throw new DomainError("CONFLICT", "Este ejemplar ya está prestado. Recarga los préstamos.")
      return readLoan(tx, userId, opened.loan_id)
    })
  })
}

export async function returnLoanAction(input: unknown): Promise<ActionResult<LoanRecord>> {
  return result(async () => {
    const userId = await getRequiredUserId()
    const value = parse(returnLoanSchema, input)
    return withRlsContext(userId, async (tx) => {
      await lockLibrary(tx)
      const [row] = await tx.execute<{ result: LoanReturnResult }>(sql`select biblib.loan_return(${value.id}::uuid, ${value.expectedVersion}::uuid, ${value.returnedOn}::date) as result`)
      const returned = row.result
      if (returned.status === "not_found") throw new DomainError("NOT_FOUND", "El préstamo ya no está disponible.")
      if (returned.status === "conflict" || (returned.status === "already_returned" && !isOwnLoanReturnRetry(returned, value.returnedOn))) throw new DomainError("CONFLICT", LOAN_CHANGED)
      return readLoan(tx, userId, value.id)
    })
  })
}

export async function updateLoanAction(input: unknown): Promise<ActionResult<LoanRecord>> {
  return result(async () => {
    const userId = await getRequiredUserId()
    const value = parse(updateLoanSchema, input)
    return withRlsContext(userId, async (tx) => {
      await lockLibrary(tx)
      const current = await readLoan(tx, userId, value.id)
      if (value.dueOn !== null && value.dueOn < current.loanedOn) throw new DomainError("INVALID_INPUT", "La fecha acordada no puede ser anterior a la salida.")
      const changed = await tx.update(loans).set({ borrowerLabel: value.borrowerLabel, dueOn: value.dueOn, note: value.note, updatedAt: new Date() })
        .where(and(eq(loans.userId, userId), eq(loans.id, value.id), eq(loans.version, value.expectedVersion))).returning({ id: loans.id })
      if (!changed.length) throw new DomainError("CONFLICT", LOAN_CHANGED)
      return readLoan(tx, userId, value.id)
    })
  })
}

export async function deleteLoanAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return result(async () => {
    const userId = await getRequiredUserId()
    const value = parse(deleteLoanSchema, input)
    return withRlsContext(userId, async (tx) => {
      await lockLibrary(tx)
      await readLoan(tx, userId, value.id)
      const removed = await tx.delete(loans).where(and(eq(loans.userId, userId), eq(loans.id, value.id), eq(loans.version, value.expectedVersion))).returning({ id: loans.id })
      if (!removed.length) throw new DomainError("CONFLICT", LOAN_CHANGED)
      return { id: value.id }
    })
  })
}
