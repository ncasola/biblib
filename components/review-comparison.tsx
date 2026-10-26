"use client"

import Link from "next/link"
import { useCallback, useEffect, useId, useRef, useState } from "react"
import { AlertTriangle, ArrowLeft, CheckCircle, ExternalLink, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { compareBibliographicCandidatesAction, decideReviewIssueAction, type ReviewComparison } from "@/app/actions/review"
import { unwrapAction } from "@/lib/action-result"
import { buildBookDetailHref } from "@/lib/book-search"
import {
  ACCEPT_FIELDS, COMPARE_FIELD_LABELS, CONFIDENCE_TEXT, DECISION_LABELS, EVIDENCE_SOURCE_LABELS, REVIEW_REASON_HELP, REVIEW_REASON_LABELS, REVIEW_STATE_LABELS,
  displayValue, evidenceOriginLabel, type AcceptField, type ColumnKey, type ProposedDecision,
} from "@/lib/catalogue-review"
import { DomainError } from "@/lib/domain-errors"
import { addToBatchDraft, readBatchDraft } from "@/lib/review-batch-draft"

// Comparación campo a campo de una incidencia (U-DAT-07) con la fuente de cada afirmación, y decisiones individuales:
// aceptar campos (los no elegidos se conservan), confirmar en el ejemplar (solo con la casilla explícita), fusionar
// duplicados (las discrepancias abren una resolución), ignorar (la evidencia se conserva) o reabrir. Cada decisión se
// aplica ahora o se añade al lote de la bandeja, que la muestra en una vista previa antes de confirmar.

const failure = (error: unknown, fallback: string) => error instanceof DomainError ? error.message : fallback
const selectClass = "flex h-10 w-full rounded-md border border-input bg-input px-3 py-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-ring"
const dateText = (iso: string) => new Date(iso).toLocaleString("es-ES", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })

interface DecisionActionsProps {
  decision: ProposedDecision | null
  summary: string
  disabledReason?: string
  onApplied: (message: string) => void
  onQueued: (message: string) => void
}

/** «Aplicar ahora» o «Añadir al lote» para una decisión ya construida. */
function DecisionActions({ decision, summary, disabledReason, onApplied, onQueued }: DecisionActionsProps) {
  const key = useRef(crypto.randomUUID())
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const hint = useId()
  const apply = async () => {
    if (!decision || pending) return
    setPending(true); setError("")
    try {
      const report = unwrapAction(await decideReviewIssueAction({ decision, idempotencyKey: key.current }))
      key.current = crypto.randomUUID()
      const row = report.rows[0]
      if (row?.outcome === "applied") onApplied(`${DECISION_LABELS[decision.kind]}: aplicada.`)
      else setError(row?.message ?? "No se pudo aplicar la decisión.")
    } catch (caught) { setError(failure(caught, "No se pudo aplicar la decisión. No se ha guardado nada.")) }
    finally { setPending(false) }
  }
  const queue = () => {
    if (!decision) return
    const next = addToBatchDraft(readBatchDraft(), { decision, summary })
    if (!next) setError("El lote ya tiene el máximo de decisiones. Aplícalo o quita alguna desde la bandeja.")
    else onQueued(`Añadida al lote (${next.length}). Prepárala desde la bandeja para ver la vista previa.`)
  }
  return (
    <div className="space-y-2">
      {disabledReason && <p id={hint} className="text-sm text-muted-foreground">{disabledReason}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={!decision || pending} aria-describedby={disabledReason ? hint : undefined} onClick={() => void apply()}>{pending && <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" />}Aplicar ahora</Button>
        <Button type="button" variant="outline" disabled={!decision || pending} aria-describedby={disabledReason ? hint : undefined} onClick={queue}>Añadir al lote</Button>
      </div>
    </div>
  )
}

export function ReviewComparisonScreen({ issueId, returnPath }: { issueId: string; returnPath: string }) {
  const id = useId()
  const [data, setData] = useState<ReviewComparison | null>(null)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [targetId, setTargetId] = useState("")
  const [choices, setChoices] = useState<Partial<Record<AcceptField, ColumnKey>>>({})
  const [copyId, setCopyId] = useState("")
  const [confirmed, setConfirmed] = useState(false)
  const [sources, setSources] = useState<string[]>([])
  const heading = useRef<HTMLHeadingElement>(null)

  const load = useCallback(() => compareBibliographicCandidatesAction({ issueId }).then((result) => {
    const value = unwrapAction(result)
    setError("")
    setData(value)
    setTargetId(value.editions[0]?.id ?? ""); setChoices({}); setConfirmed(false)
    setCopyId(value.copies.find((copy) => !copy.isbnVerified)?.id ?? value.copies[0]?.id ?? "")
    setSources(value.editions.slice(1).map((edition) => edition.id))
  }).catch((caught: unknown) => { setError(failure(caught, "No se pudo cargar la incidencia. Comprueba la conexión y vuelve a intentarlo.")) }), [issueId])

  useEffect(() => { void load() }, [load])

  const done = (message: string) => { setNotice(message); void load().then(() => heading.current?.focus()) }

  if (error && !data) return <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-destructive">{error}</p>
  if (!data) return <p role="status" className="text-muted-foreground">Cargando la comparación…</p>

  const { issue } = data
  const open = issue.state === "open"
  const title = data.editions.map((edition) => edition.title).join(" · ") || "Fichas que ya no existen"
  const summary = `${REVIEW_REASON_LABELS[issue.reason]} · ${title}`
  const target = data.editions.find((edition) => edition.id === targetId)
  const targetColumn = data.columns.find((column) => column.editionId === targetId)
  const alternatives = data.columns.filter((column) => column.key !== targetColumn?.key)
  const base = { issueId: issue.id, expectedVersion: issue.version }

  const acceptDecision: ProposedDecision | null = target && Object.keys(choices).length
    ? { ...base, kind: "accept_fields", editionId: target.id, editionVersion: target.version, fields: choices } : null
  const copy = data.copies.find((entry) => entry.id === copyId)
  const copyEdition = copy ? data.editions.find((edition) => edition.id === copy.editionId) : undefined
  const physicalDecision: ProposedDecision | null = copy && confirmed && copyEdition?.isbn13 ? { ...base, kind: "confirm_physical", copyId: copy.id, copyVersion: copy.version, confirmed: true } : null
  const mergeSources = sources.filter((source) => source !== targetId)
  const mergeDecision: ProposedDecision | null = target && mergeSources.length ? {
    ...base, kind: "merge", targetEditionId: target.id, sourceEditionIds: mergeSources,
    expectedVersions: Object.fromEntries(data.editions.filter((edition) => edition.id === target.id || mergeSources.includes(edition.id)).map((edition) => [edition.id, edition.version])),
  } : null
  const firstCopy = (editionId: string) => data.copies.find((entry) => entry.editionId === editionId)?.id
  const fieldRows = ACCEPT_FIELDS.filter((field) => alternatives.some((column) => column.values[field] !== undefined))

  return (
    <div className="space-y-6">
      <Button asChild variant="outline"><Link tabIndex={0} href={returnPath}><ArrowLeft aria-hidden="true" className="mr-2 h-4 w-4" />Volver a la bandeja</Link></Button>
      <header className="space-y-2">
        <p className="flex flex-wrap items-center gap-2 text-sm"><span className="rounded-full bg-brass px-2.5 py-0.5 text-xs font-semibold text-[#1b130d]">{REVIEW_REASON_LABELS[issue.reason]}</span><span className="text-muted-foreground">{REVIEW_STATE_LABELS[issue.state]}</span></p>
        <h1 ref={heading} tabIndex={-1} className="heading-vintage text-3xl leading-[1.08] md:text-5xl break-words">{title}</h1>
        <p className="text-muted-foreground">{REVIEW_REASON_HELP[issue.reason]}</p>
      </header>
      <div role="status" aria-live="polite" className="text-sm">{notice && <span className="inline-flex items-center gap-2"><CheckCircle aria-hidden="true" className="h-4 w-4" />{notice}</span>}</div>
      {error && <p role="alert" className="flex items-start gap-2 text-sm text-destructive"><AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{error}</p>}

      <section aria-labelledby={`${id}-editions`} className="surface-card space-y-3 rounded-2xl p-4 md:p-6">
        <h2 id={`${id}-editions`} className="text-lg font-semibold">Fichas afectadas</h2>
        <ul className="space-y-2">
          {data.editions.map((edition, index) => {
            const copyLink = firstCopy(edition.id)
            return (
              <li key={edition.id} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <span>Edición {index + 1}: <strong>{edition.title}</strong> · {edition.isbn13 ? `ISBN ${edition.isbn13}` : "Sin ISBN"} · {edition.copies} ejemplar{edition.copies === 1 ? "" : "es"}</span>
                {copyLink && <Link tabIndex={0} className="text-sm font-medium underline underline-offset-4" href={buildBookDetailHref(copyLink, returnPath)}>Abrir ficha<span className="sr-only"> de {edition.title}</span></Link>}
              </li>
            )
          })}
        </ul>
      </section>

      <section aria-labelledby={`${id}-compare`} className="surface-card space-y-3 rounded-2xl p-4 md:p-6">
        <h2 id={`${id}-compare`} className="text-lg font-semibold">Comparación campo a campo</h2>
        {data.providers.length > 0 && (
          <p className="text-sm text-muted-foreground">Fuentes consultadas ahora: {data.providers.map((outcome) => `${outcome.provider === "open-library" ? "Open Library" : outcome.provider === "bne" ? "BNE" : outcome.provider === "google-books" ? "Google Books" : outcome.provider} (${outcome.status === "found" ? "ficha encontrada" : outcome.status === "notFound" ? "sin ficha" : "no disponible"})`).join(", ")}.</p>
        )}
        <div role="region" aria-labelledby={`${id}-compare`} tabIndex={0} className="overflow-x-auto rounded-xl border border-border focus-visible:outline-2 focus-visible:outline-ring">
          <table className="w-full min-w-[40rem] border-collapse text-sm">
            <caption className="sr-only">Valores de cada fuente por campo. Cada celda indica el valor y de dónde procede.</caption>
            <thead>
              <tr>
                <th scope="col" className="border-b border-border p-2 text-left">Campo</th>
                {data.columns.map((column) => (
                  <th key={column.key} scope="col" className="border-b border-border p-2 text-left align-bottom">
                    <span className="block">{column.label}</span>
                    <span className="block text-xs font-normal text-muted-foreground">{EVIDENCE_SOURCE_LABELS[column.sourceKind]}{column.confidence ? ` · ${CONFIDENCE_TEXT[column.confidence]}` : ""}</span>
                    {column.hasPhoto && <span className="block text-xs font-normal text-muted-foreground">Con foto privada propia</span>}
                    {!column.selectable && <span className="block text-xs font-normal text-destructive">{column.notSelectableReason}</span>}
                    {column.sourceUrl && <a href={column.sourceUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs font-normal underline">Registro<ExternalLink aria-hidden="true" className="h-3 w-3" /><span className="sr-only"> de {column.label} (se abre en otra pestaña)</span></a>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.field} className={row.differs ? "bg-vintage-yellow/10" : undefined}>
                  <th scope="row" className="border-b border-border p-2 text-left align-top">{row.label}{row.differs && <span className="block text-xs font-normal text-destructive">Valores distintos</span>}</th>
                  {row.cells.map((cell) => (
                    <td key={cell.column} className="border-b border-border p-2 align-top">
                      <span className="block break-words">{cell.display || <span className="text-muted-foreground">Sin dato</span>}</span>
                      {cell.source && <span className="block text-xs text-muted-foreground">Fuente: {cell.source}</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby={`${id}-evidence`} className="surface-card space-y-3 rounded-2xl p-4 md:p-6">
        <h2 id={`${id}-evidence`} className="text-lg font-semibold">Evidencias guardadas</h2>
        {data.evidence.length ? (
          <ul className="space-y-2 text-sm">
            {data.evidence.map((entry) => (
              <li key={entry.id} className="rounded-lg border border-border p-2">
                <strong>{EVIDENCE_SOURCE_LABELS[entry.sourceKind]}</strong>{entry.sourceRef ? ` (${entry.sourceRef})` : ""} · {CONFIDENCE_TEXT[entry.confidence]} · de {entry.subject.kind === "copy" ? "un ejemplar" : "la edición"} · origen: {evidenceOriginLabel(entry.origin)}
                {entry.observedAt && <> · observada el {dateText(entry.observedAt)}</>}
                {entry.hasPhoto && <> · cita una foto privada propia</>}
                {entry.claimedFields.length > 0 && <> · afirma: {entry.claimedFields.map((field) => COMPARE_FIELD_LABELS[field].toLocaleLowerCase("es")).join(", ")}</>}
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted-foreground">No hay evidencias guardadas para estas fichas.</p>}
      </section>

      {open ? (
        <section aria-labelledby={`${id}-decide`} className="surface-card space-y-6 rounded-2xl p-4 md:p-6">
          <h2 id={`${id}-decide`} className="text-lg font-semibold">Decidir</h2>

          {fieldRows.length > 0 && target && (
            <fieldset className="min-w-0 space-y-4">
              <legend className="font-semibold">Aceptar campos de otra fuente</legend>
              <p className="text-sm text-muted-foreground">Solo cambian los campos que elijas; los demás se conservan. Aceptar una ficha pública no comprueba tu ejemplar.</p>
              {data.editions.length > 1 && (
                <div className="space-y-1"><label htmlFor={`${id}-target`} className="text-sm font-medium">Edición que cambia</label>
                  <select id={`${id}-target`} className={selectClass} value={targetId} onChange={(event) => { setTargetId(event.target.value); setChoices({}) }}>
                    {data.editions.map((edition, index) => <option key={edition.id} value={edition.id}>Edición {index + 1}: {edition.title}</option>)}
                  </select></div>
              )}
              {target.copies > 1 && <p className="text-sm">Esta edición la comparten {target.copies} ejemplares: el cambio se verá en todos.</p>}
              {fieldRows.map((field) => {
                const current = targetColumn?.values[field]
                return (
                  <fieldset key={field} className="min-w-0 space-y-1 rounded-lg border border-border p-3">
                    <legend className="px-1 text-sm font-medium">{COMPARE_FIELD_LABELS[field]}</legend>
                    <label className="flex items-start gap-2 text-sm"><input type="radio" className="mt-1 accent-primary" name={`${id}-${field}`} checked={!choices[field]} onChange={() => setChoices((previous) => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== field)))} />
                      <span>Conservar: {displayValue(field, current) || "sin dato"}</span></label>
                    {alternatives.filter((column) => column.values[field] !== undefined).map((column) => (
                      <label key={column.key} className={`flex items-start gap-2 text-sm ${column.selectable ? "" : "text-muted-foreground"}`}>
                        <input type="radio" className="mt-1 accent-primary" name={`${id}-${field}`} disabled={!column.selectable} checked={choices[field] === column.key}
                          onChange={() => setChoices((previous) => ({ ...previous, [field]: column.key }))} />
                        <span>{displayValue(field, column.values[field])} <span className="text-muted-foreground">— {column.label}{column.selectable ? "" : " (solo vista previa)"}</span></span>
                      </label>
                    ))}
                  </fieldset>
                )
              })}
              <DecisionActions decision={acceptDecision} summary={summary} disabledReason={acceptDecision ? undefined : "Elige al menos un campo de otra fuente."} onApplied={done} onQueued={setNotice} />
            </fieldset>
          )}

          {(issue.reason === "duplicate_candidate" || issue.reason === "isbn_conflict") && data.editions.length > 1 && (
            <fieldset className="min-w-0 space-y-3">
              <legend className="font-semibold">Fusionar ediciones</legend>
              <p className="text-sm text-muted-foreground">Los ejemplares y sus evidencias pasan a la edición de destino. Si hay valores distintos, no se sobrescriben: se abre una resolución para elegirlos.</p>
              <div className="space-y-1"><label htmlFor={`${id}-merge-target`} className="text-sm font-medium">Edición de destino</label>
                <select id={`${id}-merge-target`} className={selectClass} value={targetId} onChange={(event) => { setTargetId(event.target.value); setChoices({}) }}>
                  {data.editions.map((edition, index) => <option key={edition.id} value={edition.id}>Edición {index + 1}: {edition.title}{edition.isbn13 ? ` (${edition.isbn13})` : ""}</option>)}
                </select></div>
              <fieldset className="space-y-1"><legend className="text-sm font-medium">Ediciones que se fusionan en ella</legend>
                {data.editions.filter((edition) => edition.id !== targetId).map((edition) => (
                  <label key={edition.id} className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 h-4 w-4 accent-primary" checked={sources.includes(edition.id)}
                    onChange={(event) => setSources((previous) => event.target.checked ? [...previous, edition.id] : previous.filter((value) => value !== edition.id))} />
                    <span>{edition.title} · {edition.isbn13 ?? "Sin ISBN"} · {edition.copies} ejemplar{edition.copies === 1 ? "" : "es"}</span></label>
                ))}
              </fieldset>
              <DecisionActions decision={mergeDecision} summary={summary} disabledReason={mergeDecision ? undefined : "Elige al menos una edición que fusionar."} onApplied={done} onQueued={setNotice} />
            </fieldset>
          )}

          {data.copies.length > 0 && (issue.reason === "provisional" || issue.reason === "photo_doubt") && (
            <fieldset className="min-w-0 space-y-3">
              <legend className="font-semibold">Confirmar en el ejemplar</legend>
              <p className="text-sm text-muted-foreground">Solo tú puedes comprobar el ISBN frente a tu libro físico. Ninguna ficha ni foto lo hace por ti.</p>
              {data.copies.length > 1 && (
                <div className="space-y-1"><label htmlFor={`${id}-copy`} className="text-sm font-medium">Ejemplar</label>
                  <select id={`${id}-copy`} className={selectClass} value={copyId} onChange={(event) => { setCopyId(event.target.value); setConfirmed(false) }}>
                    {data.copies.map((entry, index) => <option key={entry.id} value={entry.id}>Ejemplar {index + 1}{entry.isbnVerified ? " (ya comprobado)" : ""}</option>)}
                  </select></div>
              )}
              {copyEdition?.isbn13 ? (
                <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 h-4 w-4 accent-primary" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
                  <span>He comprobado en mi ejemplar físico que el ISBN es {copyEdition.isbn13}.</span></label>
              ) : <p className="text-sm">Este ejemplar no tiene ISBN que comprobar.</p>}
              <DecisionActions decision={physicalDecision} summary={summary} disabledReason={physicalDecision ? undefined : "Marca la casilla para confirmar la comprobación."} onApplied={done} onQueued={setNotice} />
            </fieldset>
          )}

          <fieldset className="min-w-0 space-y-3">
            <legend className="font-semibold">Ignorar</legend>
            <p className="text-sm text-muted-foreground">La incidencia deja de mostrarse entre las abiertas. Sus evidencias se conservan y puedes reabrirla.</p>
            <DecisionActions decision={{ ...base, kind: "ignore" }} summary={summary} onApplied={done} onQueued={setNotice} />
          </fieldset>
        </section>
      ) : (
        <section aria-labelledby={`${id}-reopen`} className="surface-card space-y-3 rounded-2xl p-4 md:p-6">
          <h2 id={`${id}-reopen`} className="text-lg font-semibold">Reabrir</h2>
          <p className="text-sm text-muted-foreground">Esta incidencia está {REVIEW_STATE_LABELS[issue.state].toLocaleLowerCase("es")}. Reábrela si quieres volver a decidir.</p>
          <DecisionActions decision={{ ...base, kind: "reopen" }} summary={summary} onApplied={done} onQueued={setNotice} />
        </section>
      )}

      {data.history.length > 0 && (
        <section aria-labelledby={`${id}-history`} className="surface-card space-y-2 rounded-2xl p-4 md:p-6">
          <h2 id={`${id}-history`} className="text-lg font-semibold">Historial de decisiones</h2>
          <ol className="space-y-1 text-sm">{data.history.map((entry, index) => <li key={`${entry.decidedAt}-${index}`}>{DECISION_LABELS[entry.kind]} · {dateText(entry.decidedAt)}{entry.evidenceRefs.length ? ` · ${entry.evidenceRefs.length} evidencia(s) citada(s)` : ""}</li>)}</ol>
        </section>
      )}
    </div>
  )
}
