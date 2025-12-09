"use client"

import { Header } from "@/components/header"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useState, useEffect, useMemo } from "react"
import type { LibraryData } from "@/lib/types"
import { getStoredLibraryData, loadLibraryData } from "@/lib/storage"
import Link from "next/link"
import Image from "next/image"
import { Search } from "lucide-react"

export default function SearchPage() {
  const [data, setData] = useState<LibraryData | null>(null)
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedStatus, setSelectedStatus] = useState<string>("all")
  const [selectedShelf, setSelectedShelf] = useState<string>("all")
  const [sortBy, setSortBy] = useState<string>("title")

  useEffect(() => {
    const initData = async () => {
      const stored = getStoredLibraryData()
      const libraryData = stored || (await loadLibraryData())
      setData(libraryData)
      setLoading(false)
    }

    initData()
  }, [])

  const filteredAndSortedBooks = useMemo(() => {
    if (!data) return []

    let results = [...data.books]

    // Apply search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      results = results.filter(
        (book) =>
          book.title.toLowerCase().includes(query) ||
          book.authors.some((a) => a.name.toLowerCase().includes(query)) ||
          book.isbn.toLowerCase().includes(query),
      )
    }

    // Apply status filter
    if (selectedStatus !== "all") {
      results = results.filter((book) => book.status === selectedStatus)
    }

    // Apply shelf filter
    if (selectedShelf !== "all") {
      results = results.filter((book) => book.shelf_id === selectedShelf)
    }

    // Apply sorting
    results.sort((a, b) => {
      switch (sortBy) {
        case "title":
          return a.title.localeCompare(b.title)
        case "author":
          return (a.authors[0]?.name || "").localeCompare(b.authors[0]?.name || "")
        case "date":
          return new Date(b.publish_date || 0).getTime() - new Date(a.publish_date || 0).getTime()
        case "pages":
          return b.number_of_pages - a.number_of_pages
        default:
          return 0
      }
    })

    return results
  }, [data, searchQuery, selectedStatus, selectedShelf, sortBy])

  if (loading || !data) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <div className="flex items-center justify-center h-96">
          <p className="text-foreground-light">Loading...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main className="max-w-7xl mx-auto px-4 py-12">
        <div className="mb-12">
          <h1 className="text-4xl font-bold heading-vintage mb-2">Advanced Search</h1>
          <p className="text-muted-foreground text-lg">Find books by title, author, status, or shelf</p>
        </div>

        <div className="rounded-2xl border border-border bg-card backdrop-blur-md p-6 shadow-xl mb-8 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Search Input */}
            <div className="lg:col-span-2">
              <label className="text-sm font-medium text-foreground mb-2 block">Search</label>
              <div className="flex gap-2">
                <Input
                  placeholder="Title, author, ISBN..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="bg-surface border-border"
                />
                <Button variant="outline" size="icon" className="border-border bg-transparent">
                  <Search className="w-4 h-4" />
                </Button>
              </div>
            </div>

            {/* Status Filter */}
            <div>
              <label className="text-sm font-medium text-foreground mb-2 block">Status</label>
              <Select value={selectedStatus} onValueChange={setSelectedStatus}>
                <SelectTrigger className="bg-surface border-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="to-read">Want to Read</SelectItem>
                  <SelectItem value="reading">Reading</SelectItem>
                  <SelectItem value="read">Read</SelectItem>
                  <SelectItem value="unread">Unread</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Shelf Filter */}
            <div>
              <label className="text-sm font-medium text-foreground mb-2 block">Shelf</label>
              <Select value={selectedShelf} onValueChange={setSelectedShelf}>
                <SelectTrigger className="bg-surface border-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Shelves</SelectItem>
                  {data.shelves.map((shelf) => (
                    <SelectItem key={shelf.id} value={shelf.id}>
                      {shelf.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Sort By */}
            <div>
              <label className="text-sm font-medium text-foreground mb-2 block">Sort By</label>
              <Select value={sortBy} onValueChange={setSortBy}>
                <SelectTrigger className="bg-surface border-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="title">Title (A-Z)</SelectItem>
                  <SelectItem value="author">Author (A-Z)</SelectItem>
                  <SelectItem value="date">Newest First</SelectItem>
                  <SelectItem value="pages">Most Pages</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {/* Results */}
        <div>
          <p className="text-sm text-muted-foreground mb-4">
            Found {filteredAndSortedBooks.length} book{filteredAndSortedBooks.length !== 1 ? "s" : ""}
          </p>

          {filteredAndSortedBooks.length === 0 ? (
            <div className="rounded-2xl border border-border bg-card backdrop-blur-md p-12 shadow-xl text-center">
              <p className="text-muted-foreground">No books found matching your criteria</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {filteredAndSortedBooks.map((book) => (
                <Link key={book.id} href={`/book/${book.id}`}>
                  <div className="rounded-2xl border border-border bg-card backdrop-blur-md p-6 shadow-xl hover:shadow-2xl transition-shadow cursor-pointer h-full flex flex-col gap-4">
                    <div className="relative w-full h-48">
                      <Image
                        src={book.cover.medium || "/default-book-cover.webp"}
                        alt={book.title}
                        fill
                        sizes="(max-width: 768px) 100vw, (max-width: 1024px) 50vw, 33vw"
                        className="object-cover rounded-xl border-2 border-border"
                        onError={(e) => {
                          e.currentTarget.src = "/default-book-cover.webp"
                        }}
                      />
                    </div>
                    <div className="flex-1 flex flex-col gap-2">
                      <h3 className="font-bold text-foreground line-clamp-2">{book.title}</h3>
                      <p className="text-sm text-muted-foreground">{book.authors.map((a) => a.name).join(", ")}</p>
                      <p className="text-xs text-muted-foreground mt-auto">{book.shelf_name}</p>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
