import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { failed, isbn13, reviewContext, value } from "./lib/context.mjs"

// U-DAT-07 · aislamiento A/B con sesiones GoTrue reales: B no enumera incidencias, fuentes, evidencias ni fotos de A, no
// compara ni decide sobre ellas, y sus respuestas no confirman que existan.

let ctx, a, b, sessionA, sessionB, issueA, photo

before(async () => {
  ctx = await reviewContext()
  a = await ctx.account("a")
  b = await ctx.account("b")
  sessionA = await ctx.signIn(a)
  sessionB = await ctx.signIn(b)
  const shelfA = await ctx.shelf(a.id)
  await ctx.shelf(b.id)
  const book = await ctx.book(a.id, shelfA, { isbn: isbn13(1), title: ctx.label("privada de A") })
  photo = await ctx.uploadMedia(a.id, sessionA, "evidence")
  await ctx.asUser(a.id, (tx) => tx`insert into biblib.bibliographic_evidence (user_id, copy_id, source_kind, photo_asset_id, field_claims, confidence, origin)
    values (${a.id}, ${book.id}, 'photo', ${photo.id}, ${tx.json({ values: { title: "Lomo de A" } })}, 'provisional', 'review')`)
  await ctx.list(sessionA)
  issueA = await ctx.issueFor(a.id, "photo_doubt", book.editionId)
  assert.ok(issueA, "A tiene su duda de foto")
})
after(async () => { await ctx?.cleanup(); await ctx?.close() })

test("B no enumera incidencias, fuentes ni evidencias de A", async () => {
  const page = await ctx.list(sessionB, { filters: { states: ["open", "resolved", "ignored"] } })
  assert.deepEqual(page.items, [])
  assert.deepEqual(page.counts, {})
  const seen = await ctx.rolledBack(b.id, async (tx) => ({
    issues: (await tx`select count(*)::int as n from biblib.review_issues`)[0].n,
    evidence: (await tx`select count(*)::int as n from biblib.bibliographic_evidence`)[0].n,
    media: (await tx`select count(*)::int as n from biblib.media_assets`)[0].n,
    decisions: (await tx`select count(*)::int as n from biblib.review_decisions`)[0].n,
  }))
  assert.deepEqual(seen, { issues: 0, evidence: 0, media: 0, decisions: 0 })
  const { data } = await ctx.storageAs(sessionB).list(`${a.id}/evidence`)
  assert.deepEqual(data ?? [], [], "B no lista las fotos de A")
  const download = await ctx.storageAs(sessionB).download(photo.key)
  assert.ok(download.error, "B no descarga la foto de A")
})

test("B no compara ni decide sobre una incidencia de A y la respuesta no confirma que exista", async () => {
  const compared = await ctx.call("compareBibliographicCandidatesAction", [{ issueId: issueA.id }], sessionB)
  assert.ok(failed(compared, "NOT_FOUND"))
  const missing = await ctx.call("compareBibliographicCandidatesAction", [{ issueId: "00000000-0000-4000-8000-0000000000aa" }], sessionB)
  assert.equal(compared.value.error.message, missing.value.error.message, "misma respuesta que una incidencia inexistente")
  const ignore = { issueId: issueA.id, expectedVersion: issueA.version, kind: "ignore" }
  const decided = await ctx.call("decideReviewIssueAction", [{ decision: ignore, idempotencyKey: ctx.key("b-decide") }], sessionB)
  assert.ok(failed(decided, "CONFLICT"))
  assert.equal(decided.value.error.message, "La incidencia ya no existe. No se ha aplicado nada.")
  const preview = value(await ctx.call("prepareReviewBatchAction", [{ issueIds: [issueA.id], proposedDecisions: [ignore] }], sessionB))
  assert.equal(preview.rows[0].status, "conflict")
  const after = (await ctx.stored(a.id)).find((row) => row.id === issueA.id)
  assert.equal(after.state, "open")
  assert.equal(after.version, issueA.version)
  assert.equal((await ctx.decisions(a.id)).length, 0)
})

test("A compara su duda de foto: ve la foto citada como privada, sin ruta ni URL firmada", async () => {
  const comparison = await ctx.compare(sessionA, issueA.id)
  const evidence = comparison.evidence.find((entry) => entry.sourceKind === "photo")
  assert.equal(evidence.hasPhoto, true)
  const text = JSON.stringify(comparison)
  assert.ok(!text.includes(photo.key) && !text.includes(photo.id) && !/token=|\/storage\/v1\//.test(text), "la comparación no expone la clave ni el asset de la foto")
  const column = comparison.columns.find((entry) => entry.kind === "evidence")
  assert.equal(column.values.title, "Lomo de A")
  assert.match(comparison.rows.find((row) => row.field === "title").cells.find((cell) => cell.column === column.key).source, /Foto propia/)
})
