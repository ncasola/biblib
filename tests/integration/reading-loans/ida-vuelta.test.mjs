import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { readingContext, readingState, value } from "./lib/context.mjs"

// O14 · 0015. Ida y vuelta v2 por la app real: exportación (acción + ruta de partes) con las secciones copies.reading y
// copies.loans, reemplazo desde ese archivo (mismos IDs), restauración de la versión anterior que captura el reemplazo
// (esquema 4), fusión en otra cuenta (IDs nuevos, sin duplicar al repetir) y un archivo anterior que no inventa lectura ni
// préstamos aunque traiga libros leídos.

let ctx, a, b, sessionA, sessionB, lib, exported, original, mutated

before(async () => {
  ctx = await readingContext()
  a = await ctx.account("a")
  b = await ctx.account("b")
  sessionA = await ctx.signIn(a)
  sessionB = await ctx.signIn(b)
  lib = await ctx.library(a.id)
  await ctx.setPages(lib.books[0].id, 300)
  await ctx.asUser(a.id, async (tx) => {
    const [first] = await tx`select biblib.reading_cycle_start(${lib.books[0].id}::uuid, '2025-12-20T18:00:00Z') as result`
    await tx`insert into biblib.reading_entries (user_id, cycle_id, occurred_at, page_from, page_to, note) values (${a.id}, ${first.result.cycle_id}, '2025-12-21T22:15:00+01:00', 0, 120, 'Primera sesión ✨')`
    await tx`select biblib.reading_cycle_close(${first.result.cycle_id}::uuid, ${first.result.version}::uuid, 'finished', '2026-01-05T10:00:00Z')`
    const [second] = await tx`select biblib.reading_cycle_start(${lib.books[0].id}::uuid, null) as result`
    await tx`insert into biblib.reading_entries (user_id, cycle_id, occurred_at, page_to) values (${a.id}, ${second.result.cycle_id}, '2026-10-20T07:00:00Z', 300)`
    await tx`insert into biblib.reading_entries (user_id, cycle_id, occurred_at, note) values (${a.id}, ${second.result.cycle_id}, '2026-10-21T07:00:00Z', 'Solo una nota')`
    const [paused] = await tx`select biblib.reading_cycle_start(${lib.books[1].id}::uuid, '2026-09-01T00:00:00Z') as result`
    await tx`update biblib.reading_cycles set status = 'paused' where id = ${paused.result.cycle_id}`
    const [lent] = await tx`select biblib.loan_open(${lib.books[1].id}::uuid, 'Tía Ana', '2026-03-29', null, 'Semana Santa') as result`
    await tx`select biblib.loan_return(${lent.result.loan_id}::uuid, ${lent.result.version}::uuid, '2026-04-05')`
    await tx`select biblib.loan_open(${lib.books[1].id}::uuid, 'Luis', '2026-10-01', '2026-11-01', null)`
  })
  await ctx.sql`update biblib.copies set status = 'read' where id = ${lib.books[2].id}`
  original = await readingState(ctx.sql, a.id)
})
after(async () => { await ctx?.cleanup(); await ctx?.close() })

async function exportParts(session) {
  const prepared = value(await ctx.call("prepareLibraryExportAction", [], session))
  const parts = []
  for (const part of prepared.parts) {
    const response = await ctx.get(part.href, session)
    assert.equal(response.status, 200, `la parte ${part.index} se descarga`)
    parts.push(JSON.parse(response.body.toString("utf8")))
  }
  return { prepared, parts }
}

async function importFile(session, file, mode) {
  const prepared = value(await ctx.call("prepareImportAction", [file, mode], session))
  const confirmed = value(await ctx.call("confirmImportAction", [{ previewId: prepared.previewId, expectedRevision: prepared.revision, idempotencyKey: ctx.key("importar") }], session))
  assert.equal(confirmed.status, "committed")
  return { prepared, confirmed }
}

test("la exportación v2 declara y lleva lectura y préstamos: instantes en UTC, fechas civiles tal cual y nada inventado", async () => {
  const { prepared, parts } = await exportParts(sessionA)
  assert.equal(prepared.formatVersion, 2)
  assert.equal(parts.length, 1)
  exported = parts[0]
  for (const capability of ["copies.reading", "copies.loans"]) assert.ok(exported.requiredCapabilities.includes(capability), capability)
  const first = exported.copies.find((copy) => copy.id === lib.books[0].id)
  assert.deepEqual(first.reading.map((cycle) => [cycle.cycleNumber, cycle.status, cycle.startedAt, cycle.finishedAt, cycle.entries?.length]), [
    [1, "finished", "2025-12-20T18:00:00.000Z", "2026-01-05T10:00:00.000Z", 1],
    [2, "reading", undefined, undefined, 2],
  ])
  assert.deepEqual(first.reading[0].entries[0], { id: original.entries.find((entry) => entry.page_to === 120).id, occurredAt: "2025-12-21T21:15:00.000Z", pageFrom: 0, pageTo: 120, note: "Primera sesión ✨" })
  const second = exported.copies.find((copy) => copy.id === lib.books[1].id)
  assert.deepEqual(second.loans.map((loan) => { const copy = { ...loan }; delete copy.id; return copy }), [
    { borrowerLabel: "Tía Ana", loanedOn: "2026-03-29", returnedOn: "2026-04-05", note: "Semana Santa" },
    { borrowerLabel: "Luis", loanedOn: "2026-10-01", dueOn: "2026-11-01" },
  ])
  const third = exported.copies.find((copy) => copy.id === lib.books[2].id)
  assert.equal(third.status, "read")
  assert.ok(!("reading" in third) && !("loans" in third), "el estado read no se exporta como lectura")
  assert.ok(!JSON.stringify(exported).match(/"version"|remind|recordatorio/i), "ni tokens ni recordatorios")
})

test("reemplazar desde la propia copia devuelve lectura y préstamos exactos con los mismos IDs", async () => {
  assert.ok(exported, "depende de la exportación")
  await ctx.asUser(a.id, async (tx) => {
    const [cycle] = await tx`select id, version from biblib.reading_cycles where copy_id = ${lib.books[0].id} and cycle_number = 2`
    await tx`select biblib.reading_cycle_close(${cycle.id}::uuid, ${cycle.version}::uuid, 'abandoned', null)`
    await tx`insert into biblib.reading_entries (user_id, cycle_id, occurred_at, page_to) values (${a.id}, ${cycle.id}, '2026-10-22T07:00:00Z', 10)`
    const [loan] = await tx`select id, version from biblib.loans where copy_id = ${lib.books[1].id} and returned_on is null`
    await tx`select biblib.loan_return(${loan.id}::uuid, ${loan.version}::uuid, '2026-10-15')`
    await tx`update biblib.loans set note = 'Cambiada' where copy_id = ${lib.books[1].id} and borrower_label = 'Tía Ana'`
  })
  mutated = await readingState(ctx.sql, a.id)
  assert.notDeepEqual(mutated, original)
  await importFile(sessionA, exported, "replace")
  assert.deepEqual(await readingState(ctx.sql, a.id), original)
})

test("la versión anterior que capturó el reemplazo restaura también la lectura y los préstamos", async () => {
  assert.ok(mutated, "depende del reemplazo")
  const page = value(await ctx.call("listLibrarySnapshotsAction", [{}], sessionA))
  const preview = value(await ctx.call("previewSnapshotRestoreAction", [{ snapshotId: page.items[0].id }], sessionA))
  value(await ctx.call("restoreSnapshotAction", [{ previewId: preview.previewId, expectedRevision: preview.revision, idempotencyKey: ctx.key("restaurar") }], sessionA))
  assert.deepEqual(await readingState(ctx.sql, a.id), mutated)
  const [{ version }] = await ctx.sql`select schema_version as version from biblib.library_snapshots where user_id = ${a.id} order by created_at desc limit 1`
  assert.equal(version, 4)
})

test("otra cuenta fusiona el archivo con IDs propios y repetir la fusión no duplica nada", async () => {
  assert.ok(exported, "depende de la exportación")
  await ctx.library(b.id)
  await importFile(sessionB, exported, "merge")
  const state = await readingState(ctx.sql, b.id)
  assert.deepEqual([state.cycles.length, state.entries.length, state.loans.length], [original.cycles.length, original.entries.length, original.loans.length])
  const ids = (rows) => new Set(rows.map((row) => row.id))
  for (const key of ["cycles", "entries", "loans"]) assert.ok(state[key].every((row) => !ids(original[key]).has(row.id)), `${key}: IDs propios de B`)
  assert.deepEqual(state.loans.map((loan) => [loan.loaned_on, loan.due_on, loan.returned_on]).sort(), original.loans.map((loan) => [loan.loaned_on, loan.due_on, loan.returned_on]).sort())
  await importFile(sessionB, exported, "merge")
  assert.deepEqual(await readingState(ctx.sql, b.id), state, "los ejemplares ya existen: conservan lo suyo")
})

test("un archivo anterior (v1) con libros leídos se importa sin lectura ni préstamos", async () => {
  const before = await readingState(ctx.sql, b.id)
  const legacy = {
    formatVersion: 1, exportedAt: new Date().toISOString(),
    shelves: [{ id: "s1", title: "Principal", book_count: 1, isDefault: true }],
    books: [{ id: "l1", isbn: `manual-o14d-${ctx.run}-v1`, title: ctx.label("leído en un archivo v1"), authors: [], number_of_pages: 200, publish_date: "", status: "read", shelf_id: "s1", shelf_name: "Principal" }],
  }
  const { prepared } = await importFile(sessionB, legacy, "merge")
  assert.equal(prepared.plan.books.insert.length, 1)
  assert.deepEqual(await readingState(ctx.sql, b.id), before, "ningún ciclo, sesión ni préstamo inventado")
  const [{ status }] = await ctx.sql`select status from biblib.copies where id = ${prepared.plan.books.insert[0].id}`
  assert.equal(status, "read", "el estado actual se conserva tal cual")
})
