"use server"

import { and, asc, eq, gt, inArray, sql } from "drizzle-orm"
import { mutationResult } from "@/lib/action-result"
import { DEFAULT_BOOK_COVER } from "@/lib/book-covers"
import { parseUuid } from "@/lib/book-validation"
import { COVER_RECOVERY_BATCH_SIZE, decideCoverRecovery, type CoverRecoveryResult, type CoverRecoverySnapshot } from "@/lib/cover-recovery"
import { withRlsContext } from "@/lib/db/client"
import { lockLibrary, mapRowToBook } from "@/lib/db/library"
import { books } from "@/lib/db/schema"
import { translateDatabaseError } from "@/lib/domain-errors"
import { normalizeIsbn } from "@/lib/isbn"
import { enrichImportedBookCovers } from "@/lib/library-import"
import { getRequiredUserId } from "@/lib/server-user"

function snapshot(row: typeof books.$inferSelect): CoverRecoverySnapshot {
  return { id: row.id, isbn: row.isbn, version: row.version, cover: { small: row.coverSmall, medium: row.coverMedium, large: row.coverLarge } }
}

async function recoverMissingCovers(cursor: unknown): Promise<CoverRecoveryResult> {
  const userId = await getRequiredUserId()
  const after = cursor === null || cursor === undefined ? null : parseUuid(cursor)
  // Solo marcadores locales conocidos: una URL real en cualquier tamaño excluye la ficha.
  const missing = and(...[books.coverSmall, books.coverMedium, books.coverLarge].map((column) =>
    sql`split_part(btrim(${column}), '?', 1) in ('', ${DEFAULT_BOOK_COVER}, '/placeholder.svg')`))
  const rows = await withRlsContext(userId, (tx) => tx.select().from(books)
    .where(and(eq(books.userId, userId), missing, after ? gt(books.id, after) : undefined))
    .orderBy(asc(books.id)).limit(COVER_RECOVERY_BATCH_SIZE + 1))
  const batch = rows.slice(0, COVER_RECOVERY_BATCH_SIZE)
  const result: CoverRecoveryResult = {
    nextCursor: rows.length > COVER_RECOVERY_BATCH_SIZE ? batch.at(-1)!.id : null,
    scanned: batch.length, recovered: 0, unavailable: 0, skipped: 0,
  }
  if (batch.length === 0) return result

  const candidates = batch.filter((row) => normalizeIsbn(row.isbn)).map((row) => mapRowToBook({ book: row, shelfTitle: "" }))
  // La red queda fuera de la transacción y del bloqueo de escrituras.
  const found = new Map((await enrichImportedBookCovers(candidates)).map((book) => [book.id, book.cover]))
  try {
    return await withRlsContext(userId, async (tx) => {
      await lockLibrary(tx, userId)
      const currentRows = await tx.select().from(books).where(and(eq(books.userId, userId), inArray(books.id, batch.map((row) => row.id))))
      const current = new Map(currentRows.map((row) => [row.id, snapshot(row)]))
      for (const previous of batch.map(snapshot)) {
        const decision = decideCoverRecovery(previous, current.get(previous.id), found.get(previous.id))
        if (decision.outcome !== "recovered") { result[decision.outcome]++; continue }
        const updated = await tx.update(books).set({ coverSmall: decision.cover.small, coverMedium: decision.cover.medium,
          coverLarge: decision.cover.large, updatedAt: new Date() })
          .where(and(eq(books.userId, userId), eq(books.id, previous.id), eq(books.version, previous.version),
            eq(books.isbn, previous.isbn), eq(books.coverSmall, previous.cover.small),
            eq(books.coverMedium, previous.cover.medium), eq(books.coverLarge, previous.cover.large)))
          .returning({ id: books.id })
        if (updated.length) result.recovered++
        else result.skipped++
      }
      return result
    })
  } catch (error) { translateDatabaseError(error) }
}

export async function recoverMissingCoversAction(cursor: unknown = null) {
  return mutationResult(() => recoverMissingCovers(cursor))
}
