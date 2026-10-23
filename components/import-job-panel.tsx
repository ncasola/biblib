"use client"

import { useEffect } from "react"
import { getLibraryJobAction, listLibraryJobsAction } from "@/app/actions/library-jobs"
import { isTerminal } from "@/lib/jobs/contracts"
import { LibraryJobProgress, useLibraryJob } from "@/components/library-job-progress"

// U-DAT-03 · Seguimiento de la importación confirmada: la publicación y las portadas pendientes son
// fases distintas. Al volver a Ajustes se retoma la importación que siga en curso.

interface Props {
  /** Trabajo recién confirmado en esta página; sin él se busca una importación activa de la cuenta. */
  jobId: string | null
  disabled?: boolean
}

export function ImportJobPanel({ jobId, disabled }: Props) {
  const { job, setJob } = useLibraryJob()

  useEffect(() => {
    let active = true
    const load = jobId
      ? getLibraryJobAction({ jobId }).then((result) => result.ok ? result.value : null)
      : listLibraryJobsAction().then((result) => result.ok ? result.value.find((candidate) => candidate.kind === "import" && !isTerminal(candidate.state)) ?? null : null)
    load.then((found) => { if (active && found) setJob(found) }).catch(() => { /* Se mostrará al volver a consultar. */ })
    return () => { active = false }
  }, [jobId, setJob])

  if (!job) return null
  const covers = job.counts.total > 0
  return <section aria-labelledby="import-job-title" className="rounded-2xl border border-border bg-card/80 backdrop-blur-xl p-5 md:p-8 shadow-xl space-y-3">
    <h2 id="import-job-title" className="text-2xl font-bold">Importación en segundo plano</h2>
    <p className="text-sm text-muted-foreground">{job.published
      ? "La importación está publicada en tu biblioteca. Las portadas pendientes se buscan aparte: si alguna no aparece, la importación no se revierte."
      : "La importación todavía no se ha publicado. Puedes recargar o cerrar esta página: el trabajo conserva su estado."}</p>
    <LibraryJobProgress job={job} onChange={setJob} disabled={disabled}>
      {covers && <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">{([["Portadas recuperadas", job.counts.recovered], ["Sin portada", job.counts.notFound], ["Omitidas", job.counts.skipped], ["Sin respuesta", job.counts.failed]] as const).map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="text-lg font-semibold">{value}</dd></div>)}</dl>}
    </LibraryJobProgress>
  </section>
}
