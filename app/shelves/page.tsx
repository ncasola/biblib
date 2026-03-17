"use client"

import { Header } from "@/components/header"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useState, useEffect } from "react"
import type { LibraryData } from "@/lib/types"
import { getLibraryDataAction } from "@/app/actions/library"
import { createShelfAction, deleteShelfAction, renameShelfAction } from "@/app/actions/shelves"
import { ShelfCard } from "@/components/shelf-card"
import { Plus } from "lucide-react"
import { LoadingState } from "@/components/loading-state"

export default function ShelvesPage() {
  const [data, setData] = useState<LibraryData | null>(null)
  const [loading, setLoading] = useState(true)
  const [newShelfName, setNewShelfName] = useState("")
  const [isDialogOpen, setIsDialogOpen] = useState(false)

  const refreshData = async () => {
    const loaded = await getLibraryDataAction()
    setData(loaded)
  }

  useEffect(() => {
    const initData = async () => {
      try {
        const loaded = await getLibraryDataAction()
        setData(loaded)
      } catch (error) {
        console.error("Error loading shelves:", error)
        setData({ books: [], shelves: [] })
      } finally {
        setLoading(false)
      }
    }

    void initData()
  }, [])

  const handleCreateShelf = async () => {
    if (!newShelfName.trim()) return
    await createShelfAction(newShelfName)
    await refreshData()
    setNewShelfName("")
    setIsDialogOpen(false)
  }

  const handleDeleteShelf = async (shelfId: string) => {
    await deleteShelfAction(shelfId)
    await refreshData()
  }

  const handleUpdateShelf = async (shelfId: string, newTitle: string) => {
    if (!newTitle.trim()) return
    await renameShelfAction(shelfId, newTitle)
    await refreshData()
  }

  if (loading || !data) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <LoadingState message="Ordenando tus estanterías..." />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main className="max-w-7xl mx-auto px-4 py-12">
        <div className="flex items-center justify-between mb-12">
          <div>
            <h1 className="text-4xl font-bold heading-vintage mb-2">Tus estanterías</h1>
            <p className="text-muted-foreground text-lg">Organiza tus libros en estanterías personalizadas</p>
          </div>

          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button className="bg-primary text-primary-foreground px-6 py-3 rounded-xl font-semibold hover:scale-105 transition-all shadow-lg shadow-primary/30">
                <Plus className="w-4 h-4 mr-2" />
                Nueva estantería
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Crear nueva estantería</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <Input
                  placeholder="Nombre de estantería (ej.: 'Ciencia ficción', 'Favoritos')"
                  value={newShelfName}
                  onChange={(e) => setNewShelfName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreateShelf()
                  }}
                  className="bg-surface border-border"
                />
                <div className="flex gap-2 justify-end">
                  <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
                    Cancelar
                  </Button>
                  <Button
                    onClick={handleCreateShelf}
                    disabled={!newShelfName.trim()}
                    className="bg-primary text-primary-foreground px-4 py-2 rounded-xl font-semibold hover:scale-105 transition-all shadow-lg shadow-primary/30"
                  >
                    Crear estantería
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {data.shelves.length === 0 ? (
          <div className="rounded-2xl border border-border bg-card backdrop-blur-md p-12 shadow-xl text-center">
            <p className="text-muted-foreground mb-4">Aún no has creado estanterías.</p>
            <p className="text-sm text-muted-foreground">Crea tu primera estantería para organizar tus libros.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {data.shelves.map((shelf) => {
              const shelfBooks = data.books.filter((b) => b.shelf_id === shelf.id)
              return (
                <ShelfCard
                  key={shelf.id}
                  shelf={shelf}
                  bookCount={shelfBooks.length}
                  onUpdate={handleUpdateShelf}
                  onDelete={handleDeleteShelf}
                  isDefault={shelf.isDefault || false}
                />
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}
