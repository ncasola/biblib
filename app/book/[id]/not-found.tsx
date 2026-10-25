import Link from "next/link"
import { privateMetadata } from "@/lib/route-metadata"

export const metadata = privateMetadata("Libro no encontrado")

export default function BookNotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6 text-foreground">
      <section className="surface-card w-full max-w-md p-8 text-center">
        <h1 className="heading-vintage text-3xl">Libro no encontrado</h1>
        <p className="mt-3 text-foreground-light">El libro que buscas ya no está disponible en tu biblioteca.</p>
        <Link href="/books" className="mt-6 inline-flex min-h-11 items-center rounded-md bg-primary px-5 font-semibold text-primary-foreground shadow-md transition-colors hover:bg-primary/90">
          Volver a la colección
        </Link>
      </section>
    </main>
  )
}
