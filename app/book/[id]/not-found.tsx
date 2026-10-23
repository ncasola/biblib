import Link from "next/link"
import { privateMetadata } from "@/lib/route-metadata"

export const metadata = privateMetadata("Libro no encontrado")

export default function BookNotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <section className="w-full max-w-md rounded-2xl border border-border bg-card/80 p-8 text-center shadow-xl backdrop-blur-xl">
        <h1 className="text-2xl font-bold">Libro no encontrado</h1>
        <p className="mt-3 text-muted-foreground">El libro que buscas ya no está disponible en tu biblioteca.</p>
        <Link href="/books" className="mt-6 inline-flex rounded-xl bg-vintage-red px-5 py-3 font-semibold text-white transition-colors hover:bg-vintage-red/90 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-vintage-red">
          Volver a la colección
        </Link>
      </section>
    </main>
  )
}
