"use server"

import { and, eq, inArray, sql, asc, desc, count } from "drizzle-orm"
import { z } from "zod"
import { withRlsContext } from "@/lib/db/client"
import { bookFields, books, shelves } from "@/lib/db/schema"
import { ensureDefaultShelf, mapRowToBook } from "@/lib/db/library"
import { getRequiredUserId } from "@/lib/server-user"
import { DomainError } from "@/lib/domain-errors"
import { normalizeIsbn } from "@/lib/isbn"

// La lectura completa de la colección (getLibraryDataAction) se retiró con U-DAT-04 (tarea T1):
// Ajustes usa recuentos y la copia por partes se genera en el servidor (lib/library-export-server.ts).

export async function getLibrarySummaryAction() {
  const userId = await getRequiredUserId()
  return withRlsContext(userId, async (tx) => {
    // Recuentos y comprobación de la predeterminada en una sola consulta; ensureDefaultShelf solo si falta (U-FIX-02).
    const [{ hasDefaultShelf, shelfCount, ...totals }] = await tx.select({
      totalBooks: count(),
      read: sql<number>`count(*) filter (where ${books.status} = 'read')::int`,
      reading: sql<number>`count(*) filter (where ${books.status} = 'reading')::int`,
      toRead: sql<number>`count(*) filter (where ${books.status} = 'to-read')::int`,
      unread: sql<number>`count(*) filter (where ${books.status} = 'unread')::int`,
      shelfCount: sql<number>`(select count(*)::int from ${shelves} where ${shelves.userId} = ${userId})`,
      hasDefaultShelf: sql<boolean>`exists (select 1 from ${shelves} where ${shelves.userId} = ${userId} and ${shelves.isDefault})`,
    }).from(books).where(eq(books.userId, userId))
    let shelfTotals = { totalShelves: shelfCount }
    if (!hasDefaultShelf) {
      await ensureDefaultShelf(tx, userId)
      const [recounted] = await tx.select({ totalShelves: count() }).from(shelves).where(eq(shelves.userId, userId))
      shelfTotals = recounted
    }
    const recent = await tx.select({ book: bookFields, shelfTitle: shelves.title }).from(books)
      .innerJoin(shelves, and(eq(books.shelfId, shelves.id), eq(shelves.userId, userId)))
      .where(eq(books.userId, userId)).orderBy(desc(books.createdAt), desc(books.id)).limit(5)
    const reading = await tx.select({ book: bookFields, shelfTitle: shelves.title }).from(books)
      .innerJoin(shelves, and(eq(books.shelfId, shelves.id), eq(shelves.userId, userId)))
      .where(and(eq(books.userId, userId), eq(books.status, "reading"))).orderBy(desc(books.updatedAt), asc(books.id)).limit(5)
    return { ...totals, totalShelves: shelfTotals.totalShelves, recent: recent.map(mapRowToBook), currentlyReading: reading.map(mapRowToBook) }
  })
}

const listSchema = z.object({
  q: z.string().max(500).default(""), status: z.enum(["all", "read", "reading", "unread", "to-read"]).default("all"),
  shelf: z.union([z.literal("all"), z.uuid()]).default("all"),
  series: z.union([z.literal("all"), z.uuid()]).default("all"),
  sort: z.enum(["title", "-title", "author", "-author", "pages", "-pages", "date", "-date", "status", "-status"]).default("title"),
  page: z.number().int().min(1).max(100_000).default(1), pageSize: z.number().int().min(1).max(100).default(10),
})

export async function listBooksAction(input: unknown = {}) {
  const userId = await getRequiredUserId()
  const parsed = listSchema.safeParse(input)
  if (!parsed.success) throw new DomainError("INVALID_INPUT", "Los filtros de búsqueda no son válidos.")
  const filter = parsed.data
  const searchValue = normalizeIsbn(filter.q) ?? (/^[0-9Xx\s-]+$/.test(filter.q) ? filter.q.replace(/[\s-]/g, "") : filter.q)
  const query = searchValue.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim()
  const escaped = `%${query.replace(/[\\%_]/g, "\\$&")}%`
  const conditions = and(eq(books.userId, userId), filter.status !== "all" ? eq(books.status, filter.status) : undefined,
    filter.shelf !== "all" ? eq(books.shelfId, filter.shelf) : undefined,
    // U-PRO-05: la serie es de la edición; el dueño sale de la sesión y la FK compuesta impide vínculos ajenos.
    filter.series !== "all" ? sql`exists (select 1 from biblib.series_editions se where se.user_id = ${userId} and se.series_id = ${filter.series} and se.edition_id = ${books.editionId})` : undefined,
    // Tarea T5 (U-DAT-06): el texto de búsqueda de la edición se calcula al escribir (columna generada de 0010); el
    // identificador legacy es del ejemplar y se busca aparte.
    query ? sql`(${books.searchText} like ${escaped} or lower(coalesce(${books.legacyIdentifier}, '')) like ${escaped})` : undefined)
  return withRlsContext(userId, async (tx) => {
    const [{ total }] = await tx.select({ total: count() }).from(books).where(conditions)
    const page = Math.min(filter.page, Math.max(1, Math.ceil(total / filter.pageSize)))
    const key = filter.sort.replace(/^-/, "")
    const orderColumn = key === "author" ? sql`${books.authors}->0->>'name'` : key === "pages" ? books.numberOfPages
      : key === "date" ? sql`coalesce(substring(${books.publishDate} from '[0-9]{4}'), '0000')` : key === "status" ? books.status : books.title
    // U-DAT-06: primero se ordena y pagina solo el ID del ejemplar (sin calcular las columnas de la vista para toda
    // la colección) y después se leen las filas de la página, como mucho 100, en ese orden.
    const pageIds = (await tx.select({ id: books.id }).from(books).where(conditions)
      .orderBy(filter.sort.startsWith("-") ? desc(orderColumn) : asc(orderColumn), asc(books.id))
      .limit(filter.pageSize).offset((page - 1) * filter.pageSize)).map((row) => row.id)
    const rows = pageIds.length ? await tx.select({ book: bookFields, shelfTitle: shelves.title }).from(books)
      .innerJoin(shelves, and(eq(books.shelfId, shelves.id), eq(shelves.userId, userId)))
      .where(and(eq(books.userId, userId), inArray(books.id, pageIds))) : []
    const position = new Map(pageIds.map((id, index) => [id, index]))
    const ordered = [...rows].sort((left, right) => position.get(left.book.id)! - position.get(right.book.id)!)
    return { books: ordered.map(mapRowToBook), total, page, pageSize: filter.pageSize }
  })
}
