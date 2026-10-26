"use client"

import { useId, useState, type FormEvent } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SERIES_LIMITS } from "@/lib/product/contracts"

// Título y descripción de una serie privada (U-PRO-05): alta en /series y edición en /series/[id].

interface SeriesFormProps {
  initial?: { title: string; description?: string }
  submitLabel: string
  pendingLabel: string
  onSubmit: (values: { title: string; description: string }) => Promise<void>
  onCancel?: () => void
}

export function SeriesForm({ initial, submitLabel, pendingLabel, onSubmit, onCancel }: SeriesFormProps) {
  const id = useId()
  const [title, setTitle] = useState(initial?.title ?? "")
  const [description, setDescription] = useState(initial?.description ?? "")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (pending) return
    if (!title.trim()) { setError("Escribe el título de la serie."); return }
    setPending(true); setError("")
    try {
      await onSubmit({ title, description })
      if (!initial) { setTitle(""); setDescription("") }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "No se pudo guardar la serie. Comprueba la conexión e inténtalo de nuevo.") }
    finally { setPending(false) }
  }

  return (
    <form onSubmit={(event) => void submit(event)} aria-busy={pending} className="space-y-3">
      <fieldset disabled={pending} className="space-y-3 min-w-0">
        <div className="space-y-1">
          <label htmlFor={`${id}-title`} className="text-sm font-medium">Título de la serie</label>
          <Input id={`${id}-title`} value={title} maxLength={SERIES_LIMITS.titleMax} onChange={(event) => { setTitle(event.target.value); setError("") }} className="border-border bg-surface" />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-description`} className="text-sm font-medium">Descripción (opcional)</label>
          <textarea id={`${id}-description`} rows={3} value={description} maxLength={SERIES_LIMITS.descriptionMax} onChange={(event) => setDescription(event.target.value)}
            className="flex w-full rounded-md border border-border bg-surface px-3 py-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-ring" />
        </div>
      </fieldset>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>{pending && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}{pending ? pendingLabel : submitLabel}</Button>
        {onCancel && <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>Cancelar</Button>}
      </div>
    </form>
  )
}
