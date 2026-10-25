"use client"

import { useId, useRef, useState, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { BookCover } from "@/components/book-cover"
import { parseBookInput, type BookInput } from "@/lib/book-validation"
import { DEFAULT_BOOK_COVER } from "@/lib/book-covers"
import type { Author, Book, Publisher, Shelf } from "@/lib/types"
import { Loader2, Plus, X } from "lucide-react"
import { normalizeIsbn } from "@/lib/isbn"
import { DomainError } from "@/lib/domain-errors"
import { SubmissionGate, type BookEntryDefaults } from "@/lib/book-entry"
import { PersonalFields } from "@/components/personal-fields"
import type { PersonalInput } from "@/lib/personal-validation"

interface BookFormProps {
  initialBook?: Book
  initialIsbn?: string
  shelves: Shelf[]
  onSubmit: (input: BookInput) => Promise<void>
  onSaveAndAddAnother?: (input: BookInput) => Promise<void>
  entryDefaults?: BookEntryDefaults
  onCancel?: () => void
  onReload?: () => Promise<void>
  submitLabel?: string
  /** `edition`: solo los datos bibliográficos de la edición (U-DAT-06); estado, estantería y comprobación son del ejemplar. */
  scope?: "copy" | "edition"
}

const selectClass = "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-ring"

export function BookForm({ initialBook, initialIsbn = "", shelves, onSubmit, onSaveAndAddAnother, entryDefaults, onCancel, onReload, submitLabel = "Agregar a la biblioteca", scope = "copy" }: BookFormProps) {
  const id = useId()
  const initialCover = initialBook?.cover.large || DEFAULT_BOOK_COVER
  // Una clave por formulario: reintentar el mismo envío no crea dos ediciones (U-DAT-06).
  const idempotencyKey = useRef(crypto.randomUUID())
  const gate = useRef(new SubmissionGate())
  const sharedCopies = initialBook?.version ? initialBook.edition?.copies ?? 1 : 1
  const [confirmShared, setConfirmShared] = useState(false)
  const [personal, setPersonal] = useState<PersonalInput>({})
  const [fields, setFields] = useState({
    title: initialBook?.title ?? "", subtitle: initialBook?.subtitle ?? "",
    // Un libro sin ISBN se guarda sin ISBN: nunca se le inventa un identificador.
    isbn: initialBook ? initialBook.isbn ?? "" : initialIsbn,
    publish_date: initialBook?.publish_date ?? "", pages: initialBook?.number_of_pages ? String(initialBook.number_of_pages) : "",
    coverUrl: initialCover === DEFAULT_BOOK_COVER ? "" : initialCover,
    status: entryDefaults?.status ?? initialBook?.status ?? "unread" as Book["status"],
    shelf_id: entryDefaults && shelves.some((shelf) => shelf.id === entryDefaults.shelf_id) ? entryDefaults.shelf_id
      : shelves.some((shelf) => shelf.id === initialBook?.shelf_id)
        ? initialBook!.shelf_id : shelves.find((shelf) => shelf.isDefault)?.id ?? shelves[0]?.id ?? "",
  })
  const [authors, setAuthors] = useState<Author[]>(initialBook?.authors.length ? initialBook.authors.map((author) => ({ ...author })) : [{ name: "" }])
  const [publishers, setPublishers] = useState<Publisher[]>(initialBook?.publishers?.length ? initialBook.publishers.map((publisher) => ({ ...publisher })) : [{ name: "" }])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const [conflict, setConflict] = useState(false)
  const [isbnVerified, setIsbnVerified] = useState(initialBook?.catalogue?.isbnVerified ?? false)
  const update = <K extends keyof typeof fields>(key: K, value: typeof fields[K]) => {
    setFields((current) => ({ ...current, [key]: value }))
    if (key === "isbn") setIsbnVerified(false)
    setError("")
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!gate.current.enter()) return
    setPending(true)
    setError("")
    try {
      const coverUrl = fields.coverUrl.trim() || DEFAULT_BOOK_COVER
      const input = parseBookInput({
        version: initialBook?.version, copyVersion: initialBook?.copyVersion, editionVersion: initialBook?.edition?.version,
        ...(initialBook?.version ? (sharedCopies > 1 && confirmShared ? { confirmSharedCopies: sharedCopies } : {}) : { idempotencyKey: idempotencyKey.current }),
        title: fields.title, subtitle: fields.subtitle,
        isbn: fields.isbn.trim() || null,
        authors: authors.filter((author) => author.name.trim()), publishers: publishers.filter((publisher) => publisher.name.trim()),
        number_of_pages: fields.pages === "" ? 0 : Number(fields.pages), publish_date: fields.publish_date,
        cover: initialBook && coverUrl === initialCover ? initialBook.cover : { small: coverUrl, medium: coverUrl, large: coverUrl },
        status: fields.status, shelf_id: fields.shelf_id,
        // Se envía la procedencia tal como se cargó (v1 o v2); al editar, el servidor la recalcula desde la ficha guardada.
        catalogue: { ...(initialBook?.catalogue ?? { source: "manual" as const }), isbnVerified: Boolean(normalizeIsbn(fields.isbn)) && isbnVerified },
        ...(!initialBook?.version && scope === "copy" ? { personal } : {}),
      })
      const another = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "another"
      await (another && onSaveAndAddAnother ? onSaveAndAddAnother(input) : onSubmit(input))
    } catch (caught) {
      setConflict(caught instanceof DomainError && caught.code === "CONFLICT")
      setError(caught instanceof DomainError ? caught.message : "No se pudo guardar el libro. Comprueba la conexión y vuelve a intentarlo.")
    } finally { gate.current.leave(); setPending(false) }
  }

  return (
    <form onSubmit={handleSubmit} aria-busy={pending} className="space-y-5">
      {initialBook?.version && initialBook.catalogue?.schemaVersion === 2 && initialBook.catalogue.fields && <p className="rounded-xl border border-border bg-muted/40 p-3 text-sm">Esta ficha registra la fuente de cada campo. Si cambias un campo, pasará a constar como escrito por ti; los demás conservan su fuente.</p>}
      {sharedCopies > 1 && <div className="rounded-xl border border-border bg-muted/40 p-3 text-sm space-y-2"><p>Título, autoría, editoriales, fecha, páginas, ISBN y portada son de la edición, que comparten {sharedCopies} ejemplares de tu biblioteca: si los cambias, cambiarán en todos. El estado y la estantería son solo de este ejemplar.</p>
        <div className="flex items-start gap-2"><input id={`${id}-shared`} type="checkbox" checked={confirmShared} onChange={(event) => setConfirmShared(event.target.checked)} className="mt-1 h-4 w-4 accent-primary" /><Label htmlFor={`${id}-shared`} className="leading-6">Aplicar los cambios bibliográficos a los {sharedCopies} ejemplares</Label></div></div>}
      {initialBook?.legacyIdentifier && !initialBook.legacyIdentifier.startsWith("manual-") && <p className="rounded-xl border border-border bg-muted/40 p-3 text-sm">Identificador anterior de este ejemplar: <span className="font-mono">{initialBook.legacyIdentifier}</span>. No es un ISBN que BibLib pueda usar; escribe el ISBN correcto si lo conoces.</p>}
      <fieldset disabled={pending} className="space-y-5 min-w-0">
        <div className="space-y-2"><Label htmlFor={`${id}-title`}>Título <span aria-hidden="true">*</span></Label><Input id={`${id}-title`} required maxLength={500} value={fields.title} onChange={(event) => update("title", event.target.value)} /></div>
        <div className="space-y-2"><Label htmlFor={`${id}-subtitle`}>Subtítulo</Label><Input id={`${id}-subtitle`} maxLength={1000} value={fields.subtitle} onChange={(event) => update("subtitle", event.target.value)} /></div>
        <fieldset className="space-y-2 min-w-0"><legend className="text-sm font-medium mb-2">Autores</legend>
          {authors.map((author, index) => <div key={index} className="flex gap-2"><Label className="sr-only" htmlFor={`${id}-author-${index}`}>Autor {index + 1}</Label><Input id={`${id}-author-${index}`} maxLength={200} value={author.name} onChange={(event) => setAuthors((current) => current.map((entry, position) => position === index ? { ...entry, name: event.target.value } : entry))} placeholder="Nombre completo del autor" /><Button type="button" variant="outline" size="icon" aria-label={`Eliminar autor ${index + 1}`} onClick={() => setAuthors((current) => current.filter((_, position) => position !== index))}><X aria-hidden="true" className="h-4 w-4" /></Button></div>)}
          <Button type="button" variant="outline" size="sm" disabled={authors.length >= 30} onClick={() => setAuthors((current) => [...current, { name: "" }])}><Plus aria-hidden="true" className="h-4 w-4 mr-2" />Añadir autor</Button>
          <p className="text-xs text-muted-foreground">Un autor por fila. Puedes dejarlo vacío si no lo conoces.</p>
        </fieldset>
        <fieldset className="space-y-2 min-w-0"><legend className="text-sm font-medium mb-2">Editoriales</legend>
          {publishers.map((publisher, index) => <div key={index} className="flex gap-2"><Label className="sr-only" htmlFor={`${id}-publisher-${index}`}>Editorial {index + 1}</Label><Input id={`${id}-publisher-${index}`} maxLength={200} value={publisher.name} onChange={(event) => setPublishers((current) => current.map((entry, position) => position === index ? { name: event.target.value } : entry))} /><Button type="button" variant="outline" size="icon" aria-label={`Eliminar editorial ${index + 1}`} onClick={() => setPublishers((current) => current.filter((_, position) => position !== index))}><X aria-hidden="true" className="h-4 w-4" /></Button></div>)}
          <Button type="button" variant="outline" size="sm" disabled={publishers.length >= 20} onClick={() => setPublishers((current) => [...current, { name: "" }])}><Plus aria-hidden="true" className="h-4 w-4 mr-2" />Añadir editorial</Button>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2"><Label htmlFor={`${id}-date`}>Publicación</Label><Input id={`${id}-date`} maxLength={100} value={fields.publish_date} onChange={(event) => update("publish_date", event.target.value)} placeholder="Por ejemplo: 1997" /></div>
          <div className="space-y-2"><Label htmlFor={`${id}-pages`}>Número de páginas</Label><Input id={`${id}-pages`} type="number" min={0} max={100000} step={1} value={fields.pages} onChange={(event) => update("pages", event.target.value)} placeholder="Desconocido" /></div>
        </div>
        <div className="space-y-3"><div className="space-y-2"><Label htmlFor={`${id}-isbn`}>ISBN</Label><Input id={`${id}-isbn`} maxLength={100} value={fields.isbn} onChange={(event) => update("isbn", event.target.value)} aria-describedby={`${id}-isbn-help`} /><p id={`${id}-isbn-help`} className="text-xs text-muted-foreground">ISBN de 10 o 13 dígitos, con o sin guiones. Déjalo vacío si el ejemplar no tiene ISBN.</p></div>
          {scope === "copy" && <><div className="flex items-start gap-2"><input id={`${id}-verified`} type="checkbox" checked={isbnVerified && Boolean(normalizeIsbn(fields.isbn))} disabled={!normalizeIsbn(fields.isbn)} onChange={(event) => setIsbnVerified(event.target.checked)} className="mt-1 h-4 w-4 accent-primary" aria-describedby={`${id}-verified-help`} /><Label htmlFor={`${id}-verified`} className="leading-6">He comprobado que el ISBN corresponde a mi edición</Label></div><p id={`${id}-verified-help`} className="text-xs text-muted-foreground">Una portada encontrada no confirma la edición. Comprueba el ISBN en tu ejemplar.</p></>}
        </div>
        {scope === "copy" && <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2"><Label htmlFor={`${id}-status`}>Estado de lectura</Label><select id={`${id}-status`} className={selectClass} value={fields.status} onChange={(event) => update("status", event.target.value as Book["status"])}><option value="unread">Sin leer</option><option value="reading">Leyendo</option><option value="read">Leído</option><option value="to-read">Por leer</option></select></div>
          <div className="space-y-2"><Label htmlFor={`${id}-shelf`}>Estantería</Label><select id={`${id}-shelf`} className={selectClass} value={fields.shelf_id} onChange={(event) => update("shelf_id", event.target.value)}>{shelves.length === 0 && <option value="">Predeterminada</option>}{shelves.map((shelf) => <option key={shelf.id} value={shelf.id}>{shelf.title}{shelf.isDefault ? " (predeterminada)" : ""}</option>)}</select></div>
        </div>}
        <div className="space-y-2"><Label htmlFor={`${id}-cover`}>URL de la portada</Label><Input id={`${id}-cover`} type="url" maxLength={2048} value={fields.coverUrl} onChange={(event) => update("coverUrl", event.target.value)} placeholder="https://…" aria-describedby={`${id}-cover-help`} /><p id={`${id}-cover-help`} className="text-xs text-muted-foreground">Usa una dirección HTTPS o déjalo vacío para usar la portada predeterminada.</p><BookCover cover={{ large: fields.coverUrl }} title={fields.title || "libro"} className="w-24" sizes="96px" /></div>
        {!initialBook?.version && scope === "copy" && <PersonalFields value={personal} onChange={setPersonal} />}
      </fieldset>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {conflict && onReload && <div className="space-y-2 rounded-xl border border-border bg-muted/40 p-3 text-sm"><p>El formulario conserva lo que has escrito. Copia los cambios que quieras mantener antes de cargar la ficha guardada.</p><Button type="button" variant="outline" disabled={pending} onClick={async () => {
        setPending(true)
        try { await onReload() } catch { setError("No se pudo cargar la ficha actual. Tu formulario se conserva; vuelve a intentarlo.") }
        finally { setPending(false) }
      }}>Descartar formulario y cargar versión actual</Button></div>}
      <div className="flex flex-wrap gap-3"><Button type="submit" disabled={pending} className="bg-primary text-primary-foreground">{pending && <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" />}{pending ? "Guardando..." : submitLabel}</Button>{onSaveAndAddAnother && <Button type="submit" name="intent" value="another" variant="outline" disabled={pending}>Guardar y añadir otro</Button>}{onCancel && <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>Cancelar</Button>}</div>
    </form>
  )
}
