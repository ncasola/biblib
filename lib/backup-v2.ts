import { z } from "zod"
import { catalogueProblem, catalogueRequiresV2, catalogueV1Schema, catalogueV2Schema } from "./catalogue-provenance"
import { normalizeIsbn } from "./isbn"
import type { Author, Book, CatalogueMetadata, CopyVerification, EditionIdentifiers, LibraryData, Publisher, Shelf } from "./types"

// Copia portable `formatVersion: 2` (U-BIB-04, capacidad completa con U-DAT-06): obras, ediciones,
// ejemplares y estanterías. Cada ejemplar conserva su ID (el de la ficha legacy); varias copias pueden
// compartir edición y una obra solo aparece con evidencia. La verificación física vive en la copia y las
// fuentes por campo en la edición. Un payload declara en `requiredCapabilities` lo que usa; el lector
// rechaza una capacidad desconocida y todo lo que no puede conservar, sin truncarlo.

export const BACKUP_V2_FORMAT_VERSION = 2

/** Capacidades que este lector sabe conservar. */
export const BACKUP_V2_SUPPORTED_CAPABILITIES = [
  "catalogue.provenance-v2", "works.entities", "copies.multiple-per-edition", "copies.verification-evidence", "editions.identifiers",
] as const

export type BackupV2Capability = typeof BACKUP_V2_SUPPORTED_CAPABILITIES[number]

const capabilityLabels: Record<BackupV2Capability, string> = {
  "catalogue.provenance-v2": "procedencia por campo",
  "works.entities": "obras",
  "copies.multiple-per-edition": "varias copias de una misma edición",
  "copies.verification-evidence": "fecha o evidencias de la comprobación física",
  "editions.identifiers": "identificadores externos o idioma de la edición",
}

/** Procedencia bibliográfica de la edición: la de `Book.catalogue` sin la comprobación física. */
export type EditionCatalogueV2 =
  | { schemaVersion?: undefined; source: Exclude<CatalogueMetadata["source"], "bne">; sourceUrl?: string }
  | Omit<Extract<CatalogueMetadata, { schemaVersion: 2 }>, "isbnVerified" | "isbnChecksumValid">

export interface PortableWorkV2 {
  id: string
  title: string
}

export interface PortableEditionV2 {
  id: string
  work_id: string | null
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
  language?: string
  identifiers?: EditionIdentifiers
}

export interface PortableCopyV2 {
  id: string
  edition_id: string
  status: Book["status"]
  shelf_id: string
  /** Comprobación humana del ISBN frente al ejemplar físico. Ningún proveedor ni checksum la activa. */
  edition_verification: CopyVerification
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
  works: PortableWorkV2[]
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

const hasEvidence = (book: Book) => Boolean(book.verification?.checkedAt || book.verification?.evidenceRefs?.length)

/** Edición y copia de una fila: la edición es la de `book.edition` o, en una ficha legacy, la del propio `book.id`. */
export function bookToEditionAndCopy(book: Book): { edition: PortableEditionV2; copy: PortableCopyV2 } {
  const isbn13 = book.isbn ? normalizeIsbn(book.isbn) : null
  const catalogue = editionCatalogue(book.catalogue)
  const editionId = book.edition?.id ?? book.id
  return {
    edition: {
      id: editionId, work_id: book.edition?.workId ?? null, isbn13, title: book.title,
      ...(book.subtitle !== undefined ? { subtitle: book.subtitle } : {}),
      authors: book.authors.map((author) => ({ ...author })),
      ...(book.publishers !== undefined ? { publishers: book.publishers.map((publisher) => ({ ...publisher })) } : {}),
      publish_date: book.publish_date, number_of_pages: book.number_of_pages, cover: { ...book.cover },
      ...(catalogue ? { catalogue } : {}),
      ...(book.edition?.language ? { language: book.edition.language } : {}),
      ...(book.edition?.identifiers && Object.keys(book.edition.identifiers).length ? { identifiers: book.edition.identifiers } : {}),
    },
    copy: {
      id: book.id, edition_id: editionId, status: book.status, shelf_id: book.shelf_id,
      edition_verification: {
        isbnVerified: Boolean(isbn13) && (book.catalogue?.isbnVerified ?? false),
        ...(book.verification?.checkedAt ? { checkedAt: book.verification.checkedAt } : {}),
        ...(book.verification?.evidenceRefs?.length ? { evidenceRefs: [...book.verification.evidenceRefs] } : {}),
      },
      legacy_identifier: isbn13 ? null : book.legacyIdentifier ?? (book.isbn?.trim() ? book.isbn : null),
    },
  }
}

export function requiredCapabilitiesFor(books: readonly Book[]): BackupV2Capability[] {
  const perEdition = new Map<string, number>()
  for (const book of books) perEdition.set(book.edition?.id ?? book.id, (perEdition.get(book.edition?.id ?? book.id) ?? 0) + 1)
  const used: Record<BackupV2Capability, boolean> = {
    "catalogue.provenance-v2": books.some((book) => book.catalogue?.schemaVersion === 2),
    "works.entities": books.some((book) => Boolean(book.edition?.workId)),
    "copies.multiple-per-edition": [...perEdition.values()].some((count) => count > 1),
    "copies.verification-evidence": books.some(hasEvidence),
    "editions.identifiers": books.some((book) => Boolean(book.edition?.language || (book.edition?.identifiers && Object.keys(book.edition.identifiers).length))),
  }
  return BACKUP_V2_SUPPORTED_CAPABILITIES.filter((capability) => used[capability])
}

/** Escritor canónico. Los tokens de versión no se exportan: no autorizan escrituras al restaurar. */
export function createBackupV2(data: LibraryData, exportedAt = new Date()): PortableBackupV2 {
  const editions = new Map<string, PortableEditionV2>()
  const works = new Map<string, PortableWorkV2>()
  const copies: PortableCopyV2[] = []
  for (const book of data.books) {
    const { edition, copy } = bookToEditionAndCopy(book)
    if (!editions.has(edition.id)) editions.set(edition.id, edition)
    if (edition.work_id && !works.has(edition.work_id)) works.set(edition.work_id, { id: edition.work_id, title: book.edition?.workTitle ?? book.title })
    copies.push(copy)
  }
  return {
    formatVersion: 2,
    exportedAt: exportedAt.toISOString(),
    requiredCapabilities: requiredCapabilitiesFor(data.books),
    works: [...works.values()],
    editions: [...editions.values()],
    copies,
    shelves: data.shelves.map((shelf) => ({ id: shelf.id, title: shelf.title, ...(shelf.isDefault !== undefined ? { isDefault: shelf.isDefault } : {}) })),
  }
}

/**
 * Indica si la colección necesita el formato 2: procedencia que v1 no conserva (BNE o fuentes por campo),
 * varias copias de una edición, obras, evidencias de comprobación, identificadores o idioma de edición, o
 * un libro sin ISBN ni identificador legacy (v1 exigiría inventarle uno).
 */
export function libraryRequiresV2(data: LibraryData): boolean {
  if (requiredCapabilitiesFor(data.books).some((capability) => capability !== "catalogue.provenance-v2")) return true
  return data.books.some((book) => catalogueRequiresV2(book.catalogue) || (!book.isbn && !book.legacyIdentifier))
}

const id = z.string().trim().min(1).max(200)
const httpsOrLocalCover = z.string().max(2_048)
const editionCatalogueSchema = z.union([
  catalogueV2Schema.omit({ isbnVerified: true, isbnChecksumValid: true }),
  catalogueV1Schema.omit({ isbnVerified: true }),
])
/** Mismos límites que la restricción de `editions` (0010) y que la importación. */
export const editionLanguageSchema = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/).max(35)
export const editionIdentifiersSchema = z.record(z.string().regex(/^[a-z][A-Za-z0-9]{1,30}$/), z.array(z.string().trim().min(1).max(200)).min(1).max(10))
  .refine((value) => Object.keys(value).length <= 10, "Demasiados esquemas de identificador.")
export const copyVerificationSchema = z.object({
  isbnVerified: z.boolean(),
  checkedAt: z.iso.datetime({ offset: true }).optional(),
  evidenceRefs: z.array(z.string().regex(/^[A-Za-z0-9:_-]{1,100}$/)).min(1).max(10).optional(),
}).strict()

const workSchema = z.object({ id, title: z.string().trim().min(1).max(500) }).strict()

const editionSchema = z.object({
  id, work_id: id.nullable(),
  isbn13: z.string().regex(/^97[89]\d{10}$/).nullable(),
  title: z.string().trim().min(1).max(500),
  subtitle: z.string().max(1_000).optional(),
  authors: z.array(z.object({ name: z.string().trim().min(1).max(200), url: z.string().max(2_048).optional() }).strict()).max(30),
  publishers: z.array(z.object({ name: z.string().trim().min(1).max(200) }).strict()).max(20).optional(),
  publish_date: z.string().max(100),
  number_of_pages: z.number().int().min(0).max(100_000),
  cover: z.object({ small: httpsOrLocalCover, medium: httpsOrLocalCover, large: httpsOrLocalCover }).strict(),
  catalogue: editionCatalogueSchema.optional(),
  language: editionLanguageSchema.optional(),
  identifiers: editionIdentifiersSchema.optional(),
}).strict()

const copySchema = z.object({
  id, edition_id: id,
  status: z.enum(["read", "reading", "unread", "to-read"]),
  shelf_id: id,
  edition_verification: copyVerificationSchema,
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

/** Las filas de una edición comparten estos campos; dos filas de la misma clave con valores distintos no son una edición. */
export function editionFingerprint(book: Book): string {
  return JSON.stringify([book.isbn ?? null, book.title, book.subtitle ?? null, book.authors, book.publishers ?? [], book.publish_date, book.number_of_pages,
    book.cover, editionCatalogue(book.catalogue) ?? null, book.edition?.workId ?? null, book.edition?.language ?? null, book.edition?.identifiers ?? null])
}

/**
 * Lector v2. Devuelve filas planas (una por ejemplar, con la clave de su edición y su obra) que pasan por
 * las mismas validaciones que v1 (duplicados, estanterías, límites). Rechaza con explicación lo que no
 * puede conservar o no declara, en lugar de truncarlo.
 */
export function readBackupV2(input: unknown): { books: Book[]; shelves: Shelf[] } {
  const envelope = envelopeSchema.safeParse(input)
  if (!envelope.success) {
    const keys = unrecognizedKeys(envelope.error)
    if (keys.length) throw new BackupFormatError(`El archivo de formato 2 contiene secciones que esta versión no puede conservar (${keys.slice(0, 5).join(", ")}). No se importa para no descartarlas.`)
    throw new BackupFormatError("El archivo de formato 2 no es válido: debe incluir fecha de exportación, capacidades, obras, ediciones, copias y estanterías.")
  }
  const data = envelope.data
  for (const capability of data.requiredCapabilities) {
    if ((BACKUP_V2_SUPPORTED_CAPABILITIES as readonly string[]).includes(capability)) continue
    throw new BackupFormatError(`Este archivo necesita la capacidad «${capability.slice(0, 60)}», que esta versión de BibLib no conoce. No se ha importado nada.`)
  }

  const works = data.works.map((entry, index) => parseEntry(workSchema, entry, `La obra ${index + 1}`))
  const editions = data.editions.map((entry, index) => parseEntry(editionSchema, entry, `La edición ${index + 1}`))
  const copies = data.copies.map((entry, index) => parseEntry(copySchema, entry, `La copia ${index + 1}`))
  const shelves = data.shelves.map((entry, index) => parseEntry(shelfSchema, entry, `La estantería ${index + 1}`))

  const unique = <T extends { id: string }>(items: T[], label: string) => {
    const byId = new Map<string, T>()
    for (const item of items) {
      if (byId.has(item.id)) throw new BackupFormatError(`El archivo contiene ${label} con el mismo identificador.`)
      byId.set(item.id, item)
    }
    return byId
  }
  const worksById = unique(works, "obras")
  const editionsById = unique(editions, "ediciones")
  const copiesPerEdition = new Map<string, number>()
  for (const copy of copies) copiesPerEdition.set(copy.edition_id, (copiesPerEdition.get(copy.edition_id) ?? 0) + 1)
  if (editions.some((edition) => !copiesPerEdition.has(edition.id))) {
    throw new BackupFormatError("Este archivo tiene ediciones sin ningún ejemplar, que BibLib no conserva: cada edición pertenece a un ejemplar de tu biblioteca. No se ha importado nada.")
  }
  const usedWorks = new Set(editions.flatMap((edition) => edition.work_id ? [edition.work_id] : []))
  if (works.some((work) => !usedWorks.has(work.id))) throw new BackupFormatError("Este archivo tiene obras sin ninguna edición, que BibLib no conserva. No se ha importado nada.")

  const declared = new Set(data.requiredCapabilities)
  const uses: [BackupV2Capability, boolean][] = [
    ["catalogue.provenance-v2", editions.some((edition) => edition.catalogue !== undefined && "schemaVersion" in edition.catalogue)],
    ["works.entities", works.length > 0],
    ["copies.multiple-per-edition", [...copiesPerEdition.values()].some((count) => count > 1)],
    ["copies.verification-evidence", copies.some((copy) => copy.edition_verification.checkedAt !== undefined || copy.edition_verification.evidenceRefs !== undefined)],
    ["editions.identifiers", editions.some((edition) => edition.language !== undefined || edition.identifiers !== undefined)],
  ]
  for (const [capability, used] of uses) {
    if (used && !declared.has(capability)) throw new BackupFormatError(`El archivo usa ${capabilityLabels[capability]} sin declarar la capacidad «${capability}».`)
  }

  const books = copies.map((copy): Book => {
    const edition = editionsById.get(copy.edition_id)
    if (!edition) throw new BackupFormatError("Una copia hace referencia a una edición inexistente.")
    const work = edition.work_id ? worksById.get(edition.work_id) : undefined
    if (edition.work_id && !work) throw new BackupFormatError("Una edición hace referencia a una obra inexistente.")
    if (edition.isbn13 && !normalizeIsbn(edition.isbn13)) throw new BackupFormatError(`La edición «${edition.title}» tiene un ISBN-13 con dígito de control incorrecto.`)
    if (edition.isbn13 && copy.legacy_identifier) {
      throw new BackupFormatError(`La copia de «${edition.title}» tiene ISBN y un identificador legacy a la vez; un ejemplar de una edición con ISBN no conserva otro identificador.`)
    }
    if (copy.edition_verification.isbnVerified && !edition.isbn13) throw new BackupFormatError(`La copia de «${edition.title}» está marcada como comprobada sin ISBN que comprobar.`)
    const { isbnVerified, ...evidence } = copy.edition_verification
    const catalogue = edition.catalogue ?? { source: "import" as const }
    return {
      id: copy.id, isbn: edition.isbn13,
      ...(copy.legacy_identifier ? { legacyIdentifier: copy.legacy_identifier } : {}),
      title: edition.title,
      ...(edition.subtitle !== undefined ? { subtitle: edition.subtitle } : {}),
      authors: edition.authors,
      ...(edition.publishers !== undefined ? { publishers: edition.publishers } : {}),
      number_of_pages: edition.number_of_pages, publish_date: edition.publish_date, cover: edition.cover,
      status: copy.status, shelf_id: copy.shelf_id, shelf_name: "",
      catalogue: { ...catalogue, isbnVerified } as CatalogueMetadata,
      // Una edición propia de un solo ejemplar con su mismo ID es la forma de una ficha legacy: sin clave explícita.
      ...(edition.id !== copy.id || work || edition.language || edition.identifiers || (copiesPerEdition.get(edition.id) ?? 0) > 1 ? { edition: {
        id: edition.id,
        ...(work ? { workId: work.id, workTitle: work.title } : {}),
        ...(edition.language ? { language: edition.language } : {}),
        ...(edition.identifiers ? { identifiers: edition.identifiers } : {}),
      } } : {}),
      ...(Object.keys(evidence).length ? { verification: evidence } : {}),
    }
  })
  return { books, shelves: shelves.map((shelf) => ({ ...shelf, book_count: 0 })) }
}
