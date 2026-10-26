"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { BookCover } from "@/components/book-cover"
import { ReadingCycleBadge, ReadingProgressView, ReadingTime } from "@/components/reading-progress"
import { getContinueReadingAction, getReadingStatsAction, type ContinueReadingItem } from "@/app/actions/reading"
import { displayCover } from "@/lib/book-covers"
import { cycleLabel, formatCivilDate, type ReadingStats } from "@/lib/reading"

// Inicio (U-PRO-02): «Seguir leyendo» con los ciclos abiertos reales y estadísticas que solo cuentan lo registrado, con
// su periodo y su denominador a la vista. Un libro marcado como leído sin lecturas registradas no recibe fecha: se
// menciona aparte. Los periodos y las fechas se calculan en la zona horaria del navegador de la persona.

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
const authorsOf = (item: ContinueReadingItem) => item.book.authors.map((author) => author.name).join(", ") || "Autor desconocido"

function SectionTitle({ id, title, aside }: { id: string; title: string; aside?: React.ReactNode }) {
  return <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
    <h2 id={id} className="heading-vintage text-2xl md:text-[1.75rem]">{title}</h2>
    {aside}
  </div>
}

/** Ciclos abiertos (leyendo y en pausa) con su progreso; la sección no aparece si no hay ninguno. */
export function ReadingContinueSection() {
  const [data, setData] = useState<{ items: ContinueReadingItem[]; open: number } | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let active = true
    getContinueReadingAction().then((result) => { if (active) { if (result.ok) setData(result.value); else setError(true) } }, () => { if (active) setError(true) })
    return () => { active = false }
  }, [])

  if (error) return <section aria-labelledby="seguir-leyendo" className="flex flex-col gap-4">
    <SectionTitle id="seguir-leyendo" title="Seguir leyendo" />
    <p className="surface-card p-5 text-foreground-light">No se pudieron cargar tus lecturas en curso. Recarga la página para intentarlo de nuevo.</p>
  </section>
  if (!data || data.items.length === 0) return null
  return <section aria-labelledby="seguir-leyendo" className="flex flex-col gap-4" data-testid="reading-continue">
    <SectionTitle id="seguir-leyendo" title="Seguir leyendo" aside={data.open > data.items.length
      ? <span className="text-sm text-muted-foreground">{`${data.items.length} de ${plural(data.open, "lectura en curso", "lecturas en curso")}`}</span> : undefined} />
    <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {data.items.map((item) => <li key={item.cycleId}>
        <Link href={`/book/${item.book.id}`} className="surface-card group flex h-full gap-4 p-4 transition-[transform,box-shadow] duration-300 hover:shadow-xl motion-safe:hover:-translate-y-0.5">
          <BookCover cover={displayCover(item.book)} title={item.book.title} sizes="92px" className="w-[5.75rem] shrink-0 rounded-[4px_8px_8px_4px] border-0 shadow-[0_14px_24px_-8px_rgb(0_0_0/0.45)]" />
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="font-heading text-xl leading-tight font-bold text-heading group-hover:underline group-hover:decoration-brass group-hover:underline-offset-4">{item.book.title}</span>
            <span className="text-sm text-muted-foreground">{authorsOf(item)}</span>
            <span className="flex flex-wrap items-center gap-2 pt-1 text-xs text-muted-foreground"><ReadingCycleBadge status={item.status} />{item.cycleNumber > 1 ? cycleLabel(item.cycleNumber) : null}</span>
            <span className="mt-auto flex flex-col gap-1 pt-2">
              <ReadingProgressView progress={item.progress} label={`Progreso de «${item.book.title}»`} />
              <span className="text-xs text-muted-foreground">{item.lastEntryAt ? <>Última sesión: <ReadingTime iso={item.lastEntryAt} /></> : "Sin sesiones registradas"}</span>
            </span>
          </span>
        </Link>
      </li>)}
    </ul>
  </section>
}

function Stat({ label, value, period, detail }: { label: string; value: number; period: string; detail: string }) {
  return <div className="surface-card flex flex-col gap-1 p-4">
    <dt className="text-sm font-semibold text-foreground">{label}</dt>
    <dd className="flex flex-col gap-1">
      <span className="font-heading text-3xl font-bold leading-none text-heading">{value}</span>
      <span className="text-sm text-foreground-light">{detail}</span>
      <span className="text-xs text-muted-foreground">{period}</span>
    </dd>
  </div>
}

/** Cifras de lectura registrada con periodo y denominador; sin lecturas registradas, lo dice sin inventar nada. */
export function ReadingStatsSection() {
  const [stats, setStats] = useState<ReadingStats | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let active = true
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    getReadingStatsAction({ timeZone }).then((result) => { if (active) { if (result.ok) setStats(result.value); else setError(true) } }, () => { if (active) setError(true) })
    return () => { active = false }
  }, [])

  if (error) return <section aria-labelledby="lectura-registrada" className="flex flex-col gap-4">
    <SectionTitle id="lectura-registrada" title="Tu lectura registrada" />
    <p className="surface-card p-5 text-foreground-light">No se pudieron calcular tus estadísticas de lectura. Recarga la página para intentarlo de nuevo.</p>
  </section>
  if (!stats) return null
  const { periods, sessions, year } = stats
  const last30 = `Últimos ${sessions.days} días: del ${formatCivilDate(periods.sessionsFrom)} al ${formatCivilDate(periods.today)}`
  const notes = [
    stats.openCycles > 0 ? `${plural(stats.openCycles, "lectura sigue", "lecturas siguen")} en curso.` : null,
    stats.closedWithoutDate > 0 ? `${plural(stats.closedWithoutDate, "lectura cerrada", "lecturas cerradas")} sin fecha de fin no ${stats.closedWithoutDate === 1 ? "entra" : "entran"} en ningún periodo.` : null,
    stats.legacyReadWithoutCycles > 0 ? (stats.legacyReadWithoutCycles === 1
      ? "1 libro marcado como leído no tiene lecturas registradas: no cuenta aquí ni recibe fecha."
      : `${stats.legacyReadWithoutCycles} libros marcados como leídos no tienen lecturas registradas: no cuentan aquí ni reciben fecha.`) : null,
  ].filter((note): note is string => note !== null)

  return <section aria-labelledby="lectura-registrada" className="flex flex-col gap-4" data-testid="reading-stats">
    <SectionTitle id="lectura-registrada" title="Tu lectura registrada" />
    <p className="text-sm text-foreground-light">Solo cuenta lo que registras en la ficha de cada libro. Fechas en tu zona horaria ({periods.timeZone}).</p>
    {stats.totalCycles === 0
      ? <p className="rounded-2xl border border-dashed border-control-border/60 bg-surface/50 p-6 text-foreground-light">Aún no hay lecturas registradas. Empieza una desde la ficha de un libro para ver aquí tus sesiones y tus lecturas terminadas.</p>
      : <dl className="grid gap-4 sm:grid-cols-3">
        <Stat label="Sesiones" value={sessions.entries} period={last30} detail={`En ${sessions.activeDays} de ${sessions.days} días`} />
        <Stat label="Páginas avanzadas" value={sessions.pages} period={last30}
          detail={sessions.entries === 0 ? "Sin sesiones en el periodo" : `De ${sessions.entriesWithRange} de ${plural(sessions.entries, "sesión", "sesiones")} con página inicial y final`} />
        <Stat label="Lecturas terminadas" value={year.finished} period={`En ${periods.year}: del ${formatCivilDate(periods.yearFrom)} al ${formatCivilDate(periods.today)}`}
          detail={`De ${plural(year.closed, "lectura cerrada", "lecturas cerradas")} con fecha${year.abandoned ? ` (${year.abandoned} ${year.abandoned === 1 ? "abandonada" : "abandonadas"})` : ""}`} />
      </dl>}
    {notes.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">{notes.map((note) => <li key={note}>{note}</li>)}</ul>}
  </section>
}
