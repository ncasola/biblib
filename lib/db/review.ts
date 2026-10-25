import "server-only"
import { createHash } from "node:crypto"
import { and, eq, inArray, sql } from "drizzle-orm"
import type { DatabaseTransaction } from "./client"
import { lockLibrary } from "./library"
import { mergeEditions } from "./editions"
import { bibliographicEvidence, copies, editions, reviewDecisions, reviewIssues } from "./schema"
import { canonicalJson } from "../import-plan"
import { DomainError, databaseErrorCode, translateDatabaseError } from "../domain-errors"
import {
  decodeReviewCursor, deriveReviewIssues, effectiveStates, encodeReviewCursor, planIssueSync, planReviewBatch, rowDigestView,
  type ColumnKey, type CopyFacts, type EditionFacts, type EvidenceFacts, type IssueFacts, type PlanOperation, type PlanRow, type PlanState,
  type ProposedDecision, type ReviewFilters, type StoredIssueFacts, type BatchSummary,
} from "../catalogue-review"
import type { BibliographicCandidate } from "../bibliographic-catalog/types"
import { REVIEW_LIMITS, type ConfidenceLabel, type EvidenceOrigin, type EvidenceSourceKind, type ReviewDecisionKind, type ReviewEntityRef, type ReviewReason, type ReviewState } from "../review/contracts"
import type { EditionCatalogue } from "../types"

// Persistencia de la bandeja de revisión (U-DAT-07) sobre las tablas de 0014. Todas las funciones reciben una
// transacción ya situada en el contexto RLS del dueño (`withRlsContext`): el dueño sale de la sesión, nunca de un DTO,
// y una incidencia, edición o evidencia de otra cuenta no existe para esta. Las escrituras de un lote se hacen bajo el
// bloqueo de colección y un bloqueo consultivo de la bandeja, que también toma la sincronización de incidencias.

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** UUID determinista (variante RFC 4122, versión 8) a partir de una huella. */
export function digestUuid(text: string): string {
  const hex = sha256(text)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** Serializa la sincronización y los lotes de la bandeja de una cuenta (dos revisores, dos pestañas). */
async function lockReviewInbox(tx: DatabaseTransaction, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`biblib.review:${userId}`}, 0))`)
}

// ── Hechos ───────────────────────────────────────────────────────────────────────────────────────────────────────────

interface EditionRow extends Record<string, unknown> {
  id: string; version: string; work_id: string | null; isbn13: string | null; title: string; subtitle: string | null
  authors: EditionFacts["authors"]; publishers: EditionFacts["publishers"]; publish_date: string; number_of_pages: number
  catalogue: EditionCatalogue; cover_small: string; cover_medium: string; cover_large: string; cover_asset_id: string | null; copies: number
}

const editionFacts = (row: EditionRow): EditionFacts => ({
  id: row.id, version: row.version, workId: row.work_id, isbn13: row.isbn13, title: row.title, subtitle: row.subtitle, authors: row.authors,
  publishers: row.publishers, publishDate: row.publish_date, numberOfPages: row.number_of_pages, catalogue: row.catalogue,
  covers: { small: row.cover_small, medium: row.cover_medium, large: row.cover_large }, coverAssetId: row.cover_asset_id, copies: Number(row.copies),
})

async function readEditions(tx: DatabaseTransaction, userId: string, ids?: readonly string[]): Promise<EditionFacts[]> {
  if (ids && !ids.length) return []
  const filter = ids ? sql`and e.id = any(${sql`array[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}]`})` : sql``
  const rows = await tx.execute<EditionRow>(sql`
    select e.id, e.version, e.work_id, e.isbn13, e.title, e.subtitle, e.authors, e.publishers, e.publish_date, e.number_of_pages, e.catalogue,
      e.cover_small, e.cover_medium, e.cover_large, e.cover_asset_id,
      (select count(*)::int from biblib.copies as c where c.user_id = e.user_id and c.edition_id = e.id) as copies
    from biblib.editions as e where e.user_id = ${userId}::uuid ${filter} order by e.id`)
  return [...rows].map(editionFacts)
}

async function readCopies(tx: DatabaseTransaction, userId: string, filter?: { ids?: readonly string[]; editionIds?: readonly string[] }): Promise<CopyFacts[]> {
  const conditions = [eq(copies.userId, userId)]
  if (filter) {
    const ids = filter.ids ?? []
    const editionIds = filter.editionIds ?? []
    if (!ids.length && !editionIds.length) return []
    conditions.push(sql`(${ids.length ? inArray(copies.id, [...ids]) : sql`false`} or ${editionIds.length ? inArray(copies.editionId, [...editionIds]) : sql`false`})`)
  }
  const rows = await tx.select({ id: copies.id, version: copies.version, editionId: copies.editionId, verification: copies.editionVerification })
    .from(copies).where(and(...conditions)).orderBy(copies.id)
  return rows.map((row) => ({ id: row.id, version: row.version, editionId: row.editionId, isbnVerified: row.verification.isbnVerified === true }))
}

interface EvidenceRow extends Record<string, unknown> {
  id: string; edition_id: string | null; copy_id: string | null; source_kind: EvidenceSourceKind; source_ref: string | null; source_url: string | null
  has_photo: boolean; observed_at: string | null; field_claims: Record<string, unknown> | null; confidence: ConfidenceLabel; origin: EvidenceOrigin
}

/** Evidencias de la cuenta o de unas ediciones/ejemplares; sin `field_claims` cuando solo hace falta clasificarlas. */
async function readEvidence(tx: DatabaseTransaction, userId: string, options: { claims: boolean; editionIds?: readonly string[]; copyIds?: readonly string[] }): Promise<EvidenceFacts[]> {
  let scope = sql``
  if (options.editionIds || options.copyIds) {
    const editionIds = options.editionIds ?? []
    const copyIds = options.copyIds ?? []
    if (!editionIds.length && !copyIds.length) return []
    const list = (ids: readonly string[]) => sql`array[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}]`
    scope = sql`and (${editionIds.length ? sql`ev.edition_id = any(${list(editionIds)})` : sql`false`} or ${copyIds.length ? sql`ev.copy_id = any(${list(copyIds)})` : sql`false`})`
  }
  const rows = await tx.execute<EvidenceRow>(sql`
    select ev.id, ev.edition_id, ev.copy_id, ev.source_kind, ev.source_ref, ev.source_url, ev.photo_asset_id is not null as has_photo,
      to_char(ev.observed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as observed_at,
      ${options.claims ? sql`ev.field_claims` : sql`null::jsonb`} as field_claims, ev.confidence, ev.origin
    from biblib.bibliographic_evidence as ev where ev.user_id = ${userId}::uuid ${scope} order by ev.created_at, ev.id`)
  return [...rows].map((row) => ({
    id: row.id, editionId: row.edition_id, copyId: row.copy_id, sourceKind: row.source_kind, sourceRef: row.source_ref, sourceUrl: row.source_url,
    hasPhoto: row.has_photo, observedAt: row.observed_at, fieldClaims: row.field_claims ?? {}, confidence: row.confidence, origin: row.origin,
  }))
}

// ── Sincronización ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface IssueSyncResult { created: number; reopened: number; autoResolved: number; refreshed: number; deferred: number }

interface StoredIssueRow extends Record<string, unknown> {
  id: string; reason: ReviewReason; dedupe_key: string | null; state: ReviewState; entity_refs: ReviewEntityRef[]; resolved_at: string | null; auto_resolved: boolean
}

/**
 * Genera las incidencias que faltan y cierra las que ya no se dan, con una abierta por `dedupe_key`. Escribe solo
 * `review_issues` (no rota la revisión de colección). Nunca crea evidencias ni toca comprobaciones físicas.
 */
export async function syncReviewIssues(tx: DatabaseTransaction, userId: string): Promise<IssueSyncResult> {
  await lockReviewInbox(tx, userId)
  const [editionRows, copyRows, evidenceRows] = [await readEditions(tx, userId), await readCopies(tx, userId), await readEvidence(tx, userId, { claims: false })]
  const desired = deriveReviewIssues({ editions: editionRows, copies: copyRows, evidence: evidenceRows })
  const stored = [...await tx.execute<StoredIssueRow>(sql`
    select i.id, i.reason, i.dedupe_key, i.state, i.entity_refs, to_char(i.resolved_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as resolved_at,
      (i.state = 'resolved' and coalesce(last.kind, 'reopen') = 'reopen') as auto_resolved
    from biblib.review_issues as i
    left join lateral (select d.kind from biblib.review_decisions as d where d.user_id = i.user_id and d.issue_id = i.id order by d.decided_at desc, d.id desc limit 1) as last on true
    where i.user_id = ${userId}::uuid`)].map((row): StoredIssueFacts => ({
    id: row.id, reason: row.reason, dedupeKey: row.dedupe_key, state: row.state, entityRefs: row.entity_refs, resolvedAt: row.resolved_at, autoResolved: row.auto_resolved,
  }))
  const totalRoom = 10_000 - stored.length
  const plan = planIssueSync(desired, stored)
  if (plan.create.length > totalRoom) { plan.deferred += plan.create.length - Math.max(totalRoom, 0); plan.create = plan.create.slice(0, Math.max(totalRoom, 0)) }
  const now = new Date()
  if (plan.autoResolve.length) {
    await tx.update(reviewIssues).set({ state: "resolved", resolvedAt: now, updatedAt: now })
      .where(and(eq(reviewIssues.userId, userId), inArray(reviewIssues.id, plan.autoResolve), eq(reviewIssues.state, "open")))
  }
  if (plan.reopen.length) {
    await tx.update(reviewIssues).set({ state: "open", resolvedAt: null, updatedAt: now })
      .where(and(eq(reviewIssues.userId, userId), inArray(reviewIssues.id, plan.reopen), eq(reviewIssues.state, "resolved")))
  }
  for (const entry of plan.refresh) {
    await tx.update(reviewIssues).set({ entityRefs: entry.entityRefs, updatedAt: now }).where(and(eq(reviewIssues.userId, userId), eq(reviewIssues.id, entry.id)))
  }
  for (let offset = 0; offset < plan.create.length; offset += 200) {
    const batch = plan.create.slice(offset, offset + 200).map((issue) => ({ userId, reason: issue.reason, entityRefs: issue.entityRefs, dedupeKey: issue.dedupeKey }))
    await tx.insert(reviewIssues).values(batch).onConflictDoNothing()
  }
  return { created: plan.create.length, reopened: plan.reopen.length, autoResolved: plan.autoResolve.length, refreshed: plan.refresh.length, deferred: plan.deferred }
}

// ── Listado ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ReviewEntityView {
  kind: ReviewEntityRef["kind"]
  id: string
  title?: string
  isbn13?: string | null
  /** Ejemplar que abre la ficha (`/book/[id]`). */
  copyId?: string
}

export interface ReviewIssueItem {
  id: string
  reason: ReviewReason
  state: ReviewState
  version: string
  dedupeKey: string | null
  createdAt: string
  resolvedAt?: string
  entities: ReviewEntityView[]
  /** Entidades citadas que ya no existen (se descartan al listar). */
  missingEntities: number
  sources: EvidenceSourceKind[]
  lastDecision?: { kind: ReviewDecisionKind; decidedAt: string }
}

export interface ReviewIssuePage {
  items: ReviewIssueItem[]
  nextCursor: string | null
  /** Incidencias por motivo con los estados y fuentes filtrados (sin el filtro de motivo). */
  counts: Partial<Record<ReviewReason, number>>
  sync?: IssueSyncResult
}

interface IssueListRow extends Record<string, unknown> {
  id: string; reason: ReviewReason; state: ReviewState; version: string; dedupe_key: string | null; entity_refs: ReviewEntityRef[]
  created_at: string; resolved_at: string | null; sources: EvidenceSourceKind[] | null; last_kind: ReviewDecisionKind | null; last_at: string | null
}

const refUuid = (column: "edition" | "copy") => sql`case when r.value->>'kind' = ${column} and r.value->>'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (r.value->>'id')::uuid end`

/** Fuentes de una incidencia: tipos de evidencia de sus entidades y, sin evidencia, la fuente primaria de la edición. */
const issueSources = sql`(
  select array_agg(distinct src) from (
    select ev.source_kind as src from jsonb_array_elements(i.entity_refs) as r
      join biblib.bibliographic_evidence as ev on ev.user_id = i.user_id and (ev.edition_id = ${refUuid("edition")} or ev.copy_id = ${refUuid("copy")})
    union
    select case when e.catalogue->>'source' in ('open-library', 'bne', 'google-books') then 'provider' when e.catalogue->>'source' in ('photo', 'manual') then e.catalogue->>'source' else 'import' end
      from jsonb_array_elements(i.entity_refs) as r join biblib.editions as e on e.user_id = i.user_id and e.id = ${refUuid("edition")}
  ) as s)`

function filterConditions(userId: string, filters: ReviewFilters, withReasons: boolean) {
  const states = effectiveStates(filters)
  const parts = [sql`i.user_id = ${userId}::uuid`, sql`i.state in (${sql.join(states.map((state) => sql`${state}`), sql`, `)})`]
  if (withReasons && filters.reasons?.length) parts.push(sql`i.reason in (${sql.join(filters.reasons.map((reason) => sql`${reason}`), sql`, `)})`)
  if (filters.sources?.length) parts.push(sql`${issueSources} && array[${sql.join(filters.sources.map((source) => sql`${source}`), sql`, `)}]::text[]`)
  return sql.join(parts, sql` and `)
}

export async function listReviewIssues(tx: DatabaseTransaction, userId: string, request: { filters: ReviewFilters; cursor?: string | null; limit: number }): Promise<ReviewIssuePage> {
  const cursor = decodeReviewCursor(request.cursor)
  if (request.cursor && !cursor) throw new DomainError("INVALID_INPUT", "La página pedida no es válida. Vuelve a la primera página.")
  const after = cursor ? sql`and (i.created_at, i.id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)` : sql``
  const rows = [...await tx.execute<IssueListRow>(sql`
    select i.id, i.reason, i.state, i.version, i.dedupe_key, i.entity_refs,
      to_char(i.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
      to_char(i.resolved_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as resolved_at,
      ${issueSources} as sources, last.kind as last_kind, to_char(last.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as last_at
    from biblib.review_issues as i
    left join lateral (select d.kind, d.decided_at from biblib.review_decisions as d where d.user_id = i.user_id and d.issue_id = i.id order by d.decided_at desc, d.id desc limit 1) as last on true
    where ${filterConditions(userId, request.filters, true)} ${after}
    order by i.created_at desc, i.id desc limit ${request.limit + 1}`)]
  const page = rows.slice(0, request.limit)
  const counts = Object.fromEntries([...await tx.execute<{ reason: ReviewReason; n: number }>(sql`
    select i.reason, count(*)::int as n from biblib.review_issues as i where ${filterConditions(userId, request.filters, false)} group by i.reason`)].map((row) => [row.reason, row.n]))

  const editionIds = [...new Set(page.flatMap((row) => row.entity_refs.filter((ref) => ref.kind === "edition" && UUID.test(ref.id)).map((ref) => ref.id)))]
  const copyIds = [...new Set(page.flatMap((row) => row.entity_refs.filter((ref) => ref.kind === "copy" && UUID.test(ref.id)).map((ref) => ref.id)))]
  const editionRows = editionIds.length ? await tx.select({ id: editions.id, title: editions.title, isbn13: editions.isbn13 }).from(editions).where(and(eq(editions.userId, userId), inArray(editions.id, editionIds))) : []
  const copyRows = copyIds.length || editionIds.length ? await tx.select({ id: copies.id, editionId: copies.editionId }).from(copies)
    .where(and(eq(copies.userId, userId), sql`(${copyIds.length ? inArray(copies.id, copyIds) : sql`false`} or ${editionIds.length ? inArray(copies.editionId, editionIds) : sql`false`})`))
    .orderBy(copies.createdAt, copies.id) : []
  const editionById = new Map(editionRows.map((row) => [row.id, row]))
  const copyById = new Map(copyRows.map((row) => [row.id, row]))
  const firstCopy = new Map<string, string>()
  for (const row of copyRows) if (!firstCopy.has(row.editionId)) firstCopy.set(row.editionId, row.id)

  const items = page.map((row): ReviewIssueItem => {
    const entities: ReviewEntityView[] = []
    let missing = 0
    for (const ref of row.entity_refs) {
      if (ref.kind === "edition") {
        const edition = editionById.get(ref.id)
        if (!edition) { missing++; continue }
        entities.push({ kind: "edition", id: edition.id, title: edition.title, isbn13: edition.isbn13, ...(firstCopy.get(edition.id) ? { copyId: firstCopy.get(edition.id) } : {}) })
      } else if (ref.kind === "copy") {
        const copy = copyById.get(ref.id)
        if (!copy) { missing++; continue }
        const edition = editionById.get(copy.editionId)
        entities.push({ kind: "copy", id: copy.id, copyId: copy.id, ...(edition ? { title: edition.title, isbn13: edition.isbn13 } : {}) })
      } else missing++
    }
    return {
      id: row.id, reason: row.reason, state: row.state, version: row.version, dedupeKey: row.dedupe_key, createdAt: row.created_at,
      ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}), entities, missingEntities: missing, sources: row.sources ?? [],
      ...(row.last_kind && row.last_at ? { lastDecision: { kind: row.last_kind, decidedAt: row.last_at } } : {}),
    }
  })
  const last = page.at(-1)
  return { items, nextCursor: rows.length > request.limit && last ? encodeReviewCursor({ createdAt: last.created_at, id: last.id }) : null, counts }
}

// ── Estado para comparar y planificar ────────────────────────────────────────────────────────────────────────────────

export async function readIssues(tx: DatabaseTransaction, userId: string, ids: readonly string[]): Promise<IssueFacts[]> {
  if (!ids.length) return []
  const rows = await tx.select({ id: reviewIssues.id, version: reviewIssues.version, reason: reviewIssues.reason, state: reviewIssues.state, dedupeKey: reviewIssues.dedupeKey, entityRefs: reviewIssues.entityRefs })
    .from(reviewIssues).where(and(eq(reviewIssues.userId, userId), inArray(reviewIssues.id, [...ids])))
  return rows.map((row) => ({ id: row.id, version: row.version, reason: row.reason, state: row.state, dedupeKey: row.dedupeKey, entityRefs: row.entityRefs }))
}

/** IDs de edición y ejemplar válidos citados por las incidencias y las decisiones. */
function citedIds(issues: readonly IssueFacts[], decisions: readonly ProposedDecision[]) {
  const editionIds = new Set<string>()
  const copyIds = new Set<string>()
  for (const issue of issues) for (const ref of issue.entityRefs) {
    if (!UUID.test(ref.id)) continue
    if (ref.kind === "edition") editionIds.add(ref.id)
    if (ref.kind === "copy") copyIds.add(ref.id)
  }
  for (const decision of decisions) {
    if (decision.kind === "accept_fields") editionIds.add(decision.editionId)
    if (decision.kind === "confirm_physical") copyIds.add(decision.copyId)
    if (decision.kind === "merge") [decision.targetEditionId, ...decision.sourceEditionIds].forEach((id) => editionIds.add(id))
  }
  return { editionIds: [...editionIds], copyIds: [...copyIds] }
}

export interface LoadedReviewState extends Omit<PlanState, "providers"> {
  editionList: EditionFacts[]
  copyList: CopyFacts[]
  evidenceList: EvidenceFacts[]
}

export async function loadReviewState(tx: DatabaseTransaction, userId: string, issueIds: readonly string[], decisions: readonly ProposedDecision[] = []): Promise<LoadedReviewState> {
  const issues = await readIssues(tx, userId, issueIds)
  const { editionIds, copyIds } = citedIds(issues, decisions)
  const copyRows = await readCopies(tx, userId, { ids: copyIds, editionIds })
  const allEditionIds = [...new Set([...editionIds, ...copyRows.map((copy) => copy.editionId)])]
  const editionRows = await readEditions(tx, userId, allEditionIds)
  const evidenceRows = await readEvidence(tx, userId, { claims: true, editionIds: allEditionIds, copyIds: copyRows.map((copy) => copy.id) })
  const keys = issues.flatMap((issue) => [issue.dedupeKey, ...editionRows.map((edition) => `source_conflict:${edition.id}`)]).filter((key): key is string => Boolean(key))
  const openKeys = keys.length ? new Set((await tx.select({ key: reviewIssues.dedupeKey }).from(reviewIssues)
    .where(and(eq(reviewIssues.userId, userId), eq(reviewIssues.state, "open"), inArray(reviewIssues.dedupeKey, [...new Set(keys)])))).flatMap((row) => row.key ? [row.key] : [])) : new Set<string>()
  return {
    issues: new Map(issues.map((issue) => [issue.id, issue])), editions: new Map(editionRows.map((edition) => [edition.id, edition])),
    copies: new Map(copyRows.map((copy) => [copy.id, copy])), evidence: new Map(evidenceRows.map((entry) => [entry.id, entry])), openKeys,
    editionList: editionRows, copyList: copyRows, evidenceList: evidenceRows,
  }
}

export interface DecisionHistoryEntry { kind: ReviewDecisionKind; decidedAt: string; selectedFields: Record<string, unknown>; evidenceRefs: string[] }

export async function decisionHistory(tx: DatabaseTransaction, userId: string, issueId: string): Promise<DecisionHistoryEntry[]> {
  const rows = await tx.select({ kind: reviewDecisions.kind, decidedAt: reviewDecisions.decidedAt, selectedFields: reviewDecisions.selectedFields, evidenceRefs: reviewDecisions.evidenceRefs })
    .from(reviewDecisions).where(and(eq(reviewDecisions.userId, userId), eq(reviewDecisions.issueId, issueId))).orderBy(reviewDecisions.decidedAt, reviewDecisions.id).limit(100)
  return rows.map((row) => ({ kind: row.kind, decidedAt: row.decidedAt.toISOString(), selectedFields: row.selectedFields, evidenceRefs: row.evidenceRefs }))
}

// ── Huellas y aplicación ─────────────────────────────────────────────────────────────────────────────────────────────

export function rowDigest(userId: string, row: PlanRow, decision: ProposedDecision): string {
  return sha256(canonicalJson({ scope: "biblib.review.row.v1", owner: userId, row: rowDigestView(row, decision) }))
}

/**
 * Identificador de una vista previa sin estado: huella de dueño, revisión, caducidad, decisiones y filas. No es una
 * autorización (cada escritura vuelve a comprobar versiones, dueño y RLS): garantiza que se aplica lo que se revisó.
 */
export function previewDigest(input: { userId: string; revision: string; expiresAt: string; decisions: readonly ProposedDecision[]; rowDigests: readonly string[] }): string {
  return sha256(canonicalJson({ scope: "biblib.review.preview.v1", owner: input.userId, revision: input.revision, expiresAt: input.expiresAt, decisions: input.decisions, rows: input.rowDigests }))
}

export function planBatch(state: LoadedReviewState, providers: ReadonlyMap<ColumnKey, BibliographicCandidate>, decisions: readonly ProposedDecision[], now: string): { rows: PlanRow[]; summary: BatchSummary } {
  return planReviewBatch({ ...state, providers }, decisions, now)
}

const rowConflict = (message: string) => new DomainError("CONFLICT", message)

/** Ejecuta las operaciones de una fila ya planificada. Cualquier versión distinta lanza `CONFLICT`. */
async function executeRow(tx: DatabaseTransaction, userId: string, row: PlanRow, operationId: string, decisionId: string): Promise<void> {
  const created: string[] = []
  const now = new Date()
  const operations: PlanOperation[] = [...row.ops.filter((op) => op.op !== "verify_copy" && op.op !== "set_issue_state"), ...row.ops.filter((op) => op.op === "verify_copy"), ...row.ops.filter((op) => op.op === "set_issue_state")]
  for (const op of operations) {
    switch (op.op) {
      case "update_edition": {
        const values = op.values
        const [updated] = await tx.update(editions).set({
          ...(values.title !== undefined ? { title: String(values.title) } : {}),
          ...(values.subtitle !== undefined ? { subtitle: String(values.subtitle) } : {}),
          ...(values.authors !== undefined ? { authors: values.authors as EditionFacts["authors"] } : {}),
          ...(values.publishers !== undefined ? { publishers: values.publishers as EditionFacts["publishers"] } : {}),
          ...(values.publish_date !== undefined ? { publishDate: String(values.publish_date) } : {}),
          ...(values.number_of_pages !== undefined ? { numberOfPages: Number(values.number_of_pages) } : {}),
          catalogue: op.catalogue, updatedAt: now,
        }).where(and(eq(editions.userId, userId), eq(editions.id, op.editionId), eq(editions.version, op.expectedVersion))).returning({ id: editions.id })
        if (!updated) throw rowConflict("La edición ha cambiado desde que la revisaste.")
        break
      }
      case "insert_evidence": {
        const entry = op.evidence
        const [inserted] = await tx.insert(bibliographicEvidence).values({
          userId, ...(entry.subject.kind === "edition" ? { editionId: entry.subject.id } : { copyId: entry.subject.id }), sourceKind: entry.sourceKind,
          sourceRef: entry.sourceRef ?? null, sourceUrl: entry.sourceUrl ?? null, observedAt: entry.observedAt ? new Date(entry.observedAt) : null,
          fieldClaims: entry.fieldClaims, confidence: entry.confidence, origin: "review",
        }).returning({ id: bibliographicEvidence.id })
        created.push(inserted.id)
        break
      }
      case "verify_copy": {
        const refs = created.slice(0, 10)
        const [updated] = await tx.update(copies).set({
          editionVerification: sql`${copies.editionVerification} || ${JSON.stringify({ isbnVerified: true, checkedAt: now.toISOString(), evidenceRefs: refs })}::jsonb`, updatedAt: now,
        }).where(and(eq(copies.userId, userId), eq(copies.id, op.copyId), eq(copies.version, op.expectedVersion))).returning({ id: copies.id })
        if (!updated) throw rowConflict("El ejemplar ha cambiado desde que lo revisaste.")
        break
      }
      case "merge_editions": {
        // La revisión vigente dentro de esta misma transacción: el lote ya comprobó la que vio la persona.
        const revision = await lockLibrary(tx)
        await mergeEditions(tx, userId, { sourceIds: op.sourceIds, targetId: op.targetId, expectedVersions: op.expectedVersions, expectedRevision: revision, idempotencyKey: `review-merge-${digestUuid(`${operationId}:${row.index}`).replaceAll("-", "")}` })
        break
      }
      case "open_issue":
        await tx.insert(reviewIssues).values({ userId, reason: op.reason, entityRefs: op.entityRefs, dedupeKey: op.dedupeKey }).onConflictDoNothing()
        break
      case "set_issue_state": {
        const [updated] = await tx.update(reviewIssues).set({ state: op.state, resolvedAt: op.state === "open" ? null : now, updatedAt: now })
          .where(and(eq(reviewIssues.userId, userId), eq(reviewIssues.id, op.issueId), eq(reviewIssues.version, op.expectedVersion))).returning({ id: reviewIssues.id })
        if (!updated) throw rowConflict("La incidencia ha cambiado desde que la revisaste.")
        break
      }
    }
  }
  await tx.insert(reviewDecisions).values({
    id: decisionId, userId, issueId: row.issueId, kind: row.kind, selectedFields: row.selectedFields,
    evidenceRefs: [...row.evidenceRefs, ...created].slice(0, REVIEW_LIMITS.evidenceRefs), operationId,
  })
}

export type ApplyMode = "atomic" | "partial"

export interface ReviewRowOutcome {
  index: number
  issueId: string
  kind: ReviewDecisionKind
  outcome: "applied" | "conflict" | "invalid"
  message?: string
}

export interface ReviewBatchReport {
  operationId: string
  mode: ApplyMode
  /** `replayed`: la misma confirmación ya se había aplicado; se devuelve su resultado durable. */
  status: "applied" | "partial" | "replayed"
  applied: number
  failed: number
  rows: ReviewRowOutcome[]
}

export interface ApplyRequest {
  operation: "review.apply" | "review.decide"
  idempotencyKey: string
  /** Huella de lo que se revisó; `null` en una decisión individual (sin vista previa). */
  previewId: string | null
  /** Revisión que se vio al preparar; en modo parcial no se exige, cada fila compara sus versiones. */
  expectedRevision: string | null
  decisions: readonly ProposedDecision[]
  /** Huella por fila de la vista previa, en el orden de `decisions`. */
  rowDigests: readonly string[] | null
  mode: ApplyMode
  providers: ReadonlyMap<ColumnKey, BibliographicCandidate>
  /** Caducidad de la vista previa; una repetición de una confirmación ya aplicada recupera su resultado aunque haya caducado. */
  expiresAt?: string
}

const decisionIdFor = (operationId: string, previewId: string | null, index: number, decision: ProposedDecision) =>
  digestUuid(canonicalJson({ operationId, previewId, index, decision }))

/**
 * Aplica decisiones bajo el bloqueo de colección y de la bandeja. Modo atómico: cualquier fila distinta de la vista
 * previa o en conflicto aborta todo (`CONFLICT`/`REVISION_CONFLICT`, nada aplicado). Modo parcial (elección explícita):
 * cada fila válida se aplica en su propio punto de guardado y el informe dice qué pasó con cada una.
 */
export async function applyReviewDecisions(tx: DatabaseTransaction, userId: string, request: ApplyRequest): Promise<ReviewBatchReport> {
  const revision = await lockLibrary(tx)
  await lockReviewInbox(tx, userId)
  const operationId = digestUuid(canonicalJson({ scope: "biblib.review.operation.v1", owner: userId, operation: request.operation, key: request.idempotencyKey }))
  const expectedIds = request.decisions.map((decision, index) => decisionIdFor(operationId, request.previewId, index, decision))
  const previous = await tx.select({ id: reviewDecisions.id }).from(reviewDecisions).where(and(eq(reviewDecisions.userId, userId), eq(reviewDecisions.operationId, operationId)))
  if (previous.length) {
    const applied = new Set(previous.map((row) => row.id))
    if (![...applied].every((id) => expectedIds.includes(id))) {
      throw new DomainError("IDEMPOTENCY_CONFLICT", "Esta confirmación ya se usó con otras decisiones. No se ha aplicado nada; prepara una revisión nueva.")
    }
    const rows = request.decisions.map((decision, index): ReviewRowOutcome => applied.has(expectedIds[index])
      ? { index, issueId: decision.issueId, kind: decision.kind, outcome: "applied" }
      : { index, issueId: decision.issueId, kind: decision.kind, outcome: "conflict", message: "No se aplicó en la confirmación original." })
    return { operationId, mode: request.mode, status: "replayed", applied: applied.size, failed: rows.length - applied.size, rows }
  }
  if (request.expiresAt && Date.parse(request.expiresAt) < Date.now()) {
    throw new DomainError("PREVIEW_EXPIRED", "La vista previa del lote ha caducado. No se ha aplicado nada: vuelve a prepararla con los datos actuales.")
  }
  if (request.mode === "atomic" && request.expectedRevision && revision !== request.expectedRevision) {
    throw new DomainError("REVISION_CONFLICT", "Tu biblioteca ha cambiado desde que preparaste este lote. No se ha aplicado nada: vuelve a preparar la vista previa.")
  }
  const state = await loadReviewState(tx, userId, [...new Set(request.decisions.map((decision) => decision.issueId))], request.decisions)
  const { rows } = planBatch(state, request.providers, request.decisions, new Date().toISOString())
  const matches = rows.map((row, index) => row.status === "ready" && (!request.rowDigests || request.rowDigests[index] === rowDigest(userId, row, request.decisions[index])))
  if (request.mode === "atomic" && matches.some((ok) => !ok)) {
    const stale = matches.filter((ok) => !ok).length
    const first = rows.find((row, index) => !matches[index])
    // Una decisión individual responde con el motivo concreto de su fila.
    if (!request.previewId && first?.message) throw new DomainError(first.status === "invalid" ? "INVALID_INPUT" : "CONFLICT", `${first.message} No se ha aplicado nada.`)
    throw new DomainError("CONFLICT", `${stale === 1 ? "Una decisión del lote ya no coincide" : `${stale} decisiones del lote ya no coinciden`} con los datos actuales${first?.message ? ` (${first.message.replace(/\.$/, "")})` : ""}. No se ha aplicado nada: vuelve a preparar la vista previa.`)
  }
  const outcomes: ReviewRowOutcome[] = []
  for (const [index, row] of rows.entries()) {
    const base = { index, issueId: row.issueId, kind: row.kind }
    if (!matches[index]) {
      outcomes.push({ ...base, outcome: row.status === "invalid" ? "invalid" : "conflict", message: row.message ?? "Los datos cambiaron desde la vista previa." })
      continue
    }
    if (request.mode === "atomic") {
      await executeRow(tx, userId, row, operationId, expectedIds[index])
      outcomes.push({ ...base, outcome: "applied" })
      continue
    }
    try {
      await tx.transaction((savepoint) => executeRow(savepoint, userId, row, operationId, expectedIds[index]))
      outcomes.push({ ...base, outcome: "applied" })
    } catch (error) {
      if (databaseErrorCode(error) === "BD001") throw error
      const message = error instanceof DomainError ? error.message : "No se pudo aplicar esta decisión."
      outcomes.push({ ...base, outcome: error instanceof DomainError && error.code === "INVALID_INPUT" ? "invalid" : "conflict", message })
    }
  }
  const applied = outcomes.filter((row) => row.outcome === "applied").length
  return { operationId, mode: request.mode, status: applied === outcomes.length ? "applied" : "partial", applied, failed: outcomes.length - applied, rows: outcomes }
}

/** Traduce los fallos de Postgres de la bandeja a errores de dominio en español. */
export function translateReviewError(error: unknown): never {
  if (databaseErrorCode(error) === "BP001") throw new DomainError("LIMIT_EXCEEDED", "Se ha alcanzado el límite de incidencias o evidencias de tu cuenta. No se ha aplicado nada.")
  if (databaseErrorCode(error) === "23505") throw new DomainError("CONFLICT", "Otra revisión ha cambiado estas incidencias al mismo tiempo. No se ha aplicado nada; vuelve a cargar la bandeja.")
  if (databaseErrorCode(error) === "23503") throw new DomainError("NOT_FOUND", "Alguna ficha o evidencia ya no está disponible. No se ha aplicado nada.")
  translateDatabaseError(error)
}
