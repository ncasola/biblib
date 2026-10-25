"use server"

import { and, eq, inArray } from "drizzle-orm"
import { z } from "zod"
import { withRlsContext } from "@/lib/db/client"
import { lockLibrary } from "@/lib/db/library"
import { editions } from "@/lib/db/schema"
import {
  applyReviewDecisions, decisionHistory, listReviewIssues, loadReviewState, planBatch, previewDigest, rowDigest, syncReviewIssues, translateReviewError,
  type DecisionHistoryEntry, type ReviewBatchReport, type ReviewIssuePage,
} from "@/lib/db/review"
import { bibliographicCatalog } from "@/lib/bibliographic-catalog/server"
import type { BibliographicCandidate, ProviderOutcome } from "@/lib/bibliographic-catalog/types"
import { idempotencyKeySchema, uuidSchema } from "@/lib/book-validation"
import {
  ACCEPT_FIELDS, comparisonRows, editionColumn, evidenceColumn, listReviewIssuesSchema, proposedDecisionSchema, providerColumn, providerColumnKey, reviewBatchSchema,
  type AcceptField, type BatchSummary, type ColumnKey, type ComparisonColumn, type ComparisonRow, type PlanRowStatus, type ProposedDecision,
} from "@/lib/catalogue-review"
import { DomainError } from "@/lib/domain-errors"
import { REVIEW_LIMITS, type ConfidenceLabel, type EvidenceOrigin, type EvidenceSourceKind, type ReviewDecisionKind, type ReviewReason, type ReviewState } from "@/lib/review/contracts"
import { getRequiredUserId } from "@/lib/server-user"
import { domainMutation } from "@/lib/server-action"

// Bandeja de revisión bibliográfica (U-DAT-07), todas `ActionResult`:
// - listReviewIssuesAction({ filters, cursor, limit }): primera página → sincroniza las incidencias derivadas; cursor opaco.
// - compareBibliographicCandidatesAction({ issueId }): comparación campo a campo con la fuente de cada afirmación.
// - prepareReviewBatchAction({ issueIds, proposedDecisions }): vista previa de hasta 50 decisiones (altas, cambios, fusiones).
// - applyReviewBatchAction({ previewId, expectedRevision, idempotencyKey, preview, mode }): aplica lo revisado o nada.
// - decideReviewIssueAction({ decision, idempotencyKey }): una decisión individual, con las versiones que se vieron.
// La vista previa no se guarda: `previewId` es la huella de lo revisado y `preview` lo devuelve el cliente tal cual (sin
// cambiar el schema de 0014). El dueño sale de la sesión; una incidencia o ficha de otra cuenta responde «no disponible».

const PREVIEW_TTL_MS = 15 * 60_000
const MAX_PROVIDER_LOOKUPS = 10

function parse<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const result = schema.safeParse(input)
  if (!result.success) throw new DomainError("INVALID_INPUT", message)
  return result.data
}

async function inTransaction<T>(userId: string, work: Parameters<typeof withRlsContext<T>>[1]): Promise<T> {
  try { return await withRlsContext(userId, work) } catch (error) { translateReviewError(error) }
}

// ── Proveedores (fuera de las transacciones de dominio) ──────────────────────────────────────────────────────────────

interface ProviderLookup { candidates: BibliographicCandidate[]; outcomes: ProviderOutcome[] }

async function lookupProviders(userId: string, isbns: readonly string[]): Promise<Map<string, ProviderLookup>> {
  const results = new Map<string, ProviderLookup>()
  for (const isbn of isbns.slice(0, MAX_PROVIDER_LOOKUPS)) {
    try {
      const result = await bibliographicCatalog.lookupISBN(isbn, { userId })
      results.set(isbn, { candidates: result.candidates.filter((candidate) => candidate.level === "edition"), outcomes: result.providers })
    } catch {
      // Un proveedor caído no es «no existe»: la comparación sigue con las fuentes guardadas.
      results.set(isbn, { candidates: [], outcomes: [] })
    }
  }
  return results
}

function providerMap(lookups: ReadonlyMap<string, ProviderLookup>): Map<ColumnKey, BibliographicCandidate> {
  const map = new Map<ColumnKey, BibliographicCandidate>()
  for (const { candidates } of lookups.values()) candidates.forEach((candidate, index) => map.set(providerColumnKey(candidate, index), candidate))
  return map
}

/** Candidatos de proveedor que citan las decisiones (por el ISBN de su edición), consultados antes de abrir la transacción. */
async function providersFor(userId: string, decisions: readonly ProposedDecision[]): Promise<Map<ColumnKey, BibliographicCandidate>> {
  const editionIds = [...new Set(decisions.flatMap((decision) => decision.kind === "accept_fields" && Object.values(decision.fields).some((key) => key?.startsWith("provider:")) ? [decision.editionId] : []))]
  if (!editionIds.length) return new Map()
  const rows = await inTransaction(userId, (tx) => tx.select({ isbn13: editions.isbn13 }).from(editions).where(and(eq(editions.userId, userId), inArray(editions.id, editionIds))))
  const isbns = [...new Set(rows.flatMap((row) => row.isbn13 ? [row.isbn13] : []))]
  if (isbns.length > MAX_PROVIDER_LOOKUPS) throw new DomainError("LIMIT_EXCEEDED", `Un lote admite fichas de proveedor de ${MAX_PROVIDER_LOOKUPS} ediciones como máximo. Divide el lote.`)
  return providerMap(await lookupProviders(userId, isbns))
}

// ── Listado ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function listReviewIssuesAction(input: unknown) {
  return domainMutation(async (): Promise<ReviewIssuePage> => {
    const userId = await getRequiredUserId()
    const request = parse(listReviewIssuesSchema, input ?? {}, "Los filtros de la bandeja no son válidos.")
    return inTransaction(userId, async (tx) => {
      // La primera página regenera las incidencias derivadas; las siguientes solo leen, para que el cursor sea estable.
      const sync = request.cursor ? undefined : await syncReviewIssues(tx, userId)
      const page = await listReviewIssues(tx, userId, request)
      return sync ? { ...page, sync } : page
    })
  })
}

// ── Comparación ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ReviewEvidenceView {
  id: string
  subject: { kind: "edition" | "copy"; id: string }
  sourceKind: EvidenceSourceKind
  sourceRef?: string
  sourceUrl?: string
  /** Hay una foto privada propia citada; la imagen no se muestra ni se enlaza desde aquí. */
  hasPhoto: boolean
  observedAt?: string
  confidence: ConfidenceLabel
  origin: EvidenceOrigin
  claimedFields: AcceptField[]
}

export interface ReviewCopyView { id: string; version: string; editionId: string; isbnVerified: boolean }

export interface ReviewComparison {
  issue: { id: string; version: string; reason: ReviewReason; state: ReviewState }
  editions: { id: string; version: string; title: string; isbn13: string | null; copies: number; workId: string | null }[]
  copies: ReviewCopyView[]
  columns: ComparisonColumn[]
  rows: ComparisonRow[]
  evidence: ReviewEvidenceView[]
  history: DecisionHistoryEntry[]
  /** Estado de cada proveedor consultado ahora (ficha encontrada, no disponible…). */
  providers: ProviderOutcome[]
}

const COMPARED_REASONS: ReadonlySet<ReviewReason> = new Set(["provisional", "missing_cover", "photo_doubt", "source_conflict", "invalid_isbn"])

export async function compareBibliographicCandidatesAction(input: unknown) {
  return domainMutation(async (): Promise<ReviewComparison> => {
    const userId = await getRequiredUserId()
    const { issueId } = parse(z.object({ issueId: uuidSchema }).strict(), input, "Indica la incidencia que quieres revisar.")
    const loaded = await inTransaction(userId, async (tx) => {
      const state = await loadReviewState(tx, userId, [issueId])
      const issue = state.issues.get(issueId)
      if (!issue) throw new DomainError("NOT_FOUND", "La incidencia ya no está disponible.")
      return { state, issue, history: await decisionHistory(tx, userId, issueId) }
    })
    const { state, issue } = loaded
    const editionIds = issue.entityRefs.filter((ref) => ref.kind === "edition").map((ref) => ref.id)
    const copyEditions = issue.entityRefs.flatMap((ref) => ref.kind === "copy" ? [state.copies.get(ref.id)?.editionId] : []).filter((id): id is string => Boolean(id))
    const cited = [...new Set([...editionIds, ...copyEditions])].map((id) => state.editions.get(id)).filter((edition) => edition !== undefined)
    const isbns = COMPARED_REASONS.has(issue.reason) ? [...new Set(cited.flatMap((edition) => edition.isbn13 ? [edition.isbn13] : []))].slice(0, 2) : []
    const lookups = isbns.length ? await lookupProviders(userId, isbns) : new Map<string, ProviderLookup>()
    const citedIds = new Set(cited.map((edition) => edition.id))
    const relevantEvidence = state.evidenceList.filter((entry) => (entry.editionId && citedIds.has(entry.editionId)) || (entry.copyId && citedIds.has(state.copies.get(entry.copyId)?.editionId ?? "")))
    const columns: ComparisonColumn[] = [
      ...cited.map((edition, index) => editionColumn(edition, index)),
      ...relevantEvidence.flatMap((entry) => { const column = evidenceColumn(entry); return column ? [column] : [] }),
      ...[...lookups.values()].flatMap(({ candidates }) => candidates.map((candidate, index) => providerColumn(candidate, index))),
    ]
    return {
      issue: { id: issue.id, version: issue.version, reason: issue.reason, state: issue.state },
      editions: cited.map((edition) => ({ id: edition.id, version: edition.version, title: edition.title, isbn13: edition.isbn13, copies: edition.copies, workId: edition.workId })),
      copies: state.copyList.filter((copy) => citedIds.has(copy.editionId)).map((copy) => ({ id: copy.id, version: copy.version, editionId: copy.editionId, isbnVerified: copy.isbnVerified })),
      columns, rows: comparisonRows(columns),
      evidence: relevantEvidence.map((entry) => ({
        id: entry.id, subject: entry.copyId ? { kind: "copy" as const, id: entry.copyId } : { kind: "edition" as const, id: entry.editionId ?? "" },
        sourceKind: entry.sourceKind, ...(entry.sourceRef ? { sourceRef: entry.sourceRef } : {}), ...(entry.sourceUrl ? { sourceUrl: entry.sourceUrl } : {}),
        hasPhoto: entry.hasPhoto, ...(entry.observedAt ? { observedAt: entry.observedAt } : {}), confidence: entry.confidence, origin: entry.origin,
        claimedFields: ACCEPT_FIELDS.filter((field) => evidenceColumn(entry)?.values[field] !== undefined),
      })),
      history: loaded.history,
      providers: [...lookups.values()].flatMap(({ outcomes }) => outcomes),
    }
  })
}

// ── Lotes ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ReviewPreviewRow {
  index: number
  issueId: string
  kind: ReviewDecisionKind
  status: PlanRowStatus
  message?: string
  effects: string[]
  creates: number
  updates: number
  merges: number
}

/** Lo que el cliente devuelve tal cual al confirmar (la vista previa no se guarda en el servidor). */
export interface ReviewPreviewToken {
  expiresAt: string
  decisions: ProposedDecision[]
  rowDigests: string[]
}

export interface ReviewBatchPreview {
  previewId: string
  expectedRevision: string
  expiresAt: string
  preview: ReviewPreviewToken
  rows: ReviewPreviewRow[]
  summary: BatchSummary
}

const prepareSchema = z.object({
  issueIds: z.array(uuidSchema).min(1).max(REVIEW_LIMITS.batch),
  proposedDecisions: reviewBatchSchema,
}).strict()

export async function prepareReviewBatchAction(input: unknown) {
  return domainMutation(async (): Promise<ReviewBatchPreview> => {
    const userId = await getRequiredUserId()
    const request = parse(prepareSchema, input, `Elige entre 1 y ${REVIEW_LIMITS.batch} incidencias y una decisión para cada una.`)
    const selected = new Set(request.issueIds)
    if (selected.size !== request.issueIds.length || request.proposedDecisions.length !== selected.size || request.proposedDecisions.some((decision) => !selected.has(decision.issueId))) {
      throw new DomainError("INVALID_INPUT", "Cada incidencia elegida necesita exactamente una decisión.")
    }
    const providers = await providersFor(userId, request.proposedDecisions)
    return inTransaction(userId, async (tx) => {
      const revision = await lockLibrary(tx)
      const state = await loadReviewState(tx, userId, request.issueIds, request.proposedDecisions)
      const { rows, summary } = planBatch(state, providers, request.proposedDecisions, new Date().toISOString())
      const rowDigests = rows.map((row, index) => rowDigest(userId, row, request.proposedDecisions[index]))
      const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS).toISOString()
      const previewId = previewDigest({ userId, revision, expiresAt, decisions: request.proposedDecisions, rowDigests })
      return {
        previewId, expectedRevision: revision, expiresAt, preview: { expiresAt, decisions: request.proposedDecisions, rowDigests }, summary,
        rows: rows.map(({ index, issueId, kind, status, message, effects, creates, updates, merges }) => ({ index, issueId, kind, status, ...(message ? { message } : {}), effects, creates, updates, merges })),
      }
    })
  })
}

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/)
const applySchema = z.object({
  previewId: digestSchema,
  expectedRevision: uuidSchema,
  idempotencyKey: idempotencyKeySchema,
  preview: z.object({ expiresAt: z.iso.datetime(), decisions: reviewBatchSchema, rowDigests: z.array(digestSchema).max(REVIEW_LIMITS.batch) }).strict(),
  /** `partial` solo por elección explícita: aplica las filas que siguen valiendo e informa de cada una. */
  mode: z.enum(["atomic", "partial"]).default("atomic"),
}).strict()

export async function applyReviewBatchAction(input: unknown) {
  return domainMutation(async (): Promise<ReviewBatchReport> => {
    const userId = await getRequiredUserId()
    const request = parse(applySchema, input, "La confirmación del lote no es válida. Vuelve a preparar la vista previa.")
    const { decisions, rowDigests, expiresAt } = request.preview
    if (rowDigests.length !== decisions.length || previewDigest({ userId, revision: request.expectedRevision, expiresAt, decisions, rowDigests }) !== request.previewId) {
      throw new DomainError("INVALID_INPUT", "La vista previa no coincide con lo que se intenta aplicar. No se ha aplicado nada; vuelve a prepararla.")
    }
    const providers = await providersFor(userId, decisions)
    return inTransaction(userId, (tx) => applyReviewDecisions(tx, userId, {
      operation: "review.apply", idempotencyKey: request.idempotencyKey, previewId: request.previewId, expectedRevision: request.expectedRevision,
      decisions, rowDigests, mode: request.mode, providers, expiresAt,
    }))
  })
}

const decideSchema = z.object({ decision: proposedDecisionSchema, idempotencyKey: idempotencyKeySchema }).strict()

/** Decisión individual desde la comparación: sin vista previa, pero con las versiones de incidencia y ficha que se vieron. */
export async function decideReviewIssueAction(input: unknown) {
  return domainMutation(async (): Promise<ReviewBatchReport> => {
    const userId = await getRequiredUserId()
    const request = parse(decideSchema, input, "La decisión no es válida. Vuelve a cargar la incidencia.")
    const providers = await providersFor(userId, [request.decision])
    return inTransaction(userId, (tx) => applyReviewDecisions(tx, userId, {
      operation: "review.decide", idempotencyKey: request.idempotencyKey, previewId: null, expectedRevision: null,
      decisions: [request.decision], rowDigests: null, mode: "atomic", providers,
    }))
  })
}
