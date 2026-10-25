"use client"

import { useEffect, useRef, useState } from "react"
import { getBookDetailAction } from "@/app/actions/books"
import { saveCopyPersonalAction } from "@/app/actions/copy-personal"
import { createTagAction, deleteTagAction, getTagsAction, renameTagAction } from "@/app/actions/tags"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { PersonalFields } from "@/components/personal-fields"
import { unwrapAction } from "@/lib/action-result"
import { DomainError } from "@/lib/domain-errors"
import type { PersonalInput } from "@/lib/personal-validation"
import type { Tag } from "@/lib/product/contracts"
import type { Book } from "@/lib/types"

export function BookPersonalPanel({ book, onChange }: { book: Book; onChange: (book: Book) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<PersonalInput>({})
  const [version, setVersion] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [conflict, setConflict] = useState(false)
  const [tags, setTags] = useState<Tag[]>([])
  const [attempt, setAttempt] = useState(0)
  const saving = useRef(false)
  useEffect(() => {
    let active = true
    getTagsAction().then((rows) => { if (active) setTags(rows) }).catch(() => { if (active) setError("No se pudieron cargar las etiquetas. Reintenta la carga.") })
    return () => { active = false }
  }, [attempt])
  const begin = () => { setDraft({ ...book.personal }); setVersion(book.personalVersion ?? null); setEditing(true); setError(""); setConflict(false); setMessage("") }
  const reload = async () => {
    setPending(true)
    try {
      const current = await getBookDetailAction(book.id)
      if (!current) throw new DomainError("NOT_FOUND", "El ejemplar ya no está disponible.")
      onChange(current); setDraft({ ...current.personal }); setVersion(current.personalVersion ?? null); setConflict(false); setError(""); setAttempt((n) => n + 1)
    } catch (caught) { setError(caught instanceof DomainError ? caught.message : "No se pudo cargar la versión actual. El borrador se conserva.") }
    finally { setPending(false) }
  }
  const save = async () => {
    if (pending || saving.current) return
    saving.current = true
    setPending(true); setError("")
    try {
      const updated = unwrapAction(await saveCopyPersonalAction({ copyId: book.id, expectedVersion: version, personal: draft }))
      onChange(updated); setEditing(false); setMessage("Datos personales guardados."); setAttempt((n) => n + 1)
    } catch (caught) { setConflict(caught instanceof DomainError && caught.code === "CONFLICT"); setError(caught instanceof DomainError ? caught.message : "No se pudieron guardar los datos personales. El borrador se conserva.") }
    finally { saving.current = false; setPending(false) }
  }
  return <section aria-label="Datos personales" className="space-y-4 rounded-2xl border border-border bg-card/80 p-5 shadow-lg">
    <h2 className="text-xl font-semibold">Notas, etiquetas y valoración</h2>
    {editing ? <form onSubmit={(event) => { event.preventDefault(); void save() }}><fieldset disabled={pending} className="min-w-0 space-y-4"><PersonalFields value={draft} onChange={setDraft} /><div className="flex flex-wrap gap-2"><Button disabled={pending || conflict}>Guardar datos personales</Button><Button type="button" variant="outline" onClick={() => { setEditing(false); setError(""); setConflict(false) }}>Cancelar</Button></div></fieldset></form> : <>
      <p className="whitespace-pre-wrap break-words">{book.personal?.notes || "Sin notas privadas."}</p>
      <p>{book.personal?.rating ? `Valoración: ${book.personal.rating} de 5` : "Sin valoración"}</p>
      <p className="text-sm">Etiquetas: {book.personal?.tagIds?.map((id) => tags.find((tag) => tag.id === id)?.name ?? "Etiqueta").join(", ") || "Sin etiquetas"}</p>
      <Button type="button" variant="outline" disabled={pending} onClick={begin}>Editar datos personales</Button>
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {conflict && <div className="space-y-2 text-sm"><p>Copia el contenido que quieras conservar antes de descartar el borrador.</p><Button type="button" variant="outline" disabled={pending} onClick={() => void reload()}>Descartar borrador y cargar datos personales actuales</Button></div>}
    {message && <p role="status">{message}</p>}
    {!editing && <TagManager tags={tags} onChanged={reload} onBusy={setPending} />}
    <Button type="button" size="sm" variant="ghost" onClick={() => setAttempt((n) => n + 1)}>Recargar etiquetas</Button>
  </section>
}

function TagManager({ tags, onChanged, onBusy }: { tags: Tag[]; onChanged: () => Promise<void>; onBusy: (busy: boolean) => void }) {
  const [error, setError] = useState("")
  const [pending, setPending] = useState(false)
  const [newName, setNewName] = useState("")
  const change = async (action: () => Promise<unknown>) => {
    setPending(true); onBusy(true); setError("")
    try { await action(); await onChanged() }
    catch (caught) { setError(caught instanceof DomainError ? caught.message : "No se pudo modificar la etiqueta.") }
    finally { setPending(false); onBusy(false) }
  }
  return <details className="space-y-3 border-t border-border pt-3"><summary className="min-h-11 cursor-pointer text-sm font-semibold">Gestionar etiquetas de la biblioteca</summary><p className="text-xs text-muted-foreground">Renombrar afecta a todos los ejemplares que usan la etiqueta. Eliminar retira sus vínculos y conserva todos los libros.</p>
    <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); void change(async () => { unwrapAction(await createTagAction(newName)); setNewName("") }) }}><Input aria-label="Nombre de etiqueta nueva" value={newName} onChange={(event) => setNewName(event.target.value)} disabled={pending} className="min-w-0 flex-1" /><Button disabled={pending}>Crear etiqueta</Button></form>
    <div className="max-h-80 space-y-2 overflow-y-auto">{tags.map((tag) => <form key={`${tag.id}-${tag.version}`} className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); const name = new FormData(event.currentTarget).get("name"); void change(async () => { unwrapAction(await renameTagAction({ tagId: tag.id, expectedVersion: tag.version, name })) }) }}><Input name="name" defaultValue={tag.name} aria-label={`Nombre de etiqueta ${tag.name}`} disabled={pending} className="min-w-0 flex-1" /><Button variant="outline" disabled={pending} aria-label={`Renombrar etiqueta ${tag.name}`}>Renombrar</Button><Button type="button" variant="outline" disabled={pending} aria-label={`Eliminar etiqueta ${tag.name}`} onClick={() => void change(async () => { unwrapAction(await deleteTagAction({ tagId: tag.id, expectedVersion: tag.version })) })}>Eliminar</Button></form>)}</div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </details>
}
