/**
 * Contrato puro de la vista 3D de estantería (U-EXP-04, rediseñada en U-UX-02).
 *
 * La escena es CSS 3D, sin dependencias y paginada: cada libro es una caja con lomo,
 * tapas y canto, y un botón que lo saca de la balda; la ficha se abre desde el panel
 * lateral. El mueble solo gira levemente con el puntero (nunca con movimiento
 * reducido ni en móvil) y no hay zoom ni gestos de giro. La vista 2D sigue siendo la
 * alternativa equivalente con los mismos libros.
 *
 * Todo lo que la escena deriva de cada libro sale de datos que ya existen: grosor por
 * páginas (acotado), altura, color y tipo de lomo estables por id, y el reparto en
 * baldas con el último libro inclinado.
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
/** Límite superior del parámetro de página, alineado con el listado del servidor. */
export const SCENE_PAGE_MAX = 100_000

/** Grosor del lomo en px: sale de las páginas (1 px por cada 26) y queda acotado. */
export const SCENE_SPINE_MIN_THICKNESS = 24
export const SCENE_SPINE_MAX_THICKNESS = 52
const PAGES_PER_PIXEL = 26

/** Altura del lomo en px: estable por libro y siempre por debajo de la balda superior. */
export const SCENE_SPINE_MIN_HEIGHT = 150
export const SCENE_SPINE_MAX_HEIGHT = 208

/** Separación entre lomos y hueco que deja el último libro de la balda al inclinarse. */
export const SCENE_SPINE_GAP = 1
export const SCENE_LEAN_GAP = 34

/** Paleta de telas del prototipo «Biblioteca nocturna»; el color se elige por id de forma estable. */
export const SCENE_SPINE_COLORS: readonly string[] = [
  "#7a1f24", "#1f3a5f", "#2f4a2c", "#5b3a29", "#c9b48a", "#3b2a4a",
  "#8a4326", "#22303a", "#6b5222", "#e8dcc4", "#0f3d3e", "#6d1a36",
]

/** Lomo de tela con nervios, de bloque liso o con etiqueta de papel. */
export const SCENE_SPINE_STYLES = ["nervios", "bloque", "etiqueta"] as const
export type SceneSpineStyle = (typeof SCENE_SPINE_STYLES)[number]

/** Tintas del lomo: oro viejo sobre tela oscura y sepia sobre tela clara. */
export const SPINE_LIGHT_INK = "#ecd9a6"
export const SPINE_DARK_INK = "#2a2118"

export const SCENE_STATUS_LABELS: Record<Book["status"], string> = {
  read: "Leído",
  reading: "Leyendo",
  "to-read": "Por leer",
  unread: "Sin leer",
}

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
 * Enlace «Ver como tabla»: misma estantería, misma página y el mismo tamaño de
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

/** Huella FNV-1a de 32 bits del id: la misma ficha da siempre la misma apariencia. */
export function sceneBookHash(bookId: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < bookId.length; index++) {
    hash ^= bookId.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Grosor del lomo a partir de las páginas registradas, siempre dentro de los límites. */
export function spineThicknessFor(numberOfPages: number): number {
  const pages = Number.isFinite(numberOfPages) ? Math.max(numberOfPages, 0) : 0
  return Math.round(Math.min(SCENE_SPINE_MAX_THICKNESS, Math.max(SCENE_SPINE_MIN_THICKNESS, pages / PAGES_PER_PIXEL)))
}

/** Altura del lomo, estable por libro y acotada. */
export function spineHeightFor(bookId: string): number {
  const range = SCENE_SPINE_MAX_HEIGHT - SCENE_SPINE_MIN_HEIGHT + 1
  return SCENE_SPINE_MIN_HEIGHT + ((sceneBookHash(bookId) >>> 16) % range)
}

/** Color de la tela del lomo, estable por libro. */
export function spineColorFor(bookId: string): string {
  return SCENE_SPINE_COLORS[sceneBookHash(bookId) % SCENE_SPINE_COLORS.length]
}

/** Tipo de lomo (nervios, bloque o etiqueta), estable por libro. */
export function spineStyleFor(bookId: string): SceneSpineStyle {
  return SCENE_SPINE_STYLES[(sceneBookHash(bookId) >>> 8) % SCENE_SPINE_STYLES.length]
}

export interface SceneSpine {
  thickness: number
  height: number
  color: string
  ink: string
  style: SceneSpineStyle
  /** El último libro de la balda se apoya inclinado sobre su vecino. */
  leaning: boolean
}

export interface SceneShelfRow<T> {
  books: Array<{ book: T; spine: SceneSpine }>
  /** Iniciales del primer y del último título de la balda (orden por título). */
  from: string
  to: string
}

/** Inicial de un título para la placa de la balda: sin signos de apertura ni tildes (la «Ñ» se conserva). */
export function sceneTitleInitial(title: string): string {
  for (const character of title.normalize("NFC")) {
    const isLetter = character.toLocaleLowerCase("es") !== character.toLocaleUpperCase("es")
    if (!isLetter && !/[0-9]/.test(character)) continue
    const upper = character.toLocaleUpperCase("es")
    return upper === "Ñ" ? upper : upper.normalize("NFD")[0]
  }
  return "#"
}

/**
 * Reparte una página de libros en baldas de `rowWidth` px por grosor real: cada balda
 * se llena hasta donde cabe y reserva el hueco en el que se inclina su último libro.
 * Una balda con un solo libro lo deja de pie. Nunca pasa de 48 libros.
 */
export function layoutSceneShelves<T extends Pick<Book, "id" | "title" | "number_of_pages">>(
  books: readonly T[],
  rowWidth: number,
): SceneShelfRow<T>[] {
  const width = Math.max(SCENE_SPINE_MAX_THICKNESS + SCENE_LEAN_GAP + SCENE_SPINE_GAP, Math.trunc(rowWidth))
  const groups: T[][] = []
  let current: T[] = []
  let used = 0
  for (const book of books.slice(0, SCENE_BOOKS_PER_PAGE)) {
    const step = spineThicknessFor(book.number_of_pages) + SCENE_SPINE_GAP
    if (current.length > 0 && used + step + SCENE_LEAN_GAP > width) {
      groups.push(current)
      current = []
      used = 0
    }
    current.push(book)
    used += step
  }
  if (current.length > 0) groups.push(current)

  return groups.map((group) => ({
    from: sceneTitleInitial(group[0].title),
    to: sceneTitleInitial(group[group.length - 1].title),
    books: group.map((book, index) => {
      const color = spineColorFor(book.id)
      return {
        book,
        spine: {
          thickness: spineThicknessFor(book.number_of_pages),
          height: spineHeightFor(book.id),
          color,
          ink: spineForeground(color),
          style: spineStyleFor(book.id),
          leaning: group.length > 1 && index === group.length - 1,
        },
      }
    }),
  }))
}

/** Nombre accesible del lomo: título, autoría y estado de lectura, sin depender del ratón. */
export function spineAccessibleName(book: Pick<Book, "title" | "authors" | "status">): string {
  const author = book.authors[0]?.name?.trim()
  const status = SCENE_STATUS_LABELS[book.status]
  return author ? `${book.title}, de ${author}. ${status}.` : `${book.title}. ${status}.`
}

/** Nombre accesible de una balda: posición y tramo alfabético de sus títulos. */
export function sceneRowLabel(index: number, total: number, row: Pick<SceneShelfRow<unknown>, "from" | "to">): string {
  const range = row.from === row.to ? `títulos por ${row.from}` : `títulos de ${row.from} a ${row.to}`
  return `Balda ${index + 1} de ${total}, ${range}`
}

/** Orden de preferencia de tamaños: el libro sacado usa la mediana; nunca se piden todas grandes. */
export type SceneCoverSize = keyof Book["cover"]
const THUMBNAIL_FIRST: readonly SceneCoverSize[] = ["small", "medium", "large"]

/**
 * Portada real para la cara del libro. La portada genérica no identifica el libro:
 * cuando solo hay genérica se devuelve `null` y la cara muestra la tapa tipográfica.
 */
export function sceneCoverSource(
  cover: Partial<Book["cover"]> | null | undefined,
  order: readonly SceneCoverSize[] = THUMBNAIL_FIRST,
): string | null {
  for (const size of order) {
    const value = cover?.[size]
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

/** Razón de contraste WCAG entre dos colores `#rrggbb`. */
export function contrastRatio(first: string, second: string): number {
  const a = relativeLuminance(first)
  const b = relativeLuminance(second)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** Tinta del texto del lomo: la de más contraste sobre la tela (≥ 4,5:1 en toda la paleta). */
export function spineForeground(spineColor: string): string {
  return contrastRatio(spineColor, SPINE_LIGHT_INK) >= contrastRatio(spineColor, SPINE_DARK_INK) ? SPINE_LIGHT_INK : SPINE_DARK_INK
}
