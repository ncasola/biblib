"use client"

import { Header } from "@/components/header"
import { SearchBookForm } from "@/components/search-book-form"
import { ManualBookForm } from "@/components/manual-book-form"
import { BookSearchResult } from "@/components/book-search-result"
import { useState } from "react"
import type { Book } from "@/lib/types"
import { ArrowLeft } from "lucide-react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

export default function AddBookPage() {
  const [searchResult, setSearchResult] = useState<Book | null>(null)
  const [isSearching, setIsSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSearch = async (isbn: string) => {
    setIsSearching(true)
    setError(null)
    setSearchResult(null)

    try {
      const response = await fetch(`/api/books/search?isbn=${encodeURIComponent(isbn)}`)

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.error || "Libro no encontrado")
      }

      const book = await response.json()
      setSearchResult(book)
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo buscar el libro")
    } finally {
      setIsSearching(false)
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main className="max-w-6xl mx-auto px-4 py-12">
        <div className="mb-8">
          <Link href="/books">
            <Button
              variant="ghost"
              className="mb-4 bg-transparent border-2 border-border text-foreground px-6 py-3 rounded-xl font-semibold hover:bg-muted transition-all"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Volver a libros
            </Button>
          </Link>
          <h1 className="text-4xl md:text-5xl font-bold heading-vintage mb-2">Agregar nuevo libro</h1>
          <p className="text-lg text-muted-foreground">Busca por ISBN o agrega manualmente</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div>
            <Tabs defaultValue="isbn" className="w-full">
              <TabsList className="grid w-full grid-cols-2 mb-6">
                <TabsTrigger value="isbn">Buscar por ISBN</TabsTrigger>
                <TabsTrigger value="manual">Agregar manualmente</TabsTrigger>
              </TabsList>

              <TabsContent value="isbn">
                <div className="rounded-2xl border border-border bg-card backdrop-blur-md p-8 shadow-xl">
                  <h2 className="text-2xl font-bold text-foreground mb-6">Buscar libro</h2>
                  <SearchBookForm onSearch={handleSearch} isLoading={isSearching} />

                  {error && (
                    <div className="mt-6 p-4 rounded-xl bg-vintage-red/10 border-2 border-vintage-red/30">
                      <p className="text-vintage-red font-medium">{error}</p>
                      <p className="text-sm text-muted-foreground mt-1">
                        Prueba otro ISBN o revisa si el formato es correcto
                      </p>
                    </div>
                  )}
                </div>

                <div className="rounded-2xl border border-border/50 bg-card/80 backdrop-blur-xl p-6 shadow-lg mt-6">
                  <h3 className="font-bold text-foreground mb-3">Consejos:</h3>
                  <ul className="text-sm text-muted-foreground space-y-2">
                    <li>• Usa ISBN de 10 o 13 dígitos</li>
                    <li>• Try: 9780747532699 (Harry Potter)</li>
                    <li>• Try: 9780451524935 (1984)</li>
                    <li>• Quita guiones y espacios del ISBN</li>
                  </ul>
                </div>
              </TabsContent>

              <TabsContent value="manual">
                <div className="rounded-2xl border border-border bg-card backdrop-blur-md p-8 shadow-xl">
                  <h2 className="text-2xl font-bold text-foreground mb-6">Entrada manual</h2>
                  <ManualBookForm />
                </div>
              </TabsContent>
            </Tabs>
          </div>

          <div>
            {searchResult ? (
              <div>
                <h2 className="text-2xl font-bold text-foreground mb-6">Detalles del libro</h2>
                <BookSearchResult book={searchResult} />
              </div>
            ) : (
              <div className="rounded-2xl border border-border bg-card backdrop-blur-md p-12 shadow-xl flex items-center justify-center text-center min-h-[400px]">
                <div>
                  <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-vintage-yellow/20 flex items-center justify-center">
                    <span className="text-4xl">📚</span>
                  </div>
                  <h3 className="text-xl font-bold text-foreground mb-2">Listo para agregar</h3>
                  <p className="text-muted-foreground">Busca por ISBN o completa los datos manualmente</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
