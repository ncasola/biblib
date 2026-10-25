import { z } from "zod"
import { proposedDecisionSchema, type ProposedDecision } from "./catalogue-review"
import { REVIEW_LIMITS } from "./review/contracts"

// Borrador del lote de revisión (U-DAT-07): decisiones que la persona va añadiendo desde la bandeja y las comparaciones
// antes de preparar la vista previa. Es una comodidad de esta pestaña (sessionStorage), no un dato de dominio: nada se
// aplica sin la vista previa y la confirmación del servidor, y el navegador puede vaciarlo sin perder nada guardado.

const STORAGE_KEY = "biblib.review.batch.v1"
const EVENT = "biblib:review-batch"

export interface BatchDraftEntry {
  decision: ProposedDecision
  /** Resumen visible (motivo y ficha), sin datos que el servidor no haya mostrado ya en esta sesión. */
  summary: string
}

const entrySchema = z.object({ decision: proposedDecisionSchema, summary: z.string().max(300) }).strict()

export function readBatchDraft(): BatchDraftEntry[] {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item) => { const entry = entrySchema.safeParse(item); return entry.success ? [entry.data] : [] }).slice(0, REVIEW_LIMITS.batch)
  } catch { return [] }
}

function writeBatchDraft(entries: readonly BatchDraftEntry[]): void {
  try {
    if (entries.length) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
    else window.sessionStorage.removeItem(STORAGE_KEY)
  } catch { /* Sin almacenamiento de sesión: el borrador vive solo en memoria de esta vista. */ }
  try { window.dispatchEvent(new Event(EVENT)) } catch { /* Sin ventana: nada que avisar. */ }
}

/** Añade o sustituye la decisión de una incidencia; `false` si el lote ya tiene el máximo. */
export function addToBatchDraft(entries: readonly BatchDraftEntry[], entry: BatchDraftEntry): BatchDraftEntry[] | null {
  const others = entries.filter((item) => item.decision.issueId !== entry.decision.issueId)
  if (others.length >= REVIEW_LIMITS.batch) return null
  const next = [...others, entry]
  writeBatchDraft(next)
  return next
}

export function removeFromBatchDraft(entries: readonly BatchDraftEntry[], issueIds: ReadonlySet<string>): BatchDraftEntry[] {
  const next = entries.filter((item) => !issueIds.has(item.decision.issueId))
  writeBatchDraft(next)
  return next
}

export function clearBatchDraft(): BatchDraftEntry[] {
  writeBatchDraft([])
  return []
}

/** Avisa de cambios del borrador hechos en otra vista de la misma pestaña. */
export function onBatchDraftChange(listener: () => void): () => void {
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}
