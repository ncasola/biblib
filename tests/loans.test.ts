import assert from "node:assert/strict"
import { test } from "node:test"
import { deleteLoanSchema, isOwnLoanOpenRetry, isOwnLoanReturnRetry, LOAN_ALIAS_ERROR, loanDateLabel, openLoanSchema, returnLoanSchema, updateLoanSchema } from "../lib/loans"
import { civilDateInZone, isLoanOverdue, LOAN_REMINDERS_SENT } from "../lib/product/reading-loans"

const ID = "00000000-0000-4000-8000-000000000001"
const VERSION = "00000000-0000-4000-8000-000000000002"
const input = { copyId: ID, borrowerLabel: "Vecina 3.º B", loanedOn: "2026-03-29" }

test("préstamos: fechas civiles existentes, vencimiento opcional y límites sin conversión", () => {
  assert.deepEqual(openLoanSchema.parse(input), { ...input, dueOn: null, note: null })
  assert.equal(openLoanSchema.parse({ ...input, dueOn: "", note: "  " }).dueOn, null)
  for (const date of ["2026-02-29", "2026-03-29T00:00:00Z", "1899-12-31", "3000-01-01"]) assert.equal(openLoanSchema.safeParse({ ...input, loanedOn: date }).success, false, date)
  assert.equal(openLoanSchema.safeParse({ ...input, dueOn: "2026-03-28" }).success, false)
  assert.equal(openLoanSchema.safeParse({ ...input, note: "a".repeat(501) }).success, false)
  assert.equal(loanDateLabel("2026-03-29"), "29/03/2026")
})

test("préstamos: alias inválido explica cómo escribir un alias sin sugerir contactos", () => {
  for (const borrowerLabel of ["", " Ana", "Ana ", "Ana\n", "ana@example.com", "+34 600 123 456", "a".repeat(41)]) {
    const parsed = openLoanSchema.safeParse({ ...input, borrowerLabel })
    assert.equal(parsed.success, false)
    if (!parsed.success) assert.equal(parsed.error.issues[0].message, LOAN_ALIAS_ERROR)
  }
  assert.equal(openLoanSchema.safeParse({ ...input, borrowerLabel: "Á".repeat(40) }).success, true)
  assert.doesNotMatch(LOAN_ALIAS_ERROR, /correo|teléfono|email/i)
})

test("préstamos: reintento propio de alta por alias y fecha; otros intentos no se reconocen", () => {
  const active = { status: "active", loan_id: ID, version: VERSION, borrower_label: input.borrowerLabel, loaned_on: input.loanedOn } as const
  assert.equal(isOwnLoanOpenRetry(active, input), true)
  assert.equal(isOwnLoanOpenRetry(active, { ...input, borrowerLabel: "Ana" }), false)
  assert.equal(isOwnLoanOpenRetry(active, { ...input, loanedOn: "2026-03-30" }), false)
  assert.equal(isOwnLoanOpenRetry({ status: "not_found" }, input), false)
  assert.equal(isOwnLoanReturnRetry({ status: "already_returned", returned_on: "2026-04-05", version: VERSION }, "2026-04-05"), true)
  assert.equal(isOwnLoanReturnRetry({ status: "already_returned", returned_on: "2026-04-06", version: VERSION }, "2026-04-05"), false)
})

test("préstamos: modificar y borrar exigen versión y confirmación explícita", () => {
  const edit = { id: ID, expectedVersion: VERSION, borrowerLabel: "Ana", confirmed: true }
  assert.equal(updateLoanSchema.safeParse(edit).success, true)
  assert.equal(updateLoanSchema.safeParse({ ...edit, confirmed: false }).success, false)
  assert.equal(updateLoanSchema.safeParse({ ...edit, expectedVersion: undefined }).success, false)
  assert.equal(deleteLoanSchema.safeParse({ id: ID, expectedVersion: VERSION }).success, false)
  assert.equal(deleteLoanSchema.safeParse({ id: ID, expectedVersion: VERSION, confirmed: true }).success, true)
  assert.equal(returnLoanSchema.safeParse({ id: ID, expectedVersion: VERSION, returnedOn: null }).success, false)
  for (const extra of [{ userId: ID }, { remindersSent: true }, { returnedOn: "2026-04-05" }]) assert.equal(openLoanSchema.safeParse({ ...input, ...extra }).success, false)
})

test("préstamos: vencido según hoy civil de la persona, incluidas medianoche y cambio de hora", () => {
  const instant = new Date("2026-03-29T00:30:00Z")
  const loan = { dueOn: "2026-03-28" }
  assert.equal(isLoanOverdue(loan, civilDateInZone(instant, "Europe/Madrid")), true)
  assert.equal(isLoanOverdue(loan, civilDateInZone(instant, "America/Los_Angeles")), false)
  assert.equal(isLoanOverdue({}, "2026-03-29"), false)
  assert.equal(isLoanOverdue({ ...loan, returnedOn: "2026-03-29" }, "2026-03-30"), false)
  assert.equal(LOAN_REMINDERS_SENT, false)
})
