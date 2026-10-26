"use client"

import { useId } from "react"

/** El selector llama onDisable y deja de consultar Google; enabled procede del flag servidor. */
export function GoogleBooksNotice({ enabled, onDisable }: { enabled: boolean; onDisable: () => void }) {
  const titleId = useId()
  if (!enabled) return null
  return (
    <aside aria-labelledby={titleId} className="surface-card rounded-2xl p-4 space-y-3 text-sm text-foreground">
      <h2 id={titleId} className="font-semibold">Consultas opcionales a Google Books</h2>
      <p>Si seleccionas Google Books, se envía el ISBN o el texto de título y autor que buscas. No se envían tu nombre, alias, notas, fotos, préstamos, perfil ni tu colección completa.</p>
      <p>Según las condiciones de Google Books, el contenido enviado a través de su API podría hacerse público en los servicios de Google. Las portadas se ofrecen solo como previsualización temporal.</p>
      <p>
        Consulta las <a className="underline focus-visible:outline-2 focus-visible:outline-offset-4" href="https://developers.google.com/books/terms" target="_blank" rel="noopener noreferrer">condiciones de Google Books</a>, la{" "}
        <a className="underline focus-visible:outline-2 focus-visible:outline-offset-4" href="https://books.google.com/googlebooks/privacy.html" target="_blank" rel="noopener noreferrer">privacidad de Google Books</a> y la{" "}
        <a className="underline focus-visible:outline-2 focus-visible:outline-offset-4" href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">política de privacidad de Google</a>.
      </p>
      <button type="button" onClick={onDisable} className="rounded-lg border border-border px-3 py-2 font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-4">Desactivar Google Books</button>
      <p>Puedes seguir con Open Library, BNE o completar la ficha manualmente.</p>
    </aside>
  )
}
