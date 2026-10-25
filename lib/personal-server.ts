import "server-only"
import { and, asc, eq, inArray } from "drizzle-orm"
import type { DatabaseTransaction } from "./db/client"
import { copies, copyAnnotations, copyTags, tags } from "./db/schema"
import { lockLibrary } from "./db/library"
import { databaseErrorCode, DomainError, translateDatabaseError } from "./domain-errors"
import { normalizeTagName, type CopyPersonal } from "./product/contracts"
import type { PersonalInput } from "./personal-validation"
import type { Book } from "./types"

export const personalConflict = () => new DomainError("CONFLICT", "Los datos personales han cambiado desde que los abriste. Tu borrador se conserva; carga la versión actual antes de guardar.")

export function personalDatabaseError(error: unknown): never {
  const code = databaseErrorCode(error)
  if (code === "BP001") throw new DomainError("LIMIT_EXCEEDED", "Has alcanzado el límite de etiquetas de tu biblioteca o de este ejemplar.")
  if (code === "23503") throw new DomainError("NOT_FOUND", "El ejemplar o alguna etiqueta ya no están disponibles.")
  if (code === "23514") throw new DomainError("INVALID_INPUT", "Revisa los límites de notas, valoración y etiquetas.")
  if (code === "23505") throw new DomainError("CONFLICT", "Ya existe una etiqueta con ese nombre. Carga las etiquetas actuales.")
  translateDatabaseError(error)
}

/** El bloqueo de colección precede a toda escritura y a las guardas de cuota. */
export async function ensureTag(tx: DatabaseTransaction, userId: string, name: string) {
  await lockLibrary(tx)
  const [known] = await tx.select().from(tags).where(and(eq(tags.userId, userId), eq(tags.normalizedName, normalizeTagName(name)))).limit(1)
  if (known) return known
  const [created] = await tx.insert(tags).values({ userId, name })
    .onConflictDoNothing({ target: [tags.userId, tags.normalizedName] }).returning()
  if (created) return created
  const [existing] = await tx.select().from(tags).where(and(eq(tags.userId, userId), eq(tags.normalizedName, normalizeTagName(name)))).limit(1)
  if (!existing) throw personalConflict()
  return existing
}

/** Dos consultas acotadas a la página, sin N+1 ni lectura de la colección completa. */
export async function attachPersonal(tx: DatabaseTransaction, userId: string, books: Book[]): Promise<Book[]> {
  if (!books.length) return books
  const ids = books.map((book) => book.id)
  const annotations = await tx.select().from(copyAnnotations).where(and(eq(copyAnnotations.userId, userId), inArray(copyAnnotations.copyId, ids)))
  const links = await tx.select({ copyId: copyTags.copyId, tagId: copyTags.tagId }).from(copyTags)
    .where(and(eq(copyTags.userId, userId), inArray(copyTags.copyId, ids))).orderBy(asc(copyTags.tagId))
  const byCopy = new Map(annotations.map((row) => [row.copyId, row]))
  const tagIds = new Map<string, string[]>()
  for (const link of links) tagIds.set(link.copyId, [...(tagIds.get(link.copyId) ?? []), link.tagId])
  return books.map((book) => {
    const row = byCopy.get(book.id)
    const personal: CopyPersonal = { ...(row?.notes ? { notes: row.notes } : {}), ...(row?.rating ? { rating: row.rating } : {}), ...(tagIds.has(book.id) ? { tagIds: tagIds.get(book.id)! } : {}) }
    return { ...book, personalVersion: row?.version ?? null, personal: Object.keys(personal).length ? personal : undefined }
  })
}

/** Nota, valoración y todos los vínculos se guardan juntos con el token de copy_annotations. */
export async function savePersonal(tx: DatabaseTransaction, userId: string, copyId: string, expectedVersion: string | null, input: PersonalInput): Promise<void> {
  await lockLibrary(tx)
  const [copy] = await tx.select({ id: copies.id }).from(copies).where(and(eq(copies.userId, userId), eq(copies.id, copyId))).limit(1)
  if (!copy) throw new DomainError("NOT_FOUND", "El ejemplar ya no está disponible.")
  const [current] = await tx.select().from(copyAnnotations).where(and(eq(copyAnnotations.userId, userId), eq(copyAnnotations.copyId, copyId))).limit(1)
  if ((current?.version ?? null) !== expectedVersion) throw personalConflict()
  const selected = [...new Set(input.tagIds ?? [])]
  if (selected.length) {
    const own = await tx.select({ id: tags.id }).from(tags).where(and(eq(tags.userId, userId), inArray(tags.id, selected)))
    if (own.length !== selected.length) throw new DomainError("NOT_FOUND", "Alguna etiqueta ya no está disponible.")
  }
  for (const name of input.tagNames ?? []) selected.push((await ensureTag(tx, userId, name)).id)
  const ids = [...new Set(selected)]
  if (ids.length > 20) throw new DomainError("LIMIT_EXCEEDED", "El ejemplar admite hasta 20 etiquetas.")
  const values = { notes: input.notes || null, rating: input.rating ?? null, updatedAt: new Date() }
  if (current) {
    const updated = await tx.update(copyAnnotations).set(values).where(and(eq(copyAnnotations.userId, userId), eq(copyAnnotations.copyId, copyId), eq(copyAnnotations.version, expectedVersion!))).returning({ copyId: copyAnnotations.copyId })
    if (!updated.length) throw personalConflict()
  } else {
    await tx.insert(copyAnnotations).values({ userId, copyId, ...values })
  }
  await tx.delete(copyTags).where(and(eq(copyTags.userId, userId), eq(copyTags.copyId, copyId)))
  if (ids.length) await tx.insert(copyTags).values(ids.map((tagId) => ({ userId, copyId, tagId })))
}
