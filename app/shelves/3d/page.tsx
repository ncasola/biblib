"use client"

import { Header } from "@/components/header"
import { Suspense, useState, useEffect } from "react"
import type { LibraryData } from "@/lib/types"
import { getLibraryDataAction } from "@/app/actions/library"
import { ShelfViewer3D } from "@/components/shelf-viewer-3d"
import { LoadingState } from "@/components/loading-state"

export default function Shelf3DPage() {
  const [data, setData] = useState<LibraryData | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedShelfId, setSelectedShelfId] = useState<string | null>(null)

  useEffect(() => {
    const initData = async () => {
      try {
        const loaded = await getLibraryDataAction()
        setData(loaded)
        if (loaded.shelves.length > 0) {
          setSelectedShelfId(loaded.shelves[0].id)
        }
      } catch (error) {
        console.error("Error loading 3D shelf data:", error)
        setData({ books: [], shelves: [] })
      } finally {
        setLoading(false)
      }
    }

    void initData()
  }, [])

  if (loading || !data) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <LoadingState message="Renderizando vista 3D..." />
      </div>
    )
  }

  const selectedShelf = data.shelves.find((s) => s.id === selectedShelfId)
  const shelfBooks = selectedShelf ? data.books.filter((b) => b.shelf_id === selectedShelf.id) : []

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main className="max-w-7xl mx-auto px-4 py-12">
        <div className="mb-12">
          <h1 className="text-4xl font-bold heading-vintage mb-2">Vista de estantería</h1>
          <p className="text-muted-foreground text-lg">Explora tus libros en una estantería 3D</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Sidebar */}
          <div className="space-y-4">
            <div className="rounded-2xl border border-border bg-card backdrop-blur-md p-6 shadow-xl">
              <h3 className="text-lg font-bold text-foreground mb-4">Estanterías</h3>
              <div className="space-y-2">
                {data.shelves.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Aún no hay estanterías</p>
                ) : (
                  data.shelves.map((shelf) => (
                    <button
                      key={shelf.id}
                      onClick={() => setSelectedShelfId(shelf.id)}
                      className={`w-full text-left px-3 py-2 rounded-xl transition-colors ${
                        selectedShelfId === shelf.id
                          ? "bg-primary text-white"
                          : "bg-surface text-foreground hover:bg-border"
                      }`}
                    >
                      <p className="font-medium text-sm">{shelf.title}</p>
                      <p className="text-xs opacity-75">
                        {data.books.filter((b) => b.shelf_id === shelf.id).length} libros
                      </p>
                    </button>
                  ))
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-card backdrop-blur-md p-6 shadow-xl">
              <h3 className="text-lg font-bold text-foreground mb-4">Controles</h3>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>• Arrastra para rotar</p>
                <p>• Rueda para hacer zoom</p>
                <p>• Clic derecho para desplazar</p>
              </div>
            </div>
          </div>

          {/* 3D Viewer */}
          <div className="lg:col-span-3">
            <div className="rounded-2xl border border-border bg-card backdrop-blur-md shadow-xl overflow-hidden">
              {shelfBooks.length === 0 ? (
                <div className="w-full h-full flex flex-col items-center justify-center text-center p-6">
                  <p className="text-muted-foreground mb-2">No hay libros en esta estantería</p>
                  <p className="text-sm text-muted-foreground">Agrega libros para verlos en 3D</p>
                </div>
              ) : (
                <Suspense
                  fallback={
                    <div className="w-full h-full flex items-center justify-center">
                      <p className="text-muted-foreground">Cargando vista de estantería...</p>
                    </div>
                  }
                >
                  <ShelfViewer3D books={shelfBooks} />
                </Suspense>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
