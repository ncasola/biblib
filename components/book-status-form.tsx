"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import type { Book } from "@/lib/types"
import { DomainError } from "@/lib/domain-errors"

interface BookStatusFormProps {
  currentStatus: Book["status"]
  onStatusChange: (status: Book["status"]) => Promise<void>
  disabled?: boolean
}

export function BookStatusForm({ currentStatus, onStatusChange, disabled = false }: BookStatusFormProps) {
  const [pending, setPending] = useState<Book["status"] | null>(null)
  const [error, setError] = useState("")
  const statuses: { value: Book["status"]; label: string }[] = [
    { value: "unread", label: "Sin leer" }, { value: "reading", label: "Leyendo" },
    { value: "read", label: "Leído" }, { value: "to-read", label: "Por leer" },
  ]
  const change = async (status: Book["status"]) => {
    if (pending || disabled || status === currentStatus) return
    setPending(status); setError("")
    try { await onStatusChange(status) } catch (caught) {
      setError(caught instanceof DomainError ? caught.message : "No se pudo cambiar el estado. Comprueba la conexión y vuelve a intentarlo.")
    } finally { setPending(null) }
  }
  return <div aria-busy={Boolean(pending)} className="space-y-3">
    <p className="text-sm text-muted-foreground">Estado de lectura</p>
    <div role="group" aria-label="Estado de lectura" className="grid grid-cols-2 gap-2">
      {statuses.map((status) => <Button type="button" key={status.value} onClick={() => void change(status.value)} disabled={disabled || Boolean(pending)} aria-pressed={currentStatus === status.value} variant={currentStatus === status.value ? "default" : "outline"}>{pending === status.value ? "Guardando..." : status.label}</Button>)}
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>
}
