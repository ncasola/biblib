"use client"

import { BooksTable } from "@/components/books-table"
import { Button } from "@/components/ui/button"
import { Plus } from "lucide-react"
import Link from "next/link"

export default function BooksPage() {
  return (
    <>
        <div className="mb-8 flex flex-col gap-4 md:mb-12 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="mb-2 text-3xl font-bold heading-vintage md:text-4xl">Tus libros</h1>
            <p className="text-base text-muted-foreground md:text-lg">Gestiona y explora tu colección de libros</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:gap-3">
            <Button asChild className="w-full rounded-xl bg-primary px-6 py-3 font-semibold text-primary-foreground shadow-lg shadow-primary/30 transition-all hover:scale-105 sm:w-auto"><Link href="/books/add"><Plus aria-hidden="true" className="h-5 w-5" />Agregar libro</Link></Button>
            <Button asChild variant="secondary" className="w-full rounded-xl px-6 py-3 font-semibold shadow-lg shadow-secondary/30 transition-all hover:scale-105 sm:w-auto"><Link href="/shelves/3d">Ver estantería 3D</Link></Button>
          </div>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4 shadow-xl backdrop-blur-md md:p-8">
          <BooksTable initialView="table" />
        </div>
    </>
  )
}
