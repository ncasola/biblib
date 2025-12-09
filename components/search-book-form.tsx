"use client"

import type React from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useState } from "react"
import { Search, Loader2 } from "lucide-react"

interface SearchBookFormProps {
  onSearch: (isbn: string) => Promise<void>
  isLoading?: boolean
}

export function SearchBookForm({ onSearch, isLoading = false }: SearchBookFormProps) {
  const [isbn, setIsbn] = useState("")

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (isbn.trim()) {
      await onSearch(isbn.trim())
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label htmlFor="isbn" className="text-sm font-semibold text-foreground">
          ISBN Number
        </label>
        <Input
          id="isbn"
          type="text"
          placeholder="e.g., 9780747532699"
          value={isbn}
          onChange={(e) => setIsbn(e.target.value)}
          disabled={isLoading}
          className="bg-input border-2 border-border rounded-xl px-4 py-3 text-base focus:border-vintage-red focus:ring-vintage-red/20"
        />
        <p className="text-xs text-muted-foreground">Enter the 10 or 13 digit ISBN code</p>
      </div>

      <Button
        type="submit"
        disabled={isLoading || !isbn.trim()}
        className="w-full bg-primary text-primary-foreground px-6 py-6 rounded-xl font-semibold hover:scale-105 active:scale-95 transition-all duration-200 shadow-lg shadow-primary/30 text-base"
      >
        {isLoading ? (
          <>
            <Loader2 className="w-5 h-5 mr-2 animate-spin" />
            Searching...
          </>
        ) : (
          <>
            <Search className="w-5 h-5 mr-2" />
            Search Book
          </>
        )}
      </Button>
    </form>
  )
}
