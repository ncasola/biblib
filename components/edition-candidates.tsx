"use client"

import { Button } from "@/components/ui/button"
import type { CandidatePage, SearchCandidate } from "@/lib/title-author-search"
export type { CandidatePage, SearchCandidate } from "@/lib/title-author-search"

const names: Record<string, string> = { "open-library": "Open Library", bne: "BNE", "google-books": "Google Books" }
const statuses: Record<string, string> = {
  found: "Resultados disponibles", notFound: "No se han encontrado resultados", rateLimited: "Límite de consultas alcanzado; espera antes de reintentar",
  unavailable: "Fuente no disponible; vuelve a intentarlo", misconfigured: "Fuente sin configurar", disabled: "Fuente desactivada", notAttempted: "Fuente no consultada",
}

export function EditionCandidates({ data, busy, editions = false, onPage, onWork, onChoose }: {
  data: CandidatePage; busy: boolean; editions?: boolean
  onPage: (page: number) => void
  onWork?: (candidate: SearchCandidate) => void
  onChoose: (candidate: SearchCandidate) => void
}) {
  return <section aria-label={editions ? "Ediciones de la obra" : "Resultados bibliográficos"} aria-busy={busy} className="space-y-4">
    <p role="status" aria-live="polite">{statuses[data.status]}. Página {data.page}.</p>
    <ul aria-label="Estado de las fuentes" className="text-sm text-muted-foreground space-y-1">{data.providers.map((entry) => <li key={entry.provider}>{names[entry.provider] ?? entry.provider}: {statuses[entry.status]}{entry.retryAfterSeconds ? ` (${entry.retryAfterSeconds} s)` : ""}</li>)}</ul>
    <ul className="grid gap-4 md:grid-cols-2">{data.results.map((candidate) => <li key={candidate.candidateKey} className="rounded-xl border border-border bg-background/70 p-4 space-y-3 min-w-0">
      <h3 className="font-bold break-words">{candidate.title || "Título no indicado"}</h3>
      <p className="text-sm">{candidate.authors.map((entry) => entry.name).join("; ") || "Autoría no indicada"}</p>
      <p className="text-sm text-muted-foreground">{names[candidate.provider]} · {candidate.level === "work" ? "Obra" : "Edición"} · {candidate.language || "Idioma no indicado"} · {candidate.publishDate || "Fecha no indicada"} · {candidate.format || "Formato no indicado"}</p>
      <p className="text-sm break-all">ISBN candidatos: {candidate.isbns.join(", ") || "Ninguno"}</p>
      {candidate.sourceUrl && <a href={candidate.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-primary underline">Ver registro en la fuente<span className="sr-only"> (se abre en otra pestaña)</span></a>}
      <p className="text-xs text-muted-foreground">La similitud de título o autor no confirma tu edición física.</p>
      <div className="flex flex-wrap gap-2">
        {candidate.level === "work" && onWork && <Button type="button" variant="outline" disabled={busy} onClick={() => onWork(candidate)}>Consultar ediciones</Button>}
        {candidate.provider !== "google-books" && <Button type="button" variant="outline" disabled={busy} onClick={() => onChoose(candidate)}>{candidate.level === "work" ? "No sé la edición" : "Revisar esta edición"}</Button>}
      </div>
    </li>)}</ul>
    <nav aria-label={editions ? "Páginas de ediciones" : "Páginas de resultados"} className="flex gap-3">
      <Button type="button" variant="outline" disabled={busy || data.page <= 1} onClick={() => onPage(data.page - 1)}>Anterior</Button>
      <Button type="button" variant="outline" disabled={busy || !data.nextPage} onClick={() => data.nextPage && onPage(data.nextPage)}>Siguiente</Button>
    </nav>
  </section>
}
