"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { ChevronLeft, ChevronRight, Filter, LayoutGrid, List, Plus, Search, X } from "lucide-react"
import { getShelvesAction } from "@/app/actions/shelves"
import { listBooksAction } from "@/app/actions/library"
import { moveBooksShelfAction } from "@/app/actions/books"
import { BookCover } from "@/components/book-cover"
import { BookStatusBadge } from "@/components/book-status-badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { LoadingState } from "@/components/loading-state"
import { BOOK_PAGE_SIZE, defaultBookSearchFilters, normalizeBookSearchQuery, parseBookSearchFilters, serializeBookSearchFilters, type BookSearchFilters, type BookSort, type BookSortKey, type BookStatusFilter, type BookView } from "@/lib/book-search"
import type { Book, Shelf } from "@/lib/types"
import { unwrapAction } from "@/lib/action-result"

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

function updateAddress(filters: BookSearchFilters, defaultView: BookView = "table"): void {
  const params = new URLSearchParams(window.location.search)
  const query = serializeBookSearchFilters(filters, params, defaultView)
  const nextUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`
  window.history.replaceState(window.history.state, "", nextUrl)
}

function getBookSortLabel(sort: BookSort): string {
  return SORT_OPTIONS.find((option) => option.value === sort)?.label ?? "Título (A-Z)"
}

export function BooksTable({ initialView = "table" }: BooksTableProps) {
  const [filters, setFilters] = useState<BookSearchFilters>(() => defaultBookSearchFilters(initialView))
  const [queryInput, setQueryInput] = useState("")
  const [showFilters, setShowFilters] = useState(false)
  const [ready, setReady] = useState(false)
  const [books, setBooks] = useState<Book[]>([])
  const [total, setTotal] = useState(0)
  const [shelves, setShelves] = useState<Shelf[]>([])
  const [shelvesLoading, setShelvesLoading] = useState(true)
  const [shelvesError, setShelvesError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState(false)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [retryToken, setRetryToken] = useState(0)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [moveTargetShelf, setMoveTargetShelf] = useState("none")
  const [movePending, setMovePending] = useState(false)
  const [moveError, setMoveError] = useState<string | null>(null)
  const requestSequence = useRef(0)
  const { q: filterQuery, status: filterStatus, shelf: filterShelf, sort: filterSort, page: filterPage } = filters

  useEffect(() => {
    const readAddress = () => {
      const parsed = parseBookSearchFilters(new URLSearchParams(window.location.search), initialView)
      setFilters(parsed)
      setQueryInput(parsed.q)
      setSelectedIds([])
      setLoading(true)
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
    const requestId = ++requestSequence.current
    void listBooksAction({
      q: normalizeBookSearchQuery(filterQuery),
      status: filterStatus,
      shelf: filterShelf,
      sort: filterSort,
      page: filterPage,
      pageSize: BOOK_PAGE_SIZE,
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
          updateAddress(next, initialView)
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
  }, [filterQuery, filterStatus, filterShelf, filterSort, filterPage, ready, retryToken, initialView])

  const updateFilters = useCallback((update: Partial<BookSearchFilters>, resetPage = true) => {
    if (update.view === undefined) setLoading(true)
    if (resetPage || update.page !== undefined) setSelectedIds([])
    setFilters((current) => {
      const next = { ...current, ...update, page: resetPage ? 1 : update.page ?? current.page }
      updateAddress(next, initialView)
      return next
    })
  }, [initialView])

  const clearFilters = () => {
    setLoading(true)
    const next: BookSearchFilters = { ...filters, q: "", status: "all", shelf: "all", sort: "title", page: 1 }
    setQueryInput("")
    setFilters(next)
    setSelectedIds([])
    updateAddress(next, initialView)
  }

  const changeQuery = (value: string) => setQueryInput(value)
  const changeStatus = (status: BookStatusFilter) => updateFilters({ status })
  const changeShelf = (shelf: string) => updateFilters({ shelf })
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
      setSelectedIds([])
      retryList()
      await loadShelves()
    } catch (error) {
      setMoveError(error instanceof Error ? error.message : "No se pudieron mover los libros seleccionados.")
    } finally {
      setMovePending(false)
    }
  }

  const pageCount = Math.ceil(total / BOOK_PAGE_SIZE)
  const firstResult = total === 0 ? 0 : (filters.page - 1) * BOOK_PAGE_SIZE + 1
  const lastResult = Math.min(filters.page * BOOK_PAGE_SIZE, total)
  const hasCriteria = Boolean(filters.q || filters.status !== "all" || filters.shelf !== "all")
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

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(16rem,2fr)_minmax(12rem,1fr)_minmax(12rem,1fr)]">
        <div>
          <label htmlFor="book-search" className="mb-2 block text-sm font-medium text-foreground">Buscar por título, autor o ISBN</label>
          <div className="relative"><Search aria-hidden="true" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input id="book-search" placeholder="Título, autor, ISBN..." value={queryInput} onChange={(event) => changeQuery(event.target.value)} className="border-border bg-surface pl-9" /></div>
        </div>
        <div id="book-status-filters" className={showFilters ? "" : "hidden sm:block"}>
          <label htmlFor="book-status" className="mb-2 block text-sm font-medium text-foreground">Estado</label>
          <Select value={filters.status} onValueChange={(value) => changeStatus(value as BookStatusFilter)}><SelectTrigger id="book-status" aria-label="Filtrar por estado" className="w-full border-border bg-surface"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Todos los estados</SelectItem><SelectItem value="to-read">Por leer</SelectItem><SelectItem value="reading">Leyendo</SelectItem><SelectItem value="read">Leído</SelectItem><SelectItem value="unread">Sin leer</SelectItem></SelectContent></Select>
        </div>
        <div id="book-shelf-filters" className={showFilters ? "" : "hidden sm:block"}>
          <label htmlFor="book-shelf" className="mb-2 block text-sm font-medium text-foreground">Estantería</label>
          <Select value={filters.shelf} onValueChange={changeShelf} disabled={shelvesLoading || shelvesError}><SelectTrigger id="book-shelf" aria-label="Filtrar por estantería" className="w-full border-border bg-surface"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Todas las estanterías</SelectItem>{shelves.map((shelf) => <SelectItem key={shelf.id} value={shelf.id}>{shelf.title}</SelectItem>)}</SelectContent></Select>
        </div>
      </div>

      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div id="book-sort-filters" className={showFilters ? "w-full sm:max-w-xs" : "hidden w-full sm:block sm:max-w-xs"}><label htmlFor="book-sort" className="mb-2 block text-sm font-medium text-foreground">Ordenar por</label><Select value={filters.sort} onValueChange={(value) => changeSort(value as BookSort)}><SelectTrigger id="book-sort" aria-label="Ordenar libros" className="w-full border-border bg-surface"><SelectValue>{getBookSortLabel(filters.sort)}</SelectValue></SelectTrigger><SelectContent>{SORT_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></div>
        <div className="flex items-center justify-between gap-3">
          <Button className="sm:hidden" variant="outline" size="sm" onClick={() => setShowFilters((current) => !current)} aria-expanded={showFilters} aria-controls="book-status-filters book-shelf-filters book-sort-filters"><Filter aria-hidden="true" />Filtros{hasCriteria ? " activos" : ""}</Button>
          <div className="flex items-center rounded-lg border border-border p-1" role="group" aria-label="Vista de la colección"><Button type="button" size="sm" variant={filters.view === "table" ? "secondary" : "ghost"} aria-pressed={filters.view === "table"} aria-label="Vista de tabla" onClick={() => changeView("table")}><List aria-hidden="true" /></Button><Button type="button" size="sm" variant={filters.view === "grid" ? "secondary" : "ghost"} aria-pressed={filters.view === "grid"} aria-label="Vista de cuadrícula" onClick={() => changeView("grid")}><LayoutGrid aria-hidden="true" /></Button></div>
          {canClear && <Button variant="ghost" size="sm" onClick={clearFilters}><X aria-hidden="true" />Limpiar filtros</Button>}
        </div>
      </div>

      <p className="text-sm text-muted-foreground" aria-live="polite">{loading ? "Actualizando resultados… " : ""}{total} resultado{total === 1 ? "" : "s"}</p>

      {books.length > 0 && <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface/50 p-3 sm:flex-row sm:items-center sm:justify-between">
        <label className="flex items-center gap-2 text-sm font-medium text-foreground"><input type="checkbox" checked={selectedAllOnPage} disabled={loading || movePending} onChange={(event) => togglePageSelection(event.target.checked)} aria-label="Seleccionar todos los libros de esta página" className="h-4 w-4 accent-primary" />Seleccionar esta página<span className="whitespace-nowrap text-muted-foreground">({selectedIds.length})</span></label>
        {selectedIds.length > 0 && <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label htmlFor="move-books-shelf" className="sr-only">Estantería de destino</label>
          <Select value={moveTargetShelf} onValueChange={setMoveTargetShelf} disabled={shelvesLoading || shelvesError || movePending}><SelectTrigger id="move-books-shelf" aria-label="Estantería de destino" className="w-full border-border bg-surface sm:w-56"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Mover a estantería…</SelectItem>{shelves.map((shelf) => <SelectItem key={shelf.id} value={shelf.id}>{shelf.title}</SelectItem>)}</SelectContent></Select>
          <Button onClick={() => void moveSelectedBooks()} disabled={moveTargetShelf === "none" || movePending || loading}>{movePending ? "Moviendo…" : `Mover ${selectedIds.length} libro${selectedIds.length === 1 ? "" : "s"}`}</Button>
        </div>}
        {moveError && <p role="alert" className="text-sm text-destructive sm:basis-full">{moveError}</p>}
      </div>}

      {total === 0 ? (
        hasCriteria ? <div className="rounded-xl border border-border bg-surface/60 px-6 py-12 text-center"><Filter aria-hidden="true" className="mx-auto mb-3 h-6 w-6 text-muted-foreground" /><p className="font-medium text-foreground">No hay libros con estos filtros</p><Button variant="link" onClick={clearFilters} className="mt-2">Limpiar filtros</Button></div> : <div className="rounded-xl border border-border bg-surface/60 px-6 py-12 text-center"><p className="mb-4 text-foreground">Aún no tienes libros en tu biblioteca.</p><Button asChild><Link href="/books/add"><Plus aria-hidden="true" />Agrega tu primer libro</Link></Button></div>
      ) : filters.view === "table" ? (
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table><TableHeader className="bg-surface"><TableRow><TableHead scope="col"><span className="sr-only">Seleccionar</span></TableHead><TableHead scope="col" className="text-foreground">Portada</TableHead>{columns.map(({ key, label }) => {const active = filters.sort === key || filters.sort === `-${key}`; const direction = filters.sort.startsWith("-") ? "desc" : "asc"; return <TableHead key={key} scope="col" aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"} className="p-0 text-foreground"><button type="button" onClick={() => sortColumn(key)} className="flex min-h-11 w-full items-center gap-2 px-4 text-left font-semibold hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{label}{active && <span aria-hidden="true">{direction === "desc" ? "↓" : "↑"}</span>}<span className="sr-only">{active ? `Orden actual ${direction === "asc" ? "ascendente" : "descendente"}` : "Ordenar"}</span></button></TableHead>})}<TableHead scope="col" className="text-foreground">Acciones</TableHead></TableRow></TableHeader>
            <TableBody>{books.map((book) => <TableRow key={book.id} className="border-b border-border hover:bg-surface/50"><TableCell><input type="checkbox" checked={selectedIds.includes(book.id)} disabled={loading || movePending} onChange={(event) => toggleBookSelection(book.id, event.target.checked)} aria-label={`Seleccionar ${book.title}`} className="h-4 w-4 accent-primary" /></TableCell><TableCell><BookCover cover={book.cover} title={book.title} className="w-10" size="small" sizes="40px" /></TableCell><TableCell><p className="font-medium text-foreground">{book.title}</p>{book.subtitle && <p className="text-xs text-muted-foreground">{book.subtitle}</p>}</TableCell><TableCell>{book.authors.length ? book.authors.map((author) => author.name).join(", ") : "Desconocido"}</TableCell><TableCell>{book.number_of_pages || "—"}</TableCell><TableCell>{book.publish_date || "—"}</TableCell><TableCell><BookStatusBadge status={book.status} /></TableCell><TableCell><Link href={`/book/${book.id}`} className="font-medium text-primary underline-offset-4 hover:underline">Ver<span className="sr-only"> {book.title}</span></Link></TableCell></TableRow>)}</TableBody>
          </Table>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">{books.map((book) => <article key={book.id} className="flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-lg"><div className="flex items-center justify-between gap-2 p-3"><label className="flex items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" checked={selectedIds.includes(book.id)} disabled={loading || movePending} onChange={(event) => toggleBookSelection(book.id, event.target.checked)} aria-label={`Seleccionar ${book.title}`} className="h-4 w-4 accent-primary" />Seleccionar</label><BookStatusBadge status={book.status} /></div><Link href={`/book/${book.id}`} className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><BookCover cover={book.cover} title={book.title} className="w-full rounded-none border-x-0 border-b-0 border-t" sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw" /></Link><div className="flex flex-1 flex-col gap-2 p-5"><h2 className="line-clamp-2 font-bold text-foreground"><Link href={`/book/${book.id}`} className="underline-offset-4 hover:text-primary hover:underline">{book.title}</Link></h2><p className="text-sm text-muted-foreground">{book.authors.map((author) => author.name).join(", ") || "Desconocido"}</p><div className="mt-auto flex items-end justify-between gap-3 pt-3"><span className="text-xs text-muted-foreground">{book.shelf_name}</span></div></div></article>)}</div>
      )}

      <div className="flex flex-col items-center justify-between gap-4 pt-2 sm:flex-row"><p className="text-center text-sm text-muted-foreground sm:text-left">Mostrando {firstResult} a {lastResult} de {total} libros</p><nav aria-label="Paginación de libros" className="flex items-center gap-2"><Button variant="outline" size="sm" aria-label="Página anterior" onClick={() => updateFilters({ page: Math.max(filters.page - 1, 1) }, false)} disabled={filters.page <= 1 || loading}><ChevronLeft aria-hidden="true" /></Button><span className="min-w-24 text-center text-sm text-muted-foreground">Página {pageCount ? Math.min(filters.page, pageCount) : 0} de {pageCount}</span><Button variant="outline" size="sm" aria-label="Página siguiente" onClick={() => updateFilters({ page: Math.min(filters.page + 1, pageCount) }, false)} disabled={filters.page >= pageCount || loading}><ChevronRight aria-hidden="true" /></Button></nav></div>
    </div>
  )
}
