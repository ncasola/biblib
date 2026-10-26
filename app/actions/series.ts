"use server"

import { and, asc, eq, sql } from "drizzle-orm"
import type { z } from "zod"
import { withRlsContext, type DatabaseTransaction } from "@/lib/db/client"
import { lockLibrary } from "@/lib/db/library"
import { editions, series, seriesEditions } from "@/lib/db/schema"
import { getRequiredUserId } from "@/lib/server-user"
import { domainMutation } from "@/lib/server-action"
import { databaseErrorCode, DomainError } from "@/lib/domain-errors"
import type { ActionResult } from "@/lib/action-result"
import { PRODUCT_LIMIT_SQLSTATE, SERIES_LIMITS } from "@/lib/product/contracts"
import {
  createSeriesSchema, deleteSeriesSchema, linkEditionSchema, moveVolumeSchema, seriesIdSchema, unlinkEditionSchema, updateSeriesSchema,
  type EditionSeriesState, type SeriesDetail, type SeriesSummary, type SeriesVolume,
} from "@/lib/series"
import type { Author } from "@/lib/types"

// Series privadas (U-PRO-05). Acciones por dueño de la sesión; ningún DTO elige `user_id`. Una edición pertenece a cero o
// una serie, con posición exacta en texto decimal (NUMERIC, nunca un flotante). Borrar una serie retira los vínculos
// (cascada de `series_editions`) y nunca las ediciones ni los ejemplares. Cada escritura bloquea la colección como el
// resto de acciones y compara la `version` del registro: 0 filas → CONFLICT.
//   - listSeriesAction() / getSeriesAction(id) / getEditionSeriesAction(editionId): lecturas.
//   - createSeriesAction({ title, description? }), updateSeriesAction({ id, expectedVersion, title, description? }),
//     deleteSeriesAction({ id, expectedVersion }).
//   - linkEditionToSeriesAction({ editionId, seriesId, position?, volumeLabel?, orderNote? }): primera vinculación.
//   - moveSeriesVolumeAction({ editionId, seriesId, expectedVersion, position?, volumeLabel?, orderNote? }): cambia la
//     posición, la etiqueta, la nota o la serie de un vínculo existente.
//   - unlinkEditionFromSeriesAction({ editionId, expectedVersion }): quita el volumen.

const SERIES_NOT_FOUND = "La serie ya no está disponible."
const EDITION_NOT_FOUND = "La edición ya no está disponible."
const SERIES_CHANGED = "La serie ha cambiado. Actualiza la lista antes de volver a modificarla."
const VOLUME_CHANGED = "El volumen ha cambiado. Actualiza la ficha antes de volver a modificarlo."

function parse<T>(schema: z.ZodType<T>, input: unknown, fallback: string): T {
  const result = schema.safeParse(input)
  if (result.success) return result.data
  throw new DomainError("INVALID_INPUT", result.error.issues[0]?.message || fallback)
}

async function result<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  return domainMutation(async () => {
    try { return await work() } catch (error) {
      if (error instanceof DomainError) throw error
      const code = databaseErrorCode(error)
      if (code === PRODUCT_LIMIT_SQLSTATE) throw new DomainError("LIMIT_EXCEEDED", `Ya tienes ${SERIES_LIMITS.perAccount} series. Borra una antes de crear otra.`)
      if (code === "23514") throw new DomainError("INVALID_INPUT", "Los datos de la serie o del volumen no son válidos.")
      if (code === "23505") throw new DomainError("CONFLICT", "Esta edición ya está en una serie. Muévela o quítala antes de vincularla otra vez.")
      // Una edición o serie de otra cuenta responde como inexistente: no se confirma nada de la otra cuenta.
      if (code === "23503") throw new DomainError("NOT_FOUND", "La edición o la serie ya no está disponible.")
      throw error
    }
  })
}

async function requireSeries(tx: DatabaseTransaction, userId: string, id: string, lock = false) {
  const query = tx.select().from(series).where(and(eq(series.id, id), eq(series.userId, userId)))
  const [row] = lock ? await query.for("update") : await query
  if (!row) throw new DomainError("NOT_FOUND", SERIES_NOT_FOUND)
  return row
}

async function requireEdition(tx: DatabaseTransaction, userId: string, id: string): Promise<void> {
  const [row] = await tx.select({ id: editions.id }).from(editions).where(and(eq(editions.id, id), eq(editions.userId, userId))).limit(1)
  if (!row) throw new DomainError("NOT_FOUND", EDITION_NOT_FOUND)
}

/** Lectura exacta de la posición (`trim_scale(...)::text`): «1.5» y no «1.50», nunca un número de JS. */
const positionText = sql<string | null>`trim_scale(${seriesEditions.position})::text`

function toSummary(row: { id: string; title: string; description: string | null; version: string }, volumes: number): SeriesSummary {
  return { id: row.id, title: row.title, ...(row.description !== null ? { description: row.description } : {}), version: row.version, volumes }
}

export async function listSeriesAction(): Promise<ActionResult<SeriesSummary[]>> {
  return result(async () => {
    const userId = await getRequiredUserId()
    return withRlsContext(userId, async (tx) => {
      const rows = await tx.select({
        id: series.id, title: series.title, description: series.description, version: series.version,
        volumes: sql<number>`(select count(*)::int from ${seriesEditions} where ${seriesEditions.userId} = ${series.userId} and ${seriesEditions.seriesId} = ${series.id})`,
      }).from(series).where(eq(series.userId, userId)).orderBy(asc(sql`lower(${series.title})`), asc(series.id)).limit(SERIES_LIMITS.perAccount)
      return rows.map((row) => toSummary(row, row.volumes))
    })
  })
}

type VolumeRow = {
  edition_id: string; book_id: string; copies: number; title: string; subtitle: string | null; authors: Author[]
  cover_small: string; cover_asset_id: string | null; position: string | null; volume_label: string | null; order_note: string | null; version: string
}

export async function getSeriesAction(id: unknown): Promise<ActionResult<SeriesDetail>> {
  return result(async () => {
    const userId = await getRequiredUserId()
    const seriesId = parse(seriesIdSchema, id, "La serie no es válida.")
    return withRlsContext(userId, async (tx) => {
      const row = await requireSeries(tx, userId, seriesId)
      // Orden exacto: la posición NUMERIC ordena 1, 1.5, 2 y deja al final el orden desconocido. Nunca se usa la fecha de
      // publicación; a igual posición, el título y la edición dan un orden estable.
      const volumes = await tx.execute<VolumeRow>(sql`
        select se.edition_id, c.book_id, c.copies, e.title, e.subtitle, e.authors, e.cover_small, e.cover_asset_id,
          trim_scale(se.position)::text as position, se.volume_label, se.order_note, se.version
        from biblib.series_editions se
        join biblib.editions e on e.user_id = se.user_id and e.id = se.edition_id
        join lateral (
          select (array_agg(cp.id order by cp.created_at, cp.id))[1] as book_id, count(*)::int as copies
          from biblib.copies cp where cp.user_id = se.user_id and cp.edition_id = se.edition_id
        ) c on c.book_id is not null
        where se.user_id = ${userId} and se.series_id = ${seriesId}
        order by se.position asc nulls last, lower(e.title), se.edition_id`)
      const items: SeriesVolume[] = [...volumes].map((volume) => ({
        editionId: volume.edition_id, bookId: volume.book_id, copies: volume.copies, title: volume.title,
        ...(volume.subtitle ? { subtitle: volume.subtitle } : {}),
        authors: volume.authors.map((author) => author.name),
        cover: volume.cover_asset_id ? `/api/covers/${volume.cover_asset_id}` : volume.cover_small,
        ...(volume.position !== null ? { position: volume.position } : {}),
        ...(volume.volume_label !== null ? { volumeLabel: volume.volume_label } : {}),
        ...(volume.order_note !== null ? { orderNote: volume.order_note } : {}),
        version: volume.version,
      }))
      return { ...toSummary(row, items.length), items }
    })
  })
}

/** Vínculo actual de la edición y series de la cuenta, dentro de la transacción del dueño. */
async function readEditionSeries(tx: DatabaseTransaction, userId: string, editionId: string): Promise<EditionSeriesState> {
  const [link] = await tx.select({
    seriesId: series.id, seriesTitle: series.title, position: positionText, volumeLabel: seriesEditions.volumeLabel,
    orderNote: seriesEditions.orderNote, version: seriesEditions.version,
  }).from(seriesEditions).innerJoin(series, and(eq(series.userId, seriesEditions.userId), eq(series.id, seriesEditions.seriesId)))
    .where(and(eq(seriesEditions.userId, userId), eq(seriesEditions.editionId, editionId))).limit(1)
  const available = await tx.select({ id: series.id, title: series.title }).from(series).where(eq(series.userId, userId))
    .orderBy(asc(sql`lower(${series.title})`), asc(series.id)).limit(SERIES_LIMITS.perAccount)
  return {
    link: link ? {
      series: { id: link.seriesId, title: link.seriesTitle },
      ...(link.position !== null ? { position: link.position } : {}),
      ...(link.volumeLabel !== null ? { volumeLabel: link.volumeLabel } : {}),
      ...(link.orderNote !== null ? { orderNote: link.orderNote } : {}),
      version: link.version,
    } : null,
    available,
  }
}

export async function getEditionSeriesAction(editionId: unknown): Promise<ActionResult<EditionSeriesState>> {
  return result(async () => {
    const userId = await getRequiredUserId()
    const id = parse(seriesIdSchema, editionId, "La edición no es válida.")
    return withRlsContext(userId, async (tx) => {
      await requireEdition(tx, userId, id)
      return readEditionSeries(tx, userId, id)
    })
  })
}

export async function createSeriesAction(input: unknown): Promise<ActionResult<SeriesSummary>> {
  return result(async () => {
    const userId = await getRequiredUserId()
    const values = parse(createSeriesSchema, input, "Indica el título de la serie.")
    return withRlsContext(userId, async (tx) => {
      await lockLibrary(tx)
      const [row] = await tx.insert(series).values({ userId, title: values.title, description: values.description }).returning()
      return toSummary(row, 0)
    })
  })
}

export async function updateSeriesAction(input: unknown): Promise<ActionResult<SeriesSummary>> {
  return result(async () => {
    const userId = await getRequiredUserId()
    const values = parse(updateSeriesSchema, input, "Indica el título de la serie.")
    return withRlsContext(userId, async (tx) => {
      await lockLibrary(tx)
      const current = await requireSeries(tx, userId, values.id, true)
      if (current.version !== values.expectedVersion) throw new DomainError("CONFLICT", SERIES_CHANGED)
      const [row] = await tx.update(series).set({ title: values.title, description: values.description, updatedAt: new Date() })
        .where(and(eq(series.id, current.id), eq(series.userId, userId), eq(series.version, values.expectedVersion))).returning()
      if (!row) throw new DomainError("CONFLICT", SERIES_CHANGED)
      const [{ volumes }] = await tx.select({ volumes: sql<number>`count(*)::int` }).from(seriesEditions)
        .where(and(eq(seriesEditions.userId, userId), eq(seriesEditions.seriesId, row.id)))
      return toSummary(row, volumes)
    })
  })
}

/** Borra la serie y sus vínculos; las ediciones y los ejemplares se conservan. Devuelve cuántos volúmenes se desvincularon. */
export async function deleteSeriesAction(input: unknown): Promise<ActionResult<{ unlinked: number }>> {
  return result(async () => {
    const userId = await getRequiredUserId()
    const values = parse(deleteSeriesSchema, input, "La serie no es válida.")
    return withRlsContext(userId, async (tx) => {
      await lockLibrary(tx)
      const current = await requireSeries(tx, userId, values.id, true)
      if (current.version !== values.expectedVersion) throw new DomainError("CONFLICT", SERIES_CHANGED)
      const [{ unlinked }] = await tx.select({ unlinked: sql<number>`count(*)::int` }).from(seriesEditions)
        .where(and(eq(seriesEditions.userId, userId), eq(seriesEditions.seriesId, current.id)))
      const removed = await tx.delete(series).where(and(eq(series.id, current.id), eq(series.userId, userId), eq(series.version, values.expectedVersion)))
        .returning({ id: series.id })
      if (!removed.length) throw new DomainError("CONFLICT", SERIES_CHANGED)
      return { unlinked }
    })
  })
}

export async function linkEditionToSeriesAction(input: unknown): Promise<ActionResult<EditionSeriesState>> {
  return result(async () => {
    const userId = await getRequiredUserId()
    const values = parse(linkEditionSchema, input, "Elige la edición y la serie.")
    return withRlsContext(userId, async (tx) => {
      await lockLibrary(tx)
      await requireEdition(tx, userId, values.editionId)
      await requireSeries(tx, userId, values.seriesId)
      const [existing] = await tx.select({ editionId: seriesEditions.editionId }).from(seriesEditions)
        .where(and(eq(seriesEditions.userId, userId), eq(seriesEditions.editionId, values.editionId))).limit(1)
      if (existing) throw new DomainError("CONFLICT", "Esta edición ya está en una serie. Muévela o quítala antes de vincularla otra vez.")
      await tx.insert(seriesEditions).values({ userId, editionId: values.editionId, seriesId: values.seriesId, position: values.position, volumeLabel: values.volumeLabel, orderNote: values.orderNote })
      return readEditionSeries(tx, userId, values.editionId)
    })
  })
}

export async function moveSeriesVolumeAction(input: unknown): Promise<ActionResult<EditionSeriesState>> {
  return result(async () => {
    const userId = await getRequiredUserId()
    const values = parse(moveVolumeSchema, input, "Indica la serie y la posición del volumen.")
    return withRlsContext(userId, async (tx) => {
      await lockLibrary(tx)
      const [current] = await tx.select({ version: seriesEditions.version }).from(seriesEditions)
        .where(and(eq(seriesEditions.userId, userId), eq(seriesEditions.editionId, values.editionId))).for("update")
      if (!current) throw new DomainError("NOT_FOUND", "Esta edición ya no está en ninguna serie.")
      if (current.version !== values.expectedVersion) throw new DomainError("CONFLICT", VOLUME_CHANGED)
      await requireSeries(tx, userId, values.seriesId)
      const changed = await tx.update(seriesEditions).set({ seriesId: values.seriesId, position: values.position, volumeLabel: values.volumeLabel, orderNote: values.orderNote, updatedAt: new Date() })
        .where(and(eq(seriesEditions.userId, userId), eq(seriesEditions.editionId, values.editionId), eq(seriesEditions.version, values.expectedVersion)))
        .returning({ editionId: seriesEditions.editionId })
      if (!changed.length) throw new DomainError("CONFLICT", VOLUME_CHANGED)
      return readEditionSeries(tx, userId, values.editionId)
    })
  })
}

export async function unlinkEditionFromSeriesAction(input: unknown): Promise<ActionResult<EditionSeriesState>> {
  return result(async () => {
    const userId = await getRequiredUserId()
    const values = parse(unlinkEditionSchema, input, "La edición no es válida.")
    return withRlsContext(userId, async (tx) => {
      await lockLibrary(tx)
      const [current] = await tx.select({ version: seriesEditions.version }).from(seriesEditions)
        .where(and(eq(seriesEditions.userId, userId), eq(seriesEditions.editionId, values.editionId))).for("update")
      if (!current) throw new DomainError("NOT_FOUND", "Esta edición ya no está en ninguna serie.")
      if (current.version !== values.expectedVersion) throw new DomainError("CONFLICT", VOLUME_CHANGED)
      const removed = await tx.delete(seriesEditions)
        .where(and(eq(seriesEditions.userId, userId), eq(seriesEditions.editionId, values.editionId), eq(seriesEditions.version, values.expectedVersion)))
        .returning({ editionId: seriesEditions.editionId })
      if (!removed.length) throw new DomainError("CONFLICT", VOLUME_CHANGED)
      return readEditionSeries(tx, userId, values.editionId)
    })
  })
}
