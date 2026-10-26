"use client"
import { ShelfSpines } from "@/components/shelf-spines"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import type { Shelf } from "@/lib/types"
import { useState } from "react"
import { BookOpen, Trash2, Edit2 } from "lucide-react"
import Link from "next/link"

interface ShelfCardProps {
  shelf: Shelf
  bookCount: number
  onUpdate: (shelfId: string, newTitle: string) => Promise<void>
  onDelete: (shelfId: string) => Promise<void>
  isDefault: boolean
}

export function ShelfCard({ shelf, bookCount, onUpdate, onDelete, isDefault }: ShelfCardProps) {
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false)
  const [editedName, setEditedName] = useState(shelf.title)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleUpdate = async () => {
    if (!editedName.trim() || editedName.trim() === shelf.title || isDefault || pending) return
    setPending(true)
    setError(null)
    try {
      await onUpdate(shelf.id, editedName.trim())
      setIsEditDialogOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo renombrar la estantería.")
    } finally {
      setPending(false)
    }
  }

  const handleDelete = async () => {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      await onDelete(shelf.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo eliminar la estantería.")
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="surface-card rounded-2xl p-5 flex flex-col gap-4 relative transition-shadow duration-300 hover:shadow-xl">
      <ShelfSpines id={shelf.id} count={bookCount} className="h-20" />
      {isDefault && (
        <div className="absolute top-7 right-7 rounded-full bg-brass px-2.5 py-0.5 text-xs font-semibold text-[#1b130d] shadow-sm">Predeterminada</div>
      )}

      <div className="flex items-start justify-between gap-4 pr-12">
        <div className="flex-1">
          <h2 className="mb-1 text-xl font-bold"><Link tabIndex={0} href={`/books?shelf=${encodeURIComponent(shelf.id)}`} className="rounded-sm underline-offset-4 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{shelf.title}</Link></h2>
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <BookOpen className="w-4 h-4" />
            <span>
              {bookCount} libro{bookCount !== 1 ? "s" : ""}
            </span>
          </div>
        </div>
      </div>

      <div className="h-px bg-border" />

      <Link tabIndex={0} href={`/books?shelf=${encodeURIComponent(shelf.id)}`} className="link-quiet inline-flex min-h-11 items-center text-sm">Ver libros de esta estantería<span className="sr-only">: {shelf.title}</span></Link>
      <Button asChild variant="outline"><Link href={`/books/print?shelf=${encodeURIComponent(shelf.id)}`}>Imprimir catálogo<span className="sr-only">: {shelf.title}</span></Link></Button>

      <div className="flex gap-2">
        <Dialog open={isEditDialogOpen} onOpenChange={(open) => { if (!pending) { setIsEditDialogOpen(open); setError(null) } }}>
          {isDefault ? (
            <Button type="button" variant="outline" size="sm" className="flex-1" disabled title="El nombre de esta estantería es inmutable." aria-label="Renombrar estantería predeterminada, acción deshabilitada">
              <Edit2 className="mr-2 h-4 w-4" />
              Renombrar
            </Button>
          ) : <DialogTrigger asChild>
            <Button variant="outline" size="sm" className="flex-1" disabled={pending}>
              <Edit2 className="w-4 h-4 mr-2" />
              Renombrar
            </Button>
          </DialogTrigger>}
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Renombrar estantería</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <Input
                aria-label="Nuevo nombre de estantería"
                value={editedName}
                onChange={(e) => setEditedName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleUpdate()
                }}
                className="bg-surface border-border"
              />
              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={() => { setIsEditDialogOpen(false); setError(null) }} disabled={pending}>
                  Cancelar
                </Button>
                <Button
                  onClick={() => void handleUpdate()}
                  disabled={pending || !editedName.trim() || editedName.trim() === shelf.title}
                  className="px-4"
                >
                  {pending ? "Guardando…" : "Guardar"}
                </Button>
              </div>
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            </div>
          </DialogContent>
        </Dialog>

        {!isDefault && (
          <Button
            variant="outline"
            size="sm"
            className="flex-1 border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={pending}
            onClick={() => {
              if (window.confirm(`¿Eliminar la estantería "${shelf.title}"? Los libros se moverán a la predeterminada.`)) {
                void handleDelete()
              }
            }}
          >
            <Trash2 className="w-4 h-4 mr-2" />
            {pending ? "Guardando…" : "Eliminar"}
          </Button>
        )}
      </div>
      {error && !isEditDialogOpen && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
