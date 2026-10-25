"use server"

import { sql } from "drizzle-orm"
import { z } from "zod"
import type { ActionResult } from "@/lib/action-result"
import { withRlsContext, type DatabaseTransaction } from "@/lib/db/client"
import { lockLibrary } from "@/lib/db/library"
import { DomainError, databaseErrorCode, translateDatabaseError } from "@/lib/domain-errors"
import {
  DELETE_CONTENTS, LOCATION_CONTENTS_PAGE_SIZE, locationIdSchema, locationPath, locationVersionSchema, parseLocationKind, parseLocationName,
  parsePosition, parseShelfLabel, type CopyLocationView, type LocationView,
} from "@/lib/locations"
import { beginUpload, discard, register, upload } from "@/lib/media/server"
import {
  LOCATION_CYCLE_SQLSTATE, LOCATION_DEPTH_SQLSTATE, LOCATION_LIMITS, MEDIA_LIMITS, MEDIA_REFERENCE_SQLSTATE, PRODUCT_LIMIT_SQLSTATE, type LocationKind,
} from "@/lib/product/contracts"
import { domainMutation } from "@/lib/server-action"
import { getRequiredUserId } from "@/lib/server-user"
import type { Book } from "@/lib/types"

// U-PRO-03 · Ubicación física: árbol mueble → balda propio de la cuenta, ubicación actual de cada ejemplar y foto general
// de referencia. Complementa la estantería lógica: ninguna acción de este archivo toca `copies.shelf_id` ni el estado de
// lectura. El dueño sale de la sesión; RLS, las FK con dueño y las guardas de 0014 (BL001 ciclo, BL002 profundidad, BP001
// límite, BA010 foto) son la segunda barrera. Todas devuelven `ActionResult`.

const LOCATION_GONE = "La ubicación ya no está disponible. Recarga la lista."
const LOCATION_CHANGED = "La ubicación ha cambiado desde que la abriste. No se ha guardado nada: recarga y vuelve a intentarlo."
const COPY_GONE = "El libro ya no está disponible."
const COPY_LOCATION_CHANGED = "La ubicación de este ejemplar ha cambiado en otra pestaña. No se ha guardado nada: recarga la ficha y vuelve a intentarlo."

function parse<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new DomainError("INVALID_INPUT", message)
  return parsed.data
}

/** Traduce los errores de la base a mensajes claros; `missing` es el de una referencia que no existe (23503). */
function locationError(error: unknown, missing = LOCATION_GONE): never {
  if (error instanceof DomainError) throw error
  switch (databaseErrorCode(error)) {
    case LOCATION_CYCLE_SQLSTATE: throw new DomainError("INVALID_INPUT", "Una ubicación no puede quedar dentro de sí misma ni de otra que ella contiene. No se ha movido nada.")
    case LOCATION_DEPTH_SQLSTATE: throw new DomainError("INVALID_INPUT", `Las ubicaciones admiten como máximo ${LOCATION_LIMITS.maxDepth} niveles, contando las que contiene la que mueves. No se ha movido nada.`)
    case PRODUCT_LIMIT_SQLSTATE: throw new DomainError("LIMIT_EXCEEDED", `Has alcanzado el máximo de ${LOCATION_LIMITS.perAccount} ubicaciones. Borra alguna que ya no uses antes de crear otra.`)
    case MEDIA_REFERENCE_SQLSTATE: throw new DomainError("CONFLICT", "La foto ya no está disponible. Vuelve a subirla.")
    case "23503": throw new DomainError("NOT_FOUND", missing)
    case "23514": throw new DomainError("INVALID_INPUT", "Algún dato de la ubicación no es válido. Revisa el nombre, la balda y la posición.")
    default: translateDatabaseError(error)
  }
}

interface LocationRow extends Record<string, unknown> {
  id: string; name: string; kind: LocationKind; parent_id: string | null; version: string; photo_asset_id: string | null; copies: number; children: number
}

const viewOf = (row: LocationRow): LocationView => ({
  id: row.id, name: row.name, kind: row.kind, parentId: row.parent_id, version: row.version, photoAssetId: row.photo_asset_id, copies: row.copies, children: row.children,
})

async function readLocations(tx: DatabaseTransaction, owner: string, id?: string): Promise<LocationView[]> {
  const rows = await tx.execute<LocationRow>(sql`
    select l.id, l.name, l.kind, l.parent_id, l.version, l.photo_asset_id,
      (select count(*)::int from biblib.copy_locations as cl where cl.user_id = l.user_id and cl.location_id = l.id) as copies,
      (select count(*)::int from biblib.locations as c where c.user_id = l.user_id and c.parent_id = l.id) as children
    from biblib.locations as l where l.user_id = ${owner}::uuid ${id ? sql`and l.id = ${id}::uuid` : sql``}
    order by l.created_at, l.id`)
  return [...rows].map(viewOf)
}

async function readLocation(tx: DatabaseTransaction, owner: string, id: string): Promise<LocationView> {
  const [location] = await readLocations(tx, owner, id)
  if (!location) throw new DomainError("NOT_FOUND", LOCATION_GONE)
  return location
}

/** Fila bloqueada de la ubicación con la versión vista; otra versión es `CONFLICT` y una ajena o inexistente, `NOT_FOUND`. */
async function lockLocation(tx: DatabaseTransaction, owner: string, id: string, expectedVersion: string) {
  const [row] = await tx.execute<{ id: string; parent_id: string | null; version: string; photo_asset_id: string | null }>(sql`
    select id, parent_id, version, photo_asset_id from biblib.locations where user_id = ${owner}::uuid and id = ${id}::uuid for update`)
  if (!row) throw new DomainError("NOT_FOUND", LOCATION_GONE)
  if (row.version !== expectedVersion) throw new DomainError("CONFLICT", LOCATION_CHANGED)
  return row
}

/** La foto sustituida o de una ubicación borrada se descarta si nada la cita, tampoco una versión anterior de la biblioteca. */
async function releasePhoto(owner: string, assetId: string | null): Promise<void> {
  if (!assetId) return
  try {
    const cited = await withRlsContext(owner, async (tx) => (await tx.execute<{ cited: boolean }>(sql`
      select exists (select 1 from biblib.library_snapshot_chunks as sc where sc.user_id = ${owner}::uuid and sc.kind in ('books', 'locations')
        and strpos(sc.payload::text, ${assetId}) > 0) as cited`))[0]?.cited)
    // Citada por una versión anterior: se conserva; la purga administrativa la retira cuando ya nada la cite.
    if (!cited) await discard(assetId)
  } catch { /* Sin citas pendientes, la purga administrativa la encuentra (media_asset_purge_candidates). */ }
}

// ── Árbol de ubicaciones ────────────────────────────────────────────────────────────────────────────

export interface LocationsOverview {
  locations: LocationView[]
  limits: { perAccount: number; maxDepth: number }
}

/** Todas las ubicaciones de la cuenta, también las vacías, con lo que contiene cada una. */
export async function getLocationsAction(): Promise<ActionResult<LocationsOverview>> {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    const locations = await withRlsContext(owner, (tx) => readLocations(tx, owner))
    return { locations, limits: { perAccount: LOCATION_LIMITS.perAccount, maxDepth: LOCATION_LIMITS.maxDepth } }
  })
}

const createSchema = z.object({ name: z.unknown(), kind: z.unknown(), parentId: locationIdSchema.nullish() })

/** Crea una ubicación en la raíz o dentro de otra propia. */
export async function createLocationAction(input: { name: string; kind: LocationKind; parentId?: string | null }): Promise<ActionResult<LocationView>> {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    const fields = parse(createSchema, input, "Los datos de la ubicación no son válidos.")
    const name = parseLocationName(fields.name)
    const kind = parseLocationKind(fields.kind)
    try {
      return await withRlsContext(owner, async (tx) => {
        await lockLibrary(tx)
        if (fields.parentId) await readLocation(tx, owner, fields.parentId)
        const [row] = await tx.execute<{ id: string }>(sql`
          insert into biblib.locations (user_id, parent_id, name, kind) values (${owner}::uuid, ${fields.parentId ?? null}, ${name}, ${kind}) returning id`)
        return readLocation(tx, owner, row.id)
      })
    } catch (error) { locationError(error, "La ubicación que la contiene ya no está disponible. Recarga la lista.") }
  })
}

const updateSchema = z.object({ id: locationIdSchema, name: z.unknown(), kind: z.unknown(), expectedVersion: locationVersionSchema })

/** Renombra una ubicación o cambia su tipo; no mueve nada ni toca su contenido. */
export async function updateLocationAction(input: { id: string; name: string; kind: LocationKind; expectedVersion: string }): Promise<ActionResult<LocationView>> {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    const fields = parse(updateSchema, input, "Los datos de la ubicación no son válidos.")
    const name = parseLocationName(fields.name)
    const kind = parseLocationKind(fields.kind)
    try {
      return await withRlsContext(owner, async (tx) => {
        await lockLibrary(tx)
        await lockLocation(tx, owner, fields.id, fields.expectedVersion)
        await tx.execute(sql`update biblib.locations set name = ${name}, kind = ${kind}, updated_at = now() where user_id = ${owner}::uuid and id = ${fields.id}::uuid`)
        return readLocation(tx, owner, fields.id)
      })
    } catch (error) { locationError(error) }
  })
}

const moveSchema = z.object({ id: locationIdSchema, parentId: locationIdSchema.nullable(), expectedVersion: locationVersionSchema })

/** Mueve una ubicación (con todo lo que contiene) a la raíz o dentro de otra. Ciclos y profundidad los rechaza la base. */
export async function moveLocationAction(input: { id: string; parentId: string | null; expectedVersion: string }): Promise<ActionResult<LocationView>> {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    const fields = parse(moveSchema, input, "El destino no es válido.")
    if (fields.parentId === fields.id) throw new DomainError("INVALID_INPUT", "Una ubicación no puede quedar dentro de sí misma ni de otra que ella contiene. No se ha movido nada.")
    try {
      return await withRlsContext(owner, async (tx) => {
        await lockLibrary(tx)
        await lockLocation(tx, owner, fields.id, fields.expectedVersion)
        if (fields.parentId) await readLocation(tx, owner, fields.parentId).catch(() => { throw new DomainError("NOT_FOUND", "La ubicación de destino ya no está disponible. Recarga la lista.") })
        await tx.execute(sql`update biblib.locations set parent_id = ${fields.parentId}, updated_at = now() where user_id = ${owner}::uuid and id = ${fields.id}::uuid`)
        return readLocation(tx, owner, fields.id)
      })
    } catch (error) { locationError(error, "La ubicación de destino ya no está disponible. Recarga la lista.") }
  })
}

const deleteSchema = z.object({ id: locationIdSchema, expectedVersion: locationVersionSchema, contents: z.enum(DELETE_CONTENTS).default("reject") })

export interface LocationDeletion {
  /** Ubicaciones interiores que pasaron a la que la contenía (o a la raíz). */
  movedChildren: number
  /** Ejemplares que pasaron a la ubicación que la contenía, conservando su balda y posición. */
  movedCopies: number
  /** Ejemplares que quedaron sin ubicación porque la borrada estaba en la raíz. */
  unassignedCopies: number
}

/**
 * Borra una ubicación. Vacía, siempre. Ocupada (con ubicaciones interiores o ejemplares), solo con la elección explícita
 * `move-to-parent`: su contenido pasa a la ubicación que la contiene sin renumerar posiciones (si está en la raíz, sus
 * ubicaciones pasan a la raíz y sus ejemplares quedan sin ubicación). Nunca se borra ningún libro ni cambia su estantería.
 */
export async function deleteLocationAction(input: { id: string; expectedVersion: string; contents?: (typeof DELETE_CONTENTS)[number] }): Promise<ActionResult<LocationDeletion>> {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    const fields = parse(deleteSchema, input, "La ubicación indicada no es válida.")
    let photo: string | null = null
    let result: LocationDeletion
    try {
      result = await withRlsContext(owner, async (tx) => {
        await lockLibrary(tx)
        const row = await lockLocation(tx, owner, fields.id, fields.expectedVersion)
        const { copies, children } = await readLocation(tx, owner, fields.id)
        if ((copies || children) && fields.contents !== "move-to-parent") {
          throw new DomainError("CONFLICT", `La ubicación no está vacía: contiene ${children} ${children === 1 ? "ubicación" : "ubicaciones"} y ${copies} ${copies === 1 ? "ejemplar" : "ejemplares"}. Vacíala antes de borrarla o elige pasar su contenido a la ubicación que la contiene.`)
        }
        const movedChildren = children ? (await tx.execute(sql`update biblib.locations set parent_id = ${row.parent_id}, updated_at = now() where user_id = ${owner}::uuid and parent_id = ${fields.id}::uuid`)).count : 0
        let movedCopies = 0, unassignedCopies = 0
        if (copies && row.parent_id) movedCopies = (await tx.execute(sql`update biblib.copy_locations set location_id = ${row.parent_id}::uuid, updated_at = now() where user_id = ${owner}::uuid and location_id = ${fields.id}::uuid`)).count
        else if (copies) unassignedCopies = (await tx.execute(sql`delete from biblib.copy_locations where user_id = ${owner}::uuid and location_id = ${fields.id}::uuid`)).count
        await tx.execute(sql`delete from biblib.locations where user_id = ${owner}::uuid and id = ${fields.id}::uuid`)
        photo = row.photo_asset_id
        return { movedChildren, movedCopies, unassignedCopies }
      })
    } catch (error) { locationError(error, "La ubicación no está vacía: alguien añadió contenido mientras la borrabas. Recarga y vuelve a intentarlo.") }
    await releasePhoto(owner, photo)
    return result
  })
}

// ── Contenido de una ubicación ──────────────────────────────────────────────────────────────────────

export interface LocationContentItem {
  id: string
  title: string
  authors: string[]
  status: Book["status"]
  shelfName: string
  locationId: string
  shelfLabel: string | null
  position: number | null
}

export interface LocationContents {
  location: LocationView
  path: string[]
  items: LocationContentItem[]
  total: number
  page: number
  pageSize: number
}

const contentsSchema = z.object({
  locationId: locationIdSchema,
  query: z.string().max(200).optional(),
  includeNested: z.boolean().optional(),
  status: z.enum(["read", "reading", "unread", "to-read"]).optional(),
  page: z.number().int().min(1).max(10_000).optional(),
})

const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, "\\$&")}%`

/** Ejemplares de una ubicación (y, si se pide, de las que contiene), filtrados por texto y estado, por balda y posición. */
export async function getLocationContentsAction(input: { locationId: string; query?: string; includeNested?: boolean; status?: Book["status"]; page?: number }): Promise<ActionResult<LocationContents>> {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    const fields = parse(contentsSchema, input, "El filtro no es válido.")
    const text = fields.query?.trim() ? likePattern(fields.query.trim()) : null
    const page = fields.page ?? 1
    return withRlsContext(owner, async (tx) => {
      const all = await readLocations(tx, owner)
      const location = all.find((entry) => entry.id === fields.locationId)
      if (!location) throw new DomainError("NOT_FOUND", LOCATION_GONE)
      const rows = await tx.execute<{ id: string; title: string; authors: { name: string }[]; status: Book["status"]; shelf_name: string; location_id: string; shelf_label: string | null; position: number | null; total: number }>(sql`
        with recursive scope(id, level) as (
          select l.id, 1 from biblib.locations as l where l.user_id = ${owner}::uuid and l.id = ${fields.locationId}::uuid
          union all
          select l.id, s.level + 1 from biblib.locations as l join scope as s on l.parent_id = s.id
          where l.user_id = ${owner}::uuid and ${fields.includeNested === true} and s.level < ${LOCATION_LIMITS.maxDepth}
        )
        select b.id, b.title, b.authors, b.status, sh.title as shelf_name, cl.location_id, cl.shelf_label, cl.position, count(*) over ()::int as total
        from biblib.copy_locations as cl
        join scope on scope.id = cl.location_id
        join biblib.books as b on b.user_id = cl.user_id and b.id = cl.copy_id
        join biblib.shelves as sh on sh.user_id = b.user_id and sh.id = b.shelf_id
        where cl.user_id = ${owner}::uuid
          ${fields.status ? sql`and b.status = ${fields.status}` : sql``}
          ${text ? sql`and (b.title ilike ${text} or b.subtitle ilike ${text} or exists (select 1 from jsonb_array_elements(b.authors) as a where a->>'name' ilike ${text}))` : sql``}
        order by scope.level, cl.shelf_label nulls first, cl.position nulls last, b.title, b.id
        limit ${LOCATION_CONTENTS_PAGE_SIZE} offset ${(page - 1) * LOCATION_CONTENTS_PAGE_SIZE}`)
      const byId = new Map(all.map((entry) => [entry.id, entry]))
      return {
        location, path: locationPath(byId, location.id), page, pageSize: LOCATION_CONTENTS_PAGE_SIZE, total: rows[0]?.total ?? 0,
        items: [...rows].map((row) => ({
          id: row.id, title: row.title, authors: row.authors.map((author) => author.name), status: row.status, shelfName: row.shelf_name,
          locationId: row.location_id, shelfLabel: row.shelf_label, position: row.position,
        })),
      }
    })
  })
}

// ── Ubicación de un ejemplar ────────────────────────────────────────────────────────────────────────

export interface CopyLocationState {
  current: CopyLocationView | null
  /** Ubicaciones de la cuenta para elegir destino. */
  locations: LocationView[]
}

async function readCopyLocation(tx: DatabaseTransaction, owner: string, copyId: string): Promise<CopyLocationState> {
  const [copy] = await tx.execute<{ id: string }>(sql`select id from biblib.copies where user_id = ${owner}::uuid and id = ${copyId}::uuid`)
  if (!copy) throw new DomainError("NOT_FOUND", COPY_GONE)
  const locations = await readLocations(tx, owner)
  const [row] = await tx.execute<{ location_id: string; shelf_label: string | null; position: number | null; version: string }>(sql`
    select location_id, shelf_label, position, version from biblib.copy_locations where user_id = ${owner}::uuid and copy_id = ${copyId}::uuid`)
  const byId = new Map(locations.map((entry) => [entry.id, entry]))
  const current = row ? {
    locationId: row.location_id, shelfLabel: row.shelf_label, position: row.position, version: row.version,
    path: locationPath(byId, row.location_id), kind: byId.get(row.location_id)?.kind ?? "other",
  } satisfies CopyLocationView : null
  return { current, locations }
}

/** Ubicación actual del ejemplar (o ninguna) y las ubicaciones disponibles. Sin ubicación, la ficha funciona igual. */
export async function getCopyLocationAction(copyId: string): Promise<ActionResult<CopyLocationState>> {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    const id = parse(z.uuid(), copyId, "La ficha no es válida.")
    return withRlsContext(owner, (tx) => readCopyLocation(tx, owner, id))
  })
}

const assignSchema = z.object({
  copyId: z.uuid(), locationId: locationIdSchema, shelfLabel: z.unknown().optional(), position: z.unknown().optional(),
  expectedVersion: locationVersionSchema.nullable(),
})

export interface CopyLocationChange extends CopyLocationState {
  /** Otros ejemplares que ya ocupaban esa posición en la misma ubicación y hueco: se avisa, no se renumera ninguno. */
  samePosition: number
}

/**
 * Asigna o mueve la ubicación de un ejemplar con la versión vista (`null` si aún no tenía). Solo cambia `copy_locations`:
 * la estantería lógica, la colección y el estado de lectura no se tocan, y ninguna otra posición se renumera.
 */
export async function setCopyLocationAction(input: { copyId: string; locationId: string; shelfLabel?: string | null; position?: number | string | null; expectedVersion: string | null }): Promise<ActionResult<CopyLocationChange>> {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    const fields = parse(assignSchema, input, "La ubicación indicada no es válida.")
    const shelfLabel = parseShelfLabel(fields.shelfLabel)
    const position = parsePosition(fields.position)
    try {
      return await withRlsContext(owner, async (tx) => {
        await lockLibrary(tx)
        const [copy] = await tx.execute<{ id: string }>(sql`select id from biblib.copies where user_id = ${owner}::uuid and id = ${fields.copyId}::uuid`)
        if (!copy) throw new DomainError("NOT_FOUND", COPY_GONE)
        await readLocation(tx, owner, fields.locationId)
        const changed = fields.expectedVersion === null
          ? await tx.execute(sql`insert into biblib.copy_locations (user_id, copy_id, location_id, shelf_label, position)
              values (${owner}::uuid, ${fields.copyId}::uuid, ${fields.locationId}::uuid, ${shelfLabel}, ${position})
              on conflict (user_id, copy_id) do nothing returning version`)
          : await tx.execute(sql`update biblib.copy_locations set location_id = ${fields.locationId}::uuid, shelf_label = ${shelfLabel}, position = ${position}, updated_at = now()
              where user_id = ${owner}::uuid and copy_id = ${fields.copyId}::uuid and version = ${fields.expectedVersion}::uuid returning version`)
        if (!changed.length) throw new DomainError("CONFLICT", COPY_LOCATION_CHANGED)
        const [{ n }] = position === null ? [{ n: 0 }] : await tx.execute<{ n: number }>(sql`
          select count(*)::int as n from biblib.copy_locations where user_id = ${owner}::uuid and location_id = ${fields.locationId}::uuid
            and position = ${position} and shelf_label is not distinct from ${shelfLabel} and copy_id <> ${fields.copyId}::uuid`)
        return { ...await readCopyLocation(tx, owner, fields.copyId), samePosition: n }
      })
    } catch (error) { locationError(error) }
  })
}

const clearSchema = z.object({ copyId: z.uuid(), expectedVersion: locationVersionSchema })

/** Deja el ejemplar sin ubicación física; su estantería y estado no cambian. */
export async function clearCopyLocationAction(input: { copyId: string; expectedVersion: string }): Promise<ActionResult<CopyLocationState>> {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    const fields = parse(clearSchema, input, "La ficha no es válida.")
    try {
      return await withRlsContext(owner, async (tx) => {
        await lockLibrary(tx)
        const removed = await tx.execute(sql`delete from biblib.copy_locations where user_id = ${owner}::uuid and copy_id = ${fields.copyId}::uuid and version = ${fields.expectedVersion}::uuid returning copy_id`)
        if (!removed.length) {
          const [copy] = await tx.execute<{ id: string }>(sql`select id from biblib.copies where user_id = ${owner}::uuid and id = ${fields.copyId}::uuid`)
          throw copy ? new DomainError("CONFLICT", COPY_LOCATION_CHANGED) : new DomainError("NOT_FOUND", COPY_GONE)
        }
        return readCopyLocation(tx, owner, fields.copyId)
      })
    } catch (error) { locationError(error) }
  })
}

// ── Foto de la ubicación ────────────────────────────────────────────────────────────────────────────

/**
 * Reserva, sube y registra la foto con el flujo de imágenes privadas de U-EXP-06 (`lib/media/server.ts`): `upload` valida y
 * reencodifica a WebP sin metadatos antes de subir con la sesión del dueño. Si algo falla, la reserva se descarta y no
 * queda cuarentena ni objeto; la foto que la ubicación cite hasta ahora no cambia.
 */
async function storeLocationPhoto(bytes: Uint8Array, declaredType: string): Promise<string> {
  const asset = await beginUpload("location")
  try {
    const image = await upload(asset, bytes, declaredType)
    await register(asset.assetId, image)
    return asset.assetId
  } catch (error) {
    await discard(asset.assetId).catch(() => null)
    throw error
  }
}

const ACCEPTED_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const
const photoSchema = z.object({ locationId: locationIdSchema, expectedVersion: locationVersionSchema, mime: z.enum(ACCEPTED_PHOTO_TYPES), bytes: z.coerce.number().int().min(1) })

/**
 * Sube o sustituye la foto general de la ubicación. Los bytes se validan y reencodifican a WebP sin EXIF ni GPS antes de
 * subirlos al bucket privado; la foto anterior solo se suelta cuando la nueva está registrada y citada con la versión vista.
 * Si algo falla, la ubicación conserva la foto que tenía. La foto nunca es pública ni viaja a ningún proveedor.
 */
export async function uploadLocationPhotoAction(form: FormData): Promise<ActionResult<LocationView>> {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    const fields = parse(photoSchema, { locationId: form.get("locationId"), expectedVersion: form.get("expectedVersion"), mime: form.get("mime"), bytes: form.get("bytes") },
      "La imagen no es válida. Elige un archivo JPEG, PNG o WebP de hasta 5 MiB.")
    const file = form.get("file")
    if (!(file instanceof Blob)) throw new DomainError("INVALID_INPUT", "Elige una imagen para subir.")
    if (fields.bytes > MEDIA_LIMITS.maxBytes.location || file.size > MEDIA_LIMITS.maxBytes.location) throw new DomainError("ASSET_REJECTED", "La imagen supera el tamaño máximo de 5 MiB.")
    if (file.size !== fields.bytes) throw new DomainError("INVALID_INPUT", "La imagen llegó incompleta. Vuelve a intentarlo.")
    // Antes de procesar nada: la ubicación existe y sigue en la versión vista.
    const seen = await withRlsContext(owner, (tx) => readLocation(tx, owner, fields.locationId))
    if (seen.version !== fields.expectedVersion) throw new DomainError("CONFLICT", LOCATION_CHANGED)

    const photoId = await storeLocationPhoto(new Uint8Array(await file.arrayBuffer()), fields.mime)
    let previous: string | null = null
    let updated: LocationView
    try {
      updated = await withRlsContext(owner, async (tx) => {
        await lockLibrary(tx)
        const row = await lockLocation(tx, owner, fields.locationId, fields.expectedVersion)
        await tx.execute(sql`update biblib.locations set photo_asset_id = ${photoId}::uuid, updated_at = now() where user_id = ${owner}::uuid and id = ${fields.locationId}::uuid`)
        previous = row.photo_asset_id
        return readLocation(tx, owner, fields.locationId)
      })
    } catch (error) {
      // La nueva no llegó a citarse: se descarta y la anterior sigue citada.
      await discard(photoId).catch(() => null)
      locationError(error)
    }
    await releasePhoto(owner, previous)
    return updated
  })
}

const removePhotoSchema = z.object({ locationId: locationIdSchema, expectedVersion: locationVersionSchema })

/** Quita la foto de la ubicación; la imagen se descarta cuando nada la cita. */
export async function removeLocationPhotoAction(input: { locationId: string; expectedVersion: string }): Promise<ActionResult<LocationView>> {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    const fields = parse(removePhotoSchema, input, "La ubicación indicada no es válida.")
    let previous: string | null = null
    let updated: LocationView
    try {
      updated = await withRlsContext(owner, async (tx) => {
        await lockLibrary(tx)
        const row = await lockLocation(tx, owner, fields.locationId, fields.expectedVersion)
        if (!row.photo_asset_id) throw new DomainError("CONFLICT", "La ubicación ya no tiene foto. Recarga la lista.")
        await tx.execute(sql`update biblib.locations set photo_asset_id = null, updated_at = now() where user_id = ${owner}::uuid and id = ${fields.locationId}::uuid`)
        previous = row.photo_asset_id
        return readLocation(tx, owner, fields.locationId)
      })
    } catch (error) { locationError(error) }
    await releasePhoto(owner, previous)
    return updated
  })
}
