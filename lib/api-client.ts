import "server-only"
import { createOpenLibraryClient } from "./open-library"
import { telemetry, withActionCorrelation } from "./observability/server"

const client = createOpenLibraryClient({ telemetry })

export async function searchBookByISBN(isbn: string) {
  return withActionCorrelation(() => client.searchBookByISBN(isbn))
}
