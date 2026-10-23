import { normalizedBookIdentifier } from "./isbn"
import type { LibraryData } from "./types"

// Plan privado de importación (U-DAT-01). Funciones puras, sin red ni base de datos: el servidor
// las usa al preparar la vista previa y otra vez, bajo el bloqueo de colección, al confirmarla.

/** Cambiar estas reglas invalida las vistas previas anteriores (PREVIEW_EXPIRED). */
export const IMPORT_RULES_VERSION = 1
export const DEFAULT_PREVIEW_TTL_MINUTES = 30
export const MAX_ACTIVE_PREVIEWS = 10

export type ImportMode = "merge" | "replace"

/** Estado mínimo de la colección actual que decide el plan. */
export interface CollectionSnapshot {
  shelves: { id: string; title: string; isDefault: boolean }[]
  books: { id: string; isbn: string }[]
}

export interface ImportPlanCounts {
  /** Libros nuevos, con un ID recién asignado. */
  added: number
  /** Libros actuales cuyo ID sobrevive: todos al fusionar; al reemplazar, los que coinciden por ISBN o identificador. */
  kept: number
  /** Libros actuales que el reemplazo sobrescribe con los datos del archivo conservando su ID. */
  overwritten: number
  /** Libros del archivo omitidos al fusionar porque ya están en la biblioteca. */
  skipped: number
  /** Libros o estanterías del archivo que reciben un ID distinto del suyo. */
  reassigned: number
  /** Libros actuales que se eliminarán. */
  deleted: number
  shelvesCreated: number
  shelvesDeleted: number
  /** Estanterías de la biblioteca resultante. */
  shelvesAfter: number
  booksAfter: number
  coversFound: number
  coversPending: number
}

export interface ImportPlan {
  rulesVersion: number
  mode: ImportMode
  counts: ImportPlanCounts
  shelves: {
    create: { sourceId: string; id: string; title: string }[]
    map: { sourceId: string; id: string }[]
    delete: string[]
  }
  books: {
    insert: { sourceId: string; id: string; shelfId: string }[]
    skip: { sourceId: string; existingId: string }[]
    delete: string[]
  }
  reassigned: { kind: "book" | "shelf"; sourceId: string; id: string }[]
}

export interface ImportOperationResult {
  imported: number
  skipped: number
  deleted: number
  reassigned: number
  shelves: number
  coversFound: number
  coversPending: number
}

/** Genera IDs nuevos estables para una misma vista previa (semilla aleatoria del servidor). */
export type IdAllocator = (kind: "book" | "shelf", sourceId: string) => string

export interface BuildImportPlanInput {
  imported: LibraryData
  current: CollectionSnapshot
  mode: ImportMode
  allocateId: IdAllocator
  covers?: { found: number; pending: number }
}

const titleKey = (title: string) => title.toLocaleLowerCase("es")

export function buildImportPlan({ imported, current, mode, allocateId, covers = { found: 0, pending: 0 } }: BuildImportPlanInput): ImportPlan {
  const defaultShelf = current.shelves.find((shelf) => shelf.isDefault)
  if (!defaultShelf) throw new Error("La colección actual no tiene estantería predeterminada.")
  const previousByIdentifier = new Map(current.books.map((book) => [normalizedBookIdentifier(book.isbn), book.id]))
  const previousCustom = new Map(current.shelves.filter((shelf) => !shelf.isDefault).map((shelf) => [shelf.id, shelf]))

  // Al reemplazar solo sobrevive la predeterminada; al fusionar se unen estanterías por nombre.
  const titles = new Map<string, string>(mode === "replace"
    ? [[titleKey(defaultShelf.title), defaultShelf.id]]
    : current.shelves.map((shelf) => [titleKey(shelf.title), shelf.id]))
  const create: ImportPlan["shelves"]["create"] = []
  const map: ImportPlan["shelves"]["map"] = []
  const reassigned: ImportPlan["reassigned"] = []
  const reused = new Set<string>()
  for (const shelf of imported.shelves) {
    if (shelf.isDefault) { map.push({ sourceId: shelf.id, id: defaultShelf.id }); continue }
    const existing = titles.get(titleKey(shelf.title))
    if (existing) { map.push({ sourceId: shelf.id, id: existing }); continue }
    // Un ID propio reconocido se conserva al reemplazar; en otro caso, ID nuevo e informado.
    const id = mode === "replace" && previousCustom.has(shelf.id) ? shelf.id : allocateId("shelf", shelf.id)
    if (id === shelf.id) reused.add(id)
    else reassigned.push({ kind: "shelf", sourceId: shelf.id, id })
    create.push({ sourceId: shelf.id, id, title: shelf.title })
    map.push({ sourceId: shelf.id, id })
    titles.set(titleKey(shelf.title), id)
  }
  const shelfFor = new Map(map.map((entry) => [entry.sourceId, entry.id]))

  const insert: ImportPlan["books"]["insert"] = []
  const skip: ImportPlan["books"]["skip"] = []
  const matched = new Set<string>()
  for (const book of imported.books) {
    const shelfId = shelfFor.get(book.shelf_id)
    if (!shelfId) throw new Error("Hay libros con una estantería inexistente.")
    const previous = previousByIdentifier.get(normalizedBookIdentifier(book.isbn))
    if (mode === "merge" && previous) { skip.push({ sourceId: book.id, existingId: previous }); continue }
    const id = previous ?? allocateId("book", book.id)
    if (previous) matched.add(previous)
    if (id !== book.id) reassigned.push({ kind: "book", sourceId: book.id, id })
    insert.push({ sourceId: book.id, id, shelfId })
  }

  const deletedBooks = mode === "replace" ? current.books.filter((book) => !matched.has(book.id)).map((book) => book.id) : []
  const deletedShelves = mode === "replace" ? [...previousCustom.keys()].filter((id) => !reused.has(id)) : []
  const shelvesAfter = mode === "replace" ? 1 + create.length : current.shelves.length + create.length
  return {
    rulesVersion: IMPORT_RULES_VERSION,
    mode,
    counts: {
      added: insert.length - matched.size,
      kept: mode === "merge" ? current.books.length : matched.size,
      overwritten: mode === "replace" ? matched.size : 0,
      skipped: skip.length,
      reassigned: reassigned.length,
      deleted: deletedBooks.length,
      shelvesCreated: create.filter((shelf) => !reused.has(shelf.id)).length,
      shelvesDeleted: deletedShelves.length,
      shelvesAfter,
      booksAfter: mode === "replace" ? insert.length : current.books.length + insert.length,
      coversFound: covers.found,
      coversPending: covers.pending,
    },
    shelves: { create, map, delete: deletedShelves },
    books: { insert, skip, delete: deletedBooks },
    reassigned,
  }
}

export function operationResult(plan: ImportPlan): ImportOperationResult {
  return {
    imported: plan.books.insert.length,
    skipped: plan.counts.skipped,
    deleted: plan.counts.deleted,
    reassigned: plan.counts.reassigned,
    shelves: plan.counts.shelvesAfter,
    coversFound: plan.counts.coversFound,
    coversPending: plan.counts.coversPending,
  }
}

/** JSON con claves ordenadas: base estable para los hashes de entrada y de confirmación. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map((item) => item === undefined ? "null" : canonicalJson(item)).join(",")}]`
  const entries = Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`
}

/** Entrada canónica de una confirmación: archivo, modo y reglas. La clave de idempotencia se limita a esto. */
export function confirmationInput(preview: { inputDigest: string; mode: ImportMode; rulesVersion: number }) {
  return { operation: "import.confirm", inputDigest: preview.inputDigest, mode: preview.mode, rulesVersion: preview.rulesVersion }
}

export type ConfirmDecision =
  | { kind: "replay"; operationId: string }
  | { kind: "reject"; code: "IDEMPOTENCY_CONFLICT" | "PREVIEW_EXPIRED" | "REVISION_CONFLICT" | "NOT_FOUND" | "ALREADY_CONFIRMED" }
  | { kind: "execute" }

export interface ConfirmState {
  /** Operación previa con la misma clave (mismo propietario y operación). */
  existing: { operationId: string; inputDigest: string; previewId: string | null } | null
  /** Vista previa del propietario, o null si no existe, es ajena o se purgó. */
  /** `expired` lo calcula Postgres: el reloj de la base es la autoridad, no el del navegador. */
  preview: { id: string; revision: string; expired: boolean; rulesVersion: number; confirmed: boolean } | null
  previewId: string
  digest: string | null
  expectedRevision: string
  currentRevision: string
  rulesVersion?: number
}

/**
 * Orden de decisión de una confirmación, siempre bajo el bloqueo de colección: primero la clave
 * (una repetición idéntica recupera el resultado durable), después caducidad/reglas y por último la
 * revisión. Ninguna opción del cliente cambia el plan almacenado.
 */
export function decideConfirmation(state: ConfirmState): ConfirmDecision {
  const { existing, preview } = state
  if (existing) {
    const same = preview ? existing.inputDigest === state.digest : existing.previewId === state.previewId
    return same ? { kind: "replay", operationId: existing.operationId } : { kind: "reject", code: "IDEMPOTENCY_CONFLICT" }
  }
  if (!preview) return { kind: "reject", code: "NOT_FOUND" }
  if (preview.confirmed) return { kind: "reject", code: "ALREADY_CONFIRMED" }
  if (preview.expired || preview.rulesVersion !== (state.rulesVersion ?? IMPORT_RULES_VERSION)) {
    return { kind: "reject", code: "PREVIEW_EXPIRED" }
  }
  if (state.expectedRevision !== preview.revision || state.currentRevision !== preview.revision) {
    return { kind: "reject", code: "REVISION_CONFLICT" }
  }
  return { kind: "execute" }
}

/** Caducidad configurable por servidor (minutos), acotada para que un valor erróneo no deje previews eternas. */
export function previewTtlMinutes(value: string | undefined): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 24 * 60 ? parsed : DEFAULT_PREVIEW_TTL_MINUTES
}
