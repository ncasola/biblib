"use client"

import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { ChevronLeft, ChevronRight, Filter, LayoutGrid, List, Plus, Search, X } from "lucide-react"
import { getShelvesAction } from "@/app/actions/shelves"
import { listSeriesAction } from "@/app/actions/series"
import { getTagsAction } from "@/app/actions/tags"
import type { Tag } from "@/lib/product/contracts"
import { listBooksAction } from "@/app/actions/library"
import { moveBooksShelfAction } from "@/app/actions/books"
import { BookCover } from "@/components/book-cover"
import { displayCover } from "@/lib/book-covers"
import { BookStatusBadge } from "@/components/book-status-badge"
import { RatingStars } from "@/components/rating-stars"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { LoadingState } from "@/components/loading-state"
import { SavedBookViews } from "@/components/saved-book-views"
import { PrintCatalogueLink } from "@/components/print-catalogue-link"
import { applySavedView, type SavedViewFilters } from "@/lib/saved-views"
import { BOOK_PAGE_SIZE, bookRowAnchor, buildBookDetailHref, buildCollectionPath, defaultBookSearchFilters, parseBookRowAnchor, normalizeBookSearchQuery, parseBookSearchFilters, serializeBookSearchFilters, type BookSearchFilters, type BookSort, type BookSortKey, type BookStatusFilter, type BookView } from "@/lib/book-search"
import type { Book, Shelf } from "@/lib/types"
import { unwrapAction } from "@/lib/action-result"
import { DomainError } from "@/lib/domain-errors"

interface BooksTableProps {
  initialView?: BookView
}

const SORT_OPTIONS: ReadonlyArray<{ value: BookSort; label: string }> = [
  { value: "title", label: "Título (A-Z)" },
  { value: "-title", label: "Título (Z-A)" },
  { value: "author", label: "Autor (A-Z)" },
  { value: "-author", label: "Autor (Z-A)" },
  { value: "date", label: "Publicación (más antigua)" },
  { value: "-date", label: "Publicación (más reciente)" },
  { value: "pages", label: "Menos páginas" },
  { value: "-pages", label: "Más páginas" },
  { value: "status", label: "Estado (A-Z)" },
  { value: "-status", label: "Estado (Z-A)" },
]

// Un cambio de filtros, orden, vista o página descarta el fragmento de la fila recordada:
// ya no apunta a lo que se está viendo y no debe restaurarse un desplazamiento obsoleto.
function updateAddress(filters: BookSearchFilters, defaultView: BookView = "table", replace = false): void {
  const params = new URLSearchParams(window.location.search)
  const query = serializeBookSearchFilters(filters, params, defaultView)
  const nextUrl = `${window.location.pathname}${query ? `?${query}` : ""}`
  if (nextUrl === `${window.location.pathname}${window.location.search}` && !window.location.hash) return
  if (replace) window.history.replaceState(window.history.state, "", nextUrl)
  else window.history.pushState(window.history.state, "", nextUrl)
}

function getBookSortLabel(sort: BookSort): string {
  return SORT_OPTIONS.find((option) => option.value === sort)?.label ?? "Título (A-Z)"
}

function requestKey(filters: BookSearchFilters): string {
  return JSON.stringify([filters.q, filters.status, filters.shelf, filters.series ?? "all", filters.sort, filters.page, filters.pageSize ?? BOOK_PAGE_SIZE, filters.tagIds ?? [], filters.tagMode ?? "or"])
}

export function BooksTable({ initialView = "table" }: BooksTableProps) {
  const pathname = usePathname()
  const [filters, setFilters] = useState<BookSearchFilters>(() => defaultBookSearchFilters(initialView))
  const pageSize = filters.pageSize ?? BOOK_PAGE_SIZE
  const [queryInput, setQueryInput] = useState("")
  const [showFilters, setShowFilters] = useState(false)
  const [ready, setReady] = useState(false)
  const [books, setBooks] = useState<Book[]>([])
  const [total, setTotal] = useState(0)
  const [tags, setTags] = useState<Tag[]>([])
  const [tagError, setTagError] = useState(false)
  const [shelves, setShelves] = useState<Shelf[]>([])
  const [shelvesLoading, setShelvesLoading] = useState(true)
  const [shelvesError, setShelvesError] = useState(false)
  const [seriesOptions, setSeriesOptions] = useState<Array<{ id: string; title: string }>>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState(false)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [retryToken, setRetryToken] = useState(0)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [moveTargetShelf, setMoveTargetShelf] = useState("none")
  const [movePending, setMovePending] = useState(false)
  const [moveError, setMoveError] = useState<string | null>(null)
  const requestSequence = useRef(0)
  const requestedFilters = useRef<string | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const pageSelection = useRef<HTMLInputElement>(null)
  const restoreMoveFocus = useRef(false)
  const { q: filterQuery, status: filterStatus, shelf: filterShelf, series: filterSeriesValue, sort: filterSort, page: filterPage } = filters
  const filterSeries = filterSeriesValue ?? "all"
  const filterTagKey = JSON.stringify(filters.tagIds ?? [])
  const filterTagMode = filters.tagMode ?? "or"

  useEffect(() => {
    if (loading || movePending || !restoreMoveFocus.current) return
    restoreMoveFocus.current = false
    // La barra de movimiento desaparece al vaciar la selección; devuelve el foco
    // a un control que permanece, también cuando el filtro queda sin resultados.
    const target = books.length ? pageSelection.current : searchInput.current
    target?.focus()
  }, [loading, movePending, books])

  useEffect(() => {
    const readAddress = () => {
      const params = new URLSearchParams(window.location.search)
      const parsed = parseBookSearchFilters(params, initialView)
      setFilters(parsed)
      setQueryInput(parsed.q)
      // Canoniza los parámetros malformados sin añadir entradas al historial ni perder el ancla.
      const query = serializeBookSearchFilters(parsed, params, initialView)
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`)
      setSelectedIds([])
      if (requestKey(parsed) !== requestedFilters.current) setLoading(true)
      setReady(true)
    }
    readAddress()
    window.addEventListener("popstate", readAddress)
    return () => window.removeEventListener("popstate", readAddress)
  }, [initialView])

  const loadShelves = useCallback(() => getShelvesAction().then((loaded) => {
      setShelves(loaded)
      setShelvesError(false)
    }).catch((error: unknown) => {
      console.error("Error loading shelves for book collection:", error)
      setShelvesError(true)
    }).finally(() => {
      setShelvesLoading(false)
    }), [])

  useEffect(() => { void loadShelves() }, [loadShelves])
  const loadTags = useCallback(() => getTagsAction().then((rows) => { setTags(rows); setTagError(false) }).catch(() => setTagError(true)), [])
  useEffect(() => { void loadTags() }, [loadTags])

  // U-PRO-05: el filtro por serie solo aparece si la cuenta tiene series; un fallo aquí no bloquea el catálogo.
  useEffect(() => {
    void listSeriesAction().then((result) => { if (result.ok) setSeriesOptions(result.value.map((item) => ({ id: item.id, title: item.title }))) }).catch(() => setSeriesOptions([]))
  }, [])

  // Al volver desde una ficha la URL trae `#book-row-<id>`: cuando ya está el listado se muestra esa fila
  // una sola vez y se retira el fragmento. Si la fila no está en esta página, simplemente se ignora.
  useEffect(() => {
    if (!ready || !hasLoaded || loading || listError) return
    const bookId = parseBookRowAnchor(window.location.hash)
    if (!bookId) return
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`)
    const row = document.getElementById(bookRowAnchor(bookId))
    if (!row) return
    row.scrollIntoView({ block: "center" })
    row.querySelector<HTMLElement>("a[href]")?.focus({ preventScroll: true })
  }, [ready, hasLoaded, loading, listError, books])

  useEffect(() => {
    if (!ready || queryInput === filters.q) return
    const timeout = window.setTimeout(() => {
      const next = { ...filters, q: queryInput, page: 1 }
      setFilters(next)
      setLoading(true)
      setSelectedIds([])
      updateAddress(next, initialView)
    }, 250)
    return () => window.clearTimeout(timeout)
  }, [filters, queryInput, ready, initialView])

  useEffect(() => {
    if (!ready) return
    requestedFilters.current = JSON.stringify([filterQuery, filterStatus, filterShelf, filterSeries, filterSort, filterPage, pageSize, JSON.parse(filterTagKey), filterTagMode])
    const requestId = ++requestSequence.current
    void listBooksAction({
      q: normalizeBookSearchQuery(filterQuery),
      status: filterStatus,
      shelf: filterShelf,
      series: filterSeries,
      sort: filterSort,
      page: filterPage,
      pageSize,
      tagIds: JSON.parse(filterTagKey) as string[], tagMode: filterTagMode,
    }).then((result) => {
      if (requestSequence.current !== requestId) return
      setBooks(result.books)
      setListError(false)
      setTotal(result.total)
      setHasLoaded(true)
      setSelectedIds([])
      if (result.page !== filterPage) {
        setFilters((current) => {
          const next = { ...current, page: result.page }
          updateAddress(next, initialView, true)
          return next
        })
      }
    }).catch((error: unknown) => {
      if (requestSequence.current !== requestId) return
      console.error("Error loading paginated books:", error)
      setListError(true)
    }).finally(() => {
      if (requestSequence.current === requestId) setLoading(false)
    })
    return () => {
      if (requestSequence.current === requestId) requestSequence.current += 1
    }
  }, [filterQuery, filterStatus, filterShelf, filterSeries, filterSort, filterPage, pageSize, ready, retryToken, initialView, filterTagKey, filterTagMode])

  const updateFilters = useCallback((update: Partial<BookSearchFilters>, resetPage = true) => {
    if (update.view === undefined) setLoading(true)
    setSelectedIds([])
    setFilters((current) => {
      const next = { ...current, ...update, page: resetPage ? 1 : update.page ?? current.page }
      updateAddress(next, initialView)
      return next
    })
  }, [initialView])

  const clearFilters = () => {
    const next: BookSearchFilters = { ...filters, q: "", status: "all", shelf: "all", series: "all", sort: "title", page: 1, tagIds: [], tagMode: "or" }
    setQueryInput("")
    setFilters(next)
    setSelectedIds([])
    if (requestKey(next) !== requestedFilters.current) setLoading(true)
    updateAddress(next, initialView)
  }

  const changeQuery = (value: string) => setQueryInput(value.slice(0, 500))
  const changeStatus = (status: BookStatusFilter) => updateFilters({ status })
  const changeShelf = (shelf: string) => updateFilters({ shelf })
  const changeSeries = (series: string) => updateFilters({ series })
  const changeSort = (sort: BookSort) => updateFilters({ sort })
  const changeView = (view: BookView) => updateFilters({ view }, false)
  const retryList = () => { setLoading(true); setRetryToken((current) => current + 1) }
  const selectedAllOnPage = books.length > 0 && books.every((book) => selectedIds.includes(book.id))
  const toggleBookSelection = (bookId: string, checked: boolean) => {
    setSelectedIds((current) => checked ? [...new Set([...current, bookId])] : current.filter((id) => id !== bookId))
    setMoveError(null)
  }
  const togglePageSelection = (checked: boolean) => {
    setSelectedIds(checked ? books.map((book) => book.id) : [])
    setMoveError(null)
  }
  const moveSelectedBooks = async () => {
    if (moveTargetShelf === "none" || selectedIds.length === 0 || movePending) return
    setMovePending(true)
    setMoveError(null)
    try {
      unwrapAction(await moveBooksShelfAction(selectedIds, moveTargetShelf))
      restoreMoveFocus.current = true
      setSelectedIds([])
      retryList()
      await loadShelves()
    } catch (error) {
      setMoveError(error instanceof DomainError ? error.message : "No se pudieron mover los libros seleccionados. Inténtalo de nuevo.")
    } finally {
      setMovePending(false)
    }
  }

  const applyView = async (saved: SavedViewFilters) => {
    // Se consulta al aplicar: una estantería puede haberse borrado desde que se abrió el panel.
    const currentShelves = await getShelvesAction()
    const next = applySavedView(saved, currentShelves.map((shelf) => shelf.id))
    setShelves(currentShelves)
    setFilters(next)
    setQueryInput(next.q)
    setSelectedIds([])
    if (requestKey(next) !== requestedFilters.current) setLoading(true)
    updateAddress(next, initialView)
  }
  const collectionPath = buildCollectionPath(pathname, filters, initialView)
  const detailHref = (bookId: string) => buildBookDetailHref(bookId, `${collectionPath}#${bookRowAnchor(bookId)}`)
  // El historial de esta entrada recuerda la fila abierta para que «Atrás» la recupere.
  const rememberOpenedBook = (event: MouseEvent<HTMLAnchorElement>, bookId: string) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}#${bookRowAnchor(bookId)}`)
  }
  const pageCount = Math.ceil(total / pageSize)
  const firstResult = total === 0 ? 0 : (filters.page - 1) * pageSize + 1
  const lastResult = Math.min(filters.page * pageSize, total)
  const hasCriteria = Boolean(filters.q || filters.status !== "all" || filters.shelf !== "all" || filterSeries !== "all" || filters.tagIds?.length)
  const canClear = hasCriteria || filters.sort !== "title"
  const columns = [
    { key: "title" as const, label: "Título" },
    { key: "author" as const, label: "Autor(es)" },
    { key: "pages" as const, label: "Páginas" },
    { key: "date" as const, label: "Publicado" },
    { key: "status" as const, label: "Estado" },
  ]

  const sortColumn = (key: BookSortKey) => {
    const nextSort: BookSort = filters.sort === key ? `-${key}` as BookSort : key
    changeSort(nextSort)
  }

  if (loading && !hasLoaded && !listError) {
    return <LoadingState message="Cargando tu catálogo..." />
  }

  if (listError && !hasLoaded) {
    return <div role="alert" className="rounded-2xl border border-destructive/40 bg-card p-8 text-center shadow-xl"><p className="mb-4 text-foreground">No se pudo cargar tu catálogo.</p><Button onClick={retryList}>Reintentar</Button></div>
  }

  return (
    <div className="space-y-4">
      {listError && <div role="alert" className="flex flex-col items-start justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4 sm:flex-row sm:items-center"><p className="text-sm text-foreground">No se pudieron actualizar los resultados. Se conserva la página anterior.</p><Button variant="outline" size="sm" onClick={retryList}>Reintentar</Button></div>}
      {shelvesError && <div role="alert" className="flex flex-col items-start justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4 sm:flex-row sm:items-center"><p className="text-sm text-foreground">No se pudieron cargar las estanterías; el filtro no está disponible.</p><Button variant="outline" size="sm" onClick={() => void loadShelves()}>Reintentar estanterías</Button></div>}

      <SavedBookViews filters={filters} onApply={applyView} />
      <PrintCatalogueLink filters={filters} disabled={loading || listError} />
      {Boolean(filters.tagIds?.length) && <p className="text-sm text-muted-foreground">Para conservar los filtros por etiquetas, guarda la dirección de esta página. Las vistas guardadas todavía no admiten etiquetas.</p>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(16rem,2fr)_minmax(12rem,1fr)_minmax(12rem,1fr)]">
        <div>
          <label htmlFor="book-search" className="mb-2 block text-sm font-medium text-foreground">Buscar por título, autor o ISBN</label>
          <div className="relative"><Search aria-hidden="true" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input ref={searchInput} id="book-search" placeholder="Título, autor, ISBN..." value={queryInput} maxLength={500} onChange={(event) => changeQuery(event.target.value)} className="border-border bg-surface pl-9" /></div>
        </div>
        <div id="book-status-filters" className={showFilters ? "" : "hidden sm:block"}>
          <label htmlFor="book-status" className="mb-2 block text-sm font-medium text-foreground">Estado</label>
          <Select value={filters.status} onValueChange={(value) => changeStatus(value as BookStatusFilter)}><SelectTrigger id="book-status" aria-label="Filtrar por estado" className="w-full border-border bg-surface"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Todos los estados</SelectItem><SelectItem value="to-read">Por leer</SelectItem><SelectItem value="reading">Leyendo</SelectItem><SelectItem value="read">Leído</SelectItem><SelectItem value="unread">Sin leer</SelectItem></SelectContent></Select>
        </div>
        <div id="book-shelf-filters" className={showFilters ? "" : "hidden sm:block"}>
          <label htmlFor="book-shelf" className="mb-2 block text-sm font-medium text-foreground">Estantería</label>
          <Select value={filters.shelf} onValueChange={changeShelf} disabled={shelvesLoading || shelvesError}><SelectTrigger id="book-shelf" aria-label="Filtrar por estantería" className="w-full border-border bg-surface"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Todas las estanterías</SelectItem>{shelves.map((shelf) => <SelectItem key={shelf.id} value={shelf.id}>{shelf.title}</SelectItem>)}</SelectContent></Select>
        </div>
        {(seriesOptions.length > 0 || filterSeries !== "all") && <div id="book-series-filters" className={showFilters ? "" : "hidden sm:block"}>
          <label htmlFor="book-series" className="mb-2 block text-sm font-medium text-foreground">Serie</label>
          <Select value={filterSeries} onValueChange={changeSeries}><SelectTrigger id="book-series" aria-label="Filtrar por serie" className="w-full border-border bg-surface"><SelectValue placeholder="Serie no disponible" /></SelectTrigger><SelectContent><SelectItem value="all">Todas las series</SelectItem>{seriesOptions.map((item) => <SelectItem key={item.id} value={item.id}>{item.title}</SelectItem>)}</SelectContent></Select>
        </div>}
      </div>

      <fieldset id="book-tag-filters" className={showFilters ? "space-y-3 rounded-xl border border-border p-3" : "hidden space-y-3 rounded-xl border border-border p-3 sm:block"}>
        <legend className="px-2 text-sm font-medium">Filtrar por etiquetas</legend>
        {tagError ? <div role="alert"><p>No se pudieron cargar las etiquetas.</p><Button variant="outline" size="sm" onClick={() => void loadTags()}>Reintentar etiquetas</Button></div> : <div className="flex max-h-48 flex-wrap gap-2 overflow-y-auto">{tags.map((tag) => <label key={tag.id} className="flex min-h-11 items-center gap-2 rounded-full border border-border bg-card px-3 text-sm transition-colors hover:bg-accent has-checked:border-brass has-checked:bg-accent"><input type="checkbox" checked={filters.tagIds?.includes(tag.id) ?? false} disabled={(filters.tagIds?.length ?? 0) >= 20 && !filters.tagIds?.includes(tag.id)} onChange={(event) => updateFilters({ tagIds: event.target.checked ? [...(filters.tagIds ?? []), tag.id] : filters.tagIds?.filter((id) => id !== tag.id) })} className="accent-primary" />{tag.name}</label>)}</div>}
        {!tags.length && !tagError && <p className="text-sm text-muted-foreground">Aún no hay etiquetas.</p>}
        <label className="flex flex-wrap items-center gap-2 text-sm">Coincidencia de etiquetas<select aria-label="Coincidencia de etiquetas" value={filters.tagMode ?? "or"} onChange={(event) => updateFilters({ tagMode: event.target.value as "or" | "and" })} className="rounded-md border border-input bg-input px-3 py-2"><option value="or">Cualquiera (OR)</option><option value="and">Todas (AND)</option></select></label>
      </fieldset>

      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div id="book-sort-filters" className={showFilters ? "w-full sm:max-w-xs" : "hidden w-full sm:block sm:max-w-xs"}><label htmlFor="book-sort" className="mb-2 block text-sm font-medium text-foreground">Ordenar por</label><Select value={filters.sort} onValueChange={(value) => changeSort(value as BookSort)}><SelectTrigger id="book-sort" aria-label="Ordenar libros" className="w-full border-border bg-surface"><SelectValue>{getBookSortLabel(filters.sort)}</SelectValue></SelectTrigger><SelectContent>{SORT_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></div>
        <div className="flex items-center justify-between gap-3">
          <Button className="sm:hidden" variant="outline" size="sm" onClick={() => setShowFilters((current) => !current)} aria-expanded={showFilters} aria-controls={`book-status-filters book-shelf-filters ${seriesOptions.length > 0 || filterSeries !== "all" ? "book-series-filters " : ""}book-sort-filters book-tag-filters`}><Filter aria-hidden="true" />Filtros{hasCriteria ? " activos" : ""}</Button>
          <div className="flex items-center gap-1 rounded-xl border border-border bg-surface p-1" role="group" aria-label="Vista de la colección"><Button type="button" size="sm" variant={filters.view === "table" ? "secondary" : "ghost"} aria-pressed={filters.view === "table"} aria-label="Vista de tabla" onClick={() => changeView("table")}><List aria-hidden="true" /></Button><Button type="button" size="sm" variant={filters.view === "grid" ? "secondary" : "ghost"} aria-pressed={filters.view === "grid"} aria-label="Vista de cuadrícula" onClick={() => changeView("grid")}><LayoutGrid aria-hidden="true" /></Button></div>
          {canClear && <Button variant="ghost" size="sm" onClick={clearFilters}><X aria-hidden="true" />Limpiar filtros</Button>}
        </div>
      </div>

      <p className="text-sm text-muted-foreground" aria-live="polite">{loading ? "Actualizando resultados… " : ""}{total} resultado{total === 1 ? "" : "s"}</p>

      {books.length > 0 && <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface/50 p-3 sm:flex-row sm:items-center sm:justify-between">
        <label className="flex items-center gap-2 text-sm font-medium text-foreground"><input ref={pageSelection} type="checkbox" checked={selectedAllOnPage} disabled={loading || movePending} onChange={(event) => togglePageSelection(event.target.checked)} aria-label="Seleccionar todos los libros de esta página" className="h-4 w-4 accent-primary" />Seleccionar esta página<span className="whitespace-nowrap text-muted-foreground">({selectedIds.length})</span></label>
        {selectedIds.length > 0 && <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label htmlFor="move-books-shelf" className="sr-only">Estantería de destino</label>
          <Select value={moveTargetShelf} onValueChange={setMoveTargetShelf} disabled={shelvesLoading || shelvesError || movePending}><SelectTrigger id="move-books-shelf" aria-label="Estantería de destino" className="w-full border-border bg-surface sm:w-56"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Mover a estantería…</SelectItem>{shelves.map((shelf) => <SelectItem key={shelf.id} value={shelf.id}>{shelf.title}</SelectItem>)}</SelectContent></Select>
          <Button onClick={() => void moveSelectedBooks()} disabled={moveTargetShelf === "none" || movePending || loading}>{movePending ? "Moviendo…" : `Mover ${selectedIds.length} libro${selectedIds.length === 1 ? "" : "s"}`}</Button>
        </div>}
        {moveError && <p role="alert" className="text-sm text-destructive sm:basis-full">{moveError}</p>}
      </div>}

      {total === 0 ? (
        hasCriteria ? <div className="rounded-2xl border border-dashed border-control-border/60 bg-surface/50 px-6 py-12 text-center"><Filter aria-hidden="true" className="mx-auto mb-3 h-6 w-6 text-brass-text" /><p className="font-medium text-foreground">No hay libros con estos filtros</p><Button variant="link" onClick={clearFilters} className="mt-2">Limpiar filtros</Button></div> : <div className="rounded-2xl border border-dashed border-control-border/60 bg-surface/50 px-6 py-12 text-center"><p className="mb-4 font-heading text-xl text-heading">Aún no tienes libros en tu biblioteca.</p><Button asChild><Link tabIndex={0} href="/books/add"><Plus aria-hidden="true" />Agrega tu primer libro</Link></Button></div>
      ) : filters.view === "table" ? (
        <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
          <Table><TableHeader className="bg-surface"><TableRow><TableHead scope="col"><span className="sr-only">Seleccionar</span></TableHead><TableHead scope="col" className="text-foreground">Portada</TableHead>{columns.map(({ key, label }) => {const active = filters.sort === key || filters.sort === `-${key}`; const direction = filters.sort.startsWith("-") ? "desc" : "asc"; return <TableHead key={key} scope="col" aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"} className="p-0 text-foreground"><button type="button" onClick={() => sortColumn(key)} className="flex min-h-11 w-full items-center gap-2 px-4 text-left font-semibold hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{label}{active && <span aria-hidden="true">{direction === "desc" ? "↓" : "↑"}</span>}<span className="sr-only">{active ? `Orden actual ${direction === "asc" ? "ascendente" : "descendente"}` : "Ordenar"}</span></button></TableHead>})}<TableHead scope="col" className="text-foreground">Acciones</TableHead></TableRow></TableHeader>
            <TableBody>{books.map((book) => <TableRow key={book.id} id={bookRowAnchor(book.id)} className="scroll-mt-28 border-b border-border hover:bg-surface/50"><TableCell><input type="checkbox" checked={selectedIds.includes(book.id)} disabled={loading || movePending} onChange={(event) => toggleBookSelection(book.id, event.target.checked)} aria-label={`Seleccionar ${book.title}`} className="h-4 w-4 accent-primary" /></TableCell><TableCell><BookCover cover={displayCover(book)} title={book.title} className="w-10" size="small" sizes="40px" /></TableCell><TableCell><p className="font-semibold text-foreground">{book.title}</p><PersonalSummary book={book} tags={tags} />{book.subtitle && <p className="text-xs text-muted-foreground">{book.subtitle}</p>}</TableCell><TableCell>{book.authors.length ? book.authors.map((author) => author.name).join(", ") : "Desconocido"}</TableCell><TableCell>{book.number_of_pages || "—"}</TableCell><TableCell>{book.publish_date || "—"}</TableCell><TableCell><BookStatusBadge status={book.status} /></TableCell><TableCell><Link tabIndex={0} href={detailHref(book.id)} onClick={(event) => rememberOpenedBook(event, book.id)} className="link-quiet inline-flex min-h-11 items-center">Ver<span className="sr-only"> {book.title}</span></Link></TableCell></TableRow>)}</TableBody>
          </Table>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">{books.map((book) => <article key={book.id} id={bookRowAnchor(book.id)} className="surface-card flex h-full scroll-mt-28 flex-col overflow-hidden transition-[transform,box-shadow] duration-300 hover:shadow-xl motion-safe:hover:-translate-y-0.5"><div className="flex items-center justify-between gap-2 p-3"><label className="flex items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" checked={selectedIds.includes(book.id)} disabled={loading || movePending} onChange={(event) => toggleBookSelection(book.id, event.target.checked)} aria-label={`Seleccionar ${book.title}`} className="h-4 w-4 accent-primary" />Seleccionar</label><BookStatusBadge status={book.status} /></div><Link tabIndex={0} href={detailHref(book.id)} onClick={(event) => rememberOpenedBook(event, book.id)} className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><BookCover cover={displayCover(book)} title={book.title} className="w-full rounded-none border-x-0 border-b-0 border-t bg-surface" sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw" /></Link><div className="flex flex-1 flex-col gap-2 p-5"><h2 className="line-clamp-2 text-lg leading-snug font-bold"><Link tabIndex={0} href={detailHref(book.id)} onClick={(event) => rememberOpenedBook(event, book.id)} className="underline-offset-4 hover:underline hover:decoration-brass">{book.title}</Link></h2><PersonalSummary book={book} tags={tags} /><p className="text-sm text-muted-foreground">{book.authors.map((author) => author.name).join(", ") || "Desconocido"}</p><div className="mt-auto flex items-end justify-between gap-3 pt-3"><span className="text-xs text-muted-foreground">{book.shelf_name}</span></div></div></article>)}</div>
      )}

      <div className="flex flex-col items-center justify-between gap-4 pt-2 sm:flex-row"><p className="text-center text-sm text-muted-foreground sm:text-left">Mostrando {firstResult} a {lastResult} de {total} libros</p><nav aria-label="Paginación de libros" className="flex items-center gap-2"><Button variant="outline" size="sm" aria-label="Página anterior" onClick={() => updateFilters({ page: Math.max(filters.page - 1, 1) }, false)} disabled={filters.page <= 1 || loading}><ChevronLeft aria-hidden="true" /></Button><span className="min-w-24 text-center text-sm text-muted-foreground">Página {pageCount ? Math.min(filters.page, pageCount) : 0} de {pageCount}</span><Button variant="outline" size="sm" aria-label="Página siguiente" onClick={() => updateFilters({ page: Math.min(filters.page + 1, pageCount) }, false)} disabled={filters.page >= pageCount || loading}><ChevronRight aria-hidden="true" /></Button></nav></div>
    </div>
  )
}

function PersonalSummary({ book, tags }: { book: Book; tags: Tag[] }) {
  return <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">{book.personal?.rating && <span className="inline-flex items-center gap-1"><RatingStars value={book.personal.rating} className="text-xs" />Valoración: {book.personal.rating} de 5</span>}{book.personal?.tagIds?.map((id) => <span key={id} className="rounded-full border border-border bg-surface px-2">{tags.find((tag) => tag.id === id)?.name ?? "Etiqueta"}</span>)}</div>
}
