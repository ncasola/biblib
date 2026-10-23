"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { SearchBookForm } from "@/components/search-book-form"
import { ManualBookForm } from "@/components/manual-book-form"
import { BookSearchResult } from "@/components/book-search-result"
import { getShelvesAction } from "@/app/actions/shelves"
import { getBookByIsbnAction } from "@/app/actions/books"
import type { Book, Shelf } from "@/lib/types"
import { ArrowLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

export default function AddBookPage() {
  const [searchResult, setSearchResult] = useState<Book | null>(null)
  const [existingBook, setExistingBook] = useState(false)
  const [isSearching, setIsSearching] = useState(false)
  const [error, setError] = useState("")
  const [tab, setTab] = useState("isbn")
  const [lastIsbn, setLastIsbn] = useState("")
  const [shelves, setShelves] = useState<Shelf[]>([])
  const [loadingShelves, setLoadingShelves] = useState(true)
  const [shelfError, setShelfError] = useState("")
  const [attempt, setAttempt] = useState(0)
  const searchController = useRef<AbortController | null>(null)

  useEffect(() => {
    let active = true
    const load = async () => {
      setLoadingShelves(true)
      setShelfError("")
      try { const loaded = await getShelvesAction(); if (active) setShelves(loaded) }
      catch { if (active) setShelfError("No se pudieron cargar tus estanterías. Vuelve a intentarlo.") }
      finally { if (active) setLoadingShelves(false) }
    }
    void load()
    return () => { active = false }
  }, [attempt])

  useEffect(() => () => searchController.current?.abort(), [])

  const handleSearch = async (isbn: string) => {
    if (isSearching) return
    setIsSearching(true); setError(""); setSearchResult(null); setExistingBook(false); setLastIsbn(isbn)
    const controller = new AbortController()
    searchController.current = controller
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      const existing = await getBookByIsbnAction(isbn)
      if (existing) { setSearchResult(existing); setExistingBook(true); return }
      const response = await fetch(`/api/books/search?isbn=${encodeURIComponent(isbn)}`, { signal: controller.signal })
      if (!response.ok) {
        setError(response.status === 404 ? "Open Library no tiene una ficha para este ISBN." : "No se pudo consultar Open Library. Puedes volver a intentarlo o añadir el libro manualmente.")
        return
      }
      setSearchResult(await response.json() as Book)
    } catch (caught) {
      setError(caught instanceof Error && caught.name === "AbortError" ? "La búsqueda ha tardado demasiado. Vuelve a intentarlo o añade el libro manualmente." : "No se pudo buscar el libro. Comprueba la conexión y vuelve a intentarlo.")
    } finally { clearTimeout(timeout); searchController.current = null; setIsSearching(false) }
  }

  return <div className="mx-auto max-w-6xl">
      <Button asChild variant="outline" className="mb-5"><Link href="/books"><ArrowLeft aria-hidden="true" className="w-4 h-4 mr-2" />Volver a libros</Link></Button>
      <h1 className="text-3xl sm:text-4xl font-bold heading-vintage mb-2">Agregar nuevo libro</h1>
      <p className="text-muted-foreground mb-8">Busca una edición por ISBN o completa su ficha manualmente.</p>
      {loadingShelves ? <p role="status">Cargando estanterías...</p> : shelfError ? <div role="alert" className="space-y-4"><p className="text-destructive">{shelfError}</p><Button variant="outline" onClick={() => setAttempt((current) => current + 1)}>Reintentar</Button></div> : (
        <Tabs value={tab} onValueChange={setTab} className="w-full">
          <TabsList className="grid w-full max-w-md grid-cols-2 mb-6"><TabsTrigger value="isbn">Buscar por ISBN</TabsTrigger><TabsTrigger value="manual">Entrada manual</TabsTrigger></TabsList>
          <TabsContent value="isbn">
            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] gap-6 items-start">
              <div className="rounded-2xl border border-border bg-card/80 backdrop-blur-md p-5 sm:p-6 shadow-xl space-y-5">
                <h2 className="text-2xl font-bold">Buscar libro</h2>
                <SearchBookForm onSearch={handleSearch} isLoading={isSearching} />
                {error && <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 space-y-3"><p role="alert" className="text-destructive">{error}</p><Button type="button" variant="outline" onClick={() => setTab("manual")}>Completar ficha manual con este ISBN</Button></div>}
                <div className="space-y-2 text-sm text-muted-foreground"><h3 className="font-semibold text-foreground">Dónde encontrar el ISBN</h3><p>Consulta la contraportada o la página de créditos. Comprueba que corresponde a tu edición.</p><p>Por ejemplo: 9780747532699. Se admiten guiones y espacios.</p></div>
              </div>
              {searchResult ? <BookSearchResult key={searchResult.isbn} book={searchResult} shelves={shelves} existing={existingBook} /> : <div className="rounded-2xl border border-border bg-card/80 p-8 text-center space-y-3"><p aria-hidden="true" className="text-4xl">📚</p><h2 className="text-xl font-bold">{isSearching ? "Buscando la edición..." : "Revisa antes de guardar"}</h2><p role={isSearching ? "status" : undefined} className="text-muted-foreground">Aquí podrás corregir los datos encontrados, elegir estado y estantería y guardar el libro.</p></div>}
            </div>
          </TabsContent>
          <TabsContent value="manual">
            <section className="max-w-2xl rounded-2xl border border-border bg-card/80 backdrop-blur-md p-5 sm:p-6 shadow-xl"><h2 className="text-2xl font-bold mb-5">Ficha del libro</h2><ManualBookForm key={lastIsbn || "manual"} shelves={shelves} initialIsbn={lastIsbn} /></section>
          </TabsContent>
        </Tabs>
      )}
  </div>
}
