"use server"

import { and, count, desc, eq, sql } from "drizzle-orm"
import { z } from "zod"
import { withRlsContext } from "@/lib/db/client"
import { savedBookViews } from "@/lib/db/schema"
import { getRequiredUserId } from "@/lib/server-user"
import { domainMutation } from "@/lib/server-action"
import { databaseErrorCode, DomainError } from "@/lib/domain-errors"
import type { ActionResult } from "@/lib/action-result"
import { parseSavedViewFilters, SAVED_VIEWS_LIMIT, savedViewFiltersSchema, savedViewNameSchema, type SavedBookView } from "@/lib/saved-views"

const identity = z.strictObject({ id: z.uuid(), expectedVersion: z.uuid() })
const createSchema = z.strictObject({ name: savedViewNameSchema, filters: savedViewFiltersSchema })
const renameSchema = identity.extend({ name: savedViewNameSchema })
const overwriteSchema = identity.extend({ filters: savedViewFiltersSchema })

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) throw new DomainError("INVALID_INPUT", "La vista no es válida. Usa un nombre de 1 a 80 caracteres y filtros admitidos.")
  return result.data
}

function toView(row: typeof savedBookViews.$inferSelect): SavedBookView {
  return { id: row.id, name: parse(savedViewNameSchema, row.name), filters: parseSavedViewFilters(row.filters), updatedAt: row.updatedAt.toISOString(), version: row.version }
}

async function result<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  return domainMutation(async () => {
    try { return await work() } catch (error) {
      if (error instanceof DomainError) throw error
      const code = databaseErrorCode(error)
      if (code === "23505") throw new DomainError("CONFLICT", "Ya existe una vista con ese nombre.")
      if (code === "BV001") throw new DomainError("LIMIT_EXCEEDED", "Ya tienes 100 vistas guardadas. Borra una antes de guardar otra.")
      if (code === "23514") throw new DomainError("INVALID_INPUT", "El nombre o los filtros de la vista no son válidos.")
      throw error
    }
  })
}

export async function listSavedViewsAction(): Promise<ActionResult<SavedBookView[]>> {
  return result(async () => {
    const userId = await getRequiredUserId()
    return withRlsContext(userId, async (tx) => (await tx.select().from(savedBookViews).where(eq(savedBookViews.userId, userId))
      .orderBy(desc(savedBookViews.updatedAt), desc(savedBookViews.id)).limit(SAVED_VIEWS_LIMIT)).map(toView))
  })
}

export async function saveCurrentViewAction(input: unknown): Promise<ActionResult<SavedBookView>> {
  return result(async () => {
    const userId = await getRequiredUserId()
    const values = parse(createSchema, input)
    return withRlsContext(userId, async (tx) => {
      // Mismo bloqueo que el trigger: el límite también se comprueba antes de escribir en servidor.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('biblib.saved_views:' || ${userId}::text, 0))`)
      const [{ total }] = await tx.select({ total: count() }).from(savedBookViews).where(eq(savedBookViews.userId, userId))
      if (total >= SAVED_VIEWS_LIMIT) throw new DomainError("LIMIT_EXCEEDED", "Ya tienes 100 vistas guardadas. Borra una antes de guardar otra.")
      const [row] = await tx.insert(savedBookViews).values({ userId, ...values }).returning()
      return toView(row)
    })
  })
}

async function changeView(input: unknown, operation: "rename" | "overwrite" | "delete"): Promise<SavedBookView | null> {
  const userId = await getRequiredUserId()
  const values = operation === "rename" ? parse(renameSchema, input) : operation === "overwrite" ? parse(overwriteSchema, input) : parse(identity, input)
  return withRlsContext(userId, async (tx) => {
    const [current] = await tx.select().from(savedBookViews).where(and(eq(savedBookViews.id, values.id), eq(savedBookViews.userId, userId))).for("update")
    if (!current) throw new DomainError("NOT_FOUND", "La vista ya no está disponible.")
    if (current.version !== values.expectedVersion) throw new DomainError("CONFLICT", "La vista ha cambiado. Actualiza la lista antes de volver a modificarla.")
    const condition = and(eq(savedBookViews.id, current.id), eq(savedBookViews.userId, userId), eq(savedBookViews.version, values.expectedVersion))
    if (operation === "delete") {
      await tx.delete(savedBookViews).where(condition)
      return null
    }
    const update = operation === "rename" ? { name: parse(renameSchema, input).name } : { filters: parse(overwriteSchema, input).filters }
    const [row] = await tx.update(savedBookViews).set(update).where(condition).returning()
    return toView(row)
  })
}

export async function renameSavedViewAction(input: unknown): Promise<ActionResult<SavedBookView | null>> { return result(() => changeView(input, "rename")) }
export async function overwriteSavedViewAction(input: unknown): Promise<ActionResult<SavedBookView | null>> { return result(() => changeView(input, "overwrite")) }
export async function deleteSavedViewAction(input: unknown): Promise<ActionResult<null>> { return result(async () => { await changeView(input, "delete"); return null }) }
