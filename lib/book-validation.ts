import { z } from "zod"
import { normalizeBookCover } from "./book-covers"
import { normalizeIsbn } from "./isbn"
import { DomainError } from "./domain-errors"
import { catalogueProblem, catalogueSchema, normalizeCatalogue } from "./catalogue-provenance"

export const uuidSchema = z.uuid({ message: "El identificador no es válido." })
export const statusSchema = z.enum(["read", "reading", "unread", "to-read"])
export const shelfTitleSchema = z.string().trim().min(1).max(120)
const coverUrl = z.string().max(2048).refine((value) => {
  if (value === "" || value === "/default-book-cover.webp") return true
  try { return new URL(value).protocol === "https:" } catch { return false }
}, "La portada debe tener una dirección HTTPS válida.")

const bookInputSchema = z.object({
  version: uuidSchema.optional(),
  isbn: z.string().trim().max(100).default(""),
  title: z.string().trim().min(1).max(500),
  subtitle: z.string().trim().max(1000).optional(),
  authors: z.array(z.object({ name: z.string().trim().min(1).max(200), url: z.string().max(2048).optional() })).max(30),
  publishers: z.array(z.object({ name: z.string().trim().min(1).max(200) })).max(20).optional(),
  number_of_pages: z.number().int().min(0).max(100_000),
  publish_date: z.string().trim().max(100),
  cover: z.object({ small: coverUrl.optional(), medium: coverUrl.optional(), large: coverUrl.optional() }).nullish(),
  status: statusSchema,
  shelf_id: z.string().max(100).default(""),
  // Procedencia legacy (v1) o `schemaVersion: 2` (U-BIB-04); las acciones deciden cuál se guarda.
  catalogue: catalogueSchema.optional(),
})

export type BookInput = z.input<typeof bookInputSchema>

export function parseBookInput(input: unknown) {
  const result = bookInputSchema.safeParse(input)
  const problem = !result.success && input && typeof input === "object" && "catalogue" in input ? catalogueProblem(input.catalogue) : null
  if (problem) throw new DomainError("INVALID_INPUT", problem)
  if (!result.success) throw new DomainError("INVALID_INPUT", "Revisa el título, autores, páginas, estado y dirección de portada.")
  const data = result.data
  let isbn = data.isbn
  if (isbn.startsWith("manual-") && !uuidSchema.safeParse(isbn.slice(7)).success) {
    throw new DomainError("INVALID_INPUT", "El identificador del libro sin ISBN no es válido.")
  }
  if (isbn && !isbn.startsWith("manual-")) {
    const normalized = normalizeIsbn(isbn)
    if (!normalized) throw new DomainError("INVALID_INPUT", "El ISBN no es válido. Revisa sus dígitos o déjalo vacío.")
    isbn = normalized
  }
  return { ...data, isbn, cover: normalizeBookCover(data.cover), catalogue: normalizeCatalogue(data.catalogue ?? { source: "manual", isbnVerified: false }, isbn) }
}

export function parseUuid(value: unknown): string {
  const result = uuidSchema.safeParse(value)
  if (!result.success) throw new DomainError("INVALID_INPUT", "El identificador no es válido.")
  return result.data
}

export function parseShelfTitle(value: unknown): string {
  const result = shelfTitleSchema.safeParse(value)
  if (!result.success) throw new DomainError("INVALID_INPUT", "El nombre de la estantería debe tener entre 1 y 120 caracteres.")
  return result.data
}
