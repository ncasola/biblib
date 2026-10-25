import type { CopyLocationRef, CopyPersonal, EditionSeriesRef, LocationEntry, SeriesEntry, TagEntry } from "./product/contracts"
import type { EvidenceEntry } from "./review/contracts"

export interface Author {
  name: string
  url?: string
}

export interface Publisher {
  name: string
}

/** Fuentes del objeto `catalogue` legacy (v1, sin `schemaVersion`). */
export type CatalogueSourceV1 = "manual" | "open-library" | "photo" | "import"

/**
 * Fuentes admitidas en la procedencia ampliada. `google-books` se añadirá cuando exista su lector
 * y validador (U-BIB-03): hasta entonces se rechaza con explicación, nunca se reclasifica.
 */
export type ProvenanceProvider = CatalogueSourceV1 | "bne"

export type ProvenanceField = "title" | "subtitle" | "authors" | "publishers" | "publish_date" | "number_of_pages" | "cover"

export interface FieldProvenance {
  provider: ProvenanceProvider
  sourceUrl?: string
  recordId?: string
  retrievedAt?: string
  selection: "user-selected" | "manually-verified" | "unverified"
}

/** Procedencia legacy: una fuente para toda la ficha. La ausencia de `isbnVerified` se lee como `false`. */
export interface CatalogueMetadataV1 {
  schemaVersion?: undefined
  source: CatalogueSourceV1
  /** La persona confirmó el ISBN frente a su ejemplar físico. Un proveedor o el checksum nunca lo activan. */
  isbnVerified: boolean
  sourceUrl?: string
}

/** `catalogue.schemaVersion: 2`: conserva la fuente primaria y añade procedencia por campo. */
export interface CatalogueAttributionV2 {
  schemaVersion: 2
  source: ProvenanceProvider
  isbnVerified: boolean
  /** Derivado de `normalizeIsbn` al leer; no se persiste ni equivale a comprobar el ejemplar. */
  isbnChecksumValid?: boolean
  sourceUrl?: string
  fields?: Partial<Record<ProvenanceField, FieldProvenance>>
}

export type CatalogueMetadata = CatalogueMetadataV1 | CatalogueAttributionV2

/**
 * Procedencia bibliográfica de una edición (U-DAT-06): la de `catalogue` sin la comprobación física,
 * que pertenece a cada ejemplar. `isbnChecksumValid` se conserva si venía, pero siempre se deriva al leer.
 */
export type EditionCatalogue =
  | Omit<CatalogueMetadataV1, "isbnVerified">
  | Omit<CatalogueAttributionV2, "isbnVerified">

/** Comprobación humana del ISBN frente a un ejemplar concreto. Ningún proveedor ni checksum la activa. */
export interface CopyVerification {
  isbnVerified: boolean
  /** Momento de la comprobación (ISO 8601), si se registró. */
  checkedAt?: string
  /** Referencias opacas a la evidencia (p. ej. una foto propia); nunca URL firmadas. */
  evidenceRefs?: string[]
}

/** Identificadores externos de una edición por esquema (`openLibrary`, `bne`, `oclc`…); el ISBN-13 va aparte. */
export type EditionIdentifiers = Record<string, string[]>

/** Edición a la que pertenece un ejemplar (U-DAT-06). En una importación, `id` es la clave de agrupación del archivo. */
export interface BookEdition {
  id: string
  /** Token de la edición; ausente en archivos importados. Autoriza solo los campos bibliográficos. */
  version?: string
  /** Ejemplares de la cuenta que comparten esta edición (incluido este). */
  copies?: number
  workId?: string
  workTitle?: string
  language?: string
  identifiers?: EditionIdentifiers
  /** Serie de la edición (U-PRO-05, 0014): cero o una, con su posición exacta. */
  series?: EditionSeriesRef
  /** Evidencias bibliográficas de la edición (U-DAT-07, 0014). */
  evidence?: EvidenceEntry[]
}

/**
 * DTO plano de un ejemplar para la interfaz (U-DAT-06): un ejemplar (`copies`) con la descripción de su
 * edición. `id` es el ID del ejemplar, que conserva el de la ficha legacy. La descripción bibliográfica
 * pertenece a la edición y puede compartirse entre varios ejemplares; estado, estantería y comprobación
 * física son de cada ejemplar.
 */
export interface Book {
  id: string
  /**
   * Token plano de la ficha persistida: cambia cuando cambia el ejemplar o su edición. Protege las
   * operaciones sobre una ficha; nunca autoriza por sí solo cambiar una edición compartida.
   */
  version?: string
  /** Token del ejemplar: estado, estantería y comprobación física. */
  copyVersion?: string
  /** ISBN-13 canónico de la edición, o `null` si el libro no tiene ISBN. Nunca un identificador inventado. */
  isbn: string | null
  /** Identificador legacy del ejemplar (`manual-…` u otro valor anterior que no es un ISBN); no se edita. */
  legacyIdentifier?: string
  edition?: BookEdition
  /** Fecha y evidencias de la comprobación física; el indicador está en `catalogue.isbnVerified`. */
  verification?: Omit<CopyVerification, "isbnVerified">
  title: string
  subtitle?: string
  authors: Author[]
  number_of_pages: number
  publish_date: string
  publishers?: Publisher[]
  cover: {
    small: string
    medium: string
    large: string
  }
  status: "read" | "reading" | "unread" | "to-read"
  shelf_id: string
  shelf_name: string
  /** Procedencia de la edición; `catalogue.isbnVerified` se deriva del ejemplar, no de la edición compartida. */
  catalogue?: CatalogueMetadata
  /**
   * Portada privada validada (U-DAT-10) de la edición. La portada visible es la de `displayCover`; `cover`
   * conserva las URL originales, que son las que se editan y exportan.
   */
  coverAssetId?: string
  /** Nota, valoración y etiquetas del ejemplar (U-PRO-01, 0014); ausente si no tiene ninguna. */
  personal?: CopyPersonal
  /** Ubicación física actual del ejemplar (U-PRO-03, 0014); la estantería lógica es `shelf_id`. */
  location?: CopyLocationRef
  /** Evidencias bibliográficas del ejemplar, como su comprobación física (U-DAT-07, 0014). */
  evidence?: EvidenceEntry[]
}

export interface Shelf {
  id: string
  title: string
  book_count: number
  isDefault?: boolean
}

/** Colección plana: `books` tiene un elemento por ejemplar (varios pueden compartir `edition.id`). */
export interface LibraryData {
  books: Book[]
  shelves: Shelf[]
  /**
   * Etiquetas, ubicaciones y series de la cuenta (0014). Los ejemplares y ediciones las citan por ID; también se
   * conservan las que nadie cita. Ausentes en v1 y en archivos anteriores: se importan vacías, sin inventar datos.
   */
  tags?: TagEntry[]
  locations?: LocationEntry[]
  series?: SeriesEntry[]
}
