"use client"

import { PageHeader } from "@/components/page-header"
import { ReviewInbox } from "@/components/review-inbox"

// U-DAT-07: bandeja de revisión bibliográfica. Las incidencias se generan desde las evidencias y el modelo al abrirla.
export default function BooksReviewPage() {
  return (
    <>
      <PageHeader eyebrow="Colección" title="Revisión bibliográfica" description="Resuelve fichas sin ISBN, ISBN provisionales, portadas que faltan, dudas de fotos y posibles duplicados. Ninguna decisión borra evidencias." />
      <ReviewInbox />
    </>
  )
}
