import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { failed, isbn13, reviewContext, value } from "./lib/context.mjs"

// U-DAT-07 · decisiones individuales por la acción real: aceptar campos de una ficha de proveedor (fixture de Open Library
// con datos que contradicen la edición) conserva los no elegidos y no comprueba el ejemplar; confirmar en el ejemplar solo
// con la confirmación explícita; ignorar conserva evidencias; reabrir; versiones antiguas y repeticiones idempotentes.

const FIXTURE_ISBN = "9780000000019"
let ctx, a, session, shelf, provisional, photoBook, coverBook

before(async () => {
  ctx = await reviewContext()
  a = await ctx.account("a")
  session = await ctx.signIn(a)
  shelf = await ctx.shelf(a.id)
  provisional = await ctx.book(a.id, shelf, { isbn: FIXTURE_ISBN, title: ctx.label("Título equivocado"), pages: 10, publishDate: "1999", authors: [{ name: "Bruno Ficticio" }] })
  photoBook = await ctx.book(a.id, shelf, { isbn: isbn13(10), catalogue: { source: "open-library" } })
  coverBook = await ctx.book(a.id, shelf, { isbn: isbn13(11), catalogue: { source: "open-library" }, cover: "/default-book-cover.webp" })
  const asset = await ctx.uploadMedia(a.id, session, "evidence")
  await ctx.asUser(a.id, (tx) => tx`insert into biblib.bibliographic_evidence (user_id, copy_id, source_kind, photo_asset_id, field_claims, confidence, origin)
    values (${a.id}, ${photoBook.id}, 'photo', ${asset.id}, ${tx.json({ values: { title: "Lomo leído" } })}, 'provisional', 'review')`)
  await ctx.list(session)
})
after(async () => { await ctx?.cleanup(); await ctx?.close() })

const decide = (decision, key = ctx.key("decidir")) => ctx.call("decideReviewIssueAction", [{ decision, idempotencyKey: key }], session)

test("aceptar el título de la ficha de proveedor conserva los demás campos, cita la fuente y deja el ejemplar provisional", async () => {
  const issue = await ctx.issueFor(a.id, "provisional", provisional.editionId)
  const comparison = await ctx.compare(session, issue.id)
  const column = comparison.columns.find((entry) => entry.kind === "provider" && entry.selectable)
  assert.ok(column, "la comparación incluye la ficha del proveedor simulado")
  assert.equal(column.values.title, "La isla de papel")
  const title = comparison.rows.find((row) => row.field === "title")
  assert.equal(title.differs, true, "los datos contradictorios se marcan")
  assert.equal(comparison.rows.find((row) => row.field === "number_of_pages").differs, true)
  const before = await ctx.edition(a.id, provisional.editionId)
  const decision = { issueId: issue.id, expectedVersion: issue.version, kind: "accept_fields", editionId: before.id, editionVersion: before.version, fields: { title: column.key } }
  const key = ctx.key("aceptar")
  const report = value(await decide(decision, key))
  assert.equal(report.status, "applied")
  const after = await ctx.edition(a.id, provisional.editionId)
  assert.equal(after.title, "La isla de papel")
  assert.deepEqual([after.number_of_pages, after.publish_date, after.authors], [10, "1999", [{ name: "Bruno Ficticio" }]], "los campos no elegidos se conservan")
  assert.equal(after.catalogue.fields.title.provider, "open-library")
  assert.equal(after.catalogue.fields.title.selection, "user-selected")
  const created = (await ctx.evidence(a.id)).filter((entry) => entry.edition_id === provisional.editionId && entry.origin === "review")
  assert.equal(created.length, 1)
  assert.equal(created[0].confidence, "bibliographic_match")
  assert.match(created[0].source_ref, /^open-library/)
  assert.deepEqual(created[0].field_claims.values, { title: "La isla de papel" }, "solo se guarda lo aceptado")
  const copy = await ctx.copy(a.id, provisional.id)
  assert.equal(copy.edition_verification.isbnVerified, false)
  const [stored] = (await ctx.decisions(a.id)).filter((row) => row.issue_id === issue.id)
  assert.equal(stored.kind, "accept_fields")
  assert.deepEqual(stored.selected_fields, { title: { from: column.key } })
  assert.ok(stored.evidence_refs.includes(created[0].id))
  assert.equal((await ctx.stored(a.id)).find((row) => row.id === issue.id).state, "resolved")

  const replay = value(await decide(decision, key))
  assert.equal(replay.status, "replayed", "la misma clave recupera el resultado durable")
  assert.ok(failed(await decide({ ...decision, fields: { publish_date: column.key } }, key), "IDEMPOTENCY_CONFLICT"))
  const sync = await ctx.list(session)
  assert.equal(sync.sync.created, 0, "la coincidencia bibliográfica retira el ISBN provisional")
})

test("una versión antigua de la incidencia o de la edición es un conflicto y no cambia nada", async () => {
  const issue = await ctx.issueFor(a.id, "missing_cover", coverBook.editionId)
  const stale = await decide({ issueId: issue.id, expectedVersion: "00000000-0000-4000-8000-000000000001", kind: "ignore" })
  assert.ok(failed(stale, "CONFLICT"))
  assert.equal((await ctx.stored(a.id)).find((row) => row.id === issue.id).state, "open")
})

test("ignorar no borra evidencias, no se regenera sola y se puede reabrir", async () => {
  const issue = await ctx.issueFor(a.id, "missing_cover", coverBook.editionId)
  const evidenceBefore = await ctx.evidence(a.id)
  value(await decide({ issueId: issue.id, expectedVersion: issue.version, kind: "ignore" }))
  assert.deepEqual(await ctx.evidence(a.id), evidenceBefore)
  const ignored = (await ctx.stored(a.id)).find((row) => row.id === issue.id)
  assert.equal(ignored.state, "ignored")
  const sync = await ctx.list(session)
  assert.equal(sync.sync.created, 0, "una incidencia ignorada no se vuelve a abrir sola")
  value(await decide({ issueId: issue.id, expectedVersion: ignored.version, kind: "reopen" }))
  assert.equal((await ctx.stored(a.id)).find((row) => row.id === issue.id).state, "open")
  assert.deepEqual((await ctx.decisions(a.id)).filter((row) => row.issue_id === issue.id).map((row) => row.kind), ["ignore", "reopen"])
})

test("confirmar en el ejemplar exige la confirmación literal y conserva la foto como evidencia", async () => {
  const issue = await ctx.issueFor(a.id, "photo_doubt", photoBook.editionId)
  const copy = await ctx.copy(a.id, photoBook.id)
  const base = { issueId: issue.id, expectedVersion: issue.version, kind: "confirm_physical", copyId: copy.id, copyVersion: copy.version }
  assert.ok(failed(await decide(base), "INVALID_INPUT"))
  assert.ok(failed(await decide({ ...base, confirmed: false }), "INVALID_INPUT"))
  assert.equal((await ctx.copy(a.id, photoBook.id)).edition_verification.isbnVerified, false)
  value(await decide({ ...base, confirmed: true }))
  const checked = await ctx.copy(a.id, photoBook.id)
  assert.equal(checked.edition_verification.isbnVerified, true)
  const evidence = (await ctx.evidence(a.id)).filter((entry) => entry.copy_id === photoBook.id)
  assert.deepEqual(evidence.map((entry) => [entry.source_kind, entry.confidence]).sort(), [["manual", "physically_checked"], ["photo", "provisional"]])
  assert.ok(checked.edition_verification.evidenceRefs.includes(evidence.find((entry) => entry.confidence === "physically_checked").id))
  const [{ physical }] = await ctx.sql`select count(*)::int as physical from biblib.bibliographic_evidence where user_id = ${a.id} and confidence = 'physically_checked'`
  assert.equal(physical, 1, "solo la confirmación explícita crea una comprobación física")
})
