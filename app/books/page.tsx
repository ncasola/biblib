"use client"

import { Header } from "@/components/header"
import { BooksTable } from "@/components/books-table"
import { useState, useEffect } from "react"
import type { LibraryData } from "@/lib/types"
import { getStoredLibraryData, loadLibraryData } from "@/lib/storage"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Plus } from "lucide-react"

export default function BooksPage() {
  const [data, setData] = useState<LibraryData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const initData = async () => {
      const stored = getStoredLibraryData()
      if (stored) {
        setData(stored)
      } else {
        const loaded = await loadLibraryData()
        setData(loaded)
      }
      setLoading(false)
    }

    initData()
  }, [])

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

      <main className="max-w-7xl mx-auto px-4 py-8 md:py-12">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-8 md:mb-12">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold heading-vintage mb-2">Your Books</h1>
            <p className="text-muted-foreground text-base md:text-lg">Manage and explore your book collection</p>
          </div>

          <div className="flex flex-col sm:flex-row gap-2 sm:gap-3">
            <Link href="/books/add" className="w-full sm:w-auto">
              <Button className="w-full bg-primary text-primary-foreground px-6 py-3 rounded-xl font-semibold hover:scale-105 transition-all shadow-lg shadow-primary/30 flex items-center justify-center gap-2">
                <Plus className="w-5 h-5" />
                Add Book
              </Button>
            </Link>
            <Link href="/shelves/3d" className="w-full sm:w-auto">
              <Button className="w-full bg-secondary text-secondary-foreground px-6 py-3 rounded-xl font-semibold hover:scale-105 transition-all shadow-lg shadow-secondary/30">
                View 3D Shelf
              </Button>
            </Link>
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-card backdrop-blur-md p-4 md:p-8 shadow-xl">
          <BooksTable books={data.books} shelves={data.shelves} />
        </div>
      </main>
    </div>
  )
}
