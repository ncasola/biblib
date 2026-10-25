"use client"

import { useEffect, useId, useRef, useState } from "react"
import { BookOpen } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { ReadingEntryForm, ReadingEntryList } from "@/components/reading-entries"
import { ReadingCycleBadge, ReadingProgressView, ReadingTime } from "@/components/reading-progress"
import {
  addReadingEntryAction, closeReadingAction, deleteReadingEntryAction, getCopyReadingAction, pauseReadingAction, reopenReadingAction, resumeReadingAction,
  startReadingAction, updateReadingEntryAction,
} from "@/app/actions/reading"
import type { ActionResult } from "@/lib/action-result"
import {
  cycleLabel, cycleProgress, formatInstant, fromDateTimeLocalValue, latestCycle, openCycle, toDateTimeLocalValue, type CopyReadingView, type ReadingCycleView,
  type ReadingMutation,
} from "@/lib/reading"
import type { Book } from "@/lib/types"

// Panel de lectura de la ficha (U-PRO-02): el ciclo actual con su progreso y acciones, el registro de sesiones y el
// historial de lecturas y relecturas. Independiente del estado actual del libro (Leído, Leyendo…), que se cambia aparte:
// nada de este panel lo modifica ni lo convierte en fechas. Las fechas se muestran en la zona horaria del navegador.

type When = { mode: "now" | "other" | "unknown"; local: string }
type Dialog = { kind: "start" } | { kind: "close"; status: "finished" | "abandoned"; cycle: ReadingCycleView } | { kind: "reopen"; cycle: ReadingCycleView }

const OFFLINE = "No se pudo confirmar el cambio por un problema de conexión. Puedes volver a intentarlo: si ya se guardó, no se duplicará."
const RETRY = "El cambio ya constaba (quizá se guardó antes de perder la respuesta): no se ha duplicado nada."
const newEntryId = () => crypto.randomUUID()

/** Instante elegido: ahora, otra fecha (en la zona local) o sin fecha. `undefined` si la fecha escrita no es válida. */
function resolveWhen(when: When): string | null | undefined {
  if (when.mode === "now") return new Date().toISOString()
  if (when.mode === "unknown") return null
  return fromDateTimeLocalValue(when.local) ?? undefined
}

function WhenField({ legend, unknownLabel, value, onChange, disabled }: { legend: string; unknownLabel: string; value: When; onChange: (next: When) => void; disabled?: boolean }) {
  const id = useId()
  const options: [When["mode"], string][] = [["now", "Ahora"], ["other", "Otra fecha y hora"], ["unknown", unknownLabel]]
  return <fieldset className="space-y-2">
    <legend className="text-sm font-medium">{legend}</legend>
    {options.map(([mode, label]) => <div key={mode} className="flex items-center gap-2">
      <input type="radio" id={`${id}-${mode}`} name={`${id}-when`} checked={value.mode === mode} disabled={disabled} onChange={() => onChange({ ...value, mode })} className="h-4 w-4 accent-primary" />
      <label htmlFor={`${id}-${mode}`} className="text-sm">{label}</label>
    </div>)}
    {value.mode === "other" && <div className="space-y-1 pl-6">
      <label htmlFor={`${id}-local`} className="text-sm">Fecha y hora <span className="text-muted-foreground">(tu zona horaria)</span></label>
      <Input id={`${id}-local`} type="datetime-local" value={value.local} disabled={disabled} onChange={(event) => onChange({ ...value, local: event.target.value })} />
    </div>}
  </fieldset>
}

function cycleDates(cycle: ReadingCycleView) {
  return <span>
    {cycle.startedAt ? <>Empezada el <ReadingTime iso={cycle.startedAt} dateOnly /></> : "Inicio sin fecha registrada"}
    {cycle.status === "finished" || cycle.status === "abandoned"
      ? <> · {cycle.finishedAt ? <>{cycle.status === "finished" ? "terminada" : "dejada"} el <ReadingTime iso={cycle.finishedAt} dateOnly /></> : "fin sin fecha registrada"}</>
      : null}
  </span>
}

interface ReadingPanelProps {
  copyId: string
  /** Estado actual del libro: solo para explicar que un «Leído» sin lecturas registradas no tiene fecha. */
  bookStatus: Book["status"]
  disabled?: boolean
}

export function ReadingPanel({ copyId, bookStatus, disabled = false }: ReadingPanelProps) {
  const id = useId()
  const [reading, setReading] = useState<CopyReadingView | null>(null)
  const [loadError, setLoadError] = useState("")
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")
  const [logging, setLogging] = useState(false)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [when, setWhen] = useState<When>({ mode: "now", local: "" })
  const [dialogError, setDialogError] = useState("")
  // El ID de la sesión nueva se conserva hasta que el servidor la confirma: reenviarla tras un corte no la duplica.
  const pendingEntry = useRef(newEntryId())

  useEffect(() => {
    let active = true
    getCopyReadingAction(copyId).then((result) => {
      if (!active) return
      if (result.ok) { setReading(result.value); setLoadError("") } else setLoadError(result.error.message)
    }, () => { if (active) setLoadError("No se pudo cargar la lectura. La ficha sigue disponible.") })
    return () => { active = false }
  }, [copyId, attempt])

  /** Ejecuta una mutación; devuelve si se aplicó (o ya constaba). Los errores quedan en `target` (panel o diálogo). */
  const mutate = async (operation: () => Promise<ActionResult<ReadingMutation>>, success: string, target: "panel" | "dialog" = "panel"): Promise<boolean> => {
    if (busy) return false
    const fail = target === "dialog" ? setDialogError : setError
    setBusy(true); setMessage(""); setError(""); setDialogError("")
    try {
      const result = await operation()
      if (!result.ok) { fail(result.error.message); return false }
      setReading(result.value.reading)
      setMessage(result.value.outcome === "retry" ? RETRY
        : result.value.outcome === "already-open" ? "Ya había una lectura en curso de este libro (quizá desde otro dispositivo): se muestra esa, sin crear otra." : success)
      return true
    } catch { fail(OFFLINE); return false }
    finally { setBusy(false) }
  }

  const openDialog = (next: Dialog) => { setWhen({ mode: "now", local: toDateTimeLocalValue(new Date()) }); setDialogError(""); setDialog(next) }

  const confirmDialog = async () => {
    if (!dialog || !reading) return
    if (dialog.kind === "reopen") {
      const done = await mutate(() => reopenReadingAction({ cycleId: dialog.cycle.id, expectedVersion: dialog.cycle.version, confirm: true }),
        `${cycleLabel(dialog.cycle.cycleNumber)} reabierta: vuelve a estar en curso.`, "dialog")
      if (done) setDialog(null)
      return
    }
    const instant = resolveWhen(when)
    if (instant === undefined) { setDialogError("Indica una fecha y hora válidas."); return }
    if (dialog.kind === "start") {
      const latest = latestCycle(reading)
      const done = await mutate(() => startReadingAction({ copyId, startedAt: instant, expectedLatestCycleId: latest?.id ?? null, confirmReread: latest !== null }),
        latest ? `Relectura empezada (lectura n.º ${latest.cycleNumber + 1}). Las lecturas anteriores se conservan.` : "Lectura empezada.", "dialog")
      if (done) setDialog(null)
      return
    }
    const done = await mutate(() => closeReadingAction({ cycleId: dialog.cycle.id, expectedVersion: dialog.cycle.version, status: dialog.status, finishedAt: instant, confirm: true }),
      dialog.status === "finished" ? "Lectura terminada. Puedes reabrirla desde el historial si fue un error." : "Lectura abandonada. Puedes reabrirla desde el historial si fue un error.", "dialog")
    if (done) setDialog(null)
  }

  const current = reading ? openCycle(reading) : null
  const history = reading ? reading.cycles.filter((cycle) => cycle !== current) : []
  const locked = disabled || busy
  const latest = reading ? latestCycle(reading) : null

  return <section aria-labelledby={`${id}-title`} className="surface-card space-y-4 rounded-2xl p-5" data-testid="reading-panel">
    <div className="flex items-center gap-2"><BookOpen aria-hidden="true" className="h-4 w-4 text-brass-text" /><h2 id={`${id}-title`} className="text-sm font-semibold">Lectura</h2></div>
    {loadError ? <div role="alert" className="space-y-2 text-sm text-destructive"><p>{loadError}</p><Button type="button" variant="outline" onClick={() => setAttempt((value) => value + 1)}>Reintentar</Button></div>
      : !reading ? <p className="text-sm text-muted-foreground" aria-busy="true">Cargando la lectura…</p>
      : <>
        {current ? <div className="space-y-3" data-testid="reading-current">
          <div className="flex flex-wrap items-center gap-2"><ReadingCycleBadge status={current.status} /><span className="font-heading text-lg font-bold text-heading">{cycleLabel(current.cycleNumber)}</span></div>
          <p className="text-sm text-muted-foreground">{cycleDates(current)}</p>
          <ReadingProgressView progress={cycleProgress(current, reading.totalPages)} label={`Progreso de la ${cycleLabel(current.cycleNumber).toLowerCase()}`} />
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={locked} aria-expanded={logging} onClick={() => setLogging((value) => !value)}>{logging ? "Cerrar el registro" : "Registrar sesión"}</Button>
            {current.status === "reading"
              ? <Button type="button" variant="outline" disabled={locked} onClick={() => void mutate(() => pauseReadingAction({ cycleId: current.id, expectedVersion: current.version }), "Lectura en pausa.")}>Pausar</Button>
              : <Button type="button" variant="outline" disabled={locked} onClick={() => void mutate(() => resumeReadingAction({ cycleId: current.id, expectedVersion: current.version }), "Lectura reanudada.")}>Reanudar</Button>}
            <Button type="button" variant="secondary" disabled={locked} onClick={() => openDialog({ kind: "close", status: "finished", cycle: current })}>Terminar…</Button>
            <Button type="button" variant="ghost" disabled={locked} onClick={() => openDialog({ kind: "close", status: "abandoned", cycle: current })}>Abandonar…</Button>
          </div>
          {logging && <ReadingEntryForm title="Registrar una sesión" totalPages={reading.totalPages} submitLabel="Guardar sesión" busyLabel="Guardando…" disabled={locked}
            onSubmit={async (fields) => {
              const done = await mutate(() => addReadingEntryAction({ cycleId: current.id, entryId: pendingEntry.current, ...fields }), "Sesión registrada.")
              if (done) pendingEntry.current = newEntryId()
              return done
            }} />}
          <ReadingEntryList label={`Sesiones de la ${cycleLabel(current.cycleNumber).toLowerCase()}`} entries={current.entries} totalPages={reading.totalPages} disabled={locked}
            onUpdate={(entry, fields) => mutate(() => updateReadingEntryAction({ entryId: entry.id, expectedVersion: entry.version, ...fields }), "Sesión corregida.")}
            onDelete={(entry) => mutate(() => deleteReadingEntryAction({ entryId: entry.id, copyId, expectedVersion: entry.version, confirm: true }), "Sesión borrada.")} />
        </div> : <div className="space-y-3">
          <p className="text-sm text-foreground-light">{reading.cycles.length === 0
            ? bookStatus === "read"
              ? "Este libro está marcado como leído, pero no tiene lecturas registradas: no consta cuándo se leyó y no se le asigna ninguna fecha."
              : "Aún no has registrado ninguna lectura de este libro."
            : "No hay ninguna lectura en curso. Puedes empezar una relectura: las anteriores se conservan."}</p>
          <Button type="button" disabled={locked} onClick={() => openDialog({ kind: "start" })}>{latest ? "Empezar una relectura" : "Empezar a leer"}</Button>
        </div>}

        <p className="text-xs text-muted-foreground">El estado del libro (Leído, Leyendo…) se cambia aparte: registrar lecturas no lo modifica.</p>
        {message && <p role="status" className="rounded-xl border border-l-4 border-border border-l-[var(--status-read)] bg-card p-3 text-sm shadow-sm">{message}</p>}
        {error && <div role="alert" className="space-y-2 rounded-xl border border-destructive/30 p-3 text-sm text-destructive"><p>{error}</p><Button type="button" variant="outline" onClick={() => { setError(""); setAttempt((value) => value + 1) }}>Recargar la lectura</Button></div>}

        {history.length > 0 && <div className="space-y-3">
          <h3 className="font-heading text-base font-bold text-heading">Historial de lecturas</h3>
          <ol aria-label="Historial de lecturas" className="space-y-3">
            {history.map((cycle) => <li key={cycle.id} className="space-y-2 rounded-xl border border-border bg-surface/50 p-3" data-testid="reading-history-item">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex flex-wrap items-center gap-2"><ReadingCycleBadge status={cycle.status} /><span className="font-semibold">{cycleLabel(cycle.cycleNumber)}</span></span>
                {!current && cycle === latest && <Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => openDialog({ kind: "reopen", cycle })}>Reabrir…</Button>}
              </div>
              <p className="text-sm text-muted-foreground">{cycleDates(cycle)} · {cycle.entries.length === 1 ? "1 sesión" : `${cycle.entries.length} sesiones`}</p>
              <ReadingProgressView progress={cycleProgress(cycle, reading.totalPages)} label={`Progreso de la ${cycleLabel(cycle.cycleNumber).toLowerCase()}`} />
              {cycle.entries.length > 0 && <details>
                <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">Ver sesiones</summary>
                <ReadingEntryList label={`Sesiones de la ${cycleLabel(cycle.cycleNumber).toLowerCase()}`} entries={cycle.entries} totalPages={reading.totalPages} disabled={locked}
                  onUpdate={(entry, fields) => mutate(() => updateReadingEntryAction({ entryId: entry.id, expectedVersion: entry.version, ...fields }), "Sesión corregida.")}
                  onDelete={(entry) => mutate(() => deleteReadingEntryAction({ entryId: entry.id, copyId, expectedVersion: entry.version, confirm: true }), "Sesión borrada.")} />
              </details>}
            </li>)}
          </ol>
        </div>}
      </>}

    <AlertDialog open={dialog !== null} onOpenChange={(open) => { if (!open && !busy) setDialog(null) }}>
      <AlertDialogContent>
        {dialog && <>
          <AlertDialogHeader>
            <AlertDialogTitle>{dialog.kind === "start" ? (latest ? "¿Empezar una relectura?" : "Empezar a leer")
              : dialog.kind === "reopen" ? `¿Reabrir la ${cycleLabel(dialog.cycle.cycleNumber).toLowerCase()}?`
              : dialog.status === "finished" ? "¿Terminar la lectura?" : "¿Abandonar la lectura?"}</AlertDialogTitle>
            <AlertDialogDescription>{dialog.kind === "start"
              ? (latest ? `Se creará la lectura n.º ${latest.cycleNumber + 1}. Las anteriores y sus sesiones se conservan tal cual.` : "Se registrará una lectura de este libro. El estado del libro no cambia.")
              : dialog.kind === "reopen"
                ? `Volverá a estar en curso y se borrará su fecha de fin${dialog.cycle.finishedAt ? ` (${formatInstant(dialog.cycle.finishedAt)})` : ""}. Sus sesiones se conservan.`
                : "La lectura pasará al historial con sus sesiones. Podrás reabrirla si te equivocas."}</AlertDialogDescription>
          </AlertDialogHeader>
          {dialog.kind !== "reopen" && <WhenField legend={dialog.kind === "start" ? "¿Cuándo empezaste?" : dialog.status === "finished" ? "¿Cuándo terminaste?" : "¿Cuándo lo dejaste?"}
            unknownLabel="No lo sé (sin fecha)" value={when} onChange={setWhen} disabled={busy} />}
          {dialogError && <p role="alert" className="text-sm text-destructive">{dialogError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancelar</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={(event) => { event.preventDefault(); void confirmDialog() }}>
              {busy ? "Guardando…" : dialog.kind === "start" ? (latest ? "Empezar la relectura" : "Empezar a leer") : dialog.kind === "reopen" ? "Reabrir" : dialog.status === "finished" ? "Terminar" : "Abandonar"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </>}
      </AlertDialogContent>
    </AlertDialog>
  </section>
}
