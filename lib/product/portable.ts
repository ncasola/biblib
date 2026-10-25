import type { IdAllocator, ImportPlan } from "../import-plan"
import type { ConfidenceLabel, EvidenceEntry, EvidenceOrigin, EvidenceSourceKind } from "../review/contracts"
import type { Book, LibraryData } from "../types"
import { normalizeTagName, type LocationKind, type MediaKind, type MediaRef } from "./contracts"

// Datos de producto de una colección portable (v2, partes o versión anterior) → filas de 0014 con los IDs finales. Función
// pura: la publicación (importar, restaurar partes o una versión anterior) la llama con el plan ya comprobado y escribe el
// resultado en la misma transacción. Solo los ejemplares y ediciones que crea el plan reciben datos por ejemplar o por
// edición; al fusionar, los ejemplares omitidos conservan los suyos.

/**
 * `merge`: fusión; las etiquetas se reutilizan por nombre normalizado y las ubicaciones y series propias por ID. `replace`:
 * reemplazo desde un archivo; se conservan los IDs que ya eran del dueño. `snapshot`: versión anterior; se conservan los
 * IDs que no usa otra cuenta. En los dos últimos, los datos de producto actuales se retiran antes de escribir.
 */
export type ProductApplyMode = "merge" | "replace" | "snapshot"

export interface ProductTargets {
  /** Etiquetas actuales del dueño por forma normalizada. */
  tagsByName: ReadonlyMap<string, string>
  ownLocations: ReadonlySet<string>
  ownSeries: ReadonlySet<string>
  /** Si un ID del origen se puede conservar tal cual; si no, se asigna otro estable para la misma vista previa. */
  keep: (id: string) => boolean
  /** Assets de imagen propios y listos citados por el origen: tipo y sha256. */
  media: ReadonlyMap<string, { kind: MediaKind; sha256: string }>
}

export interface EvidenceRow {
  id: string
  editionId: string | null
  copyId: string | null
  sourceKind: EvidenceSourceKind
  sourceRef: string | null
  sourceUrl: string | null
  photoAssetId: string | null
  observedAt: string | null
  fieldClaims: Record<string, unknown>
  confidence: ConfidenceLabel
  origin: EvidenceOrigin
}

export interface ProductRows {
  tags: { id: string; name: string; createdAt?: string }[]
  locations: { id: string; parentId: string | null; name: string; kind: LocationKind; photoAssetId: string | null; createdAt?: string }[]
  series: { id: string; title: string; description: string | null; createdAt?: string }[]
  copyTags: { copyId: string; tagId: string }[]
  annotations: { copyId: string; notes: string | null; rating: number | null }[]
  copyLocations: { copyId: string; locationId: string; shelfLabel: string | null; position: number | null }[]
  seriesEditions: { editionId: string; seriesId: string; position: string | null; volumeLabel: string | null; orderNote: string | null }[]
  evidence: EvidenceRow[]
  /** Referencias a fotos que no se conservan: el asset ya no es del dueño, no está listo, es de otro tipo o tiene otros bytes. */
  droppedPhotos: number
}

/** Ningún dato de producto en el origen: la publicación no lee ni escribe nada de 0014 (salvo retirar al reemplazar). */
export function hasProductData(library: LibraryData): boolean {
  return Boolean(library.tags?.length || library.locations?.length || library.series?.length || library.books.some((book) =>
    book.personal || book.location || book.evidence?.length || book.edition?.series || book.edition?.evidence?.length))
}

/** IDs de assets de imagen que cita el origen (para comprobar cuáles siguen siendo del dueño). */
export function referencedMedia(library: LibraryData): string[] {
  const ids = new Set<string>()
  for (const location of library.locations ?? []) if (location.photo) ids.add(location.photo.assetId)
  for (const book of library.books) for (const entry of [...(book.evidence ?? []), ...(book.edition?.evidence ?? [])]) if (entry.photo) ids.add(entry.photo.assetId)
  return [...ids]
}

export function planProductRows(library: LibraryData, plan: Pick<ImportPlan, "books" | "editions">, mode: ProductApplyMode, targets: ProductTargets, allocateId: IdAllocator): ProductRows {
  const rows: ProductRows = { tags: [], locations: [], series: [], copyTags: [], annotations: [], copyLocations: [], seriesEditions: [], evidence: [], droppedPhotos: 0 }
  const finalId = (kind: "tag" | "location" | "series" | "evidence", sourceId: string) => mode !== "merge" && targets.keep(sourceId) ? sourceId : allocateId(kind, sourceId)
  const photo = (ref: MediaRef | undefined, kind: MediaKind): string | null => {
    if (!ref) return null
    const asset = targets.media.get(ref.assetId)
    if (asset && asset.kind === kind && (!ref.sha256 || ref.sha256 === asset.sha256)) return ref.assetId
    rows.droppedPhotos++
    return null
  }

  const tagFor = new Map<string, string>()
  for (const tag of library.tags ?? []) {
    const existing = mode === "merge" ? targets.tagsByName.get(normalizeTagName(tag.name)) : undefined
    if (existing) { tagFor.set(tag.id, existing); continue }
    const id = finalId("tag", tag.id)
    tagFor.set(tag.id, id)
    rows.tags.push({ id, name: tag.name, ...(tag.createdAt ? { createdAt: tag.createdAt } : {}) })
  }

  const locationFor = new Map<string, string>()
  const newLocations = (library.locations ?? []).filter((location) => {
    if (mode === "merge" && targets.ownLocations.has(location.id)) { locationFor.set(location.id, location.id); return false }
    locationFor.set(location.id, finalId("location", location.id))
    return true
  })
  for (const location of newLocations) {
    rows.locations.push({
      id: locationFor.get(location.id)!, parentId: location.parentId === null ? null : locationFor.get(location.parentId) ?? null,
      name: location.name, kind: location.kind, photoAssetId: photo(location.photo, "location"), ...(location.createdAt ? { createdAt: location.createdAt } : {}),
    })
  }

  const seriesFor = new Map<string, string>()
  for (const entry of library.series ?? []) {
    if (mode === "merge" && targets.ownSeries.has(entry.id)) { seriesFor.set(entry.id, entry.id); continue }
    const id = finalId("series", entry.id)
    seriesFor.set(entry.id, id)
    rows.series.push({ id, title: entry.title, description: entry.description ?? null, ...(entry.createdAt ? { createdAt: entry.createdAt } : {}) })
  }

  const evidenceRow = (entry: EvidenceEntry, subject: { editionId: string | null; copyId: string | null }): EvidenceRow => ({
    id: finalId("evidence", entry.id), ...subject, sourceKind: entry.sourceKind, sourceRef: entry.sourceRef ?? null, sourceUrl: entry.sourceUrl ?? null,
    photoAssetId: entry.sourceKind === "photo" ? photo(entry.photo, "evidence") : null, observedAt: entry.observedAt ?? null,
    fieldClaims: entry.fieldClaims, confidence: entry.confidence, origin: entry.origin ?? "import",
  })

  const source = new Map(library.books.map((book) => [book.id, book]))
  const book = (sourceId: string): Book => {
    const found = source.get(sourceId)
    if (!found) throw new Error("La fila del plan no existe.")
    return found
  }
  for (const entry of plan.books.insert) {
    const row = book(entry.sourceId)
    const tagIds = [...new Set((row.personal?.tagIds ?? []).flatMap((tagId) => tagFor.has(tagId) ? [tagFor.get(tagId)!] : []))]
    for (const tagId of tagIds) rows.copyTags.push({ copyId: entry.id, tagId })
    if (row.personal?.notes !== undefined || row.personal?.rating !== undefined) {
      rows.annotations.push({ copyId: entry.id, notes: row.personal.notes ?? null, rating: row.personal.rating ?? null })
    }
    const locationId = row.location ? locationFor.get(row.location.locationId) : undefined
    if (row.location && locationId) {
      rows.copyLocations.push({ copyId: entry.id, locationId, shelfLabel: row.location.shelfLabel ?? null, position: row.location.position ?? null })
    }
    for (const evidence of row.evidence ?? []) rows.evidence.push(evidenceRow(evidence, { editionId: null, copyId: entry.id }))
  }
  for (const edition of plan.editions.create) {
    const row = book(edition.sourceId)
    const seriesId = row.edition?.series ? seriesFor.get(row.edition.series.seriesId) : undefined
    if (row.edition?.series && seriesId) {
      const ref = row.edition.series
      rows.seriesEditions.push({ editionId: edition.id, seriesId, position: ref.position ?? null, volumeLabel: ref.volumeLabel ?? null, orderNote: ref.orderNote ?? null })
    }
    for (const evidence of row.edition?.evidence ?? []) rows.evidence.push(evidenceRow(evidence, { editionId: edition.id, copyId: null }))
  }
  return rows
}
