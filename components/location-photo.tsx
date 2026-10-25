"use client"

import { useEffect, useId, useRef, useState } from "react"
import { ImagePlus, Loader2, Trash2, Upload, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { removeLocationPhotoAction, uploadLocationPhotoAction } from "@/app/actions/locations"
import { unwrapAction } from "@/lib/action-result"
import { DomainError } from "@/lib/domain-errors"
import { locationPhotoUrl, type LocationView } from "@/lib/locations"

const ACCEPT = ["image/jpeg", "image/png", "image/webp"]
const MAX_BYTES = 5 * 1024 * 1024

interface LocationPhotoProps {
  location: LocationView
  onChange(location: LocationView): void
}

/**
 * Foto general del mueble o de referencia (U-PRO-03). Opcional: ningún libro la necesita. Se elige, se ve una vista
 * previa local y solo entonces se sube; el servidor la reencodifica sin EXIF ni GPS. Si la subida falla, la foto anterior
 * se conserva. Se lee por la ruta autenticada del propio origen, nunca por una URL pública.
 */
export function LocationPhoto({ location, onChange }: LocationPhotoProps) {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")
  const current = locationPhotoUrl(location)

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])

  const reset = () => {
    setFile(null)
    setPreview(null)
    if (input.current) input.current.value = ""
  }

  const choose = (chosen: File | undefined) => {
    setMessage(""); setError("")
    if (!chosen) { reset(); return }
    if (!ACCEPT.includes(chosen.type)) { reset(); setError("Solo se admiten imágenes JPEG, PNG o WebP."); return }
    if (chosen.size > MAX_BYTES) { reset(); setError("La imagen supera el tamaño máximo de 5 MiB."); return }
    setFile(chosen)
    setPreview(URL.createObjectURL(chosen))
  }

  const upload = async () => {
    if (!file || busy) return
    setBusy("upload"); setMessage(""); setError("")
    try {
      const form = new FormData()
      form.set("locationId", location.id)
      form.set("expectedVersion", location.version)
      form.set("mime", file.type)
      form.set("bytes", String(file.size))
      form.set("file", file)
      onChange(unwrapAction(await uploadLocationPhotoAction(form)))
      reset()
      setMessage(current ? "Foto sustituida." : "Foto guardada.")
    } catch (caught) {
      setError(`${caught instanceof DomainError ? caught.message : "No se pudo guardar la foto."}${current ? " La foto anterior se conserva." : ""}`)
    } finally { setBusy(null) }
  }

  const remove = async () => {
    if (busy) return
    setBusy("remove"); setMessage(""); setError("")
    try {
      onChange(unwrapAction(await removeLocationPhotoAction({ locationId: location.id, expectedVersion: location.version })))
      setMessage("Foto quitada.")
    } catch (caught) { setError(caught instanceof DomainError ? caught.message : "No se pudo quitar la foto.") }
    finally { setBusy(null) }
  }

  return <section aria-labelledby={`${id}-title`} className="space-y-3">
    <h3 id={`${id}-title`} className="text-base font-semibold">Foto de referencia</h3>
    <p className="text-xs text-muted-foreground">Opcional: una imagen general del mueble ayuda a encontrarlo. Es privada, se guarda sin datos de ubicación GPS ni EXIF y no se comparte con ningún catálogo.</p>
    <div className="flex flex-wrap items-start gap-4">
      {preview ? (
        <figure className="space-y-1">
          {/* eslint-disable-next-line @next/next/no-img-element -- vista previa local (blob:) antes de subir */}
          <img src={preview} alt={`Vista previa de la nueva foto de ${location.name}`} className="h-40 w-auto max-w-full rounded-xl border border-border object-contain" />
          <figcaption className="text-xs text-muted-foreground">Vista previa: aún no se ha guardado.</figcaption>
        </figure>
      ) : current ? (
        // eslint-disable-next-line @next/next/no-img-element -- ruta autenticada del propio origen, sin optimizador
        <img src={current} alt={`Foto de ${location.name}`} className="h-40 w-auto max-w-full rounded-xl border border-border object-contain" />
      ) : <p className="text-sm text-muted-foreground">Sin foto.</p>}
    </div>
    <div className="flex flex-wrap gap-2">
      <input ref={input} id={`${id}-file`} aria-label={`Archivo de imagen para ${location.name}`} tabIndex={-1} type="file" accept={ACCEPT.join(",")} className="sr-only" disabled={busy !== null} onChange={(event) => choose(event.target.files?.[0])} />
      <Button type="button" variant="outline" disabled={busy !== null} onClick={() => input.current?.click()}><ImagePlus aria-hidden="true" className="mr-2 h-4 w-4" />{current ? "Elegir otra foto" : "Elegir foto"}</Button>
      {file && <Button type="button" disabled={busy !== null} onClick={() => void upload()}>{busy === "upload" ? <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" /> : <Upload aria-hidden="true" className="mr-2 h-4 w-4" />}{busy === "upload" ? "Guardando foto…" : current ? "Sustituir foto" : "Guardar foto"}</Button>}
      {file && <Button type="button" variant="ghost" disabled={busy !== null} onClick={reset}><X aria-hidden="true" className="mr-2 h-4 w-4" />Descartar vista previa</Button>}
      {current && !file && <Button type="button" variant="outline" className="text-destructive border-destructive/40" disabled={busy !== null} onClick={() => void remove()}><Trash2 aria-hidden="true" className="mr-2 h-4 w-4" />{busy === "remove" ? "Quitando…" : "Quitar foto"}</Button>}
    </div>
    {message && <p role="status" className="text-sm">{message}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>
}
