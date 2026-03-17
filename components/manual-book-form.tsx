"use client"

import type React from "react"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useRouter } from "next/navigation"
import { addBookAction } from "@/app/actions/books"
import type { Book } from "@/lib/types"

export function ManualBookForm() {
  const router = useRouter()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [formData, setFormData] = useState({
    title: "",
    subtitle: "",
    authors: "",
    publisher: "",
    publish_date: "",
    number_of_pages: "",
    isbn: "",
    coverUrl: "",
    status: "unread" as Book["status"],
  })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)

    try {
      const newBook: Book = {
        id: crypto.randomUUID(),
        isbn: formData.isbn.trim() || `manual-${crypto.randomUUID()}`,
        title: formData.title,
        subtitle: formData.subtitle || undefined,
        authors: formData.authors ? formData.authors.split(",").map((name) => ({ name: name.trim() })) : [],
        publishers: formData.publisher ? [{ name: formData.publisher }] : [],
        publish_date: formData.publish_date || "",
        number_of_pages: formData.number_of_pages ? Number.parseInt(formData.number_of_pages, 10) : 0,
        cover: {
          small: formData.coverUrl || "/default-book-cover.webp",
          medium: formData.coverUrl || "/default-book-cover.webp",
          large: formData.coverUrl || "/default-book-cover.webp",
        },
        status: formData.status,
        shelf_id: "",
        shelf_name: "",
      }

      await addBookAction(newBook)

      router.push("/books")
    } catch (error) {
      console.error("Error adding book:", error)
      alert("No se pudo agregar el libro. Inténtalo de nuevo.")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <Label htmlFor="title" className="text-foreground font-semibold">
          Título *
        </Label>
        <Input
          id="title"
          required
          value={formData.title}
          onChange={(e) => setFormData({ ...formData, title: e.target.value })}
          className="mt-2 bg-surface border-border"
          placeholder="Introduce el título del libro"
        />
      </div>

      <div>
        <Label htmlFor="subtitle" className="text-foreground font-semibold">
          Subtítulo
        </Label>
        <Input
          id="subtitle"
          value={formData.subtitle}
          onChange={(e) => setFormData({ ...formData, subtitle: e.target.value })}
          className="mt-2 bg-surface border-border"
          placeholder="Introduce el subtítulo (opcional)"
        />
      </div>

      <div>
        <Label htmlFor="authors" className="text-foreground font-semibold">
          Autores *
        </Label>
        <Input
          id="authors"
          required
          value={formData.authors}
          onChange={(e) => setFormData({ ...formData, authors: e.target.value })}
          className="mt-2 bg-surface border-border"
          placeholder="Separados por coma (ej.: J.K. Rowling, George Orwell)"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="publisher" className="text-foreground font-semibold">
            Editorial
          </Label>
          <Input
            id="publisher"
            value={formData.publisher}
            onChange={(e) => setFormData({ ...formData, publisher: e.target.value })}
            className="mt-2 bg-surface border-border"
            placeholder="Nombre de la editorial"
          />
        </div>

        <div>
          <Label htmlFor="publish_date" className="text-foreground font-semibold">
            Fecha de publicación
          </Label>
          <Input
            id="publish_date"
            value={formData.publish_date}
            onChange={(e) => setFormData({ ...formData, publish_date: e.target.value })}
            className="mt-2 bg-surface border-border"
            placeholder="ej.: 1997"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="pages" className="text-foreground font-semibold">
            Número de páginas
          </Label>
          <Input
            id="pages"
            type="number"
            value={formData.number_of_pages}
            onChange={(e) => setFormData({ ...formData, number_of_pages: e.target.value })}
            className="mt-2 bg-surface border-border"
            placeholder="ej.: 320"
          />
        </div>

        <div>
          <Label htmlFor="isbn" className="text-foreground font-semibold">
            ISBN
          </Label>
          <Input
            id="isbn"
            value={formData.isbn}
            onChange={(e) => setFormData({ ...formData, isbn: e.target.value })}
            className="mt-2 bg-surface border-border"
            placeholder="ej.: 9780747532699"
          />
        </div>
      </div>

      <div>
        <Label htmlFor="coverUrl" className="text-foreground font-semibold">
          URL de la portada
        </Label>
        <Input
          id="coverUrl"
          type="url"
          value={formData.coverUrl}
          onChange={(e) => setFormData({ ...formData, coverUrl: e.target.value })}
          className="mt-2 bg-surface border-border"
          placeholder="https://example.com/portada.jpg (opcional)"
        />
        <p className="text-xs text-muted-foreground mt-1">Déjalo vacío para usar la portada vintage por defecto</p>
      </div>

      <div>
        <Label htmlFor="status" className="text-foreground font-semibold">
          Estado de lectura
        </Label>
        <Select
          value={formData.status}
          onValueChange={(value) => setFormData({ ...formData, status: value as Book["status"] })}
        >
          <SelectTrigger className="mt-2 bg-surface border-border">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="unread">Sin empezar</SelectItem>
            <SelectItem value="reading">Leyendo</SelectItem>
            <SelectItem value="read">Leído</SelectItem>
            <SelectItem value="to-read">Por leer</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Button
        type="submit"
        disabled={isSubmitting}
        className="w-full bg-primary text-primary-foreground px-6 py-3 rounded-xl font-semibold hover:scale-105 transition-all shadow-lg shadow-primary/30"
      >
        {isSubmitting ? "Agregando libro..." : "Agregar libro a la biblioteca"}
      </Button>
    </form>
  )
}
