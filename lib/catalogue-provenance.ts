import { z } from "zod"
import { DomainError } from "./domain-errors"
import { normalizeIsbn } from "./isbn"
import type {
  Book, CatalogueAttributionV2, CatalogueMetadata, CatalogueMetadataV1, CatalogueSourceV1, FieldProvenance,
  ProvenanceField, ProvenanceProvider,
} from "./types"

// Procedencia de la ficha (U-BIB-04). Lectores compatibles con `catalogue` legacy (v1, sin
// `schemaVersion`) y con `catalogue.schemaVersion: 2`. Funciones puras: cliente y servidor.

export const CATALOGUE_SOURCES_V1 = ["manual", "open-library", "photo", "import"] as const satisfies readonly CatalogueSourceV1[]
export const PROVENANCE_PROVIDERS = [...CATALOGUE_SOURCES_V1, "bne"] as const satisfies readonly ProvenanceProvider[]
export const PROVENANCE_FIELDS = ["title", "subtitle", "authors", "publishers", "publish_date", "number_of_pages", "cover"] as const satisfies readonly ProvenanceField[]
export const PROVENANCE_SELECTIONS = ["user-selected", "manually-verified", "unverified"] as const

const httpsUrl = z.url().max(2_048).refine((value) => new URL(value).protocol === "https:")

export const fieldProvenanceSchema = z.object({
  provider: z.enum(PROVENANCE_PROVIDERS),
  sourceUrl: httpsUrl.optional(),
  recordId: z.string().trim().min(1).max(500).optional(),
  retrievedAt: z.iso.datetime().optional(),
  selection: z.enum(PROVENANCE_SELECTIONS),
}).strict()

const fieldsSchema = z.object({
  title: fieldProvenanceSchema.optional(),
  subtitle: fieldProvenanceSchema.optional(),
  authors: fieldProvenanceSchema.optional(),
  publishers: fieldProvenanceSchema.optional(),
  publish_date: fieldProvenanceSchema.optional(),
  number_of_pages: fieldProvenanceSchema.optional(),
  cover: fieldProvenanceSchema.optional(),
}).strict()

/** v1 legacy: los writers solo han escrito estas tres claves; cualquier otra se rechaza en lugar de descartarla. */
export const catalogueV1Schema = z.object({
  source: z.enum(CATALOGUE_SOURCES_V1),
  isbnVerified: z.boolean().default(false),
  sourceUrl: httpsUrl.optional(),
}).strict()

export const catalogueV2Schema = z.object({
  schemaVersion: z.literal(2),
  source: z.enum(PROVENANCE_PROVIDERS),
  isbnVerified: z.boolean().default(false),
  // Se acepta por compatibilidad, pero siempre se vuelve a derivar del ISBN al leer.
  isbnChecksumValid: z.boolean().optional(),
  sourceUrl: httpsUrl.optional(),
  fields: fieldsSchema.optional(),
}).strict()

export const catalogueSchema = z.union([catalogueV2Schema, catalogueV1Schema])
export type CatalogueInput = z.input<typeof catalogueSchema>

const providerLabels: Record<ProvenanceProvider, string> = {
  manual: "Entrada manual",
  "open-library": "Open Library",
  bne: "Biblioteca Nacional de España (BNE)",
  photo: "Fotografías del ejemplar",
  import: "Importación",
}

export const provenanceFieldLabels: Record<ProvenanceField, string> = {
  title: "Título", subtitle: "Subtítulo", authors: "Autoría", publishers: "Editoriales",
  publish_date: "Fecha editorial", number_of_pages: "Páginas", cover: "Portada",
}

const selectionLabels: Record<FieldProvenance["selection"], string> = {
  "user-selected": "elegido por ti",
  "manually-verified": "comprobado en tu ejemplar",
  unverified: "sin revisar",
}

const isKnownProvider = (value: unknown): value is ProvenanceProvider =>
  typeof value === "string" && (PROVENANCE_PROVIDERS as readonly string[]).includes(value)

/** Nombre visible de una fuente. Un valor desconocido se muestra tal cual, nunca como «manual». */
export function provenanceProviderLabel(provider: string): string {
  return isKnownProvider(provider) ? providerLabels[provider] : `Fuente no reconocida («${provider.slice(0, 40)}»)`
}

export function provenanceSelectionLabel(selection: FieldProvenance["selection"]): string {
  return selectionLabels[selection]
}

function describeUnknownProvider(value: unknown): string {
  if (value === "google-books") return "Google Books todavía no es una fuente admitida en la procedencia: su lector y validador no existen en esta versión."
  return `La fuente «${String(value).slice(0, 40)}» no es reconocida. No se convierte en «manual»: corrige el archivo o actualiza BibLib.`
}

/**
 * Explica por qué un objeto `catalogue` no se puede leer sin pérdida; `null` si no hay un problema
 * de fuente o versión (el resto lo valida el schema). Así ningún valor desconocido se degrada en silencio.
 */
export function catalogueProblem(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if ("schemaVersion" in record && record.schemaVersion !== 2) {
    return `La versión de procedencia «${String(record.schemaVersion).slice(0, 20)}» no es compatible. Se admiten la procedencia legacy y la versión 2.`
  }
  const v2 = record.schemaVersion === 2
  if ("source" in record && !(v2 ? isKnownProvider(record.source) : (CATALOGUE_SOURCES_V1 as readonly unknown[]).includes(record.source))) {
    return record.source === "bne" ? "La fuente BNE solo se admite con procedencia versión 2." : describeUnknownProvider(record.source)
  }
  if (!v2 && "fields" in record) return "La procedencia por campo requiere «schemaVersion: 2»; no se descarta en silencio."
  const fields = record.fields
  if (v2 && fields && typeof fields === "object" && !Array.isArray(fields)) {
    for (const [field, provenance] of Object.entries(fields)) {
      if (!(PROVENANCE_FIELDS as readonly string[]).includes(field)) return `El campo de procedencia «${field.slice(0, 40)}» no se puede conservar en esta versión.`
      if (provenance && typeof provenance === "object" && "provider" in provenance && !isKnownProvider(provenance.provider)) {
        return describeUnknownProvider(provenance.provider)
      }
    }
  }
  return null
}

const hasFields = (catalogue: CatalogueMetadata | undefined): catalogue is CatalogueAttributionV2 & { fields: NonNullable<CatalogueAttributionV2["fields"]> } =>
  catalogue?.schemaVersion === 2 && Boolean(catalogue.fields && Object.keys(catalogue.fields).length)

/**
 * Forma canónica para guardar: `isbnVerified` solo con ISBN válido, sin `isbnChecksumValid`
 * (derivado) y sin `fields` vacío. No cambia la fuente ni añade procedencia.
 */
export function normalizeCatalogue(value: z.output<typeof catalogueSchema>, isbn: string | null): CatalogueMetadata {
  const isbnVerified = Boolean(normalizeIsbn(isbn ?? "")) && value.isbnVerified
  const sourceUrl = value.sourceUrl ? { sourceUrl: value.sourceUrl } : {}
  if (!("schemaVersion" in value)) return { source: value.source, isbnVerified, ...sourceUrl }
  const fields = Object.fromEntries(PROVENANCE_FIELDS.flatMap((field) => value.fields?.[field] ? [[field, value.fields[field]]] : []))
  return { schemaVersion: 2, source: value.source, isbnVerified, ...sourceUrl, ...(Object.keys(fields).length ? { fields } : {}) }
}

export interface CatalogueView {
  schemaVersion: 1 | 2
  source: string
  sourceLabel: string
  sourceKnown: boolean
  /** Confirmación humana frente al ejemplar físico; `false` si no hay valor legacy. */
  isbnVerified: boolean
  /** Dígito de control válido. No equivale a comprobar el ejemplar. */
  isbnChecksumValid: boolean
  sourceUrl?: string
  fields: Partial<Record<ProvenanceField, FieldProvenance>>
}

/** Lector tolerante para mostrar fichas guardadas: deriva el checksum y nunca reclasifica la fuente. */
export function readCatalogueView(catalogue: unknown, isbn: string | null): CatalogueView {
  const record = catalogue && typeof catalogue === "object" && !Array.isArray(catalogue) ? catalogue as Record<string, unknown> : {}
  const source = typeof record.source === "string" ? record.source : "import"
  const parsedFields = record.schemaVersion === 2 ? fieldsSchema.safeParse(record.fields ?? {}) : undefined
  const sourceUrl = typeof record.sourceUrl === "string" && httpsUrl.safeParse(record.sourceUrl).success ? record.sourceUrl : undefined
  const checksum = Boolean(normalizeIsbn(isbn ?? ""))
  return {
    schemaVersion: record.schemaVersion === 2 ? 2 : 1,
    source, sourceLabel: provenanceProviderLabel(source), sourceKnown: isKnownProvider(source),
    isbnVerified: checksum && record.isbnVerified === true,
    isbnChecksumValid: checksum,
    ...(sourceUrl ? { sourceUrl } : {}),
    fields: parsedFields?.success ? parsedFields.data : {},
  }
}

/** Una ficha con procedencia que v1 no representa (BNE o fuentes por campo) exige el formato 2. */
export function catalogueRequiresV2(catalogue: CatalogueMetadata | undefined): boolean {
  if (catalogue?.schemaVersion !== 2) return false
  return !(CATALOGUE_SOURCES_V1 as readonly string[]).includes(catalogue.source) || hasFields(catalogue)
}

/** Conversión sin pérdida a v1; lanza si la ficha necesita el formato 2. */
export function toCatalogueV1(catalogue: CatalogueMetadata): CatalogueMetadataV1 {
  if (catalogueRequiresV2(catalogue)) throw new Error("Esta procedencia necesita el formato 2.")
  return { source: catalogue.source as CatalogueSourceV1, isbnVerified: catalogue.isbnVerified, ...(catalogue.sourceUrl ? { sourceUrl: catalogue.sourceUrl } : {}) }
}

type BookFieldSource = Pick<Book, "title" | "subtitle" | "authors" | "publishers" | "publish_date" | "number_of_pages" | "cover">

/** Valor comparable de un campo, para saber si una edición lo ha cambiado. */
export function provenanceFieldValue(book: BookFieldSource, field: ProvenanceField): string {
  switch (field) {
    case "title": return book.title.trim()
    case "subtitle": return (book.subtitle ?? "").trim()
    case "authors": return JSON.stringify(book.authors.map((author) => author.name.trim()))
    case "publishers": return JSON.stringify((book.publishers ?? []).map((publisher) => publisher.name.trim()))
    case "publish_date": return book.publish_date.trim()
    case "number_of_pages": return String(book.number_of_pages)
    case "cover": return book.cover.large
  }
}

/**
 * Alta: con la revisión bibliográfica apagada se escribe v1 como hasta ahora y una procedencia v2
 * se rechaza (no se recorta). Con la revisión activa se guarda la procedencia elegida.
 */
export function catalogueForCreate(catalogue: CatalogueMetadata, reviewEnabled: boolean): CatalogueMetadata {
  if (catalogue.schemaVersion === 2 && !reviewEnabled) {
    throw new DomainError("INVALID_INPUT", "La revisión bibliográfica no está activada: no se puede guardar procedencia por campo.")
  }
  return catalogue
}

/**
 * Edición: la procedencia sale de la ficha guardada (bajo bloqueo y con su versión), nunca del
 * cliente. Los campos cambiados pasan a «manual»; los demás conservan su fuente. Una ficha v2
 * sigue siendo v2 aunque la revisión se apague, para no borrar procedencia.
 */
export function catalogueForUpdate(current: BookFieldSource & { isbn: string | null; catalogue?: CatalogueMetadata }, next: BookFieldSource & { isbn: string | null; catalogue: CatalogueMetadata }, reviewEnabled: boolean): CatalogueMetadata {
  const stored = current.catalogue ?? { source: "import" as const, isbnVerified: false }
  const isbnVerified = Boolean(normalizeIsbn(next.isbn ?? "")) && next.catalogue.isbnVerified
  const sourceUrl = stored.sourceUrl ? { sourceUrl: stored.sourceUrl } : {}
  const changed = PROVENANCE_FIELDS.filter((field) => provenanceFieldValue(current, field) !== provenanceFieldValue(next, field))
  if (stored.schemaVersion !== 2 && (!reviewEnabled || changed.length === 0)) {
    return { source: stored.source, isbnVerified, ...sourceUrl }
  }
  const fields: Partial<Record<ProvenanceField, FieldProvenance>> = { ...(stored.schemaVersion === 2 ? stored.fields : {}) }
  for (const field of changed) fields[field] = { provider: "manual", selection: "user-selected" }
  return { schemaVersion: 2, source: stored.source, isbnVerified, ...sourceUrl, ...(Object.keys(fields).length ? { fields } : {}) }
}

/** Sustituye la procedencia de un campo (p. ej. portada recuperada) sin activar v2 si la revisión está apagada. */
export function catalogueWithField(catalogue: CatalogueMetadata | undefined, field: ProvenanceField, provenance: FieldProvenance, reviewEnabled: boolean): CatalogueMetadata {
  const stored = catalogue ?? { source: "import" as const, isbnVerified: false }
  if (stored.schemaVersion !== 2 && !reviewEnabled) return stored
  return { ...stored, schemaVersion: 2, fields: { ...(stored.schemaVersion === 2 ? stored.fields : {}), [field]: provenance } }
}
