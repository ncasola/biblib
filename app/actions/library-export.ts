"use server"

import { randomUUID } from "node:crypto"
import { and, eq, inArray } from "drizzle-orm"
import { z } from "zod"
import { withRlsContext } from "@/lib/db/client"
import { books } from "@/lib/db/schema"
import { getRequiredUserId } from "@/lib/server-user"
import { DomainError, translateDatabaseError } from "@/lib/domain-errors"
import type { ActionResult } from "@/lib/action-result"
import { domainMutation } from "@/lib/server-action"
import type { BackupSetManifest } from "@/lib/import-manifest"
import { exportSet, libraryCounts, readExportLibrary } from "@/lib/library-export-server"

// Tarea T1 (U-QA-03) dentro de U-DAT-04: Ajustes muestra recuentos sin leer la colección y la copia
// por partes la genera el servidor. Esta acción devuelve solo el manifest y los enlaces de descarga;
// los bytes de cada parte los sirve /api/library/export generándolos de nuevo para esa revisión.

export interface ExportPartLink {
  index: number
  fileName: string
  byteLength: number
  sha256: string
  books: number
  shelves: number
  /** Descarga de la parte: misma revisión, fecha y conjunto, comprobada contra su hash. */
  href: string
}

export interface PreparedLibraryExport {
  formatVersion: 1 | 2
  reason?: string
  exportedAt: string
  revision: string
  manifest: BackupSetManifest
  manifestText: string
  manifestFileName: string
  totals: { books: number; shelves: number }
  parts: ExportPartLink[]
}

export async function getLibraryCountsAction(): Promise<ActionResult<{ books: number; shelves: number }>> {
  return domainMutation(async () => {
    const userId = await getRequiredUserId()
    try { return await withRlsContext(userId, (tx) => libraryCounts(tx, userId)) } catch (error) { translateDatabaseError(error) }
  })
}

const titlesSchema = z.object({ ids: z.array(z.uuid()).max(50) })

/** Títulos de unas pocas fichas propias (la revisión de una importación muestra las que se eliminarán). */
export async function getBookTitlesAction(input: { ids: string[] }): Promise<ActionResult<{ id: string; title: string }[]>> {
  return domainMutation(async () => {
    const userId = await getRequiredUserId()
    const parsed = titlesSchema.safeParse(input)
    if (!parsed.success) throw new DomainError("INVALID_INPUT", "La consulta de títulos no es válida.")
    if (!parsed.data.ids.length) return []
    try {
      return await withRlsContext(userId, (tx) => tx.select({ id: books.id, title: books.title }).from(books).where(and(eq(books.userId, userId), inArray(books.id, parsed.data.ids))))
    } catch (error) { translateDatabaseError(error) }
  })
}

export async function prepareLibraryExportAction(): Promise<ActionResult<PreparedLibraryExport>> {
  return domainMutation(async () => {
    const userId = await getRequiredUserId()
    let read: Awaited<ReturnType<typeof readExportLibrary>>
    try { read = await withRlsContext(userId, (tx) => readExportLibrary(tx, userId)) } catch (error) { translateDatabaseError(error) }
    if (!read) throw new DomainError("PROVIDER_UNAVAILABLE", "Tu biblioteca estaba cambiando mientras se preparaba la copia. No se ha descargado nada; vuelve a intentarlo.")
    const exportedAt = new Date()
    const exportSetId = randomUUID()
    let set
    try { set = exportSet(read.data, exportedAt, exportSetId) } catch (error) {
      throw new DomainError("INVALID_INPUT", error instanceof Error ? error.message : "No se pudo preparar la copia.")
    }
    const query = (index: number, sha256: string) => new URLSearchParams({ revision: read.revision, exportedAt: exportedAt.toISOString(), set: exportSetId, part: String(index), sha256 }).toString()
    return {
      formatVersion: set.formatVersion, ...(set.reason ? { reason: set.reason } : {}), exportedAt: exportedAt.toISOString(), revision: read.revision,
      manifest: set.manifest, manifestText: set.manifestText, manifestFileName: set.manifestFileName,
      totals: { books: read.data.books.length, shelves: read.data.shelves.length },
      parts: set.files.map((file) => {
        const counts = "copies" in file.counts ? { books: file.counts.copies, shelves: file.counts.shelves } : file.counts
        return { index: file.index, fileName: file.fileName, byteLength: file.byteLength, sha256: file.sha256, books: counts.books, shelves: counts.shelves, href: `/api/library/export?${query(file.index, file.sha256)}` }
      }),
    }
  })
}
