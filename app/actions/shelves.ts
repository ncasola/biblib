"use server"

import { and, eq } from "drizzle-orm"
import { withRlsContext } from "@/lib/db/client"
import { books, shelves } from "@/lib/db/schema"
import { createClient } from "@/lib/supabase/server"
import { ensureDefaultShelf } from "@/app/actions/library"

async function getRequiredUserId(): Promise<string> {
  const supabase = await createClient()
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()

  if (error || !user) {
    throw new Error("No autorizado")
  }

  return user.id
}

export async function createShelfAction(title: string): Promise<void> {
  const userId = await getRequiredUserId()
  const normalizedTitle = title.trim()
  if (!normalizedTitle) {
    throw new Error("El nombre de la estantería es obligatorio")
  }

  await withRlsContext(userId, async (tx) => {
    await tx.insert(shelves).values({
      userId,
      title: normalizedTitle,
      isDefault: false,
    })
  })
}

export async function renameShelfAction(shelfId: string, title: string): Promise<void> {
  const userId = await getRequiredUserId()
  const normalizedTitle = title.trim()
  if (!normalizedTitle) {
    throw new Error("El nombre de la estantería es obligatorio")
  }

  await withRlsContext(userId, async (tx) => {
    await tx
      .update(shelves)
      .set({
        title: normalizedTitle,
        updatedAt: new Date(),
      })
      .where(and(eq(shelves.id, shelfId), eq(shelves.userId, userId), eq(shelves.isDefault, false)))
  })
}

export async function deleteShelfAction(shelfId: string): Promise<void> {
  const userId = await getRequiredUserId()
  const defaultShelfId = await ensureDefaultShelf(userId)

  if (shelfId === defaultShelfId) {
    throw new Error("No se puede eliminar la estantería predeterminada")
  }

  await withRlsContext(userId, async (tx) => {
    await tx
      .update(books)
      .set({
        shelfId: defaultShelfId,
        updatedAt: new Date(),
      })
      .where(and(eq(books.userId, userId), eq(books.shelfId, shelfId)))

    await tx.delete(shelves).where(and(eq(shelves.id, shelfId), eq(shelves.userId, userId), eq(shelves.isDefault, false)))
  })
}

export async function moveBookShelfAction(bookId: string, shelfId: string): Promise<void> {
  const userId = await getRequiredUserId()

  await withRlsContext(userId, async (tx) => {
    const shelfExists = await tx
      .select({ id: shelves.id })
      .from(shelves)
      .where(and(eq(shelves.id, shelfId), eq(shelves.userId, userId)))
      .limit(1)

    if (shelfExists.length === 0) {
      throw new Error("Estantería no encontrada")
    }

    await tx
      .update(books)
      .set({
        shelfId,
        updatedAt: new Date(),
      })
      .where(and(eq(books.id, bookId), eq(books.userId, userId)))
  })
}
