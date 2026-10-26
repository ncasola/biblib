"use server"

import { sql } from "drizzle-orm"
import { listBooksAction } from "@/app/actions/library"
import { withRlsContext } from "@/lib/db/client"
import { getRequiredUserId } from "@/lib/server-user"
import { collectPrintPages, printQuery, type PrintBook } from "@/lib/print-catalogue"
import { formatLocationPath } from "@/lib/locations"

export async function getPrintCatalogueAction(query: string) {
  const owner = await getRequiredUserId()
  if (typeof query !== "string" || query.length > 10000) throw new Error("Los filtros de impresión no son válidos.")
  const params = new URLSearchParams(query)
  return collectPrintPages(async (page) => {
    const result = await listBooksAction(printQuery(params, page))
    // Ruta física por ejemplar, acotada a los 100 IDs de esta página y a los ocho niveles del contrato.
    const ids = result.books.map((book) => book.id)
    const locations = ids.length ? await withRlsContext(owner, (tx) => tx.execute<{
      copy_id: string; path: string[]; shelf_label: string | null; position: number | null
    }>(sql`
      with recursive paths as (
        select cl.copy_id, l.id, l.parent_id, array[l.name] as path, cl.shelf_label, cl.position, 1 as depth
        from biblib.copy_locations cl join biblib.locations l on l.id = cl.location_id and l.user_id = cl.user_id
        where cl.user_id = ${owner}::uuid and cl.copy_id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
        union all
        select p.copy_id, l.id, l.parent_id, array[l.name] || p.path, p.shelf_label, p.position, p.depth + 1
        from paths p join biblib.locations l on l.id = p.parent_id and l.user_id = ${owner}::uuid where p.depth < 8
      ) select distinct on (copy_id) copy_id, path, shelf_label, position from paths order by copy_id, depth desc limit 100
    `)) : []
    const byCopy = new Map(locations.map((row) => [row.copy_id, formatLocationPath(row.path, { shelfLabel: row.shelf_label, position: row.position })]))
    const books: PrintBook[] = result.books.map((book) => ({ id: book.id, title: book.title, authors: book.authors, isbn: book.isbn,
      status: book.status, cover: book.cover, coverAssetId: book.coverAssetId, notes: book.personal?.notes, locationText: byCopy.get(book.id) }))
    return { ...result, books }
  })
}
