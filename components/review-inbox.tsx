"use client"

import Link from "next/link"
import { useCallback, useEffect, useId, useRef, useState } from "react"
import { AlertTriangle, CheckCircle, Loader2, RefreshCw, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { applyReviewBatchAction, listReviewIssuesAction, prepareReviewBatchAction, type ReviewBatchPreview } from "@/app/actions/review"
import { unwrapAction } from "@/lib/action-result"
import { buildBookDetailHref, BOOK_RETURN_PARAM, bookRowAnchor, parseBookRowAnchor } from "@/lib/book-search"
import {
  DECISION_LABELS, EVIDENCE_SOURCE_LABELS, REVIEW_REASON_LABELS, REVIEW_STATE_LABELS, effectiveStates, parseReviewQuery, serializeReviewQuery, type ReviewFilters,
} from "@/lib/catalogue-review"
import type { ReviewBatchReport, ReviewIssueItem, ReviewIssuePage } from "@/lib/db/review"
import { DomainError } from "@/lib/domain-errors"
import { EVIDENCE_SOURCE_KINDS, REVIEW_LIMITS, REVIEW_REASONS, REVIEW_STATES } from "@/lib/review/contracts"
import { addToBatchDraft, clearBatchDraft, onBatchDraftChange, readBatchDraft, removeFromBatchDraft, type BatchDraftEntry } from "@/lib/review-batch-draft"

// Bandeja de revisión bibliográfica (U-DAT-07): incidencias paginadas por cursor, filtros en la URL (sobreviven a abrir
// una ficha y volver), selección para decisiones masivas y lote con vista previa y confirmación. Nada se aplica sin
// preparar la vista previa en el servidor; el modo parcial es una elección explícita con informe por fila.

const failure = (error: unknown, fallback: string) => error instanceof DomainError ? error.message : fallback
const sourcesText = (item: ReviewIssueItem) => item.sources.length ? item.sources.map((source) => EVIDENCE_SOURCE_LABELS[source]).join(", ") : "Sin evidencias guardadas"
const dateText = (iso: string) => new Date(iso).toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" })

export function issueTitle(item: ReviewIssueItem): string {
  const titles = [...new Set(item.entities.flatMap((entity) => entity.title ? [entity.title] : []))]
  if (!titles.length) return item.missingEntities ? "Fichas que ya no existen" : "Sin ficha"
  return titles.length > 2 ? `${titles.slice(0, 2).join(" · ")} y ${titles.length - 2} más` : titles.join(" · ")
}

function currentReturnPath(issueId?: string): string {
  return `${window.location.pathname}${window.location.search}${issueId ? `#${bookRowAnchor(issueId)}` : ""}`
}

export function reviewIssueHref(issueId: string, returnPath: string): string {
  const params = new URLSearchParams()
  params.set(BOOK_RETURN_PARAM, returnPath)
  return `/books/review/${encodeURIComponent(issueId)}?${params.toString()}`
}

interface FilterGroupProps<T extends string> {
  legend: string
  values: readonly T[]
  labels: Record<T, string>
  selected: readonly T[]
  counts?: Partial<Record<T, number>>
  onChange: (next: T[]) => void
}

function FilterGroup<T extends string>({ legend, values, labels, selected, counts, onChange }: FilterGroupProps<T>) {
  const id = useId()
  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className="text-sm font-semibold">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {values.map((value) => {
          const checked = selected.includes(value)
          return (
            <label key={value} htmlFor={`${id}-${value}`} className={`inline-flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-1.5 text-sm ${checked ? "border-primary bg-primary/10" : "border-border bg-background"}`}>
              <input id={`${id}-${value}`} type="checkbox" className="h-4 w-4 accent-primary" checked={checked}
                onChange={(event) => onChange(event.target.checked ? [...selected, value] : selected.filter((item) => item !== value))} />
              <span>{labels[value]}{counts && counts[value] !== undefined ? <span className="text-muted-foreground"> ({counts[value]})</span> : null}</span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

export function ReviewInbox() {
  const headingId = useId()
  const [query, setQuery] = useState<{ filters: ReviewFilters; cursor: string | null } | null>(null)
  const [page, setPage] = useState<ReviewIssuePage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [status, setStatus] = useState("")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [draft, setDraft] = useState<BatchDraftEntry[]>([])
  const [preview, setPreview] = useState<ReviewBatchPreview | null>(null)
  const [partial, setPartial] = useState(false)
  const [report, setReport] = useState<ReviewBatchReport | null>(null)
  const [busy, setBusy] = useState<"" | "preview" | "apply">("")
  const applyKey = useRef(crypto.randomUUID())
  const focusIssue = useRef<string | null>(null)
  const [reportSummaries, setReportSummaries] = useState<Map<string, string>>(new Map())
  const reloadToken = useRef(0)
  const [reload, setReload] = useState(0)

  // La URL es la fuente de los filtros: al volver de una ficha (o con Atrás) se recupera la misma selección.
  useEffect(() => {
    const read = () => {
      focusIssue.current = parseBookRowAnchor(window.location.hash)
      setLoading(true)
      setQuery(parseReviewQuery(new URLSearchParams(window.location.search)))
    }
    const init = () => { read(); setDraft(readBatchDraft()) }
    init()
    window.addEventListener("popstate", read)
    const stop = onBatchDraftChange(() => setDraft(readBatchDraft()))
    return () => { window.removeEventListener("popstate", read); stop() }
  }, [])

  useEffect(() => {
    if (!query) return
    let cancelled = false
    const token = ++reloadToken.current
    listReviewIssuesAction({ filters: query.filters, cursor: query.cursor, limit: 20 })
      .then((result) => {
        if (cancelled || token !== reloadToken.current) return
        const value = unwrapAction(result)
        setPage(value)
        setError("")
        if (value.sync?.deferred) setStatus(`Hay ${value.sync.deferred} incidencias más que no se han generado porque se alcanzó el límite de abiertas. Resuelve o ignora algunas para ver el resto.`)
      })
      .catch((caught: unknown) => { if (!cancelled) setError(failure(caught, "No se pudo cargar la bandeja. Comprueba la conexión y vuelve a intentarlo.")) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [query, reload])

  // Tras volver de una ficha, el foco vuelve a la incidencia desde la que se abrió.
  useEffect(() => {
    const target = focusIssue.current
    if (!page || !target) return
    const element = document.getElementById(bookRowAnchor(target))
    if (element) { element.focus(); element.scrollIntoView({ block: "center" }) }
    focusIssue.current = null
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`)
  }, [page])

  const navigate = useCallback((filters: ReviewFilters, cursor: string | null) => {
    const next = `${window.location.pathname}${serializeReviewQuery(filters, cursor)}`
    window.history.pushState(window.history.state, "", next)
    setSelected(new Set())
    setLoading(true)
    setQuery({ filters, cursor })
  }, [])

  if (!query) return <p role="status" className="text-muted-foreground">Cargando la bandeja…</p>
  const { filters } = query
  const states = effectiveStates(filters)
  const items = page?.items ?? []
  const draftIds = new Set(draft.map((entry) => entry.decision.issueId))

  const queueSelected = (kind: "ignore" | "reopen") => {
    let next = draft
    let skipped = 0
    for (const item of items.filter((entry) => selected.has(entry.id))) {
      if ((kind === "ignore") !== (item.state === "open")) { skipped++; continue }
      const added = addToBatchDraft(next, { decision: { issueId: item.id, expectedVersion: item.version, kind }, summary: `${REVIEW_REASON_LABELS[item.reason]} · ${issueTitle(item)}` })
      if (!added) { setStatus(`El lote admite ${REVIEW_LIMITS.batch} decisiones como máximo.`); break }
      next = added
    }
    setDraft(next); setSelected(new Set()); setPreview(null); setReport(null)
    setStatus(`Lote pendiente: ${next.length} decision${next.length === 1 ? "" : "es"}.${skipped ? ` ${skipped} no admite${skipped === 1 ? "" : "n"} «${DECISION_LABELS[kind]}» por su estado.` : ""}`)
  }

  const prepare = async () => {
    if (!draft.length || busy) return
    setBusy("preview"); setError(""); setReport(null)
    try {
      const value = unwrapAction(await prepareReviewBatchAction({ issueIds: draft.map((entry) => entry.decision.issueId), proposedDecisions: draft.map((entry) => entry.decision) }))
      setPreview(value); applyKey.current = crypto.randomUUID()
      setStatus(`Vista previa lista: ${value.summary.ready} de ${value.rows.length} decisiones se pueden aplicar.`)
    } catch (caught) { setError(failure(caught, "No se pudo preparar la vista previa del lote.")) }
    finally { setBusy("") }
  }

  const apply = async () => {
    if (!preview || busy) return
    setBusy("apply"); setError("")
    try {
      const value = unwrapAction(await applyReviewBatchAction({ previewId: preview.previewId, expectedRevision: preview.expectedRevision, idempotencyKey: applyKey.current, preview: preview.preview, mode: partial ? "partial" : "atomic" }))
      // Los resúmenes sobreviven a quitar del lote lo aplicado: el informe sigue nombrando cada decisión.
      setReportSummaries(issueSummary)
      setReport(value); setPreview(null)
      const applied = new Set(value.rows.filter((row) => row.outcome === "applied").map((row) => row.issueId))
      setDraft(removeFromBatchDraft(draft, applied))
      setStatus(value.status === "partial" ? `Se aplicaron ${value.applied} de ${value.rows.length} decisiones; revisa el informe.` : `Se aplicaron ${value.applied} decisiones.`)
      setLoading(true); setReload((count) => count + 1)
    } catch (caught) {
      setError(failure(caught, "No se pudo aplicar el lote. No se ha aplicado nada."))
      if (caught instanceof DomainError && ["REVISION_CONFLICT", "CONFLICT", "PREVIEW_EXPIRED", "INVALID_INPUT"].includes(caught.code)) setPreview(null)
    } finally { setBusy("") }
  }

  const issueSummary = new Map(draft.map((entry) => [entry.decision.issueId, entry.summary]))

  return (
    <div className="space-y-6">
      <section aria-labelledby={`${headingId}-filters`} className="space-y-4 rounded-2xl border border-border bg-card/80 p-4 shadow-xl backdrop-blur-xl md:p-6">
        <h2 id={`${headingId}-filters`} className="text-lg font-semibold">Filtros</h2>
        <FilterGroup legend="Motivo" values={REVIEW_REASONS} labels={REVIEW_REASON_LABELS} selected={filters.reasons ?? []} counts={page?.counts}
          onChange={(reasons) => navigate({ ...filters, reasons: reasons.length ? reasons : undefined }, null)} />
        <FilterGroup legend="Fuente" values={EVIDENCE_SOURCE_KINDS} labels={EVIDENCE_SOURCE_LABELS} selected={filters.sources ?? []}
          onChange={(sources) => navigate({ ...filters, sources: sources.length ? sources : undefined }, null)} />
        <FilterGroup legend="Resolución" values={REVIEW_STATES} labels={REVIEW_STATE_LABELS} selected={states}
          onChange={(next) => navigate({ ...filters, states: next.length ? next : undefined }, null)} />
      </section>

      <div aria-live="polite" role="status" className="text-sm text-muted-foreground">{loading ? "Cargando incidencias…" : status}</div>
      {error && <p role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"><AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{error}</p>}

      <section aria-labelledby={`${headingId}-list`} className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 id={`${headingId}-list`} className="text-lg font-semibold">Incidencias{page ? ` (${items.length}${page.nextCursor ? "+" : ""})` : ""}</h2>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={!items.length} onClick={() => setSelected(selected.size === items.length ? new Set() : new Set(items.map((item) => item.id)))}>
              {selected.size === items.length && items.length ? "Quitar la selección" : "Seleccionar esta página"}
            </Button>
            <Button type="button" variant="outline" onClick={() => { setLoading(true); setReload((count) => count + 1) }} disabled={loading}><RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />Actualizar</Button>
          </div>
        </div>
        {selected.size > 0 && (
          <div role="group" aria-label="Acciones con la selección" className="flex flex-col gap-2 rounded-xl border border-border bg-muted/40 p-3 sm:flex-row sm:items-center">
            <span className="text-sm font-medium">{selected.size} seleccionada{selected.size === 1 ? "" : "s"}</span>
            <Button type="button" variant="secondary" onClick={() => queueSelected("ignore")}>Añadir «Ignorar» al lote</Button>
            <Button type="button" variant="secondary" onClick={() => queueSelected("reopen")}>Añadir «Reabrir» al lote</Button>
          </div>
        )}
        {page && !items.length && !loading && <p className="rounded-xl border border-border bg-card/80 p-4 text-muted-foreground">No hay incidencias con estos filtros.</p>}
        <ul className="space-y-3" aria-label="Incidencias de revisión">
          {items.map((item) => {
            const firstCopy = item.entities.find((entity) => entity.copyId)?.copyId
            return (
              <li key={item.id} id={bookRowAnchor(item.id)} tabIndex={-1} className="rounded-2xl border border-border bg-card/80 p-4 shadow-sm backdrop-blur-xl focus-visible:outline-2 focus-visible:outline-ring">
                <div className="flex flex-col gap-3 md:flex-row md:items-start">
                  <label className="flex items-center gap-2 text-sm md:pt-1">
                    <input type="checkbox" className="h-4 w-4 accent-primary" checked={selected.has(item.id)}
                      onChange={(event) => { const next = new Set(selected); if (event.target.checked) next.add(item.id); else next.delete(item.id); setSelected(next) }} />
                    <span className="sr-only">Seleccionar: {REVIEW_REASON_LABELS[item.reason]}, {issueTitle(item)}</span>
                  </label>
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="rounded-md bg-vintage-yellow px-2 py-0.5 text-xs font-semibold text-black">{REVIEW_REASON_LABELS[item.reason]}</span>
                      <span className="text-xs text-muted-foreground">{REVIEW_STATE_LABELS[item.state]}{item.resolvedAt ? ` el ${dateText(item.resolvedAt)}` : ""}</span>
                      {draftIds.has(item.id) && <span className="text-xs font-medium">· En el lote</span>}
                    </p>
                    <h3 className="break-words font-semibold">{issueTitle(item)}</h3>
                    <p className="text-sm text-muted-foreground">
                      {item.entities.some((entity) => entity.kind === "edition") ? `${item.entities.filter((entity) => entity.kind === "edition").length} edición(es)` : ""}
                      {item.entities.filter((entity) => entity.isbn13).slice(0, 2).map((entity) => ` · ISBN ${entity.isbn13}`).join("")}
                      {` · Fuentes: ${sourcesText(item)}`}
                      {item.missingEntities ? ` · ${item.missingEntities} ficha(s) citada(s) ya no existen` : ""}
                    </p>
                    {item.lastDecision && <p className="text-xs text-muted-foreground">Última decisión: {DECISION_LABELS[item.lastDecision.kind]} ({dateText(item.lastDecision.decidedAt)})</p>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button asChild size="sm"><Link tabIndex={0} href={reviewIssueHref(item.id, currentReturnPath(item.id))}>Revisar y comparar<span className="sr-only">: {issueTitle(item)}</span></Link></Button>
                    {firstCopy && <Button asChild size="sm" variant="outline"><Link tabIndex={0} href={buildBookDetailHref(firstCopy, currentReturnPath(item.id))}>Abrir ficha<span className="sr-only">: {issueTitle(item)}</span></Link></Button>}
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
        <nav aria-label="Páginas de incidencias" className="flex flex-wrap gap-2">
          {query.cursor && <Button type="button" variant="outline" onClick={() => navigate(filters, null)}>Primera página</Button>}
          {page?.nextCursor && <Button type="button" variant="outline" onClick={() => navigate(filters, page.nextCursor)}>Página siguiente</Button>}
        </nav>
      </section>

      <section aria-labelledby={`${headingId}-batch`} className="space-y-4 rounded-2xl border border-border bg-card/80 p-4 shadow-xl backdrop-blur-xl md:p-6">
        <h2 id={`${headingId}-batch`} className="text-lg font-semibold">Lote pendiente ({draft.length} de {REVIEW_LIMITS.batch})</h2>
        <p className="text-sm text-muted-foreground">Añade decisiones desde la selección o desde la comparación de cada incidencia. Antes de aplicar verás qué se crea, qué cambia y qué se fusiona.</p>
        {draft.length > 0 && (
          <ul className="space-y-2" aria-label="Decisiones del lote">
            {draft.map((entry) => (
              <li key={entry.decision.issueId} className="flex items-center justify-between gap-2 rounded-xl border border-border p-2 text-sm">
                <span className="min-w-0 break-words"><strong>{DECISION_LABELS[entry.decision.kind]}</strong> · {entry.summary}</span>
                <Button type="button" size="icon" variant="ghost" aria-label={`Quitar del lote: ${entry.summary}`} onClick={() => { setDraft(removeFromBatchDraft(draft, new Set([entry.decision.issueId]))); setPreview(null) }}><X aria-hidden="true" className="h-4 w-4" /></Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={!draft.length || busy !== ""} onClick={() => void prepare()}>{busy === "preview" && <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" />}Preparar vista previa</Button>
          {draft.length > 0 && <Button type="button" variant="outline" onClick={() => { setDraft(clearBatchDraft()); setPreview(null) }}>Vaciar el lote</Button>}
        </div>

        {preview && (
          <div className="space-y-3 rounded-xl border border-border p-3" aria-labelledby={`${headingId}-preview`} role="region">
            <h3 id={`${headingId}-preview`} className="font-semibold">Vista previa (caduca a las {new Date(preview.expiresAt).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })})</h3>
            <p className="text-sm">Altas: {preview.summary.creates} · Modificaciones: {preview.summary.updates} · Fusiones: {preview.summary.merges} · En conflicto: {preview.summary.conflicts} · No aplicables: {preview.summary.invalid}</p>
            <ol className="space-y-2">
              {preview.rows.map((row) => (
                <li key={row.index} className="rounded-lg border border-border p-2 text-sm">
                  <p><strong>{DECISION_LABELS[row.kind]}</strong> · {issueSummary.get(row.issueId) ?? row.issueId} · <span className={row.status === "ready" ? "" : "font-semibold text-destructive"}>{row.status === "ready" ? "Lista" : row.status === "conflict" ? "Conflicto" : "No aplicable"}</span></p>
                  {row.message && <p className="text-destructive">{row.message}</p>}
                  {row.effects.length > 0 && <ul className="list-disc pl-5 text-muted-foreground">{row.effects.map((effect) => <li key={effect}>{effect}</li>)}</ul>}
                </li>
              ))}
            </ol>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary" checked={partial} onChange={(event) => setPartial(event.target.checked)} />
              <span>Modo parcial: aplicar solo las decisiones que sigan siendo válidas y mostrar un informe por fila. Sin marcarlo, cualquier conflicto deja el lote entero sin aplicar.</span>
            </label>
            {!partial && preview.summary.ready < preview.rows.length && <p className="text-sm text-destructive">Hay decisiones en conflicto: quítalas del lote, vuelve a prepararlo o elige el modo parcial.</p>}
            <Button type="button" disabled={busy !== "" || !preview.summary.ready || (!partial && preview.summary.ready < preview.rows.length)} onClick={() => void apply()}>
              {busy === "apply" && <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" />}Confirmar y aplicar {partial ? preview.summary.ready : preview.rows.length} decisiones
            </Button>
          </div>
        )}

        {report && (
          <div role="region" aria-label="Informe del lote" className="space-y-2 rounded-xl border border-border p-3 text-sm">
            <p className="flex items-center gap-2 font-semibold"><CheckCircle aria-hidden="true" className="h-4 w-4" />Aplicadas {report.applied} de {report.rows.length}{report.mode === "partial" ? " (modo parcial)" : ""}</p>
            <ul className="space-y-1">
              {report.rows.map((row) => (
                <li key={row.index}>{DECISION_LABELS[row.kind]} · {reportSummaries.get(row.issueId) ?? `incidencia ${row.index + 1}`}: {row.outcome === "applied" ? "aplicada" : `${row.outcome === "conflict" ? "conflicto" : "no aplicable"} — ${row.message ?? ""}`}</li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  )
}

