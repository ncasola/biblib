"use client"

import { Header } from "@/components/header"
import { Button } from "@/components/ui/button"
import { useState, useEffect } from "react"
import type { Book, LibraryData } from "@/lib/types"
import { getStoredLibraryData, loadLibraryData, saveLibraryData } from "@/lib/storage"
import { useParams, useRouter } from "next/navigation"
import Image from "next/image"
import { ArrowLeft, Edit2, Trash2 } from "lucide-react"
import { BookStatusForm } from "@/components/book-status-form"

export default function BookDetailsPage() {
  const params = useParams()
  const router = useRouter()
  const bookId = params.id as string

  const [data, setData] = useState<LibraryData | null>(null)
  const [book, setBook] = useState<Book | null>(null)
  const [loading, setLoading] = useState(true)
  const [isEditing, setIsEditing] = useState(false)

  useEffect(() => {
    const initData = async () => {
      const stored = getStoredLibraryData()
      const libraryData = stored || (await loadLibraryData())
      setData(libraryData)

      const foundBook = libraryData.books.find((b) => b.id === bookId)
      setBook(foundBook || null)
      setLoading(false)
    }

    initData()
  }, [bookId])

  const handleStatusChange = (newStatus: Book["status"]) => {
    if (!book || !data) return

    const updatedBook = { ...book, status: newStatus }
    const updatedData = {
      ...data,
      books: data.books.map((b) => (b.id === book.id ? updatedBook : b)),
    }

    setBook(updatedBook)
    setData(updatedData)
    saveLibraryData(updatedData)
    setIsEditing(false)
  }

  const handleDeleteBook = () => {
    if (!book || !data) return

    if (window.confirm(`Delete "${book.title}"?`)) {
      const updatedData = {
        ...data,
        books: data.books.filter((b) => b.id !== book.id),
      }
      saveLibraryData(updatedData)
      router.push("/books")
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <div className="flex items-center justify-center h-96">
          <p className="text-foreground-light">Loading...</p>
        </div>
      </div>
    )
  }

  if (!book) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <main className="max-w-4xl mx-auto px-4 py-12">
          <p className="text-foreground-light">Book not found</p>
          <Button
            onClick={() => router.push("/books")}
            className="mt-4 bg-primary text-primary-foreground px-6 py-3 rounded-xl font-semibold hover:scale-105 transition-all shadow-lg shadow-primary/30"
          >
            Back to Books
          </Button>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main className="max-w-4xl mx-auto px-4 py-12">
        <Button
          variant="ghost"
          onClick={() => router.push("/books")}
          className="mb-6 bg-transparent border-2 border-border text-foreground px-6 py-3 rounded-xl font-semibold hover:bg-muted transition-all"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Books
        </Button>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {/* Book Cover */}
          <div className="relative w-full max-w-sm aspect-[2/3]">
            <Image
              src={book.cover.large || "/default-book-cover.webp"}
              alt={book.title}
              fill
              sizes="(max-width: 768px) 60vw, 320px"
              className="object-cover rounded-2xl border-4 border-border shadow-2xl"
              onError={(e) => {
                e.currentTarget.src = "/default-book-cover.webp"
              }}
              priority
            />
          </div>

          {/* Book Details */}
          <div className="md:col-span-2 space-y-6">
            <div>
              <h1 className="text-4xl font-bold heading-vintage mb-2">{book.title}</h1>
              {book.subtitle && <p className="text-lg text-muted-foreground mb-4">{book.subtitle}</p>}
            </div>

            <div className="rounded-2xl border border-border bg-card backdrop-blur-md p-6 shadow-xl space-y-4">
              <div>
                <p className="text-sm font-semibold text-vintage-red uppercase tracking-wide mb-1">Authors</p>
                <p className="text-foreground font-medium">
                  {book.authors && book.authors.length > 0 ? book.authors.map((a) => a.name).join(", ") : "Unknown"}
                </p>
              </div>

              {book.publishers && book.publishers.length > 0 && (
                <div>
                  <p className="text-sm font-semibold text-vintage-olive uppercase tracking-wide mb-1">Publisher</p>
                  <p className="text-foreground font-medium">{book.publishers.map((p) => p.name).join(", ")}</p>
                </div>
              )}

              {book.publish_date && (
                <div>
                  <p className="text-sm font-semibold text-vintage-purple uppercase tracking-wide mb-1">Published</p>
                  <p className="text-foreground font-medium">{book.publish_date}</p>
                </div>
              )}

              {book.number_of_pages > 0 && (
                <div>
                  <p className="text-sm font-semibold text-vintage-brown uppercase tracking-wide mb-1">Pages</p>
                  <p className="text-foreground font-medium">{book.number_of_pages}</p>
                </div>
              )}

              {book.isbn && (
                <div>
                  <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-1">ISBN</p>
                  <p className="text-foreground font-mono text-sm">{book.isbn}</p>
                </div>
              )}
            </div>

            {/* Status Section */}
            <div className="rounded-2xl border border-border bg-card backdrop-blur-md p-6 shadow-xl space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-2">Reading Status</p>
                  <p className="text-lg font-semibold text-primary">
                    {book.status === "read"
                      ? "Read"
                      : book.status === "reading"
                        ? "Currently Reading"
                        : book.status === "to-read"
                          ? "Want to Read"
                          : "Unread"}
                  </p>
                </div>

                <Button variant="outline" onClick={() => setIsEditing(!isEditing)} className="border-border">
                  <Edit2 className="w-4 h-4 mr-2" />
                  Change
                </Button>
              </div>

              {isEditing && <BookStatusForm currentStatus={book.status} onStatusChange={handleStatusChange} />}
            </div>

            {/* Shelf Info */}
            <div className="rounded-2xl border border-border bg-card backdrop-blur-md p-6 shadow-xl">
              <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-1">Shelf</p>
              <p className="text-foreground font-medium">{book.shelf_name}</p>
            </div>

            {/* Actions */}
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1 border-destructive text-destructive hover:bg-destructive/10 bg-transparent px-6 py-3 rounded-xl font-semibold"
                onClick={handleDeleteBook}
              >
                <Trash2 className="w-4 h-4 mr-2" />
                Delete Book
              </Button>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
