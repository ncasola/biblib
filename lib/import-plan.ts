import { normalizedBookIdentifier } from "./isbn"
import type { Book, LibraryData } from "./types"

// Plan privado de importación (U-DAT-01). Funciones puras, sin red ni base de datos: el servidor
// las usa al preparar la vista previa y otra vez, bajo el bloqueo de colección, al confirmarla.
// Desde U-DAT-06 cada fila del archivo es un ejemplar; las filas con la misma clave de edición
// (`book.edition.id`, o el propio ID en v1/legacy) forman una edición y comparten sus datos.

/**
 * Cambiar estas reglas invalida las vistas previas anteriores (PREVIEW_EXPIRED). La versión 2 (U-DAT-06)
 * planifica ejemplares agrupados en ediciones y obras.
 */
export const IMPORT_RULES_VERSION = 2
export const DEFAULT_PREVIEW_TTL_MINUTES = 30
export const MAX_ACTIVE_PREVIEWS = 10

export type ImportMode = "merge" | "replace"

/**
 * Estado mínimo de la colección actual que decide el plan. `books` tiene un elemento por ejemplar con su
 * identificador plano (ISBN-13 de la edición o identificador legacy) y, desde U-DAT-06, su edición y obra.
 */
export interface CollectionSnapshot {
  shelves: { id: string; title: string; isDefault: boolean }[]
  books: { id: string; isbn: string | null; editionId?: string; workId?: string | null }[]
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
  /** Ediciones y obras que crea la publicación (U-DAT-06); varios ejemplares pueden compartir edición. */
  editionsCreated: number
  worksCreated: number
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
    /** Ejemplares: `editionId` es la edición de destino que crea este plan. */
    insert: { sourceId: string; id: string; shelfId: string; editionId: string }[]
    skip: { sourceId: string; existingId: string }[]
    delete: string[]
  }
  /** Ediciones nuevas: `sourceId` es la fila de la que salen sus datos; `workId`, su obra (o null). */
  editions: { create: { key: string; id: string; sourceId: string; workId: string | null }[] }
  /** Obras nuevas, solo con evidencia explícita de la fuente: su título sale de la fila `sourceId`. */
  works: { create: { key: string; id: string; sourceId: string }[] }
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
export type IdAllocator = (kind: "book" | "shelf" | "edition" | "work" | "tag" | "location" | "series" | "evidence", sourceId: string) => string

export interface BuildImportPlanInput {
  imported: LibraryData
  current: CollectionSnapshot
  mode: ImportMode
  allocateId: IdAllocator
  covers?: { found: number; pending: number }
}

const titleKey = (title: string) => title.toLocaleLowerCase("es")

/** Identificador con el que una fila coincide con un ejemplar actual: su ISBN-13 o su identificador legacy. */
export function copyIdentity(book: Pick<Book, "isbn" | "legacyIdentifier">): string | null {
  const value = book.isbn ?? book.legacyIdentifier ?? ""
  return value.trim() ? normalizedBookIdentifier(value) : null
}

/** Clave de edición de una fila en su archivo: la edición declarada o, en v1/legacy, el propio ejemplar. */
export const editionKey = (book: Pick<Book, "id" | "edition">): string => book.edition?.id ?? book.id

/** Clave de obra de una fila, solo si la fuente la declara. */
export const workKey = (book: Pick<Book, "edition">): string | null => book.edition?.workId ?? null

interface EditionTargets {
  /** IDs de edición y obra que el plan puede conservar (propios de la cuenta y libres tras reemplazar). */
  keepEdition: (key: string, copyIds: readonly string[]) => string | null
  keepWork: (key: string) => string | null
}

/**
 * Asigna ediciones y obras a los ejemplares insertados: una edición por clave de edición del archivo y una
 * obra por clave de obra declarada. Conserva un ID propio cuando las reglas de `targets` lo permiten.
 */
export function planEditions(rows: ReadonlyMap<string, Book>, insert: { sourceId: string; id: string }[], allocateId: IdAllocator, targets: EditionTargets) {
  const groups = new Map<string, { sourceId: string; copyIds: string[] }>()
  for (const entry of insert) {
    const book = rows.get(entry.sourceId)
    if (!book) throw new Error("La fila del archivo no existe.")
    const key = editionKey(book)
    const group = groups.get(key)
    if (group) group.copyIds.push(entry.id)
    else groups.set(key, { sourceId: entry.sourceId, copyIds: [entry.id] })
  }
  const usedEditions = new Set<string>()
  const usedWorks = new Map<string, string>()
  const works: ImportPlan["works"]["create"] = []
  const editions: ImportPlan["editions"]["create"] = []
  const editionFor = new Map<string, string>()
  for (const [key, group] of groups) {
    const kept = targets.keepEdition(key, group.copyIds)
    const id = kept && !usedEditions.has(kept) ? kept : allocateId("edition", key)
    usedEditions.add(id)
    const book = rows.get(group.sourceId)!
    const work = workKey(book)
    let workId: string | null = null
    if (work) {
      workId = usedWorks.get(work) ?? null
      if (!workId) {
        const keptWork = targets.keepWork(work)
        workId = keptWork ?? allocateId("work", work)
        usedWorks.set(work, workId)
        works.push({ key: work, id: workId, sourceId: group.sourceId })
      }
    }
    editions.push({ key, id, sourceId: group.sourceId, workId })
    editionFor.set(key, id)
  }
  return { editions, works, editionOf: (sourceId: string) => editionFor.get(editionKey(rows.get(sourceId)!))! }
}

export function buildImportPlan({ imported, current, mode, allocateId, covers = { found: 0, pending: 0 } }: BuildImportPlanInput): ImportPlan {
  const defaultShelf = current.shelves.find((shelf) => shelf.isDefault)
  if (!defaultShelf) throw new Error("La colección actual no tiene estantería predeterminada.")
  // Varios ejemplares actuales pueden compartir identificador (una edición con varias copias).
  const previousByIdentifier = new Map<string, string[]>()
  for (const book of current.books) {
    const key = book.isbn?.trim() ? normalizedBookIdentifier(book.isbn) : null
    if (key) previousByIdentifier.set(key, [...(previousByIdentifier.get(key) ?? []), book.id])
  }
  const previousById = new Map(current.books.map((book) => [book.id, book]))
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

  const insert: { sourceId: string; id: string; shelfId: string }[] = []
  const skip: ImportPlan["books"]["skip"] = []
  const matched = new Set<string>()
  for (const book of imported.books) {
    const shelfId = shelfFor.get(book.shelf_id)
    if (!shelfId) throw new Error("Hay libros con una estantería inexistente.")
    const identity = copyIdentity(book)
    const candidates = identity ? previousByIdentifier.get(identity) ?? [] : []
    // Un ejemplar sin ISBN ni identificador (U-DAT-06) solo se reconoce por su ID propio de esta cuenta.
    const own = previousById.get(book.id)
    const sameCopy = Boolean(own) && (identity === null ? !own!.isbn?.trim() : candidates.includes(book.id))
    if (mode === "merge" && (candidates.length || sameCopy)) { skip.push({ sourceId: book.id, existingId: sameCopy ? book.id : candidates[0] }); continue }
    // Al reemplazar, el mismo ejemplar conserva su ID; si no, el siguiente libre con ese identificador.
    const previous = sameCopy && !matched.has(book.id) ? book.id : candidates.find((id) => !matched.has(id))
    const id = previous ?? allocateId("book", book.id)
    if (previous) matched.add(previous)
    if (id !== book.id) reassigned.push({ kind: "book", sourceId: book.id, id })
    insert.push({ sourceId: book.id, id, shelfId })
  }

  // Al reemplazar se conservan los IDs de edición y obra propios que el archivo reconoce: la edición actual de
  // todos los ejemplares conservados de un grupo, o la clave del archivo si es una edición actual. Al fusionar
  // siempre son nuevos: la edición actual sigue intacta.
  const currentEditions = new Set(current.books.flatMap((book) => book.editionId ? [book.editionId] : []))
  const currentWorks = new Set(current.books.flatMap((book) => book.workId ? [book.workId] : []))
  const rows = new Map(imported.books.map((book) => [book.id, book]))
  const plannedEditions = planEditions(rows, insert, allocateId, {
    keepEdition: (key, copyIds) => {
      if (mode !== "replace") return null
      const kept = [...new Set(copyIds.map((id) => previousById.get(id)?.editionId).filter((id): id is string => Boolean(id)))]
      if (kept.length === 1 && copyIds.every((id) => previousById.has(id))) return kept[0]
      return currentEditions.has(key) ? key : null
    },
    keepWork: (key) => mode === "replace" && currentWorks.has(key) ? key : null,
  })

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
      editionsCreated: plannedEditions.editions.length,
      worksCreated: plannedEditions.works.length,
      coversFound: covers.found,
      coversPending: covers.pending,
    },
    shelves: { create, map, delete: deletedShelves },
    books: { insert: insert.map((entry) => ({ ...entry, editionId: plannedEditions.editionOf(entry.sourceId) })), skip, delete: deletedBooks },
    editions: { create: plannedEditions.editions },
    works: { create: plannedEditions.works },
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
