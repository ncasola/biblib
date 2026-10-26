"use server"

import type { ActionResult } from "@/lib/action-result"
import type { LibraryJobView } from "@/lib/jobs/contracts"
import { startCoverJobAction } from "@/app/actions/library-jobs"

// U-DAT-03: la recuperación de portadas ya no depende de que la página pida cada lote. Inicia un
// trabajo persistente que el servidor continúa tras recargar o cerrar la página y que conserva las
// portadas existentes y los cambios hechos durante la búsqueda (versión y preimagen de cada libro).
export async function recoverMissingCoversAction(input: { idempotencyKey: string }): Promise<ActionResult<LibraryJobView>> {
  return startCoverJobAction({ scope: "missing", idempotencyKey: input.idempotencyKey })
}
