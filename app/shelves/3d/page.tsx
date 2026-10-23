"use client"

import { useEffect, useRef, useState } from "react"
import { ShelfViewer3D } from "@/components/shelf-viewer-3d"
import { LoadingState } from "@/components/loading-state"
import { Button } from "@/components/ui/button"
import { getShelvesAction } from "@/app/actions/shelves"
import { listBooksAction } from "@/app/actions/library"
import type { Book, Shelf } from "@/lib/types"

const BOOKS_PER_FRAME = 48

export default function Shelf3DPage() {
  const [shelves, setShelves] = useState<Shelf[]>([])
  const [selectedShelfId, setSelectedShelfId] = useState<string | null>(null)
  const [books, setBooks] = useState<Book[]>([])
  const [booksShelfId, setBooksShelfId] = useState<string | null>(null)
  const [booksPage, setBooksPage] = useState(1)
  const [page, setPage] = useState(1)
  const [shelvesLoading, setShelvesLoading] = useState(true)
  const [booksLoading, setBooksLoading] = useState(true)
  const [shelvesError, setShelvesError] = useState(false)
  const [booksError, setBooksError] = useState(false)
  const [shelfRetry, setShelfRetry] = useState(0)
  const [booksRetry, setBooksRetry] = useState(0)
  const booksRequest = useRef(0)
  const selectedShelf = shelves.find((shelf) => shelf.id === selectedShelfId)
  const pageCount = selectedShelf ? Math.ceil(selectedShelf.book_count / BOOKS_PER_FRAME) : 0
  const currentBooks = booksShelfId === selectedShelfId && booksPage === page ? books : []

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setShelvesLoading(true)
      setShelvesError(false)
      void getShelvesAction().then((loadedShelves) => {
        setShelves(loadedShelves)
        setSelectedShelfId((current) => current && loadedShelves.some((shelf) => shelf.id === current)
          ? current
          : loadedShelves[0]?.id ?? null)
      }).catch((error: unknown) => {
        console.error("Error loading shelves for 3D view:", error)
        setShelvesError(true)
      }).finally(() => setShelvesLoading(false))
    }, 0)
    return () => window.clearTimeout(timer)
  }, [shelfRetry])

  useEffect(() => {
    const requestId = ++booksRequest.current
    const timer = window.setTimeout(() => {
      setBooksLoading(true)
      setBooksError(false)
      if (!selectedShelfId) {
        setBooks([])
        setBooksShelfId(null)
        setBooksPage(1)
        setBooksLoading(false)
        return
      }
      void listBooksAction({
        q: "",
        status: "all",
        shelf: selectedShelfId,
        sort: "title",
        page,
        pageSize: BOOKS_PER_FRAME,
      }).then((result) => {
        if (booksRequest.current !== requestId) return
        setBooks(result.books)
        setBooksShelfId(selectedShelfId)
        setBooksPage(result.page)
        if (result.page !== page) setPage(result.page)
      }).catch((error: unknown) => {
        if (booksRequest.current !== requestId) return
        console.error("Error loading 3D shelf page:", error)
        setBooksError(true)
      }).finally(() => { if (booksRequest.current === requestId) setBooksLoading(false) })
    }, 0)
    return () => {
      window.clearTimeout(timer)
      if (booksRequest.current === requestId) booksRequest.current += 1
    }
  }, [selectedShelfId, page, booksRetry])

  const selectShelf = (shelfId: string) => {
    setSelectedShelfId(shelfId)
    setPage(1)
    setBooksLoading(true)
  }

  if (shelvesLoading && shelves.length === 0 && !shelvesError) {
    return <LoadingState message="Cargando estanterías..." />
  }

  return (
    <>
        {shelvesError ? (
          <div role="alert" className="rounded-2xl border border-destructive/40 bg-card p-8 text-center shadow-xl">
            <p className="mb-4 text-foreground">No se pudieron cargar las estanterías. Inténtalo de nuevo.</p>
            <Button onClick={() => setShelfRetry((value) => value + 1)} disabled={shelvesLoading}>Reintentar</Button>
          </div>
        ) : <>
          <div className="mb-8">
            <h1 className="mb-2 text-4xl font-bold heading-vintage">Vista de estantería</h1>
            <p className="text-lg text-muted-foreground">Explora tus libros en una estantería 3D</p>
          </div>

          {shelves.length === 0 ? (
            <div className="rounded-2xl border border-border bg-card p-12 text-center shadow-xl">
              <p className="text-muted-foreground">Aún no hay estanterías.</p>
            </div>
          ) : <div className="grid grid-cols-1 gap-6 lg:grid-cols-4">
            <aside className="space-y-4" aria-label="Selección de estantería">
              <div className="rounded-2xl border border-border bg-card p-6 shadow-xl backdrop-blur-md">
                <h2 className="mb-4 text-lg font-bold text-foreground">Estanterías</h2>
                <div className="space-y-2">
                  {shelves.map((shelf) => (
                    <button
                      key={shelf.id}
                      type="button"
                      onClick={() => selectShelf(shelf.id)}
                      aria-pressed={selectedShelfId === shelf.id}
                      className={`w-full rounded-xl px-3 py-2 text-left transition-colors ${selectedShelfId === shelf.id ? "bg-primary text-primary-foreground" : "bg-surface text-foreground hover:bg-border"}`}
                    >
                      <span className="block text-sm font-medium">{shelf.title}</span>
                      <span className="block text-xs opacity-75">{shelf.book_count} libros</span>
                    </button>
                  ))}
                </div>
              </div>
            </aside>

            <section className="lg:col-span-3" aria-label="Libros en vista 3D">
              <div className="mb-3 flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                <p className="text-sm text-muted-foreground" aria-live="polite">
                  {selectedShelf?.book_count ?? 0} libros · página {pageCount ? Math.min(page, pageCount) : 0} de {pageCount}
                  {booksLoading ? " · Cargando página…" : ""}
                </p>
                <nav aria-label="Páginas de la estantería" className="flex items-center gap-2">
                  <Button variant="outline" size="sm" aria-label="Página anterior" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1 || booksLoading}>
                    Anterior
                  </Button>
                  <Button variant="outline" size="sm" aria-label="Página siguiente" onClick={() => setPage((current) => Math.min(pageCount, current + 1))} disabled={page >= pageCount || booksLoading}>
                    Siguiente
                  </Button>
                </nav>
              </div>
              <p className="mb-4 text-xs text-muted-foreground">La escena muestra hasta {BOOKS_PER_FRAME} libros por página para mantenerla ágil; la altura de cada lomo se calcula con las páginas registradas.</p>
              <div className="min-h-64 overflow-hidden rounded-2xl border border-border bg-card shadow-xl backdrop-blur-md">
                {booksError ? (
                  <div role="alert" className="flex min-h-64 flex-col items-center justify-center gap-4 p-6 text-center">
                    <p className="text-foreground">No se pudo cargar esta página de libros.</p>
                    <Button onClick={() => setBooksRetry((value) => value + 1)} disabled={booksLoading}>Reintentar</Button>
                  </div>
                ) : booksLoading ? (
                  <div className="flex min-h-64 items-center justify-center"><LoadingState message="Cargando libros de la estantería..." /></div>
                ) : currentBooks.length === 0 ? (
                  <div className="flex min-h-64 flex-col items-center justify-center p-6 text-center">
                    <p className="mb-2 text-muted-foreground">No hay libros en esta estantería.</p>
                    <p className="text-sm text-muted-foreground">Agrega libros para verlos en 3D.</p>
                  </div>
                ) : <ShelfViewer3D books={currentBooks} />}
              </div>
            </section>
          </div>}
        </>}
    </>
  )
}
