import assert from "node:assert/strict"
import { after, before, beforeEach, test } from "node:test"
import { callAction } from "../lib/app.mjs"
import { csvContext, failed, mapping, sha256, value } from "./lib/context.mjs"

let ctx, ownerA, ownerB, a, b
const count = async (owner) => Number((await ctx.sql`select count(*)::int as n from biblib.copies where user_id = ${owner}`)[0].n)
before(async () => {
  ctx = await csvContext()
  ownerA = await ctx.account("csv-a"); ownerB = await ctx.account("csv-b")
  await ctx.library(ownerA.id); await ctx.library(ownerB.id)
  a = await ctx.signIn(ownerA); b = await ctx.signIn(ownerB)
})
beforeEach(async () => {
  await ctx.sql`delete from biblib.import_sessions where user_id in ${ctx.sql([ownerA.id, ownerB.id])}`
})
after(async () => {
  if (!ctx) return
  try { await ctx.cleanup() } finally { await ctx.close() }
})

test("CSV real: BOM, Unicode, comillas y saltos; staging no publica, CAS JSON confirma y retry no duplica", async () => {
  const before = await count(ownerA.id)
  const inspected = await ctx.csv(a, '\uFEFFTítulo,Autor,ISBN,Estado\r\n"Libro, con ""comillas""","Apellido, Nombre",9780306406157,Leído\r\n"Poesía\n李白 📚",María,,Leyendo\r\n"Libro, con ""comillas""","Apellido, Nombre",9780306406157,Sin leer')
  assert.equal(inspected.recordCount, 3)
  assert.equal(inspected.sampleRows[1].ordinal, 2)
  assert.equal(inspected.sampleRows[0].cells[1], "Apellido, Nombre")
  const mapped = await ctx.mapCsv(a, inspected, mapping(["title", "authors", "isbn", "status"]))
  assert.equal(mapped.validRows, 3)
  const staged = await ctx.sql`select kind, source_ordinal, source_row_key, data, issues from biblib.import_session_rows where session_id = ${inspected.sessionId} order by source_ordinal`
  assert.deepEqual(staged.map((row) => [row.kind, row.source_ordinal, row.source_row_key]), [["record", 1, "csv:1"], ["record", 2, "csv:2"], ["record", 3, "csv:3"]])
  assert.equal(staged[0].data.book.catalogue.isbnVerified, false)
  const prepared = await ctx.prepareCsv(a, inspected.sessionId)
  assert.equal(prepared.plan.counts.skipped, 1)
  const retryPlan = await ctx.prepareCsv(a, inspected.sessionId)
  assert.equal(retryPlan.previewId, prepared.previewId)
  assert.equal(await count(ownerA.id), before)
  const key = ctx.key("csv-retry")
  const committed = await ctx.confirmCsv(a, prepared, key)
  assert.equal(committed.status, "committed")
  assert.equal(await count(ownerA.id), before + 2)
  const replay = await ctx.confirmCsv(a, prepared, key)
  assert.equal(replay.operationId, committed.operationId)
  assert.equal(replay.replayed, true)
  assert.equal(await count(ownerA.id), before + 2)
  const [stored] = await ctx.sql`select state, operation_id, input_sha256, mapping_sha256 from biblib.import_sessions where id = ${inspected.sessionId}`
  assert.equal(stored.state, "committed"); assert.equal(stored.operation_id, committed.operationId)
  assert.equal(stored.input_sha256, inspected.inputHash)
  assert.equal(stored.mapping_sha256, mapped.mappingHash)
  const rows = await ctx.sql`select isbn13, edition_verification from biblib.copies c join biblib.editions e on e.id=c.edition_id where c.id in ${ctx.sql(prepared.plan.books.insert.map((row) => row.id))}`
  assert.ok(rows.every((row) => row.edition_verification.isbnVerified === false))
  assert.ok(rows.some((row) => row.isbn13 === null))
})

test("CSV real: remap invalida preview anterior, cambia hash y conserva source_row_key e IDs", async () => {
  const inspected = await ctx.csv(a, "Título,Autor\nLibro corregible,Ana")
  const first = await ctx.mapCsv(a, inspected, mapping(["title", "authors"]))
  const prepared = await ctx.prepareCsv(a, inspected.sessionId)
  const current = value(await ctx.call("inspectCsvAction", [{ sessionId: inspected.sessionId }], a))
  const second = await ctx.mapCsv(a, current, mapping(["title", "ignore"]))
  assert.notEqual(first.mappingHash, second.mappingHash)
  const before = await count(ownerA.id)
  const stale = await ctx.call("confirmImportAction", [{ previewId: prepared.previewId, expectedRevision: prepared.revision, idempotencyKey: ctx.key("old-map") }], a)
  assert.ok(failed(stale, "PREVIEW_EXPIRED"))
  assert.equal(await count(ownerA.id), before)
  const corrected = await ctx.prepareCsv(a, inspected.sessionId)
  assert.notEqual(corrected.digest, prepared.digest)
  assert.deepEqual(corrected.plan.books.insert.map((row) => row.id), prepared.plan.books.insert.map((row) => row.id))
  const keys = await ctx.sql`select source_row_key from biblib.import_session_rows where session_id = ${inspected.sessionId}`
  assert.equal(keys[0].source_row_key, "csv:1")
  assert.ok(failed(await ctx.call("setCsvMappingAction", [{ sessionId: inspected.sessionId, expectedVersion: current.version, mappingVersion: second.mappingVersion + 1, mapping: mapping(["title", "authors"]) }], a), "CONFLICT"))
})

test("CSV real: cambios de colección invalidan confirmación; B y anónimo no acceden a sesión, informe o perfiles", async () => {
  const inspected = await ctx.csv(a, "Título\nLibro para CAS")
  await ctx.mapCsv(a, inspected, mapping(["title"]))
  const prepared = await ctx.prepareCsv(a, inspected.sessionId)
  const before = await count(ownerA.id)
  await ctx.sql`insert into biblib.shelves(user_id,title) values(${ownerA.id},${ctx.label("Cambio CAS CSV")})`
  assert.ok(failed(await ctx.call("confirmImportAction", [{ previewId: prepared.previewId, expectedRevision: prepared.revision, idempotencyKey: ctx.key("cas") }], a), "REVISION_CONFLICT"))
  assert.equal(await count(ownerA.id), before)
  for (const [name, args] of [["inspectCsvAction", [{ sessionId: inspected.sessionId }]], ["getCsvIssueReportAction", [{ sessionId: inspected.sessionId }]], ["discardCsvImportAction", [{ sessionId: inspected.sessionId }]], ["prepareCsvImportAction", [{ sessionId: inspected.sessionId, mode: "merge", duplicatePolicy: "skip-existing" }]]]) {
    assert.ok(failed(await ctx.call(name, args, b), "NOT_FOUND"), name)
    const anonymous = await callAction(ctx.app, name, args)
    assert.ok(anonymous.status !== 200 || anonymous.value?.ok === false, name)
  }
  assert.equal((await ctx.asUser(ownerB.id, (tx) => tx`select * from biblib.import_session_rows where session_id = ${inspected.sessionId}`)).length, 0)
  assert.equal((await ctx.asUser(ownerB.id, (tx) => tx`select * from biblib.import_sessions where id = ${inspected.sessionId}`)).length, 0)
  value(await ctx.call("saveCsvMappingProfileAction", [{ sessionId: inspected.sessionId, name: ctx.label("Perfil CSV") }], a))
  assert.equal(value(await ctx.call("listCsvMappingProfilesAction", [], b)).length, 0)
})

test("CSV real: errores por fila bloquean por defecto; omisión explícita tiene plan e informe sin fórmulas ejecutables", async () => {
  const inspected = await ctx.csv(a, 'Título,Páginas,Estado,ISBN\nVálido,20,Sin leer,\nNegativo,-1,Leído,\nDesconocido,20,=1+1,\nChecksum,30,Sin leer,9780306406158')
  const mapped = await ctx.mapCsv(a, inspected, mapping(["title", "pages", "status", "isbn"]))
  assert.equal(mapped.validRows, 1)
  assert.deepEqual(mapped.issues.map((row) => row.code), ["INVALID_PAGES", "UNKNOWN_STATUS", "INVALID_ISBN"])
  const rows = await ctx.sql`select issues from biblib.import_session_rows where session_id = ${inspected.sessionId} order by source_ordinal`
  assert.deepEqual(rows[2].issues, [{ code: "UNKNOWN_STATUS", field: "status" }])
  assert.ok(!JSON.stringify(rows).includes("=1+1"), "Las incidencias persistidas no guardan muestras")
  const before = await count(ownerA.id)
  assert.ok(failed(await ctx.call("prepareCsvImportAction", [{ sessionId: inspected.sessionId, mode: "merge", duplicatePolicy: "skip-existing" }], a), "INVALID_INPUT"))
  assert.equal(await count(ownerA.id), before)
  const prepared = await ctx.prepareCsv(a, inspected.sessionId, { invalidRows: "skip-invalid" })
  assert.deepEqual(prepared.omittedRows.map((row) => row.ordinal), [2, 3, 4])
  const report = value(await ctx.call("getCsvIssueReportAction", [{ sessionId: inspected.sessionId }], a))
  assert.ok(report.includes('"\'=1+1"'))
  assert.equal((await ctx.confirmCsv(a, prepared)).result.imported, 1)
  assert.equal(await count(ownerA.id), before + 1)
  assert.ok(value(await ctx.call("getCsvIssueReportAction", [{ sessionId: inspected.sessionId }], a)).includes("INVALID_PAGES"))
})

test("CSV real: omitir existente frente a otra copia reutiliza edición sin sobrescribirla", async () => {
  let inspected = await ctx.csv(a, "Título,ISBN\nEdición conservada,9780131103627")
  await ctx.mapCsv(a, inspected, mapping(["title", "isbn"]))
  await ctx.confirmCsv(a, await ctx.prepareCsv(a, inspected.sessionId))
  const [edition] = await ctx.sql`select id,title,version from biblib.editions where user_id=${ownerA.id} and isbn13='9780131103627'`
  inspected = await ctx.csv(a, "Título,ISBN\nTexto CSV discrepante,9780131103627")
  await ctx.mapCsv(a, inspected, mapping(["title", "isbn"]))
  const skip = await ctx.prepareCsv(a, inspected.sessionId)
  assert.equal(skip.plan.counts.skipped, 1)
  const copy = await ctx.prepareCsv(a, inspected.sessionId, { duplicatePolicy: "another-copy" })
  assert.equal(copy.plan.counts.added, 1); assert.equal(copy.plan.editions.create.length, 0)
  assert.equal(copy.plan.books.insert[0].editionId, edition.id)
  assert.equal((await ctx.confirmCsv(a, copy)).result.imported, 1)
  const [same] = await ctx.sql`select id,title,version from biblib.editions where id=${edition.id}`
  assert.deepEqual(same, edition)
  assert.equal(Number((await ctx.sql`select count(*)::int as n from biblib.copies where edition_id=${edition.id}`)[0].n), 2)
  assert.ok(value(await ctx.call("getCsvIssueReportAction", [{ sessionId: inspected.sessionId }], a)).startsWith("\uFEFF"))
})

test("CSV real: subida por trozos fuera de orden, multibyte partido, replay y hash corrupto", async () => {
  const bytes = Buffer.from('Título,Autor\n"' + "Ñ".repeat(140000) + '",Ana', "utf8")
  const begin = value(await ctx.call("beginCsvImportAction", [{ byteLength: bytes.length, sha256: sha256(bytes), delimiter: "," }], a))
  const pieces = [bytes.subarray(0, 262144), bytes.subarray(262144)]
  const last = { ordinal: 1, total: 2, sha256: sha256(pieces[1]) }
  assert.equal(value(await ctx.uploadCsvChunk(a, begin.sessionId, last, pieces[1])).complete, false)
  const first = { ordinal: 0, total: 2, sha256: sha256(pieces[0]) }
  assert.ok(failed(await ctx.uploadCsvChunk(a, begin.sessionId, { ...first, sha256: "0".repeat(64) }, pieces[0]), "MANIFEST_MISMATCH"))
  assert.equal(value(await ctx.uploadCsvChunk(a, begin.sessionId, first, pieces[0])).recordCount, 1)
  assert.equal(value(await ctx.uploadCsvChunk(a, begin.sessionId, first, pieces[0])).recordCount, 1)
  const altered = Buffer.from(pieces[0]); altered[100] = 65
  assert.ok(failed(await ctx.uploadCsvChunk(a, begin.sessionId, { ...first, sha256: sha256(altered) }, altered), "IDEMPOTENCY_CONFLICT"))
  assert.equal(Number((await ctx.sql`select count(*)::int as n from biblib.import_session_rows where session_id=${begin.sessionId}`)[0].n), 1)
})

test("CSV real: cabecera duplicada y truncamiento bloquean incluso el modo parcial; límite propio de sesiones", async () => {
  for (const text of ["Título,Título\nA,B", 'Título,Autor\nA,Ana\n"Truncado']) {
    const inspected = await ctx.csv(a, text)
    const receipt = await ctx.mapCsv(a, inspected, mapping(["title", "authors"]))
    assert.ok(receipt.issues.length)
    assert.ok(failed(await ctx.call("prepareCsvImportAction", [{ sessionId: inspected.sessionId, mode: "merge", duplicatePolicy: "skip-existing", invalidRows: "skip-invalid" }], a), "INVALID_INPUT"))
  }
  await ctx.csv(a, "Título\nTercera")
  assert.ok(failed(await ctx.call("beginCsvImportAction", [{ byteLength: 20, sha256: "a".repeat(64), delimiter: "," }], a), "LIMIT_EXCEEDED"))
  assert.ok(failed(await ctx.call("beginCsvImportAction", [{ byteLength: 8388609, sha256: "a".repeat(64), delimiter: "," }], a), "INVALID_INPUT"))
})
