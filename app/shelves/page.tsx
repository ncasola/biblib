"use client"

import { Header } from "@/components/header"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useState, useEffect } from "react"
import type { LibraryData, Shelf } from "@/lib/types"
import { getStoredLibraryData, loadLibraryData, saveLibraryData } from "@/lib/storage"
import { ShelfCard } from "@/components/shelf-card"
import { Plus } from "lucide-react"

export default function ShelvesPage() {
  const [data, setData] = useState<LibraryData | null>(null)
  const [loading, setLoading] = useState(true)
  const [newShelfName, setNewShelfName] = useState("")
  const [isDialogOpen, setIsDialogOpen] = useState(false)

  useEffect(() => {
    const initData = async () => {
      const stored = getStoredLibraryData()
      if (stored) {
        setData(stored)
      } else {
        const loaded = await loadLibraryData()
        setData(loaded)
      }
      setLoading(false)
    }

    initData()
  }, [])

  const handleCreateShelf = () => {
    if (!data || !newShelfName.trim()) return

    const newShelf: Shelf = {
      id: `shelf-${Date.now()}`,
      title: newShelfName,
      book_count: 0,
      isDefault: false,
    }

    const updatedData = {
      ...data,
      shelves: [...data.shelves, newShelf],
    }

    setData(updatedData)
    saveLibraryData(updatedData)
    setNewShelfName("")
    setIsDialogOpen(false)
  }

  const handleDeleteShelf = (shelfId: string) => {
    if (!data) return

    const updatedData = {
      ...data,
      shelves: data.shelves.filter((s) => s.id !== shelfId),
      books: data.books.map((b) => (b.shelf_id === shelfId ? { ...b, shelf_id: "shelf-1" } : b)),
    }

    setData(updatedData)
    saveLibraryData(updatedData)
  }

  const handleUpdateShelf = (shelfId: string, newTitle: string) => {
    if (!data || !newTitle.trim()) return

    const updatedData = {
      ...data,
      shelves: data.shelves.map((s) => (s.id === shelfId ? { ...s, title: newTitle } : s)),
    }

    setData(updatedData)
    saveLibraryData(updatedData)
  }

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

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main className="max-w-7xl mx-auto px-4 py-12">
        <div className="flex items-center justify-between mb-12">
          <div>
            <h1 className="text-4xl font-bold heading-vintage mb-2">Your Shelves</h1>
            <p className="text-muted-foreground text-lg">Organize your books into custom shelves</p>
          </div>

          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button className="bg-primary text-primary-foreground px-6 py-3 rounded-xl font-semibold hover:scale-105 transition-all shadow-lg shadow-primary/30">
                <Plus className="w-4 h-4 mr-2" />
                New Shelf
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create New Shelf</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <Input
                  placeholder="Shelf name (e.g., 'Sci-Fi', 'My Favorites')"
                  value={newShelfName}
                  onChange={(e) => setNewShelfName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreateShelf()
                  }}
                  className="bg-surface border-border"
                />
                <div className="flex gap-2 justify-end">
                  <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    onClick={handleCreateShelf}
                    disabled={!newShelfName.trim()}
                    className="bg-primary text-primary-foreground px-4 py-2 rounded-xl font-semibold hover:scale-105 transition-all shadow-lg shadow-primary/30"
                  >
                    Create Shelf
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {data.shelves.length === 0 ? (
          <div className="rounded-2xl border border-border bg-card backdrop-blur-md p-12 shadow-xl text-center">
            <p className="text-muted-foreground mb-4">No shelves created yet.</p>
            <p className="text-sm text-muted-foreground">Create your first shelf to organize your books!</p>
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
