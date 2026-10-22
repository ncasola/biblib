"use client"

import Link from "next/link"
import type { Book } from "@/lib/types"

interface ShelfViewer3DProps {
  books: Book[]
}

const BOOK_COLORS = ["#DC2626", "#8B6F47", "#D4AF37", "#6B7C3F", "#256D72", "#355C9A", "#6B4E8B", "#A64B78"]

export function ShelfViewer3D({ books }: ShelfViewer3DProps) {
  const booksPerShelf = 6
  const shelves: Book[][] = []
  for (let index = 0; index < books.length; index += booksPerShelf) shelves.push(books.slice(index, index + booksPerShelf))

  return (
    <div className="max-h-[75vh] w-full overflow-auto p-4 sm:p-8">
      <div className="space-y-12 sm:space-y-16">
        {shelves.map((shelfBooks, shelfIndex) => (
          <section key={shelfIndex} aria-label={`Estante ${shelfIndex + 1}`}>
            <div className="relative" style={{ perspective: "1000px" }}>
              <div className="mb-3 flex min-h-[190px] flex-wrap items-end justify-center gap-x-2 gap-y-3 sm:min-h-[250px]">
                {shelfBooks.map((book) => {
                  const bookHeight = Math.min(220, Math.max(125, 125 + Math.max(book.number_of_pages || 0, 0) / 9))
                  const bookWidth = 40
                  const bookDepth = 24
                  const bookColor = BOOK_COLORS[(book.title.codePointAt(0) ?? 0) % BOOK_COLORS.length]
                  const cover = book.cover.small || book.cover.medium
                  const author = book.authors[0]?.name || "Autor desconocido"

                  return (
                    <Link
                      key={book.id}
                      href={`/book/${book.id}`}
                      aria-label={`${book.title}, de ${author}. Abrir ficha del libro.`}
                      title={`${book.title} — ${author}`}
                      className="group relative block rounded-sm outline-none transition-transform duration-200 hover:-translate-y-2 focus-visible:-translate-y-2 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                    >
                      <div className="relative shadow-xl" style={{ width: bookWidth, height: bookHeight, transformStyle: "preserve-3d" }}>
                        <div
                          aria-hidden="true"
                          className="absolute inset-0 flex flex-col items-center justify-between overflow-hidden border border-black/20 p-1.5 text-center text-[9px] font-bold text-white"
                          style={{
                            backgroundColor: bookColor,
                            backgroundImage: cover ? `url("${cover}")` : undefined,
                            backgroundSize: "cover",
                            backgroundPosition: "center",
                            transform: `translateZ(${bookDepth / 2}px)`,
                            boxShadow: "inset 0 0 20px rgba(0,0,0,0.2)",
                          }}
                        >
                          {!cover && <><span className="my-auto line-clamp-5 break-words">{book.title}</span><span className="line-clamp-2 text-[7px] opacity-90">{author}</span></>}
                        </div>
                        <div aria-hidden="true" className="absolute inset-0 border border-black/20" style={{ backgroundColor: bookColor, filter: "brightness(0.72)", transform: `translateZ(-${bookDepth / 2}px) rotateY(180deg)` }} />
                        <div aria-hidden="true" className="absolute bottom-0 left-0 right-0 border border-black/20" style={{ height: bookDepth, backgroundColor: bookColor, filter: "brightness(0.55)", transform: `rotateX(-90deg) translateZ(${bookHeight / 2}px)`, transformOrigin: "bottom" }} />
                        <div aria-hidden="true" className="absolute left-0 right-0 top-0 border border-black/20" style={{ height: bookDepth, backgroundColor: bookColor, filter: "brightness(1.12)", transform: `rotateX(90deg) translateZ(${-bookHeight / 2}px)`, transformOrigin: "top" }} />
                        <div aria-hidden="true" className="absolute inset-y-0 left-0 flex items-center justify-center overflow-hidden border border-black/20 px-1 text-[9px] font-bold text-white" style={{ width: bookDepth, backgroundColor: bookColor, filter: "brightness(0.7)", transform: `rotateY(-90deg) translateZ(${bookWidth / 2}px)`, transformOrigin: "left", writingMode: "vertical-rl" }}>
                          <span className="line-clamp-1">{book.title}</span>
                        </div>
                        <div aria-hidden="true" className="absolute inset-y-0 right-0 border border-black/20" style={{ width: bookDepth, backgroundColor: bookColor, filter: "brightness(0.9)", transform: `rotateY(90deg) translateZ(${-bookWidth / 2}px)`, transformOrigin: "right" }} />
                      </div>
                      <span className="sr-only">{book.number_of_pages ? `${book.number_of_pages} páginas.` : ""}</span>
                    </Link>
                  )
                })}
              </div>
              <div className="relative h-6 w-full rounded-sm shadow-lg sm:h-8" style={{ background: "linear-gradient(180deg, #8B4513 0%, #654321 100%)", boxShadow: "0 4px 6px rgba(0,0,0,0.3), inset 0 2px 4px rgba(255,255,255,0.1)" }} aria-hidden="true">
                <div className="absolute left-0 right-0 top-0 h-1 rounded-t-sm" style={{ background: "linear-gradient(180deg, rgba(255,255,255,0.2) 0%, transparent 100%)" }} />
              </div>
            </div>
          </section>
        ))}
      </div>
      <p className="mt-6 text-center text-xs text-muted-foreground">Selecciona un libro para abrir su ficha.</p>
    </div>
  )
}
