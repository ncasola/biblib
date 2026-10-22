"use client"

import { useId, useState, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Search, Loader2 } from "lucide-react"
import { normalizeIsbn } from "@/lib/isbn"

interface SearchBookFormProps {
  onSearch: (isbn: string) => Promise<void>
  isLoading?: boolean
}

export function SearchBookForm({ onSearch, isLoading = false }: SearchBookFormProps) {
  const id = useId()
  const [isbn, setIsbn] = useState("")
  const [error, setError] = useState("")
  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (isLoading) return
    const normalized = normalizeIsbn(isbn)
    if (!normalized) { setError("El ISBN no es válido. Comprueba sus 10 o 13 dígitos."); return }
    setError("")
    await onSearch(normalized)
  }
  return (
    <form onSubmit={handleSubmit} aria-busy={isLoading} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label htmlFor={id} className="text-sm font-semibold">Número ISBN</label>
        <Input id={id} type="text" required autoComplete="off" maxLength={40} placeholder="Por ejemplo: 9780747532699" value={isbn} onChange={(event) => { setIsbn(event.target.value); setError("") }} disabled={isLoading} aria-invalid={Boolean(error)} aria-describedby={`${id}-help${error ? ` ${id}-error` : ""}`} />
        <p id={`${id}-help`} className="text-xs text-muted-foreground">ISBN de 10 o 13 dígitos. Puedes incluir guiones y espacios.</p>
        {error && <p id={`${id}-error`} role="alert" className="text-sm text-destructive">{error}</p>}
      </div>
      <Button type="submit" disabled={isLoading || !isbn.trim()} className="w-full bg-primary text-primary-foreground">
        {isLoading ? <Loader2 aria-hidden="true" className="w-4 h-4 mr-2 animate-spin" /> : <Search aria-hidden="true" className="w-4 h-4 mr-2" />}{isLoading ? "Buscando..." : "Buscar libro"}
      </Button>
    </form>
  )
}
