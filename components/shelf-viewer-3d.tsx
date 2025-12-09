"use client"

import { useState } from "react"
import type { Book } from "@/lib/types"

interface ShelfViewer3DProps {
  books: Book[]
}

export function ShelfViewer3D({ books }: ShelfViewer3DProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  // Organize books into shelves (6 books per shelf)
  const booksPerShelf = 6
  const shelves: Book[][] = []
  for (let i = 0; i < books.length; i += booksPerShelf) {
    shelves.push(books.slice(i, i + booksPerShelf))
  }

  return (
    <div className="w-full h-full overflow-y-auto p-8">
      <div className="space-y-16">
        {shelves.map((shelfBooks, shelfIndex) => (
          <div key={shelfIndex} className="relative">
            {/* Shelf */}
            <div className="relative" style={{ perspective: "1200px" }}>
              {/* Books on shelf */}
              <div className="flex items-end justify-center gap-2 mb-4 min-h-[240px]">
                {shelfBooks.map((book, bookIndex) => {
                  const globalIndex = shelfIndex * booksPerShelf + bookIndex
                  const isHovered = hoveredIndex === globalIndex

                  // Random book heights and colors for variety
                  const bookHeight = 180 + (book.number_of_pages || 200) / 3
                  const bookWidth = 40
                  const bookDepth = 25

                  // Generate color from book title
                  const colors = [
                    "#DC2626",
                    "#EA580C",
                    "#CA8A04",
                    "#16A34A",
                    "#0891B2",
                    "#2563EB",
                    "#7C3AED",
                    "#C026D3",
                  ]
                  const colorIndex = book.title.charCodeAt(0) % colors.length
                  const bookColor = colors[colorIndex]

                  return (
                    <div
                      key={book.id}
                      className="relative cursor-pointer transition-all duration-300 ease-out"
                      style={{
                        transformStyle: "preserve-3d",
                        transform: isHovered
                          ? "translateY(-20px) translateZ(30px) rotateY(-5deg)"
                          : "translateY(0) translateZ(0) rotateY(0deg)",
                      }}
                      onMouseEnter={() => setHoveredIndex(globalIndex)}
                      onMouseLeave={() => setHoveredIndex(null)}
                    >
                      {/* Book 3D CSS structure */}
                      <div
                        className="relative shadow-2xl"
                        style={{
                          width: `${bookWidth}px`,
                          height: `${bookHeight}px`,
                          transformStyle: "preserve-3d",
                        }}
                      >
                        {/* Front cover */}
                        <div
                          className="absolute inset-0 flex flex-col items-center justify-between p-2 text-white text-xs font-bold overflow-hidden"
                          style={{
                            backgroundColor: bookColor,
                            backgroundImage: book.cover.small
                              ? `url(${book.cover.small})`
                              : `url(/default-book-cover.webp)`,
                            backgroundSize: "cover",
                            backgroundPosition: "center",
                            transform: `translateZ(${bookDepth / 2}px)`,
                            border: "1px solid rgba(0,0,0,0.2)",
                            boxShadow: "inset 0 0 20px rgba(0,0,0,0.2)",
                          }}
                        >
                          {!book.cover.small && !book.cover.medium && (
                            <>
                              <div className="text-center line-clamp-4 px-1">{book.title}</div>
                              <div className="text-[8px] opacity-80 text-center line-clamp-2">
                                {book.authors[0]?.name || "Unknown"}
                              </div>
                            </>
                          )}
                        </div>

                        {/* Back cover */}
                        <div
                          className="absolute inset-0"
                          style={{
                            backgroundColor: bookColor,
                            filter: "brightness(0.8)",
                            transform: `translateZ(-${bookDepth / 2}px) rotateY(180deg)`,
                            border: "1px solid rgba(0,0,0,0.2)",
                          }}
                        />

                        {/* Spine (bottom when standing) */}
                        <div
                          className="absolute bottom-0 left-0 right-0 flex items-center justify-center text-white text-[8px] font-bold"
                          style={{
                            height: `${bookDepth}px`,
                            backgroundColor: bookColor,
                            filter: "brightness(0.6)",
                            transform: `rotateX(-90deg) translateZ(${bookHeight / 2}px)`,
                            transformOrigin: "bottom",
                            border: "1px solid rgba(0,0,0,0.2)",
                          }}
                        />

                        {/* Top */}
                        <div
                          className="absolute top-0 left-0 right-0"
                          style={{
                            height: `${bookDepth}px`,
                            backgroundColor: bookColor,
                            filter: "brightness(1.1)",
                            transform: `rotateX(90deg) translateZ(${-bookHeight / 2}px)`,
                            transformOrigin: "top",
                            border: "1px solid rgba(0,0,0,0.2)",
                          }}
                        />

                        {/* Left side */}
                        <div
                          className="absolute inset-y-0 left-0 text-white flex items-center justify-center"
                          style={{
                            width: `${bookDepth}px`,
                            backgroundColor: bookColor,
                            filter: "brightness(0.7)",
                            transform: `rotateY(-90deg) translateZ(${bookWidth / 2}px)`,
                            transformOrigin: "left",
                            border: "1px solid rgba(0,0,0,0.2)",
                            writingMode: "vertical-rl",
                            fontSize: "10px",
                            fontWeight: "bold",
                            padding: "8px 4px",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          <span className="line-clamp-1">{book.title}</span>
                        </div>

                        {/* Right side */}
                        <div
                          className="absolute inset-y-0 right-0"
                          style={{
                            width: `${bookDepth}px`,
                            backgroundColor: bookColor,
                            filter: "brightness(0.9)",
                            transform: `rotateY(90deg) translateZ(${-bookWidth / 2}px)`,
                            transformOrigin: "right",
                            border: "1px solid rgba(0,0,0,0.2)",
                          }}
                        />
                      </div>

                      {/* Book info tooltip on hover */}
                      {isHovered && (
                        <div className="absolute top-full mt-2 left-1/2 -translate-x-1/2 bg-black/90 text-white text-xs rounded-lg p-2 min-w-[150px] z-50 pointer-events-none">
                          <p className="font-bold line-clamp-2">{book.title}</p>
                          <p className="text-[10px] opacity-80 mt-1">{book.authors[0]?.name || "Unknown"}</p>
                          {book.number_of_pages && (
                            <p className="text-[10px] opacity-60 mt-1">{book.number_of_pages} pages</p>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Wooden shelf */}
              <div
                className="relative w-full h-8 rounded-sm shadow-lg"
                style={{
                  background: "linear-gradient(180deg, #8B4513 0%, #654321 100%)",
                  boxShadow: "0 4px 6px rgba(0,0,0,0.3), inset 0 2px 4px rgba(255,255,255,0.1)",
                }}
              >
                {/* Shelf edge highlight */}
                <div
                  className="absolute top-0 left-0 right-0 h-1 rounded-t-sm"
                  style={{
                    background: "linear-gradient(180deg, rgba(255,255,255,0.2) 0%, transparent 100%)",
                  }}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
