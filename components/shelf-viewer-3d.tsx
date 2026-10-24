"use client"

import Link from "next/link"
import Image from "next/image"
import { useState, type MouseEvent } from "react"
import { bookRowAnchor, buildBookDetailHref } from "@/lib/book-search"
import { DEFAULT_BOOK_COVER } from "@/lib/book-covers"
import type { Book } from "@/lib/types"
import {
  SCENE_SPINE_COLORS,
  sceneCoverSource,
  spineAccessibleName,
  spineForeground,
  spineHeightFor,
  splitSceneRows,
} from "@/app/shelves/3d/viewer-contract"

interface ShelfViewer3DProps {
  books: Book[]
  /** Ruta canónica de la vista 3D actual (estantería y página) para el retorno contextual de cada lomo. */
  returnPath: string
}

const BOOK_WIDTH = 40
const BOOK_DEPTH = 24

function ShelfBookCover({ book }: { book: Book }) {
  const source = sceneCoverSource(book.cover)
  const [failedSource, setFailedSource] = useState<string | null>(null)
  const fallback = !source || failedSource === source
  const author = book.authors[0]?.name?.trim()

  return <>
    <Image src={fallback ? DEFAULT_BOOK_COVER : source} alt="" fill sizes="40px" className="object-cover"
      onError={fallback ? undefined : () => setFailedSource(source)} />
    {fallback && <div className="absolute inset-x-0 bottom-0 flex flex-col justify-center gap-2 bg-card p-1 text-card-foreground">
      <span className="line-clamp-6 break-words">{book.title}</span>
      {author && <span className="line-clamp-2 text-[8px]">{author}</span>}
    </div>}
  </>
}

/**
 * Escena CSS estática y paginada de una estantería: sin rotación, gestos de giro ni
 * zoom, y sin acciones por hover. Cada lomo es un enlace real que lleva a la ficha
 * recordando la vista 3D como retorno (`?from=` validado, como en el catálogo 2D).
 */
export function ShelfViewer3D({ books, returnPath }: ShelfViewer3DProps) {
  const rows = splitSceneRows(books)

  // El historial de esta entrada recuerda el lomo abierto para que «Atrás» lo recupere.
  const rememberOpenedSpine = (event: MouseEvent<HTMLAnchorElement>, bookId: string) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}#${bookRowAnchor(bookId)}`)
  }

  return (
    <div className="shelf-scene-enter max-h-[75vh] w-full overflow-auto p-4 sm:p-8">
      <div className="space-y-12 sm:space-y-16">
        {rows.map((rowBooks, rowIndex) => (
          <section key={rowIndex} aria-label={`Repisa ${rowIndex + 1}`}>
            <div className="shelf-scene-balda relative">
              <div className="mb-3 flex min-h-[190px] flex-wrap items-end justify-center gap-x-2 gap-y-3 sm:min-h-[250px]">
                {rowBooks.map((book) => {
                  const bookHeight = spineHeightFor(book.number_of_pages)
                  const bookColor = SCENE_SPINE_COLORS[(book.title.codePointAt(0) ?? 0) % SCENE_SPINE_COLORS.length]
                  const textColor = spineForeground(bookColor)
                  const author = book.authors[0]?.name?.trim()

                  return (
                    <Link tabIndex={0}
                      key={book.id}
                      id={bookRowAnchor(book.id)}
                      href={buildBookDetailHref(book.id, `${returnPath}#${bookRowAnchor(book.id)}`)}
                      onClick={(event) => rememberOpenedSpine(event, book.id)}
                      aria-label={spineAccessibleName(book)}
                      title={author ? `${book.title} — ${author}` : book.title}
                      className="shelf-scene-book"
                    >
                      <div className="relative shadow-xl" style={{ width: BOOK_WIDTH, height: bookHeight, transformStyle: "preserve-3d" }}>
                        <div
                          aria-hidden="true"
                          className="absolute inset-0 flex flex-col items-center justify-between overflow-hidden border border-black/20 p-1.5 text-center text-[10px] font-bold"
                          style={{
                            backgroundColor: bookColor,
                            color: textColor,
                            transform: `translateZ(${BOOK_DEPTH / 2}px)`,
                            boxShadow: "inset 0 0 20px rgba(0,0,0,0.2)",
                          }}
                        >
                          <ShelfBookCover book={book} />
                        </div>
                        <div aria-hidden="true" className="absolute inset-0 border border-black/20" style={{ backgroundColor: bookColor, filter: "brightness(0.72)", transform: `translateZ(-${BOOK_DEPTH / 2}px) rotateY(180deg)` }} />
                        <div aria-hidden="true" className="absolute bottom-0 left-0 right-0 border border-black/20" style={{ height: BOOK_DEPTH, backgroundColor: bookColor, filter: "brightness(0.55)", transform: `rotateX(-90deg) translateZ(${bookHeight / 2}px)`, transformOrigin: "bottom" }} />
                        <div aria-hidden="true" className="absolute left-0 right-0 top-0 border border-black/20" style={{ height: BOOK_DEPTH, backgroundColor: bookColor, filter: "brightness(1.12)", transform: `rotateX(90deg) translateZ(${-bookHeight / 2}px)`, transformOrigin: "top" }} />
                        <div
                          aria-hidden="true"
                          className="absolute inset-y-0 left-0 flex items-center justify-center overflow-hidden border border-black/20 px-1 text-[9px] font-bold"
                          style={{
                            width: BOOK_DEPTH,
                            backgroundColor: bookColor,
                            color: textColor,
                            transform: `rotateY(-90deg) translateZ(${BOOK_WIDTH / 2}px)`,
                            transformOrigin: "left",
                            writingMode: "vertical-rl",
                            boxShadow: "inset 0 0 6px rgba(0,0,0,0.25)",
                          }}
                        >
                          <span className="line-clamp-1">{book.title}</span>
                        </div>
                        <div aria-hidden="true" className="absolute inset-y-0 right-0 border border-black/20" style={{ width: BOOK_DEPTH, backgroundColor: bookColor, filter: "brightness(0.9)", transform: `rotateY(90deg) translateZ(${-BOOK_WIDTH / 2}px)`, transformOrigin: "right" }} />
                      </div>
                    </Link>
                  )
                })}
              </div>
              <div className="shelf-scene-wood relative h-6 w-full rounded-sm sm:h-8" aria-hidden="true">
                <div className="shelf-scene-wood-top absolute left-0 right-0 top-0 h-1 rounded-t-sm" />
              </div>
            </div>
          </section>
        ))}
      </div>
      <p className="mt-6 text-center text-xs text-muted-foreground">Selecciona un libro para abrir su ficha.</p>
    </div>
  )
}
