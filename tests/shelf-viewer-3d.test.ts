import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_BOOK_COVER } from "../lib/book-covers"
import { BOOK_RETURN_PARAM, bookRowAnchor, buildBookDetailHref, parseBookSearchFilters, resolveBookReturnPath } from "../lib/book-search"
import {
  SCENE_BOOKS_PER_PAGE,
  SCENE_BOOKS_PER_ROW,
  SCENE_PAGE_MAX,
  SCENE_SPINE_COLORS,
  SCENE_SPINE_MAX_HEIGHT,
  SCENE_SPINE_MIN_HEIGHT,
  bookIdsForPage,
  buildShelf3dPath,
  buildShelfCollectionHref,
  clampScenePage,
  parseShelfSceneParams,
  relativeLuminance,
  sceneBookIds,
  sceneCoverSource,
  sceneListRequest,
  scenePageCount,
  spineAccessibleName,
  spineForeground,
  spineHeightFor,
  splitSceneRows,
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
    assert.deepEqual(parseBookSearchFilters(params), { q: "", status: "all", shelf: SHELF_ID, sort: "title", page, view: "table" })
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

test("las alturas de lomo quedan acotadas con las páginas registradas", () => {
  for (const pages of [-5, 0, 1, 100, 300, 855, 900, 100_000]) {
    const height = spineHeightFor(pages)
    assert.ok(height >= SCENE_SPINE_MIN_HEIGHT && height <= SCENE_SPINE_MAX_HEIGHT, `${pages} páginas → ${height}px`)
  }
  assert.equal(spineHeightFor(0), SCENE_SPINE_MIN_HEIGHT)
  assert.equal(spineHeightFor(855), SCENE_SPINE_MAX_HEIGHT)
  assert.ok(spineHeightFor(300) > spineHeightFor(100))
})

test("los libros de una página se reparten en repisas fijas", () => {
  assert.equal(SCENE_BOOKS_PER_ROW, 6)
  const page = Array.from({ length: 48 }, (_, index) => sceneId(index))
  const rows = splitSceneRows(page)
  assert.equal(rows.length, 8)
  assert.ok(rows.every((row) => row.length === 6))
  assert.deepEqual(splitSceneRows(page.slice(0, 7)).map((row) => row.length), [6, 1])
  assert.deepEqual(splitSceneRows([...page, sceneId(49)]).flat(), page, "el visor recorta cualquier exceso a 48 libros")
  assert.deepEqual(splitSceneRows([]), [])
})

test("cada lomo tiene un nombre accesible con título y autoría", () => {
  assert.equal(
    spineAccessibleName({ title: "Cien años de soledad", authors: [{ name: "Gabriel García Márquez" }, { name: "Otro" }] }),
    "Cien años de soledad, de Gabriel García Márquez. Abrir la ficha del libro.",
  )
  assert.equal(spineAccessibleName({ title: "Sin autoría", authors: [] }), "Sin autoría. Abrir la ficha del libro.")
  assert.equal(spineAccessibleName({ title: "Autor vacío", authors: [{ name: "   " }] }), "Autor vacío. Abrir la ficha del libro.")
})

test("la portada genérica no cuenta como portada propia y cae al título", () => {
  assert.equal(sceneCoverSource({ small: DEFAULT_BOOK_COVER, medium: DEFAULT_BOOK_COVER, large: DEFAULT_BOOK_COVER }), null)
  assert.equal(sceneCoverSource({}), null)
  assert.equal(sceneCoverSource(null), null)
  assert.equal(sceneCoverSource({ small: "data:text/html;base64,xxx" }), null)
  assert.equal(sceneCoverSource({ small: DEFAULT_BOOK_COVER, medium: "https://covers.example.org/m.jpg" }), "https://covers.example.org/m.jpg")
  assert.equal(sceneCoverSource({ small: "/portadas/propia.webp" }), "/portadas/propia.webp")
})

test("la tinta del lomo mantiene contraste sobre toda la paleta vintage", () => {
  assert.equal(relativeLuminance("#FFFFFF"), 1)
  assert.equal(relativeLuminance("#000000"), 0)
  const yellow = relativeLuminance("#D4AF37")
  assert.ok(yellow > 0.4 && yellow < 0.5)

  const contrast = (a: string, b: string): number => {
    const first = relativeLuminance(a)
    const second = relativeLuminance(b)
    const [higher, lower] = first >= second ? [first, second] : [second, first]
    return (higher + 0.05) / (lower + 0.05)
  }

  for (const color of SCENE_SPINE_COLORS) {
    const foreground = spineForeground(color)
    assert.ok(contrast(color, foreground) >= 4.5, `${color} con ${foreground} no alcanza 4,5:1`)
  }
  // El amarillo cálido obliga a tinta oscura; el rojo principal mantiene la clara.
  assert.equal(spineForeground("#D4AF37"), "#3D2B1F")
  assert.equal(spineForeground("#DC2626"), "#FFFFFF")
  for (const color of ["#DC2626", "#6B7C3F", "#D4AF37", "#6B4E8B", "#8B6F47"]) {
    assert.ok(SCENE_SPINE_COLORS.includes(color), `la paleta conserva ${color}`)
  }
})

test("el lomo enlaza a la ficha con retorno contextual validado, como el catálogo 2D", () => {
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
