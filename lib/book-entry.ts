import type { Book } from "./types"
import type { BookInput } from "./book-validation"

/** Preferencias efímeras: pertenecen a esta pantalla de alta, nunca a almacenamiento persistente. */
export type BookEntryDefaults = Pick<Book, "status" | "shelf_id">
export type SaveAndAddAnother = (book: Book, input: BookInput) => void

/** Cierre síncrono, anterior al próximo render de React; también protege dos eventos en el mismo tick. */
export class SubmissionGate {
  private busy = false
  enter(): boolean {
    if (this.busy) return false
    this.busy = true
    return true
  }
  leave() { this.busy = false }
}

/** Acota también la consulta local de duplicados, no solo el fetch del proveedor. */
export async function entrySearchDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, controller: AbortController, timeoutMs = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("La búsqueda ha tardado demasiado.")
      error.name = "AbortError"
      controller.abort()
      reject(error)
    }, timeoutMs)
  })
  try { return await Promise.race([operation(controller.signal), deadline]) }
  finally { clearTimeout(timer) }
}
