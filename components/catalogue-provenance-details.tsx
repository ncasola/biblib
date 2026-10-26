import { PROVENANCE_FIELDS, provenanceFieldLabels, provenanceProviderLabel, provenanceSelectionLabel, readCatalogueView } from "@/lib/catalogue-provenance"
import type { Book } from "@/lib/types"

const dateFormat = new Intl.DateTimeFormat("es-ES", { dateStyle: "medium" })
const formatDate = (value?: string) => { const date = value ? new Date(value) : null; return date && !Number.isNaN(date.getTime()) ? dateFormat.format(date) : null }

/** Procedencia de la ficha: fuente primaria, comprobación humana del ISBN y fuente de cada campo (v2). */
export function CatalogueProvenanceDetails({ book }: { book: Pick<Book, "isbn" | "catalogue"> }) {
  const view = readCatalogueView(book.catalogue, book.isbn)
  const fields = PROVENANCE_FIELDS.filter((field) => view.fields[field])
  return <div className="space-y-2">
    <p>{view.sourceKnown ? `Fuente principal: ${view.sourceLabel}` : view.sourceLabel}</p>
    {view.isbnChecksumValid && <p className="text-sm text-muted-foreground">{view.isbnVerified
      ? "ISBN comprobado por ti en tu ejemplar."
      : "Edición pendiente de verificar. El ISBN tiene un dígito de control válido, pero eso no confirma tu ejemplar: compruébalo y confírmalo al editar la ficha."}</p>}
    {view.sourceUrl && <a className="text-primary underline underline-offset-4 text-sm" href={view.sourceUrl} target="_blank" rel="noopener noreferrer">Consultar fuente bibliográfica<span className="sr-only"> (se abre en otra pestaña)</span></a>}
    {fields.length > 0 && <dl aria-label="Procedencia por campo" className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
      {fields.map((field) => {
        const provenance = view.fields[field]!
        const details = [provenanceProviderLabel(provenance.provider), provenance.recordId && `registro ${provenance.recordId}`, provenanceSelectionLabel(provenance.selection), formatDate(provenance.retrievedAt) && `consultado el ${formatDate(provenance.retrievedAt)}`].filter(Boolean).join(" · ")
        return <div key={field} className="contents">
          <dt className="font-semibold text-muted-foreground">{provenanceFieldLabels[field]}</dt>
          <dd className="break-words">{provenance.sourceUrl ? <a className="text-primary underline underline-offset-4" href={provenance.sourceUrl} target="_blank" rel="noopener noreferrer">{details}<span className="sr-only"> (se abre en otra pestaña)</span></a> : details}</dd>
        </div>
      })}
    </dl>}
  </div>
}
