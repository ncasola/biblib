import { and, eq, inArray, sql } from "drizzle-orm"
import type { DatabaseTransaction } from "./client"
import {
  bibliographicEvidence, copyAnnotations, copyLocations, copyTags, locations, mediaAssets, series, seriesEditions, tags,
} from "./schema"
import { DomainError, databaseErrorCode } from "../domain-errors"
import type { IdAllocator, ImportPlan } from "../import-plan"
import {
  LOCATION_CYCLE_SQLSTATE, LOCATION_DEPTH_SQLSTATE, MEDIA_REFERENCE_SQLSTATE, PRODUCT_LIMIT_SQLSTATE,
  type CopyRating, type LocationEntry, type MediaKind, type SeriesEntry, type TagEntry,
} from "../product/contracts"
import { hasProductData, planProductRows, referencedMedia, type ProductApplyMode, type ProductRows, type ProductTargets } from "../product/portable"
import type { EvidenceEntry } from "../review/contracts"
import type { Book, LibraryData } from "../types"

// Lectura y escritura de los datos de producto de 0014 que forman parte de la colección portable: etiquetas, notas y
// valoración, ubicaciones, series y evidencias. Dentro de una transacción ya situada en el contexto RLS del dueño y, para
// escribir, bajo el bloqueo de colección. Las acciones de cada unidad (U-PRO-01/03/05, U-DAT-07) escriben por su cuenta;
// aquí solo exportar, importar, restaurar partes y restaurar versiones anteriores.

const BATCH = 100

/** Colección con los datos de producto de cada ejemplar y edición y las etiquetas, ubicaciones y series de la cuenta. */
export async function readProductData(tx: DatabaseTransaction, userId: string, books: Book[]): Promise<Pick<LibraryData, "books" | "tags" | "locations" | "series">> {
  const owner = sql`${userId}::uuid`
  const tagRows = await tx.execute<{ id: string; name: string }>(sql`select id, name from biblib.tags where user_id = ${owner} order by created_at, id`)
  const locationRows = await tx.execute<{ id: string; name: string; kind: LocationEntry["kind"]; parent_id: string | null; photo_asset_id: string | null; sha256: string | null }>(sql`
    select l.id, l.name, l.kind, l.parent_id, l.photo_asset_id, m.sha256 from biblib.locations as l
    left join biblib.media_assets as m on m.user_id = l.user_id and m.id = l.photo_asset_id and m.state = 'ready'
    where l.user_id = ${owner} order by l.created_at, l.id`)
  const seriesRows = await tx.execute<{ id: string; title: string; description: string | null }>(sql`select id, title, description from biblib.series where user_id = ${owner} order by created_at, id`)
  const annotationRows = await tx.execute<{ copy_id: string; notes: string | null; rating: number | null }>(sql`select copy_id, notes, rating from biblib.copy_annotations where user_id = ${owner}`)
  const copyTagRows = await tx.execute<{ copy_id: string; tag_id: string }>(sql`select copy_id, tag_id from biblib.copy_tags where user_id = ${owner} order by copy_id, created_at, tag_id`)
  const locationRefRows = await tx.execute<{ copy_id: string; location_id: string; shelf_label: string | null; position: number | null }>(sql`
    select copy_id, location_id, shelf_label, position from biblib.copy_locations where user_id = ${owner}`)
  const seriesRefRows = await tx.execute<{ edition_id: string; series_id: string; position: string | null; volume_label: string | null; order_note: string | null }>(sql`
    select edition_id, series_id, trim_scale(position)::text as position, volume_label, order_note from biblib.series_editions where user_id = ${owner}`)
  const evidenceRows = await tx.execute<{ id: string; edition_id: string | null; copy_id: string | null; source_kind: EvidenceEntry["sourceKind"]; source_ref: string | null; source_url: string | null;
    photo_asset_id: string | null; sha256: string | null; observed_at: string | null; field_claims: Record<string, unknown>; confidence: EvidenceEntry["confidence"]; origin: NonNullable<EvidenceEntry["origin"]> }>(sql`
    select e.id, e.edition_id, e.copy_id, e.source_kind, e.source_ref, e.source_url, e.photo_asset_id, m.sha256,
      to_char(e.observed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as observed_at, e.field_claims, e.confidence, e.origin
    from biblib.bibliographic_evidence as e left join biblib.media_assets as m on m.user_id = e.user_id and m.id = e.photo_asset_id and m.state = 'ready'
    where e.user_id = ${owner} order by e.created_at, e.id`)

  const evidenceOf = (row: (typeof evidenceRows)[number]): EvidenceEntry => ({
    id: row.id, sourceKind: row.source_kind, ...(row.source_ref ? { sourceRef: row.source_ref } : {}), ...(row.source_url ? { sourceUrl: row.source_url } : {}),
    ...(row.photo_asset_id && row.sha256 ? { photo: { assetId: row.photo_asset_id, sha256: row.sha256 } } : {}),
    ...(row.observed_at ? { observedAt: row.observed_at } : {}), fieldClaims: row.field_claims, confidence: row.confidence, origin: row.origin,
  })
  const annotations = new Map([...annotationRows].map((row) => [row.copy_id, row]))
  const tagsByCopy = new Map<string, string[]>()
  for (const row of copyTagRows) tagsByCopy.set(row.copy_id, [...(tagsByCopy.get(row.copy_id) ?? []), row.tag_id])
  const locationsByCopy = new Map([...locationRefRows].map((row) => [row.copy_id, row]))
  const seriesByEdition = new Map([...seriesRefRows].map((row) => [row.edition_id, row]))
  const copyEvidence = new Map<string, EvidenceEntry[]>()
  const editionEvidence = new Map<string, EvidenceEntry[]>()
  for (const row of evidenceRows) {
    const target = row.copy_id ? copyEvidence : editionEvidence
    const key = (row.copy_id ?? row.edition_id)!
    target.set(key, [...(target.get(key) ?? []), evidenceOf(row)])
  }

  const withProduct = books.map((book): Book => {
    const annotation = annotations.get(book.id)
    const tagIds = tagsByCopy.get(book.id)
    const place = locationsByCopy.get(book.id)
    const editionId = book.edition?.id ?? book.id
    const membership = seriesByEdition.get(editionId)
    const ofEdition = editionEvidence.get(editionId)
    const personal = {
      ...(annotation?.notes != null ? { notes: annotation.notes } : {}),
      ...(annotation?.rating != null ? { rating: annotation.rating as CopyRating } : {}),
      ...(tagIds?.length ? { tagIds } : {}),
    }
    return {
      ...book,
      ...(Object.keys(personal).length ? { personal } : {}),
      ...(place ? { location: { locationId: place.location_id, ...(place.shelf_label ? { shelfLabel: place.shelf_label } : {}), ...(place.position != null ? { position: place.position } : {}) } } : {}),
      ...(copyEvidence.get(book.id)?.length ? { evidence: copyEvidence.get(book.id) } : {}),
      ...(membership || ofEdition?.length ? { edition: {
        ...(book.edition ?? { id: editionId }),
        ...(membership ? { series: { seriesId: membership.series_id, ...(membership.position !== null ? { position: membership.position } : {}),
          ...(membership.volume_label ? { volumeLabel: membership.volume_label } : {}), ...(membership.order_note ? { orderNote: membership.order_note } : {}) } } : {}),
        ...(ofEdition?.length ? { evidence: ofEdition } : {}),
      } } : {}),
    }
  })
  const tagEntries: TagEntry[] = [...tagRows].map((row) => ({ id: row.id, name: row.name }))
  const locationEntries: LocationEntry[] = [...locationRows].map((row) => ({ id: row.id, name: row.name, kind: row.kind, parentId: row.parent_id,
    ...(row.photo_asset_id && row.sha256 ? { photo: { assetId: row.photo_asset_id, sha256: row.sha256 } } : {}) }))
  const seriesEntries: SeriesEntry[] = [...seriesRows].map((row) => ({ id: row.id, title: row.title, ...(row.description !== null ? { description: row.description } : {}) }))
  return {
    books: withProduct,
    ...(tagEntries.length ? { tags: tagEntries } : {}),
    ...(locationEntries.length ? { locations: locationEntries } : {}),
    ...(seriesEntries.length ? { series: seriesEntries } : {}),
  }
}

/**
 * Lo que la publicación necesita saber de la cuenta antes de retirar nada: etiquetas por nombre normalizado, ubicaciones,
 * series y evidencias propias (para conservar sus IDs al reemplazar) y los assets de imagen que cita el origen.
 */
export async function readProductTargets(tx: DatabaseTransaction, userId: string, library: LibraryData, mode: ProductApplyMode, foreign: ReadonlySet<string> = new Set()): Promise<ProductTargets> {
  const owner = sql`${userId}::uuid`
  const tagRows = await tx.execute<{ id: string; normalized_name: string }>(sql`select id, normalized_name from biblib.tags where user_id = ${owner}`)
  const own = new Set<string>([...tagRows].map((row) => row.id))
  const ownLocations = new Set([...await tx.execute<{ id: string }>(sql`select id from biblib.locations where user_id = ${owner}`)].map((row) => row.id))
  const ownSeries = new Set([...await tx.execute<{ id: string }>(sql`select id from biblib.series where user_id = ${owner}`)].map((row) => row.id))
  if (mode === "replace") {
    for (const id of [...ownLocations, ...ownSeries]) own.add(id)
    for (const row of await tx.execute<{ id: string }>(sql`select id from biblib.bibliographic_evidence where user_id = ${owner}`)) own.add(row.id)
  }
  const wanted = referencedMedia(library)
  const media = new Map<string, { kind: MediaKind; sha256: string }>()
  if (wanted.length) {
    const assets = await tx.select({ id: mediaAssets.id, kind: mediaAssets.kind, sha256: mediaAssets.sha256 }).from(mediaAssets)
      .where(and(eq(mediaAssets.userId, userId), eq(mediaAssets.state, "ready"), inArray(mediaAssets.id, wanted)))
    for (const asset of assets) if (asset.sha256) media.set(asset.id, { kind: asset.kind, sha256: asset.sha256 })
  }
  return {
    tagsByName: new Map([...tagRows].map((row) => [row.normalized_name, row.id])), ownLocations, ownSeries, media,
    keep: mode === "snapshot" ? (id) => !foreign.has(id) : mode === "replace" ? (id) => own.has(id) : () => false,
  }
}

/** Retira las etiquetas, ubicaciones y series de la cuenta (reemplazo o restauración). Los datos por ejemplar y por edición ya cayeron con ellos. */
export async function deleteAccountProduct(tx: DatabaseTransaction, userId: string): Promise<void> {
  await tx.execute(sql`delete from biblib.copy_locations where user_id = ${userId}::uuid`)
  await tx.execute(sql`delete from biblib.locations where user_id = ${userId}::uuid`)
  await tx.execute(sql`delete from biblib.tags where user_id = ${userId}::uuid`)
  await tx.execute(sql`delete from biblib.series where user_id = ${userId}::uuid`)
}

function productLimitError(error: unknown): never {
  const code = databaseErrorCode(error)
  if (code === PRODUCT_LIMIT_SQLSTATE) throw new DomainError("LIMIT_EXCEEDED", "La importación superaría el máximo de etiquetas, ubicaciones o series de tu cuenta (o de etiquetas por libro). No se ha aplicado nada.")
  if (code === LOCATION_CYCLE_SQLSTATE || code === LOCATION_DEPTH_SQLSTATE) throw new DomainError("INVALID_INPUT", "Las ubicaciones del archivo formarían un ciclo o más de 8 niveles con las tuyas. No se ha aplicado nada.")
  if (code === MEDIA_REFERENCE_SQLSTATE) throw new DomainError("CONFLICT", "Una foto citada ya no está disponible. Vuelve a preparar la importación.")
  throw error
}

async function insertBatches<T>(rows: readonly T[], insert: (batch: T[]) => Promise<unknown>): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += BATCH) await insert(rows.slice(offset, offset + BATCH))
}

/** Escribe las filas planificadas en el orden de las FK con dueño. */
export async function writeProductRows(tx: DatabaseTransaction, userId: string, rows: ProductRows): Promise<void> {
  const at = (value: string | undefined) => value ? { createdAt: new Date(value) } : {}
  try {
    await insertBatches(rows.tags, (batch) => tx.insert(tags).values(batch.map((row) => ({ id: row.id, userId, name: row.name, ...at(row.createdAt) }))))
    await insertBatches(rows.series, (batch) => tx.insert(series).values(batch.map((row) => ({ id: row.id, userId, title: row.title, description: row.description, ...at(row.createdAt) }))))
    // Una sola sentencia: el árbol se comprueba con todas sus filas presentes (trigger AFTER de 0014).
    if (rows.locations.length) await tx.insert(locations).values(rows.locations.map((row) => ({ id: row.id, userId, parentId: row.parentId, name: row.name, kind: row.kind, photoAssetId: row.photoAssetId, ...at(row.createdAt) })))
    await insertBatches(rows.copyTags, (batch) => tx.insert(copyTags).values(batch.map((row) => ({ userId, copyId: row.copyId, tagId: row.tagId }))))
    await insertBatches(rows.annotations, (batch) => tx.insert(copyAnnotations).values(batch.map((row) => ({ userId, copyId: row.copyId, notes: row.notes, rating: row.rating as CopyRating | null }))))
    await insertBatches(rows.copyLocations, (batch) => tx.insert(copyLocations).values(batch.map((row) => ({ userId, ...row }))))
    await insertBatches(rows.seriesEditions, (batch) => tx.insert(seriesEditions).values(batch.map((row) => ({ userId, ...row }))))
    await insertBatches(rows.evidence, (batch) => tx.insert(bibliographicEvidence).values(batch.map((row) => ({
      id: row.id, userId, editionId: row.editionId, copyId: row.copyId, sourceKind: row.sourceKind, sourceRef: row.sourceRef, sourceUrl: row.sourceUrl,
      photoAssetId: row.photoAssetId, observedAt: row.observedAt ? new Date(row.observedAt) : null, fieldClaims: row.fieldClaims, confidence: row.confidence, origin: row.origin,
    }))))
  } catch (error) {
    productLimitError(error)
  }
}

/**
 * Publica los datos de producto de un origen según el plan ya comprobado. `targets` se leen antes de retirar nada (ver
 * `readProductTargets`); en reemplazo y restauración, `deleteAccountProduct` ya se ejecutó tras retirar los ejemplares.
 */
export async function applyProductData(tx: DatabaseTransaction, userId: string, library: LibraryData, plan: Pick<ImportPlan, "books" | "editions">,
  mode: ProductApplyMode, targets: ProductTargets, allocateId: IdAllocator): Promise<ProductRows | null> {
  if (!hasProductData(library)) return null
  const rows = planProductRows(library, plan, mode, targets, allocateId)
  await writeProductRows(tx, userId, rows)
  return rows
}
