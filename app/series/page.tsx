"use client"

import Link from "next/link"
import { useCallback, useEffect, useState } from "react"
import { Library, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { LoadingState } from "@/components/loading-state"
import { SeriesForm } from "@/components/series-form"
import { createSeriesAction, listSeriesAction } from "@/app/actions/series"
import { unwrapAction } from "@/lib/action-result"
import type { SeriesSummary } from "@/lib/series"

export default function SeriesPage() {
  const [series, setSeries] = useState<SeriesSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [creating, setCreating] = useState(false)
  const [message, setMessage] = useState("")

  const load = useCallback(async () => {
    try { setSeries(unwrapAction(await listSeriesAction())); setLoadError(false) }
    catch (error: unknown) { console.error("Error loading series:", error); setLoadError(true) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  if (loading && !loadError) return <LoadingState message="Cargando series..." />

  if (loadError) {
    return (
      <div role="alert" className="rounded-2xl border border-destructive/40 bg-card p-8 text-center shadow-xl">
        <h1 className="mb-2 text-2xl font-bold heading-vintage">No se pudieron cargar las series</h1>
        <p className="mb-4 text-muted-foreground">Inténtalo de nuevo para consultar tus series.</p>
        <Button onClick={() => { setLoading(true); void load() }}>Reintentar</Button>
      </div>
    )
  }

  return (
    <>
      <div className="mb-8 flex flex-col gap-4 sm:mb-12 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="mb-2 text-3xl font-bold heading-vintage md:text-4xl">Tus series</h1>
          <p className="text-base text-muted-foreground md:text-lg">Agrupa ediciones en series y conserva el orden exacto de sus volúmenes.</p>
        </div>
        {!creating && <Button onClick={() => { setCreating(true); setMessage("") }}><Plus aria-hidden="true" className="h-4 w-4" />Nueva serie</Button>}
      </div>

      {creating && (
        <section aria-labelledby="new-series-title" className="mb-8 max-w-2xl rounded-2xl border border-border bg-card/80 p-5 shadow-xl backdrop-blur-xl">
          <h2 id="new-series-title" className="mb-4 text-lg font-bold">Crear serie</h2>
          <SeriesForm submitLabel="Crear serie" pendingLabel="Creando..." onCancel={() => setCreating(false)} onSubmit={async (values) => {
            const created = unwrapAction(await createSeriesAction(values))
            await load()
            setCreating(false)
            setMessage(`Serie «${created.title}» creada. Añade ediciones desde la ficha de cada libro.`)
          }} />
        </section>
      )}
      {message && <p role="status" className="mb-6 rounded-xl border border-border bg-muted/40 p-3 text-sm">{message}</p>}

      {series.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card p-12 text-center shadow-xl">
          <p className="mb-4 text-muted-foreground">Aún no has creado series.</p>
          <p className="text-sm text-muted-foreground">Una serie puede estar incompleta: añade solo los volúmenes que tengas.</p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {series.map((item) => (
            <li key={item.id} className="rounded-2xl border border-border bg-card p-6 shadow-xl transition-shadow hover:shadow-2xl">
              <h2 className="mb-1 text-lg font-bold text-foreground"><Link href={`/series/${item.id}`} className="rounded-sm underline-offset-4 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{item.title}</Link></h2>
              <p className="flex items-center gap-2 text-sm text-muted-foreground"><Library aria-hidden="true" className="h-4 w-4" />{item.volumes} {item.volumes === 1 ? "volumen" : "volúmenes"}</p>
              {item.description && <p className="mt-3 line-clamp-3 text-sm text-muted-foreground">{item.description}</p>}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
