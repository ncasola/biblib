import "server-only"
import { createHash } from "node:crypto"
import { and, asc, count, eq, sql } from "drizzle-orm"
import type { DatabaseTransaction } from "@/lib/db/client"
import { bookFields, books, libraryState, shelves } from "@/lib/db/schema"
import { ensureDefaultShelf, mapRowToBook } from "@/lib/db/library"
import { buildBackupSet, type BackupSet } from "@/lib/library-export"
import type { LibraryData } from "@/lib/types"

// Exportación por partes en el servidor (tarea T1 de U-QA-03, U-DAT-04). Ajustes ya no descarga la
// colección al abrirse: pide recuentos y, al exportar, el manifest; cada parte se genera aquí y se
// descarga como archivo, sin materializar las fichas en el navegador. Como la generación es
// determinista para una revisión y una fecha, cada descarga vuelve a generar su parte y comprueba
// que la colección no ha cambiado y que sus bytes coinciden con el hash del manifest.

export const sha256Bytes = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

export async function libraryCounts(tx: DatabaseTransaction, userId: string): Promise<{ books: number; shelves: number }> {
  const [row] = await tx.select({
    books: count(),
    shelves: sql<number>`(select count(*)::int from ${shelves} where ${shelves.userId} = ${userId})`,
    hasDefault: sql<boolean>`exists (select 1 from ${shelves} where ${shelves.userId} = ${userId} and ${shelves.isDefault})`,
  }).from(books).where(eq(books.userId, userId))
  if (row.hasDefault) return { books: row.books, shelves: row.shelves }
  await ensureDefaultShelf(tx, userId)
  const [recounted] = await tx.select({ shelves: count() }).from(shelves).where(eq(shelves.userId, userId))
  return { books: row.books, shelves: recounted.shelves }
}

async function revisionOf(tx: DatabaseTransaction, userId: string): Promise<string> {
  const [row] = await tx.select({ revision: libraryState.revision }).from(libraryState).where(eq(libraryState.userId, userId)).limit(1)
  return row?.revision ?? ""
}

/** Colección completa en el orden de la copia, leída entre dos lecturas iguales de la revisión. */
export async function readExportLibrary(tx: DatabaseTransaction, userId: string): Promise<{ revision: string; data: LibraryData } | null> {
  await ensureDefaultShelf(tx, userId)
  const before = await revisionOf(tx, userId)
  const userShelves = await tx.select().from(shelves).where(eq(shelves.userId, userId)).orderBy(asc(shelves.createdAt), asc(shelves.id))
  // U-DAT-06: el orden se calcula sobre IDs (estrecho) y las filas de la vista se leen sin ordenar en Postgres.
  const order = (await tx.select({ id: books.id }).from(books).where(eq(books.userId, userId)).orderBy(asc(books.title), asc(books.id))).map((row) => row.id)
  const position = new Map(order.map((id, index) => [id, index]))
  const bookRows = (await tx.select({ book: bookFields, shelfTitle: shelves.title }).from(books)
    .innerJoin(shelves, and(eq(books.shelfId, shelves.id), eq(shelves.userId, userId)))
    .where(eq(books.userId, userId))).sort((left, right) => (position.get(left.book.id) ?? 0) - (position.get(right.book.id) ?? 0))
  // Una escritura confirmada entre medias rota la revisión: la lectura no sería de un único estado.
  if (await revisionOf(tx, userId) !== before) return null
  const counts = new Map<string, number>()
  for (const { book } of bookRows) counts.set(book.shelfId, (counts.get(book.shelfId) ?? 0) + 1)
  return {
    revision: before,
    data: {
      shelves: userShelves.map((shelf) => ({ id: shelf.id, title: shelf.title, isDefault: shelf.isDefault, book_count: counts.get(shelf.id) ?? 0 })),
      books: bookRows.map(mapRowToBook),
    },
  }
}

export function exportSet(data: LibraryData, exportedAt: Date, exportSetId: string): BackupSet {
  return buildBackupSet(data, { exportedAt, exportSetId, sha256: sha256Bytes })
}
