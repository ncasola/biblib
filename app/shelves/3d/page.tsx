"use client"

import { Header } from "@/components/header"
import { Suspense, useState, useEffect } from "react"
import type { LibraryData } from "@/lib/types"
import { getStoredLibraryData, loadLibraryData } from "@/lib/storage"
import { ShelfViewer3D } from "@/components/shelf-viewer-3d"

export default function Shelf3DPage() {
  const [data, setData] = useState<LibraryData | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedShelfId, setSelectedShelfId] = useState<string | null>(null)

  useEffect(() => {
    const initData = async () => {
      const stored = getStoredLibraryData()
      if (stored) {
        setData(stored)
        if (stored.shelves.length > 0) {
          setSelectedShelfId(stored.shelves[0].id)
        }
      } else {
        const loaded = await loadLibraryData()
        setData(loaded)
        if (loaded.shelves.length > 0) {
          setSelectedShelfId(loaded.shelves[0].id)
        }
      }
      setLoading(false)
    }

    initData()
  }, [])

  if (loading || !data) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <div className="flex items-center justify-center h-96">
          <p className="text-foreground-light">Loading...</p>
        </div>
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
          <h1 className="text-4xl font-bold heading-vintage mb-2">Bookshelf View</h1>
          <p className="text-muted-foreground text-lg">Browse your books displayed on beautiful 3D shelves</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Sidebar */}
          <div className="space-y-4">
            <div className="rounded-2xl border border-border bg-card backdrop-blur-md p-6 shadow-xl">
              <h3 className="text-lg font-bold text-foreground mb-4">Shelves</h3>
              <div className="space-y-2">
                {data.shelves.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No shelves yet</p>
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
                        {data.books.filter((b) => b.shelf_id === shelf.id).length} books
                      </p>
                    </button>
                  ))
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-card backdrop-blur-md p-6 shadow-xl">
              <h3 className="text-lg font-bold text-foreground mb-4">Controls</h3>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>• Drag to rotate</p>
                <p>• Scroll to zoom</p>
                <p>• Right-click to pan</p>
              </div>
            </div>
          </div>

          {/* 3D Viewer */}
          <div className="lg:col-span-3">
            <div className="rounded-2xl border border-border bg-card backdrop-blur-md shadow-xl overflow-hidden">
              {shelfBooks.length === 0 ? (
                <div className="w-full h-full flex flex-col items-center justify-center text-center p-6">
                  <p className="text-muted-foreground mb-2">No books on this shelf</p>
                  <p className="text-sm text-muted-foreground">Add books to see them in 3D view</p>
                </div>
              ) : (
                <Suspense
                  fallback={
                    <div className="w-full h-full flex items-center justify-center">
                      <p className="text-muted-foreground">Loading shelf view...</p>
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
