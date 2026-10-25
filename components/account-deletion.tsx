"use client"

import { useEffect, useRef, useState, type FormEvent } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { AlertTriangle, Download, LoaderCircle, LogIn, Trash2 } from "lucide-react"
import { getAccountDeletionStatusAction, requestAccountDeletionAction } from "@/app/actions/account"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ADMIN_BACKUP_RETENTION_DAYS, DELETION_CONFIRMATION, DELETION_PHASE_TEXT, DELETION_SCOPE, type AccountDeletionView } from "@/lib/account-deletion/contracts"
import { useAuth } from "@/lib/auth-context"

const longDate = (iso: string) => new Date(iso).toLocaleString("es", { dateStyle: "long", timeStyle: "short" })

/**
 * U-OPS-03 · Eliminar la cuenta desde Perfil: alcance, exportar antes, confirmación escrita e inicio de sesión
 * reciente. La cuenta es siempre la de la sesión; repetir la confirmación devuelve la misma solicitud.
 */
export function AccountDeletionSection() {
  const { signOut } = useAuth()
  const router = useRouter()
  const [view, setView] = useState<AccountDeletionView | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [confirmation, setConfirmation] = useState("")
  const [acknowledged, setAcknowledged] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState("")
  const [reauth, setReauth] = useState(false)
  // Una clave por confirmación: un doble clic o un reintento tras perder la respuesta repiten la misma solicitud.
  const operationKey = useRef("")

  useEffect(() => {
    let active = true
    getAccountDeletionStatusAction().then((result) => {
      if (!active) return
      if (result.ok) setView(result.value)
      else setLoadFailed(true)
    }).catch(() => { if (active) setLoadFailed(true) })
    return () => { active = false }
  }, [])

  const matches = confirmation.trim().toLocaleUpperCase("es") === DELETION_CONFIRMATION

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (working || !matches || !acknowledged) return
    operationKey.current ||= crypto.randomUUID()
    setWorking(true)
    setError("")
    setReauth(false)
    try {
      const result = await requestAccountDeletionAction({ confirmation, operationKey: operationKey.current })
      if (result.ok) setView(result.value)
      else {
        setReauth(result.error.code === "REAUTH_REQUIRED")
        setError(result.error.message)
      }
    } catch {
      setError("No se pudo enviar la solicitud. Comprueba la conexión y vuelve a intentarlo: si ya se registró, verás el mismo estado.")
    } finally {
      setWorking(false)
    }
  }

  const signInAgain = async () => {
    try { await signOut() } catch { /* La página de acceso vuelve a pedir la sesión igualmente. */ }
    router.push("/login?redirect=%2Fprofile")
  }

  return (
    <Card className="mt-8 p-5 sm:p-8 bg-card/80 backdrop-blur-xl border-2 border-border/50 rounded-2xl" aria-labelledby="account-deletion-title">
      <h2 id="account-deletion-title" className="text-2xl font-bold heading-vintage mb-4 flex items-center gap-2">
        <Trash2 aria-hidden="true" className="w-6 h-6 text-vintage-red" />Eliminar la cuenta
      </h2>

      {!view && !loadFailed && <p role="status" className="text-sm">Comprobando el estado de tu cuenta…</p>}
      {loadFailed && <p role="alert" className="text-destructive text-sm">No se pudo comprobar si ya pediste la eliminación. Recarga la página antes de continuar.</p>}

      {view && view.phase !== "none" && (
        <div role="status" className="space-y-3">
          <p className="font-semibold">{DELETION_PHASE_TEXT[view.phase]}</p>
          {view.requestedAt && <p className="text-sm text-muted-foreground">Solicitada el {longDate(view.requestedAt)}.</p>}
          {view.sessionsRevoked !== undefined && (
            <p className="text-sm">{view.sessionsRevoked ? "Hemos cerrado tu sesión en todos los dispositivos." : "Cerraremos tu sesión en todos los dispositivos en los próximos minutos."}</p>
          )}
          <p className="text-sm text-muted-foreground">La eliminación no se puede deshacer. Las copias administrativas del servicio caducan en un máximo de {ADMIN_BACKUP_RETENTION_DAYS} días y, si alguna se restaura, tu cuenta se vuelve a suprimir antes de abrir el servicio.</p>
          <Button asChild variant="outline" className="rounded-xl"><Link href="/login">Ir al inicio de sesión</Link></Button>
        </div>
      )}

      {view?.phase === "none" && (
        <div className="space-y-5">
          <div>
            <p className="mb-2">Se eliminarán de forma definitiva:</p>
            <ul className="list-disc pl-6 space-y-1 text-sm">
              {DELETION_SCOPE.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </div>
          <p className="text-sm text-muted-foreground">
            Las copias de seguridad administrativas no se borran al instante: caducan según su política (como máximo {ADMIN_BACKUP_RETENTION_DAYS} días) y,
            si alguna se restaura, tu cuenta se vuelve a suprimir antes de abrir el servicio. Solo se conserva una marca técnica, sin datos de tu biblioteca,
            para impedirlo.
          </p>
          <div className="rounded-xl border-2 border-vintage-yellow/60 p-4 text-sm">
            <p className="mb-3">¿Quieres conservar tu biblioteca? Descarga antes una copia: después no se podrá recuperar.</p>
            <Button asChild variant="outline" className="rounded-xl"><Link href="/settings"><Download aria-hidden="true" />Exportar mi biblioteca</Link></Button>
          </div>

          <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4" aria-busy={working}>
            <div className="space-y-2">
              <Label htmlFor="deletion-confirmation">Para confirmar, escribe «{DELETION_CONFIRMATION}»</Label>
              <Input id="deletion-confirmation" type="text" autoComplete="off" spellCheck={false} maxLength={100} value={confirmation} disabled={working}
                onChange={(event) => { setConfirmation(event.target.value); setError(""); setReauth(false) }} className="rounded-xl border-2" aria-describedby="deletion-session" />
              <p id="deletion-session" className="text-sm text-muted-foreground">Por seguridad, solo se acepta si iniciaste sesión hace menos de 15 minutos.</p>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={acknowledged} disabled={working} onChange={(event) => setAcknowledged(event.target.checked)} className="mt-1 h-4 w-4 accent-vintage-red" />
              <span>Entiendo que se eliminarán mi biblioteca y mi acceso, y que no se puede deshacer.</span>
            </label>
            {error && (
              <div role="alert" className="flex items-start gap-2 text-destructive text-sm">
                <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span>
              </div>
            )}
            <div className="flex flex-wrap gap-3">
              <Button type="submit" disabled={working || !matches || !acknowledged}>
                {working ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <Trash2 aria-hidden="true" />}
                {working ? "Enviando solicitud…" : "Eliminar mi cuenta"}
              </Button>
              {reauth && <Button type="button" variant="outline" onClick={() => void signInAgain()} className="rounded-xl"><LogIn aria-hidden="true" />Volver a iniciar sesión</Button>}
            </div>
          </form>
        </div>
      )}
    </Card>
  )
}
