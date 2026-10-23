"use client"

import { BooksTable } from "@/components/books-table"

export default function SearchPage() {
  return (
    <>
        <div className="mb-8 md:mb-12">
          <h1 className="mb-2 text-3xl font-bold heading-vintage md:text-4xl">Búsqueda avanzada</h1>
          <p className="text-base text-muted-foreground md:text-lg">Busca por título, autor, ISBN, estado o estantería y alterna entre tabla y cuadrícula.</p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4 shadow-xl backdrop-blur-md md:p-8">
          <BooksTable initialView="grid" />
        </div>
    </>
  )
}
