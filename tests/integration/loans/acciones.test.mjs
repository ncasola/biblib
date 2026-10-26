import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, before, test } from "node:test"
import { loansContext, value } from "./lib/context.mjs"

let ctx, a, b, sa, sb, lib, other, first, current
before(async () => {
  ctx = await loansContext()
  a = await ctx.account("loans-a"); b = await ctx.account("loans-b")
  sa = await ctx.signIn(a); sb = await ctx.signIn(b)
  lib = await ctx.library(a.id); other = await ctx.library(b.id)
})
after(async () => { await ctx?.cleanup(); await ctx?.close() })

const open = (copyId, borrowerLabel = "Ana", loanedOn = "2026-03-29") => ({ copyId, borrowerLabel, loanedOn })
async function fails(name, input, session, code) {
  const response = await ctx.call(name, [input], session)
  assert.equal(response.status, 200)
  assert.equal(response.value?.ok, false)
  assert.equal(response.value.error.code, code)
  return response.value.error
}

test("loans: alta concurrente por acciones, un activo y reintento tras respuesta perdida sin escritura", async () => {
  const [before] = await ctx.sql`select status, version from biblib.copies where id = ${lib.books[0].id}`
  const payload = open(lib.books[0].id)
  const responses = await Promise.all([ctx.call("openLoanAction", [payload], sa), ctx.call("openLoanAction", [payload], sa)])
  first = value(responses[0]); current = value(responses[1])
  assert.equal(first.id, current.id); assert.equal(first.version, current.version)
  assert.equal(current.loanedOn, "2026-03-29"); assert.equal(current.dueOn, undefined)
  const [after] = await ctx.sql`select status, version from biblib.copies where id = ${lib.books[0].id}`
  assert.deepEqual({ ...after }, { ...before }, "prestar no cambia lectura ni versión del ejemplar")
  await fails("openLoanAction", open(lib.books[0].id, "Luis"), sa, "CONFLICT")
  assert.equal(value(await ctx.call("getLoanCountAction", [], sa)), 1)
  assert.equal(value(await ctx.call("getLoanCountAction", [], sb)), 0)
})

test("loans: dos conexiones simultáneas solo abren un préstamo", async () => {
  const lend = (tx, alias) => tx`select biblib.loan_open(${lib.books[1].id}::uuid, ${alias}, '2026-03-29', null, null) as result`.then(([row]) => row.result)
  const responses = await Promise.all([ctx.asUser(a.id, (tx) => lend(tx, "Ana")), ctx.asUserElsewhere(a.id, (tx) => lend(tx, "Luis"))])
  assert.deepEqual(responses.map((row) => row.status).sort(), ["active", "opened"])
  const [{ n }] = await ctx.sql`select count(*)::int as n from biblib.loans where copy_id = ${lib.books[1].id} and returned_on is null`
  assert.equal(n, 1)
})

test("loans: alias y fechas inválidos; editar y borrar sin confirmar no escriben", async () => {
  for (const borrowerLabel of ["ana@example.com", "+34 600 123 456"]) {
    const error = await fails("openLoanAction", { ...open(lib.books[2].id), borrowerLabel }, sa, "INVALID_INPUT")
    assert.doesNotMatch(error.message, /correo|teléfono|email/i)
  }
  await fails("openLoanAction", { ...open(lib.books[2].id), dueOn: "2026-03-28" }, sa, "INVALID_INPUT")
  await fails("updateLoanAction", { id: current.id, expectedVersion: current.version, borrowerLabel: "Luis" }, sa, "INVALID_INPUT")
  await fails("deleteLoanAction", { id: current.id, expectedVersion: current.version }, sa, "INVALID_INPUT")
  assert.equal(value(await ctx.call("getCopyLoansAction", [lib.books[0].id], sa))[0].version, current.version)
})

test("loans: B no ve ni modifica préstamos de A por las acciones reales", async () => {
  await fails("getCopyLoansAction", lib.books[0].id, sb, "NOT_FOUND")
  await fails("openLoanAction", open(lib.books[0].id), sb, "NOT_FOUND")
  for (const name of ["returnLoanAction", "updateLoanAction", "deleteLoanAction"]) {
    const data = name === "returnLoanAction" ? { returnedOn: "2026-04-05" } : name === "updateLoanAction" ? { borrowerLabel: "Intruso", confirmed: true } : { confirmed: true }
    await fails(name, { id: current.id, expectedVersion: current.version, ...data }, sb, "NOT_FOUND")
  }
  assert.deepEqual(value(await ctx.call("listActiveLoansAction", [], sb)), [])
})

test("loans: devolución con versión, reintento y préstamo sucesivo conservando historial", async () => {
  await fails("returnLoanAction", { id: current.id, expectedVersion: randomUUID(), returnedOn: "2026-04-05" }, sa, "CONFLICT")
  await fails("returnLoanAction", { id: current.id, expectedVersion: current.version, returnedOn: "2026-03-28" }, sa, "INVALID_INPUT")
  const payload = { id: current.id, expectedVersion: current.version, returnedOn: "2026-04-05" }
  current = value(await ctx.call("returnLoanAction", [payload], sa))
  assert.equal(current.returnedOn, "2026-04-05")
  assert.equal(value(await ctx.call("returnLoanAction", [payload], sa)).version, current.version)
  await fails("returnLoanAction", { ...payload, returnedOn: "2026-04-06" }, sa, "CONFLICT")
  current = value(await ctx.call("openLoanAction", [{ ...open(lib.books[0].id, "Luis", "2026-04-06"), dueOn: "2026-10-25" }], sa))
  const history = value(await ctx.call("getCopyLoansAction", [lib.books[0].id], sa))
  assert.equal(history.length, 2)
  assert.equal(history.filter((row) => !row.returnedOn).length, 1)
  assert.equal(history.find((row) => row.id === first.id).returnedOn, "2026-04-05")
})

test("loans: editar confirmado rota versión y las pestañas antiguas no sobrescriben ni borran", async () => {
  const old = current
  current = value(await ctx.call("updateLoanAction", [{ id: old.id, expectedVersion: old.version, borrowerLabel: "Vecina 3.º B", dueOn: "", note: "Sin prisa", confirmed: true }], sa))
  assert.notEqual(current.version, old.version)
  assert.equal(current.dueOn, undefined); assert.equal(current.note, "Sin prisa")
  await fails("updateLoanAction", { id: old.id, expectedVersion: old.version, borrowerLabel: "Otro", confirmed: true }, sa, "CONFLICT")
  await fails("deleteLoanAction", { id: old.id, expectedVersion: old.version, confirmed: true }, sa, "CONFLICT")
  await fails("returnLoanAction", { id: old.id, expectedVersion: old.version, returnedOn: "2026-04-07" }, sa, "CONFLICT")
})

test("loans: fechas civiles idénticas en varios husos, también en la lectura de la acción", async () => {
  for (const zone of ["Pacific/Kiritimati", "America/Los_Angeles", "Europe/Madrid", "UTC"]) {
    const dates = await ctx.inTimeZone(a.id, zone, async (tx) => {
      const [loan] = await tx`select biblib.loan_open(${lib.books[2].id}::uuid, 'Ana', '2026-03-29', '2026-10-25', null) as result`
      const [row] = await tx`select loaned_on::text as start, due_on::text as due from biblib.loans where id = ${loan.result.loan_id}`
      return { ...row }
    })
    assert.deepEqual(dates, { start: "2026-03-29", due: "2026-10-25" }, zone)
  }
  assert.equal(value(await ctx.call("getCopyLoansAction", [lib.books[0].id], sa)).find((row) => row.id === current.id).loanedOn, "2026-04-06")
})

test("loans: exportación e importación v2 por acciones conservan préstamos e historial", async () => {
  const prepared = value(await ctx.call("prepareLibraryExportAction", [], sa))
  assert.equal(prepared.formatVersion, 2)
  const response = await ctx.get(prepared.parts[0].href, sa)
  assert.equal(response.status, 200)
  const file = JSON.parse(response.body.toString("utf8"))
  assert.ok(file.requiredCapabilities.includes("copies.loans"))
  const exported = file.copies.find((copy) => copy.id === lib.books[0].id).loans
  assert.equal(exported.length, 2)
  assert.equal(exported.find((loan) => loan.id === first.id).returnedOn, "2026-04-05")
  value(await ctx.call("deleteLoanAction", [{ id: current.id, expectedVersion: current.version, confirmed: true }], sa))
  const preview = value(await ctx.call("prepareImportAction", [file, "replace"], sa))
  const committed = value(await ctx.call("confirmImportAction", [{ previewId: preview.previewId, expectedRevision: preview.revision, idempotencyKey: ctx.key("loans-v2") }], sa))
  assert.equal(committed.status, "committed")
  const restored = value(await ctx.call("getCopyLoansAction", [lib.books[0].id], sa))
  const portable = restored.map((row) => { const loan = { ...row }; delete loan.version; delete loan.copyId; delete loan.title; return loan })
  assert.deepEqual(portable.sort((x, y) => x.id.localeCompare(y.id)), exported.sort((x, y) => x.id.localeCompare(y.id)))
  current = restored.find((row) => row.id === current.id)
})

test("loans: borrado confirmado de un préstamo conserva el ejemplar; libro borrado no deja historial", async () => {
  value(await ctx.call("deleteLoanAction", [{ id: current.id, expectedVersion: current.version, confirmed: true }], sa))
  assert.equal(value(await ctx.call("getCopyLoansAction", [lib.books[0].id], sa)).length, 1)
  const [copy] = await ctx.sql`select version from biblib.copies where id = ${lib.books[1].id}`
  const [loan] = await ctx.sql`select id, version from biblib.loans where copy_id = ${lib.books[1].id}`
  value(await ctx.call("deleteBookAction", [lib.books[1].id, copy.version], sa))
  await fails("getCopyLoansAction", lib.books[1].id, sa, "NOT_FOUND")
  await fails("openLoanAction", open(lib.books[1].id), sa, "NOT_FOUND")
  await fails("returnLoanAction", { id: loan.id, expectedVersion: loan.version, returnedOn: "2026-04-06" }, sa, "NOT_FOUND")
  const [{ count }] = await ctx.sql`select count(*)::int as count from biblib.loans where copy_id = ${lib.books[1].id}`
  assert.equal(count, 0)
  assert.equal(value(await ctx.call("getLoanCountAction", [], sa)), 0)
})

test("loans: una cuenta inactiva no presta, devuelve, edita ni borra con su sesión anterior", async () => {
  const loan = value(await ctx.call("openLoanAction", [open(other.books[0].id)], sb))
  await ctx.asUser(b.id, (tx) => tx`select biblib.account_deletion_request(${ctx.key("loans-inactive")})`)
  await fails("openLoanAction", open(other.books[1].id), sb, "ACCOUNT_INACTIVE")
  await fails("returnLoanAction", { id: loan.id, expectedVersion: loan.version, returnedOn: "2026-04-06" }, sb, "ACCOUNT_INACTIVE")
  await fails("updateLoanAction", { id: loan.id, expectedVersion: loan.version, borrowerLabel: "Ana", confirmed: true }, sb, "ACCOUNT_INACTIVE")
  await fails("deleteLoanAction", { id: loan.id, expectedVersion: loan.version, confirmed: true }, sb, "ACCOUNT_INACTIVE")
})
