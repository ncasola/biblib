"use client"

import { BookX } from "lucide-react"
import { Button } from "@/components/ui/button"

/** Estado de error de una ruta que ya vive dentro de `AppShell` (no pinta cabecera ni `<main>`). */
export function RouteError({ reset }: { reset: () => void }) {
  return (
    <section aria-labelledby="route-error-title" className="surface-card mx-auto my-12 flex max-w-xl flex-col items-center gap-4 px-6 py-10 text-center">
      <span aria-hidden="true" className="flex size-14 items-center justify-center rounded-full bg-destructive/12 text-destructive"><BookX className="size-7" /></span>
      <h1 id="route-error-title" className="heading-vintage text-3xl">No se pudo abrir esta página</h1>
      <p role="alert" className="text-foreground-light">Ha ocurrido un problema al cargar la biblioteca. Vuelve a intentarlo; tus datos guardados se conservan.</p>
      <Button onClick={reset}>Reintentar</Button>
    </section>
  )
}
