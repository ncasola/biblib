import { z } from "zod"
import { catalogueProblem, catalogueRequiresV2, catalogueV1Schema, catalogueV2Schema } from "./catalogue-provenance"
import { normalizeIsbn } from "./isbn"
import {
  canonicalSeriesPosition, isValidTagName, LOCATION_KINDS, LOCATION_LIMITS, NOTES_MAX, normalizeTagName, SERIES_LIMITS, TAG_LIMITS,
  type CopyLocationRef, type CopyPersonal, type EditionSeriesRef, type LocationEntry, type MediaRef, type SeriesEntry, type TagEntry,
} from "./product/contracts"
import {
  isCivilDate, isOpenReadingStatus, isValidBorrowerLabel, LOAN_LIMITS, READING_CYCLE_STATUSES, READING_LIMITS, type Loan, type ReadingCycle,
} from "./product/reading-loans"
import { CONFIDENCE_LABELS, EVIDENCE_LIMITS, EVIDENCE_ORIGINS, EVIDENCE_SOURCE_KINDS, EVIDENCE_SOURCE_REF_PATTERN, type EvidenceEntry } from "./review/contracts"
import type { Author, Book, CatalogueMetadata, CopyVerification, EditionIdentifiers, LibraryData, Publisher } from "./types"

// Copia portable `formatVersion: 2` (U-BIB-04, capacidad completa con U-DAT-06): obras, ediciones,
// ejemplares y estanterías. Cada ejemplar conserva su ID (el de la ficha legacy); varias copias pueden
// compartir edición y una obra solo aparece con evidencia. La verificación física vive en la copia y las
// fuentes por campo en la edición. Un payload declara en `requiredCapabilities` lo que usa; el lector
// rechaza una capacidad desconocida y todo lo que no puede conservar, sin truncarlo.
// O13 (0014) añade secciones opcionales declaradas: nota, valoración y etiquetas de cada copia, su ubicación
// física, la serie de cada edición y las evidencias bibliográficas, más las etiquetas, ubicaciones y series de
// la cuenta. Un archivo anterior no las trae y se importa con esos datos vacíos.
// O14 (0015) añade, por copia, los ciclos de lectura con sus entradas y los préstamos (capacidades `copies.reading` y
// `copies.loans`). Un archivo anterior se importa sin lectura ni préstamos: nunca se deducen del estado `read`.

export const BACKUP_V2_FORMAT_VERSION = 2

/** Capacidades que este lector sabe conservar. */
export const BACKUP_V2_SUPPORTED_CAPABILITIES = [
  "catalogue.provenance-v2", "works.entities", "copies.multiple-per-edition", "copies.verification-evidence", "editions.identifiers",
  "copies.personal", "copies.locations", "editions.series", "bibliographic.evidence", "copies.reading", "copies.loans",
] as const

export type BackupV2Capability = typeof BACKUP_V2_SUPPORTED_CAPABILITIES[number]

const capabilityLabels: Record<BackupV2Capability, string> = {
  "catalogue.provenance-v2": "procedencia por campo",
  "works.entities": "obras",
  "copies.multiple-per-edition": "varias copias de una misma edición",
  "copies.verification-evidence": "fecha o evidencias de la comprobación física",
  "editions.identifiers": "identificadores externos o idioma de la edición",
  "copies.personal": "notas, valoraciones o etiquetas",
  "copies.locations": "ubicaciones físicas",
  "editions.series": "series",
  "bibliographic.evidence": "evidencias bibliográficas",
  "copies.reading": "ciclos y sesiones de lectura",
  "copies.loans": "préstamos",
}

/** Procedencia bibliográfica de la edición: la de `Book.catalogue` sin la comprobación física. */
export type EditionCatalogueV2 =
  | { schemaVersion?: undefined; source: Exclude<CatalogueMetadata["source"], "bne">; sourceUrl?: string }
  | Omit<Extract<CatalogueMetadata, { schemaVersion: 2 }>, "isbnVerified" | "isbnChecksumValid">

export interface PortableWorkV2 {
  id: string
  title: string
}

/** Evidencia portable: la referencia a una foto lleva su sha256 y solo se conserva si el asset sigue siendo del dueño. */
export type PortableEvidenceV2 = Omit<EvidenceEntry, "photo"> & { photo?: Required<MediaRef> }

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
  series?: EditionSeriesRef
  evidence?: PortableEvidenceV2[]
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
  personal?: CopyPersonal
  location?: CopyLocationRef
  evidence?: PortableEvidenceV2[]
  /** Ciclos de lectura con sus entradas (instantes UTC); nunca deducidos del estado. */
  reading?: ReadingCycle[]
  /** Préstamos con fechas civiles `AAAA-MM-DD`. */
  loans?: Loan[]
}

export interface PortableShelfV2 {
  id: string
  title: string
  isDefault?: boolean
}

export type PortableLocationV2 = Omit<LocationEntry, "photo" | "createdAt"> & { photo?: Required<MediaRef> }

export interface PortableBackupV2 {
  formatVersion: 2
  exportedAt: string
  requiredCapabilities: BackupV2Capability[]
  works: PortableWorkV2[]
  editions: PortableEditionV2[]
  copies: PortableCopyV2[]
  shelves: PortableShelfV2[]
  tags?: Omit<TagEntry, "createdAt">[]
  locations?: PortableLocationV2[]
  series?: Omit<SeriesEntry, "createdAt">[]
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
const hasPersonal = (personal: CopyPersonal | undefined) => Boolean(personal && (personal.notes !== undefined || personal.rating !== undefined || personal.tagIds?.length))

/** Copia sin claves vacías: una evidencia solo exporta la foto con su sha256 (sin él no es portable). */
function portableEvidence(entries: readonly EvidenceEntry[] | undefined): PortableEvidenceV2[] | undefined {
  if (!entries?.length) return undefined
  return entries.map((entry) => {
    const { photo, ...rest } = entry
    return { ...rest, fieldClaims: { ...entry.fieldClaims }, ...(photo?.sha256 ? { photo: { assetId: photo.assetId, sha256: photo.sha256 } } : {}) }
  })
}

function portablePersonal(personal: CopyPersonal | undefined): CopyPersonal | undefined {
  if (!personal || !hasPersonal(personal)) return undefined
  return {
    ...(personal.notes !== undefined ? { notes: personal.notes } : {}),
    ...(personal.rating !== undefined ? { rating: personal.rating } : {}),
    ...(personal.tagIds?.length ? { tagIds: [...personal.tagIds] } : {}),
  }
}

/** Copia de los ciclos sin claves vacías (el escritor no comparte referencias con la colección). */
function portableReading(cycles: readonly ReadingCycle[] | undefined): ReadingCycle[] | undefined {
  if (!cycles?.length) return undefined
  return cycles.map(({ entries, ...cycle }) => ({ ...cycle, ...(entries?.length ? { entries: entries.map((entry) => ({ ...entry })) } : {}) }))
}

/** Edición y copia de una fila: la edición es la de `book.edition` o, en una ficha legacy, la del propio `book.id`. */
export function bookToEditionAndCopy(book: Book): { edition: PortableEditionV2; copy: PortableCopyV2 } {
  const isbn13 = book.isbn ? normalizeIsbn(book.isbn) : null
  const catalogue = editionCatalogue(book.catalogue)
  const editionId = book.edition?.id ?? book.id
  const personal = portablePersonal(book.personal)
  const editionEvidence = portableEvidence(book.edition?.evidence)
  const copyEvidence = portableEvidence(book.evidence)
  const reading = portableReading(book.reading)
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
      ...(book.edition?.series ? { series: { ...book.edition.series } } : {}),
      ...(editionEvidence ? { evidence: editionEvidence } : {}),
    },
    copy: {
      id: book.id, edition_id: editionId, status: book.status, shelf_id: book.shelf_id,
      edition_verification: {
        isbnVerified: Boolean(isbn13) && (book.catalogue?.isbnVerified ?? false),
        ...(book.verification?.checkedAt ? { checkedAt: book.verification.checkedAt } : {}),
        ...(book.verification?.evidenceRefs?.length ? { evidenceRefs: [...book.verification.evidenceRefs] } : {}),
      },
      legacy_identifier: isbn13 ? null : book.legacyIdentifier ?? (book.isbn?.trim() ? book.isbn : null),
      ...(personal ? { personal } : {}),
      ...(book.location ? { location: { ...book.location } } : {}),
      ...(copyEvidence ? { evidence: copyEvidence } : {}),
      ...(reading ? { reading } : {}),
      ...(book.loans?.length ? { loans: book.loans.map((loan) => ({ ...loan })) } : {}),
    },
  }
}

/** Datos de la cuenta (0014) de una colección; vacíos en v1 y en archivos anteriores. */
export type AccountProduct = Pick<LibraryData, "tags" | "locations" | "series">

export function requiredCapabilitiesFor(books: readonly Book[], product: AccountProduct = {}): BackupV2Capability[] {
  const perEdition = new Map<string, number>()
  for (const book of books) perEdition.set(book.edition?.id ?? book.id, (perEdition.get(book.edition?.id ?? book.id) ?? 0) + 1)
  const used: Record<BackupV2Capability, boolean> = {
    "catalogue.provenance-v2": books.some((book) => book.catalogue?.schemaVersion === 2),
    "works.entities": books.some((book) => Boolean(book.edition?.workId)),
    "copies.multiple-per-edition": [...perEdition.values()].some((count) => count > 1),
    "copies.verification-evidence": books.some(hasEvidence),
    "editions.identifiers": books.some((book) => Boolean(book.edition?.language || (book.edition?.identifiers && Object.keys(book.edition.identifiers).length))),
    "copies.personal": books.some((book) => hasPersonal(book.personal)) || Boolean(product.tags?.length),
    "copies.locations": books.some((book) => Boolean(book.location)) || Boolean(product.locations?.length),
    "editions.series": books.some((book) => Boolean(book.edition?.series)) || Boolean(product.series?.length),
    "bibliographic.evidence": books.some((book) => Boolean(book.evidence?.length || book.edition?.evidence?.length)),
    "copies.reading": books.some((book) => Boolean(book.reading?.length)),
    "copies.loans": books.some((book) => Boolean(book.loans?.length)),
  }
  return BACKUP_V2_SUPPORTED_CAPABILITIES.filter((capability) => used[capability])
}

function portableLocations(locations: readonly LocationEntry[] | undefined): PortableLocationV2[] | undefined {
  if (!locations?.length) return undefined
  return locations.map((location) => ({
    id: location.id, name: location.name, kind: location.kind, parentId: location.parentId,
    ...(location.photo?.sha256 ? { photo: { assetId: location.photo.assetId, sha256: location.photo.sha256 } } : {}),
  }))
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
  const locations = portableLocations(data.locations)
  return {
    formatVersion: 2,
    exportedAt: exportedAt.toISOString(),
    requiredCapabilities: requiredCapabilitiesFor(data.books, data),
    works: [...works.values()],
    editions: [...editions.values()],
    copies,
    shelves: data.shelves.map((shelf) => ({ id: shelf.id, title: shelf.title, ...(shelf.isDefault !== undefined ? { isDefault: shelf.isDefault } : {}) })),
    ...(data.tags?.length ? { tags: data.tags.map((tag) => ({ id: tag.id, name: tag.name })) } : {}),
    ...(locations ? { locations } : {}),
    ...(data.series?.length ? { series: data.series.map((entry) => ({ id: entry.id, title: entry.title, ...(entry.description !== undefined ? { description: entry.description } : {}) })) } : {}),
  }
}

/**
 * Indica si la colección necesita el formato 2: procedencia que v1 no conserva (BNE o por campo),
 * varias copias de una edición, obras, evidencias de comprobación, identificadores o idioma de edición,
 * datos de producto de 0014 o un libro sin ISBN ni identificador legacy (v1 exigiría inventarle uno).
 */
export function libraryRequiresV2(data: LibraryData): boolean {
  if (requiredCapabilitiesFor(data.books, data).some((capability) => capability !== "catalogue.provenance-v2")) return true
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

// Secciones de 0014: mismos límites que las restricciones y triggers de la base.
// Longitudes en caracteres (puntos de código), como `char_length` de Postgres; sin espacios en los extremos, como `btrim`.
const chars = (min: number, max: number) => z.string().refine((value) => { const length = [...value].length; return length >= min && length <= max }, "Longitud no válida.")
const trimmedText = (max: number) => chars(1, max).refine((value) => !value.startsWith(" ") && !value.endsWith(" "), "Sin espacios en los extremos.")
const mediaRefSchema = z.object({ assetId: z.uuid(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict()
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
export const personalSchema = z.object({
  notes: chars(1, NOTES_MAX).optional(),
  rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(),
  tagIds: z.array(id).min(1).max(TAG_LIMITS.perCopy).refine((ids) => new Set(ids).size === ids.length, "Etiquetas repetidas.").optional(),
}).strict()
export const locationRefSchema = z.object({
  locationId: id,
  shelfLabel: trimmedText(LOCATION_LIMITS.shelfLabelMax).optional(),
  position: z.number().int().min(1).max(LOCATION_LIMITS.positionMax).optional(),
}).strict()
export const seriesRefSchema = z.object({
  seriesId: id,
  position: z.string().refine((value) => canonicalSeriesPosition(value) === value, "Posición no válida.").optional(),
  volumeLabel: chars(1, SERIES_LIMITS.volumeLabelMax).optional(),
  orderNote: chars(1, SERIES_LIMITS.orderNoteMax).optional(),
}).strict()
export const evidenceSchema = z.object({
  id,
  sourceKind: z.enum(EVIDENCE_SOURCE_KINDS),
  sourceRef: z.string().regex(EVIDENCE_SOURCE_REF_PATTERN).optional(),
  sourceUrl: z.string().regex(/^https?:\/\//).max(EVIDENCE_LIMITS.sourceUrlMax).optional(),
  photo: mediaRefSchema.optional(),
  observedAt: z.iso.datetime({ offset: true }).optional(),
  fieldClaims: z.record(z.string().max(100), z.unknown()).refine((value) => jsonBytes(value) <= EVIDENCE_LIMITS.fieldClaimsBytes, "Afirmaciones demasiado grandes."),
  confidence: z.enum(CONFIDENCE_LABELS),
  origin: z.enum(EVIDENCE_ORIGINS).optional(),
}).strict().refine((value) => !value.photo || value.sourceKind === "photo", "Solo una evidencia de foto cita una foto.")
const evidenceListSchema = z.array(evidenceSchema).min(1).max(EVIDENCE_LIMITS.perSubject)
const tagEntrySchema = z.object({ id, name: z.string().refine(isValidTagName, "Nombre de etiqueta no válido.") }).strict()
const locationEntrySchema = z.object({
  id, name: trimmedText(LOCATION_LIMITS.nameMax), kind: z.enum(LOCATION_KINDS), parentId: id.nullable(), photo: mediaRefSchema.optional(),
}).strict()
const seriesEntrySchema = z.object({
  id, title: trimmedText(SERIES_LIMITS.titleMax), description: chars(1, SERIES_LIMITS.descriptionMax).optional(),
}).strict()

// Secciones de 0015: estructura y límites de la base; las reglas entre campos y entre copias las comprueba
// `assertReadingAndLoans` con un mensaje para la persona.
const instant = z.iso.datetime({ offset: true })
const page = z.number().int().min(0).max(READING_LIMITS.pageMax)
const civilDate = z.string().refine(isCivilDate, "Fecha no válida.")
export const readingEntrySchema = z.object({
  id, occurredAt: instant, pageFrom: page.optional(), pageTo: page.optional(), note: chars(1, READING_LIMITS.noteMax).optional(),
}).strict()
export const readingCycleSchema = z.object({
  id, cycleNumber: z.number().int().min(1).max(READING_LIMITS.cycleNumberMax), status: z.enum(READING_CYCLE_STATUSES),
  startedAt: instant.optional(), finishedAt: instant.optional(), entries: z.array(readingEntrySchema).min(1).max(READING_LIMITS.entriesPerCycle).optional(),
}).strict()
export const loanSchema = z.object({
  id, borrowerLabel: z.string().refine(isValidBorrowerLabel, "Alias no válido."), loanedOn: civilDate, dueOn: civilDate.optional(), returnedOn: civilDate.optional(),
  note: chars(1, LOAN_LIMITS.noteMax).optional(),
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
  series: seriesRefSchema.optional(),
  evidence: evidenceListSchema.optional(),
}).strict()

const copySchema = z.object({
  id, edition_id: id,
  status: z.enum(["read", "reading", "unread", "to-read"]),
  shelf_id: id,
  edition_verification: copyVerificationSchema,
  legacy_identifier: z.string().trim().min(1).max(100).nullable(),
  personal: personalSchema.optional(),
  location: locationRefSchema.optional(),
  evidence: evidenceListSchema.optional(),
  reading: z.array(readingCycleSchema).min(1).max(READING_LIMITS.cyclesPerCopy).optional(),
  loans: z.array(loanSchema).min(1).max(LOAN_LIMITS.perCopy).optional(),
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
  tags: z.array(z.unknown()).max(TAG_LIMITS.perAccount).optional(),
  locations: z.array(z.unknown()).max(LOCATION_LIMITS.perAccount).optional(),
  series: z.array(z.unknown()).max(SERIES_LIMITS.perAccount).optional(),
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
    book.cover, editionCatalogue(book.catalogue) ?? null, book.edition?.workId ?? null, book.edition?.language ?? null, book.edition?.identifiers ?? null,
    book.edition?.series ?? null, book.edition?.evidence ?? null])
}

/**
 * Comprueba que las referencias de ejemplares y ediciones a etiquetas, ubicaciones y series existen en la misma colección
 * y que el árbol de ubicaciones no tiene ciclos ni más niveles de los admitidos. Lo usan el lector v2 y la validación de
 * cada parte; lanza `BackupFormatError` con explicación.
 */
export function assertProductReferences(books: readonly Book[], product: AccountProduct): void {
  const unique = <T extends { id: string }>(items: readonly T[] | undefined, label: string) => {
    const ids = new Set<string>()
    for (const item of items ?? []) {
      if (ids.has(item.id)) throw new BackupFormatError(`El archivo contiene ${label} con el mismo identificador.`)
      ids.add(item.id)
    }
    return ids
  }
  const tagIds = unique(product.tags, "etiquetas")
  const names = new Set<string>()
  for (const tag of product.tags ?? []) {
    const normalized = normalizeTagName(tag.name)
    if (names.has(normalized)) throw new BackupFormatError(`El archivo contiene dos etiquetas equivalentes («${tag.name}»): mayúsculas y acentos no distinguen etiquetas.`)
    names.add(normalized)
  }
  const locationIds = unique(product.locations, "ubicaciones")
  const seriesIds = unique(product.series, "series")
  const parents = new Map((product.locations ?? []).map((location) => [location.id, location.parentId]))
  for (const location of product.locations ?? []) {
    let cursor = location.parentId
    let depth = 1
    while (cursor !== null) {
      if (!parents.has(cursor)) throw new BackupFormatError(`La ubicación «${location.name}» cuelga de una ubicación que no está en el archivo.`)
      if (cursor === location.id) throw new BackupFormatError(`La ubicación «${location.name}» está dentro de sí misma.`)
      if (++depth > LOCATION_LIMITS.maxDepth) throw new BackupFormatError(`Las ubicaciones del archivo tienen más de ${LOCATION_LIMITS.maxDepth} niveles o un ciclo.`)
      cursor = parents.get(cursor) ?? null
    }
  }
  for (const book of books) {
    for (const tagId of book.personal?.tagIds ?? []) if (!tagIds.has(tagId)) throw new BackupFormatError(`La copia de «${book.title}» cita una etiqueta que no está en el archivo.`)
    if (book.location && !locationIds.has(book.location.locationId)) throw new BackupFormatError(`La copia de «${book.title}» cita una ubicación que no está en el archivo.`)
    if (book.edition?.series && !seriesIds.has(book.edition.series.seriesId)) throw new BackupFormatError(`La edición de «${book.title}» cita una serie que no está en el archivo.`)
    if (book.edition?.evidence?.some((entry) => entry.confidence === "physically_checked")) {
      throw new BackupFormatError(`La edición de «${book.title}» tiene una comprobación física: solo un ejemplar concreto puede estar comprobado.`)
    }
  }
}

/**
 * Reglas de lectura y préstamos de cada copia (las mismas de 0015): ciclos con número único y como mucho uno abierto, sin
 * fin en uno abierto ni fin antes del inicio; entradas con página o nota, desde ≤ hasta y nunca por encima del total
 * conocido de la edición; préstamos con vencimiento y devolución no anteriores a la salida y como mucho uno activo; IDs
 * únicos en todo el archivo. Lanza `BackupFormatError` con explicación.
 */
export function assertReadingAndLoans(books: readonly Book[]): void {
  const ids = new Set<string>()
  const once = (value: string, label: string) => {
    if (ids.has(value)) throw new BackupFormatError(`El archivo contiene ${label} con el mismo identificador.`)
    ids.add(value)
  }
  for (const book of books) {
    const numbers = new Set<number>()
    let open = 0
    for (const cycle of book.reading ?? []) {
      once(`cycle:${cycle.id}`, "ciclos de lectura")
      if (numbers.has(cycle.cycleNumber)) throw new BackupFormatError(`La copia de «${book.title}» repite la lectura número ${cycle.cycleNumber}.`)
      numbers.add(cycle.cycleNumber)
      if (isOpenReadingStatus(cycle.status) && ++open > 1) throw new BackupFormatError(`La copia de «${book.title}» tiene más de una lectura en curso: solo puede haber una.`)
      if (isOpenReadingStatus(cycle.status) && cycle.finishedAt) throw new BackupFormatError(`La lectura en curso de «${book.title}» tiene fecha de fin.`)
      if (cycle.startedAt && cycle.finishedAt && Date.parse(cycle.finishedAt) < Date.parse(cycle.startedAt)) {
        throw new BackupFormatError(`Una lectura de «${book.title}» termina antes de empezar.`)
      }
      for (const entry of cycle.entries ?? []) {
        once(`entry:${entry.id}`, "entradas de lectura")
        if (entry.pageTo === undefined && entry.note === undefined) throw new BackupFormatError(`Una entrada de lectura de «${book.title}» no tiene página ni nota.`)
        if (entry.pageFrom !== undefined && (entry.pageTo === undefined || entry.pageFrom > entry.pageTo)) {
          throw new BackupFormatError(`Una entrada de lectura de «${book.title}» empieza en una página posterior a la final.`)
        }
        if (entry.pageTo !== undefined && book.number_of_pages > 0 && entry.pageTo > book.number_of_pages) {
          throw new BackupFormatError(`Una entrada de lectura de «${book.title}» llega a la página ${entry.pageTo}, por encima de las ${book.number_of_pages} de su edición.`)
        }
      }
    }
    let active = 0
    for (const loan of book.loans ?? []) {
      once(`loan:${loan.id}`, "préstamos")
      if ((loan.dueOn && loan.dueOn < loan.loanedOn) || (loan.returnedOn && loan.returnedOn < loan.loanedOn)) {
        throw new BackupFormatError(`Un préstamo de «${book.title}» vence o se devuelve antes de prestarse.`)
      }
      if (loan.returnedOn === undefined && ++active > 1) throw new BackupFormatError(`La copia de «${book.title}» tiene más de un préstamo activo: solo puede haber uno.`)
    }
  }
}

/**
 * Lector v2. Devuelve filas planas (una por ejemplar, con la clave de su edición y su obra) que pasan por
 * las mismas validaciones que v1 (duplicados, estanterías, límites), y las etiquetas, ubicaciones y series de
 * la cuenta. Rechaza con explicación lo que no puede conservar o no declara, en lugar de truncarlo.
 */
export function readBackupV2(input: unknown): Required<Pick<LibraryData, "books" | "shelves">> & AccountProduct {
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
  const tags = data.tags?.map((entry, index) => parseEntry(tagEntrySchema, entry, `La etiqueta ${index + 1}`))
  const locations = data.locations?.map((entry, index) => parseEntry(locationEntrySchema, entry, `La ubicación ${index + 1}`))
  const series = data.series?.map((entry, index) => parseEntry(seriesEntrySchema, entry, `La serie ${index + 1}`))

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
    ["copies.personal", copies.some((copy) => copy.personal !== undefined) || tags !== undefined],
    ["copies.locations", copies.some((copy) => copy.location !== undefined) || locations !== undefined],
    ["editions.series", editions.some((edition) => edition.series !== undefined) || series !== undefined],
    ["bibliographic.evidence", editions.some((edition) => edition.evidence !== undefined) || copies.some((copy) => copy.evidence !== undefined)],
    ["copies.reading", copies.some((copy) => copy.reading !== undefined)],
    ["copies.loans", copies.some((copy) => copy.loans !== undefined)],
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
      ...(edition.id !== copy.id || work || edition.language || edition.identifiers || edition.series || edition.evidence || (copiesPerEdition.get(edition.id) ?? 0) > 1 ? { edition: {
        id: edition.id,
        ...(work ? { workId: work.id, workTitle: work.title } : {}),
        ...(edition.language ? { language: edition.language } : {}),
        ...(edition.identifiers ? { identifiers: edition.identifiers } : {}),
        ...(edition.series ? { series: edition.series } : {}),
        ...(edition.evidence ? { evidence: edition.evidence } : {}),
      } } : {}),
      ...(Object.keys(evidence).length ? { verification: evidence } : {}),
      ...(copy.personal ? { personal: copy.personal } : {}),
      ...(copy.location ? { location: copy.location } : {}),
      ...(copy.evidence ? { evidence: copy.evidence } : {}),
      ...(copy.reading ? { reading: copy.reading } : {}),
      ...(copy.loans ? { loans: copy.loans } : {}),
    }
  })
  const product: AccountProduct = { ...(tags ? { tags } : {}), ...(locations ? { locations } : {}), ...(series ? { series } : {}) }
  assertProductReferences(books, product)
  assertReadingAndLoans(books)
  return { books, shelves: shelves.map((shelf) => ({ ...shelf, book_count: 0 })), ...product }
}

/** Secciones de la cuenta de una colección (para escritores y partes): siempre presentes, quizá vacías. */
export function accountProduct(data: LibraryData): Required<AccountProduct> {
  return { tags: data.tags ?? [], locations: data.locations ?? [], series: data.series ?? [] }
}

