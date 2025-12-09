"use client"

import { Header } from "@/components/header"
import { SearchBookForm } from "@/components/search-book-form"
import { ManualBookForm } from "@/components/manual-book-form"
import { BookSearchResult } from "@/components/book-search-result"
import { useState } from "react"
import type { Book } from "@/lib/types"
import { ArrowLeft } from "lucide-react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

export default function AddBookPage() {
  const [searchResult, setSearchResult] = useState<Book | null>(null)
  const [isSearching, setIsSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSearch = async (isbn: string) => {
    setIsSearching(true)
    setError(null)
    setSearchResult(null)

    try {
      const response = await fetch(`/api/books/search?isbn=${encodeURIComponent(isbn)}`)

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.error || "Book not found")
      }

      const book = await response.json()
      setSearchResult(book)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to search book")
    } finally {
      setIsSearching(false)
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main className="max-w-6xl mx-auto px-4 py-12">
        <div className="mb-8">
          <Link href="/books">
            <Button
              variant="ghost"
              className="mb-4 bg-transparent border-2 border-border text-foreground px-6 py-3 rounded-xl font-semibold hover:bg-muted transition-all"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Books
            </Button>
          </Link>
          <h1 className="text-4xl md:text-5xl font-bold heading-vintage mb-2">Add New Book</h1>
          <p className="text-lg text-muted-foreground">Search by ISBN or add manually</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div>
            <Tabs defaultValue="isbn" className="w-full">
              <TabsList className="grid w-full grid-cols-2 mb-6">
                <TabsTrigger value="isbn">Search by ISBN</TabsTrigger>
                <TabsTrigger value="manual">Add Manually</TabsTrigger>
              </TabsList>

              <TabsContent value="isbn">
                <div className="rounded-2xl border border-border bg-card backdrop-blur-md p-8 shadow-xl">
                  <h2 className="text-2xl font-bold text-foreground mb-6">Search Book</h2>
                  <SearchBookForm onSearch={handleSearch} isLoading={isSearching} />

                  {error && (
                    <div className="mt-6 p-4 rounded-xl bg-vintage-red/10 border-2 border-vintage-red/30">
                      <p className="text-vintage-red font-medium">{error}</p>
                      <p className="text-sm text-muted-foreground mt-1">
                        Try another ISBN or check if the format is correct
                      </p>
                    </div>
                  )}
                </div>

                <div className="rounded-2xl border border-border/50 bg-card/80 backdrop-blur-xl p-6 shadow-lg mt-6">
                  <h3 className="font-bold text-foreground mb-3">Tips:</h3>
                  <ul className="text-sm text-muted-foreground space-y-2">
                    <li>• Use 10 or 13 digit ISBN numbers</li>
                    <li>• Try: 9780747532699 (Harry Potter)</li>
                    <li>• Try: 9780451524935 (1984)</li>
                    <li>• Remove dashes and spaces from ISBN</li>
                  </ul>
                </div>
              </TabsContent>

              <TabsContent value="manual">
                <div className="rounded-2xl border border-border bg-card backdrop-blur-md p-8 shadow-xl">
                  <h2 className="text-2xl font-bold text-foreground mb-6">Manual Entry</h2>
                  <ManualBookForm />
                </div>
              </TabsContent>
            </Tabs>
          </div>

          <div>
            {searchResult ? (
              <div>
                <h2 className="text-2xl font-bold text-foreground mb-6">Book Details</h2>
                <BookSearchResult book={searchResult} />
              </div>
            ) : (
              <div className="rounded-2xl border border-border bg-card backdrop-blur-md p-12 shadow-xl flex items-center justify-center text-center min-h-[400px]">
                <div>
                  <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-vintage-yellow/20 flex items-center justify-center">
                    <span className="text-4xl">📚</span>
                  </div>
                  <h3 className="text-xl font-bold text-foreground mb-2">Ready to Add</h3>
                  <p className="text-muted-foreground">Search by ISBN or enter book details manually</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
