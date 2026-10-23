/**
 * Contrato puro de la vista 3D de estantería (U-EXP-04).
 *
 * La escena es CSS, estática y paginada: no hay rotación libre, gestos de giro ni
 * zoom, y ningún texto del visor los promete. Cada lomo es un enlace real a su
 * ficha y la vista 2D es la alternativa equivalente con los mismos libros.
 *
 * Este módulo no tiene código de cliente ni de servidor: lo comparten la página,
 * el visor y las pruebas de `node --test`. Por eso importa con rutas relativas
 * (`../../../lib/...`), a diferencia del resto de archivos de `app`, que usan el
 * alias `@/`: el compilador de pruebas emite estos fuentes tal cual y Node no
 * resuelve el alias en tiempo de ejecución.
 */
import { DEFAULT_BOOK_COVER } from "../../../lib/book-covers"
import type { Book } from "../../../lib/types"

/** Máximo de libros por página de la escena; dentro del máximo que admite el listado (≤ 100). */
export const SCENE_BOOKS_PER_PAGE = 48
/** Libros por repisa dentro de una misma página de la escena. */
export const SCENE_BOOKS_PER_ROW = 6
/** Límite superior del parámetro de página, alineado con el listado del servidor. */
export const SCENE_PAGE_MAX = 100_000

/** Alturas de lomo acotadas: la escena no crece sin límite con las páginas registradas. */
export const SCENE_SPINE_MIN_HEIGHT = 125
export const SCENE_SPINE_MAX_HEIGHT = 220

/** Paleta vintage de lomos; el color se elige por título de forma estable. */
export const SCENE_SPINE_COLORS: readonly string[] = [
  "#DC2626", "#8B6F47", "#D4AF37", "#6B7C3F", "#256D72", "#355C9A", "#6B4E8B", "#A64B78",
]

/** Umbral de luminancia a partir del cual el texto del lomo pasa a tinta oscura. */
const SPINE_TEXT_SWITCH_LUMINANCE = 0.35
const SPINE_DARK_TEXT = "#3D2B1F"
const SPINE_LIGHT_TEXT = "#FFFFFF"

const SHELF_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ShelfSceneParams {
  shelf: string | null
  page: number
}

/** Páginas de la escena para un recuento de libros (con 0 libros no hay páginas). */
export function scenePageCount(bookCount: number): number {
  return Math.ceil(Math.max(bookCount, 0) / SCENE_BOOKS_PER_PAGE)
}

/** Ajusta la página al rango real con el mismo criterio con que el servidor la corrige. */
export function clampScenePage(page: number, pageCount: number): number {
  const last = Math.max(1, pageCount)
  const requested = Number.isFinite(page) ? Math.trunc(page) : 1
  return Math.min(Math.max(1, requested), last)
}

/** Lee estantería y página de la URL de la vista 3D; los valores ajenos caen a los seguros. */
export function parseShelfSceneParams(params: URLSearchParams): ShelfSceneParams {
  const shelf = params.get("shelf")
  const rawPage = Number.parseInt(params.get("page") ?? "", 10)
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.min(rawPage, SCENE_PAGE_MAX) : 1
  return { shelf: shelf && SHELF_ID_PATTERN.test(shelf) ? shelf : null, page }
}

/** Ruta canónica de la vista 3D, omitiendo los valores por defecto como hace el catálogo 2D. */
export function buildShelf3dPath(shelfId: string | null, page: number): string {
  const params = new URLSearchParams()
  if (shelfId) params.set("shelf", shelfId)
  if (page > 1) params.set("page", String(Math.trunc(page)))
  const query = params.toString()
  return query ? `/shelves/3d?${query}` : "/shelves/3d"
}

/**
 * Enlace «Ver en la colección»: misma estantería, misma página y el mismo tamaño de
 * página, de modo que la vista 2D contiene exactamente los mismos libros que la
 * escena 3D (mismo orden por título y mismo recorte del servidor).
 */
export function buildShelfCollectionHref(shelfId: string, page: number): string {
  const params = new URLSearchParams()
  params.set("shelf", shelfId)
  if (page > 1) params.set("page", String(Math.trunc(page)))
  params.set("pageSize", String(SCENE_BOOKS_PER_PAGE))
  return `/books?${params.toString()}`
}

/** Filtros exactos con los que la vista 3D pide su página al listado paginado del servidor. */
export function sceneListRequest(shelfId: string, page: number) {
  return {
    q: "",
    status: "all",
    shelf: shelfId,
    sort: "title",
    page,
    pageSize: SCENE_BOOKS_PER_PAGE,
  } as const
}

/** Recorta una lista ordenada del servidor a una página, corrigiendo páginas fuera de rango. */
export function bookIdsForPage(orderedIds: readonly string[], page: number, pageSize: number): string[] {
  const size = Math.max(1, Math.trunc(pageSize))
  const requested = Number.isFinite(page) ? Math.trunc(page) : 1
  const last = Math.max(1, Math.ceil(orderedIds.length / size))
  const current = Math.min(Math.max(1, requested), last)
  const start = (current - 1) * size
  return orderedIds.slice(start, start + size)
}

/** Ids de los libros de una página de la escena, en el orden que devuelve el servidor. */
export function sceneBookIds(orderedIds: readonly string[], page: number): string[] {
  return bookIdsForPage(orderedIds, page, SCENE_BOOKS_PER_PAGE)
}

/** Reparte los libros de una página en repisas fijas para componer la escena. */
export function splitSceneRows<T>(items: readonly T[], perRow: number = SCENE_BOOKS_PER_ROW): T[][] {
  const size = Math.max(1, Math.trunc(perRow))
  const page = items.slice(0, SCENE_BOOKS_PER_PAGE)
  const rows: T[][] = []
  for (let index = 0; index < page.length; index += size) rows.push(page.slice(index, index + size))
  return rows
}

/** Altura del lomo a partir de las páginas registradas, siempre dentro de los límites. */
export function spineHeightFor(numberOfPages: number): number {
  const pages = Number.isFinite(numberOfPages) ? Math.max(numberOfPages, 0) : 0
  const scaled = SCENE_SPINE_MIN_HEIGHT + pages / 9
  return Math.min(SCENE_SPINE_MAX_HEIGHT, Math.max(SCENE_SPINE_MIN_HEIGHT, scaled))
}

/** Nombre accesible del lomo: título, autoría y acción, sin depender del ratón. */
export function spineAccessibleName(book: Pick<Book, "title" | "authors">): string {
  const author = book.authors[0]?.name?.trim()
  return author ? `${book.title}, de ${author}. Abrir la ficha del libro.` : `${book.title}. Abrir la ficha del libro.`
}

/**
 * Portada real para la cara del libro. La portada genérica no identifica el libro:
 * cuando solo hay genérica se devuelve `null` y la cara muestra el título.
 */
export function sceneCoverSource(cover: Partial<Book["cover"]> | null | undefined): string | null {
  for (const value of [cover?.small, cover?.medium, cover?.large]) {
    if (typeof value !== "string") continue
    const candidate = value.trim()
    if (!candidate || candidate === DEFAULT_BOOK_COVER || candidate === "/placeholder.svg") continue
    if (candidate.startsWith("/") || /^https?:\/\//i.test(candidate)) return candidate
  }
  return null
}

function channelToLinear(channel: number): number {
  const ratio = channel / 255
  return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4
}

/** Luminancia relativa WCAG de un color hexadecimal `#rrggbb`. */
export function relativeLuminance(hex: string): number {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return 0
  const value = Number.parseInt(match[1], 16)
  return 0.2126 * channelToLinear((value >> 16) & 0xff) + 0.7152 * channelToLinear((value >> 8) & 0xff) + 0.0722 * channelToLinear(value & 0xff)
}

/** Tinta del texto del lomo con contraste sobre el color del libro (≥ 4,5:1 en la paleta). */
export function spineForeground(spineColor: string): string {
  return relativeLuminance(spineColor) >= SPINE_TEXT_SWITCH_LUMINANCE ? SPINE_DARK_TEXT : SPINE_LIGHT_TEXT
}
