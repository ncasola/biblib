"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useCallback, useEffect, useState } from "react"
import { ArrowLeft, Edit2, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { BookCover } from "@/components/book-cover"
import { LoadingState } from "@/components/loading-state"
import { SeriesForm } from "@/components/series-form"
import { SeriesVolumeForm, type SeriesVolumeValues } from "@/components/series-volume-form"
import { deleteSeriesAction, getSeriesAction, listSeriesAction, moveSeriesVolumeAction, unlinkEditionFromSeriesAction, updateSeriesAction } from "@/app/actions/series"
import { unwrapAction } from "@/lib/action-result"
import { buildBookDetailHref } from "@/lib/book-search"
import { DomainError } from "@/lib/domain-errors"
import { describePosition, type SeriesDetail, type SeriesVolume } from "@/lib/series"

// Detalle de una serie (U-PRO-05): volúmenes en orden exacto (1, 1.5, 2…) y, al final, los de orden desconocido, que se
// muestran como tales. Una serie incompleta es válida. Borrar la serie solo retira los vínculos: los libros se conservan.

const message = (caught: unknown, fallback: string) => caught instanceof DomainError ? caught.message : fallback

export function SeriesDetailScreen({ seriesId }: { seriesId: string }) {
  const router = useRouter()
  const [detail, setDetail] = useState<SeriesDetail | null>(null)
  const [others, setOthers] = useState<Array<{ id: string; title: string }>>([])
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading")
  const [editing, setEditing] = useState(false)
  const [movingId, setMovingId] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [status, setStatus] = useState("")
  const [deleteOpen, setDeleteOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      const [loaded, all] = await Promise.all([getSeriesAction(seriesId), listSeriesAction()])
      if (!loaded.ok) {
        setState(loaded.error.code === "NOT_FOUND" || loaded.error.code === "INVALID_INPUT" ? "missing" : "error")
        return
      }
      setDetail(loaded.value)
      setOthers(all.ok ? all.value.map((item) => ({ id: item.id, title: item.title })) : [{ id: loaded.value.id, title: loaded.value.title }])
      setState("ready")
    } catch { setState("error") }
  }, [seriesId])

  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const back = <Button asChild variant="outline" className="mb-6"><Link href="/series"><ArrowLeft aria-hidden="true" className="mr-2 h-4 w-4" />Volver a series</Link></Button>

  if (state === "loading") return <LoadingState message="Cargando serie..." />
  if (state === "error") return <div>{back}<div role="alert" className="space-y-3"><p className="text-destructive">No se pudo cargar la serie. Comprueba la conexión e inténtalo de nuevo.</p><Button variant="outline" onClick={() => { setState("loading"); void load() }}>Reintentar</Button></div></div>
  if (state === "missing" || !detail) return <div>{back}<div className="space-y-3"><h1 className="text-2xl font-bold">Serie no encontrada</h1><p className="text-muted-foreground">Esta serie ya no está disponible en tu biblioteca.</p></div></div>

  const run = async (key: string, work: () => Promise<void>, fallback: string) => {
    if (pending) return
    setPending(key); setError(""); setStatus("")
    try { await work() }
    catch (caught) { setError(message(caught, fallback)); void load() }
    finally { setPending(null) }
  }

  const moveVolume = (volume: SeriesVolume, values: SeriesVolumeValues) => run(`move-${volume.editionId}`, async () => {
    unwrapAction(await moveSeriesVolumeAction({ editionId: volume.editionId, seriesId: values.seriesId, expectedVersion: volume.version, position: values.position, volumeLabel: values.volumeLabel, orderNote: values.orderNote }))
    setMovingId(null); await load()
    setStatus(values.seriesId === detail.id ? "Volumen actualizado." : "Volumen movido a otra serie.")
  }, "No se pudo mover el volumen. Comprueba la conexión e inténtalo de nuevo.")

  const removeVolume = (volume: SeriesVolume) => run(`remove-${volume.editionId}`, async () => {
    unwrapAction(await unlinkEditionFromSeriesAction({ editionId: volume.editionId, expectedVersion: volume.version }))
    await load(); setStatus(`«${volume.title}» ya no está en la serie. El libro se conserva.`)
  }, "No se pudo quitar el volumen. Comprueba la conexión e inténtalo de nuevo.")

  const deleteSeries = async () => {
    if (pending) return
    setPending("delete"); setError("")
    try {
      unwrapAction(await deleteSeriesAction({ id: detail.id, expectedVersion: detail.version }))
      setDeleteOpen(false); router.replace("/series"); router.refresh()
    } catch (caught) { setError(message(caught, "No se pudo borrar la serie. Comprueba la conexión e inténtalo de nuevo.")) }
    finally { setPending(null) }
  }

  const detailHref = (bookId: string) => buildBookDetailHref(bookId, `/series/${detail.id}`)

  return (
    <div className="mx-auto max-w-4xl">
      {back}
      {editing ? (
        <section aria-labelledby="edit-series-title" className="mb-8 max-w-2xl rounded-2xl border border-border bg-card/80 p-5 shadow-xl">
          <h1 id="edit-series-title" className="mb-4 text-2xl font-bold">Editar serie</h1>
          <SeriesForm initial={{ title: detail.title, description: detail.description }} submitLabel="Guardar serie" pendingLabel="Guardando..." onCancel={() => setEditing(false)} onSubmit={async (values) => {
            try { unwrapAction(await updateSeriesAction({ id: detail.id, expectedVersion: detail.version, ...values })) }
            catch (caught) { if (caught instanceof DomainError && caught.code === "CONFLICT") void load(); throw caught }
            await load(); setEditing(false); setStatus("Serie actualizada.")
          }} />
        </section>
      ) : (
        <div className="mb-8 flex flex-col items-start justify-between gap-4 sm:flex-row">
          <div className="min-w-0">
            <h1 className="break-words text-3xl font-bold heading-vintage sm:text-4xl">{detail.title}</h1>
            {detail.description && <p className="mt-2 whitespace-pre-line text-muted-foreground">{detail.description}</p>}
            <p className="mt-2 text-sm text-muted-foreground">{detail.items.length} {detail.items.length === 1 ? "volumen" : "volúmenes"}. Una serie puede estar incompleta.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={Boolean(pending)} onClick={() => { setEditing(true); setStatus("") }}><Edit2 aria-hidden="true" className="h-4 w-4" />Editar serie</Button>
            <AlertDialog open={deleteOpen} onOpenChange={(open) => { if (pending !== "delete") { setDeleteOpen(open); setError("") } }}>
              <AlertDialogTrigger asChild><Button variant="outline" disabled={Boolean(pending)} className="border-destructive/40 text-destructive"><Trash2 aria-hidden="true" className="h-4 w-4" />Borrar serie</Button></AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>¿Borrar esta serie?</AlertDialogTitle>
                  <AlertDialogDescription>Se borrará «{detail.title}» y se retirarán sus {detail.items.length} volúmenes de la serie. Tus libros y ediciones se conservan.</AlertDialogDescription>
                </AlertDialogHeader>
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={pending === "delete"}>Cancelar</AlertDialogCancel>
                  <AlertDialogAction disabled={pending === "delete"} onClick={(event) => { event.preventDefault(); void deleteSeries() }} className="bg-destructive text-destructive-foreground">{pending === "delete" ? "Borrando..." : "Borrar serie"}</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      )}

      {status && <p role="status" className="mb-4 rounded-xl border border-border bg-muted/40 p-3 text-sm">{status}</p>}
      {error && !deleteOpen && <p role="alert" className="mb-4 rounded-xl border border-destructive/30 p-3 text-sm text-destructive">{error}</p>}

      {detail.items.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card p-10 text-center shadow-xl">
          <p className="mb-2 text-muted-foreground">Esta serie aún no tiene volúmenes.</p>
          <p className="text-sm text-muted-foreground">Abre la ficha de un libro y usa «Añadir a una serie».</p>
        </div>
      ) : (
        <ol aria-label="Volúmenes de la serie" className="space-y-4">
          {detail.items.map((volume) => (
            <li key={volume.editionId} className="rounded-2xl border border-border bg-card/80 p-4 shadow-lg">
              <div className="flex items-start gap-4">
                <BookCover cover={{ small: volume.cover, medium: volume.cover, large: volume.cover }} title={volume.title} className="w-16 shrink-0 sm:w-20" sizes="80px" />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-sm font-semibold text-primary"><span className="sr-only">Posición: </span>{volume.position === undefined ? describePosition(undefined) : `Posición ${volume.position}`}{volume.volumeLabel ? ` · ${volume.volumeLabel}` : ""}</p>
                  <h2 className="break-words text-lg font-bold"><Link href={detailHref(volume.bookId)} className="underline-offset-4 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{volume.title}</Link></h2>
                  {volume.subtitle && <p className="text-sm text-muted-foreground">{volume.subtitle}</p>}
                  <p className="text-sm text-muted-foreground">{volume.authors.join("; ") || "Autor desconocido"}{volume.copies > 1 ? ` · ${volume.copies} ejemplares` : ""}</p>
                  {volume.orderNote && <p className="text-sm">Nota de orden: {volume.orderNote}</p>}
                </div>
              </div>
              {movingId === volume.editionId ? (
                <div className="mt-4 border-t border-border pt-4">
                  <SeriesVolumeForm
                    series={others}
                    initial={{ seriesId: detail.id, position: volume.position ?? "", volumeLabel: volume.volumeLabel ?? "", orderNote: volume.orderNote ?? "" }}
                    submitLabel="Guardar volumen" pendingLabel="Guardando..." pending={pending === `move-${volume.editionId}`}
                    onSubmit={(values) => void moveVolume(volume, values)} onCancel={() => setMovingId(null)}
                  />
                </div>
              ) : (
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" disabled={Boolean(pending)} aria-label={`Mover o cambiar el volumen «${volume.title}»`} onClick={() => { setMovingId(volume.editionId); setStatus(""); setError("") }}>Mover o cambiar</Button>
                  <Button type="button" variant="outline" size="sm" disabled={Boolean(pending)} aria-label={`Quitar «${volume.title}» de la serie`} onClick={() => void removeVolume(volume)}>{pending === `remove-${volume.editionId}` ? "Quitando..." : "Quitar de la serie"}</Button>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
