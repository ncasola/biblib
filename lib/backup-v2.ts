import { z } from "zod"
import { catalogueProblem, catalogueRequiresV2, catalogueV1Schema, catalogueV2Schema } from "./catalogue-provenance"
import { normalizeIsbn } from "./isbn"
import type { Author, Book, CatalogueMetadata, LibraryData, Publisher } from "./types"

// Copia portable `formatVersion: 2` (U-BIB-04, contrato de U-DAT-06) sobre la tabla legacy `books`.
// Antes de separar tablas, cada fila es una copia y una edición con el mismo `book.id` en namespaces
// distintos, `work_id = null` y `works = []`. La verificación física vive en la copia y las fuentes
// por campo en la edición. Lo que el modelo legacy no puede guardar se rechaza con explicación.

export const BACKUP_V2_FORMAT_VERSION = 2

/** Capacidades que este lector sabe conservar. */
export const BACKUP_V2_SUPPORTED_CAPABILITIES = ["catalogue.provenance-v2"] as const

/** Capacidades conocidas que exigen el modelo de obras/ejemplares (U-DAT-06) y aún se rechazan. */
const unsupportedCapabilities: Record<string, string> = {
  "works.entities": "obras independientes de sus ediciones",
  "copies.multiple-per-edition": "varias copias de una misma edición",
  "copies.verification-evidence": "fecha o evidencias de la comprobación física",
  "editions.identifiers": "identificadores externos de edición",
}

export type BackupV2Capability = typeof BACKUP_V2_SUPPORTED_CAPABILITIES[number]

/** Procedencia bibliográfica de la edición: la de `Book.catalogue` sin la comprobación física. */
export type EditionCatalogueV2 =
  | { schemaVersion?: undefined; source: Exclude<CatalogueMetadata["source"], "bne">; sourceUrl?: string }
  | Omit<Extract<CatalogueMetadata, { schemaVersion: 2 }>, "isbnVerified" | "isbnChecksumValid">

export interface PortableEditionV2 {
  id: string
  work_id: null
  /** ISBN-13 canónico o `null`; un identificador manual nunca ocupa este campo. */
  isbn13: string | null
  title: string
  subtitle?: string
  authors: Author[]
  publishers?: Publisher[]
  publish_date: string
  number_of_pages: number
  cover: Book["cover"]
  catalogue?: EditionCatalogueV2
}

export interface PortableCopyV2 {
  id: string
  edition_id: string
  status: Book["status"]
  shelf_id: string
  /** Comprobación humana del ISBN frente al ejemplar físico. Ningún proveedor ni checksum la activa. */
  edition_verification: { isbnVerified: boolean }
  /** Identificador legacy (`manual-…` u otro valor que no es un ISBN válido). */
  legacy_identifier: string | null
}

export interface PortableShelfV2 {
  id: string
  title: string
  isDefault?: boolean
}

export interface PortableBackupV2 {
  formatVersion: 2
  exportedAt: string
  requiredCapabilities: BackupV2Capability[]
  works: []
  editions: PortableEditionV2[]
  copies: PortableCopyV2[]
  shelves: PortableShelfV2[]
}

export class BackupFormatError extends Error {}

function editionCatalogue(catalogue: CatalogueMetadata | undefined): EditionCatalogueV2 | undefined {
  if (!catalogue) return undefined
  const sourceUrl = catalogue.sourceUrl ? { sourceUrl: catalogue.sourceUrl } : {}
  if (catalogue.schemaVersion === 2) {
    return { schemaVersion: 2, source: catalogue.source, ...sourceUrl, ...(catalogue.fields && Object.keys(catalogue.fields).length ? { fields: catalogue.fields } : {}) }
  }
  return { source: catalogue.source, ...sourceUrl }
}

/** Una fila legacy se representa como edición + copia con IDs derivados de `book.id`. */
export function bookToEditionAndCopy(book: Book): { edition: PortableEditionV2; copy: PortableCopyV2 } {
  const isbn13 = normalizeIsbn(book.isbn)
  const catalogue = editionCatalogue(book.catalogue)
  return {
    edition: {
      id: book.id, work_id: null, isbn13, title: book.title,
      ...(book.subtitle !== undefined ? { subtitle: book.subtitle } : {}),
      authors: book.authors.map((author) => ({ ...author })),
      ...(book.publishers !== undefined ? { publishers: book.publishers.map((publisher) => ({ ...publisher })) } : {}),
      publish_date: book.publish_date, number_of_pages: book.number_of_pages, cover: { ...book.cover },
      ...(catalogue ? { catalogue } : {}),
    },
    copy: {
      id: book.id, edition_id: book.id, status: book.status, shelf_id: book.shelf_id,
      edition_verification: { isbnVerified: Boolean(isbn13) && (book.catalogue?.isbnVerified ?? false) },
      legacy_identifier: isbn13 ? null : book.isbn,
    },
  }
}

export function requiredCapabilitiesFor(books: readonly Book[]): BackupV2Capability[] {
  return books.some((book) => book.catalogue?.schemaVersion === 2) ? ["catalogue.provenance-v2"] : []
}

/** Escritor canónico. Los tokens `version` no se exportan: no autorizan escrituras al restaurar. */
export function createBackupV2(data: LibraryData, exportedAt = new Date()): PortableBackupV2 {
  const pairs = data.books.map(bookToEditionAndCopy)
  return {
    formatVersion: 2,
    exportedAt: exportedAt.toISOString(),
    requiredCapabilities: requiredCapabilitiesFor(data.books),
    works: [],
    editions: pairs.map((pair) => pair.edition),
    copies: pairs.map((pair) => pair.copy),
    shelves: data.shelves.map((shelf) => ({ id: shelf.id, title: shelf.title, ...(shelf.isDefault !== undefined ? { isDefault: shelf.isDefault } : {}) })),
  }
}

/** Indica si alguna ficha tiene procedencia que el formato 1 no puede conservar. */
export function libraryRequiresV2(data: LibraryData): boolean {
  return data.books.some((book) => catalogueRequiresV2(book.catalogue))
}

const id = z.string().trim().min(1).max(200)
const httpsOrLocalCover = z.string().max(2_048)
const editionCatalogueSchema = z.union([
  catalogueV2Schema.omit({ isbnVerified: true, isbnChecksumValid: true }),
  catalogueV1Schema.omit({ isbnVerified: true }),
])

const editionSchema = z.object({
  id, work_id: z.null(),
  isbn13: z.string().regex(/^97[89]\d{10}$/).nullable(),
  title: z.string().trim().min(1).max(500),
  subtitle: z.string().max(1_000).optional(),
  authors: z.array(z.object({ name: z.string().trim().min(1).max(200), url: z.string().max(2_048).optional() }).strict()).max(30),
  publishers: z.array(z.object({ name: z.string().trim().min(1).max(200) }).strict()).max(20).optional(),
  publish_date: z.string().max(100),
  number_of_pages: z.number().int().min(0).max(100_000),
  cover: z.object({ small: httpsOrLocalCover, medium: httpsOrLocalCover, large: httpsOrLocalCover }).strict(),
  catalogue: editionCatalogueSchema.optional(),
}).strict()

const copySchema = z.object({
  id, edition_id: id,
  status: z.enum(["read", "reading", "unread", "to-read"]),
  shelf_id: id,
  edition_verification: z.object({ isbnVerified: z.boolean() }).strict(),
  legacy_identifier: z.string().trim().min(1).max(100).nullable(),
}).strict()

const shelfSchema = z.object({ id, title: z.string().trim().min(1).max(120), isDefault: z.boolean().optional() }).strict()

const envelopeSchema = z.object({
  formatVersion: z.literal(2),
  exportedAt: z.iso.datetime(),
  requiredCapabilities: z.array(z.string().max(100)).max(20),
  works: z.array(z.unknown()),
  editions: z.array(z.unknown()),
  copies: z.array(z.unknown()),
  shelves: z.array(z.unknown()),
}).strict()

function unrecognizedKeys(error: z.ZodError): string[] {
  return [...new Set(error.issues.flatMap((issue) => issue.code === "unrecognized_keys" ? issue.keys : []))]
}

function parseEntry<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  const keys = unrecognizedKeys(result.error)
  if (keys.length) throw new BackupFormatError(`${label} contiene campos que esta versión no puede conservar (${keys.slice(0, 5).join(", ")}). No se importa para no descartarlos.`)
  const catalogue = value && typeof value === "object" && "catalogue" in value ? catalogueProblem(value.catalogue) : null
  if (catalogue) throw new BackupFormatError(`${label}: ${catalogue}`)
  throw new BackupFormatError(`${label} no tiene un formato válido.`)
}

/**
 * Lector v2 previo a la separación de tablas. Devuelve la forma legacy `{ books, shelves }` para que
 * pase por las mismas validaciones que v1 (duplicados, estanterías, límites); rechaza con explicación
 * todo lo que el modelo actual no puede representar en lugar de truncarlo.
 */
export function readBackupV2(input: unknown): { books: unknown[]; shelves: unknown[] } {
  const envelope = envelopeSchema.safeParse(input)
  if (!envelope.success) {
    const keys = unrecognizedKeys(envelope.error)
    if (keys.length) throw new BackupFormatError(`El archivo de formato 2 contiene secciones que esta versión no puede conservar (${keys.slice(0, 5).join(", ")}). No se importa para no descartarlas.`)
    throw new BackupFormatError("El archivo de formato 2 no es válido: debe incluir fecha de exportación, capacidades, obras, ediciones, copias y estanterías.")
  }
  const data = envelope.data
  for (const capability of data.requiredCapabilities) {
    if ((BACKUP_V2_SUPPORTED_CAPABILITIES as readonly string[]).includes(capability)) continue
    const known = unsupportedCapabilities[capability]
    throw new BackupFormatError(known
      ? `Este archivo necesita ${known}, que esta versión de BibLib todavía no puede representar. No se ha importado nada.`
      : `Este archivo necesita la capacidad «${capability.slice(0, 60)}», que esta versión de BibLib no conoce. No se ha importado nada.`)
  }
  if (data.works.length) throw new BackupFormatError("Este archivo contiene obras, que esta versión de BibLib todavía no puede representar. No se ha importado nada.")

  const editions = data.editions.map((entry, index) => parseEntry(editionSchema, entry, `La edición ${index + 1}`))
  const copies = data.copies.map((entry, index) => parseEntry(copySchema, entry, `La copia ${index + 1}`))
  const shelves = data.shelves.map((entry, index) => parseEntry(shelfSchema, entry, `La estantería ${index + 1}`))

  const editionsById = new Map<string, PortableEditionV2>()
  for (const edition of editions) {
    if (editionsById.has(edition.id)) throw new BackupFormatError("El archivo contiene ediciones con el mismo identificador.")
    editionsById.set(edition.id, edition)
  }
  const copiesPerEdition = new Map<string, number>()
  for (const copy of copies) copiesPerEdition.set(copy.edition_id, (copiesPerEdition.get(copy.edition_id) ?? 0) + 1)
  if ([...copiesPerEdition.values()].some((count) => count > 1)) {
    throw new BackupFormatError("Este archivo tiene varias copias de una misma edición, que esta versión de BibLib todavía no puede representar. No se ha importado nada.")
  }
  if (editions.some((edition) => !copiesPerEdition.has(edition.id))) {
    throw new BackupFormatError("Este archivo tiene ediciones sin ningún ejemplar, que esta versión de BibLib todavía no puede representar. No se ha importado nada.")
  }
  const usesV2Catalogue = editions.some((edition) => edition.catalogue && "schemaVersion" in edition.catalogue)
  if (usesV2Catalogue && !data.requiredCapabilities.includes("catalogue.provenance-v2")) {
    throw new BackupFormatError("El archivo usa procedencia por campo sin declarar la capacidad «catalogue.provenance-v2».")
  }

  const books = copies.map((copy) => {
    const edition = editionsById.get(copy.edition_id)
    if (!edition) throw new BackupFormatError("Una copia hace referencia a una edición inexistente.")
    if (edition.id !== copy.id) {
      throw new BackupFormatError("Este archivo usa identificadores de edición independientes de sus copias, que esta versión de BibLib todavía no puede conservar. No se ha importado nada.")
    }
    if (edition.isbn13 && !normalizeIsbn(edition.isbn13)) throw new BackupFormatError(`La edición «${edition.title}» tiene un ISBN-13 con dígito de control incorrecto.`)
    if (edition.isbn13 && copy.legacy_identifier) {
      throw new BackupFormatError(`La copia de «${edition.title}» tiene ISBN y un identificador legacy a la vez; esta versión solo puede conservar uno.`)
    }
    const isbn = edition.isbn13 ?? copy.legacy_identifier ?? `manual-${copy.id}`
    const catalogue = edition.catalogue ?? { source: "import" as const }
    return {
      id: copy.id, isbn, title: edition.title,
      ...(edition.subtitle !== undefined ? { subtitle: edition.subtitle } : {}),
      authors: edition.authors,
      ...(edition.publishers !== undefined ? { publishers: edition.publishers } : {}),
      number_of_pages: edition.number_of_pages, publish_date: edition.publish_date, cover: edition.cover,
      status: copy.status, shelf_id: copy.shelf_id, shelf_name: "",
      catalogue: { ...catalogue, isbnVerified: copy.edition_verification.isbnVerified },
    }
  })
  return { books, shelves: shelves.map((shelf) => ({ ...shelf, book_count: 0 })) }
}
