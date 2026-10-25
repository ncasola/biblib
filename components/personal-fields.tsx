"use client"

import { useEffect, useId, useState } from "react"
import { getTagsAction } from "@/app/actions/tags"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { isValidTagName, normalizeTagName, type Tag, type CopyRating } from "@/lib/product/contracts"
import type { PersonalInput } from "@/lib/personal-validation"

export function PersonalFields({ value, onChange }: { value: PersonalInput; onChange: (value: PersonalInput) => void }) {
  const id = useId()
  const [tags, setTags] = useState<Tag[]>([])
  const [name, setName] = useState("")
  const [error, setError] = useState("")
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    getTagsAction().then((rows) => { if (active) { setTags(rows); setError("") } }).catch(() => { if (active) setError("No se pudieron cargar las etiquetas. Puedes reintentar sin perder el borrador.") })
    return () => { active = false }
  }, [attempt])
  const ids = value.tagIds ?? [], names = value.tagNames ?? []
  const count = ids.length + names.length
  const add = () => {
    const trimmed = name.trim().normalize("NFC")
    if (!isValidTagName(trimmed)) { setError("La etiqueta debe tener entre 1 y 40 caracteres, sin caracteres de control."); return }
    const existing = tags.find((tag) => tag.normalizedName === normalizeTagName(trimmed))
    if (existing ? ids.includes(existing.id) : names.some((entry) => normalizeTagName(entry) === normalizeTagName(trimmed))) { setName(""); return }
    if (count >= 20) { setError("El ejemplar admite hasta 20 etiquetas."); return }
    onChange(existing ? { ...value, tagIds: [...ids, existing.id] } : { ...value, tagNames: [...names, trimmed] })
    setName(""); setError("")
  }
  return <fieldset className="min-w-0 space-y-4 rounded-xl border border-border bg-muted/20 p-4">
    <legend className="px-2 font-semibold">Datos personales del ejemplar (opcionales)</legend>
    <div className="space-y-2"><Label htmlFor={`${id}-notes`}>Notas privadas</Label><textarea id={`${id}-notes`} rows={5} value={value.notes ?? ""} onChange={(event) => onChange({ ...value, notes: event.target.value })} aria-describedby={`${id}-notes-help`} className="w-full rounded-md border border-input bg-background p-3 text-foreground focus-visible:outline-2 focus-visible:outline-ring" /><p id={`${id}-notes-help`} className="text-xs text-muted-foreground">{[...(value.notes ?? "")].length} / 4000 caracteres. Solo tú puedes ver estas notas.</p></div>
    <fieldset className="min-w-0 space-y-2"><legend className="text-sm font-medium">Valoración personal</legend><div className="flex flex-wrap gap-2">{[0, 1, 2, 3, 4, 5].map((rating) => <label key={rating} className="flex min-h-11 cursor-pointer items-center gap-1 rounded-md border border-border px-2 has-checked:bg-primary/10 has-focus-visible:outline-2 has-focus-visible:outline-ring"><input type="radio" name={`${id}-rating`} value={rating} checked={(value.rating ?? 0) === rating} onChange={() => onChange({ ...value, rating: rating === 0 ? null : rating as CopyRating })} className="accent-primary" /><span aria-hidden="true">{rating ? "★".repeat(rating) : "Sin valorar"}</span><span className="sr-only">{rating ? `${rating} de 5 estrellas` : "Sin valoración"}</span></label>)}</div><p className="text-sm text-muted-foreground" aria-live="polite">{value.rating ? `Valoración: ${value.rating} de 5` : "Sin valoración"}</p></fieldset>
    <fieldset className="min-w-0 space-y-2"><legend className="text-sm font-medium">Etiquetas ({count} / 20)</legend><p className="text-xs text-muted-foreground">Describen temas o preferencias. La estantería se elige por separado.</p>
      <div className="flex max-h-48 flex-wrap gap-2 overflow-y-auto">{tags.map((tag) => <label key={tag.id} className="flex min-h-11 items-center gap-2 rounded-md border border-border px-2 text-sm"><input type="checkbox" checked={ids.includes(tag.id)} disabled={count >= 20 && !ids.includes(tag.id)} onChange={(event) => onChange({ ...value, tagIds: event.target.checked ? [...ids, tag.id] : ids.filter((entry) => entry !== tag.id) })} className="accent-primary" />{tag.name}</label>)}</div>
      {names.map((entry) => <Button key={entry} type="button" variant="outline" size="sm" onClick={() => onChange({ ...value, tagNames: names.filter((name) => name !== entry) })} aria-label={`Quitar etiqueta ${entry}`}>{entry} ×</Button>)}
      <div className="space-y-2"><Label htmlFor={`${id}-tag`}>Nueva etiqueta</Label><div className="flex flex-wrap gap-2"><Input id={`${id}-tag`} value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add() } }} className="min-w-0 flex-1" /><Button type="button" variant="outline" onClick={add}>Añadir etiqueta al ejemplar</Button></div></div>
    </fieldset>
    {error && <div className="space-y-2"><p role="alert" className="text-sm text-destructive">{error}</p><Button type="button" variant="outline" size="sm" onClick={() => setAttempt((current) => current + 1)}>Recargar etiquetas</Button></div>}
  </fieldset>
}
