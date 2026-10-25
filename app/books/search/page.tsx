"use client"

import { BooksTable } from "@/components/books-table"
import { PageHeader } from "@/components/page-header"

export default function SearchPage() {
  return (
    <>
        <PageHeader eyebrow="Colección" title="Búsqueda avanzada" description="Busca por título, autor, ISBN, estado, estantería o etiquetas y alterna entre tabla y cuadrícula." />
        <div className="surface-card p-4 md:p-6">
          <BooksTable initialView="grid" />
        </div>
    </>
  )
}
