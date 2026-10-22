"use client"

import Image from "next/image"
import { useState } from "react"
import type { Book } from "@/lib/types"
import { DEFAULT_BOOK_COVER, normalizeBookCover } from "@/lib/book-covers"
import { cn } from "@/lib/utils"

interface BookCoverProps {
  cover?: Partial<Book["cover"]> | null
  title: string
  className?: string
  sizes?: string
  priority?: boolean
  size?: keyof Book["cover"]
}

export function BookCover({ cover, title, className, sizes = "(max-width: 768px) 50vw, 240px", priority = false, size = "medium" }: BookCoverProps) {
  const source = normalizeBookCover(cover)[size]
  const [failedSource, setFailedSource] = useState<string | null>(null)
  const src = failedSource === source ? DEFAULT_BOOK_COVER : source

  return (
    <div className={cn("relative aspect-[2/3] overflow-hidden rounded-xl border border-border bg-muted/40", className)}>
      <Image src={src} alt={`Portada de ${title}`} fill sizes={sizes} priority={priority} className="object-contain"
        onError={src !== DEFAULT_BOOK_COVER ? () => setFailedSource(source) : undefined} />
    </div>
  )
}
