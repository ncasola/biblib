"use client"

import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from "react"
import Image from "next/image"
import Link from "next/link"
import { CloudOff, Lock, LoaderCircle, Search, Trash2, Wifi } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { BookStatusBadge } from "@/components/book-status-badge"
import { PageHeader } from "@/components/page-header"
import {
  browserOfflineLibrary, isOfflineCopyExpired, offlineDate, OfflineCopyError, readOfflineAccountPointer, OFFLINE_ACCOUNT_POINTER_KEY,
  type OfflineBook, type OfflineCopySession, type OfflineCopyStatus, type OfflineSnapshot,
} from "@/lib/offline-library"

// U-EXP-08 · Consulta sin conexión de la copia de lectura (contrato: docs/spec-pendientes/contratos-o15.md).
// Solo lectura: buscar y filtrar en memoria; no hay ningún control que guarde ni cambios pendientes.
// La vista solo abre la copia de la última cuenta que usó este dispositivo con conexión.

type View =
  | { state: "loading" }
  | { state: "disabled" }
  | { state: "unsupported" }
  | { state: "wiped" }
  | OfflineCopyStatus
  | { state: "open"; session: OfflineCopySession }

const PAGE_SIZE = 100

/** Estado de la copia de la última cuenta que usó este dispositivo con conexión. */
async function readCopyView(snapshotEnabled: boolean): Promise<{ accountId: string | null; view: View }> {
  if (!snapshotEnabled) return { accountId: null, view: { state: "disabled" } }
  const accountId = readOfflineAccountPointer()
  if (!accountId) return { accountId, view: { state: "none" } }
  try { return { accountId, view: await browserOfflineLibrary().status(accountId) } } catch (cause) {
    return { accountId, view: cause instanceof OfflineCopyError && cause.code === "UNSUPPORTED" ? { state: "unsupported" } : { state: "corrupt" } }
  }
}

function useOnline(): boolean {
  const [online, setOnline] = useState(true)
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    update()
    window.addEventListener("online", update)
    window.addEventListener("offline", update)
    return () => {
      window.removeEventListener("online", update)
      window.removeEventListener("offline", update)
    }
  }, [])
  return online
}

function locationPath(snapshot: OfflineSnapshot, locationId: string): string {
  const byId = new Map(snapshot.locations.map((location) => [location.id, location]))
  const names: string[] = []
  for (let current = byId.get(locationId); current && names.length < 8; current = current.parentId ? byId.get(current.parentId) : undefined) names.unshift(current.name)
  return names.join(" › ")
}

function OfflineBookItem({ book, snapshot, shelves, tags, series }: {
  book: OfflineBook
  snapshot: OfflineSnapshot
  shelves: Map<string, string>
  tags: Map<string, string>
  series: Map<string, string>
}) {
  const seriesTitle = book.series ? series.get(book.series.seriesId) : undefined
  return (
    <li className="rounded-xl border border-border bg-surface/50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-heading text-lg font-semibold leading-snug break-words">{book.title}</h3>
          {book.subtitle && <p className="text-sm text-foreground-light break-words">{book.subtitle}</p>}
          {book.authors.length > 0 && <p className="text-sm text-muted-foreground break-words">{book.authors.join(", ")}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <BookStatusBadge status={book.status} />
          {book.onLoan && <span data-status="loaned" className="status-chip">Prestado</span>}
        </div>
      </div>
      <dl className="mt-3 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex gap-1"><dt className="text-muted-foreground">Estantería:</dt><dd className="break-words">{shelves.get(book.shelfId) ?? "Sin estantería"}</dd></div>
        {book.location && <div className="flex gap-1"><dt className="text-muted-foreground">Ubicación:</dt><dd className="break-words">{locationPath(snapshot, book.location.locationId)}{book.location.shelfLabel ? ` · ${book.location.shelfLabel}` : ""}{book.location.position !== undefined ? ` · posición ${book.location.position}` : ""}</dd></div>}
        {seriesTitle && <div className="flex gap-1"><dt className="text-muted-foreground">Serie:</dt><dd className="break-words">{seriesTitle}{book.series?.position ? ` · n.º ${book.series.position}` : ""}{book.series?.volumeLabel ? ` (${book.series.volumeLabel})` : ""}</dd></div>}
        {book.isbn && <div className="flex gap-1"><dt className="text-muted-foreground">ISBN:</dt><dd>{book.isbn}</dd></div>}
        {book.tagIds.length > 0 && <div className="flex gap-1 sm:col-span-2"><dt className="text-muted-foreground">Etiquetas:</dt><dd className="break-words">{book.tagIds.map((id) => tags.get(id)).filter(Boolean).join(", ")}</dd></div>}
      </dl>
    </li>
  )
}

function OfflineCatalogue({ session }: { session: OfflineCopySession }) {
  const { snapshot } = session
  const ids = useId()
  const [query, setQuery] = useState("")
  const [shelf, setShelf] = useState("")
  const [limit, setLimit] = useState(PAGE_SIZE)
  const maps = useMemo(() => ({
    shelves: new Map(snapshot.shelves.map((entry) => [entry.id, entry.title])),
    tags: new Map(snapshot.tags.map((entry) => [entry.id, entry.name])),
    series: new Map(snapshot.series.map((entry) => [entry.id, entry.title])),
  }), [snapshot])
  const normalize = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  const results = useMemo(() => {
    const needle = normalize(query.trim())
    return snapshot.books.filter((book) => (!shelf || book.shelfId === shelf)
      && (!needle || normalize([book.title, book.subtitle ?? "", ...book.authors, book.isbn ?? ""].join(" ")).includes(needle)))
  }, [snapshot, query, shelf])

  return (
    <section aria-labelledby={`${ids}-titulo`} className="surface-card rounded-2xl p-5 md:p-8">
      <h2 id={`${ids}-titulo`} className="sr-only">Libros de la copia</h2>
      <div role="search" className="grid gap-4 sm:grid-cols-[1fr_minmax(0,16rem)]">
        <div className="space-y-2">
          <label htmlFor={`${ids}-buscar`} className="text-sm font-medium">Buscar en la copia</label>
          <div className="relative"><Search aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input id={`${ids}-buscar`} type="search" value={query} onChange={(event) => { setQuery(event.target.value); setLimit(PAGE_SIZE) }} placeholder="Título, autor o ISBN" autoComplete="off" className="pl-10" /></div>
        </div>
        <div className="space-y-2">
          <label htmlFor={`${ids}-estanteria`} className="text-sm font-medium">Estantería</label>
          <select id={`${ids}-estanteria`} value={shelf} onChange={(event) => { setShelf(event.target.value); setLimit(PAGE_SIZE) }} className="h-11 w-full rounded-md border border-control-border bg-input px-3 text-base md:text-sm">
            <option value="">Todas</option>
            {snapshot.shelves.map((entry) => <option key={entry.id} value={entry.id}>{entry.title}</option>)}
          </select>
        </div>
      </div>
      <p role="status" className="mt-4 text-sm text-muted-foreground">{results.length === 1 ? "1 libro" : `${results.length} libros`}{query || shelf ? " con estos filtros" : " en la copia"}</p>
      {results.length === 0
        ? <p className="mt-4 rounded-xl border border-dashed border-border bg-surface/50 p-6 text-center text-muted-foreground">No hay libros con estos filtros en la copia.</p>
        : <ul className="mt-4 space-y-3" aria-label="Libros de la copia">{results.slice(0, limit).map((book) => <OfflineBookItem key={book.id} book={book} snapshot={snapshot} {...maps} />)}</ul>}
      {results.length > limit && <Button type="button" variant="outline" className="mt-4" onClick={() => setLimit((current) => current + PAGE_SIZE)}>Mostrar {Math.min(PAGE_SIZE, results.length - limit)} más</Button>}
    </section>
  )
}

export function OfflineLibraryView({ snapshotEnabled }: { snapshotEnabled: boolean }) {
  const online = useOnline()
  const ids = useId()
  const [view, setView] = useState<View>({ state: "loading" })
  const [accountId, setAccountId] = useState<string | null>(null)
  const [secret, setSecret] = useState("")
  const [working, setWorking] = useState(false)
  const [error, setError] = useState("")

  const load = useCallback(() => readCopyView(snapshotEnabled).then((next) => {
    setAccountId(next.accountId)
    setView(next.view)
  }), [snapshotEnabled])

  useEffect(() => { void load() }, [load])

  const lock = useCallback(() => {
    setSecret("")
    setError("")
    void load()
  }, [load])

  // Cambio de cuenta en otra pestaña o caducidad con la copia abierta: la vista se bloquea.
  useEffect(() => {
    if (view.state !== "open") return
    const { session } = view
    const check = () => {
      if (readOfflineAccountPointer() !== session.accountId || isOfflineCopyExpired(session.validatedAt, new Date())) lock()
    }
    const onStorage = (event: StorageEvent) => { if (event.key === null || event.key === OFFLINE_ACCOUNT_POINTER_KEY) check() }
    const timer = window.setInterval(check, 30_000)
    window.addEventListener("storage", onStorage)
    window.addEventListener("focus", check)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener("storage", onStorage)
      window.removeEventListener("focus", check)
    }
  }, [view, lock])

  const unlock = async (event: FormEvent) => {
    event.preventDefault()
    if (!accountId || working) return
    setWorking(true)
    setError("")
    try {
      const session = await browserOfflineLibrary().unlock(accountId, secret)
      setSecret("")
      setView({ state: "open", session })
    } catch (cause) {
      setSecret("")
      if (cause instanceof OfflineCopyError && cause.code === "WIPED") setView({ state: "wiped" })
      else if (cause instanceof OfflineCopyError && cause.code === "CORRUPT") setView({ state: "corrupt" })
      else {
        setError(cause instanceof OfflineCopyError ? cause.message : "No se pudo abrir la copia. Vuelve a intentarlo.")
        await load()
      }
    } finally {
      setWorking(false)
    }
  }

  const removeCopy = async () => {
    if (!accountId || working) return
    setWorking(true)
    try { await browserOfflineLibrary().remove(accountId) } catch { /* Se vuelve a leer el estado debajo. */ }
    setWorking(false)
    await load()
  }

  const session = view.state === "open" ? view.session : null
  const summary = view.state === "locked" || view.state === "expired" ? view : session

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-background/80">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-6">
          <Link href="/" prefetch={false} className="flex min-h-11 items-center gap-2 rounded-xl font-heading text-xl font-semibold"><Image src="/logo-mark.png" alt="" width={36} height={36} className="size-9" />BibLib</Link>
          <p className="flex items-center gap-2 text-sm text-foreground-light" role="status">{online ? <Wifi aria-hidden="true" className="size-4" /> : <CloudOff aria-hidden="true" className="size-4" />}{online ? "Con conexión" : "Sin conexión"}</p>
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className="mx-auto max-w-5xl px-4 py-8 outline-none md:px-6 md:py-12">
        <PageHeader
          eyebrow="Consulta sin conexión"
          title={summary ? `Copia del ${offlineDate(summary.generatedAt)}` : "Sin conexión"}
          description={summary
            ? <>Cuenta <strong>{summary.maskedEmail}</strong> · solo lectura · {view.state === "expired" ? "caducó" : "caduca"} el {offlineDate(summary.expiresAt)}</>
            : "BibLib necesita conexión para mostrar y cambiar tu biblioteca."}
          actions={<>
            {session && <Button type="button" variant="outline" onClick={lock}><Lock aria-hidden="true" />Bloquear copia</Button>}
            {online && <Button asChild variant="secondary"><Link href="/" prefetch={false}>Volver a BibLib</Link></Button>}
          </>}
        />

        {view.state === "loading" && <p role="status" className="flex items-center gap-2"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Buscando la copia de este dispositivo…</p>}

        {(view.state === "disabled" || view.state === "none") && <div className="rounded-2xl border border-dashed border-border bg-surface/50 p-6 space-y-2">
          <p className="font-medium">No hay ninguna copia de lectura disponible en este dispositivo para la última cuenta que lo usó con conexión.</p>
          <p className="text-sm text-muted-foreground">{view.state === "disabled" ? "La copia de lectura sin conexión no está habilitada." : "Con conexión puedes guardarla desde Ajustes, en «Copia de lectura sin conexión»."} Cuando vuelvas a tener red podrás seguir donde lo dejaste.</p>
        </div>}

        {view.state === "unsupported" && <p className="text-destructive">Este navegador no permite abrir una copia cifrada (faltan IndexedDB o Web Crypto).</p>}

        {view.state === "wiped" && <div role="alert" className="rounded-2xl border border-destructive p-6"><p>Se ha borrado la copia de este dispositivo tras 10 intentos fallidos seguidos. Puedes volver a descargarla con conexión desde Ajustes.</p></div>}

        {view.state === "corrupt" && <div role="alert" className="rounded-2xl border border-destructive p-6 space-y-3">
          <p className="font-medium">La copia de este dispositivo está dañada o no se puede leer.</p>
          <p className="text-sm text-muted-foreground">Bórrala; con conexión podrás descargarla de nuevo desde Ajustes.</p>
          <Button type="button" variant="destructive" disabled={working} onClick={() => void removeCopy()}><Trash2 aria-hidden="true" />Borrar la copia dañada</Button>
        </div>}

        {view.state === "expired" && <div role="alert" className="surface-card rounded-2xl p-6 space-y-2">
          <p className="font-medium flex items-center gap-2"><Lock aria-hidden="true" className="size-5" />Copia bloqueada por caducidad</p>
          <p className="text-sm text-muted-foreground">Han pasado más de 7 días desde la última validación con conexión. Conéctate y entra en BibLib con esta cuenta para desbloquearla.</p>
        </div>}

        {view.state === "locked" && <form onSubmit={(event) => void unlock(event)} className="surface-card rounded-2xl p-5 md:p-8 space-y-4 max-w-xl">
          <h2 className="text-xl font-bold flex items-center gap-2"><Lock aria-hidden="true" className="size-5 text-brass-text" />Desbloquear la copia</h2>
          <div className="space-y-2"><label htmlFor={`${ids}-secreto`} className="text-sm font-medium">PIN o frase de la copia</label><Input id={`${ids}-secreto`} type="password" autoComplete="current-password" maxLength={128} value={secret} onChange={(event) => setSecret(event.target.value)} disabled={working} required aria-describedby={`${ids}-intentos`} /></div>
          <p id={`${ids}-intentos`} className="text-sm text-muted-foreground">Quedan {view.attemptsLeft} intentos antes de que se borre la copia de este dispositivo. Si olvidaste el PIN o la frase no se puede recuperar: bórrala y descárgala de nuevo con conexión.</p>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={working || !secret}>{working ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <Lock aria-hidden="true" />}{working ? "Abriendo…" : "Abrir copia"}</Button>
        </form>}

        {session && <div className="space-y-6">
          <p className="rounded-xl border border-border border-l-4 border-l-[var(--brass)] bg-surface/50 p-4 text-sm">Estás consultando una copia de solo lectura guardada en este dispositivo. Los cambios solo se hacen en BibLib con conexión.</p>
          <OfflineCatalogue session={session} />
        </div>}
      </main>
    </div>
  )
}
