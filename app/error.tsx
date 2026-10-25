"use client"

import { Button } from "@/components/ui/button"

export default function LibraryError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main id="main-content" className="mx-auto max-w-xl px-4 py-20">
    <section className="surface-card flex flex-col items-center gap-4 px-6 py-10 text-center">
      <h1 className="heading-vintage text-3xl">No se pudo abrir esta página</h1>
      <p role="alert" className="text-foreground-light">Ha ocurrido un problema al cargar la biblioteca. Vuelve a intentarlo; tus datos guardados se conservan.</p>
      <Button onClick={reset}>Reintentar</Button>
    </section>
  </main>
}
