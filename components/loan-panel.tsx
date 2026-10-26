"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { deleteLoanAction, getCopyLoansAction, openLoanAction, returnLoanAction, updateLoanAction } from "@/app/actions/loans"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { LoadingState } from "@/components/loading-state"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { LoanDetails, useLoanToday } from "@/components/loan-details"
import { unwrapAction } from "@/lib/action-result"
import { LOAN_LIMITS, CIVIL_DATE_RANGE } from "@/lib/product/reading-loans"
import type { LoanRecord } from "@/lib/loans"

function message(error: unknown) { return error instanceof Error ? error.message : "No se pudo guardar el préstamo. Comprueba la conexión y vuelve a intentarlo." }

function LoanFields({ prefix, borrower, setBorrower, due, setDue, note, setNote, min }: {
  prefix: string; borrower: string; setBorrower: (value: string) => void; due: string; setDue: (value: string) => void;
  note: string; setNote: (value: string) => void; min: string
}) {
  return <>
    <div className="space-y-1"><label htmlFor={`${prefix}-alias`} className="text-sm font-semibold">Alias de la persona</label><Input id={`${prefix}-alias`} required maxLength={LOAN_LIMITS.borrowerLabelMax} value={borrower} onChange={(event) => setBorrower(event.target.value)} aria-describedby={`${prefix}-hint`} /><p id={`${prefix}-hint`} className="text-xs text-muted-foreground">Un alias corto, como «Ana» o «Vecina 3.º B», sin datos de contacto.</p></div>
    <div className="space-y-1"><label htmlFor={`${prefix}-due`} className="text-sm font-semibold">Fecha acordada (opcional)</label><Input id={`${prefix}-due`} type="date" min={min} max={CIVIL_DATE_RANGE.max} value={due} onChange={(event) => setDue(event.target.value)} /><p className="text-xs text-muted-foreground">Déjala vacía si no hay fecha acordada.</p></div>
    <div className="space-y-1"><label htmlFor={`${prefix}-note`} className="text-sm font-semibold">Nota del préstamo (opcional)</label><textarea id={`${prefix}-note`} maxLength={LOAN_LIMITS.noteMax} value={note} onChange={(event) => setNote(event.target.value)} className="min-h-22 w-full rounded-xl border border-[var(--control-border)] bg-input px-3 py-2 text-sm" /></div>
  </>
}

function LoanItem({ loan, today, onChange, onDelete, onMessage }: { loan: LoanRecord; today: string; onChange: (loan: LoanRecord) => void; onDelete: (id: string) => void; onMessage: (text: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [borrower, setBorrower] = useState(loan.borrowerLabel)
  const [due, setDue] = useState(loan.dueOn ?? "")
  const [note, setNote] = useState(loan.note ?? "")
  const [returned, setReturned] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const [confirmation, setConfirmation] = useState<"edit" | "delete" | null>(null)

  async function save(kind: "return" | "edit" | "delete") {
    if (pending) return
    setPending(true); setError("")
    try {
      const base = { id: loan.id, expectedVersion: loan.version }
      if (kind === "delete") { unwrapAction(await deleteLoanAction({ ...base, confirmed: true })); onDelete(loan.id); onMessage("Préstamo borrado del historial.") }
      else {
        const updated = unwrapAction(await (kind === "return" ? returnLoanAction({ ...base, returnedOn: returned || today }) : updateLoanAction({ ...base, borrowerLabel: borrower, dueOn: due, note, confirmed: true })))
        onChange(updated); setEditing(false); onMessage(kind === "return" ? "Devolución registrada." : "Préstamo actualizado.")
      }
      setConfirmation(null)
    } catch (caught) { setError(message(caught)) }
    finally { setPending(false) }
  }

  return <li className="rounded-xl border border-border bg-surface/50 p-4 space-y-4">
    <LoanDetails loan={loan} today={today} />
    {!loan.returnedOn && <form aria-label="Registrar devolución" className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(event) => { event.preventDefault(); void save("return") }}>
      <div className="min-w-0 flex-1 space-y-1"><label htmlFor={`returned-${loan.id}`} className="text-sm font-semibold">Fecha de devolución</label><Input id={`returned-${loan.id}`} type="date" required min={loan.loanedOn} max={CIVIL_DATE_RANGE.max} value={returned || today} onChange={(event) => setReturned(event.target.value)} disabled={pending} /></div>
      <Button variant="secondary" disabled={pending || !today}>Registrar devolución</Button>
    </form>}
    {editing ? <form aria-label="Editar préstamo" className="space-y-3" onSubmit={(event) => { event.preventDefault(); setConfirmation("edit"); setError("") }}>
      <fieldset disabled={pending} className="space-y-3"><LoanFields prefix={loan.id} borrower={borrower} setBorrower={setBorrower} due={due} setDue={setDue} note={note} setNote={setNote} min={loan.loanedOn} />
        <div className="flex flex-wrap gap-2"><Button variant="secondary">Revisar cambios</Button><Button type="button" variant="ghost" onClick={() => setEditing(false)}>Cancelar edición</Button></div>
      </fieldset>
    </form> : <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={pending} onClick={() => { setBorrower(loan.borrowerLabel); setDue(loan.dueOn ?? ""); setNote(loan.note ?? ""); setEditing(true); setError("") }}>Editar préstamo</Button><Button variant="outline" disabled={pending} onClick={() => { setConfirmation("delete"); setError("") }}>Borrar préstamo</Button></div>}
    {error && !confirmation && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <AlertDialog open={confirmation !== null} onOpenChange={(open) => { if (!open && !pending) setConfirmation(null) }}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{confirmation === "delete" ? "¿Borrar este préstamo?" : "¿Guardar los cambios del préstamo?"}</AlertDialogTitle><AlertDialogDescription>{confirmation === "delete" ? "Se retirará este préstamo y su información del historial. Esta acción no se puede deshacer." : `Se guardarán el alias «${borrower}», la fecha acordada y la nota de este préstamo.`}</AlertDialogDescription></AlertDialogHeader>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <AlertDialogFooter><AlertDialogCancel disabled={pending}>Cancelar</AlertDialogCancel><AlertDialogAction asChild><Button variant={confirmation === "delete" ? "destructive" : "secondary"} disabled={pending} onClick={(event) => { event.preventDefault(); if (confirmation) void save(confirmation) }}>{pending ? "Guardando…" : confirmation === "delete" ? "Confirmar borrado" : "Confirmar cambios"}</Button></AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </li>
}

export function LoanPanel({ copyId }: { copyId: string }) {
  const today = useLoanToday()
  const [rows, setRows] = useState<LoanRecord[] | null>(null)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [pending, setPending] = useState(false)
  const [borrower, setBorrower] = useState("")
  const [loaned, setLoaned] = useState("")
  const [due, setDue] = useState("")
  const [note, setNote] = useState("")
  const load = useCallback(() => getCopyLoansAction(copyId).then((result) => {
    setRows(unwrapAction(result)); setError("")
  }).catch((caught: unknown) => { setError(message(caught)) }), [copyId])
  useEffect(() => { void load() }, [load])
  const active = rows?.find((loan) => !loan.returnedOn)
  const history = rows?.filter((loan) => loan.returnedOn) ?? []
  const change = (loan: LoanRecord) => setRows((previous) => previous?.map((row) => row.id === loan.id ? loan : row) ?? [loan])
  async function lend() {
    if (pending) return
    setPending(true); setError(""); setNotice("")
    try {
      const loan = unwrapAction(await openLoanAction({ copyId, borrowerLabel: borrower, loanedOn: loaned || today, dueOn: due, note }))
      setRows((previous) => [loan, ...(previous ?? []).filter((row) => row.id !== loan.id)])
      setBorrower(""); setLoaned(""); setDue(""); setNote(""); setNotice("Préstamo registrado.")
    } catch (caught) { setError(message(caught)) }
    finally { setPending(false) }
  }
  const item = (loan: LoanRecord) => <LoanItem key={`${loan.id}-${loan.version}`} loan={loan} today={today} onChange={change} onDelete={(id) => setRows((previous) => previous?.filter((row) => row.id !== id) ?? [])} onMessage={setNotice} />
  return <section aria-labelledby="loans-heading" className="surface-card p-5 space-y-5">
    <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 id="loans-heading" className="heading-vintage text-2xl">Préstamos</h2><Link href="/loans" className="link-quiet inline-flex min-h-11 items-center">Ver prestados</Link></div>
    {notice && <p role="status" className="rounded-xl border border-l-4 border-border border-l-[var(--status-read)] p-3 text-sm">{notice}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Button type="button" variant="outline" disabled={pending} onClick={() => void load()}>Recargar préstamos</Button>
    {rows === null ? <LoadingState message="Cargando préstamos…" /> : <>
      {active ? <div className="space-y-3"><h3 className="font-heading text-xl">Préstamo activo</h3><ul>{item(active)}</ul></div> : <>
        <p className="text-sm text-foreground-light">Este ejemplar está disponible para prestar.</p>
        <form aria-label="Nuevo préstamo" className="space-y-3" onSubmit={(event) => { event.preventDefault(); void lend() }}>
          <fieldset disabled={pending} className="space-y-3"><LoanFields prefix={`new-${copyId}`} borrower={borrower} setBorrower={setBorrower} due={due} setDue={setDue} note={note} setNote={setNote} min={loaned || today || CIVIL_DATE_RANGE.min} />
            <div className="space-y-1"><label htmlFor={`loaned-${copyId}`} className="text-sm font-semibold">Fecha de salida</label><Input id={`loaned-${copyId}`} type="date" required min={CIVIL_DATE_RANGE.min} max={CIVIL_DATE_RANGE.max} value={loaned || today} onChange={(event) => setLoaned(event.target.value)} /></div>
            <Button variant="secondary" disabled={pending || !today}>{pending ? "Guardando…" : "Prestar ejemplar"}</Button>
          </fieldset>
        </form>
      </>}
      <div className="space-y-3"><h3 className="font-heading text-xl">Historial de préstamos</h3>{history.length ? <ul className="space-y-3">{history.map(item)}</ul> : <p className="rounded-xl border border-dashed border-border bg-surface/50 p-4 text-sm text-muted-foreground">Aún no hay devoluciones registradas.</p>}</div>
    </>}
  </section>
}
