"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { AlertCircle, BookOpen, Table2 } from "lucide-react"
import { ShelfViewer3D } from "@/components/shelf-viewer-3d"
import { LoadingState } from "@/components/loading-state"
import { Button } from "@/components/ui/button"
import { getShelvesAction } from "@/app/actions/shelves"
import { listBooksAction } from "@/app/actions/library"
import { bookRowAnchor, parseBookRowAnchor } from "@/lib/book-search"
import type { Book, Shelf } from "@/lib/types"
import {
  SCENE_BOOKS_PER_PAGE,
  buildShelf3dPath,
  buildShelfCollectionHref,
  clampScenePage,
  parseShelfSceneParams,
  sceneListRequest,
  scenePageCount,
  type ShelfSceneParams,
} from "./viewer-contract"

/**
 * Vista 3D de estantería: escena CSS estática y paginada por el servidor (máximo
 * 48 libros por página). Se navega con toque y teclado seleccionando estantería y
 * página; no hay rotación, gestos de giro ni zoom, y ningún texto lo promete. La
 * URL conserva la selección para poder volver desde cada ficha y para enlazar a la
 * vista 2D con exactamente los mismos libros.
 */
export default function Shelf3DPage() {
  const [shelves, setShelves] = useState<Shelf[]>([])
  const [shelvesLoading, setShelvesLoading] = useState(true)
  const [shelvesError, setShelvesError] = useState(false)
  const [shelvesRetry, setShelvesRetry] = useState(0)
  const [scene, setScene] = useState<ShelfSceneParams>({ shelf: null, page: 1 })
  const [addressReady, setAddressReady] = useState(false)
  const [addressVersion, setAddressVersion] = useState(0)
  const [books, setBooks] = useState<Book[]>([])
  const [booksShelfId, setBooksShelfId] = useState<string | null>(null)
  const [booksPage, setBooksPage] = useState(1)
  const [booksTotal, setBooksTotal] = useState(0)
  const [booksLoading, setBooksLoading] = useState(true)
  const [booksError, setBooksError] = useState(false)
  const [booksRetry, setBooksRetry] = useState(0)
  const [hasLoadedBooks, setHasLoadedBooks] = useState(false)
  const requestSequence = useRef(0)

  // Selección efectiva: una estantería de la URL que ya no existe cae, durante el
  // propio render, a la primera disponible con la página inicial.
  const listedShelf = scene.shelf && shelves.some((shelf) => shelf.id === scene.shelf) ? scene.shelf : null
  const shelfId = listedShelf ?? (shelves.length > 0 ? shelves[0].id : null)
  const page = listedShelf ? scene.page : 1
  const selectedShelf = shelves.find((shelf) => shelf.id === shelfId) ?? null
  const currentBooks = booksShelfId === shelfId && booksPage === page ? books : []
  const currentTotal = booksShelfId === shelfId ? booksTotal : selectedShelf?.book_count ?? 0
  const pageCount = scenePageCount(currentTotal)
  const shownPage = booksShelfId === shelfId ? booksPage : page
  // Solo hay escena (o vacío real) cuando la página del servidor corresponde a la selección actual.
  const sceneSettled = !booksLoading && !booksError && shelfId !== null && booksShelfId === shelfId && booksPage === page

  const updateAddress = useCallback((nextShelfId: string | null, nextPage: number) => {
    window.history.replaceState(window.history.state, "", buildShelf3dPath(nextShelfId, nextPage))
  }, [])

  // La selección vive en la URL: al entrar, al usar atrás/adelante y al volver de una ficha.
  useEffect(() => {
    const readAddress = () => {
      setScene(parseShelfSceneParams(new URLSearchParams(window.location.search)))
      setBooksLoading(true)
      setAddressVersion((value) => value + 1)
      setAddressReady(true)
    }
    readAddress()
    window.addEventListener("popstate", readAddress)
    return () => window.removeEventListener("popstate", readAddress)
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setShelvesLoading(true)
      setShelvesError(false)
      void getShelvesAction().then((loadedShelves) => {
        setShelves(loadedShelves)
      }).catch((error: unknown) => {
        console.error("Error loading shelves for 3D view:", error)
        setShelvesError(true)
      }).finally(() => setShelvesLoading(false))
    }, 0)
    return () => window.clearTimeout(timer)
  }, [shelvesRetry])

  // La URL refleja la selección efectiva (por ejemplo, tras caer a la primera estantería).
  useEffect(() => {
    if (shelvesLoading || shelvesError || shelves.length === 0) return
    if (scene.shelf === shelfId && scene.page === page) return
    updateAddress(shelfId, page)
  }, [shelvesLoading, shelvesError, shelves.length, scene.shelf, scene.page, shelfId, page, updateAddress])

  // Página del servidor: nunca se carga el catálogo completo en el cliente. Las
  // transiciones de carga las marcan los gestores y la dirección; el efecto solo
  // sincroniza con el listado del servidor.
  useEffect(() => {
    if (!addressReady || !shelfId) return
    const requestId = ++requestSequence.current
    void listBooksAction(sceneListRequest(shelfId, page)).then((result) => {
      if (requestSequence.current !== requestId) return
      setBooksError(false)
      setBooks(result.books)
      setBooksShelfId(shelfId)
      setBooksPage(result.page)
      setBooksTotal(result.total)
      setHasLoadedBooks(true)
      if (result.page !== page) {
        setScene((current) => (current.shelf === shelfId ? { ...current, page: result.page } : current))
        updateAddress(shelfId, result.page)
      }
    }).catch((error: unknown) => {
      if (requestSequence.current !== requestId) return
      console.error("Error loading 3D shelf page:", error)
      setBooksError(true)
    }).finally(() => {
      if (requestSequence.current === requestId) setBooksLoading(false)
    })
    return () => {
      if (requestSequence.current === requestId) requestSequence.current += 1
    }
  }, [addressReady, addressVersion, shelfId, page, booksRetry, updateAddress])

  // Al volver de una ficha la URL trae `#book-row-<id>`: se enfoca ese lomo una sola
  // vez y se retira el fragmento. Si el libro no está en esta página, se ignora.
  useEffect(() => {
    if (!addressReady || !hasLoadedBooks || !sceneSettled) return
    const bookId = parseBookRowAnchor(window.location.hash)
    if (!bookId) return
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`)
    const spine = document.getElementById(bookRowAnchor(bookId))
    if (!spine) return
    spine.scrollIntoView({ block: "center" })
    spine.focus({ preventScroll: true })
  }, [addressReady, hasLoadedBooks, sceneSettled, books])

  const selectShelf = (nextShelfId: string) => {
    if (nextShelfId === scene.shelf) return
    setBooksLoading(true)
    setScene({ shelf: nextShelfId, page: 1 })
    updateAddress(nextShelfId, 1)
  }

  const goToPage = (target: number) => {
    if (!shelfId) return
    const next = clampScenePage(target, pageCount)
    if (next === page) return
    setBooksLoading(true)
    setScene({ shelf: shelfId, page: next })
    updateAddress(shelfId, next)
  }

  const retryBooks = () => {
    setBooksLoading(true)
    setBooksRetry((value) => value + 1)
  }

  if (shelvesLoading && shelves.length === 0 && !shelvesError) {
    return <LoadingState message="Cargando estanterías..." />
  }

  return (
    <>
      {shelvesError ? (
        <div role="alert" className="rounded-2xl border border-destructive/40 bg-card p-8 text-center shadow-xl">
          <AlertCircle aria-hidden="true" className="mx-auto mb-3 h-8 w-8 text-destructive" />
          <h1 className="mb-2 text-2xl font-bold heading-vintage">No se pudieron cargar las estanterías</h1>
          <p className="mb-4 text-muted-foreground">La vista 3D no puede mostrar tu biblioteca ahora mismo.</p>
          <Button onClick={() => setShelvesRetry((value) => value + 1)} disabled={shelvesLoading}>{shelvesLoading ? "Reintentando…" : "Reintentar"}</Button>
        </div>
      ) : <>
        <div className="mb-8">
          <h1 className="mb-2 text-3xl font-bold heading-vintage md:text-4xl">Vista de estantería</h1>
          <p className="text-base text-muted-foreground md:text-lg">Recorre tus estanterías página a página y abre cualquier lomo para ver su ficha.</p>
        </div>

        {shelves.length === 0 ? (
          <div className="rounded-2xl border border-border bg-card p-12 text-center shadow-xl">
            <p className="text-muted-foreground">Aún no hay estanterías.</p>
          </div>
        ) : <div className="grid grid-cols-1 gap-6 lg:grid-cols-4" aria-busy={shelvesLoading || booksLoading}>
          <aside className="space-y-4" aria-label="Selección de estantería">
            <div className="rounded-2xl border border-border bg-card p-6 shadow-xl backdrop-blur-md">
              <h2 className="mb-4 text-lg font-bold text-foreground">Estanterías</h2>
              <div className="space-y-2">
                {shelves.map((shelf) => (
                  <button
                    key={shelf.id}
                    type="button"
                    onClick={() => selectShelf(shelf.id)}
                    aria-pressed={shelfId === shelf.id}
                    className={`min-h-11 w-full rounded-xl px-3 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${shelfId === shelf.id ? "bg-primary text-primary-foreground" : "bg-surface text-foreground hover:bg-border"}`}
                  >
                    <span className="block text-sm font-medium">{shelf.title}</span>
                    <span className="block text-xs opacity-75">{shelf.book_count} libro{shelf.book_count === 1 ? "" : "s"}</span>
                  </button>
                ))}
              </div>
            </div>
          </aside>

          <section className="min-w-0 lg:col-span-3" aria-label="Libros en vista 3D">
            <div className="mb-3 flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <p aria-live="polite" aria-atomic="true" className="text-sm text-muted-foreground">
                {booksLoading || (!sceneSettled && !booksError)
                  ? `Cargando la página ${page} de «${selectedShelf?.title ?? "…"}»…`
                  : booksError
                    ? `Estantería «${selectedShelf?.title ?? ""}» · página ${page}`
                    : currentTotal === 0
                      ? `Estantería «${selectedShelf?.title ?? ""}» · sin libros`
                      : `Estantería «${selectedShelf?.title ?? ""}» · ${currentTotal} ${currentTotal === 1 ? "libro" : "libros"} · página ${shownPage} de ${pageCount}`}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {shelfId && (
                  <Button asChild variant="outline" size="sm" className="min-h-11">
                    <Link href={buildShelfCollectionHref(shelfId, page)}>
                      <Table2 aria-hidden="true" className="h-4 w-4" />
                      Ver en la colección
                    </Link>
                  </Button>
                )}
                <nav aria-label="Páginas de la estantería" className="flex items-center gap-2">
                  <Button variant="outline" size="sm" className="min-h-11" aria-label="Página anterior" onClick={() => goToPage(page - 1)} disabled={page <= 1 || booksLoading}>
                    Anterior
                  </Button>
                  <Button variant="outline" size="sm" className="min-h-11" aria-label="Página siguiente" onClick={() => goToPage(page + 1)} disabled={page >= pageCount || booksLoading}>
                    Siguiente
                  </Button>
                </nav>
              </div>
            </div>
            <p className="mb-4 text-xs text-muted-foreground">
              La escena muestra hasta {SCENE_BOOKS_PER_PAGE} libros por página, ordenados por título; la altura de cada lomo se calcula con las páginas registradas.
            </p>
            <div className="min-h-64 overflow-hidden rounded-2xl border border-border bg-card shadow-xl backdrop-blur-md">
              {booksError && !booksLoading ? (
                <div role="alert" className="flex min-h-64 flex-col items-center justify-center gap-4 p-6 text-center">
                  <AlertCircle aria-hidden="true" className="h-8 w-8 text-destructive" />
                  <p className="text-foreground">No se pudo cargar esta página de la estantería.</p>
                  <Button onClick={retryBooks} disabled={booksLoading}>Reintentar</Button>
                </div>
              ) : !sceneSettled ? (
                <div className="flex min-h-64 items-center justify-center"><LoadingState message="Cargando los libros de la estantería..." /></div>
              ) : currentBooks.length === 0 ? (
                <div className="flex min-h-64 flex-col items-center justify-center p-6 text-center">
                  <BookOpen aria-hidden="true" className="mb-3 h-8 w-8 text-muted-foreground" />
                  <p className="mb-1 font-medium text-foreground">Esta estantería todavía no tiene libros.</p>
                  <p className="mb-4 text-sm text-muted-foreground">Agrega alguno para verlo aquí, en la vista 2D o en esta escena.</p>
                  <Button asChild><Link href="/books/add">Agregar un libro</Link></Button>
                </div>
              ) : (
                <ShelfViewer3D key={`${shelfId ?? "sin-estanteria"}-${page}`} books={currentBooks} returnPath={buildShelf3dPath(shelfId, page)} />
              )}
            </div>
          </section>
        </div>}
      </>}
    </>
  )
}
