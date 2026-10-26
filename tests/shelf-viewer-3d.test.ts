import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_BOOK_COVER } from "../lib/book-covers"
import { BOOK_RETURN_PARAM, bookRowAnchor, buildBookDetailHref, parseBookSearchFilters, resolveBookReturnPath } from "../lib/book-search"
import {
  SCENE_BOOKS_PER_PAGE,
  SCENE_LEAN_GAP,
  SCENE_PAGE_MAX,
  SCENE_SPINE_COLORS,
  SCENE_SPINE_GAP,
  SCENE_SPINE_MAX_HEIGHT,
  SCENE_SPINE_MAX_THICKNESS,
  SCENE_SPINE_MIN_HEIGHT,
  SCENE_SPINE_MIN_THICKNESS,
  SCENE_SPINE_STYLES,
  SCENE_STATUS_LABELS,
  SPINE_DARK_INK,
  SPINE_LIGHT_INK,
  bookIdsForPage,
  buildShelf3dPath,
  buildShelfCollectionHref,
  clampScenePage,
  contrastRatio,
  layoutSceneShelves,
  parseShelfSceneParams,
  relativeLuminance,
  sceneBookHash,
  sceneBookIds,
  sceneCoverSource,
  sceneListRequest,
  scenePageCount,
  sceneRowLabel,
  sceneTitleInitial,
  spineAccessibleName,
  spineColorFor,
  spineForeground,
  spineHeightFor,
  spineStyleFor,
  spineThicknessFor,
} from "../app/shelves/3d/viewer-contract"

const SHELF_ID = "33333333-3333-4333-8333-333333333333"
const BOOK_ID = "44444444-4444-4444-8444-444444444444"

function sceneId(index: number): string {
  return `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`
}

function queryOf(path: string): URLSearchParams {
  return new URL(path, "https://biblib.invalid").searchParams
}

test("la escena pagina con un máximo de 48 libros y nunca pide el catálogo completo", () => {
  assert.equal(SCENE_BOOKS_PER_PAGE, 48)
  assert.ok(SCENE_BOOKS_PER_PAGE <= 100, "el listado del servidor admite como máximo 100 por página")

  assert.deepEqual(
    [[0, 0], [1, 1], [47, 1], [48, 1], [49, 2], [96, 2], [97, 3]].map(([count]) => scenePageCount(count)),
    [0, 1, 1, 1, 2, 2, 3],
  )

  const request = sceneListRequest(SHELF_ID, 2)
  assert.deepEqual(request, { q: "", status: "all", shelf: SHELF_ID, sort: "title", page: 2, pageSize: 48 })
  assert.equal(request.pageSize, SCENE_BOOKS_PER_PAGE)
})

test("la página de la escena se ajusta al rango real como lo corrige el servidor", () => {
  for (const [page, pages, expected] of [
    [1, 3, 1], [3, 3, 3], [4, 3, 3], [99, 3, 3], [0, 3, 1], [-2, 3, 1], [Number.NaN, 3, 1],
    [2, 0, 1], [5, 0, 1],
  ] as const) {
    assert.equal(clampScenePage(page, pages), expected, `página ${page} con ${pages} páginas`)
  }
  // El recorte del helper replica la corrección del listado ante una página fuera de rango.
  const orderedIds = Array.from({ length: 97 }, (_, index) => sceneId(index))
  assert.deepEqual(bookIdsForPage(orderedIds, 99, 48), sceneBookIds(orderedIds, clampScenePage(99, scenePageCount(97))))
})

test("la URL de la escena se lee y se construye sin parámetros ajenos", () => {
  assert.deepEqual(parseShelfSceneParams(queryOf(`/shelves/3d?shelf=${SHELF_ID}&page=2`)), { shelf: SHELF_ID, page: 2 })
  assert.deepEqual(parseShelfSceneParams(queryOf("/shelves/3d")), { shelf: null, page: 1 })
  for (const query of ["shelf=all&page=2", "page=0", "page=abc", "page=-4", "shelf=no-es-un-uuid"]) {
    const parsed = parseShelfSceneParams(queryOf(`/shelves/3d?${query}`))
    assert.ok(parsed.shelf === null || parsed.page >= 1, query)
  }
  assert.equal(parseShelfSceneParams(queryOf("/shelves/3d?page=999999")).page, SCENE_PAGE_MAX)

  assert.equal(buildShelf3dPath(null, 1), "/shelves/3d")
  assert.equal(buildShelf3dPath(SHELF_ID, 1), `/shelves/3d?shelf=${SHELF_ID}`)
  assert.equal(buildShelf3dPath(SHELF_ID, 3), `/shelves/3d?shelf=${SHELF_ID}&page=3`)
  assert.equal(buildShelf3dPath(null, 3), "/shelves/3d?page=3")
  assert.deepEqual(parseShelfSceneParams(queryOf(buildShelf3dPath(SHELF_ID, 3))), { shelf: SHELF_ID, page: 3 })
})

test("el enlace a la colección 2D conserva estantería, página y tamaño de página", () => {
  assert.equal(buildShelfCollectionHref(SHELF_ID, 1), `/books?shelf=${SHELF_ID}&pageSize=48`)
  assert.equal(buildShelfCollectionHref(SHELF_ID, 3), `/books?shelf=${SHELF_ID}&page=3&pageSize=48`)

  for (const page of [1, 3]) {
    const params = queryOf(buildShelfCollectionHref(SHELF_ID, page))
    assert.deepEqual(parseBookSearchFilters(params), { q: "", status: "all", shelf: SHELF_ID, sort: "title", page, view: "table", pageSize: 48 })
    const pageSize = Number.parseInt(params.get("pageSize") ?? "", 10)
    assert.ok(pageSize >= 10 && pageSize <= 100, "el catálogo 2D admite este tamaño de página")
  }
})

test("la página 3D y el filtro 2D seleccionan exactamente los mismos ids", () => {
  // Simula el orden del servidor para esa estantería (título asc, id asc) con 97 libros.
  const orderedIds = Array.from({ length: 97 }, (_, index) => sceneId(index))

  for (const page of [1, 2, 3]) {
    const sceneIds = sceneBookIds(orderedIds, page)
    const collection = queryOf(buildShelfCollectionHref(SHELF_ID, page))
    const filters = parseBookSearchFilters(collection)
    const pageSize = Number.parseInt(collection.get("pageSize") ?? "", 10)

    assert.equal(filters.shelf, SHELF_ID)
    assert.equal(filters.page, page)
    assert.equal(filters.sort, "title")
    assert.equal(pageSize, SCENE_BOOKS_PER_PAGE)
    assert.deepEqual({ ...filters, pageSize }, { ...sceneListRequest(SHELF_ID, page), view: "table" })
    assert.deepEqual(bookIdsForPage(orderedIds, filters.page, pageSize), sceneIds)
    assert.deepEqual(sceneIds, orderedIds.slice((page - 1) * 48, page * 48))
    assert.equal(sceneIds.length, page < 3 ? 48 : 1)
  }

  // Sin solapes y con cobertura total: la unión de las páginas reconstruye la estantería.
  assert.deepEqual([1, 2, 3].flatMap((page) => sceneBookIds(orderedIds, page)), orderedIds)
})

function sceneBook(index: number, pages: number, title = `Libro ${String(index).padStart(2, "0")}`) {
  return { id: sceneId(index), title, number_of_pages: pages }
}

test("el grosor sale de las páginas y queda acotado", () => {
  for (const pages of [-5, 0, 1, 100, 300, 855, 1376, 100_000, Number.NaN]) {
    const thickness = spineThicknessFor(pages)
    assert.ok(thickness >= SCENE_SPINE_MIN_THICKNESS && thickness <= SCENE_SPINE_MAX_THICKNESS, `${pages} páginas → ${thickness}px`)
    assert.equal(thickness, Math.round(thickness))
  }
  assert.equal(SCENE_SPINE_MIN_THICKNESS, 24, "el lomo más fino sigue siendo un objetivo táctil de 24 px")
  assert.equal(spineThicknessFor(0), SCENE_SPINE_MIN_THICKNESS)
  assert.equal(spineThicknessFor(100_000), SCENE_SPINE_MAX_THICKNESS)
  assert.ok(spineThicknessFor(1100) > spineThicknessFor(700))
})

test("altura, color y tipo de lomo son estables por libro y acotados", () => {
  const ids = Array.from({ length: 200 }, (_, index) => sceneId(index))
  for (const id of ids) {
    const height = spineHeightFor(id)
    assert.ok(height >= SCENE_SPINE_MIN_HEIGHT && height <= SCENE_SPINE_MAX_HEIGHT, `${id} → ${height}px`)
    assert.equal(spineHeightFor(id), height, "la misma ficha da la misma altura")
    assert.equal(spineColorFor(id), spineColorFor(id))
    assert.ok(SCENE_SPINE_COLORS.includes(spineColorFor(id)))
    assert.ok(SCENE_SPINE_STYLES.includes(spineStyleFor(id)))
  }
  // La altura cabe bajo la balda superior (232 px entre baldas, 18 de canto) aunque el libro asome 6 px.
  assert.ok(SCENE_SPINE_MAX_HEIGHT + 6 <= 232 - 18)
  // Hay variedad real: varias alturas, todos los colores y los tres tipos de lomo.
  assert.ok(new Set(ids.map(spineHeightFor)).size > 20)
  assert.equal(new Set(ids.map(spineColorFor)).size, SCENE_SPINE_COLORS.length)
  assert.equal(new Set(ids.map(spineStyleFor)).size, SCENE_SPINE_STYLES.length)
  assert.equal(sceneBookHash("abc"), sceneBookHash("abc"))
  assert.notEqual(sceneBookHash(sceneId(1)), sceneBookHash(sceneId(2)))
})

test("las baldas se llenan por grosor real y el último libro se inclina en su hueco", () => {
  const rowWidth = 700
  const books = Array.from({ length: 48 }, (_, index) => sceneBook(index, 200 + index * 40))
  const rows = layoutSceneShelves(books, rowWidth)

  assert.deepEqual(rows.flatMap((row) => row.books.map(({ book }) => book.id)), books.map((book) => book.id), "conserva el orden del servidor")
  for (const row of rows) {
    const used = row.books.reduce((total, { spine }) => total + spine.thickness + SCENE_SPINE_GAP, 0)
    assert.ok(used + SCENE_LEAN_GAP <= rowWidth, `la balda ocupa ${used} + ${SCENE_LEAN_GAP} px de ${rowWidth}`)
    assert.deepEqual(row.books.map(({ spine }) => spine.leaning), row.books.map((_, index) => row.books.length > 1 && index === row.books.length - 1))
    for (const { book, spine } of row.books) {
      assert.equal(spine.thickness, spineThicknessFor(book.number_of_pages))
      assert.equal(spine.height, spineHeightFor(book.id))
      assert.equal(spine.color, spineColorFor(book.id))
      assert.equal(spine.ink, spineForeground(spine.color))
    }
  }
  // Cada balda (menos la última) está llena: el siguiente libro no cabría.
  for (let index = 0; index < rows.length - 1; index++) {
    const used = rows[index].books.reduce((total, { spine }) => total + spine.thickness + SCENE_SPINE_GAP, 0)
    const next = rows[index + 1].books[0].spine.thickness + SCENE_SPINE_GAP
    assert.ok(used + next + SCENE_LEAN_GAP > rowWidth)
  }
  // Un mueble estrecho (móvil) reparte la misma página en más baldas.
  assert.ok(layoutSceneShelves(books, 180).length > rows.length)

  // Una balda con un solo libro lo deja de pie; nunca más de 48 libros; sin libros no hay baldas.
  assert.deepEqual(layoutSceneShelves([sceneBook(1, 300)], rowWidth)[0].books.map(({ spine }) => spine.leaning), [false])
  const extra = Array.from({ length: 60 }, (_, index) => sceneBook(index, 300))
  assert.equal(layoutSceneShelves(extra, rowWidth).flatMap((row) => row.books).length, SCENE_BOOKS_PER_PAGE)
  assert.deepEqual(layoutSceneShelves([], rowWidth), [])
})

test("cada balda se nombra por posición y tramo alfabético", () => {
  assert.equal(sceneTitleInitial("¿Quién mató a Palomino Molero?"), "Q")
  assert.equal(sceneTitleInitial("«Ébano»"), "E")
  assert.equal(sceneTitleInitial("ñandúes"), "Ñ")
  assert.equal(sceneTitleInitial("1984"), "1")
  assert.equal(sceneTitleInitial("…"), "#")

  const rows = layoutSceneShelves([sceneBook(1, 300, "Ana Karénina"), sceneBook(2, 300, "Cumbres borrascosas")], 700)
  assert.deepEqual([rows[0].from, rows[0].to], ["A", "C"])
  assert.equal(sceneRowLabel(0, 3, rows[0]), "Balda 1 de 3, títulos de A a C")
  assert.equal(sceneRowLabel(2, 3, { from: "M", to: "M" }), "Balda 3 de 3, títulos por M")
})

test("cada lomo tiene un nombre accesible con título, autoría y estado", () => {
  assert.equal(
    spineAccessibleName({ title: "Cien años de soledad", authors: [{ name: "Gabriel García Márquez" }, { name: "Otro" }], status: "read" }),
    "Cien años de soledad, de Gabriel García Márquez. Leído.",
  )
  assert.equal(spineAccessibleName({ title: "Sin autoría", authors: [], status: "to-read" }), "Sin autoría. Por leer.")
  assert.equal(spineAccessibleName({ title: "Autor vacío", authors: [{ name: "   " }], status: "reading" }), "Autor vacío. Leyendo.")
  assert.equal(spineAccessibleName({ title: "Pendiente", authors: [{ name: "Ana" }], status: "unread" }), "Pendiente, de Ana. Sin leer.")
  assert.deepEqual(Object.keys(SCENE_STATUS_LABELS).sort(), ["read", "reading", "to-read", "unread"])
})

test("la portada genérica no cuenta como portada propia y cae a la tapa tipográfica", () => {
  assert.equal(sceneCoverSource({ small: DEFAULT_BOOK_COVER, medium: DEFAULT_BOOK_COVER, large: DEFAULT_BOOK_COVER }), null)
  assert.equal(sceneCoverSource({}), null)
  assert.equal(sceneCoverSource(null), null)
  assert.equal(sceneCoverSource({ small: "data:text/html;base64,xxx" }), null)
  assert.equal(sceneCoverSource({ small: DEFAULT_BOOK_COVER, medium: "https://covers.example.org/m.jpg" }), "https://covers.example.org/m.jpg")
  assert.equal(sceneCoverSource({ small: "/portadas/propia.webp" }), "/portadas/propia.webp")
  // Por defecto, miniatura primero; el libro sacado pide la mediana y nunca empieza por la grande.
  const cover = { small: "https://covers.example.org/s.jpg", medium: "https://covers.example.org/m.jpg", large: "https://covers.example.org/l.jpg" }
  assert.equal(sceneCoverSource(cover), cover.small)
  assert.equal(sceneCoverSource(cover, ["medium", "small", "large"]), cover.medium)
  assert.equal(sceneCoverSource({ large: cover.large }, ["medium", "small", "large"]), cover.large)
})

test("la tinta del lomo mantiene contraste sobre toda la paleta de telas", () => {
  assert.equal(relativeLuminance("#FFFFFF"), 1)
  assert.equal(relativeLuminance("#000000"), 0)
  assert.ok(Math.abs(contrastRatio("#FFFFFF", "#000000") - 21) < 1e-9)

  for (const color of SCENE_SPINE_COLORS) {
    const foreground = spineForeground(color)
    assert.ok([SPINE_LIGHT_INK, SPINE_DARK_INK].includes(foreground))
    assert.ok(contrastRatio(color, foreground) >= 4.5, `${color} con ${foreground} no alcanza 4,5:1`)
  }
  // Telas claras (pergamino) llevan tinta sepia; las oscuras, oro viejo.
  assert.equal(spineForeground("#e8dcc4"), SPINE_DARK_INK)
  assert.equal(spineForeground("#7a1f24"), SPINE_LIGHT_INK)
})

test("«Abrir ficha» enlaza con retorno contextual validado al lomo, como el catálogo 2D", () => {
  const returnPath = `${buildShelf3dPath(SHELF_ID, 2)}#${bookRowAnchor(BOOK_ID)}`
  const href = buildBookDetailHref(BOOK_ID, returnPath)

  const recovered = resolveBookReturnPath(queryOf(href).get(BOOK_RETURN_PARAM))
  assert.equal(recovered, returnPath)
  const [recoveredPath, recoveredHash] = recovered.split("#")
  assert.deepEqual(parseShelfSceneParams(queryOf(recoveredPath)), { shelf: SHELF_ID, page: 2 })
  assert.equal(recoveredHash, bookRowAnchor(BOOK_ID))

  // Un retorno externo o inválido no llega a la ficha con parámetros ajenos.
  assert.equal(buildBookDetailHref(BOOK_ID, "https://example.com"), `/book/${BOOK_ID}`)
  assert.equal(buildBookDetailHref(BOOK_ID, `${buildShelf3dPath(SHELF_ID, 1)}#otro-fragmento`), `/book/${BOOK_ID}?from=${encodeURIComponent(`/shelves/3d?shelf=${SHELF_ID}`)}`)
})
