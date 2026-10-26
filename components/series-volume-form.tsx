"use client"

import { useId, useState, type FormEvent } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { parseSeriesPositionInput, SERIES_POSITION_HINT } from "@/lib/series"
import { SERIES_LIMITS } from "@/lib/product/contracts"

// Datos de un volumen dentro de una serie (U-PRO-05): posición exacta en texto decimal, etiqueta y nota de orden.
// Lo usan la ficha de la edición (vincular o cambiar) y el detalle de la serie (mover). Una posición vacía significa
// «orden desconocido»: nunca se rellena con la fecha de publicación ni con el número de ejemplares.

export const NEW_SERIES = "__new__"
const selectClass = "flex h-10 w-full rounded-md border border-input bg-input px-3 py-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-ring"

export interface SeriesVolumeValues {
  /** Serie elegida, o `NEW_SERIES` para crearla con `newTitle`. */
  seriesId: string
  newTitle: string
  position: string
  volumeLabel: string
  orderNote: string
}

interface SeriesVolumeFormProps {
  series: Array<{ id: string; title: string }>
  initial: Partial<SeriesVolumeValues>
  submitLabel: string
  pendingLabel: string
  pending: boolean
  /** Mensaje del servidor de la última acción. */
  error?: string
  /** Permite crear una serie nueva desde el selector (ficha); en el detalle de la serie solo se mueve entre las que hay. */
  allowNew?: boolean
  onSubmit: (values: SeriesVolumeValues) => void
  onCancel?: () => void
}

export function SeriesVolumeForm({ series, initial, submitLabel, pendingLabel, pending, error, allowNew = false, onSubmit, onCancel }: SeriesVolumeFormProps) {
  const id = useId()
  const [values, setValues] = useState<SeriesVolumeValues>({
    seriesId: initial.seriesId ?? series[0]?.id ?? (allowNew ? NEW_SERIES : ""),
    newTitle: initial.newTitle ?? "", position: initial.position ?? "", volumeLabel: initial.volumeLabel ?? "", orderNote: initial.orderNote ?? "",
  })
  const [problem, setProblem] = useState("")
  const set = (patch: Partial<SeriesVolumeValues>) => { setValues((current) => ({ ...current, ...patch })); setProblem("") }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (pending) return
    if (values.seriesId === NEW_SERIES ? !values.newTitle.trim() : !values.seriesId) { setProblem("Elige una serie o escribe el título de una nueva."); return }
    const position = parseSeriesPositionInput(values.position)
    if (!position.ok) { setProblem(position.message); return }
    onSubmit({ ...values, position: position.value ?? "" })
  }

  const shown = problem || error
  return (
    <form onSubmit={submit} aria-busy={pending} className="space-y-3 min-w-0">
      <fieldset disabled={pending} className="space-y-3 min-w-0">
        <div className="space-y-1">
          <label htmlFor={`${id}-series`} className="text-sm font-medium">Serie</label>
          <select id={`${id}-series`} className={selectClass} value={values.seriesId} onChange={(event) => set({ seriesId: event.target.value })}>
            {series.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
            {allowNew && <option value={NEW_SERIES}>Crear una serie nueva…</option>}
          </select>
        </div>
        {values.seriesId === NEW_SERIES && (
          <div className="space-y-1">
            <label htmlFor={`${id}-new`} className="text-sm font-medium">Título de la serie nueva</label>
            <Input id={`${id}-new`} value={values.newTitle} maxLength={SERIES_LIMITS.titleMax} onChange={(event) => set({ newTitle: event.target.value })} className="border-border bg-surface" />
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label htmlFor={`${id}-position`} className="text-sm font-medium">Posición (opcional)</label>
            <Input id={`${id}-position`} inputMode="decimal" autoComplete="off" value={values.position} maxLength={12} aria-describedby={`${id}-position-hint`} onChange={(event) => set({ position: event.target.value })} className="border-border bg-surface" />
            <p id={`${id}-position-hint`} className="text-xs text-muted-foreground">{SERIES_POSITION_HINT} Vacía = orden desconocido.</p>
          </div>
          <div className="space-y-1">
            <label htmlFor={`${id}-label`} className="text-sm font-medium">Etiqueta del volumen (opcional)</label>
            <Input id={`${id}-label`} value={values.volumeLabel} maxLength={SERIES_LIMITS.volumeLabelMax} placeholder="Tomo I" onChange={(event) => set({ volumeLabel: event.target.value })} className="border-border bg-surface" />
          </div>
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-note`} className="text-sm font-medium">Nota de orden (opcional)</label>
          <Input id={`${id}-note`} value={values.orderNote} maxLength={SERIES_LIMITS.orderNoteMax} placeholder="Va entre el 1 y el 2 según el editor" onChange={(event) => set({ orderNote: event.target.value })} className="border-border bg-surface" />
        </div>
      </fieldset>
      {shown && <p role="alert" className="text-sm text-destructive">{shown}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>{pending && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}{pending ? pendingLabel : submitLabel}</Button>
        {onCancel && <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>Cancelar</Button>}
      </div>
    </form>
  )
}
