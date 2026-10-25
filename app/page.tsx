"use client"

import { Header } from "@/components/header"
import { Button } from "@/components/ui/button"
import { LoadingState } from "@/components/loading-state"
import { BookCover } from "@/components/book-cover"
import { BookStatusBadge } from "@/components/book-status-badge"
import Link from "next/link"
import { useCallback, useEffect, useState, type ReactNode } from "react"
import { getLibrarySummaryAction } from "@/app/actions/library"
import { getShelvesAction } from "@/app/actions/shelves"
import { displayCover } from "@/lib/book-covers"
import type { Book, Shelf } from "@/lib/types"
import { ArrowRight, ClipboardCheck, Plus } from "lucide-react"

type Summary = Awaited<ReturnType<typeof getLibrarySummaryAction>>

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
const authorsOf = (book: Book) => book.authors.map((author) => author.name).join(", ") || "Autor desconocido"

/** Titular del inicio a partir de los recuentos reales; nunca inventa cifras. */
function heroTitle(total: number, reading: number): string {
  if (total === 0) return "Tu biblioteca empieza aquí."
  if (reading === 0) return `${plural(total, "libro", "libros")} esperando su turno.`
  return `${plural(total, "libro", "libros")} y ${reading === 1 ? "una lectura" : `${reading} lecturas`} a medias.`
}

// Lomos decorativos de cada estantería: colores de encuadernación y alturas deterministas a partir del ID.
// No representan libros concretos; solo cuántos hay (hasta 18) para dar idea de lo llena que está.
const SPINES = ["#7a1f24", "#1f3a5f", "#2f4a2c", "#5b3a29", "#c9b48a", "#3b2a4a", "#a0522d", "#22303a", "#8a6d2f", "#e8dcc4", "#0f3d3e", "#6d1a36"]
function spines(id: string, count: number) {
  const seed = [...id].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 9973, 7)
  return Array.from({ length: Math.min(count, 18) }, (_, index) => ({
    width: 10 + ((seed + index * 7) % 9),
    height: 58 + ((seed * 3 + index * 13) % 30),
    color: SPINES[(seed + index * 5) % SPINES.length],
  }))
}

function StatCard({ value, label, tone }: { value: number; label: string; tone?: string }) {
  return (
    <div className="surface-card flex flex-col gap-1 p-4">
      <span className={`font-heading text-3xl font-bold leading-none ${tone ?? "text-heading"}`}>{value}</span>
      <span className="text-sm text-muted-foreground">{label}</span>
    </div>
  )
}

function SectionTitle({ id, title, action }: { id: string; title: string; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h2 id={id} className="heading-vintage text-2xl md:text-[1.75rem]">{title}</h2>
      {action}
    </div>
  )
}

export default function Dashboard() {
  const [data, setData] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [shelves, setShelves] = useState<Shelf[] | null>(null)
  const [shelvesError, setShelvesError] = useState(false)

  const loadData = useCallback(() => getLibrarySummaryAction().then((loaded) => {
      setData(loaded)
      setLoadError(false)
    }).catch((error: unknown) => {
      console.error("Error loading library data:", error)
      setLoadError(true)
    }).finally(() => {
      setLoading(false)
    }), [])

  useEffect(() => { void loadData() }, [loadData])
  useEffect(() => {
    void getShelvesAction().then((loaded) => { setShelves(loaded); setShelvesError(false) }).catch((error: unknown) => {
      console.error("Error loading shelves for dashboard:", error)
      setShelvesError(true)
    })
  }, [])

  if (loading && !data) {
    return (
      <div className="min-h-screen">
        <Header />
        <LoadingState message="Preparando tu biblioteca..." />
      </div>
    )
  }

  const totalBooks = data?.totalBooks ?? 0
  const booksRead = data?.read ?? 0
  const booksReading = data?.reading ?? 0
  const booksToRead = data?.toRead ?? 0
  const reading = data?.currentlyReading ?? []
  const recent = data?.recent ?? []
  const visibleShelves = (shelves ?? []).filter((shelf) => shelf.book_count > 0 || !shelf.isDefault).slice(0, 6)

  return (
    <div className="min-h-screen">
      <Header />

      <main id="main-content" tabIndex={-1} className="mx-auto flex max-w-7xl flex-col gap-12 px-4 pt-8 pb-16 outline-none md:px-6 md:pt-12 lg:px-8">
        {loadError ? (
          <div role="alert" className="surface-card mx-auto max-w-xl p-8 text-center">
            <h1 className="heading-vintage mb-2 text-3xl">No se pudo cargar tu biblioteca</h1>
            <p className="mb-5 text-foreground-light">Inténtalo de nuevo para consultar tus libros y estanterías.</p>
            <Button onClick={() => void loadData()} disabled={loading}>{loading ? "Cargando…" : "Reintentar"}</Button>
          </div>
        ) : data ? <>
        <section aria-labelledby="inicio-titulo" className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex max-w-2xl flex-col gap-3">
            <p className="eyebrow">Tu biblioteca</p>
            <h1 id="inicio-titulo" className="heading-vintage text-4xl leading-[1.04] sm:text-5xl lg:text-[3.5rem]">{heroTitle(totalBooks, booksReading)}</h1>
            <p className="text-lg leading-relaxed text-foreground-light">
              {reading[0] ? <>Retoma «{reading[0].title}» donde la dejaste o recorre tus estanterías.</> : "Continúa tus lecturas y encuentra tu próximo libro."}
            </p>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:gap-3">
              <Button asChild size="lg"><Link href="/books/add"><Plus aria-hidden="true" />Agregar libro</Link></Button>
              <Button asChild size="lg" variant="outline"><Link href="/books">Ver biblioteca</Link></Button>
            </div>
          </div>
          <div className="grid w-full grid-cols-2 gap-3 sm:grid-cols-4 lg:max-w-[38rem]">
            <StatCard value={totalBooks} label={totalBooks === 1 ? "Libro" : "Libros"} />
            <StatCard value={booksReading} label="Leyendo" tone="text-[var(--status-reading)]" />
            <StatCard value={booksToRead} label="Por leer" tone="text-[var(--status-to-read)]" />
            <StatCard value={booksRead} label={booksRead === 1 ? "Leído" : "Leídos"} tone="text-[var(--status-read)]" />
            {/* Hueco para «Prestados» (préstamos, O14): no se muestra hasta que existan datos reales. */}
          </div>
        </section>

        {reading.length > 0 && (
          <section aria-labelledby="seguir-leyendo" className="flex flex-col gap-4">
            <SectionTitle id="seguir-leyendo" title="Seguir leyendo" action={<Link href="/books?status=reading" className="link-quiet inline-flex min-h-11 items-center">Ver todo</Link>} />
            <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {reading.slice(0, 3).map((book) => (
                <li key={book.id}>
                  <Link href={`/book/${book.id}`} className="surface-card group flex h-full gap-4 p-4 transition-[transform,box-shadow] duration-300 hover:shadow-xl motion-safe:hover:-translate-y-0.5">
                    <BookCover cover={displayCover(book)} title={book.title} sizes="92px" className="w-[5.75rem] shrink-0 rounded-[4px_8px_8px_4px] border-0 shadow-[0_14px_24px_-8px_rgb(0_0_0/0.45)]" />
                    <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <span className="font-heading text-xl leading-tight font-bold text-heading group-hover:underline group-hover:decoration-brass group-hover:underline-offset-4">{book.title}</span>
                      <span className="text-sm text-muted-foreground">{authorsOf(book)}</span>
                      <span className="mt-auto flex flex-wrap items-center gap-2 pt-2 text-xs text-muted-foreground"><BookStatusBadge status={book.status} />{book.shelf_name}</span>
                      {/* Hueco para el progreso de lectura (páginas leídas, O14): sin barra ni cifras hasta tener datos. */}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-labelledby="estanterias-inicio" className="flex flex-col gap-4">
          <SectionTitle id="estanterias-inicio" title="Estanterías" action={<span className="flex flex-wrap gap-x-5"><Link href="/shelves/3d" className="link-quiet inline-flex min-h-11 items-center">Abrir en 3D</Link><Link href="/shelves" className="link-quiet inline-flex min-h-11 items-center">Gestionar estanterías</Link></span>} />
          {shelvesError ? <p className="surface-card p-5 text-foreground-light">No se pudieron cargar las estanterías. <Link href="/shelves" className="link-quiet">Ábrelas desde Estanterías</Link>.</p>
            : shelves === null ? <p className="text-sm text-muted-foreground">Cargando estanterías…</p>
            : visibleShelves.length === 0 ? <p className="surface-card p-5 text-foreground-light">Aún no tienes estanterías con libros. <Link href="/shelves" className="link-quiet">Crea tu primera estantería</Link>.</p>
            : <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {visibleShelves.map((shelf) => (
                <li key={shelf.id}>
                  <Link href={`/books?shelf=${shelf.id}`} className="surface-card group flex h-full flex-col gap-3.5 p-4 transition-[transform,box-shadow] duration-300 hover:shadow-xl motion-safe:hover:-translate-y-0.5">
                    <span aria-hidden="true" className="shelf-preview">
                      {spines(shelf.id, shelf.book_count).map((spine, index) => <span key={index} style={{ width: spine.width, height: spine.height, backgroundColor: spine.color }} />)}
                    </span>
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="font-heading text-xl font-bold text-heading group-hover:underline group-hover:decoration-brass group-hover:underline-offset-4">{shelf.title}</span>
                      <span className="shrink-0 text-sm text-muted-foreground">{plural(shelf.book_count, "libro", "libros")}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>}
        </section>

        {recent.length > 0 && (
          <section aria-labelledby="ultimas" className="flex flex-col gap-4">
            <SectionTitle id="ultimas" title="Últimas incorporaciones" />
            <ul className="surface-card divide-y divide-border overflow-hidden p-0">
              {recent.map((book) => (
                <li key={book.id}>
                  <Link href={`/book/${book.id}`} className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-accent/50">
                    <BookCover cover={displayCover(book)} title={book.title} size="small" sizes="40px" className="w-10 shrink-0 rounded-md" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="font-semibold text-foreground">{book.title}</span>
                      <span className="text-sm text-muted-foreground">{authorsOf(book)} · {book.shelf_name}</span>
                    </span>
                    <span className="hidden sm:block"><BookStatusBadge status={book.status} /></span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-labelledby="revision-inicio" className="surface-card flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <span aria-hidden="true" className="flex size-11 shrink-0 items-center justify-center rounded-full bg-accent text-brass-text"><ClipboardCheck className="size-5" /></span>
            <div className="flex flex-col gap-1">
              <h2 id="revision-inicio" className="heading-vintage text-xl">Revisión de fichas</h2>
              <p className="text-foreground-light">Comprueba fichas sin ISBN, sin portada o posibles duplicados en la bandeja.</p>
            </div>
          </div>
          <Button asChild variant="secondary"><Link href="/books/review">Abrir la bandeja<ArrowRight aria-hidden="true" /></Link></Button>
        </section>
        </> : null}
      </main>
    </div>
  )
}
