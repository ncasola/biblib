"use client"

import { useEffect, useId, useRef, useState, type FormEvent } from "react"
import { searchBibliographyAction, loadEditionCandidatesAction, prepareCandidateLinkAction } from "@/app/actions/bibliography"
import { addBookAction } from "@/app/actions/books"
import { getShelvesAction } from "@/app/actions/shelves"
import { unwrapAction } from "@/lib/action-result"
import type { Book, Shelf } from "@/lib/types"
import type { PreparedCandidate } from "@/lib/title-author-search"
import { createLatestBibliographyRequest, manualTitleAuthorDraft } from "@/lib/title-author-search-request"
import { BibliographyReview } from "@/components/bibliography-review"
import { BookForm } from "@/components/book-form"
import { EditionCandidates, type CandidatePage, type SearchCandidate } from "@/components/edition-candidates"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/** Una señal por interacción invalida búsqueda, ediciones y preparación anteriores, también al desmontar. */
export function TitleAuthorSearch() {
  const id = useId()
  const latest = useRef<ReturnType<typeof createLatestBibliographyRequest> | null>(null)
  if (latest.current === null) latest.current = createLatestBibliographyRequest()
  const [title, setTitle] = useState("")
  const [author, setAuthor] = useState("")
  const [language, setLanguage] = useState("")
  const [limit, setLimit] = useState<10 | 20>(10)
  const [query, setQuery] = useState({ title: "", author: "", language: "", limit: 10 as 10 | 20 })
  const [data, setData] = useState<CandidatePage | null>(null)
  const [editions, setEditions] = useState<CandidatePage | null>(null)
  const [work, setWork] = useState<SearchCandidate | null>(null)
  const [prepared, setPrepared] = useState<PreparedCandidate | null>(null)
  const [manual, setManual] = useState<Book | null>(null)
  const [saved, setSaved] = useState<Book | null>(null)
  const [shelves, setShelves] = useState<Shelf[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  useEffect(() => () => latest.current?.cancel(), [])

  const run = async (operation: (signal: AbortSignal) => Promise<void>) => {
    const controller = latest.current!.begin()
    setBusy(true); setError("")
    const timer = setTimeout(() => { if (!controller.signal.aborted) { controller.abort(); setBusy(false); setError("La consulta ha tardado demasiado. Puedes reintentar o completar la ficha manualmente.") } }, 15000)
    try { await operation(controller.signal) }
    catch (caught) { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "No se pudo completar la consulta. Vuelve a intentarlo.") }
    finally { clearTimeout(timer); if (!controller.signal.aborted) setBusy(false) }
  }
  const search = (page: number, submitted = query) => {
    setPrepared(null); setManual(null); setEditions(null); setWork(null)
    void run(async (signal) => {
      const response = unwrapAction(await searchBibliographyAction({ ...submitted, language: submitted.language || undefined, page }))
      if (!signal.aborted) setData(response)
    })
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const submitted = { title, author, language, limit }
    setQuery(submitted); setData(null); search(1, submitted)
  }
  const loadEditions = (candidate: SearchCandidate, page = 1) => {
    if (!data) return
    setWork(candidate); setEditions(null); setPrepared(null); setManual(null)
    void run(async (signal) => {
      const response = unwrapAction(await loadEditionCandidatesAction({ queryToken: data.queryToken, workKey: candidate.candidateKey, page }))
      if (!signal.aborted) setEditions(response)
    })
  }
  const choose = (candidate: SearchCandidate) => {
    setPrepared(null); setManual(null)
    void run(async (signal) => {
      const response = unwrapAction(await prepareCandidateLinkAction({ candidateKey: candidate.candidateKey }))
      if (signal.aborted) return
      const loaded = shelves ?? await getShelvesAction()
      if (!signal.aborted) { setShelves(loaded); setPrepared(response) }
    })
  }
  const goManual = () => {
    setPrepared(null)
    void run(async (signal) => {
      const loaded = shelves ?? await getShelvesAction()
      if (signal.aborted) return
      setShelves(loaded)
      setManual(manualTitleAuthorDraft(title, author))
    })
  }
  return <section aria-labelledby={`${id}-heading`} className="mx-auto mt-8 max-w-6xl rounded-2xl border border-border bg-card/80 backdrop-blur-xl p-5 sm:p-6 shadow-xl space-y-6">
    <h2 id={`${id}-heading`} className="text-2xl font-bold heading-vintage">Buscar por título y autor</h2>
    <p className="text-sm text-muted-foreground">¿No conoces el ISBN? Busca una obra y consulta sus ediciones. Solo se consulta al pulsar Buscar; nada se guarda hasta confirmar la revisión.</p>
    <form onSubmit={submit} aria-busy={busy} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2"><Label htmlFor={`${id}-title`}>Título</Label><Input id={`${id}-title`} maxLength={300} value={title} onChange={(event) => setTitle(event.target.value)} /></div>
        <div className="space-y-2"><Label htmlFor={`${id}-author`}>Autoría</Label><Input id={`${id}-author`} maxLength={200} value={author} onChange={(event) => setAuthor(event.target.value)} /></div>
        <div className="space-y-2"><Label htmlFor={`${id}-language`}>Idioma en Open Library (código opcional, por ejemplo spa)</Label><Input id={`${id}-language`} minLength={2} maxLength={3} value={language} onChange={(event) => setLanguage(event.target.value)} /></div>
        <div className="space-y-2"><Label htmlFor={`${id}-limit`}>Resultados por fuente</Label><select id={`${id}-limit`} value={limit} onChange={(event) => setLimit(Number(event.target.value) as 10 | 20)} className="h-10 w-full rounded-md border border-input bg-background px-3"><option value={10}>10</option><option value={20}>20</option></select></div>
      </div>
      <div className="flex flex-wrap gap-3"><Button type="submit">Buscar</Button><Button type="button" variant="outline" onClick={goManual}>Completar manualmente con este texto</Button>{busy && <Button type="button" variant="outline" onClick={() => { latest.current?.cancel(); setBusy(false) }}>Cancelar consulta</Button>}</div>
    </form>
    {busy && <p role="status">Consultando el catálogo…</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {data && <EditionCandidates data={data} busy={busy} onPage={(page) => search(page)} onWork={loadEditions} onChoose={choose} />}
    {work && <h3 className="text-xl font-bold">Ediciones de {work.title || "la obra seleccionada"}</h3>}
    {editions && work && <EditionCandidates data={editions} busy={busy} editions onPage={(page) => loadEditions(work, page)} onChoose={choose} />}
    {prepared?.provisional && <p role="status">Ficha provisional sin ISBN: puedes completar y guardar los datos que conoces.</p>}
    {prepared && shelves && <BibliographyReview key={prepared.reviewKey} isbn={prepared.provisional ? "" : prepared.isbn} result={{ status: "found", candidates: [prepared.candidate], providers: [], complete: true, deadlineExceeded: false }} covers={[]} shelves={shelves} onSave={async (input) => unwrapAction(await addBookAction({ ...input, isbn: input.isbn || prepared.isbn }))} />}
    {manual && shelves && <div className="rounded-xl border border-border p-4"><h3 className="text-xl font-bold mb-4">Completar ficha manual</h3><BookForm key={manual.isbn} initialBook={manual} shelves={shelves} onSubmit={async (input) => { setSaved(unwrapAction(await addBookAction(input))); setManual(null) }} /></div>}
    {saved && <p role="status">Libro agregado a la biblioteca: {saved.title}.</p>}
  </section>
}
