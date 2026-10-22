"use client"

import { useEffect, useRef, useState } from "react"
import { LoaderCircle, RefreshCw } from "lucide-react"
import { recoverMissingCoversAction } from "@/app/actions/cover-recovery"
import { unwrapAction } from "@/lib/action-result"
import type { CoverRecoveryResult } from "@/lib/cover-recovery"
import { DomainError } from "@/lib/domain-errors"
import { Button } from "@/components/ui/button"

interface Props {
  disabled: boolean
  onRunningChange: (running: boolean) => void
  onFinish: () => Promise<void>
}

const emptyResult: CoverRecoveryResult = { nextCursor: null, scanned: 0, recovered: 0, unavailable: 0, skipped: 0 }

export function CoverRecoveryPanel({ disabled, onRunningChange, onFinish }: Props) {
  const [running, setRunning] = useState(false)
  const [pausing, setPausing] = useState(false)
  const [progress, setProgress] = useState<CoverRecoveryResult | null>(null)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")
  const paused = useRef(false)
  const active = useRef(true)
  const [started, setStarted] = useState(false)
  const cursor = useRef<string | null>(null)

  useEffect(() => { active.current = true; return () => { active.current = false; paused.current = true } }, [])

  const recover = async () => {
    if (running || disabled) return
    let totals = cursor.current ? progress ?? emptyResult : emptyResult
    if (!cursor.current) setProgress(null)
    setStarted(true)
    paused.current = false
    setPausing(false); setRunning(true); onRunningChange(true); setError(""); setMessage("")
    try {
      while (active.current && !paused.current) {
        const batchStarted = Date.now()
        const batch = unwrapAction(await recoverMissingCoversAction(cursor.current))
        cursor.current = batch.nextCursor
        totals = { nextCursor: batch.nextCursor, scanned: totals.scanned + batch.scanned, recovered: totals.recovered + batch.recovered,
          unavailable: totals.unavailable + batch.unavailable, skipped: totals.skipped + batch.skipped }
        if (!active.current) break
        setProgress(totals)
        if (!batch.nextCursor) { setMessage("Búsqueda terminada. Las portadas encontradas ya están guardadas."); break }
        const remaining = 1000 - (Date.now() - batchStarted)
        if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining))
      }
      if (active.current && paused.current && cursor.current) setMessage("Recuperación pausada. Puedes continuar desde el siguiente lote mientras permanezcas en esta página.")
    } catch (caught) {
      if (active.current) setError(caught instanceof DomainError ? caught.message : "No se pudo completar el lote. Las portadas ya guardadas se conservan; puedes reintentar.")
    } finally {
      if (active.current) {
        setRunning(false); setPausing(false); onRunningChange(false)
        await onFinish()
      }
    }
  }

  return <section aria-labelledby="covers-title" aria-busy={running} className="rounded-2xl border border-border bg-card/80 p-5 md:p-8 shadow-xl space-y-4">
    <div><h2 id="covers-title" className="text-2xl font-bold mb-2">Portadas pendientes</h2><p className="text-muted-foreground">Busca en Open Library las portadas genéricas de tu colección, en lotes de hasta 20 libros. Conserva las portadas existentes y los cambios hechos durante la búsqueda.</p></div>
    <p className="text-sm text-muted-foreground">Puedes pausar al terminar el lote actual. Si sales de esta página, se conservarán las portadas guardadas y podrás iniciar otra búsqueda. Los libros sin ISBN válido requieren revisión manual.</p>
    <div className="flex flex-wrap gap-3"><Button disabled={disabled || running} onClick={() => void recover()}>{running ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <RefreshCw aria-hidden="true" />}{running ? "Buscando portadas…" : progress?.nextCursor ? "Continuar recuperación" : started ? "Buscar portadas de nuevo" : "Recuperar portadas pendientes"}</Button>{running && <Button variant="outline" disabled={pausing} onClick={() => { paused.current = true; setPausing(true) }}>{pausing ? "Pausando al terminar el lote…" : "Pausar después de este lote"}</Button>}</div>
    {progress && <dl aria-live="polite" className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">{[["Revisados", progress.scanned], ["Portadas recuperadas", progress.recovered], ["Sin resultado", progress.unavailable], ["Omitidos", progress.skipped]].map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="text-lg font-semibold">{value}</dd></div>)}</dl>}
    {message && <p role="status" className="text-sm">{message}</p>}{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {progress && progress.skipped > 0 && <p className="text-xs text-muted-foreground">Se omiten libros sin ISBN válido o que han cambiado o se han eliminado durante la consulta.</p>}
  </section>
}
