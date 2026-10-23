"use client"

import { Button } from "@/components/ui/button"

/** Estado de error de una ruta que ya vive dentro de `AppShell` (no pinta cabecera ni `<main>`). */
export function RouteError({ reset }: { reset: () => void }) {
  return (
    <section aria-labelledby="route-error-title" className="mx-auto max-w-xl py-12 text-center">
      <h1 id="route-error-title" className="mb-4 text-3xl font-bold heading-vintage">No se pudo abrir esta página</h1>
      <p role="alert" className="mb-6 text-muted-foreground">Ha ocurrido un problema al cargar la biblioteca. Vuelve a intentarlo; tus datos guardados se conservan.</p>
      <Button onClick={reset}>Reintentar</Button>
    </section>
  )
}
