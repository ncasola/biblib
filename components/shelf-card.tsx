"use client"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import type { Shelf } from "@/lib/types"
import { useState } from "react"
import { BookOpen, Trash2, Edit2 } from "lucide-react"

interface ShelfCardProps {
  shelf: Shelf
  bookCount: number
  onUpdate: (shelfId: string, newTitle: string) => void
  onDelete: (shelfId: string) => void
  isDefault: boolean
}

export function ShelfCard({ shelf, bookCount, onUpdate, onDelete, isDefault }: ShelfCardProps) {
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false)
  const [editedName, setEditedName] = useState(shelf.title)

  const handleUpdate = () => {
    if (editedName.trim() && editedName !== shelf.title) {
      onUpdate(shelf.id, editedName)
    }
    setIsEditDialogOpen(false)
  }

  return (
    <div className="rounded-2xl border border-border bg-card backdrop-blur-md p-6 shadow-xl flex flex-col gap-4 relative hover:shadow-2xl transition-shadow">
      {isDefault && (
        <div className="absolute top-3 right-3 bg-primary text-white text-xs px-2 py-1 rounded">Default</div>
      )}

      <div className="flex items-start justify-between gap-4 pr-12">
        <div className="flex-1">
          <h3 className="text-lg font-bold text-foreground mb-1">{shelf.title}</h3>
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <BookOpen className="w-4 h-4" />
            <span>
              {bookCount} book{bookCount !== 1 ? "s" : ""}
            </span>
          </div>
        </div>
      </div>

      <div className="h-px bg-border" />

      <div className="flex gap-2">
        <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm" className="flex-1 border-border bg-transparent">
              <Edit2 className="w-4 h-4 mr-2" />
              Rename
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Rename Shelf</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <Input
                value={editedName}
                onChange={(e) => setEditedName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleUpdate()
                }}
                className="bg-surface border-border"
              />
              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={handleUpdate}
                  disabled={!editedName.trim() || editedName === shelf.title}
                  className="bg-primary text-primary-foreground px-4 py-2 rounded-xl font-semibold hover:scale-105 transition-all shadow-lg shadow-primary/30"
                >
                  Save
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
            onClick={() => {
              if (window.confirm(`Delete shelf "${shelf.title}"? Books will be moved to default shelf.`)) {
                onDelete(shelf.id)
              }
            }}
          >
            <Trash2 className="w-4 h-4 mr-2" />
            Delete
          </Button>
        )}
      </div>
    </div>
  )
}
