"use client"

import { useState, useSyncExternalStore } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { BookCover } from "@/components/book-cover"
import { displayCover } from "@/lib/book-covers"
import { DEFAULT_PRINT_FIELDS, PRINT_FIELD_LABELS, PRINT_FIELDS, PRINT_LIMIT, PRINT_STATUS_LABELS, selectPrintFields, type PrintBook, type PrintCatalogue, type PrintField } from "@/lib/print-catalogue"

function cell(book: PrintBook, field: PrintField) {
  switch (field) {
    case "title": return book.title
    case "author": return book.authors.map((author) => author.name).join(", ") || "Desconocido"
    case "isbn": return book.isbn || "—"
    case "status": return PRINT_STATUS_LABELS[book.status]
    case "location": return book.locationText || "—"
    case "notes": return book.notes || "—"
    case "cover": return <BookCover cover={displayCover(book)} title={book.title} className="print-cover w-10" sizes="40px" priority />
  }
}

function subscribeDate(onChange: () => void) {
  const timer = window.setInterval(onChange, 60_000)
  window.addEventListener("beforeprint", onChange)
  return () => { window.clearInterval(timer); window.removeEventListener("beforeprint", onChange) }
}
const localDate = () => new Date().toLocaleDateString("es-ES", { dateStyle: "long" })
const serverDate = () => ""

export function PrintCatalogueView({ catalogue, returnHref }: { catalogue: PrintCatalogue; returnHref: string }) {
  const [selected, setSelected] = useState<PrintField[]>([...DEFAULT_PRINT_FIELDS])
  const date = useSyncExternalStore(subscribeDate, localDate, serverDate)
  const fields = selectPrintFields(selected)
  const available = PRINT_FIELDS.filter((field) => field !== "notes" || (catalogue.kind === "ready" && catalogue.books.some((book) => book.notes)))
  return <section className="print-catalogue space-y-6" aria-labelledby="print-title">
    <div className="print-controls surface-card space-y-4 p-4 md:p-6">
      <p className="text-foreground-light">Elige los campos de la copia en papel. Se incluyen todos los resultados de los filtros actuales, hasta {PRINT_LIMIT.toLocaleString("es-ES")} libros.</p>
      <fieldset className="flex flex-wrap gap-x-6 gap-y-2"><legend className="mb-2 font-semibold">Campos del catálogo</legend>
        {available.map((field) => <label key={field} className="flex min-h-11 items-center gap-2"><input type="checkbox" className="h-4 w-4 accent-primary" checked={selected.includes(field)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, field] : current.filter((value) => value !== field))} />{PRINT_FIELD_LABELS[field]}</label>)}
      </fieldset>
      {!fields.length && <p role="alert" className="text-destructive">Selecciona al menos un campo para imprimir.</p>}
      <div className="flex flex-wrap gap-3"><Button disabled={!fields.length || catalogue.kind !== "ready" || !catalogue.total || !date} onClick={() => window.print()}>Imprimir</Button><Button asChild variant="outline"><Link href={returnHref}>Volver</Link></Button></div>
    </div>
    <div className="print-paper space-y-4">
      <h1 id="print-title" className="font-heading text-3xl">Catálogo de mi biblioteca</h1>
      <p>Fecha local: <time>{date || "Preparando fecha…"}</time> · Total: <span data-print-total>{catalogue.total}</span> libros</p>
      {catalogue.kind === "too-large" ? <p role="alert">El resultado supera el máximo imprimible de {PRINT_LIMIT.toLocaleString("es-ES")} libros. Vuelve y filtra por texto, estado, estantería, serie o etiquetas para reducirlo.</p>
        : catalogue.total === 0 ? <p>No hay libros con estos filtros.</p>
        : fields.length > 0 && <div className="print-table-scroll"><table className="print-table"><caption className="sr-only">Resultados filtrados del catálogo</caption>
          <thead><tr><th scope="col">N.º</th>{fields.map((field) => <th key={field} scope="col">{PRINT_FIELD_LABELS[field]}</th>)}</tr></thead>
          <tbody>{catalogue.books.map((book, index) => <tr key={book.id} data-print-book-id={book.id}><td>{index + 1}</td>{fields.map((field) => <td key={field}>{cell(book, field)}</td>)}</tr>)}</tbody>
        </table></div>}
    </div>
  </section>
}
