import Link from "next/link"
import { Printer } from "lucide-react"
import { Button } from "@/components/ui/button"
import { printHref } from "@/lib/print-catalogue"
import type { BookSearchFilters } from "@/lib/book-search"

export function PrintCatalogueLink({ filters, disabled }: { filters: BookSearchFilters; disabled?: boolean }) {
  return disabled ? <Button variant="outline" disabled><Printer aria-hidden="true" />Imprimir catálogo</Button>
    : <Button asChild variant="outline"><Link href={printHref(filters)}><Printer aria-hidden="true" />Imprimir catálogo</Link></Button>
}
