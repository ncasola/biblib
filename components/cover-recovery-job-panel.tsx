"use client"

import { useEffect, useRef, useState } from "react"
import { LoaderCircle, RefreshCw } from "lucide-react"
import { recoverMissingCoversAction } from "@/app/actions/cover-recovery"
import { listLibraryJobsAction } from "@/app/actions/library-jobs"
import { isTerminal } from "@/lib/jobs/contracts"
import { Button } from "@/components/ui/button"
import { LibraryJobProgress, useLibraryJob } from "@/components/library-job-progress"

// U-DAT-03 · Recuperación de portadas como trabajo persistente. Al abrir Ajustes se retoma el
// último trabajo de portadas de la cuenta: el progreso sobrevive a recargar o cerrar la página.

interface Props {
  disabled: boolean
  onRunningChange: (running: boolean) => void
  onFinish: () => Promise<void>
}

export function CoverRecoveryJobPanel({ disabled, onRunningChange, onFinish }: Props) {
  const { job, setJob, error: pollError } = useLibraryJob()
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState("")
  const finished = useRef<string | null>(null)

  useEffect(() => {
    let active = true
    listLibraryJobsAction().then((result) => {
      if (active && result.ok) setJob(result.value.find((candidate) => candidate.kind === "covers") ?? null)
    }).catch(() => { /* Sin trabajos previos visibles: se puede iniciar uno nuevo. */ })
    return () => { active = false }
  }, [setJob])

  const running = Boolean(job && ["queued", "running", "waiting_retry"].includes(job.state))
  useEffect(() => { onRunningChange(running) }, [running, onRunningChange])
  useEffect(() => {
    if (job && isTerminal(job.state) && finished.current !== job.id) {
      finished.current = job.id
      void onFinish()
    }
  }, [job, onFinish])

  const start = async () => {
    if (starting || disabled) return
    setStarting(true); setError("")
    try {
      // Clave nueva por recorrido: repetir la petición tras una respuesta perdida no crea otro trabajo.
      const result = await recoverMissingCoversAction({ idempotencyKey: crypto.randomUUID() })
      if (!result.ok) { setError(result.error.message); return }
      finished.current = null
      setJob(result.value)
    } catch {
      setError("No se pudo iniciar la búsqueda. Las portadas ya guardadas se conservan; vuelve a intentarlo.")
    } finally {
      setStarting(false)
    }
  }

  const done = job && (job.state === "succeeded" || job.state === "partially_succeeded")
  return <section aria-labelledby="covers-title" aria-busy={running} className="surface-card rounded-2xl p-5 md:p-8 space-y-4">
    <div><h2 id="covers-title" className="text-2xl font-bold mb-2">Portadas pendientes</h2><p className="text-muted-foreground">Busca en el catálogo bibliográfico las portadas genéricas de tu colección, en pasos de hasta 20 libros. Conserva las portadas existentes y los cambios hechos durante la búsqueda.</p></div>
    <p className="text-sm text-muted-foreground">La búsqueda continúa en el servidor aunque recargues o cierres esta página, y puedes pausarla o cancelarla. Los libros sin ISBN válido requieren revisión manual.</p>
    {(!job || isTerminal(job.state)) && <Button disabled={disabled || starting} onClick={() => void start()}>{starting ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <RefreshCw aria-hidden="true" />}{starting ? "Iniciando…" : job ? "Buscar portadas de nuevo" : "Recuperar portadas pendientes"}</Button>}
    {job && <LibraryJobProgress job={job} onChange={setJob} disabled={disabled}>
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">{([["Revisados", job.counts.processed], ["Portadas recuperadas", job.counts.recovered], ["Sin resultado", job.counts.notFound + job.counts.failed], ["Omitidos", job.counts.skipped]] as const).map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="text-lg font-semibold">{value}</dd></div>)}</dl>
    </LibraryJobProgress>}
    {done && <p role="status" className="text-sm">Búsqueda terminada. Las portadas encontradas ya están guardadas.</p>}
    {(error || pollError) && <p role="alert" className="text-sm text-destructive">{error || pollError}</p>}
    {job && job.counts.skipped > 0 && <p className="text-xs text-muted-foreground">Se omiten libros sin ISBN válido o que han cambiado o se han eliminado durante la consulta.</p>}
    {job && job.counts.failed > 0 && <p className="text-xs text-muted-foreground">«Sin resultado» incluye consultas que fallaron varias veces; no significa que la portada no exista. Puedes buscar de nuevo más tarde.</p>}
  </section>
}
