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

export interface Book {
  id: string
  /** Token de edición de la ficha persistida; ausente en catálogos y respaldos antiguos. */
  version?: string
  isbn: string
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
  catalogue?: CatalogueMetadata
}

export interface Shelf {
  id: string
  title: string
  book_count: number
  isDefault?: boolean
}

export interface LibraryData {
  books: Book[]
  shelves: Shelf[]
}
