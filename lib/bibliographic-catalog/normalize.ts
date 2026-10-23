import { z } from "zod"
import { normalizeIsbn } from "../isbn"
import type { OpenLibraryRecord } from "../open-library"
import type { Author, Book, FieldProvenance, Publisher } from "../types"
import { DEFAULT_BOOK_COVER } from "../book-covers"
import type { BibliographicCandidate, CoverCandidate } from "./types"

export function httpsUrl(value?: string): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined
  } catch { return undefined }
}

const candidateSchema = z.object({
  provider: z.enum(["open-library", "bne", "google-books"]), level: z.enum(["work", "edition"]),
  recordId: z.string().max(500).optional(), sourceUrl: z.string().optional(),
  isbns: z.array(z.string().max(100)).max(100), title: z.string().max(500).optional(), subtitle: z.string().max(1000).optional(),
  authors: z.array(z.object({ name: z.string().min(1).max(200), sourceUrl: z.string().optional() })).max(30),
  publishers: z.array(z.object({ name: z.string().min(1).max(200) })).max(20),
  language: z.string().max(100).optional(), format: z.string().max(100).optional(), publishDate: z.string().max(100).optional(),
  numberOfPages: z.number().int().min(0).max(100000).optional(), coverUrl: z.string().optional(),
  evidence: z.object({ isbnExact: z.boolean(), languageCompatible: z.boolean().optional(), formatCompatible: z.boolean().optional() }),
  retrievedAt: z.iso.datetime(),
})

export function normalizeCandidate(value: unknown, isbn?: string): BibliographicCandidate {
  const candidate = candidateSchema.parse(value)
  return { ...candidate, isbns: [...new Set(candidate.isbns)], sourceUrl: httpsUrl(candidate.sourceUrl), coverUrl: httpsUrl(candidate.coverUrl),
    authors: candidate.authors.map((author) => ({ ...author, sourceUrl: httpsUrl(author.sourceUrl) })),
    evidence: { ...candidate.evidence, isbnExact: Boolean(isbn && candidate.isbns.some((original) => normalizeIsbn(original) === isbn)) } }
}

export function fromOpenLibrary(record: OpenLibraryRecord, isbn: string, retrievedAt = new Date().toISOString()): BibliographicCandidate {
  const identifiers = [...(record.identifiers?.isbn_10 ?? []), ...(record.identifiers?.isbn_13 ?? [])]
  // La clave ISBN de Books API es un identificador publicado; no se infiere del título.
  const isbns = identifiers.length ? identifiers : [isbn]
  const sourceUrl = record.url?.replace(/^http:\/\/openlibrary\.org\//, "https://openlibrary.org/")
  const cover = record.cover?.large ?? record.cover?.medium ?? record.cover?.small
  return normalizeCandidate({
    provider: "open-library", level: "edition", recordId: record.identifiers?.openlibrary?.[0] ?? sourceUrl?.match(/\/books\/([^/]+)/)?.[1],
    sourceUrl, isbns, title: record.title, subtitle: record.subtitle,
    authors: (record.authors ?? []).map((author) => ({ name: author.name, sourceUrl: author.url })),
    publishers: record.publishers ?? [], language: record.languages?.[0]?.key.split("/").at(-1), format: record.physical_format,
    publishDate: record.publish_date, numberOfPages: record.number_of_pages,
    coverUrl: cover?.replace(/^http:\/\/covers\.openlibrary\.org\//, "https://covers.openlibrary.org/"),
    evidence: { isbnExact: false }, retrievedAt,
  }, isbn)
}

export interface CandidateComparison {
  canCombine: boolean
  evidence: { isbnExact: boolean; languageCompatible?: boolean; formatCompatible?: boolean }
  conflicts: { field: string; values: [unknown, unknown] }[]
}

/** No fusiona ni elige: conserva ambos valores para la revisión humana. */
export function compareCandidates(left: BibliographicCandidate, right: BibliographicCandidate): CandidateComparison {
  const isbns = new Set(left.isbns.map(normalizeIsbn).filter((value) => value !== null))
  const isbnExact = right.isbns.some((value) => { const isbn = normalizeIsbn(value); return isbn !== null && isbns.has(isbn) })
  const compatible = (a?: string, b?: string) => a && b ? a.trim().toLowerCase() === b.trim().toLowerCase() : undefined
  const languageCompatible = compatible(left.language, right.language)
  const formatCompatible = compatible(left.format, right.format)
  const conflicts: CandidateComparison["conflicts"] = []
  for (const field of ["title", "subtitle", "authors", "publishers", "publishDate", "numberOfPages", "language", "format"] as const) {
    if (left[field] !== undefined && right[field] !== undefined && JSON.stringify(left[field]) !== JSON.stringify(right[field])) conflicts.push({ field, values: [left[field], right[field]] })
  }
  return { canCombine: isbnExact && languageCompatible !== false && formatCompatible !== false, evidence: { isbnExact, languageCompatible, formatCompatible }, conflicts }
}

/** Compatibilidad temporal con la respuesta pública del endpoint anterior. */
export function candidateToLegacyBook(candidate: BibliographicCandidate, isbn: string, coverUrl?: string): Book {
  const cover = httpsUrl(coverUrl) ?? DEFAULT_BOOK_COVER
  return {
    id: `book-${isbn}`, isbn, title: candidate.title ?? "", subtitle: candidate.subtitle,
    authors: candidate.authors.length ? candidate.authors.map((author) => ({ name: author.name, ...(author.sourceUrl ? { url: author.sourceUrl } : {}) })) : [{ name: "Autor desconocido" }],
    publishers: candidate.publishers.length ? candidate.publishers : undefined,
    number_of_pages: candidate.numberOfPages ?? 0, publish_date: candidate.publishDate ?? "",
    cover: { small: cover, medium: cover, large: cover }, status: "to-read", shelf_id: "", shelf_name: "Predeterminada",
    ...(candidate.provider === "open-library" ? { catalogue: { source: "open-library" as const, isbnVerified: false, ...(candidate.sourceUrl ? { sourceUrl: candidate.sourceUrl } : {}) } } : {}),
  }
}

/** Campos de ficha que aporta un candidato, con la forma de `Book`. Un valor ausente queda `undefined`. */
export interface CandidateBookFields {
  title?: string
  subtitle?: string
  authors?: Author[]
  publishers?: Publisher[]
  publish_date?: string
  number_of_pages?: number
}

export function candidateBookFields(candidate: BibliographicCandidate): CandidateBookFields {
  const text = (value?: string) => value?.trim() || undefined
  return {
    title: text(candidate.title),
    subtitle: text(candidate.subtitle),
    authors: candidate.authors.length ? candidate.authors.map((author) => ({ name: author.name.trim(), ...(author.sourceUrl ? { url: author.sourceUrl } : {}) })) : undefined,
    publishers: candidate.publishers.length ? candidate.publishers.map((publisher) => ({ name: publisher.name.trim() })) : undefined,
    publish_date: text(candidate.publishDate),
    number_of_pages: candidate.numberOfPages ? candidate.numberOfPages : undefined,
  }
}

/**
 * Procedencia por campo de un candidato elegido por la persona. `null` para fuentes cuyo lector y
 * validador aún no existen (Google Books, U-BIB-03): sus datos no se pueden guardar.
 */
export function candidateProvenance(candidate: BibliographicCandidate): FieldProvenance | null {
  if (candidate.provider === "google-books") return null
  return {
    provider: candidate.provider,
    ...(httpsUrl(candidate.sourceUrl) ? { sourceUrl: httpsUrl(candidate.sourceUrl) } : {}),
    ...(candidate.recordId ? { recordId: candidate.recordId } : {}),
    retrievedAt: candidate.retrievedAt,
    selection: "user-selected",
  }
}

/** Procedencia de una portada elegida; Google nunca se persiste (solo vista previa temporal). */
export function coverProvenance(cover: CoverCandidate, retrievedAt?: string): FieldProvenance | null {
  if (cover.provider === "google-books" || !httpsUrl(cover.imageUrl)) return null
  return {
    provider: cover.provider,
    ...(httpsUrl(cover.sourceUrl) ? { sourceUrl: httpsUrl(cover.sourceUrl) } : {}),
    ...(retrievedAt ? { retrievedAt } : {}),
    selection: "user-selected",
  }
}
