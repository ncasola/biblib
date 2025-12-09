"use client"

import type React from "react"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useRouter } from "next/navigation"
import { getStoredLibraryData, saveLibraryData } from "@/lib/storage"
import type { Book, ReadingStatus } from "@/lib/types"

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
    status: "unread" as ReadingStatus,
  })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)

    try {
      // Get current library data
      const data = getStoredLibraryData()
      if (!data) {
        throw new Error("Library data not found")
      }

      // Create new book
      const newBook: Book = {
        id: `book-${Date.now()}`,
        title: formData.title,
        subtitle: formData.subtitle || undefined,
        authors: formData.authors ? formData.authors.split(",").map((name) => ({ name: name.trim() })) : [],
        publishers: formData.publisher ? [{ name: formData.publisher }] : [],
        publish_date: formData.publish_date || undefined,
        number_of_pages: formData.number_of_pages ? Number.parseInt(formData.number_of_pages) : undefined,
        isbn_13: formData.isbn || undefined,
        cover: {
          small: formData.coverUrl || "/default-book-cover.webp",
          medium: formData.coverUrl || "/default-book-cover.webp",
          large: formData.coverUrl || "/default-book-cover.webp",
        },
        status: formData.status,
        shelf_id: data.shelves[0]?.id || "default",
        added_date: new Date().toISOString(),
      }

      // Add book to library
      data.books.push(newBook)
      saveLibraryData(data)

      // Redirect to books page
      router.push("/books")
    } catch (error) {
      console.error("Error adding book:", error)
      alert("Failed to add book. Please try again.")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <Label htmlFor="title" className="text-foreground font-semibold">
          Title *
        </Label>
        <Input
          id="title"
          required
          value={formData.title}
          onChange={(e) => setFormData({ ...formData, title: e.target.value })}
          className="mt-2 bg-surface border-border"
          placeholder="Enter book title"
        />
      </div>

      <div>
        <Label htmlFor="subtitle" className="text-foreground font-semibold">
          Subtitle
        </Label>
        <Input
          id="subtitle"
          value={formData.subtitle}
          onChange={(e) => setFormData({ ...formData, subtitle: e.target.value })}
          className="mt-2 bg-surface border-border"
          placeholder="Enter book subtitle (optional)"
        />
      </div>

      <div>
        <Label htmlFor="authors" className="text-foreground font-semibold">
          Authors *
        </Label>
        <Input
          id="authors"
          required
          value={formData.authors}
          onChange={(e) => setFormData({ ...formData, authors: e.target.value })}
          className="mt-2 bg-surface border-border"
          placeholder="Comma-separated (e.g., J.K. Rowling, George Orwell)"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="publisher" className="text-foreground font-semibold">
            Publisher
          </Label>
          <Input
            id="publisher"
            value={formData.publisher}
            onChange={(e) => setFormData({ ...formData, publisher: e.target.value })}
            className="mt-2 bg-surface border-border"
            placeholder="Publisher name"
          />
        </div>

        <div>
          <Label htmlFor="publish_date" className="text-foreground font-semibold">
            Publication Date
          </Label>
          <Input
            id="publish_date"
            value={formData.publish_date}
            onChange={(e) => setFormData({ ...formData, publish_date: e.target.value })}
            className="mt-2 bg-surface border-border"
            placeholder="e.g., 1997"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="pages" className="text-foreground font-semibold">
            Number of Pages
          </Label>
          <Input
            id="pages"
            type="number"
            value={formData.number_of_pages}
            onChange={(e) => setFormData({ ...formData, number_of_pages: e.target.value })}
            className="mt-2 bg-surface border-border"
            placeholder="e.g., 320"
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
            placeholder="e.g., 9780747532699"
          />
        </div>
      </div>

      <div>
        <Label htmlFor="coverUrl" className="text-foreground font-semibold">
          Cover Image URL
        </Label>
        <Input
          id="coverUrl"
          type="url"
          value={formData.coverUrl}
          onChange={(e) => setFormData({ ...formData, coverUrl: e.target.value })}
          className="mt-2 bg-surface border-border"
          placeholder="https://example.com/cover.jpg (optional)"
        />
        <p className="text-xs text-muted-foreground mt-1">Leave empty to use default vintage cover</p>
      </div>

      <div>
        <Label htmlFor="status" className="text-foreground font-semibold">
          Reading Status
        </Label>
        <Select
          value={formData.status}
          onValueChange={(value) => setFormData({ ...formData, status: value as ReadingStatus })}
        >
          <SelectTrigger className="mt-2 bg-surface border-border">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="unread">Unread</SelectItem>
            <SelectItem value="reading">Reading</SelectItem>
            <SelectItem value="read">Read</SelectItem>
            <SelectItem value="to-read">To Read</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Button
        type="submit"
        disabled={isSubmitting}
        className="w-full bg-primary text-primary-foreground px-6 py-3 rounded-xl font-semibold hover:scale-105 transition-all shadow-lg shadow-primary/30"
      >
        {isSubmitting ? "Adding Book..." : "Add Book to Library"}
      </Button>
    </form>
  )
}
