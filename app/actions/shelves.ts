"use server"

import { and, eq, sql, asc } from "drizzle-orm"
import { withRlsContext } from "@/lib/db/client"
import { books, shelves } from "@/lib/db/schema"
import { ensureDefaultShelf, lockLibrary } from "@/lib/db/library"
import { getRequiredUserId } from "@/lib/server-user"
import { parseShelfTitle, parseUuid } from "@/lib/book-validation"
import { DomainError, translateDatabaseError } from "@/lib/domain-errors"
import type { Shelf } from "@/lib/types"
import { mutationResult } from "@/lib/action-result"

export async function getShelvesAction(): Promise<Shelf[]> {
  const userId = await getRequiredUserId()
  return withRlsContext(userId, async (tx) => {
    await ensureDefaultShelf(tx, userId)
    return tx.select({ id: shelves.id, title: shelves.title, isDefault: shelves.isDefault,
      book_count: sql<number>`count(${books.id})::int` }).from(shelves)
      .leftJoin(books, and(eq(books.shelfId, shelves.id), eq(books.userId, userId)))
      .where(eq(shelves.userId, userId)).groupBy(shelves.id).orderBy(asc(shelves.createdAt), asc(shelves.id))
  })
}

async function createShelf(input: string): Promise<void> {
  const userId = await getRequiredUserId()
  const title = parseShelfTitle(input)
  try {
    await withRlsContext(userId, async (tx) => {
      await lockLibrary(tx, userId)
      const [existing] = await tx.select({ id: shelves.id }).from(shelves)
        .where(and(eq(shelves.userId, userId), sql`lower(${shelves.title}) = lower(${title})`)).limit(1)
      if (existing) throw new DomainError("CONFLICT", "Ya existe una estantería con ese nombre.")
      await tx.insert(shelves).values({ userId, title, isDefault: false })
    })
  } catch (error) { translateDatabaseError(error) }
}

async function renameShelf(shelfId: string, input: string): Promise<void> {
  const userId = await getRequiredUserId()
  const id = parseUuid(shelfId)
  const title = parseShelfTitle(input)
  try {
    await withRlsContext(userId, async (tx) => {
      await lockLibrary(tx, userId)
      const duplicate = await tx.select({ id: shelves.id }).from(shelves)
        .where(and(eq(shelves.userId, userId), sql`lower(${shelves.title}) = lower(${title})`, sql`${shelves.id} <> ${id}`)).limit(1)
      if (duplicate.length) throw new DomainError("CONFLICT", "Ya existe una estantería con ese nombre.")
      const changed = await tx.update(shelves).set({ title, updatedAt: new Date() })
        .where(and(eq(shelves.id, id), eq(shelves.userId, userId), eq(shelves.isDefault, false))).returning({ id: shelves.id })
      if (!changed.length) throw new DomainError("NOT_FOUND", "La estantería no está disponible o es la predeterminada protegida.")
    })
  } catch (error) { translateDatabaseError(error) }
}

async function deleteShelf(shelfId: string): Promise<void> {
  const userId = await getRequiredUserId()
  const id = parseUuid(shelfId)
  try {
    await withRlsContext(userId, async (tx) => {
      await lockLibrary(tx, userId)
      const defaultId = await ensureDefaultShelf(tx, userId)
      if (id === defaultId) throw new DomainError("CONFLICT", "No se puede eliminar la estantería predeterminada.")
      await tx.update(books).set({ shelfId: defaultId, updatedAt: new Date() })
        .where(and(eq(books.userId, userId), eq(books.shelfId, id)))
      const removed = await tx.delete(shelves).where(and(eq(shelves.id, id), eq(shelves.userId, userId), eq(shelves.isDefault, false))).returning({ id: shelves.id })
      if (!removed.length) throw new DomainError("NOT_FOUND", "La estantería ya no está disponible.")
    })
  } catch (error) { translateDatabaseError(error) }
}

export async function createShelfAction(title: string) { return mutationResult(() => createShelf(title)) }
export async function renameShelfAction(id: string, title: string) { return mutationResult(() => renameShelf(id, title)) }
export async function deleteShelfAction(id: string) { return mutationResult(() => deleteShelf(id)) }
