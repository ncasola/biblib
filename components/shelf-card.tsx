"use client"
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
    <div className="rounded-2xl border border-border bg-card p-6 shadow-xl flex flex-col gap-4 relative hover:shadow-2xl transition-shadow">
      {isDefault && (
        <div className="absolute top-3 right-3 bg-primary text-white text-xs px-2 py-1 rounded">Predeterminada</div>
      )}

      <div className="flex items-start justify-between gap-4 pr-12">
        <div className="flex-1">
          <h2 className="mb-1 text-lg font-bold text-foreground"><Link href={`/books?shelf=${encodeURIComponent(shelf.id)}`} className="rounded-sm underline-offset-4 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{shelf.title}</Link></h2>
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <BookOpen className="w-4 h-4" />
            <span>
              {bookCount} libro{bookCount !== 1 ? "s" : ""}
            </span>
          </div>
        </div>
      </div>

      <div className="h-px bg-border" />

      <Link href={`/books?shelf=${encodeURIComponent(shelf.id)}`} className="text-sm font-medium text-primary underline-offset-4 hover:underline">Ver libros de esta estantería<span className="sr-only">: {shelf.title}</span></Link>

      <div className="flex gap-2">
        <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
          {isDefault ? (
            <Button type="button" variant="outline" size="sm" className="flex-1 border-border bg-transparent" disabled title="El nombre de esta estantería es inmutable." aria-label="Renombrar estantería predeterminada, acción deshabilitada">
              <Edit2 className="mr-2 h-4 w-4" />
              Renombrar
            </Button>
          ) : <DialogTrigger asChild>
            <Button variant="outline" size="sm" className="flex-1 border-border bg-transparent" disabled={pending}>
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
                <Button variant="outline" onClick={() => setIsEditDialogOpen(false)} disabled={pending}>
                  Cancelar
                </Button>
                <Button
                  onClick={() => void handleUpdate()}
                  disabled={pending || !editedName.trim() || editedName.trim() === shelf.title}
                  className="bg-primary text-primary-foreground px-4 py-2 rounded-xl font-semibold hover:scale-105 transition-all shadow-lg shadow-primary/30"
                >
                  {pending ? "Guardando…" : "Guardar"}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {!isDefault && (
          <Button
            variant="outline"
            size="sm"
            className="flex-1 border-destructive text-destructive hover:bg-destructive/10 bg-transparent"
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
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
