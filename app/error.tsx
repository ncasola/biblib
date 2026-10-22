"use client"

import { Button } from "@/components/ui/button"

export default function LibraryError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main id="main-content" className="mx-auto max-w-xl px-4 py-20 text-center">
    <h1 className="mb-4 text-3xl font-bold heading-vintage">No se pudo abrir esta página</h1>
    <p role="alert" className="mb-6 text-muted-foreground">Ha ocurrido un problema al cargar la biblioteca. Vuelve a intentarlo; tus datos guardados se conservan.</p>
    <Button onClick={reset}>Reintentar</Button>
  </main>
}
