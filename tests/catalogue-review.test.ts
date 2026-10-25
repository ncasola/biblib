import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import type { BibliographicCandidate } from "../lib/bibliographic-catalog/types"
import {
  comparisonRows, decodeReviewCursor, deriveReviewIssues, editionColumn, encodeReviewCursor, evidenceColumn, parseReviewQuery, planIssueSync, planReviewBatch,
  proposedDecisionSchema, providerColumn, providerColumnKey, rowDigestView, serializeReviewQuery,
  type CopyFacts, type EditionFacts, type EvidenceFacts, type IssueFacts, type PlanState, type ProposedDecision, type StoredIssueFacts,
} from "../lib/catalogue-review"
import { normalizeIsbn } from "../lib/isbn"
import type { Book, EditionCatalogue } from "../lib/types"

// U-DAT-07 · lógica pura de la bandeja de revisión: incidencias derivadas, sincronización, cursor, comparación y plan
// de decisiones, con candidatos de proveedor simulados (ediciones parecidas y datos contradictorios).

let sequence = 0
const uuid = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`
const version = () => uuid()
const NOW = "2026-10-25T10:00:00.000Z"

function edition(overrides: Partial<EditionFacts> = {}): EditionFacts {
  return {
    id: uuid(), version: version(), workId: null, isbn13: "9788401337208", title: "El nombre del viento", subtitle: null, authors: [{ name: "Patrick Rothfuss" }],
    publishers: [{ name: "Plaza & Janés" }], publishDate: "2009", numberOfPages: 872, catalogue: { source: "open-library" },
    covers: { small: "https://covers.example/s.jpg", medium: "https://covers.example/m.jpg", large: "https://covers.example/l.jpg" }, coverAssetId: null, copies: 1,
    ...overrides,
  }
}
const copyOf = (owner: EditionFacts, overrides: Partial<CopyFacts> = {}): CopyFacts => ({ id: uuid(), version: version(), editionId: owner.id, isbnVerified: false, ...overrides })
function evidence(overrides: Partial<EvidenceFacts>): EvidenceFacts {
  return { id: uuid(), editionId: null, copyId: null, sourceKind: "manual", sourceRef: null, sourceUrl: null, hasPhoto: false, observedAt: null, fieldClaims: {}, confidence: "provisional", origin: "review", ...overrides }
}
function candidate(overrides: Partial<BibliographicCandidate> = {}): BibliographicCandidate {
  return {
    provider: "open-library", level: "edition", recordId: "OL1M", sourceUrl: "https://openlibrary.org/books/OL1M", isbns: ["9788401337208"],
    title: "El nombre del viento", authors: [{ name: "Patrick Rothfuss" }], publishers: [{ name: "Plaza & Janés" }], publishDate: "2009", numberOfPages: 880,
    evidence: { isbnExact: true }, retrievedAt: "2026-10-25T09:00:00.000Z", ...overrides,
  }
}

function state(input: { issues: IssueFacts[]; editions?: EditionFacts[]; copies?: CopyFacts[]; evidence?: EvidenceFacts[]; providers?: BibliographicCandidate[]; openKeys?: string[] }): PlanState {
  return {
    issues: new Map(input.issues.map((issue) => [issue.id, issue])), editions: new Map((input.editions ?? []).map((entry) => [entry.id, entry])),
    copies: new Map((input.copies ?? []).map((entry) => [entry.id, entry])), evidence: new Map((input.evidence ?? []).map((entry) => [entry.id, entry])),
    providers: new Map((input.providers ?? []).map((entry, index) => [providerColumnKey(entry, index), entry])), openKeys: new Set(input.openKeys ?? []),
  }
}
const issue = (overrides: Partial<IssueFacts>): IssueFacts => ({ id: uuid(), version: version(), reason: "provisional", state: "open", dedupeKey: null, entityRefs: [], ...overrides })
const decision = (value: unknown): ProposedDecision => proposedDecisionSchema.parse(value)

test("la importación de referencia de 111 registros genera incidencias adecuadas y ninguna comprobación física", () => {
  const file = JSON.parse(readFileSync(path.join(process.cwd(), "tests", "fixtures", "import", "sintetico-111.json"), "utf8")) as { books: Book[] }
  const editions = file.books.map((book) => edition({
    id: book.id, isbn13: normalizeIsbn(book.isbn ?? ""), title: book.title, authors: book.authors, catalogue: { source: book.catalogue?.source ?? "import" } as EditionCatalogue,
    covers: book.cover,
  }))
  const copies = editions.map((entry) => copyOf(entry))
  const issues = deriveReviewIssues({ editions, copies, evidence: [] })
  const count = (reason: string) => issues.filter((entry) => entry.reason === reason).length
  assert.equal(file.books.length, 111)
  assert.equal(count("missing_isbn"), 9, "los 9 identificadores manuales quedan sin ISBN")
  assert.equal(count("missing_cover"), 9)
  assert.equal(count("provisional"), 76, "los ISBN de importación sin ficha bibliográfica quedan provisionales; los de Open Library no")
  assert.equal(count("duplicate_candidate"), 0)
  assert.equal(new Set(issues.map((entry) => entry.dedupeKey)).size, issues.length, "una clave por incidencia")
  assert.deepEqual(deriveReviewIssues({ editions: [...editions].reverse(), copies, evidence: [] }), issues, "claves y orden estables")
  assert.ok(copies.every((entry) => !entry.isbnVerified))
})

test("una comprobación física o una coincidencia bibliográfica retira el ISBN provisional; una foto sin comprobar abre una duda", () => {
  const imported = edition({ catalogue: { source: "import" } })
  const checked = edition({ isbn13: "9780000000019", catalogue: { source: "photo" } })
  const matched = edition({ isbn13: "9780000000026", catalogue: { source: "manual" } })
  const imported2 = copyOf(imported)
  const checkedCopy = copyOf(checked, { isbnVerified: true })
  const photo = evidence({ copyId: imported2.id, sourceKind: "photo", hasPhoto: true })
  const issues = deriveReviewIssues({
    editions: [imported, checked, matched], copies: [imported2, checkedCopy, copyOf(matched)],
    evidence: [photo, evidence({ editionId: matched.id, sourceKind: "provider", sourceRef: "bne", confidence: "bibliographic_match" }), evidence({ copyId: checkedCopy.id, sourceKind: "photo" })],
  })
  assert.deepEqual(issues.map((entry) => entry.dedupeKey), [`photo_doubt:${photo.id}`, `provisional:${imported.id}`])
  assert.deepEqual(issues[0].entityRefs, [{ kind: "copy", id: imported2.id }, { kind: "edition", id: imported.id }])
})

test("candidatos duplicados: mismo título y autoría; ni homónimos ni autores iguales con obras distintas", () => {
  const base = edition({ isbn13: null, title: "Poemas", authors: [{ name: "Ana Pérez" }] })
  const same = edition({ isbn13: "9780000000019", title: "  POEMAS ", authors: [{ name: "ana perez" }] })
  const homonym = edition({ isbn13: null, title: "Poemas", authors: [{ name: "Luis Gómez" }] })
  const otherWork = edition({ isbn13: null, title: "Cuentos", authors: [{ name: "Ana Pérez" }] })
  const noAuthors = [edition({ isbn13: null, title: "Anónimo", authors: [] }), edition({ isbn13: null, title: "Anónimo", authors: [] })]
  const issues = deriveReviewIssues({ editions: [base, same, homonym, otherWork, ...noAuthors], copies: [], evidence: [] }).filter((entry) => entry.reason === "duplicate_candidate")
  assert.equal(issues.length, 1)
  assert.deepEqual(issues[0].entityRefs.map((ref) => ref.id).sort(), [base.id, same.id].sort())
  assert.match(issues[0].dedupeKey, /^duplicate_candidate:[0-9a-f-]{36}:2:[0-9a-f]{8}$/)

  // Dos ISBN distintos u obras distintas nunca son la misma edición: cada una se agrupa solo con las que no tienen.
  const first = edition({ isbn13: "9780000000019", title: "Mapa", authors: [{ name: "Eva" }] })
  const second = edition({ isbn13: "9780000000026", title: "Mapa", authors: [{ name: "Eva" }] })
  const third = edition({ isbn13: "9780000000033", title: "Mapa", authors: [{ name: "Eva" }] })
  const groups = deriveReviewIssues({ editions: [first, second, third], copies: [], evidence: [] }).filter((entry) => entry.reason === "duplicate_candidate")
  assert.equal(groups.length, 0)
  const loose = edition({ isbn13: null, title: "Mapa", authors: [{ name: "Eva" }] })
  const withLoose = deriveReviewIssues({ editions: [first, second, loose], copies: [], evidence: [] }).filter((entry) => entry.reason === "duplicate_candidate")
  assert.equal(withLoose.length, 2)
  assert.ok(withLoose.every((entry) => entry.entityRefs.length === 2 && entry.entityRefs.some((ref) => ref.id === loose.id)))
  const workA = edition({ isbn13: null, workId: uuid(), title: "Obra", authors: [{ name: "Eva" }] })
  const workB = edition({ isbn13: null, workId: uuid(), title: "Obra", authors: [{ name: "Eva" }] })
  assert.equal(deriveReviewIssues({ editions: [workA, workB], copies: [], evidence: [] }).filter((entry) => entry.reason === "duplicate_candidate").length, 0)
})

test("la sincronización mantiene una abierta por clave y respeta lo que decidió la persona", () => {
  const refs = [{ kind: "edition" as const, id: uuid() }]
  const desired = ["a", "b", "c", "d", "e"].map((key) => ({ reason: "missing_cover" as const, dedupeKey: `missing_cover:${key}`, entityRefs: refs }))
  const stored = (overrides: Partial<StoredIssueFacts>): StoredIssueFacts => ({ id: uuid(), reason: "missing_cover", dedupeKey: null, state: "open", entityRefs: refs, resolvedAt: null, autoResolved: false, ...overrides })
  const open = stored({ dedupeKey: "missing_cover:a" })
  const ignored = stored({ dedupeKey: "missing_cover:b", state: "ignored", resolvedAt: NOW })
  const human = stored({ dedupeKey: "missing_cover:c", state: "resolved", resolvedAt: NOW })
  const auto = stored({ dedupeKey: "missing_cover:d", state: "resolved", resolvedAt: NOW, autoResolved: true })
  const vanished = stored({ dedupeKey: "missing_cover:z" })
  const conflict = stored({ reason: "source_conflict", dedupeKey: "source_conflict:x" })
  const plan = planIssueSync(desired, [open, ignored, human, auto, vanished, conflict])
  assert.deepEqual(plan.create.map((entry) => entry.dedupeKey), ["missing_cover:e"])
  assert.deepEqual(plan.reopen, [auto.id])
  assert.deepEqual(plan.autoResolve, [vanished.id], "source_conflict no se cierra sola")
  assert.equal(plan.deferred, 0)
  const limited = planIssueSync(desired, [], 3)
  assert.equal(limited.create.length, 3)
  assert.equal(limited.deferred, 2, "lo que no cabe se informa, no se descarta en silencio")
})

test("cursor y parámetros de la bandeja sobreviven a abrir una ficha y volver", () => {
  const cursor = encodeReviewCursor({ createdAt: "2026-10-25T10:00:00.123456Z", id: "00000000-0000-4000-8000-000000000001" })
  assert.deepEqual(decodeReviewCursor(cursor), { createdAt: "2026-10-25T10:00:00.123456Z", id: "00000000-0000-4000-8000-000000000001" })
  assert.equal(decodeReviewCursor("2026-10-25T10:00:00Z~x"), null)
  const query = serializeReviewQuery({ reasons: ["missing_cover", "missing_isbn"], sources: ["import"], states: ["open", "ignored"] }, cursor)
  const parsed = parseReviewQuery(new URLSearchParams(query.slice(1)))
  assert.deepEqual(parsed, { filters: { reasons: ["missing_cover", "missing_isbn"], sources: ["import"], states: ["open", "ignored"] }, cursor })
  assert.deepEqual(parseReviewQuery(new URLSearchParams("motivo=desconocido&estado=open&desde=roto")), { filters: { states: ["open"] }, cursor: null })
})

test("la comparación muestra cada valor con su fuente y marca los datos contradictorios; Google solo es vista previa", () => {
  const current = edition({ catalogue: { schemaVersion: 2, source: "import", fields: { title: { provider: "manual", selection: "manually-verified" } } } })
  const ol = candidate()
  const bne = candidate({ provider: "bne", recordId: "991", sourceUrl: "https://catalogo.bne.es/991", title: "Nombre del viento", publishDate: "2011" })
  const google = candidate({ provider: "google-books", recordId: "g1", sourceUrl: undefined })
  const photo = evidence({ editionId: current.id, sourceKind: "photo", hasPhoto: true, fieldClaims: { values: { title: "El nombre del viento", publish_date: "2010" } } })
  const columns = [editionColumn(current, 0), evidenceColumn(photo)!, providerColumn(ol, 0), providerColumn(bne, 1), providerColumn(google, 2)]
  assert.equal(evidenceColumn(evidence({ editionId: current.id, fieldClaims: { fields: {} } })), null, "una evidencia sin valores no es una columna")
  const rows = comparisonRows(columns)
  const byField = Object.fromEntries(rows.map((row) => [row.field, row]))
  assert.equal(byField.title.differs, true)
  assert.equal(byField.publish_date.differs, true)
  assert.equal(byField.authors.differs, false)
  assert.equal(byField.title.cells[0].source, "Entrada manual · comprobado en tu ejemplar")
  assert.equal(byField.authors.cells[0].source, "Importación · ficha completa")
  assert.match(byField.title.cells[1].source ?? "", /Foto propia · provisional/)
  assert.equal(columns[4].selectable, false)
  assert.match(columns[4].notSelectableReason ?? "", /vista previa/)
  assert.equal(columns[2].selectable && columns[3].selectable, true)
})

test("aceptar campos cambia solo los elegidos, cita la fuente y nunca comprueba el ejemplar", () => {
  const current = edition({ catalogue: { source: "import" }, title: "El nombre del bienio", numberOfPages: 10, copies: 2 })
  const copy = copyOf(current)
  const open = issue({ reason: "provisional", entityRefs: [{ kind: "edition", id: current.id }, { kind: "copy", id: copy.id }] })
  const ol = candidate()
  const plan = planReviewBatch(state({ issues: [open], editions: [current], copies: [copy], providers: [ol] }), [decision({
    issueId: open.id, expectedVersion: open.version, kind: "accept_fields", editionId: current.id, editionVersion: current.version, fields: { title: providerColumnKey(ol, 0) },
  })], NOW)
  const [row] = plan.rows
  assert.equal(row.status, "ready")
  const update = row.ops.find((op) => op.op === "update_edition")
  assert.ok(update && update.op === "update_edition")
  assert.deepEqual(update.values, { title: "El nombre del viento" }, "las páginas, la autoría y el resto se conservan")
  assert.equal("fields" in update.catalogue && update.catalogue.fields?.title?.provider, "open-library")
  const inserted = row.ops.filter((op) => op.op === "insert_evidence")
  assert.equal(inserted.length, 1)
  assert.ok(inserted.every((op) => op.op === "insert_evidence" && op.evidence.confidence === "bibliographic_match" && op.evidence.sourceRef === "open-library:OL1M"))
  assert.ok(!row.ops.some((op) => op.op === "verify_copy"), "una ficha pública conserva el ejemplar provisional")
  assert.ok(row.effects.some((text) => text.includes("2 ejemplares")))
  assert.ok(row.effects.some((text) => text.startsWith("Se conservan sin cambios")))
  assert.deepEqual(plan.summary, { ready: 1, conflicts: 0, invalid: 0, creates: 1, updates: 2, merges: 0 })
})

test("conflictos y decisiones imposibles: versión antigua, fuente eliminada, Google, duplicados en el lote", () => {
  const current = edition()
  const open = issue({ entityRefs: [{ kind: "edition", id: current.id }] })
  const second = issue({ reason: "missing_cover", entityRefs: [{ kind: "edition", id: current.id }] })
  const google = candidate({ provider: "google-books", recordId: "g1" })
  const gone = uuid()
  const view = state({ issues: [open, second], editions: [current], providers: [google] })
  const rows = planReviewBatch(view, [
    decision({ issueId: open.id, expectedVersion: version(), kind: "ignore" }),
    decision({ issueId: open.id, expectedVersion: open.version, kind: "accept_fields", editionId: current.id, editionVersion: current.version, fields: { title: `evidence:${gone}` } }),
  ], NOW).rows
  assert.deepEqual(rows.map((row) => [row.status, row.message]), [["conflict", "La incidencia ha cambiado desde que la revisaste."], ["conflict", "La fuente que elegiste se ha eliminado o ya no pertenece a esta edición."]])
  const blocked = planReviewBatch(view, [decision({ issueId: open.id, expectedVersion: open.version, kind: "accept_fields", editionId: current.id, editionVersion: current.version, fields: { title: providerColumnKey(google, 0) } })], NOW).rows[0]
  assert.equal(blocked.status, "invalid")
  const twice = planReviewBatch(view, [
    decision({ issueId: open.id, expectedVersion: open.version, kind: "ignore" }),
    decision({ issueId: open.id, expectedVersion: open.version, kind: "ignore" }),
    decision({ issueId: second.id, expectedVersion: second.version, kind: "accept_fields", editionId: current.id, editionVersion: version(), fields: { title: `edition:${current.id}` } }),
  ], NOW).rows
  assert.deepEqual(twice.map((row) => row.status), ["ready", "invalid", "conflict"])
  assert.equal(planReviewBatch(view, [decision({ issueId: uuid(), expectedVersion: version(), kind: "ignore" })], NOW).rows[0].message, "La incidencia ya no existe.")
})

test("ignorar no borra evidencias y reabrir exige que no haya otra abierta igual", () => {
  const ignored = issue({ state: "ignored", dedupeKey: "missing_cover:x" })
  const rows = planReviewBatch(state({ issues: [ignored], openKeys: ["missing_cover:x"] }), [decision({ issueId: ignored.id, expectedVersion: ignored.version, kind: "reopen" })], NOW).rows
  assert.equal(rows[0].status, "conflict")
  const open = issue({})
  const ignore = planReviewBatch(state({ issues: [open] }), [decision({ issueId: open.id, expectedVersion: open.version, kind: "ignore" })], NOW).rows[0]
  assert.deepEqual(ignore.ops, [{ op: "set_issue_state", issueId: open.id, expectedVersion: open.version, state: "ignored" }])
})

test("la comprobación física solo existe con confirmación explícita y sobre un ejemplar con ISBN", () => {
  const owner = edition()
  const copy = copyOf(owner)
  const open = issue({ reason: "photo_doubt", entityRefs: [{ kind: "copy", id: copy.id }, { kind: "edition", id: owner.id }] })
  const base = { issueId: open.id, expectedVersion: open.version, kind: "confirm_physical", copyId: copy.id, copyVersion: copy.version }
  assert.equal(proposedDecisionSchema.safeParse(base).success, false)
  assert.equal(proposedDecisionSchema.safeParse({ ...base, confirmed: false }).success, false)
  const row = planReviewBatch(state({ issues: [open], editions: [owner], copies: [copy] }), [decision({ ...base, confirmed: true })], NOW).rows[0]
  assert.equal(row.status, "ready")
  assert.ok(row.ops.some((op) => op.op === "verify_copy" && op.copyId === copy.id))
  assert.ok(row.ops.some((op) => op.op === "insert_evidence" && op.evidence.confidence === "physically_checked" && op.evidence.subject.kind === "copy"))
  const noIsbn = edition({ isbn13: null })
  const loose = copyOf(noIsbn)
  const other = issue({ reason: "missing_isbn", entityRefs: [{ kind: "edition", id: noIsbn.id }, { kind: "copy", id: loose.id }] })
  assert.equal(planReviewBatch(state({ issues: [other], editions: [noIsbn], copies: [loose] }), [decision({ issueId: other.id, expectedVersion: other.version, kind: "confirm_physical", copyId: loose.id, copyVersion: loose.version, confirmed: true })], NOW).rows[0].status, "invalid")
})

test("fusionar con discrepancias abre una resolución en lugar de sobrescribir; ISBN u obras distintas no se fusionan", () => {
  const target = edition({ isbn13: null, title: "Poemas", publishDate: "1990", copies: 1 })
  const source = edition({ isbn13: "9780000000019", title: "Poemas", publishDate: "1991", numberOfPages: 100, copies: 2 })
  const open = issue({ reason: "duplicate_candidate", entityRefs: [{ kind: "edition", id: target.id }, { kind: "edition", id: source.id }] })
  const merge = decision({ issueId: open.id, expectedVersion: open.version, kind: "merge", targetEditionId: target.id, sourceEditionIds: [source.id], expectedVersions: { [target.id]: target.version, [source.id]: source.version } })
  const row = planReviewBatch(state({ issues: [open], editions: [target, source] }), [merge], NOW).rows[0]
  assert.equal(row.status, "ready")
  assert.equal(row.merges, 1)
  assert.ok(!row.ops.some((op) => op.op === "update_edition"), "el destino conserva sus valores")
  const claim = row.ops.find((op) => op.op === "insert_evidence")
  assert.ok(claim && claim.op === "insert_evidence")
  assert.deepEqual(claim.evidence.fieldClaims, { values: { publish_date: "1991", number_of_pages: 100 }, mergedFrom: source.id })
  assert.ok(row.ops.some((op) => op.op === "open_issue" && op.reason === "source_conflict" && op.dedupeKey === `source_conflict:${target.id}`))
  assert.ok(row.effects.some((text) => text.includes("2 ejemplares pasan")))

  const stale = planReviewBatch(state({ issues: [open], editions: [target, { ...source, version: version() }] }), [merge], NOW).rows[0]
  assert.equal(stale.status, "conflict")
  const other = edition({ isbn13: "9780000000026", title: "Poemas" })
  const distinct = issue({ reason: "duplicate_candidate", entityRefs: [{ kind: "edition", id: source.id }, { kind: "edition", id: other.id }] })
  const rejected = planReviewBatch(state({ issues: [distinct], editions: [source, other] }), [decision({
    issueId: distinct.id, expectedVersion: distinct.version, kind: "merge", targetEditionId: source.id, sourceEditionIds: [other.id], expectedVersions: { [source.id]: source.version, [other.id]: other.version },
  })], NOW).rows[0]
  assert.equal(rejected.status, "invalid")
  const notDuplicate = issue({ reason: "missing_cover", entityRefs: open.entityRefs })
  assert.equal(planReviewBatch(state({ issues: [notDuplicate], editions: [target, source] }), [decision({ ...merge, issueId: notDuplicate.id, expectedVersion: notDuplicate.version })], NOW).rows[0].status, "invalid")
})

test("la huella de una fila no depende de cuándo se consultó el proveedor", () => {
  const current = edition({ title: "Otro" })
  const open = issue({ entityRefs: [{ kind: "edition", id: current.id }] })
  const plan = (retrievedAt: string) => {
    const ol = candidate({ retrievedAt })
    const choice = decision({ issueId: open.id, expectedVersion: open.version, kind: "accept_fields", editionId: current.id, editionVersion: current.version, fields: { title: providerColumnKey(ol, 0) } })
    return JSON.stringify(rowDigestView(planReviewBatch(state({ issues: [open], editions: [current], providers: [ol] }), [choice], NOW).rows[0], choice))
  }
  assert.equal(plan("2026-10-25T09:00:00.000Z"), plan("2026-10-25T09:30:00.000Z"))
  const changed = candidate({ title: "Título cambiado en la fuente" })
  const choice = decision({ issueId: open.id, expectedVersion: open.version, kind: "accept_fields", editionId: current.id, editionVersion: current.version, fields: { title: providerColumnKey(changed, 0) } })
  assert.notEqual(JSON.stringify(rowDigestView(planReviewBatch(state({ issues: [open], editions: [current], providers: [changed] }), [choice], NOW).rows[0], choice)), plan("2026-10-25T09:00:00.000Z"))
})
