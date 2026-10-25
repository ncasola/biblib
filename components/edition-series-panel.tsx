"use client"

import Link from "next/link"
import { useCallback, useEffect, useState } from "react"
import { Library } from "lucide-react"
import { Button } from "@/components/ui/button"
import { createSeriesAction, getEditionSeriesAction, linkEditionToSeriesAction, moveSeriesVolumeAction, unlinkEditionFromSeriesAction } from "@/app/actions/series"
import { NEW_SERIES, SeriesVolumeForm, type SeriesVolumeValues } from "@/components/series-volume-form"
import { unwrapAction } from "@/lib/action-result"
import { DomainError } from "@/lib/domain-errors"
import { describePosition, type EditionSeriesState } from "@/lib/series"

// Sección «Serie» de la ficha (U-PRO-05): vincula o desvincula la edición de una serie propia. La serie pertenece a la
// edición (la comparten todos sus ejemplares) y es opcional: un libro sin serie solo muestra una línea y un botón.

type Mode = "idle" | "linking" | "editing"

export function EditionSeriesPanel({ editionId }: { editionId: string }) {
  const [state, setState] = useState<EditionSeriesState | null>(null)
  const [loadError, setLoadError] = useState("")
  const [mode, setMode] = useState<Mode>("idle")
  const [pending, setPending] = useState<"save" | "remove" | null>(null)
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")

  const load = useCallback(async () => {
    try { setState(unwrapAction(await getEditionSeriesAction(editionId))); setLoadError("") }
    catch (caught) { setLoadError(caught instanceof DomainError ? caught.message : "No se pudo cargar la serie. Comprueba la conexión e inténtalo de nuevo.") }
  }, [editionId])
  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const fail = (caught: unknown) => setError(caught instanceof DomainError ? caught.message : "No se pudo guardar el cambio. Comprueba la conexión e inténtalo de nuevo.")

  const save = async (values: SeriesVolumeValues) => {
    setPending("save"); setError(""); setMessage("")
    try {
      let seriesId = values.seriesId
      if (seriesId === NEW_SERIES) seriesId = unwrapAction(await createSeriesAction({ title: values.newTitle })).id
      const volume = { editionId, seriesId, position: values.position, volumeLabel: values.volumeLabel, orderNote: values.orderNote }
      const next = unwrapAction(mode === "editing" && state?.link
        ? await moveSeriesVolumeAction({ ...volume, expectedVersion: state.link.version })
        : await linkEditionToSeriesAction(volume))
      setState(next); setMode("idle"); setMessage(mode === "editing" ? "Volumen actualizado." : "Edición añadida a la serie.")
    } catch (caught) {
      fail(caught)
      // Un conflicto o una serie borrada se resuelven con los datos actuales, no con una copia vieja.
      if (caught instanceof DomainError && (caught.code === "CONFLICT" || caught.code === "NOT_FOUND")) void load()
    } finally { setPending(null) }
  }

  const remove = async () => {
    if (!state?.link || pending) return
    setPending("remove"); setError(""); setMessage("")
    try { setState(unwrapAction(await unlinkEditionFromSeriesAction({ editionId, expectedVersion: state.link.version }))); setMessage("Edición quitada de la serie.") }
    catch (caught) { fail(caught); void load() }
    finally { setPending(null) }
  }

  const link = state?.link
  return (
    <section aria-labelledby="edition-series-title" className="rounded-2xl border border-border bg-card/80 p-5 shadow-lg space-y-3">
      <h2 id="edition-series-title" className="text-sm font-semibold flex items-center gap-2"><Library aria-hidden="true" className="h-4 w-4" />Serie</h2>
      {loadError ? <div role="alert" className="space-y-2"><p className="text-sm text-destructive">{loadError}</p><Button type="button" variant="outline" onClick={() => { setLoadError(""); void load() }}>Reintentar</Button></div>
        : !state ? <p aria-live="polite" className="text-sm text-muted-foreground">Cargando serie...</p>
        : mode !== "idle" ? (
          <SeriesVolumeForm
            key={mode}
            series={state.available}
            allowNew
            initial={link && mode === "editing" ? { seriesId: link.series.id, position: link.position ?? "", volumeLabel: link.volumeLabel ?? "", orderNote: link.orderNote ?? "" } : {}}
            submitLabel={mode === "editing" ? "Guardar volumen" : "Añadir a la serie"}
            pendingLabel="Guardando..."
            pending={pending === "save"}
            error={error}
            onSubmit={(values) => void save(values)}
            onCancel={() => { setMode("idle"); setError("") }}
          />
        ) : link ? (
          <div className="space-y-3">
            <p className="text-sm"><Link href={`/series/${link.series.id}`} className="font-semibold underline underline-offset-4 hover:text-primary">{link.series.title}</Link></p>
            <dl className="grid gap-2 text-sm sm:grid-cols-3">
              <div><dt className="text-muted-foreground font-semibold">Posición</dt><dd>{describePosition(link.position)}</dd></div>
              <div><dt className="text-muted-foreground font-semibold">Volumen</dt><dd>{link.volumeLabel ?? "Sin etiqueta"}</dd></div>
              <div><dt className="text-muted-foreground font-semibold">Nota de orden</dt><dd>{link.orderNote ?? "Sin nota"}</dd></div>
            </dl>
            <p className="text-xs text-muted-foreground">La serie es de la edición: la comparten todos sus ejemplares.</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" disabled={Boolean(pending)} onClick={() => { setMode("editing"); setError(""); setMessage("") }}>Cambiar volumen</Button>
              <Button type="button" variant="outline" disabled={Boolean(pending)} onClick={() => void remove()}>{pending === "remove" ? "Quitando..." : "Quitar de la serie"}</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Esta edición no pertenece a ninguna serie. Es opcional y no cambia nada más de la ficha.</p>
            <Button type="button" variant="outline" onClick={() => { setMode("linking"); setError(""); setMessage("") }}>Añadir a una serie</Button>
          </div>
        )}
      {mode === "idle" && error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {message && <p aria-live="polite" className="text-sm text-muted-foreground">{message}</p>}
    </section>
  )
}
