"use client"

import { useId, useState } from "react"
import { Pencil, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { ReadingTime } from "@/components/reading-progress"
import { DomainError } from "@/lib/domain-errors"
import { READING_LIMITS } from "@/lib/product/reading-loans"
import { formatInstant, fromDateTimeLocalValue, parseEntryFields, toDateTimeLocalValue, type ReadingEntryFields, type ReadingEntryView } from "@/lib/reading"

// Entradas de un ciclo de lectura (U-PRO-02): sesiones reales o cambios de progreso, cada una con el instante que
// registra la persona. El formulario valida lo mismo que el servidor (página ≤ total conocido, inicial ≤ final, página o
// nota) para dar el mensaje antes de enviar; la base lo vuelve a comprobar.

const textareaClass = "flex min-h-20 w-full rounded-md border border-input bg-input px-3 py-2 text-base text-foreground"
const pageValue = (value: string) => (value.trim() === "" ? null : Number(value))

interface ReadingEntryFormProps {
  /** Nombre accesible del formulario. */
  title: string
  totalPages: number | null
  initial?: ReadingEntryView
  submitLabel: string
  busyLabel: string
  disabled?: boolean
  onSubmit: (fields: ReadingEntryFields) => Promise<boolean>
  onCancel?: () => void
}

export function ReadingEntryForm({ title, totalPages, initial, submitLabel, busyLabel, disabled = false, onSubmit, onCancel }: ReadingEntryFormProps) {
  const id = useId()
  const [when, setWhen] = useState(() => toDateTimeLocalValue(initial ? new Date(initial.occurredAt) : new Date()))
  const [pageFrom, setPageFrom] = useState(initial?.pageFrom?.toString() ?? "")
  const [pageTo, setPageTo] = useState(initial?.pageTo?.toString() ?? "")
  const [note, setNote] = useState(initial?.note ?? "")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (busy || disabled) return
    setError("")
    const occurredAt = fromDateTimeLocalValue(when)
    if (!occurredAt) { setError("Indica el día y la hora de la sesión."); return }
    let fields: ReadingEntryFields
    // Al corregir, la página que ya estaba guardada no se vuelve a comparar con un total corregido después.
    const checkTotal = initial && pageValue(pageTo) === initial.pageTo ? null : totalPages
    try { fields = parseEntryFields({ occurredAt, pageFrom: pageValue(pageFrom), pageTo: pageValue(pageTo), note }, checkTotal) }
    catch (caught) { setError(caught instanceof DomainError ? caught.message : "Revisa los datos de la sesión."); return }
    setBusy(true)
    try { if (await onSubmit(fields) && !initial) { setPageFrom(""); setPageTo(""); setNote(""); setWhen(toDateTimeLocalValue(new Date())) } }
    finally { setBusy(false) }
  }

  const locked = disabled || busy
  return <form aria-label={title} className="grid gap-3 rounded-xl border border-border bg-surface/50 p-4 sm:grid-cols-2" aria-busy={busy}
    onSubmit={(event) => { event.preventDefault(); void submit() }}>
    <div className="space-y-1 sm:col-span-2">
      <label htmlFor={`${id}-when`} className="text-sm font-medium">Cuándo</label>
      <Input id={`${id}-when`} type="datetime-local" value={when} disabled={locked} required onChange={(event) => setWhen(event.target.value)} aria-describedby={`${id}-when-hint`} />
      <p id={`${id}-when-hint`} className="text-xs text-muted-foreground">En tu zona horaria. Registra solo lo que ya ha pasado.</p>
    </div>
    <div className="space-y-1">
      <label htmlFor={`${id}-from`} className="text-sm font-medium">Desde la página <span className="font-normal text-muted-foreground">(opcional)</span></label>
      <Input id={`${id}-from`} inputMode="numeric" pattern="[0-9]*" value={pageFrom} disabled={locked} onChange={(event) => setPageFrom(event.target.value.replace(/[^0-9]/g, "").slice(0, 6))} />
    </div>
    <div className="space-y-1">
      <label htmlFor={`${id}-to`} className="text-sm font-medium">Hasta la página</label>
      <Input id={`${id}-to`} inputMode="numeric" pattern="[0-9]*" value={pageTo} disabled={locked} aria-describedby={`${id}-total`} onChange={(event) => setPageTo(event.target.value.replace(/[^0-9]/g, "").slice(0, 6))} />
    </div>
    <p id={`${id}-total`} className="text-xs text-muted-foreground sm:col-span-2">{totalPages
      ? `Esta edición tiene ${totalPages} páginas.`
      : "El total de páginas de esta edición es desconocido: la página se guarda sin porcentaje."}</p>
    <div className="space-y-1 sm:col-span-2">
      <label htmlFor={`${id}-note`} className="text-sm font-medium">Nota <span className="font-normal text-muted-foreground">(opcional si indicas la página)</span></label>
      <textarea id={`${id}-note`} className={textareaClass} value={note} maxLength={READING_LIMITS.noteMax} disabled={locked} onChange={(event) => setNote(event.target.value)} />
    </div>
    {error && <p role="alert" className="text-sm text-destructive sm:col-span-2">{error}</p>}
    <div className="flex flex-wrap gap-2 sm:col-span-2">
      <Button type="submit" disabled={locked}>{busy ? busyLabel : submitLabel}</Button>
      {onCancel && <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>Cancelar</Button>}
    </div>
  </form>
}

interface ReadingEntryListProps {
  entries: ReadingEntryView[]
  totalPages: number | null
  /** Nombre accesible de la lista. */
  label: string
  disabled?: boolean
  onUpdate: (entry: ReadingEntryView, fields: ReadingEntryFields) => Promise<boolean>
  onDelete: (entry: ReadingEntryView) => Promise<boolean>
}

function entrySummary(entry: ReadingEntryView): string {
  if (entry.pageTo === null) return "Nota"
  if (entry.pageFrom === null) return `Hasta la página ${entry.pageTo}`
  return `Páginas ${entry.pageFrom}–${entry.pageTo}`
}

/** Entradas de un ciclo, de la más reciente a la más antigua, con corrección y borrado confirmado. */
export function ReadingEntryList({ entries, totalPages, label, disabled = false, onUpdate, onDelete }: ReadingEntryListProps) {
  const [editing, setEditing] = useState<string | null>(null)
  const [removing, setRemoving] = useState<ReadingEntryView | null>(null)
  const [busy, setBusy] = useState(false)

  if (!entries.length) return <p className="text-sm text-muted-foreground">Sin sesiones registradas en esta lectura.</p>
  return <>
    <ul aria-label={label} className="divide-y divide-border rounded-xl border border-border">
      {entries.map((entry) => <li key={entry.id} className="space-y-2 p-3">
        {editing === entry.id ? <ReadingEntryForm title="Corregir la sesión" totalPages={totalPages} initial={entry} submitLabel="Guardar la corrección" busyLabel="Guardando…"
          disabled={disabled} onCancel={() => setEditing(null)} onSubmit={async (fields) => { const done = await onUpdate(entry, fields); if (done) setEditing(null); return done }} /> : <>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="text-sm"><span className="font-semibold text-foreground">{entrySummary(entry)}</span> <span className="text-muted-foreground">· <ReadingTime iso={entry.occurredAt} /></span></p>
            <div className="flex gap-1">
              <Button type="button" variant="ghost" size="icon" disabled={disabled} aria-label={`Corregir la sesión del ${formatInstant(entry.occurredAt)}`} onClick={() => setEditing(entry.id)}><Pencil aria-hidden="true" /></Button>
              <Button type="button" variant="ghost" size="icon" disabled={disabled} aria-label={`Borrar la sesión del ${formatInstant(entry.occurredAt)}`} onClick={() => setRemoving(entry)}><Trash2 aria-hidden="true" /></Button>
            </div>
          </div>
          {entry.note && <p className="whitespace-pre-line text-sm text-foreground-light">{entry.note}</p>}
        </>}
      </li>)}
    </ul>
    <AlertDialog open={removing !== null} onOpenChange={(open) => { if (!open && !busy) setRemoving(null) }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>¿Borrar esta sesión?</AlertDialogTitle>
          <AlertDialogDescription>{removing ? `${entrySummary(removing)} · ${formatInstant(removing.occurredAt)}. ` : ""}La lectura y sus otras sesiones se conservan. No se puede deshacer.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancelar</AlertDialogCancel>
          <AlertDialogAction disabled={busy} className="bg-destructive text-destructive-foreground" onClick={(event) => {
            event.preventDefault()
            if (!removing) return
            setBusy(true)
            void onDelete(removing).then((done) => { if (done) setRemoving(null) }).finally(() => setBusy(false))
          }}>{busy ? "Borrando…" : "Borrar sesión"}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>
}
