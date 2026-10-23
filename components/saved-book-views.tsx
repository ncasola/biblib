"use client"

import { useEffect, useState } from "react"
import { deleteSavedViewAction, listSavedViewsAction, overwriteSavedViewAction, renameSavedViewAction, saveCurrentViewAction } from "@/app/actions/saved-views"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { unwrapAction } from "@/lib/action-result"
import { DomainError } from "@/lib/domain-errors"
import { currentViewFilters, type SavedBookView, type SavedViewFilters } from "@/lib/saved-views"
import type { BookSearchFilters } from "@/lib/book-search"

export function SavedBookViews({ filters, onApply }: { filters: BookSearchFilters; onApply: (filters: SavedViewFilters) => Promise<void> }) {
  const [views, setViews] = useState<SavedBookView[]>([])
  const [name, setName] = useState("")
  const [rename, setRename] = useState<{ id: string; name: string } | null>(null)
  const [confirm, setConfirm] = useState<{ id: string; operation: "overwrite" | "delete" } | null>(null)
  const [pending, setPending] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")

  async function run(work: () => Promise<void>, success: string) {
    if (pending) return
    setPending(true)
    setError("")
    setMessage("")
    try { await work(); setMessage(success) }
    catch (cause) { setError(cause instanceof DomainError ? cause.message : "No se pudo completar la operación. Tus filtros se conservan.") }
    finally { setPending(false) }
  }

  useEffect(() => {
    let active = true
    void listSavedViewsAction().then((result) => {
      const values = unwrapAction(result)
      if (active) { setViews(values); setLoaded(true) }
    }).catch(() => { if (active) setError("No se pudieron cargar las vistas guardadas. Puedes actualizar la lista.") })
    return () => { active = false }
  }, [])

  function replace(view: SavedBookView | null) {
    if (view) setViews((current) => [view, ...current.filter((entry) => entry.id !== view.id)])
  }

  return <section aria-label="Vistas guardadas" className="rounded-2xl border border-border bg-card/80 p-4 shadow-xl backdrop-blur-xl">
    <details>
      <summary className="cursor-pointer rounded-lg py-2 font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Vistas guardadas{loaded ? ` (${views.length}/100)` : ""}</summary>
      <fieldset disabled={pending} aria-busy={pending} className="mt-3 space-y-4">
        <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(event) => {
          event.preventDefault()
          void run(async () => {
            replace(unwrapAction(await saveCurrentViewAction({ name, filters: currentViewFilters(filters) })))
            setName("")
          }, "Vista guardada.")
        }}>
          <div className="flex-1"><label htmlFor="saved-view-name" className="mb-2 block text-sm font-medium">Nombre de la vista</label><Input id="saved-view-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required className="bg-surface" /></div>
          <Button type="submit" disabled={!name.trim() || !loaded || views.length >= 100}>Guardar vista actual</Button>
        </form>
        <Button type="button" variant="outline" size="sm" onClick={() => void run(async () => { setViews(unwrapAction(await listSavedViewsAction())); setLoaded(true); setRename(null); setConfirm(null) }, "Lista de vistas actualizada.")}>Actualizar vistas</Button>
        {loaded && views.length === 0 && <p className="text-sm text-muted-foreground">Aún no tienes vistas guardadas.</p>}
        <ul className="space-y-3">{views.map((view) => <li key={view.id} className="space-y-3 rounded-xl border border-border bg-surface/60 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><span className="break-all font-medium">{view.name}</span>
            <div className="flex flex-wrap gap-2" role="group" aria-label={`Acciones de ${view.name}`}>
              <Button type="button" size="sm" onClick={() => void run(() => onApply(view.filters), `Vista «${view.name}» aplicada.`)}>Aplicar</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => { setRename({ id: view.id, name: view.name }); setConfirm(null) }}>Renombrar</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => { setConfirm({ id: view.id, operation: "overwrite" }); setRename(null) }}>Sobrescribir</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => { setConfirm({ id: view.id, operation: "delete" }); setRename(null) }}>Borrar</Button>
            </div>
          </div>
          {rename?.id === view.id && <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => {
            event.preventDefault()
            void run(async () => { replace(unwrapAction(await renameSavedViewAction({ id: view.id, name: rename.name, expectedVersion: view.version }))); setRename(null) }, "Vista renombrada.")
          }}><div className="flex-1"><label htmlFor={`rename-view-${view.id}`} className="mb-2 block text-sm">Nuevo nombre</label><Input id={`rename-view-${view.id}`} value={rename.name} onChange={(event) => setRename({ id: view.id, name: event.target.value })} maxLength={80} required /></div><Button type="submit" disabled={!rename.name.trim()}>Guardar nombre</Button><Button type="button" variant="ghost" onClick={() => setRename(null)}>Cancelar</Button></form>}
          {confirm?.id === view.id && <div className="space-y-2"><p className="text-sm">{confirm.operation === "delete" ? `¿Borrar la vista «${view.name}»?` : `¿Sustituir «${view.name}» con los filtros actuales?`}</p><div className="flex flex-wrap gap-2"><Button type="button" variant={confirm.operation === "delete" ? "destructive" : "default"} onClick={() => void run(async () => {
            const input = { id: view.id, expectedVersion: view.version }
            if (confirm.operation === "delete") { unwrapAction(await deleteSavedViewAction(input)); setViews((current) => current.filter((entry) => entry.id !== view.id)) }
            else replace(unwrapAction(await overwriteSavedViewAction({ ...input, filters: currentViewFilters(filters) })))
            setConfirm(null)
          }, confirm.operation === "delete" ? "Vista borrada." : "Vista sobrescrita.")}>Confirmar {confirm.operation === "delete" ? "borrado" : "sobrescritura"}</Button><Button type="button" variant="ghost" onClick={() => setConfirm(null)}>Cancelar</Button></div></div>}
        </li>)}</ul>
      </fieldset>
      {pending && <p role="status" className="mt-3 text-sm">Procesando vista…</p>}
      {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
      {message && <p role="status" className="mt-3 text-sm text-foreground">{message}</p>}
    </details>
  </section>
}
