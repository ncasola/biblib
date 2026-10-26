"use client"

import Image from "next/image"
import Link from "next/link"
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react"
import { bookRowAnchor, buildBookDetailHref } from "@/lib/book-search"
import { displayCover } from "@/lib/book-covers"
import type { Book } from "@/lib/types"
import {
  SCENE_STATUS_LABELS,
  layoutSceneShelves,
  sceneCoverSource,
  sceneRowLabel,
  spineAccessibleName,
  type SceneSpine,
} from "@/app/shelves/3d/viewer-contract"

export type ShelfWood = "nogal" | "roble" | "ebano"

interface ShelfViewer3DProps {
  books: Book[]
  /** Ruta canónica de la vista 3D actual (estantería y página) para el retorno contextual de la ficha. */
  returnPath: string
  /** Nombre de la estantería: placa de la cornisa y ficha del libro sacado. */
  shelfTitle: string
  /** Madera del mueble; nogal por defecto. */
  wood?: ShelfWood
}

type SceneStyle = CSSProperties & Record<`--${string}`, string | number>

/** Geometría del prototipo «Estantería 3D nueva» (px). */
const CABINET_MAX_WIDTH = 760
const CABINET_MIN_WIDTH = 240
const CABINET_SIDE_MARGIN = 24
const ROW_INSET = 60
const CABINET_TOP = 20
const BOARD_PITCH = 232
/** El zócalo va bajo el canto de la última balda, que conserva su placa visible. */
const PLINTH_OFFSET = 18 + 34
const MIN_BOARDS = 2

/**
 * Cómo se ve el mueble: con giro leve al mover el ratón (escritorio), en ángulo fijo
 * (escritorio con movimiento reducido) o de frente (pantallas estrechas o táctiles).
 */
type SceneView = "giro" | "angulo" | "frente"
const DESKTOP_QUERY = "(min-width: 1024px) and (hover: hover) and (pointer: fine)"
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)"
const VIEW_ANGLES: Record<SceneView, { ax: number; ay: number }> = {
  giro: { ax: -5, ay: -14 },
  angulo: { ax: -5, ay: -14 },
  frente: { ax: -2, ay: 0 },
}

function subscribeSceneView(onChange: () => void): () => void {
  const queries = [window.matchMedia(DESKTOP_QUERY), window.matchMedia(REDUCED_MOTION_QUERY)]
  for (const query of queries) query.addEventListener("change", onChange)
  return () => {
    for (const query of queries) query.removeEventListener("change", onChange)
  }
}

function readSceneView(): SceneView {
  if (!window.matchMedia(DESKTOP_QUERY).matches) return "frente"
  return window.matchMedia(REDUCED_MOTION_QUERY).matches ? "angulo" : "giro"
}

function serverSceneView(): SceneView {
  return "frente"
}

function boardTop(index: number): number {
  return CABINET_TOP + (index + 1) * BOARD_PITCH
}

function authorsOf(book: Book): string {
  const names = book.authors.map((author) => author.name?.trim()).filter((name): name is string => Boolean(name))
  return names.length > 0 ? names.join(", ") : "Autoría sin registrar"
}

/** Tapa del libro: la portada real solo para el libro sacado; si no hay, la tapa tipográfica. */
function SceneCover({ book, selected }: { book: Book; selected: boolean }) {
  const source = selected ? sceneCoverSource(displayCover(book), ["medium", "small", "large"]) : null
  const [failedSource, setFailedSource] = useState<string | null>(null)
  const author = book.authors[0]?.name?.trim()

  return <>
    <span className="s3-cover-frame">
      <span className="s3-cover-title">{book.title}</span>
      <span className="s3-cover-rule" />
      {author && <span className="s3-cover-author">{author}</span>}
    </span>
    {source && failedSource !== source && (
      <span className="s3-cover-image">
        <Image src={source} alt="" fill sizes="92px" onError={() => setFailedSource(source)} />
      </span>
    )}
  </>
}

interface SceneBookProps {
  book: Book
  spine: SceneSpine
  selected: boolean
  tabStop: boolean
  onToggle: (bookId: string) => void
  onSpineFocus: (bookId: string) => void
  onSpineKeyDown: (event: KeyboardEvent<HTMLButtonElement>, bookId: string) => void
  registerSpine: (bookId: string, element: HTMLButtonElement | null) => void
}

/** Un libro: botón con nombre accesible y caras decorativas (lomo, tapa, contratapa y canto). */
const SceneBook = memo(function SceneBook({ book, spine, selected, tabStop, onToggle, onSpineFocus, onSpineKeyDown, registerSpine }: SceneBookProps) {
  const style: SceneStyle = { "--t": spine.thickness, "--h": spine.height, "--c": spine.color, "--ink": spine.ink }
  const banded = spine.style !== "bloque"

  return (
    <button
      type="button"
      ref={(element) => registerSpine(book.id, element)}
      id={bookRowAnchor(book.id)}
      className="s3-book"
      aria-label={spineAccessibleName(book)}
      aria-pressed={selected}
      tabIndex={tabStop ? 0 : -1}
      data-inclinado={spine.leaning}
      data-fino={spine.thickness < 28}
      style={style}
      onClick={() => onToggle(book.id)}
      onFocus={() => onSpineFocus(book.id)}
      onKeyDown={(event) => onSpineKeyDown(event, book.id)}
    >
      <span className="s3-move" aria-hidden="true">
        <span className="s3-face s3-spine" data-lomo={spine.style}>
          {banded && <span className="s3-band s3-band-top" />}
          <span className="s3-spine-title">{book.title}</span>
          {banded && <span className="s3-band s3-band-bottom" />}
        </span>
        {/* La trasera nunca se ve en la balda: solo se pinta en el libro sacado. */}
        {selected && <span className="s3-face s3-book-back" />}
        <span className="s3-face s3-cover"><SceneCover book={book} selected={selected} /></span>
        <span className="s3-face s3-back-cover" />
        <span className="s3-face s3-pages" />
      </span>
    </button>
  )
})

/**
 * Estantería 3D en CSS: un mueble de madera con baldas, y cada libro como una caja
 * que asoma al pasar el puntero o el foco y, al pulsarla, sale de la balda y gira para
 * enseñar la tapa junto a su ficha. Las flechas recorren los lomos (un único punto de
 * tabulación); Escape o «Devolver a la balda» lo devuelve y el foco vuelve al lomo.
 */
export function ShelfViewer3D({ books, returnPath, shelfTitle, wood = "nogal" }: ShelfViewer3DProps) {
  const view = useSyncExternalStore(subscribeSceneView, readSceneView, serverSceneView)
  const sceneRef = useRef<HTMLDivElement>(null)
  const cabinetRef = useRef<HTMLDivElement>(null)
  const spines = useRef(new Map<string, HTMLButtonElement>())
  const tiltFrame = useRef(0)
  const [available, setAvailable] = useState(CABINET_MAX_WIDTH + CABINET_SIDE_MARGIN)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState("")

  // El mueble se adapta al ancho disponible: en móvil es más estrecho y tiene más baldas.
  useLayoutEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    const measure = () => setAvailable(scene.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scene)
    return () => observer.disconnect()
  }, [])

  const width = Math.max(CABINET_MIN_WIDTH, Math.min(CABINET_MAX_WIDTH, Math.floor((available - CABINET_SIDE_MARGIN) / 10) * 10))
  const rows = useMemo(() => layoutSceneShelves(books, width - ROW_INSET), [books, width])
  const boards = Array.from({ length: Math.max(MIN_BOARDS, rows.length) }, (_, index) => boardTop(index))
  const height = boards[boards.length - 1] + PLINTH_OFFSET
  const order = useMemo(() => rows.map((row) => row.books.map(({ book }) => book.id)), [rows])
  const entries = useMemo(() => rows.flatMap((row, rowIndex) => row.books.map(({ book }) => ({ book, rowIndex }))), [rows])
  const selected = entries.find((entry) => entry.book.id === selectedId) ?? null
  const tabStopId = [selectedId, activeId].find((id) => id && entries.some((entry) => entry.book.id === id)) ?? entries[0]?.book.id ?? null

  const setTilt = useCallback((dx: number, dy: number) => {
    const cabinet = cabinetRef.current
    if (!cabinet) return
    cabinet.style.setProperty("--s3-dx", dx.toFixed(3))
    cabinet.style.setProperty("--s3-dy", dy.toFixed(3))
  }, [])

  // Sin giro con el puntero fuera del escritorio o con movimiento reducido.
  useEffect(() => {
    if (view !== "giro") setTilt(0, 0)
  }, [view, setTilt])

  useEffect(() => () => cancelAnimationFrame(tiltFrame.current), [])

  const onScenePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (view !== "giro" || event.pointerType !== "mouse") return
    const box = event.currentTarget.getBoundingClientRect()
    const dx = (event.clientX - box.left) / box.width - 0.5
    const dy = (event.clientY - box.top) / box.height - 0.5
    cancelAnimationFrame(tiltFrame.current)
    tiltFrame.current = requestAnimationFrame(() => setTilt(dx, dy))
  }

  const registerSpine = useCallback((bookId: string, element: HTMLButtonElement | null) => {
    if (element) spines.current.set(bookId, element)
    else spines.current.delete(bookId)
  }, [])

  const focusSpine = useCallback((bookId: string) => {
    setActiveId(bookId)
    spines.current.get(bookId)?.focus()
  }, [])

  const onToggle = useCallback((bookId: string) => {
    const book = books.find((candidate) => candidate.id === bookId)
    const next = selectedId === bookId ? null : bookId
    setActiveId(bookId)
    setSelectedId(next)
    if (book) setAnnouncement(next ? `«${book.title}» fuera de la balda; su ficha está en el panel.` : `«${book.title}» devuelto a la balda.`)
    // De frente (móvil) el panel queda al pie: el lomo sacado se centra por encima de él.
    if (next && view === "frente") {
      const behavior = window.matchMedia(REDUCED_MOTION_QUERY).matches ? "auto" : "smooth"
      requestAnimationFrame(() => spines.current.get(next)?.scrollIntoView({ block: "center", behavior }))
    }
  }, [books, selectedId, view])

  const putBack = useCallback(() => {
    if (!selectedId) return
    const book = books.find((candidate) => candidate.id === selectedId)
    setSelectedId(null)
    if (book) setAnnouncement(`«${book.title}» devuelto a la balda.`)
    focusSpine(selectedId)
  }, [books, focusSpine, selectedId])

  // Flechas: izquierda/derecha recorren la balda (y saltan a la siguiente); arriba/abajo cambian de balda.
  const onSpineKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>, bookId: string) => {
    const rowIndex = order.findIndex((row) => row.includes(bookId))
    if (rowIndex < 0) return
    const index = order[rowIndex].indexOf(bookId)
    const flat = order.flat()
    const position = flat.indexOf(bookId)
    let target: string | undefined
    if (event.key === "ArrowRight") target = flat[position + 1]
    else if (event.key === "ArrowLeft") target = flat[position - 1]
    else if (event.key === "ArrowDown") target = order[rowIndex + 1]?.[Math.min(index, order[rowIndex + 1].length - 1)]
    else if (event.key === "ArrowUp") target = order[rowIndex - 1]?.[Math.min(index, order[rowIndex - 1].length - 1)]
    else if (event.key === "Home") target = flat[0]
    else if (event.key === "End") target = flat[flat.length - 1]
    else return
    event.preventDefault()
    if (target) focusSpine(target)
  }, [focusSpine, order])

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || !selectedId) return
    event.preventDefault()
    putBack()
  }

  // El historial de esta entrada recuerda el lomo abierto para que «Atrás» lo recupere.
  const rememberOpenedSpine = (event: MouseEvent<HTMLAnchorElement>, bookId: string) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}#${bookRowAnchor(bookId)}`)
  }

  const angles = VIEW_ANGLES[view]
  const cabinetStyle: SceneStyle = { "--s3-w": width, "--s3-h": height, "--s3-ax": angles.ax, "--s3-ay": angles.ay }
  const bookCount = entries.length

  return (
    <div className="s3-root" data-madera={wood} onKeyDown={onRootKeyDown}>
      <div className="s3-stage">
        {view === "giro" && (
          <div className="s3-toolbar">
            <button type="button" className="s3-pill" onClick={() => setTilt(0, 0)}>Recentrar vista</button>
          </div>
        )}
        <div ref={sceneRef} className="s3-scene" data-vista={view} onPointerMove={onScenePointerMove}>
          <div className="s3-floor" aria-hidden="true" style={{ width: width + 60 }} />
          <div ref={cabinetRef} className="s3-cabinet" style={cabinetStyle}>
            <span aria-hidden="true" className="s3-wood s3-back" />
            {boards.map((top) => <span key={`sombra-${top}`} aria-hidden="true" className="s3-wood s3-board-shadow" style={{ "--s3-y": top } as SceneStyle} />)}
            <span aria-hidden="true" className="s3-wood s3-side s3-side-left" />
            <span aria-hidden="true" className="s3-wood s3-side s3-side-right" />
            <span aria-hidden="true" className="s3-wood s3-top" />
            {boards.map((top) => (
              <span key={`balda-${top}`} aria-hidden="true">
                <span className="s3-wood s3-board-surface" style={{ "--s3-y": top } as SceneStyle} />
                <span className="s3-wood s3-board-under" style={{ "--s3-y": top } as SceneStyle} />
              </span>
            ))}
            {rows.map((row, rowIndex) => (
              <div key={rowIndex} role="group" aria-label={sceneRowLabel(rowIndex, rows.length, row)} className="s3-row" style={{ "--s3-y": boards[rowIndex] } as SceneStyle}>
                {row.books.map(({ book, spine }) => (
                  <SceneBook
                    key={book.id}
                    book={book}
                    spine={spine}
                    selected={book.id === selectedId}
                    tabStop={book.id === tabStopId}
                    onToggle={onToggle}
                    onSpineFocus={setActiveId}
                    onSpineKeyDown={onSpineKeyDown}
                    registerSpine={registerSpine}
                  />
                ))}
              </div>
            ))}
            {boards.map((top, index) => (
              <span key={`canto-${top}`} aria-hidden="true" className="s3-wood s3-board-edge" style={{ "--s3-y": top } as SceneStyle}>
                {rows[index] && <span className="s3-plaque">{rows[index].from === rows[index].to ? rows[index].from : `${rows[index].from} – ${rows[index].to}`}</span>}
              </span>
            ))}
            <span aria-hidden="true" className="s3-wood s3-stile s3-stile-left" />
            <span aria-hidden="true" className="s3-wood s3-stile s3-stile-right" />
            <span aria-hidden="true" className="s3-wood s3-crown"><span className="s3-plaque">{shelfTitle}</span></span>
            <span aria-hidden="true" className="s3-wood s3-plinth" />
          </div>
        </div>
      </div>

      <section aria-label="Libro seleccionado" className="s3-panel" data-con-libro={selected !== null}>
        {selected ? (
          <>
            <div className="flex flex-col gap-2">
              <span className="s3-eyebrow">{shelfTitle} · balda {selected.rowIndex + 1}</span>
              <h2 className="s3-panel-title">{selected.book.title}</h2>
              {selected.book.subtitle && <p className="s3-panel-text">{selected.book.subtitle}</p>}
              <p className="s3-panel-text">{authorsOf(selected.book)}</p>
            </div>
            <dl className="s3-facts">
              <div className="s3-fact">
                <dt>Páginas</dt>
                <dd>{selected.book.number_of_pages > 0 ? selected.book.number_of_pages.toLocaleString("es-ES") : "Sin dato"}</dd>
              </div>
              <div className="s3-fact">
                <dt>Estado</dt>
                <dd data-estado={selected.book.status}>{SCENE_STATUS_LABELS[selected.book.status]}</dd>
              </div>
            </dl>
            <div className="s3-actions">
              <Link
                className="s3-action"
                href={buildBookDetailHref(selected.book.id, `${returnPath}#${bookRowAnchor(selected.book.id)}`)}
                onClick={(event) => rememberOpenedSpine(event, selected.book.id)}
              >
                Abrir ficha
              </Link>
              <button type="button" className="s3-pill s3-pill-block" onClick={putBack}>Devolver a la balda</button>
            </div>
          </>
        ) : (
          <>
            <h2 className="s3-panel-title">Saca un libro de la balda</h2>
            <p className="s3-panel-text">
              {view === "frente"
                ? "Toca un lomo para sacarlo de la estantería y ver su tapa. Con teclado, recorre los lomos con las flechas y pulsa Intro."
                : "Pasa el puntero por los lomos o recórrelos con las flechas del teclado. Al pulsar uno, sale de la estantería y gira para enseñarte la tapa."}
            </p>
            {view === "giro" && <p className="s3-panel-text">Mueve el puntero sobre el mueble para verlo desde otro ángulo.</p>}
            <p className="s3-summary">
              {bookCount} {bookCount === 1 ? "libro" : "libros"} en {rows.length} {rows.length === 1 ? "balda" : "baldas"}. El grosor de cada lomo sale de su número de páginas.
            </p>
          </>
        )}
        <p className="sr-only" aria-live="polite">{announcement}</p>
      </section>
    </div>
  )
}
