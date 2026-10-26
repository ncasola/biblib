"use client"

import { useEffect, useId, useMemo, useState } from "react"
import Link from "next/link"
import { MapPin } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { clearCopyLocationAction, getCopyLocationAction, setCopyLocationAction, type CopyLocationState } from "@/app/actions/locations"
import { unwrapAction } from "@/lib/action-result"
import { DomainError } from "@/lib/domain-errors"
import { buildLocationTree, formatLocationPath, locationKindLabel } from "@/lib/locations"
import { LOCATION_LIMITS } from "@/lib/product/contracts"

interface CopyLocationSectionProps {
  copyId: string
  disabled?: boolean
}

const messageOf = (caught: unknown, fallback: string) => caught instanceof DomainError ? caught.message : fallback

/**
 * Ubicación física del ejemplar (U-PRO-03): dónde está el libro en casa, como complemento de la estantería lógica. Cambiarla
 * no toca la estantería, la colección ni el estado de lectura; la posición es manual y no se renumera. Sin ubicaciones, la
 * ficha funciona igual.
 */
export function CopyLocationSection({ copyId, disabled = false }: CopyLocationSectionProps) {
  const id = useId()
  const [state, setState] = useState<CopyLocationState | null>(null)
  const [loadError, setLoadError] = useState("")
  const [attempt, setAttempt] = useState(0)
  const [locationId, setLocationId] = useState("")
  const [shelfLabel, setShelfLabel] = useState("")
  const [position, setPosition] = useState("")
  const [busy, setBusy] = useState<"save" | "clear" | null>(null)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")

  const apply = (next: CopyLocationState) => {
    setState(next)
    setLocationId(next.current?.locationId ?? "")
    setShelfLabel(next.current?.shelfLabel ?? "")
    setPosition(next.current?.position ? String(next.current.position) : "")
  }

  useEffect(() => {
    let active = true
    getCopyLocationAction(copyId).then((result) => {
      if (!active) return
      if (result.ok) { apply(result.value); setLoadError("") } else setLoadError(result.error.message)
    }, () => { if (active) setLoadError("No se pudo cargar la ubicación física. La ficha sigue disponible.") })
    return () => { active = false }
  }, [copyId, attempt])

  const tree = useMemo(() => buildLocationTree(state?.locations ?? []), [state])
  const current = state?.current ?? null
  const locked = disabled || busy !== null
  const unchanged = current !== null && locationId === current.locationId && shelfLabel.trim() === (current.shelfLabel ?? "") && position.trim() === (current.position ? String(current.position) : "")

  const save = async () => {
    if (!state || locked || !locationId) return
    setBusy("save"); setMessage(""); setError("")
    try {
      const changed = unwrapAction(await setCopyLocationAction({ copyId, locationId, shelfLabel: shelfLabel.trim() || null, position: position.trim() || null, expectedVersion: current?.version ?? null }))
      apply(changed)
      const placed = changed.current
      setMessage(`${current ? "Ubicación física cambiada" : "Ubicación física guardada"}: ${placed ? formatLocationPath(placed.path, placed) : ""}.${changed.samePosition ? ` ${changed.samePosition === 1 ? "Otro ejemplar ya ocupa" : `Otros ${changed.samePosition} ejemplares ya ocupan`} esa posición en el mismo hueco; no se ha renumerado ninguno.` : ""}`)
    } catch (caught) { setError(messageOf(caught, "No se pudo guardar la ubicación física. Comprueba la conexión e inténtalo de nuevo.")) }
    finally { setBusy(null) }
  }

  const clear = async () => {
    if (!current || locked) return
    setBusy("clear"); setMessage(""); setError("")
    try {
      apply(unwrapAction(await clearCopyLocationAction({ copyId, expectedVersion: current.version })))
      setMessage("El ejemplar ya no tiene ubicación física. Su estantería no cambia.")
    } catch (caught) { setError(messageOf(caught, "No se pudo quitar la ubicación física.")) }
    finally { setBusy(null) }
  }

  return <section aria-labelledby={`${id}-title`} className="surface-card rounded-2xl p-5 space-y-3">
    <div className="flex items-center gap-2"><MapPin aria-hidden="true" className="h-4 w-4 text-primary" /><h2 id={`${id}-title`} className="text-sm font-semibold">Ubicación física</h2></div>
    {loadError ? <div role="alert" className="space-y-2 text-sm text-destructive"><p>{loadError}</p><Button type="button" variant="outline" onClick={() => setAttempt((value) => value + 1)}>Reintentar</Button></div>
      : !state ? <p className="text-sm text-muted-foreground" aria-busy="true">Cargando la ubicación física…</p>
      : <>
        <p className="text-sm" data-testid="copy-location-path">{current ? <><span className="text-muted-foreground">Está en </span><strong>{formatLocationPath(current.path, current)}</strong></> : <span className="text-muted-foreground">Sin ubicación física. La estantería de la biblioteca no depende de ella.</span>}</p>
        {state.locations.length === 0 ? <p className="text-sm text-muted-foreground">Aún no tienes ubicaciones. <Link href="/locations" className="font-semibold text-primary underline underline-offset-4">Crea tus muebles y baldas en Ubicaciones</Link>.</p> : (
          <form className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,7rem)]" onSubmit={(event) => { event.preventDefault(); void save() }} aria-busy={busy !== null}>
            <div className="space-y-1 sm:col-span-3"><label htmlFor={`${id}-location`} className="text-sm font-medium">Mueble o balda</label>
              <select id={`${id}-location`} value={locationId} disabled={locked} onChange={(event) => setLocationId(event.target.value)} className="w-full min-w-0 rounded-md border border-input bg-input px-3 py-2 text-foreground">
                <option value="">Elige una ubicación…</option>
                {tree.map((entry) => <option key={entry.id} value={entry.id}>{`${"  ".repeat(entry.depth - 1)}${entry.depth > 1 ? "└ " : ""}${entry.name} (${locationKindLabel(entry.kind)})`}</option>)}
              </select>
            </div>
            <div className="space-y-1 sm:col-span-2"><label htmlFor={`${id}-label`} className="text-sm font-medium">Balda o hueco <span className="font-normal text-muted-foreground">(opcional)</span></label>
              <Input id={`${id}-label`} value={shelfLabel} maxLength={LOCATION_LIMITS.shelfLabelMax} disabled={locked} placeholder="Ej.: Fila de atrás" onChange={(event) => setShelfLabel(event.target.value)} />
            </div>
            <div className="space-y-1"><label htmlFor={`${id}-position`} className="text-sm font-medium">Posición <span className="font-normal text-muted-foreground">(opcional)</span></label>
              <Input id={`${id}-position`} inputMode="numeric" pattern="[0-9]*" value={position} disabled={locked} onChange={(event) => setPosition(event.target.value.replace(/[^0-9]/g, "").slice(0, 6))} />
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-3">La posición es manual: al mover otros libros no se renumera ninguna.</p>
            <div className="flex flex-wrap gap-2 sm:col-span-3">
              <Button type="submit" disabled={locked || !locationId || unchanged}>{busy === "save" ? "Guardando…" : current ? "Mover a esta ubicación" : "Guardar ubicación"}</Button>
              {current && <Button type="button" variant="outline" disabled={locked} onClick={() => void clear()}>{busy === "clear" ? "Quitando…" : "Quitar ubicación"}</Button>}
              <Button asChild variant="ghost"><Link href={current ? `/locations?ubicacion=${current.locationId}` : "/locations"}>Ver ubicaciones</Link></Button>
            </div>
          </form>
        )}
        {message && <p role="status" className="rounded-xl border border-border bg-muted/40 p-3 text-sm">{message}</p>}
        {error && <div role="alert" className="space-y-2 rounded-xl border border-destructive/30 p-3 text-sm text-destructive"><p>{error}</p><Button type="button" variant="outline" onClick={() => { setError(""); setAttempt((value) => value + 1) }}>Recargar ubicación</Button></div>}
      </>}
  </section>
}
