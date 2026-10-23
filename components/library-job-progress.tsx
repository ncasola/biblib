"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { LoaderCircle, Pause, Play, XCircle } from "lucide-react"
import { cancelLibraryJobAction, getLibraryJobAction, pauseLibraryJobAction, resumeLibraryJobAction } from "@/app/actions/library-jobs"
import type { ActionResult } from "@/lib/action-result"
import { isTerminal, type ControlResult, type JobState, type LibraryJobView } from "@/lib/jobs/contracts"
import { Button } from "@/components/ui/button"

// U-DAT-03 · Progreso confirmado de un trabajo persistente. Lo que se muestra procede siempre de la
// base: recargar, cerrar la página o abrir otra sesión no pierde el estado ni las cantidades.

export const JOB_STATE_LABELS: Record<JobState, string> = {
  queued: "En cola",
  running: "En curso",
  waiting_retry: "Esperando para reintentar",
  needs_review: "Necesita revisión",
  paused: "En pausa",
  succeeded: "Completado",
  partially_succeeded: "Completado con incidencias",
  failed: "No completado",
  cancelled: "Cancelado",
  expired: "Caducado",
}

const ACTIVE: JobState[] = ["queued", "running", "waiting_retry"]
const POLL_MS = 2_000

/** Sigue un trabajo mientras está activo y la página es visible. */
export function useLibraryJob() {
  const [job, setJob] = useState<LibraryJobView | null>(null)
  const [error, setError] = useState("")
  const current = useRef(job)
  useEffect(() => { current.current = job }, [job])

  const refresh = useCallback(async () => {
    const id = current.current?.id
    if (!id) return
    try {
      const result = await getLibraryJobAction({ jobId: id })
      if (result.ok) { setJob(result.value); setError("") }
      else setError(result.error.message)
    } catch {
      setError("No se pudo consultar el progreso. El trabajo continúa y se volverá a consultar.")
    }
  }, [])

  const active = Boolean(job && ACTIVE.includes(job.state))
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh() }, POLL_MS)
    return () => clearInterval(timer)
  }, [active, refresh])

  return { job, setJob, error, refresh }
}

interface Props {
  job: LibraryJobView
  onChange: (job: LibraryJobView) => void
  /** Etiquetas de las cantidades; la clave es el campo de `counts`. */
  children?: React.ReactNode
  disabled?: boolean
}

function describe(job: LibraryJobView): string {
  if (job.state === "waiting_retry" && job.nextAttemptAt) {
    const at = new Date(job.nextAttemptAt).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    return job.errorCode === "RATE_LIMITED"
      ? `El catálogo pide esperar antes de seguir consultando. Se reanudará hacia las ${at}; no significa que falten portadas.`
      : `El catálogo no respondió. Se reintentará hacia las ${at}.`
  }
  if (job.state === "needs_review") return "Tu biblioteca cambió desde la revisión. No se ha aplicado nada: vuelve a revisar el archivo con los datos actuales."
  if (job.state === "expired") return job.errorCode === "ACCOUNT_INACTIVE" ? "La cuenta no admite operaciones en este momento; el trabajo se ha detenido." : "El trabajo caducó antes de terminar. Lo ya confirmado se conserva."
  if (job.state === "paused") return "En pausa: no se reclamará el siguiente paso hasta que lo reanudes."
  if (job.state === "failed") return "El trabajo no pudo completarse. Lo ya confirmado se conserva."
  return ""
}

export function LibraryJobProgress({ job, onChange, children, disabled }: Props) {
  const [pending, setPending] = useState<"pause" | "resume" | "cancel" | null>(null)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")

  const run = async (action: "pause" | "resume" | "cancel") => {
    if (pending) return
    setPending(action); setMessage(""); setError("")
    const call = action === "pause" ? pauseLibraryJobAction : action === "resume" ? resumeLibraryJobAction : cancelLibraryJobAction
    try {
      const result: ActionResult<ControlResult> = await call({ jobId: job.id, expectedVersion: job.version })
      if (!result.ok) {
        setError(result.error.message)
        // Otra pestaña o el propio trabajo lo cambiaron: se muestra el estado actual.
        const latest = await getLibraryJobAction({ jobId: job.id })
        if (latest.ok) onChange(latest.value)
        return
      }
      onChange(result.value.job)
      if (action === "cancel") {
        setMessage(result.value.publication === "after"
          ? "La importación ya estaba publicada y se conserva. Se ha detenido la búsqueda de portadas pendientes."
          : result.value.publication === "before" ? "Cancelado antes de publicar: no se ha aplicado ningún cambio en tu biblioteca."
            : "Trabajo cancelado. Lo ya guardado se conserva.")
      } else setMessage(action === "pause" ? "Trabajo en pausa." : "Trabajo reanudado.")
    } catch {
      setError("No se pudo enviar la solicitud. Consulta el estado y vuelve a intentarlo.")
    } finally {
      setPending(null)
    }
  }

  const terminal = isTerminal(job.state)
  const remaining = Math.max(0, job.counts.total - job.counts.processed)
  const percent = job.counts.total > 0 ? Math.round((job.counts.processed / job.counts.total) * 100) : terminal ? 100 : 0
  const detail = describe(job)
  return <div className="space-y-3" aria-live="polite">
    <p className="flex items-center gap-2 text-sm font-medium">
      {ACTIVE.includes(job.state) && <LoaderCircle aria-hidden="true" className="w-4 h-4 animate-spin" />}
      Estado: {JOB_STATE_LABELS[job.state]}
      {job.kind === "import" && <span className="text-muted-foreground font-normal">· {job.published ? "importación publicada" : "pendiente de publicar"}</span>}
    </p>
    {job.counts.total > 0 && <div>
      <div role="progressbar" aria-label="Portadas revisadas" aria-valuemin={0} aria-valuemax={job.counts.total} aria-valuenow={job.counts.processed} className="h-2 w-full rounded-full bg-muted overflow-hidden"><div className="h-full bg-primary transition-all" style={{ width: `${percent}%` }} /></div>
      <p className="mt-1 text-xs text-muted-foreground">{job.counts.processed} de {job.counts.total} revisados{remaining > 0 ? ` · ${remaining} pendientes` : ""}{job.counts.retrying > 0 ? ` · ${job.counts.retrying} esperando reintento` : ""}</p>
    </div>}
    {children}
    {detail && <p className="text-sm">{detail}</p>}
    {!terminal && job.state !== "needs_review" && <div className="flex flex-wrap gap-3">
      {job.state === "paused"
        ? <Button variant="outline" disabled={disabled || pending !== null} onClick={() => void run("resume")}><Play aria-hidden="true" />{pending === "resume" ? "Reanudando…" : "Reanudar"}</Button>
        : <Button variant="outline" disabled={disabled || pending !== null} onClick={() => void run("pause")}><Pause aria-hidden="true" />{pending === "pause" ? "Pausando…" : "Pausar"}</Button>}
      <Button variant="outline" disabled={disabled || pending !== null} onClick={() => void run("cancel")}><XCircle aria-hidden="true" />{pending === "cancel" ? "Cancelando…" : "Cancelar"}</Button>
    </div>}
    {job.state === "needs_review" && <Button variant="outline" disabled={disabled || pending !== null} onClick={() => void run("cancel")}><XCircle aria-hidden="true" />Descartar este trabajo</Button>}
    {message && <p role="status" className="text-sm">{message}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>
}
