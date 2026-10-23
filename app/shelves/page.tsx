"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { LoadingState } from "@/components/loading-state"
import { ShelfCard } from "@/components/shelf-card"
import { createShelfAction, deleteShelfAction, getShelvesAction, renameShelfAction } from "@/app/actions/shelves"
import type { Shelf } from "@/lib/types"
import { Plus } from "lucide-react"
import { unwrapAction } from "@/lib/action-result"

export default function ShelvesPage() {
  const [shelves, setShelves] = useState<Shelf[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [newShelfName, setNewShelfName] = useState("")
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [mutationPending, setMutationPending] = useState(false)
  const [mutationError, setMutationError] = useState<string | null>(null)

  const refreshShelves = async () => {
    try {
      setShelves(await getShelvesAction())
      setLoadError(false)
    } catch (error) {
      console.error("Error refreshing shelves:", error)
      setLoadError(true)
    }
  }

  const loadShelves = useCallback(() => getShelvesAction().then((loaded) => {
      setShelves(loaded)
      setLoadError(false)
    }).catch((error: unknown) => {
      console.error("Error loading shelves:", error)
      setLoadError(true)
    }).finally(() => {
      setLoading(false)
    }), [])

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadShelves() }, 0)
    return () => window.clearTimeout(timer)
  }, [loadShelves])

  const handleCreateShelf = async () => {
    if (!newShelfName.trim() || mutationPending) return
    setMutationPending(true)
    setMutationError(null)
    try {
      unwrapAction(await createShelfAction(newShelfName.trim()))
      await refreshShelves()
      setNewShelfName("")
      setIsDialogOpen(false)
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : "No se pudo crear la estantería.")
    } finally {
      setMutationPending(false)
    }
  }

  const handleDeleteShelf = async (shelfId: string) => {
    unwrapAction(await deleteShelfAction(shelfId))
    await refreshShelves()
  }

  const handleUpdateShelf = async (shelfId: string, newTitle: string) => {
    if (!newTitle.trim()) return
    unwrapAction(await renameShelfAction(shelfId, newTitle.trim()))
    await refreshShelves()
  }

  if (loading && shelves.length === 0 && !loadError) {
    return <LoadingState message="Cargando estanterías..." />
  }

  return (
    <>
        {loadError ? (
          <div role="alert" className="rounded-2xl border border-destructive/40 bg-card p-8 text-center shadow-xl">
            <h1 className="mb-2 text-2xl font-bold heading-vintage">No se pudieron cargar las estanterías</h1>
            <p className="mb-4 text-muted-foreground">Inténtalo de nuevo para consultar la organización actual.</p>
            <Button onClick={() => void loadShelves()} disabled={loading}>{loading ? "Cargando…" : "Reintentar"}</Button>
          </div>
        ) : (
          <>
            <div className="mb-8 flex flex-col gap-4 sm:mb-12 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h1 className="mb-2 text-3xl font-bold heading-vintage md:text-4xl">Tus estanterías</h1>
                <p className="text-base text-muted-foreground md:text-lg">Organiza tus libros en estanterías personalizadas</p>
              </div>
              <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
                <DialogTrigger asChild><Button className="rounded-xl bg-primary px-6 py-3 font-semibold text-primary-foreground shadow-lg shadow-primary/30 transition-all hover:scale-105"><Plus aria-hidden="true" className="h-4 w-4" />Nueva estantería</Button></DialogTrigger>
                <DialogContent>
                  <DialogHeader><DialogTitle>Crear nueva estantería</DialogTitle></DialogHeader>
                  <div className="space-y-4">
                    <Input aria-label="Nombre de la estantería" placeholder="Nombre (ej.: Ciencia ficción, Favoritos)" value={newShelfName} onChange={(event) => setNewShelfName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void handleCreateShelf() }} className="border-border bg-surface" />
                    <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setIsDialogOpen(false)} disabled={mutationPending}>Cancelar</Button><Button onClick={() => void handleCreateShelf()} disabled={mutationPending || !newShelfName.trim()}>{mutationPending ? "Creando…" : "Crear estantería"}</Button></div>
                  </div>
                  {mutationError && <p role="alert" className="text-sm text-destructive">{mutationError}</p>}
                </DialogContent>
              </Dialog>
            </div>

            {shelves.length === 0 ? (
              <div className="rounded-2xl border border-border bg-card p-12 text-center shadow-xl"><p className="mb-4 text-muted-foreground">Aún no has creado estanterías.</p><p className="text-sm text-muted-foreground">Crea una estantería para organizar tus libros.</p></div>
            ) : (
              <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">{shelves.map((shelf) => <ShelfCard key={shelf.id} shelf={shelf} bookCount={shelf.book_count} onUpdate={handleUpdateShelf} onDelete={handleDeleteShelf} isDefault={shelf.isDefault ?? false} />)}</div>
            )}
          </>
        )}
    </>
  )
}
