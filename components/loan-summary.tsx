"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { getLoanCountAction } from "@/app/actions/loans"
import { Button } from "@/components/ui/button"
import { unwrapAction } from "@/lib/action-result"

export function LoanSummary() {
  const [count, setCount] = useState<number | null>(null)
  const [error, setError] = useState(false)
  const load = () => getLoanCountAction().then((result) => {
    setCount(unwrapAction(result)); setError(false)
  }).catch(() => { setError(true) })
  useEffect(() => { void load() }, [])
  if (error) return <div className="surface-card p-4 text-sm"><p role="alert">No se pudo consultar la cifra de prestados.</p><Button variant="ghost" onClick={() => void load()}>Reintentar</Button></div>
  return <Link href="/loans" className="surface-card flex flex-col gap-1 p-4 hover:shadow-xl motion-safe:hover:-translate-y-0.5"><span className="font-heading text-3xl font-bold leading-none text-[var(--status-loaned)]">{count ?? "…"}</span><span className="text-sm text-muted-foreground">Prestados</span></Link>
}
