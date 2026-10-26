"use client"

import { useCallback, useEffect, useId, useState, type FormEvent } from "react"
import { CloudOff, KeyRound, LoaderCircle, RefreshCw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { useAuth } from "@/lib/auth-context"
import { getOfflineSnapshotAction } from "@/app/actions/offline-library"
import { revalidateOfflineCopy, useOfflineConfig } from "@/components/offline-runtime"
import {
  browserOfflineLibrary, maskEmail, offlineAccountId, offlineDate, OfflineCopyError, validateOfflineSecret, writeOfflineAccountPointer,
  OFFLINE_MAX_FAILED_UNLOCKS, OFFLINE_PHRASE_MIN_CHARS, OFFLINE_PIN_MIN_DIGITS, type OfflineCopyStatus,
} from "@/lib/offline-library"

// U-EXP-08 · Ajuste «Guardar copia de lectura en este dispositivo». Opt-in con PIN o frase; ver la fecha,
// renovarla y quitarla. Detrás de BIBLIB_OFFLINE_SNAPSHOT=1 (contrato: docs/spec-pendientes/contratos-o15.md).

type View = { state: "loading" } | { state: "unsupported" } | OfflineCopyStatus
type Notice = { type: "success" | "error"; text: string }

async function readCopyStatus(userId: string): Promise<View> {
  try {
    // Esta página tiene sesión y conexión: cuenta como validación en línea de la copia de la cuenta.
    await revalidateOfflineCopy(userId).catch(() => false)
    return await browserOfflineLibrary().status(await offlineAccountId(userId))
  } catch (error) {
    return error instanceof OfflineCopyError && error.code === "UNSUPPORTED" ? { state: "unsupported" } : { state: "corrupt" }
  }
}

const errorText =(error: unknown) => error instanceof OfflineCopyError ? error.message : "No se pudo completar la operación con la copia de este dispositivo. Vuelve a intentarlo."

export function OfflineCopySettings() {
  const { snapshotEnabled } = useOfflineConfig()
  const { user } = useAuth()
  const [view, setView] = useState<View>({ state: "loading" })
  const [working, setWorking] = useState<"create" | "renew" | "remove" | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [secret, setSecret] = useState("")
  const [repeat, setRepeat] = useState("")
  const [accepted, setAccepted] = useState(false)
  const [renewing, setRenewing] = useState(false)
  const [renewSecret, setRenewSecret] = useState("")
  const [confirmRemove, setConfirmRemove] = useState(false)
  const ids = useId()
  const userId = user?.id
  const email = user?.email ?? ""

  const load = useCallback(() => userId ? readCopyStatus(userId).then(setView) : Promise.resolve(), [userId])

  useEffect(() => { if (snapshotEnabled) void load() }, [snapshotEnabled, load])

  if (!snapshotEnabled || !userId) return null

  const download = async () => {
    const response = await getOfflineSnapshotAction()
    if (!response.ok) throw new OfflineCopyError("NOT_FOUND", response.error.message)
    return response.value
  }

  const create = async (event: FormEvent) => {
    event.preventDefault()
    if (working) return
    const checked = validateOfflineSecret(secret)
    if (!checked.ok) { setNotice({ type: "error", text: checked.message }); return }
    if (secret !== repeat) { setNotice({ type: "error", text: "El PIN o la frase no coinciden." }); return }
    if (!accepted) { setNotice({ type: "error", text: "Confirma que entiendes que la copia queda guardada en este dispositivo." }); return }
    setWorking("create")
    setNotice(null)
    try {
      const accountId = await offlineAccountId(userId)
      const snapshot = await download()
      const opened = await browserOfflineLibrary().create(accountId, { secret, maskedEmail: maskEmail(email), snapshot })
      writeOfflineAccountPointer(accountId)
      setSecret("")
      setRepeat("")
      setAccepted(false)
      setNotice({ type: "success", text: `Copia de lectura guardada en este dispositivo con ${opened.snapshot.books.length} libros. Ábrela sin conexión en «Abrir copia sin conexión».` })
      await load()
    } catch (error) {
      setNotice({ type: "error", text: errorText(error) })
    } finally {
      setWorking(null)
    }
  }

  const renew = async (event: FormEvent) => {
    event.preventDefault()
    if (working) return
    setWorking("renew")
    setNotice(null)
    try {
      const library = browserOfflineLibrary()
      const accountId = await offlineAccountId(userId)
      const opened = await library.unlock(accountId, renewSecret)
      const renewed = await library.renew(opened, await download())
      setRenewSecret("")
      setRenewing(false)
      setNotice({ type: "success", text: `Copia renovada: ${renewed.snapshot.books.length} libros a fecha de ${offlineDate(renewed.generatedAt)}.` })
    } catch (error) {
      setNotice({ type: "error", text: errorText(error) })
    } finally {
      setWorking(null)
      await load()
    }
  }

  const remove = async () => {
    if (working) return
    setConfirmRemove(false)
    setWorking("remove")
    setNotice(null)
    try {
      await browserOfflineLibrary().remove(await offlineAccountId(userId))
      setRenewing(false)
      setNotice({ type: "success", text: "Se ha quitado la copia de lectura de este dispositivo." })
    } catch (error) {
      setNotice({ type: "error", text: errorText(error) })
    } finally {
      setWorking(null)
      await load()
    }
  }

  return (
    <section aria-labelledby={`${ids}-title`} aria-busy={working !== null || view.state === "loading"} className="surface-card rounded-2xl p-5 md:p-8" data-offline-copy={view.state}>
      <h2 id={`${ids}-title`} className="text-2xl font-bold mb-2 flex items-center gap-2"><CloudOff aria-hidden="true" className="size-6 text-brass-text" />Copia de lectura sin conexión</h2>
      <p className="text-muted-foreground mb-4">Guarda en este dispositivo una copia cifrada de tu catálogo para consultarlo sin conexión. Es opcional, solo de lectura y de esta cuenta: sin conexión no se puede cambiar nada.</p>
      <details className="mb-5 text-sm">
        <summary className="cursor-pointer font-medium">Qué guarda y cómo se protege</summary>
        <ul className="list-disc pl-5 mt-3 space-y-2 text-muted-foreground">
          <li>Incluye libros, ediciones y ejemplares, estanterías, ubicaciones, series, etiquetas y el estado de lectura actual.</li>
          <li>No incluye notas privadas ni valoraciones, el nombre de quien tiene un libro prestado (solo verás «Prestado»), el historial de lectura, las portadas ni los datos de tu cuenta, salvo tu correo enmascarado.</li>
          <li>Se cifra con un PIN de al menos {OFFLINE_PIN_MIN_DIGITS} dígitos o una frase de al menos {OFFLINE_PHRASE_MIN_CHARS} caracteres que no se guarda en ningún sitio. Si lo olvidas no se puede recuperar: tendrás que quitar la copia y descargarla otra vez con conexión.</li>
          <li>Tras {OFFLINE_MAX_FAILED_UNLOCKS} intentos fallidos seguidos se borra la copia de este dispositivo.</li>
          <li>Caduca a los 7 días de la última vez que abriste BibLib con conexión y esta sesión; entonces queda bloqueada hasta que vuelvas a entrar con conexión.</li>
          <li>Al cerrar sesión con conexión se borran la copia y su clave de este dispositivo. Si el dispositivo está sin conexión, nada de lo que hagas desde otro dispositivo la borra antes de que vuelva a conectarse o caduque.</li>
          <li>Evítala en dispositivos compartidos. El cifrado protege la copia guardada, no lo que se muestra en pantalla mientras está abierta.</li>
        </ul>
      </details>

      {view.state === "loading" && <p role="status" className="text-sm flex items-center gap-2"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Comprobando la copia de este dispositivo…</p>}
      {view.state === "unsupported" && <p className="text-sm text-destructive">Este navegador no permite guardar una copia cifrada (faltan IndexedDB o Web Crypto).</p>}

      {view.state === "corrupt" && <div role="alert" className="rounded-xl border border-destructive p-4 space-y-3">
        <p className="font-medium">La copia de este dispositivo está dañada o no se puede leer.</p>
        <p className="text-sm text-muted-foreground">Bórrala y vuelve a guardarla; necesitas conexión para descargarla otra vez.</p>
        <Button type="button" variant="destructive" disabled={working !== null} onClick={() => void remove()}><Trash2 aria-hidden="true" />Borrar la copia dañada</Button>
      </div>}

      {view.state === "none" && <form onSubmit={(event) => void create(event)} className="space-y-4" aria-describedby={`${ids}-requisitos`}>
        <p id={`${ids}-requisitos`} className="text-sm">PIN de al menos {OFFLINE_PIN_MIN_DIGITS} dígitos o frase de al menos {OFFLINE_PHRASE_MIN_CHARS} caracteres. Lo pediremos para abrir la copia sin conexión.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2"><label htmlFor={`${ids}-secreto`} className="text-sm font-medium">PIN o frase</label><Input id={`${ids}-secreto`} type="password" autoComplete="new-password" maxLength={128} value={secret} onChange={(event) => setSecret(event.target.value)} disabled={working !== null} required /></div>
          <div className="space-y-2"><label htmlFor={`${ids}-repetir`} className="text-sm font-medium">Repite el PIN o la frase</label><Input id={`${ids}-repetir`} type="password" autoComplete="new-password" maxLength={128} value={repeat} onChange={(event) => setRepeat(event.target.value)} disabled={working !== null} required /></div>
        </div>
        <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} disabled={working !== null} className="mt-1" /><span>Entiendo que la copia queda guardada en este dispositivo hasta que la quite, cierre sesión o se borre por intentos fallidos, y que sin el PIN o la frase no se puede recuperar.</span></label>
        <Button type="submit" variant="secondary" disabled={working !== null}>{working === "create" ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <KeyRound aria-hidden="true" />}{working === "create" ? "Guardando copia…" : "Guardar copia de lectura en este dispositivo"}</Button>
      </form>}

      {(view.state === "locked" || view.state === "expired") && <div className="space-y-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-muted-foreground">Copia del</dt><dd className="font-semibold text-lg">{offlineDate(view.generatedAt)}</dd></div>
          <div><dt className="text-muted-foreground">Cuenta</dt><dd className="font-semibold text-lg">{view.maskedEmail}</dd></div>
          <div><dt className="text-muted-foreground">Última validación con conexión</dt><dd>{offlineDate(view.validatedAt)}</dd></div>
          <div><dt className="text-muted-foreground">{view.state === "expired" ? "Caducó el" : "Caduca el"}</dt><dd>{offlineDate(view.expiresAt)}</dd></div>
        </dl>
        {view.state === "expired" && <p role="status" className="text-sm">La copia está bloqueada por caducidad. Se desbloqueará al validarla con esta sesión; si no ocurre, renuévala.</p>}
        {view.attemptsLeft < OFFLINE_MAX_FAILED_UNLOCKS && <p className="text-sm">Quedan {view.attemptsLeft} intentos antes de que se borre la copia de este dispositivo.</p>}
        <div className="flex flex-wrap gap-3">
          <Button asChild variant="secondary"><a href="/offline">Abrir copia sin conexión</a></Button>
          <Button type="button" variant="outline" disabled={working !== null} onClick={() => { setRenewing((open) => !open); setNotice(null) }} aria-expanded={renewing}><RefreshCw aria-hidden="true" />Renovar copia</Button>
          <Button type="button" variant="outline" disabled={working !== null} onClick={() => setConfirmRemove(true)}><Trash2 aria-hidden="true" />Quitar copia de este dispositivo</Button>
        </div>
        {renewing && <form onSubmit={(event) => void renew(event)} className="rounded-xl border border-border bg-surface/50 p-4 space-y-3">
          <p className="text-sm">Descarga los datos actuales y los guarda con el mismo PIN o frase. Si no lo recuerdas, quita la copia y guárdala de nuevo.</p>
          <div className="space-y-2 max-w-sm"><label htmlFor={`${ids}-renovar`} className="text-sm font-medium">PIN o frase de esta copia</label><Input id={`${ids}-renovar`} type="password" autoComplete="current-password" maxLength={128} value={renewSecret} onChange={(event) => setRenewSecret(event.target.value)} disabled={working !== null} required /></div>
          <Button type="submit" variant="secondary" disabled={working !== null || !renewSecret}>{working === "renew" ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <RefreshCw aria-hidden="true" />}{working === "renew" ? "Renovando…" : "Descargar datos actuales"}</Button>
        </form>}
      </div>}

      <div aria-live="polite" className="mt-4">
        {notice && <p role={notice.type === "error" ? "alert" : "status"} className={notice.type === "error" ? "text-sm text-destructive" : "text-sm border-l-4 border-l-[var(--status-read)] pl-3"}>{notice.text}</p>}
      </div>

      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>¿Quitar la copia de lectura?</AlertDialogTitle><AlertDialogDescription>Se borran la copia y su clave de este dispositivo. Tu biblioteca en BibLib no cambia y puedes volver a guardar la copia con conexión.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Cancelar</AlertDialogCancel><AlertDialogAction onClick={() => void remove()}>Sí, quitar copia</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
