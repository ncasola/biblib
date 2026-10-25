"use client"

import Link from "next/link"
import { useEffect, useId, useRef, useState } from "react"
import { CheckCircle, Loader2, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { BookCover } from "@/components/book-cover"
import { createCopyAction, getEditionCopiesAction } from "@/app/actions/editions"
import { unwrapAction } from "@/lib/action-result"
import { displayCover } from "@/lib/book-covers"
import { DomainError } from "@/lib/domain-errors"
import type { Book, Shelf } from "@/lib/types"

// Ejemplares de una edición (U-DAT-06). Añadir un ejemplar es siempre una acción explícita: la respuesta a
// «ya existe» ofrece abrir el ejemplar guardado o añadir otro, nunca lo hace sola.

const selectClass = "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-ring"
const statusLabels: Record<Book["status"], string> = { unread: "Sin leer", reading: "Leyendo", read: "Leído", "to-read": "Por leer" }

/** Identificador visible: ISBN-13, o «Sin ISBN» y el identificador anterior si no es un `manual-…`. */
export function bookIdentifierLabel(book: Pick<Book, "isbn" | "legacyIdentifier">): string {
  if (book.isbn) return book.isbn
  if (book.legacyIdentifier && !book.legacyIdentifier.startsWith("manual-")) return `Sin ISBN-13 (identificador anterior: ${book.legacyIdentifier})`
  return "Sin ISBN"
}

/** Formulario para añadir otro ejemplar de la edición de `book`: estantería y estado propios. */
export function AddCopyForm({ book, shelves, onCreated }: { book: Book; shelves: Shelf[]; onCreated: (copy: Book) => void }) {
  const id = useId()
  const key = useRef(crypto.randomUUID())
  const [shelfId, setShelfId] = useState(shelves.find((shelf) => shelf.isDefault)?.id ?? shelves[0]?.id ?? "")
  const [status, setStatus] = useState<Book["status"]>("unread")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  if (!book.edition) return null
  const submit = async () => {
    if (pending || !shelfId) return
    setPending(true); setError("")
    try {
      const created = unwrapAction(await createCopyAction({ editionId: book.edition!.id, placement: { shelfId }, status, idempotencyKey: key.current }))
      key.current = crypto.randomUUID()
      onCreated(created)
    } catch (caught) { setError(caught instanceof DomainError ? caught.message : "No se pudo añadir el ejemplar. Comprueba la conexión y vuelve a intentarlo.") }
    finally { setPending(false) }
  }
  return (
    <fieldset disabled={pending} className="space-y-3 min-w-0">
      <legend className="text-sm font-semibold">Añadir otro ejemplar de esta edición</legend>
      <p className="text-xs text-muted-foreground">Tendrá su propia estantería y estado. La comprobación del ISBN también es de cada ejemplar: empieza sin verificar.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1"><label htmlFor={`${id}-shelf`} className="text-sm">Estantería</label><select id={`${id}-shelf`} className={selectClass} value={shelfId} onChange={(event) => setShelfId(event.target.value)}>{shelves.map((shelf) => <option key={shelf.id} value={shelf.id}>{shelf.title}{shelf.isDefault ? " (predeterminada)" : ""}</option>)}</select></div>
        <div className="space-y-1"><label htmlFor={`${id}-status`} className="text-sm">Estado de lectura</label><select id={`${id}-status`} className={selectClass} value={status} onChange={(event) => setStatus(event.target.value as Book["status"])}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="button" variant="outline" disabled={pending || !shelfId} onClick={() => void submit()}>{pending ? <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" /> : <Plus aria-hidden="true" className="mr-2 h-4 w-4" />}{pending ? "Añadiendo..." : "Añadir otro ejemplar"}</Button>
    </fieldset>
  )
}

/** «Ya existe»: la edición ya está en la biblioteca. Abrir el ejemplar guardado o añadir otro, a elección. */
export function ExistingEditionPanel({ book, shelves }: { book: Book; shelves: Shelf[] }) {
  const [created, setCreated] = useState<Book | null>(null)
  const copies = book.edition?.copies ?? 1
  return (
    <section className="rounded-2xl border border-border bg-card/80 p-6 shadow-xl space-y-4" aria-labelledby="existing-edition-title">
      <p id="existing-edition-title" role="status" className="flex items-center gap-2 font-semibold"><CheckCircle aria-hidden="true" className="h-5 w-5" />{created ? "Ejemplar añadido a tu biblioteca" : "Esta edición ya está en tu biblioteca"}</p>
      <BookCover cover={displayCover(created ?? book)} title={book.title} className="w-28" sizes="112px" />
      <h2 className="text-xl font-bold">{book.title}</h2>
      {created
        ? <><p className="text-sm text-muted-foreground">Guardado en {created.shelf_name}. La edición tiene ahora {copies + 1} ejemplares.</p><Button asChild><Link href={`/book/${created.id}`}>Ver el ejemplar nuevo</Link></Button></>
        : <><p className="text-sm text-muted-foreground">{copies === 1 ? `Tienes un ejemplar en ${book.shelf_name}.` : `Tienes ${copies} ejemplares; uno está en ${book.shelf_name}.`}</p>
          <Button asChild><Link href={`/book/${book.id}`}>Abrir el ejemplar guardado</Link></Button>
          <AddCopyForm book={book} shelves={shelves} onCreated={setCreated} /></>}
    </section>
  )
}

/** Ficha: ejemplares de la misma edición y alta de otro. */
export function EditionCopiesPanel({ book, shelves }: { book: Book; shelves: Shelf[] }) {
  const [copies, setCopies] = useState<Book[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [added, setAdded] = useState<Book | null>(null)
  const count = book.edition?.copies ?? 1
  useEffect(() => {
    let active = true
    if (count < 2 && !added) return
    getEditionCopiesAction(book.id).then((loaded) => { if (active) setCopies(loaded) }, () => { if (active) setFailed(true) })
    return () => { active = false }
  }, [book.id, count, added])
  const others = (copies ?? []).filter((copy) => copy.id !== book.id)
  return (
    <section className="rounded-2xl border border-border bg-card/80 p-5 shadow-lg space-y-3" aria-labelledby="edition-copies-title">
      <h2 id="edition-copies-title" className="text-sm font-semibold">Ejemplares de esta edición</h2>
      <p className="text-sm text-muted-foreground">{count + (added ? 1 : 0) === 1 ? "Tienes un ejemplar de esta edición." : `Tienes ${count + (added ? 1 : 0)} ejemplares de esta edición. Los datos bibliográficos son comunes; estado, estantería y comprobación son de cada uno.`}</p>
      {failed && <p role="alert" className="text-sm text-destructive">No se pudieron cargar los otros ejemplares.</p>}
      {others.length > 0 && <ul className="space-y-1 text-sm">{others.map((copy) => <li key={copy.id}><Link className="underline underline-offset-2" href={`/book/${copy.id}`}>Ejemplar en {copy.shelf_name}</Link> · {statusLabels[copy.status]}</li>)}</ul>}
      {added && <p role="status" className="text-sm">Ejemplar añadido en {added.shelf_name}.</p>}
      <AddCopyForm book={book} shelves={shelves} onCreated={setAdded} />
    </section>
  )
}
