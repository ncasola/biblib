import { getPrintCatalogueAction } from "@/app/actions/print-catalogue"
import { PrintCatalogueView } from "@/components/print-catalogue"
import { buildCollectionPath, parseBookSearchFilters } from "@/lib/book-search"
import { privateMetadata } from "@/lib/route-metadata"
import "./print.css"

export const metadata = privateMetadata("Imprimir catálogo")

export default async function PrintPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) params.append(key, entry)
  }
  const catalogue = await getPrintCatalogueAction(params.toString())
  return <PrintCatalogueView catalogue={catalogue} returnHref={buildCollectionPath("/books", parseBookSearchFilters(params))} />
}
