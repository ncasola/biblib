import { DEFAULT_BOOK_COVER, normalizeBookCover } from "./book-covers"
import { normalizeIsbn } from "./isbn"
import { emitSafely, type TelemetryEmitter } from "./observability/emitter"
import type { Book } from "./types"

export const COVER_RECOVERY_BATCH_SIZE = 20

export interface CoverRecoverySnapshot {
  id: string
  isbn: string
  version: string
  cover: Book["cover"]
}

export interface CoverRecoveryResult {
  nextCursor: string | null
  scanned: number
  recovered: number
  unavailable: number
  skipped: number
}

/** Se llama después del commit; los contadores no contienen fichas ni cursores. */
export function recordCoverRecovery(result: CoverRecoveryResult, telemetry: TelemetryEmitter): void {
  for (const outcome of ["recovered", "unavailable", "skipped"] as const) {
    if (result[outcome] > 0) emitSafely(telemetry, "cover.recovery", { operation: "cover.outcome", result: outcome, batch: result[outcome] })
  }
}

export function isCoverRecoveryCandidate(cover: Book["cover"]): boolean {
  return [cover.small, cover.medium, cover.large].every((url) =>
    ["", DEFAULT_BOOK_COVER, "/placeholder.svg"].includes(url.trim().split("?")[0]))
}

export function decideCoverRecovery(
  snapshot: CoverRecoverySnapshot,
  current: CoverRecoverySnapshot | undefined,
  found: Book["cover"] | undefined,
): { outcome: "skipped" | "unavailable" } | { outcome: "recovered"; cover: Book["cover"] } {
  if (
    !normalizeIsbn(snapshot.isbn) || !isCoverRecoveryCandidate(snapshot.cover) ||
    !current || current.id !== snapshot.id || current.version !== snapshot.version || current.isbn !== snapshot.isbn ||
    current.cover.small !== snapshot.cover.small || current.cover.medium !== snapshot.cover.medium || current.cover.large !== snapshot.cover.large
  ) return { outcome: "skipped" }

  const cover = normalizeBookCover(found)
  if (cover.large === DEFAULT_BOOK_COVER) return { outcome: "unavailable" }
  return { outcome: "recovered", cover }
}
