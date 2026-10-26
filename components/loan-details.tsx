"use client"

import { useEffect, useState } from "react"
import { loanDateLabel } from "@/lib/loans"
import { civilDateInZone, isLoanOverdue, LOAN_NO_DUE_DATE_TEXT, type Loan } from "@/lib/product/reading-loans"

/** Hoy en el navegador de la persona, también al volver a la pestaña o cruzar medianoche. */
export function useLoanToday() {
  const [today, setToday] = useState("")
  useEffect(() => {
    const update = () => setToday(civilDateInZone(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone))
    update()
    const timer = window.setInterval(update, 60_000)
    window.addEventListener("focus", update)
    return () => { window.clearInterval(timer); window.removeEventListener("focus", update) }
  }, [])
  return today
}

export function LoanDetails({ loan, today }: { loan: Loan; today: string }) {
  const overdue = Boolean(today) && isLoanOverdue(loan, today)
  return <div className="space-y-1 text-sm">
    <p className="font-semibold break-words">{loan.borrowerLabel}</p>
    <p className="text-foreground-light">Salida: <time dateTime={loan.loanedOn}>{loanDateLabel(loan.loanedOn)}</time></p>
    <p className={overdue ? "font-semibold text-[var(--status-loaned)]" : "text-foreground-light"}>
      {loan.dueOn ? <>{overdue ? "Vencido desde el " : "Fecha acordada: "}<time dateTime={loan.dueOn}>{loanDateLabel(loan.dueOn)}</time></> : LOAN_NO_DUE_DATE_TEXT}
    </p>
    {loan.returnedOn && <p>Devuelto el <time dateTime={loan.returnedOn}>{loanDateLabel(loan.returnedOn)}</time></p>}
    {loan.note && <p className="whitespace-pre-wrap break-words text-foreground-light">{loan.note}</p>}
  </div>
}
