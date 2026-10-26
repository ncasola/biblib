"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { listActiveLoansAction } from "@/app/actions/loans"
import { LoanDetails, useLoanToday } from "@/components/loan-details"
import { PageHeader } from "@/components/page-header"
import { LoadingState } from "@/components/loading-state"
import { Button } from "@/components/ui/button"
import { unwrapAction } from "@/lib/action-result"
import type { LoanRecord } from "@/lib/loans"
import { isLoanOverdue } from "@/lib/product/reading-loans"

export function LoanList() {
  const today = useLoanToday()
  const [rows, setRows] = useState<LoanRecord[] | null>(null)
  const [error, setError] = useState(false)
  const [onlyOverdue, setOnlyOverdue] = useState(false)
  const load = useCallback(() => listActiveLoansAction().then((result) => {
    setRows(unwrapAction(result)); setError(false)
  }).catch(() => { setError(true) }), [])
  useEffect(() => { void load() }, [load])
  const visible = rows?.filter((loan) => !onlyOverdue || Boolean(today) && isLoanOverdue(loan, today))
  return <>
    <PageHeader eyebrow="Tu biblioteca" title="Prestados" description="Ejemplares que has prestado, con su alias y fecha acordada." actions={<Button asChild variant="outline"><Link href="/books">Ver biblioteca</Link></Button>} />
    {error ? <div role="alert" className="surface-card p-5 space-y-3"><p>No se pudieron consultar los préstamos.</p><Button variant="outline" onClick={() => void load()}>Reintentar</Button></div> : rows === null ? <LoadingState message="Cargando préstamos…" /> : <div className="space-y-6">
      <label className="inline-flex min-h-11 items-center gap-3"><input type="checkbox" checked={onlyOverdue} disabled={!today} onChange={(event) => setOnlyOverdue(event.target.checked)} className="size-5 accent-primary" />Solo vencidos</label>
      <p className="text-sm text-muted-foreground">{rows.length} {rows.length === 1 ? "ejemplar prestado" : "ejemplares prestados"}</p>
      {visible?.length ? <ul aria-label="Ejemplares prestados" className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{visible.map((loan) => <li key={loan.id} className="surface-card min-w-0 p-5 space-y-3"><Link href={`/book/${loan.copyId}`} className="link-quiet inline-flex min-h-11 items-center font-heading text-xl font-bold break-words">{loan.title}</Link><LoanDetails loan={loan} today={today} /><Link href={`/book/${loan.copyId}#loans-heading`} className="link-quiet inline-flex min-h-11 items-center text-sm">Gestionar préstamo</Link></li>)}</ul> : <p className="rounded-2xl border border-dashed border-border bg-surface/50 p-6 text-foreground-light">{onlyOverdue ? "No hay préstamos vencidos." : "No tienes ejemplares prestados. Puedes registrar un préstamo desde la ficha de un libro."}</p>}
    </div>}
  </>
}
