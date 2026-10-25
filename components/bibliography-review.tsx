"use client"

import Link from "next/link"
import { useId, useMemo, useRef, useState, type FormEvent } from "react"
import { CheckCircle, ExternalLink, Loader2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { BookCover } from "@/components/book-cover"
import { candidateBookFields, candidateProvenance, coverProvenance } from "@/lib/bibliographic-catalog/normalize"
import { providerRightsPolicy } from "@/lib/bibliographic-catalog/rights"
import type { BibliographicCandidate, CatalogLookupResult, CoverCandidate, ProviderOutcome } from "@/lib/bibliographic-catalog/types"
import {
  buildReviewedCatalogue, candidateEvidence, combinability, combineCompatibleFields, displayFieldValue, fieldOptions, isSelectableCandidate,
  missingCandidateFields, REVIEW_FIELDS, type FieldOption, type ReviewField, type ReviewValue,
} from "@/lib/bibliography-review"
import { parseBookInput, type BookInput } from "@/lib/book-validation"
import { DEFAULT_BOOK_COVER } from "@/lib/book-covers"
import { provenanceFieldLabels, provenanceProviderLabel } from "@/lib/catalogue-provenance"
import { DomainError } from "@/lib/domain-errors"
import { normalizeIsbn } from "@/lib/isbn"
import type { Book, FieldProvenance, ProvenanceField, Shelf } from "@/lib/types"
import { SubmissionGate, type BookEntryDefaults, type SaveAndAddAnother } from "@/lib/book-entry"

export interface BibliographyReviewData {
  /** ISBN canónico buscado. */
  isbn: string
  result: CatalogLookupResult<BibliographicCandidate> | null
  covers: CoverCandidate[]
  /** Mensaje si la consulta no pudo completarse. */
  failure?: string
}

interface BibliographyReviewProps extends BibliographyReviewData {
  shelves: Shelf[]
  onSave: (input: BookInput) => Promise<Book>
  onRetry?: () => void
  entryDefaults?: BookEntryDefaults
  onSavedAnother?: SaveAndAddAnother
}

const catalogNames: Record<string, string> = { "open-library": "Open Library", bne: "BNE", "google-books": "Google Books" }
const catalogName = (provider: string) => catalogNames[provider] ?? provider

function outcomeText(outcome: ProviderOutcome): string {
  switch (outcome.status) {
    case "found": return "ficha encontrada"
    case "notFound": return "sin ficha para este ISBN"
    case "unavailable": return "no disponible ahora; puedes reintentar"
    case "rateLimited": return "ha limitado las consultas; reintenta más tarde"
    case "disabled": return "desactivada"
    case "misconfigured": return "sin configurar"
    case "notAttempted": return outcome.reason === "deadline" ? "no consultada: se agotó el tiempo" : outcome.reason === "unsupported" ? "no admite esta consulta" : "no consultada"
  }
}

const selectClass = "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-ring"
const textareaClass = "flex min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-ring"
const emptyDraft: Record<ReviewField, string> = { title: "", subtitle: "", authors: "", publishers: "", publish_date: "", number_of_pages: "" }
const lines = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean)

function inputText(field: ReviewField, value: ReviewValue): string {
  if (field === "authors" || field === "publishers") return (value as { name: string }[] | undefined)?.map((entry) => entry.name).join("\n") ?? ""
  return value === undefined ? "" : String(value)
}

export function BibliographyReview({ isbn, result, covers, failure, shelves, onSave, onRetry, entryDefaults, onSavedAnother }: BibliographyReviewProps) {
  const id = useId()
  const idempotencyKey = useRef(crypto.randomUUID())
  const gate = useRef(new SubmissionGate())
  const candidates = useMemo(() => result?.candidates ?? [], [result])
  const selectable = useMemo(() => candidates.filter(isSelectableCandidate), [candidates])
  const options = useMemo(() => Object.fromEntries(REVIEW_FIELDS.map((field) => [field, fieldOptions(selectable, field)])) as Record<ReviewField, FieldOption[]>, [selectable])
  const combination = useMemo(() => combinability(candidates, isbn), [candidates, isbn])
  const coverOptions = covers.filter((cover) => cover.imageUrl && providerRightsPolicy(cover.provider).previewCover)
  const savableCovers = coverOptions.filter((cover) => coverProvenance(cover) !== null)
  const previewOnlyCovers = coverOptions.filter((cover) => coverProvenance(cover) === null)

  const [mode, setMode] = useState<"sources" | "manual">(candidates.length ? "sources" : "manual")
  const [draft, setDraft] = useState(emptyDraft)
  const [structured, setStructured] = useState<Partial<Record<ReviewField, NonNullable<ReviewValue>>>>({})
  const [provenance, setProvenance] = useState<Partial<Record<ReviewField, FieldProvenance>>>({})
  const [chosen, setChosen] = useState<Partial<Record<ReviewField, string>>>({})
  const [manual, setManual] = useState<ReadonlySet<ReviewField>>(new Set())
  const [isbnText, setIsbnText] = useState(isbn)
  const [isbnVerified, setIsbnVerified] = useState(false)
  const [status, setStatus] = useState<Book["status"]>(entryDefaults?.status ?? "unread")
  const [shelfId, setShelfId] = useState(entryDefaults && shelves.some((shelf) => shelf.id === entryDefaults.shelf_id) ? entryDefaults.shelf_id : shelves.find((shelf) => shelf.isDefault)?.id ?? shelves[0]?.id ?? "")
  const [coverKey, setCoverKey] = useState("default")
  const [announcement, setAnnouncement] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const [saved, setSaved] = useState<Book | null>(null)

  const apply = (field: ReviewField, value: NonNullable<ReviewValue>, source: FieldProvenance, key: string) => {
    setDraft((current) => ({ ...current, [field]: inputText(field, value) }))
    setStructured((current) => ({ ...current, [field]: value }))
    setProvenance((current) => ({ ...current, [field]: source }))
    setChosen((current) => ({ ...current, [field]: key }))
    setManual((current) => { const next = new Set(current); next.delete(field); return next })
    setError("")
  }

  /** Lo escrito a mano queda como «manual» y ninguna acción en bloque lo sustituye. */
  const typeField = (field: ReviewField, text: string) => {
    setDraft((current) => ({ ...current, [field]: text }))
    setStructured((current) => { const next = { ...current }; delete next[field]; return next })
    setChosen((current) => { const next = { ...current }; delete next[field]; return next })
    setProvenance((current) => { const next = { ...current }; if (text.trim()) next[field] = { provider: "manual", selection: "user-selected" }; else delete next[field]; return next })
    setManual((current) => { const next = new Set(current); if (text.trim()) next.add(field); else next.delete(field); return next })
    setError("")
  }

  const choose = (field: ReviewField, option: FieldOption) => {
    const source = candidateProvenance(selectable[option.candidates[0]])
    if (source) apply(field, option.value, source, option.key)
  }

  const combine = () => {
    const combined = combineCompatibleFields(selectable, manual)
    const applied = Object.keys(combined.values) as ReviewField[]
    for (const field of applied) {
      const option = options[field][0]
      apply(field, combined.values[field]!, combined.provenance[field]!, option.key)
    }
    const label = (fields: ReviewField[]) => fields.map((field) => provenanceFieldLabels[field].toLocaleLowerCase("es")).join(", ")
    setAnnouncement([
      `Se han combinado ${applied.length} ${applied.length === 1 ? "campo" : "campos"}.`,
      combined.conflicts.length ? `Las fuentes discrepan en ${label(combined.conflicts)}: elige el valor tú.` : "",
      combined.protectedFields.length ? `Se conservan tus valores en ${label(combined.protectedFields)}.` : "",
    ].filter(Boolean).join(" "))
  }

  const takeCandidate = (candidate: BibliographicCandidate) => {
    const source = candidateProvenance(candidate)
    if (!source) return
    const values = candidateBookFields(candidate)
    const kept: ReviewField[] = []
    let count = 0
    for (const field of REVIEW_FIELDS) {
      const value = values[field]
      if (value === undefined) continue
      if (manual.has(field)) { kept.push(field); continue }
      const option = options[field].find((entry) => entry.display === displayFieldValue(field, value))
      if (option) { apply(field, value, source, option.key); count++ }
    }
    setAnnouncement(`Se han tomado ${count} campos de ${catalogName(candidate.provider)}.${kept.length ? ` Se conservan tus valores en ${kept.map((field) => provenanceFieldLabels[field].toLocaleLowerCase("es")).join(", ")}.` : ""}`)
  }

  const differences = REVIEW_FIELDS.filter((field) => options[field].length > 1)
  const sourcesFor = (option: FieldOption) => option.candidates.map((index) => catalogName(selectable[index].provider)).join(", ")
  const selectedCover = savableCovers.find((cover) => cover.coverKey === coverKey)
  const coverUrl = selectedCover?.imageUrl ?? DEFAULT_BOOK_COVER
  const isbnChanged = normalizeIsbn(isbnText) !== normalizeIsbn(isbn)

  const fieldHint = (field: ReviewField) => {
    const source = provenance[field]
    if (!source) return "Sin elegir: toma un valor de las fuentes o escríbelo."
    if (source.provider === "manual") return "Escrito por ti: se guardará como entrada manual."
    return `Procedencia: ${provenanceProviderLabel(source.provider)}${source.recordId ? `, registro ${source.recordId}` : ""}.`
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!gate.current.enter()) return
    setPending(true); setError("")
    try {
      const value = <F extends "authors" | "publishers">(field: F) => (structured[field] && !manual.has(field) ? structured[field] : lines(draft[field]).map((name) => ({ name }))) as { name: string; url?: string }[]
      const fields: Partial<Record<ProvenanceField, FieldProvenance>> = {}
      for (const field of REVIEW_FIELDS) if (draft[field].trim() && provenance[field]) fields[field] = provenance[field]
      const cover = selectedCover ? coverProvenance(selectedCover) : null
      if (cover) fields.cover = cover
      const input = parseBookInput({
        idempotencyKey: idempotencyKey.current,
        title: draft.title, subtitle: draft.subtitle, isbn: isbnText.trim(),
        authors: value("authors"), publishers: value("publishers"),
        number_of_pages: draft.number_of_pages.trim() === "" ? 0 : Number(draft.number_of_pages), publish_date: draft.publish_date,
        cover: { small: coverUrl, medium: coverUrl, large: coverUrl }, status, shelf_id: shelfId,
        catalogue: buildReviewedCatalogue(fields, Boolean(normalizeIsbn(isbnText)) && isbnVerified),
      })
      const another = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "another"
      const book = await onSave(input)
      if (another && onSavedAnother) onSavedAnother(book, input)
      else setSaved(book)
    } catch (caught) {
      setError(caught instanceof DomainError ? caught.message : "No se pudo guardar el libro. Tus elecciones se conservan; comprueba la conexión y vuelve a intentarlo.")
    } finally { gate.current.leave(); setPending(false) }
  }

  if (saved) return (
    <section className="rounded-2xl border border-border bg-card/80 backdrop-blur-xl p-6 shadow-xl space-y-4">
      <p role="status" className="flex items-center gap-2 font-semibold"><CheckCircle aria-hidden="true" className="h-5 w-5" />Libro agregado a la biblioteca</p>
      <BookCover cover={saved.cover} title={saved.title} className="w-28" sizes="112px" />
      <h2 className="text-xl font-bold">{saved.title}</h2>
      <p className="text-sm text-muted-foreground">Guardado en {saved.shelf_name} con la procedencia de cada campo.</p>
      <Button asChild><Link href={`/book/${saved.id}`}>Ver libro guardado</Link></Button>
    </section>
  )

  const outcomes = result?.providers ?? []
  const emptyMessage = !candidates.length ? failure ?? (result?.status === "notFound"
    ? "Ninguna fuente tiene una ficha para este ISBN. Puedes completarla manualmente."
    : "No se pudo completar la consulta. Puedes reintentar o completar la ficha manualmente.") : ""

  return (
    <section aria-labelledby={`${id}-heading`} className="rounded-2xl border border-border bg-card/80 backdrop-blur-xl p-5 sm:p-6 shadow-xl space-y-6 min-w-0">
      <header className="space-y-2">
        <h2 id={`${id}-heading`} className="text-2xl font-bold">Revisar fuentes bibliográficas</h2>
        <p className="text-sm text-muted-foreground">ISBN buscado: <span className="font-mono">{isbn}</span>. Nada se guarda hasta que confirmes el resumen. Las fuentes describen una edición; solo tú puedes comprobar que es la de tu ejemplar.</p>
      </header>

      {outcomes.length > 0 && <ul aria-label="Estado de las fuentes consultadas" className="flex flex-wrap gap-2 text-sm">
        {outcomes.map((outcome) => <li key={`${outcome.provider}-${outcome.requestId}`} className="rounded-full border border-border bg-background/70 px-3 py-1"><span className="font-semibold">{catalogName(outcome.provider)}:</span> {outcomeText(outcome)}</li>)}
      </ul>}

      {emptyMessage && <div className="rounded-xl border border-border bg-muted/40 p-4 space-y-3"><p role={result?.status === "notFound" ? "status" : "alert"}>{emptyMessage}</p>{onRetry && result?.status !== "notFound" && <Button type="button" variant="outline" onClick={onRetry}><RefreshCw aria-hidden="true" className="h-4 w-4 mr-2" />Reintentar consulta</Button>}</div>}

      {mode === "sources" && candidates.length > 0 && <>
        <section aria-labelledby={`${id}-candidates`} className="space-y-3">
          <h3 id={`${id}-candidates`} className="text-lg font-bold">Fichas candidatas ({candidates.length})</h3>
          <ul className="grid gap-4 xl:grid-cols-2">
            {candidates.map((candidate, index) => {
              const cardId = `${id}-candidate-${index}`
              const missing = missingCandidateFields(candidate)
              return <li key={`${candidate.provider}-${candidate.recordId ?? index}`} className="min-w-0">
                <article aria-labelledby={cardId} className="h-full rounded-xl border border-border bg-background/70 p-4 space-y-3">
                  <h4 id={cardId} className="font-bold">{catalogName(candidate.provider)} · ficha {index + 1}</h4>
                  {candidate.sourceUrl ? <a href={candidate.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-primary underline underline-offset-4 break-all">Ver registro{candidate.recordId ? ` ${candidate.recordId}` : ""} en la fuente<ExternalLink aria-hidden="true" className="h-3 w-3" /><span className="sr-only"> (se abre en otra pestaña)</span></a> : candidate.recordId && <p className="text-sm">Registro {candidate.recordId}</p>}
                  <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                    <dt className="font-semibold text-muted-foreground">ISBN recibidos</dt><dd className="font-mono break-all">{candidate.isbns.join(", ") || "Ninguno"}</dd>
                    <dt className="font-semibold text-muted-foreground">Título</dt><dd className="break-words">{candidate.title ?? "—"}{candidate.subtitle ? `: ${candidate.subtitle}` : ""}</dd>
                    <dt className="font-semibold text-muted-foreground">Autoría</dt><dd className="break-words">{candidate.authors.map((author) => author.name).join("; ") || "—"}</dd>
                    <dt className="font-semibold text-muted-foreground">Idioma</dt><dd>{candidate.language ?? "—"}</dd>
                    <dt className="font-semibold text-muted-foreground">Formato</dt><dd className="break-words">{candidate.format ?? "—"}</dd>
                    <dt className="font-semibold text-muted-foreground">Fecha según la fuente</dt><dd>{candidate.publishDate ?? "—"}</dd>
                    <dt className="font-semibold text-muted-foreground">Editoriales</dt><dd className="break-words">{candidate.publishers.map((publisher) => publisher.name).join("; ") || "—"}</dd>
                    <dt className="font-semibold text-muted-foreground">Páginas</dt><dd>{candidate.numberOfPages ?? "—"}</dd>
                  </dl>
                  {missing.length > 0 && <p className="text-sm text-muted-foreground">Campos ausentes en la fuente: {missing.join(", ")}.</p>}
                  <ul aria-label={`Evidencia de la ficha ${index + 1}`} className="flex flex-wrap gap-2 text-xs">
                    {candidateEvidence(candidate, isbn, candidates).map((entry) => <li key={entry} className={`rounded-full border px-2 py-0.5 ${entry === "ISBN coincide" ? "border-secondary text-foreground font-semibold" : "border-border text-muted-foreground"}`}>{entry}</li>)}
                  </ul>
                  {isSelectableCandidate(candidate)
                    ? <Button type="button" variant="outline" size="sm" onClick={() => takeCandidate(candidate)}>Tomar los campos de esta ficha</Button>
                    : <p className="text-sm text-muted-foreground">Solo consulta: los datos de {catalogName(candidate.provider)} todavía no se pueden guardar.</p>}
                </article>
              </li>
            })}
          </ul>
        </section>

        <section aria-labelledby={`${id}-fields`} className="space-y-4">
          <h3 id={`${id}-fields`} className="text-lg font-bold">Combinar o elegir campo por campo</h3>
          {combination.canCombine ? <div className="space-y-2">
            <p className="text-sm">Las fichas incluyen el ISBN exacto y no indican idiomas ni formatos incompatibles.</p>
            {differences.length > 0 && <p className="text-sm">Diferencias que decidirás tú: {differences.map((field) => provenanceFieldLabels[field].toLocaleLowerCase("es")).join(", ")}.</p>}
            <Button type="button" onClick={combine} className="bg-primary text-primary-foreground">Combinar campos compatibles</Button>
          </div> : <div className="space-y-1 text-sm"><p>No se ofrece combinar automáticamente:</p><ul className="list-disc pl-5">{combination.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul><p>Toma una ficha completa o elige cada campo por separado.</p></div>}
          <p role="status" aria-live="polite" className="text-sm font-medium min-h-5">{announcement}</p>
          <div className="grid gap-4 md:grid-cols-2">
            {REVIEW_FIELDS.filter((field) => options[field].length > 0).map((field) => <fieldset key={field} className="min-w-0 rounded-xl border border-border p-3 space-y-2">
              <legend className="px-1 text-sm font-semibold">{provenanceFieldLabels[field]}{field === "publish_date" ? " (según la fuente)" : ""}</legend>
              {options[field].map((option, index) => <div key={option.key} className="flex items-start gap-2">
                <input type="radio" id={`${id}-${field}-${index}`} name={`${id}-${field}`} checked={chosen[field] === option.key} onChange={() => choose(field, option)} className="mt-1 h-4 w-4 accent-primary" />
                <label htmlFor={`${id}-${field}-${index}`} className="text-sm break-words">«{option.display}» <span className="text-muted-foreground">— {sourcesFor(option)}</span></label>
              </div>)}
              {manual.has(field) && <p className="text-xs text-muted-foreground">Tienes un valor escrito a mano; se conserva salvo que elijas otro aquí.</p>}
            </fieldset>)}
          </div>
        </section>
      </>}

      {coverOptions.length > 0 && <fieldset className="rounded-xl border border-border p-4 space-y-3 min-w-0">
        <legend className="px-1 font-semibold">Portada</legend>
        <p className="text-sm text-muted-foreground">Se elige aparte: puede proceder de una fuente distinta del resto de la ficha.</p>
        <div className="flex flex-wrap gap-4">
          {savableCovers.map((cover) => <div key={cover.coverKey} className="flex items-start gap-2">
            <input type="radio" id={`${id}-cover-${cover.coverKey}`} name={`${id}-cover`} checked={coverKey === cover.coverKey} onChange={() => setCoverKey(cover.coverKey)} className="mt-1 h-4 w-4 accent-primary" />
            <label htmlFor={`${id}-cover-${cover.coverKey}`} className="space-y-1 text-xs"><BookCover cover={{ large: cover.imageUrl }} title={draft.title || "libro"} className="w-24" sizes="96px" /><span className="block font-semibold">Fuente: {catalogName(cover.provider)}</span>{cover.attribution && <span className="block max-w-40 text-muted-foreground">{cover.attribution}</span>}</label>
          </div>)}
          <div className="flex items-start gap-2">
            <input type="radio" id={`${id}-cover-default`} name={`${id}-cover`} checked={coverKey === "default"} onChange={() => setCoverKey("default")} className="mt-1 h-4 w-4 accent-primary" />
            <label htmlFor={`${id}-cover-default`} className="space-y-1 text-xs"><BookCover cover={null} title={draft.title || "libro"} className="w-24" sizes="96px" /><span className="block font-semibold">Portada predeterminada</span></label>
          </div>
        </div>
        {previewOnlyCovers.map((cover) => <figure key={cover.coverKey} className="space-y-1 text-xs"><BookCover cover={{ large: cover.imageUrl }} title={draft.title || "libro"} className="w-20" sizes="80px" /><figcaption className="text-muted-foreground">Vista previa temporal de {catalogName(cover.provider)}: no se guardará.</figcaption></figure>)}
      </fieldset>}

      <form onSubmit={(event) => void submit(event)} aria-labelledby={`${id}-summary`} aria-busy={pending} className="rounded-xl border border-border bg-background/60 p-4 sm:p-5 space-y-4">
        <h3 id={`${id}-summary`} className="text-lg font-bold">Resumen antes de guardar</h3>
        <p className="text-sm text-muted-foreground">Puedes corregir cualquier campo. Lo que escribas aquí cuenta como entrada manual y no se sustituye por datos de las fuentes.</p>
        <fieldset disabled={pending} className="space-y-4 min-w-0">
          <div className="space-y-1"><Label htmlFor={`${id}-title`}>Título <span aria-hidden="true">*</span></Label><Input id={`${id}-title`} required maxLength={500} value={draft.title} onChange={(event) => typeField("title", event.target.value)} aria-describedby={`${id}-title-hint`} /><p id={`${id}-title-hint`} className="text-xs text-muted-foreground">{fieldHint("title")}</p></div>
          <div className="space-y-1"><Label htmlFor={`${id}-subtitle`}>Subtítulo</Label><Input id={`${id}-subtitle`} maxLength={1000} value={draft.subtitle} onChange={(event) => typeField("subtitle", event.target.value)} aria-describedby={`${id}-subtitle-hint`} /><p id={`${id}-subtitle-hint`} className="text-xs text-muted-foreground">{fieldHint("subtitle")}</p></div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1"><Label htmlFor={`${id}-authors`}>Autoría (una por línea)</Label><textarea id={`${id}-authors`} className={textareaClass} value={draft.authors} onChange={(event) => typeField("authors", event.target.value)} aria-describedby={`${id}-authors-hint`} /><p id={`${id}-authors-hint`} className="text-xs text-muted-foreground">{fieldHint("authors")}</p></div>
            <div className="space-y-1"><Label htmlFor={`${id}-publishers`}>Editoriales (una por línea)</Label><textarea id={`${id}-publishers`} className={textareaClass} value={draft.publishers} onChange={(event) => typeField("publishers", event.target.value)} aria-describedby={`${id}-publishers-hint`} /><p id={`${id}-publishers-hint`} className="text-xs text-muted-foreground">{fieldHint("publishers")}</p></div>
            <div className="space-y-1"><Label htmlFor={`${id}-date`}>Fecha editorial según la fuente</Label><Input id={`${id}-date`} maxLength={100} value={draft.publish_date} onChange={(event) => typeField("publish_date", event.target.value)} aria-describedby={`${id}-date-hint`} /><p id={`${id}-date-hint`} className="text-xs text-muted-foreground">{fieldHint("publish_date")} No acredita tu edición física.</p></div>
            <div className="space-y-1"><Label htmlFor={`${id}-pages`}>Número de páginas</Label><Input id={`${id}-pages`} type="number" min={0} max={100000} step={1} value={draft.number_of_pages} onChange={(event) => typeField("number_of_pages", event.target.value)} aria-describedby={`${id}-pages-hint`} /><p id={`${id}-pages-hint`} className="text-xs text-muted-foreground">{fieldHint("number_of_pages")}</p></div>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${id}-isbn`}>ISBN</Label><Input id={`${id}-isbn`} maxLength={100} value={isbnText} onChange={(event) => { setIsbnText(event.target.value); setIsbnVerified(false) }} aria-describedby={`${id}-isbn-hint`} />
            <p id={`${id}-isbn-hint`} className="text-xs text-muted-foreground">{isbnChanged ? "Has cambiado el ISBN: la procedencia elegida se refiere al ISBN buscado." : "Déjalo vacío si el ejemplar no tiene ISBN."}</p>
            <div className="flex items-start gap-2"><input id={`${id}-verified`} type="checkbox" checked={isbnVerified && Boolean(normalizeIsbn(isbnText))} disabled={!normalizeIsbn(isbnText)} onChange={(event) => setIsbnVerified(event.target.checked)} className="mt-1 h-4 w-4 accent-primary" aria-describedby={`${id}-verified-help`} /><Label htmlFor={`${id}-verified`} className="leading-6">He comprobado que el ISBN corresponde a mi ejemplar</Label></div>
            <p id={`${id}-verified-help`} className="text-xs text-muted-foreground">Que una fuente o el dígito de control coincidan no confirma tu edición física.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1"><Label htmlFor={`${id}-status`}>Estado de lectura</Label><select id={`${id}-status`} className={selectClass} value={status} onChange={(event) => setStatus(event.target.value as Book["status"])}><option value="unread">Sin leer</option><option value="reading">Leyendo</option><option value="read">Leído</option><option value="to-read">Por leer</option></select></div>
            <div className="space-y-1"><Label htmlFor={`${id}-shelf`}>Estantería</Label><select id={`${id}-shelf`} className={selectClass} value={shelfId} onChange={(event) => setShelfId(event.target.value)}>{shelves.length === 0 && <option value="">Predeterminada</option>}{shelves.map((shelf) => <option key={shelf.id} value={shelf.id}>{shelf.title}{shelf.isDefault ? " (predeterminada)" : ""}</option>)}</select></div>
          </div>
          <div className="flex items-center gap-3 text-sm"><BookCover cover={{ large: coverUrl }} title={draft.title || "libro"} className="w-16" sizes="64px" /><p>Portada: {selectedCover ? `fuente ${catalogName(selectedCover.provider)}` : "predeterminada"}.</p></div>
        </fieldset>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={pending} className="bg-primary text-primary-foreground">{pending && <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" />}{pending ? "Guardando..." : "Guardar en la biblioteca"}</Button>
          {onSavedAnother && <Button type="submit" name="intent" value="another" variant="outline" disabled={pending}>Guardar y añadir otro</Button>}
          {mode === "sources" ? <Button type="button" variant="outline" disabled={pending} onClick={() => { setMode("manual"); setAnnouncement("") }}>Completar manualmente</Button>
            : candidates.length > 0 && <Button type="button" variant="outline" disabled={pending} onClick={() => setMode("sources")}>Volver a las fuentes</Button>}
        </div>
        {mode === "manual" && <p className="text-xs text-muted-foreground">Modo manual: se conservan el ISBN y todo lo que ya has escrito o elegido.</p>}
      </form>
    </section>
  )
}
