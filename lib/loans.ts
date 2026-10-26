import { z } from "zod"
import { isCivilDate, isValidBorrowerLabel, LOAN_LIMITS, type Loan, type LoanOpenResult, type LoanReturnResult } from "./product/reading-loans"

/** Préstamo privado con el token que protege cada modificación y el enlace a su ejemplar. */
export interface LoanRecord extends Loan {
  copyId: string
  title: string
  version: string
}

export const LOAN_ALIAS_ERROR = "Escribe un alias corto de 1 a 40 caracteres, como «Ana» o «Vecina 3.º B», sin datos de contacto."
export const LOAN_CHANGED = "El préstamo ha cambiado. Recarga los préstamos antes de volver a modificarlo."
export const loanIdSchema = z.uuid("El identificador del préstamo o del ejemplar no es válido.")
const civilDate = z.string().refine(isCivilDate, "Indica una fecha válida entre 1900 y 2999.")
const optionalDate = z.union([civilDate, z.literal(""), z.null()]).optional().transform((value) => value || null)
const alias = z.string().refine(isValidBorrowerLabel, LOAN_ALIAS_ERROR)
const note = z.string().trim().refine((value) => [...value].length <= LOAN_LIMITS.noteMax, "La nota admite hasta 500 caracteres.")
  .nullish().transform((value) => value || null)
const details = { borrowerLabel: alias, dueOn: optionalDate, note }
const versioned = { id: loanIdSchema, expectedVersion: loanIdSchema }

export const openLoanSchema = z.object({ copyId: loanIdSchema, loanedOn: civilDate, ...details }).strict()
  .refine((value) => value.dueOn === null || value.dueOn >= value.loanedOn, { message: "La fecha acordada no puede ser anterior a la salida.", path: ["dueOn"] })
export const returnLoanSchema = z.object({ ...versioned, returnedOn: civilDate }).strict()
export const updateLoanSchema = z.object({ ...versioned, ...details, confirmed: z.literal(true, "Confirma los cambios del préstamo.") }).strict()
export const deleteLoanSchema = z.object({ ...versioned, confirmed: z.literal(true, "Confirma el borrado del préstamo.") }).strict()

/** El contrato SQL reconoce la respuesta perdida por alias y fecha de salida, sin volver a escribir. */
export function isOwnLoanOpenRetry(result: LoanOpenResult, input: { borrowerLabel: string; loanedOn: string }): boolean {
  return result.status === "active" && result.borrower_label === input.borrowerLabel && result.loaned_on === input.loanedOn
}

export function isOwnLoanReturnRetry(result: LoanReturnResult, returnedOn: string): boolean {
  return result.status === "already_returned" && result.returned_on === returnedOn
}

/** Presentación de una fecha civil sin convertirla en un instante ni desplazarla de día. */
export function loanDateLabel(value: string): string {
  const [year, month, day] = value.split("-")
  return `${day}/${month}/${year}`
}
