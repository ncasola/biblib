"use client"

import { useEffect, useId, useRef, useState } from "react"
import { Loader2, ShieldCheck, Undo2, Upload, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { getBookDetailAction } from "@/app/actions/books"
import { attachCoverAssetAction, beginOwnCoverUploadAction, cancelCoverAssetJobAction, detachCoverAssetAction, getBookCoverAssetsAction, getCoverAssetJobAction, requestProviderCoverAssetAction } from "@/app/actions/book-cover-assets"
import { unwrapAction } from "@/lib/action-result"
import { DomainError } from "@/lib/domain-errors"
import type { BookCoverAssetState, CoverAssetJobView } from "@/lib/assets/contracts"
import type { Book } from "@/lib/types"

const ACCEPT = "image/jpeg,image/png,image/webp"
const MAX_BYTES = 5 * 1024 * 1024
const TERMINAL = ["succeeded", "partially_succeeded", "failed", "cancelled", "expired"]

interface BookCoverAssetsProps {
  book: Book
  disabled: boolean
  onBookChange(book: Book): void
}

const messageOf = (caught: unknown, fallback: string) => caught instanceof DomainError ? caught.message : fallback
const newKey = () => crypto.randomUUID().replaceAll("-", "")

/**
 * Portada privada de la ficha (U-DAT-10): subir una imagen propia o, si la política del proveedor lo
 * permite, guardar una copia privada de su portada. La portada visible solo cambia al adjuntar.
 */
export function BookCoverAssets({ book, disabled, onBookChange }: BookCoverAssetsProps) {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<BookCoverAssetState | null>(null)
  const [busy, setBusy] = useState<"upload" | "copy" | "detach" | null>(null)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")
  const [pendingJob, setPendingJob] = useState<CoverAssetJobView | null>(null)
  const cancelled = useRef(false)

  useEffect(() => {
    let active = true
    getBookCoverAssetsAction(book.id).then((result) => { if (active && result.ok) setState(result.value) }, () => undefined)
    return () => { active = false }
  }, [book.id, book.version])

  if (!state || state.mode === "off") return null
  const locked = disabled || busy !== null

  const upload = async (file: File | undefined) => {
    if (!file || locked) return
    setMessage(""); setError("")
    if (!ACCEPT.split(",").includes(file.type)) { setError("Solo se admiten imágenes JPEG, PNG o WebP."); return }
    if (file.size > MAX_BYTES) { setError("La imagen supera el tamaño máximo de 5 MiB."); return }
    setBusy("upload")
    try {
      const form = new FormData()
      form.set("entityId", book.id)
      form.set("mime", file.type)
      form.set("bytes", String(file.size))
      form.set("file", file)
      const { asset } = unwrapAction(await beginOwnCoverUploadAction(form))
      onBookChange(unwrapAction(await attachCoverAssetAction({ assetId: asset.id, entityId: book.id, expectedVersion: book.version ?? "" })))
      setMessage("Portada propia guardada como copia privada.")
    } catch (caught) { setError(messageOf(caught, "No se pudo guardar la imagen. Comprueba la conexión e inténtalo de nuevo.")) }
    finally { setBusy(null); if (input.current) input.current.value = "" }
  }

  const copy = async () => {
    if (!state.providerCoverKey || locked) return
    setBusy("copy"); setMessage(""); setError(""); cancelled.current = false
    try {
      let job: CoverAssetJobView = unwrapAction(await requestProviderCoverAssetAction({ entityId: book.id, expectedVersion: book.version ?? "", providerCoverKey: state.providerCoverKey, idempotencyKey: newKey() }))
      for (let attempt = 0; attempt < 10 && !TERMINAL.includes(job.state) && !cancelled.current; attempt++) {
        setPendingJob(job)
        await new Promise((resolve) => setTimeout(resolve, 2_000))
        if (cancelled.current) break
        job = unwrapAction(await getCoverAssetJobAction({ jobId: job.jobId }))
      }
      if (cancelled.current) return
      if (job.attached) {
        const latest = await getBookDetailAction(book.id)
        if (latest) onBookChange(latest)
        setMessage("Copia privada guardada. La portada se sirve ahora desde tu biblioteca.")
      } else if (job.state === "succeeded") setError("La copia se guardó, pero la ficha cambió mientras tanto y no se ha sustituido la portada.")
      else if (TERMINAL.includes(job.state)) setError("No se pudo guardar la copia privada. La portada actual no ha cambiado.")
      else setMessage("La copia sigue pendiente. Vuelve a abrir la ficha más tarde para continuarla.")
    } catch (caught) { setError(messageOf(caught, "No se pudo guardar la copia privada. La portada actual no ha cambiado.")) }
    finally { setBusy(null); setPendingJob(null) }
  }

  /** Cancelar impide registrar o adjuntar un resultado tardío; la portada actual no cambia. */
  const cancel = async () => {
    if (!pendingJob) return
    cancelled.current = true
    try {
      unwrapAction(await cancelCoverAssetJobAction({ jobId: pendingJob.jobId, expectedVersion: pendingJob.version }))
      setMessage("Copia cancelada. La portada actual no ha cambiado.")
    } catch (caught) { setError(messageOf(caught, "No se pudo cancelar la copia. Vuelve a abrir la ficha para ver su estado.")) }
  }

  const detach = async () => {
    if (locked) return
    setBusy("detach"); setMessage(""); setError("")
    try {
      onBookChange(unwrapAction(await detachCoverAssetAction({ entityId: book.id, expectedVersion: book.version ?? "" })))
      setMessage("Se muestra de nuevo la portada original.")
    } catch (caught) { setError(messageOf(caught, "No se pudo cambiar la portada. Inténtalo de nuevo.")) }
    finally { setBusy(null) }
  }

  const current = book.coverAssetId ? state.current : null
  return (
    <section aria-labelledby={`${id}-title`} className="space-y-3 rounded-2xl border border-border bg-card/80 p-4 text-sm shadow-lg">
      <h2 id={`${id}-title`} className="font-semibold">Portada privada</h2>
      <p className="text-xs text-muted-foreground">
        {current
          ? `Se muestra tu copia privada${current.width && current.height ? ` (${current.width} × ${current.height} px)` : ""}. Solo tú puedes verla; la copia JSON conserva la URL original, no la imagen.`
          : "Guarda una imagen solo para tu biblioteca. Se comprueba, se convierte a WebP sin metadatos y no se comparte con nadie."}
      </p>
      {state.canUpload && <>
        <input ref={input} id={`${id}-file`} type="file" accept={ACCEPT} className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(event) => void upload(event.target.files?.[0])} />
        <Button type="button" variant="outline" className="w-full" disabled={locked} onClick={() => input.current?.click()}>
          {busy === "upload" ? <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" /> : <Upload aria-hidden="true" className="mr-2 h-4 w-4" />}
          {busy === "upload" ? "Validando imagen..." : "Subir portada propia"}
        </Button>
        <p className="text-xs text-muted-foreground">JPEG, PNG o WebP de hasta 5 MiB y 10 megapíxeles.</p>
      </>}
      {state.providerCoverKey && (
        <Button type="button" variant="outline" className="w-full" disabled={locked} onClick={() => void copy()}>
          {busy === "copy" ? <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck aria-hidden="true" className="mr-2 h-4 w-4" />}
          {busy === "copy" ? "Guardando copia..." : "Guardar copia privada"}
        </Button>
      )}
      {busy === "copy" && pendingJob && (
        <Button type="button" variant="ghost" className="w-full" onClick={() => void cancel()}>
          <X aria-hidden="true" className="mr-2 h-4 w-4" />Cancelar copia
        </Button>
      )}
      {current && (
        <Button type="button" variant="ghost" className="w-full" disabled={locked} onClick={() => void detach()}>
          <Undo2 aria-hidden="true" className="mr-2 h-4 w-4" />{busy === "detach" ? "Cambiando..." : "Usar la portada original"}
        </Button>
      )}
      {message && <p role="status" className="rounded-xl border border-border bg-muted/40 p-2 text-xs">{message}</p>}
      {error && <p role="alert" className="rounded-xl border border-destructive/30 p-2 text-xs text-destructive">{error}</p>}
    </section>
  )
}
