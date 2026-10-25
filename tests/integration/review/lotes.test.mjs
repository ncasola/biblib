import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { failed, isbn13, reviewContext, value } from "./lib/context.mjs"

// U-DAT-07 · lotes de hasta 50 decisiones con vista previa y versiones. Dos revisores de la misma cuenta: el segundo choca
// con lo que aplicó el primero y no aplica la mitad, salvo en el modo parcial explícito con informe por fila. La fusión de
// duplicados mueve antes las evidencias y abre una resolución con las discrepancias; una fuente eliminada tras la vista
// previa es un conflicto. Homónimos y autores iguales con obras distintas no se proponen como duplicados.

let ctx, a, first, second, shelf, covers, target, source, sourceCopy2, claimBook, claim, sourceEvidence

before(async () => {
  ctx = await reviewContext()
  a = await ctx.account("a")
  first = await ctx.signIn(a)
  second = await ctx.signIn(a)
  shelf = await ctx.shelf(a.id)
  covers = []
  for (const n of [20, 21, 22]) covers.push(await ctx.book(a.id, shelf, { isbn: isbn13(n), catalogue: { source: "open-library" }, cover: "/default-book-cover.webp" }))
  const title = ctx.label("Poemas reunidos")
  target = await ctx.book(a.id, shelf, { title, authors: [{ name: "Ana Pérez" }], publishDate: "1990", catalogue: { source: "open-library" } })
  source = await ctx.book(a.id, shelf, { isbn: isbn13(23), title, authors: [{ name: "ANA PEREZ" }], publishDate: "1991", pages: 120, catalogue: { source: "open-library" } })
  sourceCopy2 = await ctx.book(a.id, shelf, { editionId: source.editionId, isbn: isbn13(23) })
  await ctx.book(a.id, shelf, { title, authors: [{ name: "Luis Gómez" }], catalogue: { source: "open-library" } })
  await ctx.book(a.id, shelf, { title: ctx.label("Cuentos"), authors: [{ name: "Ana Pérez" }], catalogue: { source: "open-library" } })
  claimBook = await ctx.book(a.id, shelf, { isbn: isbn13(24), catalogue: { source: "open-library" }, cover: "/default-book-cover.webp" })
  ;[sourceEvidence] = await ctx.asUser(a.id, (tx) => tx`insert into biblib.bibliographic_evidence (user_id, edition_id, source_kind, source_ref, confidence, origin)
    values (${a.id}, ${source.editionId}, 'provider', 'open-library', 'bibliographic_match', 'review') returning id`)
  ;[claim] = await ctx.asUser(a.id, (tx) => tx`insert into biblib.bibliographic_evidence (user_id, edition_id, source_kind, field_claims, confidence, origin)
    values (${a.id}, ${claimBook.editionId}, 'photo', ${tx.json({ values: { subtitle: "Subtítulo de la foto" } })}, 'provisional', 'review') returning id`)
  await ctx.list(first)
})
after(async () => { await ctx?.cleanup(); await ctx?.close() })

const prepare = (session, decisions) => ctx.call("prepareReviewBatchAction", [{ issueIds: decisions.map((decision) => decision.issueId), proposedDecisions: decisions }], session)
const apply = (session, preview, mode = "atomic", key = ctx.key("lote")) => ctx.call("applyReviewBatchAction", [{
  previewId: preview.previewId, expectedRevision: preview.expectedRevision, idempotencyKey: key, preview: preview.preview, mode,
}], session)
const ignore = (issue) => ({ issueId: issue.id, expectedVersion: issue.version, kind: "ignore" })
const coverIssue = (index) => ctx.issueFor(a.id, "missing_cover", covers[index].editionId)

test("homónimos y autores iguales con obras distintas no se proponen como duplicados", async () => {
  const duplicates = (await ctx.stored(a.id)).filter((row) => row.reason === "duplicate_candidate" && row.state === "open")
  assert.equal(duplicates.length, 1)
  assert.deepEqual(duplicates[0].entity_refs.map((ref) => ref.id).sort(), [target.editionId, source.editionId].sort())
})

test("dos revisores: el segundo choca con lo aplicado y no aplica la mitad; el modo parcial informa por fila", async () => {
  const duplicate = (await ctx.stored(a.id)).find((row) => row.reason === "duplicate_candidate" && row.state === "open")
  const [t, s] = [await ctx.edition(a.id, target.editionId), await ctx.edition(a.id, source.editionId)]
  const merge = { issueId: duplicate.id, expectedVersion: duplicate.version, kind: "merge", targetEditionId: t.id, sourceEditionIds: [s.id], expectedVersions: { [t.id]: t.version, [s.id]: s.version } }
  const [c0, c1] = [await coverIssue(0), await coverIssue(1)]
  const previewA = value(await prepare(first, [merge, ignore(c0)]))
  const previewB = value(await prepare(second, [ignore(c0), ignore(c1)]))
  assert.equal(previewA.summary.merges, 1)
  assert.ok(previewA.summary.creates >= 2, "evidencia con los valores del origen y resolución")
  assert.ok(previewA.rows[0].effects.some((text) => text.startsWith("No se sobrescribe nada")))
  assert.ok(previewA.rows[0].effects.some((text) => text.includes("2 ejemplares pasan")))

  const keyA = ctx.key("revisor-a")
  const applied = value(await apply(first, previewA, "atomic", keyA))
  assert.deepEqual([applied.status, applied.applied], ["applied", 2])
  assert.equal(await ctx.edition(a.id, s.id), undefined, "la edición de origen se retira")
  const moved = await ctx.sql`select id, edition_id from biblib.copies where user_id = ${a.id} and id in (${source.id}, ${sourceCopy2.id}, ${target.id})`
  assert.ok(moved.every((row) => row.edition_id === t.id), "los ejemplares pasan al destino")
  const evidence = await ctx.evidence(a.id)
  assert.equal(evidence.find((entry) => entry.id === sourceEvidence.id)?.edition_id, t.id, "la evidencia del origen se movió antes de la poda")
  assert.deepEqual(evidence.find((entry) => entry.field_claims?.mergedFrom === s.id)?.field_claims.values, { publish_date: "1991", number_of_pages: 120 })
  const kept = await ctx.edition(a.id, t.id)
  assert.equal(kept.publish_date, "1990", "el destino conserva sus valores")
  assert.equal(kept.isbn13, isbn13(23), "adopta el ISBN del origen (U-DAT-06)")
  assert.ok((await ctx.stored(a.id)).some((row) => row.reason === "source_conflict" && row.state === "open" && row.entity_refs[0].id === t.id))
  assert.equal(value(await apply(first, previewA, "atomic", keyA)).status, "replayed")

  const decisionsBefore = (await ctx.decisions(a.id)).length
  assert.ok(failed(await apply(second, previewB), "REVISION_CONFLICT"))
  assert.equal((await ctx.decisions(a.id)).length, decisionsBefore, "nada aplicado del segundo lote")
  assert.equal((await ctx.stored(a.id)).find((row) => row.id === c1.id).state, "open")
  const partial = value(await apply(second, previewB, "partial"))
  assert.equal(partial.status, "partial")
  assert.deepEqual(partial.rows.map((row) => row.outcome), ["conflict", "applied"])
  assert.ok(partial.rows[0].message)
  assert.equal((await ctx.stored(a.id)).find((row) => row.id === c1.id).state, "ignored")
})

test("una fuente eliminada tras la vista previa es un conflicto: atómico no aplica nada, parcial aplica el resto", async () => {
  const issue = await ctx.issueFor(a.id, "missing_cover", claimBook.editionId)
  const edition = await ctx.edition(a.id, claimBook.editionId)
  const accept = { issueId: issue.id, expectedVersion: issue.version, kind: "accept_fields", editionId: edition.id, editionVersion: edition.version, fields: { subtitle: `evidence:${claim.id}` } }
  const c2 = await coverIssue(2)
  const preview = value(await prepare(first, [accept, ignore(c2)]))
  assert.equal(preview.summary.ready, 2)
  assert.ok(preview.rows[0].effects.some((text) => text.includes("subtítulo")))
  await ctx.asUser(a.id, (tx) => tx`delete from biblib.bibliographic_evidence where id = ${claim.id}`)
  assert.ok(failed(await apply(first, preview), "REVISION_CONFLICT"))
  assert.equal((await ctx.stored(a.id)).find((row) => row.id === c2.id).state, "open")
  const report = value(await apply(first, preview, "partial"))
  assert.deepEqual(report.rows.map((row) => [row.outcome, row.message]), [["conflict", "La fuente que elegiste se ha eliminado o ya no pertenece a esta edición."], ["applied", undefined]])
  assert.equal((await ctx.edition(a.id, edition.id)).subtitle, null)
})

test("un lote de más de 50, una vista previa alterada o ajena se rechazan sin aplicar nada", async () => {
  const c2 = (await ctx.stored(a.id)).find((row) => row.state === "open")
  const many = Array.from({ length: 51 }, (_, index) => ({ issueId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, expectedVersion: c2.version, kind: "ignore" }))
  assert.ok(failed(await prepare(first, many), "INVALID_INPUT"))
  const preview = value(await prepare(first, [ignore(c2)]))
  const tampered = { ...preview, preview: { ...preview.preview, decisions: [{ ...preview.preview.decisions[0], kind: "reopen" }] } }
  assert.ok(failed(await apply(first, tampered), "INVALID_INPUT"))
  const b = await ctx.account("b")
  const sessionB = await ctx.signIn(b)
  assert.ok(failed(await apply(sessionB, preview), "INVALID_INPUT"), "la huella incluye al dueño")
  assert.equal((await ctx.stored(a.id)).find((row) => row.id === c2.id).state, "open")
  const [{ physical }] = await ctx.sql`select count(*)::int as physical from biblib.bibliographic_evidence where user_id = ${a.id} and confidence = 'physically_checked'`
  assert.equal(physical, 0, "ninguna decisión del lote comprobó un ejemplar")
})
