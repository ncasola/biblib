"use client"

import { BooksTable } from "@/components/books-table"
import { Button } from "@/components/ui/button"
import { PageHeader } from "@/components/page-header"
import { ClipboardCheck, Plus } from "lucide-react"
import Link from "next/link"

export default function BooksPage() {
  return (
    <>
        <PageHeader eyebrow="Colección" title="Tus libros" description="Gestiona y explora tu colección de libros" actions={<>
          <Button asChild><Link href="/books/add"><Plus aria-hidden="true" />Agregar libro</Link></Button>
          <Button asChild variant="secondary"><Link href="/shelves/3d">Ver estantería 3D</Link></Button>
          <Button asChild variant="outline"><Link href="/books/review"><ClipboardCheck aria-hidden="true" />Revisar fichas</Link></Button>
        </>} />
        <div className="surface-card p-4 md:p-6">
          <BooksTable initialView="table" />
        </div>
    </>
  )
}
