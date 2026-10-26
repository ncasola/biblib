import { candidateBookFields, candidateProvenance, compareCandidates, type CandidateBookFields } from "./bibliographic-catalog/normalize"
import type { BibliographicCandidate } from "./bibliographic-catalog/types"
import { normalizeIsbn } from "./isbn"
import { provenanceFieldLabels } from "./catalogue-provenance"
import type { CatalogueAttributionV2, FieldProvenance, ProvenanceField, ProvenanceProvider } from "./types"

// Revisión de candidatos bibliográficos (U-BIB-04). Funciones puras: no eligen por la persona,
// no calculan porcentajes y describen la evidencia literal que aporta cada fuente.

export const REVIEW_FIELDS = ["title", "subtitle", "authors", "publishers", "publish_date", "number_of_pages"] as const
export type ReviewField = typeof REVIEW_FIELDS[number]
export type ReviewValue = CandidateBookFields[ReviewField]

export interface FieldOption {
  /** Clave estable del valor (normalizado) para agrupar candidatos que coinciden. */
  key: string
  value: NonNullable<ReviewValue>
  display: string
  /** Índices de los candidatos que aportan este valor, en orden de consulta. */
  candidates: number[]
}

export function displayFieldValue(field: ReviewField, value: ReviewValue): string {
  if (value === undefined) return ""
  if (field === "authors" || field === "publishers") return (value as { name: string }[]).map((entry) => entry.name).join("; ")
  return String(value)
}

const comparable = (text: string) => text.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("es")

/** Candidatos que se pueden guardar: Google Books no tiene todavía lector de procedencia. */
export function isSelectableCandidate(candidate: BibliographicCandidate): boolean {
  return candidateProvenance(candidate) !== null
}

export function fieldOptions(candidates: readonly BibliographicCandidate[], field: ReviewField): FieldOption[] {
  const options = new Map<string, FieldOption>()
  candidates.forEach((candidate, index) => {
    const value = candidateBookFields(candidate)[field]
    if (value === undefined) return
    const display = displayFieldValue(field, value)
    const key = comparable(display)
    const option = options.get(key)
    if (option) option.candidates.push(index)
    else options.set(key, { key, value, display, candidates: [index] })
  })
  return [...options.values()]
}

const year = (date?: string) => date?.match(/\b(\d{4})\b/)?.[1]

/** Evidencia literal de un candidato frente al ISBN buscado y al resto de fuentes. Nunca un porcentaje. */
export function candidateEvidence(candidate: BibliographicCandidate, searchedIsbn: string, all: readonly BibliographicCandidate[]): string[] {
  const canonical = normalizeIsbn(searchedIsbn)
  const others = all.filter((other) => other !== candidate)
  const evidence: string[] = []
  if (candidate.isbns.length === 0) evidence.push("la fuente no incluye ISBN")
  else evidence.push(canonical && candidate.isbns.some((isbn) => normalizeIsbn(isbn) === canonical) ? "ISBN coincide" : "ISBN distinto del buscado")

  const compareText = (own: string | undefined, values: (string | undefined)[], missing: string, differs: string, matches?: string) => {
    if (!own) { evidence.push(missing); return }
    const present = values.filter((value): value is string => Boolean(value))
    if (present.some((value) => comparable(value) !== comparable(own))) evidence.push(differs)
    else if (matches && present.length) evidence.push(matches)
  }
  compareText(candidate.language, others.map((other) => other.language), "la fuente no incluye idioma", "idioma distinto", "idioma coincide")
  compareText(candidate.format, others.map((other) => other.format), "la fuente no incluye formato", "formato no compatible", "formato coincide")
  const ownYear = year(candidate.publishDate)
  if (!candidate.publishDate) evidence.push("la fuente no incluye fecha")
  else if (others.some((other) => year(other.publishDate) && year(other.publishDate) !== ownYear)) evidence.push("año distinto")
  if (candidate.title && others.some((other) => other.title && comparable(other.title) !== comparable(candidate.title!))) evidence.push("título distinto")
  const authors = (entry: BibliographicCandidate) => comparable(entry.authors.map((author) => author.name).join(";"))
  if (candidate.authors.length && others.some((other) => other.authors.length && authors(other) !== authors(candidate))) evidence.push("autoría distinta")
  return evidence
}

/** Campos que la fuente no incluye, con su nombre visible. */
export function missingCandidateFields(candidate: BibliographicCandidate): string[] {
  const fields = candidateBookFields(candidate)
  const missing = REVIEW_FIELDS.filter((field) => fields[field] === undefined).map((field) => provenanceFieldLabels[field].toLocaleLowerCase("es"))
  if (!candidate.language) missing.push("idioma")
  if (!candidate.format) missing.push("formato")
  return missing
}

/**
 * «Combinar campos compatibles» solo con el ISBN canónico exacto en todas las fichas y señales de
 * idioma/formato compatibles. Un año distinto no impide combinar, pero queda como conflicto.
 */
export function combinability(candidates: readonly BibliographicCandidate[], searchedIsbn: string): { canCombine: boolean; reasons: string[] } {
  const selectable = candidates.filter(isSelectableCandidate)
  const reasons: string[] = []
  const canonical = normalizeIsbn(searchedIsbn)
  if (!selectable.length) reasons.push("No hay fichas de fuentes que se puedan guardar.")
  if (!canonical || selectable.some((candidate) => !candidate.isbns.some((isbn) => normalizeIsbn(isbn) === canonical))) {
    reasons.push("Alguna ficha no incluye exactamente el ISBN buscado.")
  }
  for (let left = 0; left < selectable.length; left++) {
    for (let right = left + 1; right < selectable.length; right++) {
      const comparison = compareCandidates(selectable[left], selectable[right])
      if (comparison.evidence.languageCompatible === false) reasons.push("Las fuentes indican idiomas distintos.")
      if (comparison.evidence.formatCompatible === false) reasons.push("Las fuentes indican formatos no compatibles.")
    }
  }
  return { canCombine: reasons.length === 0, reasons: [...new Set(reasons)] }
}

export interface CombinationResult {
  values: Partial<Record<ReviewField, NonNullable<ReviewValue>>>
  provenance: Partial<Record<ReviewField, FieldProvenance>>
  /** Campos con valores distintos entre fuentes: la persona decide. */
  conflicts: ReviewField[]
  /** Campos escritos o verificados por la persona: nunca se sobrescriben. */
  protectedFields: ReviewField[]
}

/** Toma de cada campo el valor en el que coinciden las fuentes; deja los conflictos y lo manual intactos. */
export function combineCompatibleFields(candidates: readonly BibliographicCandidate[], protectedFields: ReadonlySet<ReviewField>): CombinationResult {
  const selectable = candidates.filter(isSelectableCandidate)
  const result: CombinationResult = { values: {}, provenance: {}, conflicts: [], protectedFields: [] }
  for (const field of REVIEW_FIELDS) {
    const options = fieldOptions(selectable, field)
    if (!options.length) continue
    if (protectedFields.has(field)) { result.protectedFields.push(field); continue }
    if (options.length > 1) { result.conflicts.push(field); continue }
    const provenance = candidateProvenance(selectable[options[0].candidates[0]])
    if (!provenance) continue
    result.values[field] = options[0].value
    result.provenance[field] = provenance
  }
  return result
}

/** `catalogue` v2 que se enviará al guardar: fuente primaria (la del título si viene de una fuente) y campos. */
export function buildReviewedCatalogue(fields: Partial<Record<ProvenanceField, FieldProvenance>>, isbnVerified: boolean): CatalogueAttributionV2 {
  const primary = [fields.title, ...Object.values(fields)].find((entry): entry is FieldProvenance => Boolean(entry && entry.provider !== "manual"))
  const source: ProvenanceProvider = primary?.provider ?? "manual"
  return {
    schemaVersion: 2, source, isbnVerified,
    ...(primary?.sourceUrl ? { sourceUrl: primary.sourceUrl } : {}),
    ...(Object.keys(fields).length ? { fields } : {}),
  }
}
