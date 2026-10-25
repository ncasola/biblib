"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArrowLeft, Edit2, Loader2, RefreshCw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { BookForm } from "@/components/book-form"
import { BookPersonalPanel } from "@/components/book-personal-panel"
import { BookCover } from "@/components/book-cover"
import { BookCoverAssets } from "@/components/book-cover-assets"
import { displayCover } from "@/lib/book-covers"
import { BookStatusForm } from "@/components/book-status-form"
import { CatalogueProvenanceDetails } from "@/components/catalogue-provenance-details"
import { bookIdentifierLabel, EditionConflictPanel, EditionCopiesPanel } from "@/components/edition-copies"
import { EditionSeriesPanel } from "@/components/edition-series-panel"
import { updateEditionAction } from "@/app/actions/editions"
import { getBookDetailAction, updateBookAction, updateBookStatusAction, deleteBookAction, refreshBookCoverAction, moveBookShelfAction } from "@/app/actions/books"
import { getShelvesAction } from "@/app/actions/shelves"
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription,
  AlertDialogFooter, AlertDialogCancel, AlertDialogAction, AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import type { Book, Shelf } from "@/lib/types"
import { normalizeIsbn } from "@/lib/isbn"
import { unwrapAction } from "@/lib/action-result"
import { DomainError } from "@/lib/domain-errors"
import { resolveBookReturnPath } from "@/lib/book-search"

interface BookDetailsScreenProps {
  bookId: string
  /** URL interna del listado de origen, ya validada en el servidor; se vuelve a validar aquí. */
  returnPath: string
}

export function BookDetailsScreen({ bookId, returnPath }: BookDetailsScreenProps) {
  const router = useRouter()
  const backHref = resolveBookReturnPath(returnPath)
  const [book, setBook] = useState<Book | null>(null)
  const [shelves, setShelves] = useState<Shelf[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState("")
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [editing, setEditing] = useState<false | "copy" | "edition">(false)
  const [pending, setPending] = useState<"cover" | "delete" | "status" | "shelf" | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [targetShelf, setTargetShelf] = useState("")
  const [attempt, setAttempt] = useState(0)
  const editButton = useRef<HTMLButtonElement>(null)
  const wasEditing = useRef(false)

  useEffect(() => {
    if (editing) {
      document.querySelector<HTMLInputElement>('form input[required]')?.focus()
    } else if (wasEditing.current) {
      editButton.current?.focus()
    }
    wasEditing.current = Boolean(editing)
  }, [editing])

  useEffect(() => {
    let active = true
    const load = async () => {
      setLoading(true); setLoadError("")
      try {
        const [found, loadedShelves] = await Promise.all([getBookDetailAction(bookId), getShelvesAction()])
        if (active) { setBook(found); setShelves(loadedShelves); setTargetShelf(found?.shelf_id ?? "") }
      } catch { if (active) setLoadError("No se pudo cargar el libro. Comprueba la conexión y vuelve a intentarlo.") }
      finally { if (active) setLoading(false) }
    }
    void load()
    return () => { active = false }
  }, [bookId, attempt])

  const changeStatus = async (status: Book["status"]) => {
    if (!book || pending) return
    setPending("status"); setMessage(""); setError("")
    try {
      setBook(unwrapAction(await updateBookStatusAction(book.id, status, book.version)))
      setMessage("Estado de lectura actualizado.")
    } finally { setPending(null) }
  }

  const changeShelf = async () => {
    if (!book || pending || targetShelf === book.shelf_id) return
    setPending("shelf"); setMessage(""); setError("")
    try {
      setBook(unwrapAction(await moveBookShelfAction(book.id, targetShelf, book.version)))
      setMessage("Ubicación actualizada.")
    } catch (caught) { setError(caught instanceof DomainError ? caught.message : "No se pudo mover el libro. Comprueba la conexión e inténtalo de nuevo.") }
    finally { setPending(null) }
  }

  const refreshCover = async () => {
    if (!book || pending) return
    setPending("cover"); setMessage(""); setError("")
    try { setBook(unwrapAction(await refreshBookCoverAction(book.id, book.version))); setMessage("Portada actualizada desde Open Library.") }
    catch (caught) { setError(caught instanceof DomainError ? caught.message : "No se pudo recuperar una portada. Puedes indicar su URL al editar la ficha.") }
    finally { setPending(null) }
  }

  const deleteBook = async () => {
    if (!book || pending) return
    setPending("delete"); setMessage(""); setError("")
    try { unwrapAction(await deleteBookAction(book.id, book.version)); setDeleteOpen(false); router.replace(backHref.split("#")[0]); router.refresh() }
    catch (caught) { setError(caught instanceof DomainError ? caught.message : "No se pudo eliminar el libro. Comprueba la conexión e inténtalo de nuevo.") }
    finally { setPending(null) }
  }

  return <div className="mx-auto max-w-5xl">
      <Button asChild variant="outline" className="mb-6"><Link href={backHref}><ArrowLeft aria-hidden="true" className="w-4 h-4 mr-2" />Volver a libros</Link></Button>
      {loading ? <p role="status">Cargando detalles del libro...</p> : loadError ? <div className="space-y-4"><p role="alert" className="text-destructive">{loadError}</p><Button variant="outline" onClick={() => setAttempt((current) => current + 1)}>Reintentar</Button></div> : !book ? <div className="space-y-3"><h1 className="text-2xl font-bold">Libro no encontrado</h1><p className="text-muted-foreground">Este libro ya no está disponible en tu biblioteca.</p></div> : editing ? (
        <section className="max-w-2xl mx-auto rounded-2xl border border-border bg-card/80 p-5 sm:p-8 shadow-xl"><h1 className="text-3xl font-bold mb-6">{editing === "edition" ? "Editar la edición" : "Editar ficha"}</h1>{editing === "edition" ? <BookForm key={book.version} scope="edition" initialBook={book} shelves={shelves} submitLabel="Guardar la edición" onCancel={() => setEditing(false)} onReload={async () => {
          const latest = await getBookDetailAction(book.id)
          if (!latest) { setEditing(false); setBook(null); return }
          setBook(latest)
        }} onSubmit={async (input) => {
          // Contrato de edición (U-DAT-06): versión de la edición y confirmación de cuántos ejemplares cambian.
          const result = unwrapAction(await updateEditionAction({ ...input, editionId: book.edition!.id, expectedVersion: book.edition!.version, confirmCopies: input.confirmSharedCopies }))
          const latest = await getBookDetailAction(book.id)
          if (latest) setBook(latest)
          setEditing(false); setError(""); setMessage(result.copies > 1 ? `Edición actualizada en sus ${result.copies} ejemplares.` : "Edición actualizada.")
          router.refresh()
        }} /> : <BookForm key={book.version} initialBook={book} onReload={async () => {
          const latest = await getBookDetailAction(book.id)
          if (!latest) { setEditing(false); setBook(null); return }
          setBook(latest); setTargetShelf(latest.shelf_id)
        }} shelves={shelves} submitLabel="Guardar cambios" onCancel={() => setEditing(false)} onSubmit={async (input) => {
          const updated = unwrapAction(await updateBookAction(book.id, input))
          setBook(updated); setTargetShelf(updated.shelf_id); setEditing(false); setError(""); setMessage("Ficha actualizada correctamente.")
          router.refresh()
        }} />}</section>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-[240px_minmax(0,1fr)] gap-6 md:gap-8">
          <aside className="space-y-4">
            <BookCover cover={displayCover(book)} title={book.title} priority className="w-48 md:w-full mx-auto shadow-xl" sizes="(max-width: 768px) 192px, 240px" />
            <Button type="button" variant="outline" className="w-full" disabled={Boolean(pending) || !normalizeIsbn(book.isbn ?? "")} onClick={() => void refreshCover()}>{pending === "cover" ? <Loader2 aria-hidden="true" className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw aria-hidden="true" className="h-4 w-4 mr-2" />}{pending === "cover" ? "Buscando portada..." : "Buscar portada"}</Button>
            <p className="text-xs text-muted-foreground">{normalizeIsbn(book.isbn ?? "") ? (book.edition?.copies ?? 1) > 1 ? `Busca y sustituye la portada de la edición, común a sus ${book.edition!.copies} ejemplares.` : "Busca y sustituye la portada con la disponible en Open Library." : "Añade un ISBN válido al editar la ficha para buscar su portada."}</p>
            <BookCoverAssets book={book} disabled={Boolean(pending)} onBookChange={(updated) => { setBook(updated); setTargetShelf(updated.shelf_id); setError("") }} />
          </aside>
          <div className="space-y-5 min-w-0">
            <div className="flex flex-col sm:flex-row items-start justify-between gap-4"><div className="min-w-0"><h1 className="text-3xl sm:text-4xl font-bold heading-vintage break-words">{book.title}</h1>{book.subtitle && <p className="text-lg text-muted-foreground mt-2">{book.subtitle}</p>}</div><div className="flex flex-wrap gap-2"><Button ref={editButton} variant="outline" disabled={Boolean(pending)} onClick={() => { setEditing("copy"); setError(""); setMessage("") }}><Edit2 aria-hidden="true" className="w-4 h-4 mr-2" />Editar ficha</Button>{(book.edition?.copies ?? 1) > 1 && <Button variant="outline" disabled={Boolean(pending)} onClick={() => { setEditing("edition"); setError(""); setMessage("") }}>Editar la edición ({book.edition!.copies} ejemplares)</Button>}</div></div>
            {message && <p role="status" className="rounded-xl border border-border bg-muted/40 p-3 text-sm">{message}</p>}
            {error && !deleteOpen && <div role="alert" className="rounded-xl border border-destructive/30 p-3 text-sm text-destructive space-y-2"><p>{error}</p><Button variant="outline" onClick={() => { setError(""); setAttempt((current) => current + 1) }}>Recargar ficha</Button></div>}
            <dl className="rounded-2xl border border-border bg-card/80 p-5 shadow-lg grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2"><dt className="text-sm text-muted-foreground font-semibold">Autores</dt><dd className="mt-1">{book.authors.length ? book.authors.map((author) => author.name).join("; ") : "Desconocidos"}</dd></div>
              <div><dt className="text-sm text-muted-foreground font-semibold">Editoriales</dt><dd className="mt-1">{book.publishers?.length ? book.publishers.map((publisher) => publisher.name).join("; ") : "Desconocidas"}</dd></div>
              <div><dt className="text-sm text-muted-foreground font-semibold">Publicación</dt><dd className="mt-1">{book.publish_date || "Desconocida"}</dd></div>
              <div><dt className="text-sm text-muted-foreground font-semibold">Páginas</dt><dd className="mt-1">{book.number_of_pages || "Desconocidas"}</dd></div>
              <div><dt className="text-sm text-muted-foreground font-semibold">ISBN</dt><dd className="mt-1 font-mono text-sm break-all">{bookIdentifierLabel(book)}</dd></div>
              <div className="sm:col-span-2"><dt className="text-sm text-muted-foreground font-semibold">Procedencia y edición</dt><dd className="mt-1"><CatalogueProvenanceDetails book={book} /></dd></div>
            </dl>
            <section className="rounded-2xl border border-border bg-card/80 p-5 shadow-lg"><BookStatusForm currentStatus={book.status} onStatusChange={changeStatus} disabled={Boolean(pending)} /></section>
            <section className="rounded-2xl border border-border bg-card/80 p-5 shadow-lg space-y-3"><label htmlFor="book-shelf" className="text-sm font-semibold">Estantería</label><div className="flex flex-col sm:flex-row gap-3"><select id="book-shelf" value={targetShelf} disabled={Boolean(pending)} onChange={(event) => setTargetShelf(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-input bg-background p-2 text-foreground">{shelves.map((shelf) => <option key={shelf.id} value={shelf.id}>{shelf.title}{shelf.isDefault ? " (predeterminada)" : ""}</option>)}</select><Button type="button" disabled={Boolean(pending) || targetShelf === book.shelf_id} onClick={() => void changeShelf()}>{pending === "shelf" ? "Moviendo..." : "Mover libro"}</Button></div></section>
            <EditionConflictPanel book={book} onMerged={async () => { const latest = await getBookDetailAction(book.id); if (latest) setBook(latest); setMessage("Ediciones unidas: este ejemplar usa ahora los datos de la otra edición.") }} />
            <EditionCopiesPanel key={book.copyVersion} book={book} shelves={shelves} />
            {book.edition && <EditionSeriesPanel key={book.edition.id} editionId={book.edition.id} />}
            <BookPersonalPanel book={book} onChange={setBook} />
            <AlertDialog open={deleteOpen} onOpenChange={(open) => { if (pending !== "delete") { setDeleteOpen(open); setError("") } }}>
              <AlertDialogTrigger asChild><Button variant="outline" disabled={Boolean(pending)} className="text-destructive border-destructive/40"><Trash2 aria-hidden="true" className="w-4 h-4 mr-2" />Eliminar libro</Button></AlertDialogTrigger>
              <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>¿Eliminar este libro?</AlertDialogTitle><AlertDialogDescription>{(book.edition?.copies ?? 1) > 1 ? `Se eliminará este ejemplar de «${book.title}». La edición y sus otros ${book.edition!.copies! - 1} ejemplares se conservan.` : `Se eliminará «${book.title}» de tu biblioteca.`} Esta acción no se puede deshacer.</AlertDialogDescription></AlertDialogHeader>
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                <AlertDialogFooter><AlertDialogCancel disabled={pending === "delete"}>Cancelar</AlertDialogCancel><AlertDialogAction disabled={pending === "delete"} onClick={(event) => { event.preventDefault(); void deleteBook() }} className="bg-destructive text-destructive-foreground">{pending === "delete" ? "Eliminando..." : "Eliminar libro"}</AlertDialogAction></AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      )}
  </div>
}
