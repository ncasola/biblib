"use client"

import { ReviewInbox } from "@/components/review-inbox"

// U-DAT-07: bandeja de revisión bibliográfica. Las incidencias se generan desde las evidencias y el modelo al abrirla.
export default function BooksReviewPage() {
  return (
    <>
      <div className="mb-8 md:mb-12">
        <h1 className="mb-2 text-3xl font-bold heading-vintage md:text-4xl">Revisión bibliográfica</h1>
        <p className="text-base text-muted-foreground md:text-lg">Resuelve fichas sin ISBN, ISBN provisionales, portadas que faltan, dudas de fotos y posibles duplicados. Ninguna decisión borra evidencias.</p>
      </div>
      <ReviewInbox />
    </>
  )
}
