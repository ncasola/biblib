"use client"

import { useCallback, useEffect, useId, useMemo, useState } from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { FolderTree, Plus, Search, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { LocationPhoto } from "@/components/location-photo"
import {
  createLocationAction, deleteLocationAction, getLocationContentsAction, getLocationsAction, moveLocationAction, updateLocationAction, type LocationContents,
} from "@/app/actions/locations"
import { unwrapAction } from "@/lib/action-result"
import { BOOK_RETURN_PARAM } from "@/lib/book-search"
import { DomainError } from "@/lib/domain-errors"
import { buildLocationTree, formatLocationPath, locationKindLabel, moveTargets, type LocationTreeEntry, type LocationView } from "@/lib/locations"
import { LOCATION_KINDS, LOCATION_LIMITS, type LocationKind } from "@/lib/product/contracts"
import type { Book } from "@/lib/types"

const selectClass = "w-full min-w-0 rounded-lg border border-input bg-background p-2 text-foreground"
const statusLabels: Record<Book["status"], string> = { unread: "Sin leer", reading: "Leyendo", read: "Leído", "to-read": "Por leer" }
const messageOf = (caught: unknown, fallback: string) => caught instanceof DomainError ? caught.message : fallback
const indent = (entry: LocationTreeEntry) => `${"  ".repeat(entry.depth - 1)}${entry.depth > 1 ? "└ " : ""}${entry.name}`
const contentsLabel = (location: LocationView) => {
  const parts = [
    location.children ? `${location.children} ${location.children === 1 ? "ubicación" : "ubicaciones"}` : "",
    location.copies ? `${location.copies} ${location.copies === 1 ? "ejemplar" : "ejemplares"}` : "",
  ].filter(Boolean)
  return parts.length ? parts.join(" · ") : "Vacía"
}

function KindSelect({ id, value, disabled, onChange }: { id: string; value: LocationKind; disabled: boolean; onChange(kind: LocationKind): void }) {
  return <select id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as LocationKind)} className={selectClass}>
    {LOCATION_KINDS.map((kind) => <option key={kind} value={kind}>{locationKindLabel(kind)}</option>)}
  </select>
}

/** Alta de una ubicación en la raíz o dentro de otra. */
function CreateLocationForm({ tree, defaultParent, onCreated }: { tree: LocationTreeEntry[]; defaultParent: string; onCreated(location: LocationView): void }) {
  const id = useId()
  const [name, setName] = useState("")
  const [kind, setKind] = useState<LocationKind>("bookcase")
  // La elección vale mientras no cambie la ubicación seleccionada (destino por defecto).
  const [choice, setChoice] = useState({ base: defaultParent, value: defaultParent })
  const parentId = choice.base === defaultParent ? choice.value : defaultParent
  const setParentId = (value: string) => setChoice({ base: defaultParent, value })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const parents = tree.filter((entry) => entry.depth < LOCATION_LIMITS.maxDepth)

  const create = async () => {
    if (pending || !name.trim()) return
    setPending(true); setError("")
    try {
      onCreated(unwrapAction(await createLocationAction({ name: name.trim(), kind, parentId: parentId || null })))
      setName("")
    } catch (caught) { setError(messageOf(caught, "No se pudo crear la ubicación.")) }
    finally { setPending(false) }
  }

  return <form aria-labelledby={`${id}-title`} aria-busy={pending} onSubmit={(event) => { event.preventDefault(); void create() }} className="rounded-2xl border border-border bg-card/80 p-5 shadow-xl backdrop-blur-xl space-y-3">
    <h2 id={`${id}-title`} className="text-lg font-semibold">Nueva ubicación</h2>
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1 sm:col-span-2"><label htmlFor={`${id}-name`} className="text-sm font-medium">Nombre</label>
        <Input id={`${id}-name`} value={name} maxLength={LOCATION_LIMITS.nameMax} disabled={pending} placeholder="Ej.: Estantería del salón, Balda 3, Caja de mudanza" onChange={(event) => setName(event.target.value)} /></div>
      <div className="space-y-1"><label htmlFor={`${id}-kind`} className="text-sm font-medium">Tipo</label><KindSelect id={`${id}-kind`} value={kind} disabled={pending} onChange={setKind} /></div>
      <div className="space-y-1"><label htmlFor={`${id}-parent`} className="text-sm font-medium">Dentro de</label>
        <select id={`${id}-parent`} value={parentId} disabled={pending} onChange={(event) => setParentId(event.target.value)} className={selectClass}>
          <option value="">Ninguna (nivel superior)</option>
          {parents.map((entry) => <option key={entry.id} value={entry.id}>{indent(entry)}</option>)}
        </select></div>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Button type="submit" disabled={pending || !name.trim()}><Plus aria-hidden="true" className="mr-2 h-4 w-4" />{pending ? "Creando…" : "Crear ubicación"}</Button>
  </form>
}

/** Ejemplares de la ubicación elegida, con filtro por texto y estado y la opción de incluir las interiores. */
function LocationContentsPanel({ location }: { location: LocationTreeEntry }) {
  const id = useId()
  const [query, setQuery] = useState("")
  const [applied, setApplied] = useState("")
  const [status, setStatus] = useState<Book["status"] | "">("")
  const [includeNested, setIncludeNested] = useState(false)
  const [page, setPage] = useState(1)
  const [contents, setContents] = useState<LocationContents | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    let active = true
    getLocationContentsAction({ locationId: location.id, query: applied || undefined, status: status || undefined, includeNested, page }).then((result) => {
      if (!active) return
      if (result.ok) { setContents(result.value); setError("") } else setError(result.error.message)
    }, () => { if (active) setError("No se pudo cargar el contenido. Comprueba la conexión.") })
    return () => { active = false }
  }, [location.id, location.version, location.copies, applied, status, includeNested, page])

  const returnTo = `/locations?ubicacion=${location.id}`
  const pages = contents ? Math.max(1, Math.ceil(contents.total / contents.pageSize)) : 1
  return <section aria-labelledby={`${id}-title`} className="space-y-3">
    <h3 id={`${id}-title`} className="text-base font-semibold">Contenido</h3>
    <form role="search" aria-label={`Filtrar el contenido de ${location.name}`} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]" onSubmit={(event) => { event.preventDefault(); setApplied(query.trim()); setPage(1) }}>
      <div className="space-y-1"><label htmlFor={`${id}-query`} className="text-sm font-medium">Título o autor</label><Input id={`${id}-query`} value={query} maxLength={200} onChange={(event) => setQuery(event.target.value)} /></div>
      <div className="space-y-1"><label htmlFor={`${id}-status`} className="text-sm font-medium">Estado</label>
        <select id={`${id}-status`} value={status} onChange={(event) => { setStatus(event.target.value as Book["status"] | ""); setPage(1) }} className={selectClass}>
          <option value="">Todos</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></div>
      <div className="flex items-end"><Button type="submit" variant="outline"><Search aria-hidden="true" className="mr-2 h-4 w-4" />Filtrar</Button></div>
      <label className="flex items-center gap-2 text-sm sm:col-span-3"><input type="checkbox" checked={includeNested} onChange={(event) => { setIncludeNested(event.target.checked); setPage(1) }} className="h-4 w-4" />Incluir las ubicaciones que contiene</label>
    </form>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : !contents ? <p className="text-sm text-muted-foreground">Cargando contenido…</p> : contents.total === 0 ? (
      <p className="text-sm text-muted-foreground">{applied || status ? "Ningún ejemplar de esta ubicación coincide con el filtro." : "No hay ejemplares en esta ubicación. Asígnalos desde la ficha de cada libro."}</p>
    ) : <>
      <p className="text-sm text-muted-foreground">{contents.total} {contents.total === 1 ? "ejemplar" : "ejemplares"}</p>
      <ul className="divide-y divide-border rounded-xl border border-border" aria-label={`Ejemplares en ${location.name}`}>
        {contents.items.map((item) => <li key={item.id} className="p-3 text-sm">
          <Link href={`/book/${item.id}?${BOOK_RETURN_PARAM}=${encodeURIComponent(returnTo)}`} className="font-semibold text-primary underline-offset-4 hover:underline">{item.title}</Link>
          <p className="text-muted-foreground">{[item.authors.join("; "), statusLabels[item.status], `Estantería: ${item.shelfName}`].filter(Boolean).join(" · ")}</p>
          {(item.shelfLabel || item.position || item.locationId !== location.id) && <p className="text-muted-foreground">{[item.locationId !== location.id ? "En una ubicación interior" : "", item.shelfLabel ? `Hueco «${item.shelfLabel}»` : "", item.position ? `Posición ${item.position}` : ""].filter(Boolean).join(" · ")}</p>}
        </li>)}
      </ul>
      {pages > 1 && <nav aria-label="Páginas del contenido" className="flex items-center gap-2">
        <Button type="button" variant="outline" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Anterior</Button>
        <span className="text-sm">Página {page} de {pages}</span>
        <Button type="button" variant="outline" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>Siguiente</Button>
      </nav>}
    </>}
  </section>
}

/** Renombrar, mover, borrar, foto y contenido de la ubicación elegida. */
function LocationDetails({ entry, tree, onChanged, onDeleted }: { entry: LocationTreeEntry; tree: LocationTreeEntry[]; onChanged(location: LocationView, message: string): void; onDeleted(message: string): void }) {
  const id = useId()
  // Borrador ligado a la versión vista: si la ubicación cambia (renombrada, movida, con foto nueva), vuelve a sus datos.
  const [draft, setDraft] = useState({ version: entry.version, name: entry.name, kind: entry.kind, target: entry.parentId ?? "" })
  const current = draft.version === entry.version ? draft : { version: entry.version, name: entry.name, kind: entry.kind, target: entry.parentId ?? "" }
  const { name, kind, target } = current
  const setName = (value: string) => setDraft({ ...current, name: value })
  const setKind = (value: LocationKind) => setDraft({ ...current, kind: value })
  const setTarget = (value: string) => setDraft({ ...current, target: value })
  const [busy, setBusy] = useState<"rename" | "move" | "delete" | null>(null)
  const [error, setError] = useState("")
  const [deleteOpen, setDeleteOpen] = useState(false)
  const targets = useMemo(() => moveTargets(tree, entry.id), [tree, entry.id])
  const occupied = entry.copies > 0 || entry.children > 0
  const parentName = entry.parentId ? tree.find((candidate) => candidate.id === entry.parentId)?.name ?? null : null

  const run = async (kindOfChange: "rename" | "move", work: () => Promise<LocationView>, message: string) => {
    if (busy) return
    setBusy(kindOfChange); setError("")
    try { onChanged(await work(), message) } catch (caught) { setError(messageOf(caught, "No se pudo guardar el cambio. Inténtalo de nuevo.")) }
    finally { setBusy(null) }
  }

  const remove = async (contents: "reject" | "move-to-parent") => {
    if (busy) return
    setBusy("delete"); setError("")
    try {
      const result = unwrapAction(await deleteLocationAction({ id: entry.id, expectedVersion: entry.version, contents }))
      setDeleteOpen(false)
      const moved = [
        result.movedChildren ? `${result.movedChildren} ${result.movedChildren === 1 ? "ubicación pasó" : "ubicaciones pasaron"} ${parentName ? `a «${parentName}»` : "al nivel superior"}` : "",
        result.movedCopies ? `${result.movedCopies} ${result.movedCopies === 1 ? "ejemplar pasó" : "ejemplares pasaron"} a «${parentName}» con su hueco y posición` : "",
        result.unassignedCopies ? `${result.unassignedCopies} ${result.unassignedCopies === 1 ? "ejemplar quedó" : "ejemplares quedaron"} sin ubicación física` : "",
      ].filter(Boolean).join("; ")
      onDeleted(`Ubicación «${entry.name}» borrada.${moved ? ` ${moved}.` : ""} Ningún libro ha cambiado de estantería.`)
    } catch (caught) { setError(messageOf(caught, "No se pudo borrar la ubicación.")) }
    finally { setBusy(null) }
  }

  return <section aria-labelledby={`${id}-title`} className="rounded-2xl border border-border bg-card/80 p-5 shadow-xl backdrop-blur-xl space-y-5">
    <div>
      <h2 id={`${id}-title`} className="text-xl font-semibold break-words">{entry.name}</h2>
      <p className="text-sm text-muted-foreground">{locationKindLabel(entry.kind)} · {formatLocationPath(entry.path)} · {contentsLabel(entry)}</p>
    </div>
    {error && <p role="alert" className="rounded-xl border border-destructive/30 p-3 text-sm text-destructive">{error}</p>}

    <form aria-label="Renombrar la ubicación" className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto]" onSubmit={(event) => { event.preventDefault(); void run("rename", async () => unwrapAction(await updateLocationAction({ id: entry.id, name: name.trim(), kind, expectedVersion: entry.version })), "Ubicación actualizada.") }}>
      <div className="space-y-1"><label htmlFor={`${id}-name`} className="text-sm font-medium">Nombre</label><Input id={`${id}-name`} value={name} maxLength={LOCATION_LIMITS.nameMax} disabled={busy !== null} onChange={(event) => setName(event.target.value)} /></div>
      <div className="space-y-1"><label htmlFor={`${id}-kind`} className="text-sm font-medium">Tipo</label><KindSelect id={`${id}-kind`} value={kind} disabled={busy !== null} onChange={setKind} /></div>
      <div className="flex items-end"><Button type="submit" disabled={busy !== null || !name.trim() || (name.trim() === entry.name && kind === entry.kind)}>{busy === "rename" ? "Guardando…" : "Guardar"}</Button></div>
    </form>

    <form aria-label="Mover la ubicación" className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]" onSubmit={(event) => { event.preventDefault(); void run("move", async () => unwrapAction(await moveLocationAction({ id: entry.id, parentId: target || null, expectedVersion: entry.version })), "Ubicación movida con todo lo que contiene.") }}>
      <div className="space-y-1"><label htmlFor={`${id}-target`} className="text-sm font-medium">Mover dentro de</label>
        <select id={`${id}-target`} value={target} disabled={busy !== null} onChange={(event) => setTarget(event.target.value)} className={selectClass}>
          <option value="">Ninguna (nivel superior)</option>
          {targets.map((candidate) => <option key={candidate.id} value={candidate.id}>{indent(candidate)}</option>)}
        </select>
        <p className="text-xs text-muted-foreground">Se mueve con todo lo que contiene. No se ofrecen sus ubicaciones interiores ni destinos que superen {LOCATION_LIMITS.maxDepth} niveles.</p>
      </div>
      <div className="flex items-end"><Button type="submit" variant="outline" disabled={busy !== null || target === (entry.parentId ?? "")}>{busy === "move" ? "Moviendo…" : "Mover"}</Button></div>
    </form>

    <LocationPhoto location={entry} onChange={(updated) => onChanged(updated, "")} />
    <LocationContentsPanel location={entry} />

    <AlertDialog open={deleteOpen} onOpenChange={(open) => { if (busy !== "delete") { setDeleteOpen(open); setError("") } }}>
      <Button type="button" variant="outline" className="text-destructive border-destructive/40" disabled={busy !== null} onClick={() => setDeleteOpen(true)}><Trash2 aria-hidden="true" className="mr-2 h-4 w-4" />Borrar ubicación</Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>¿Borrar «{entry.name}»?</AlertDialogTitle>
          <AlertDialogDescription>{occupied
            ? `No está vacía: contiene ${contentsLabel(entry).toLowerCase()}. Puedes cancelar y vaciarla antes, o pasar su contenido ${parentName ? `a «${parentName}»` : "al nivel superior"}${entry.copies && !parentName ? " (sus ejemplares quedarán sin ubicación física)" : ""}. Ningún libro se borra ni cambia de estantería.`
            : "Está vacía. Ningún libro cambia."}</AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy === "delete"}>Cancelar</AlertDialogCancel>
          <AlertDialogAction disabled={busy === "delete"} onClick={(event) => { event.preventDefault(); void remove(occupied ? "move-to-parent" : "reject") }} className="bg-destructive text-destructive-foreground">
            {busy === "delete" ? "Borrando…" : occupied ? "Pasar contenido y borrar" : "Borrar ubicación"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section>
}

/** Pantalla `/locations` (U-PRO-03). La ubicación física complementa la estantería lógica y nunca la cambia. */
export function LocationManager({ initialLocationId }: { initialLocationId: string | null }) {
  const router = useRouter()
  const pathname = usePathname()
  const [locations, setLocations] = useState<LocationView[] | null>(null)
  const [loadError, setLoadError] = useState("")
  const [selected, setSelected] = useState<string | null>(initialLocationId)
  const [message, setMessage] = useState("")
  const tree = useMemo(() => buildLocationTree(locations ?? []), [locations])
  const entry = tree.find((candidate) => candidate.id === selected) ?? null

  const load = useCallback(async () => {
    try {
      setLocations(unwrapAction(await getLocationsAction()).locations)
      setLoadError("")
    } catch (caught) { setLoadError(messageOf(caught, "No se pudieron cargar las ubicaciones. Comprueba la conexión y vuelve a intentarlo.")) }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const select = (id: string | null) => {
    setSelected(id)
    router.replace(id ? `${pathname}?ubicacion=${id}` : pathname, { scroll: false })
  }

  return <div className="mx-auto max-w-6xl space-y-6">
    <div className="space-y-2">
      <h1 className="text-3xl font-bold heading-vintage">Ubicaciones físicas</h1>
      <p className="text-muted-foreground">Dónde está cada libro en casa: muebles, cajas y baldas. Es independiente de las estanterías de la biblioteca, que no cambian al mover un libro de sitio.</p>
    </div>
    {message && <p role="status" className="rounded-xl border border-border bg-muted/40 p-3 text-sm">{message}</p>}
    {loadError ? <div role="alert" className="space-y-2 text-destructive"><p>{loadError}</p><Button variant="outline" onClick={() => void load()}>Reintentar</Button></div>
      : !locations ? <p className="text-muted-foreground">Cargando ubicaciones…</p>
      : <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="space-y-6">
          <nav aria-label="Árbol de ubicaciones" className="rounded-2xl border border-border bg-card/80 p-5 shadow-xl backdrop-blur-xl space-y-3">
            <div className="flex items-center gap-2"><FolderTree aria-hidden="true" className="h-4 w-4 text-primary" /><h2 className="text-lg font-semibold">Tus ubicaciones</h2></div>
            {tree.length === 0 ? <p className="text-sm text-muted-foreground">Aún no hay ubicaciones. Crea la primera, por ejemplo una estantería, y después sus baldas dentro.</p> : (
              <ul className="space-y-1">
                {tree.map((candidate) => <li key={candidate.id} style={{ paddingInlineStart: `${(candidate.depth - 1) * 0.9}rem` }}>
                  <button type="button" aria-current={candidate.id === selected ? "true" : undefined} onClick={() => select(candidate.id)}
                    className={`w-full rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring ${candidate.id === selected ? "bg-primary/10 font-semibold text-primary" : ""}`}>
                    <span className="break-words">{candidate.name}</span>
                    <span className="block text-xs font-normal text-muted-foreground">{locationKindLabel(candidate.kind)} · {contentsLabel(candidate)}</span>
                  </button>
                </li>)}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">{locations.length} de {LOCATION_LIMITS.perAccount} ubicaciones · hasta {LOCATION_LIMITS.maxDepth} niveles.</p>
          </nav>
          <CreateLocationForm tree={tree} defaultParent={entry?.id ?? ""} onCreated={(created) => { setMessage(`Ubicación «${created.name}» creada.`); void load().then(() => select(created.id)) }} />
        </div>
        {entry ? <LocationDetails key={entry.id} entry={entry} tree={tree}
          onChanged={(updated, text) => { if (text) setMessage(text); setLocations((current) => current?.map((item) => item.id === updated.id ? updated : item) ?? null); void load() }}
          onDeleted={(text) => { setMessage(text); select(entry.parentId); void load() }} />
          : <p className="rounded-2xl border border-dashed border-border p-6 text-sm text-muted-foreground">{selected ? "Esa ubicación ya no está disponible." : "Elige una ubicación para ver su contenido, renombrarla, moverla o añadir una foto."}</p>}
      </div>}
  </div>
}
