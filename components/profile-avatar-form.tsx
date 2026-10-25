"use client"

import { useEffect, useRef, useState } from "react"
import { useAuth } from "@/lib/auth-context"
import { uploadProfileAvatarAction, removeProfileAvatarAction } from "@/app/actions/profile"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export function ProfileAvatarForm() {
  const { user, avatarVersion, avatarEditorEnabled, refreshAvatar } = useAuth()
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState("")
  const [position, setPosition] = useState(50)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [unavailable, setUnavailable] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])
  if (unavailable) return <p role="alert" className="mt-4 text-sm text-destructive">{error || "La edición de la foto no está disponible. La foto anterior se conserva."}</p>
  if (!avatarEditorEnabled) return null

  const choose = (selected: File | undefined) => {
    setError(""); setMessage(""); setFile(null); setPreview(""); setPosition(50)
    if (!selected) return
    if (!["image/jpeg", "image/png", "image/webp"].includes(selected.type) || selected.size > 1_048_576 || !selected.size) {
      setError("Elige una imagen JPEG, PNG o WebP de hasta 1 MiB.")
      if (input.current) input.current.value = ""
      return
    }
    setFile(selected)
    setPreview(URL.createObjectURL(selected))
  }
  const save = async () => {
    if (!file || busy) return
    setBusy(true); setError(""); setMessage("")
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" })
      let blob: Blob | null
      try {
        if (bitmap.width > 1024 || bitmap.height > 1024) throw new Error("La imagen debe tener como máximo 1024 × 1024 píxeles.")
        const side = Math.min(bitmap.width, bitmap.height)
        const canvas = document.createElement("canvas")
        canvas.width = side; canvas.height = side
        const context = canvas.getContext("2d")
        if (!context) throw new Error("No se pudo preparar el recorte.")
        context.drawImage(bitmap, (bitmap.width - side) * position / 100, (bitmap.height - side) * position / 100, side, side, 0, 0, side, side)
        blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.85))
      } finally { bitmap.close() }
      if (!blob) throw new Error("No se pudo preparar la imagen.")
      const form = new FormData()
      form.set("image", blob, "avatar.webp"); form.set("version", avatarVersion ?? "")
      const result = await uploadProfileAvatarAction(form)
      if (!result.ok) {
        if (result.error.code === "PROVIDER_UNAVAILABLE") setUnavailable(true)
        throw new Error(result.error.message)
      }
      await refreshAvatar(result.value)
      setFile(null); setPreview(""); if (input.current) input.current.value = ""
      setMessage("Foto de perfil guardada.")
    } catch (caught) {
      const networkError = caught instanceof TypeError
      if (networkError) setUnavailable(true)
      setError(networkError || caught instanceof DOMException ? "No se pudo guardar la foto. Comprueba la imagen y la conexión; la foto anterior se conserva." : caught instanceof Error ? caught.message : "No se pudo guardar la foto. La anterior se conserva.")
    }
    finally { setBusy(false) }
  }
  const remove = async () => {
    if (busy) return
    setBusy(true); setError(""); setMessage("")
    try {
      const result = await removeProfileAvatarAction(avatarVersion)
      if (!result.ok) throw new Error(result.error.message)
      await refreshAvatar(result.value); setMessage("Foto propia retirada. Se muestra la foto de Google o tus iniciales.")
    } catch (caught) { setError(caught instanceof TypeError ? "No se pudo quitar la foto. Comprueba la conexión y vuelve a intentarlo." : caught instanceof Error ? caught.message : "No se pudo quitar la foto.") }
    finally { setBusy(false) }
  }
  return <section aria-label="Foto de perfil" aria-busy={busy} className="mt-6 w-full space-y-3">
    <Label htmlFor="avatar-image">Cambiar foto de perfil</Label>
    <p id="avatar-limits" className="text-sm text-muted-foreground">JPEG, PNG o WebP. Hasta 1 MiB y 1024 × 1024 píxeles. Se guarda como WebP privado sin metadatos.</p>
    <Input ref={input} id="avatar-image" type="file" accept="image/jpeg,image/png,image/webp" aria-describedby="avatar-limits" disabled={busy} onChange={(event) => choose(event.target.files?.[0])} />
    {preview && <>
      {/* Archivo local temporal: nunca se envía la previsualización a un servicio externo. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={preview} alt="Previsualización del recorte cuadrado del avatar" className="mx-auto size-36 rounded-full object-cover" style={{ objectPosition: `${position}% ${position}%` }} />
      <Label htmlFor="avatar-crop">Posición del recorte</Label>
      <input id="avatar-crop" className="w-full accent-red-600" type="range" min="0" max="100" value={position} disabled={busy} onChange={(event) => setPosition(Number(event.target.value))} />
      <p className="text-sm text-muted-foreground">{file?.type} · {Math.ceil((file?.size ?? 0) / 1024)} KiB</p>
      <Button disabled={busy} onClick={() => void save()} className="w-full">{busy ? "Guardando foto…" : "Guardar foto"}</Button>
    </>}
    {user?.ownAvatar && <Button variant="outline" className="w-full" disabled={busy} onClick={() => void remove()}>Quitar foto propia</Button>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {message && <p role="status" className="text-sm">{message}</p>}
  </section>
}
