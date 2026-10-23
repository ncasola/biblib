import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import path from "node:path"
import { REPO_ROOT } from "../../lib/profiles.mjs"
import { scaleIsbn } from "./dataset.mjs"

// Escenarios de acción (Server Actions reales) de U-QA-03. Cada uno indica la acción, sus argumentos por
// iteración (se rotan para no medir siempre la misma fila) y las iteraciones por nivel de concurrencia.
// Los argumentos reproducen los que envía la interfaz (BOOK_PAGE_SIZE = 10, escena 3D de 48, etc.).

const STANDARD = { 1: 40, 5: 20, 10: 15 }
const HEAVY = { 1: 12, 5: 3, 10: 2 }
const SEARCH_TERMS = ["faro", "jardín", "peñalver", "atlas", "isla", "viaje", "nocturno", "azul", "del norte", "Ximena"]

/** Datos de la cuenta de escala que dependen del tamaño: estantería mayor, muestra de fichas y número de páginas. */
export async function scaleFacts(sql, userId) {
  const [{ id: bigShelf }] = await sql`select shelf_id as id from biblib.books where user_id = ${userId} group by shelf_id order by count(*) desc, shelf_id limit 1`
  const [{ n: total }] = await sql`select count(*)::int as n from biblib.books where user_id = ${userId}`
  const [{ n: shelves }] = await sql`select count(*)::int as n from biblib.shelves where user_id = ${userId}`
  const ids = await sql`select id from (select id, row_number() over (order by id) as rn from biblib.books where user_id = ${userId}) t where rn % greatest(1, ${Math.floor(total / 200)}::int) = 0 order by id limit 200`
  const [{ n: inBig }] = await sql`select count(*)::int as n from biblib.books where user_id = ${userId} and shelf_id = ${bigShelf}`
  return { bigShelf, total, shelves, inBig, bookIds: ids.map((row) => row.id), lastPage: Math.max(1, Math.ceil(total / 10)), scenePages: Math.max(1, Math.ceil(inBig / 48)) }
}

const list = (overrides) => ({ q: "", status: "all", shelf: "all", sort: "title", page: 1, pageSize: 10, ...overrides })

export function actionScenarios(facts) {
  return [
    { name: "dashboard", pantalla: "Inicio", action: "getLibrarySummaryAction", args: () => [], iterations: STANDARD },
    { name: "listado-inicial", pantalla: "Colección", action: "listBooksAction", args: () => [list({})], iterations: STANDARD },
    { name: "listado-100-filas", pantalla: "Colección (página máxima)", action: "listBooksAction", args: () => [list({ pageSize: 100 })], iterations: STANDARD },
    { name: "listado-ultima-pagina", pantalla: "Colección", action: "listBooksAction", args: () => [list({ page: facts.lastPage })], iterations: STANDARD },
    { name: "filtrado-estado-estanteria", pantalla: "Colección filtrada", action: "listBooksAction", args: (i) => [list({ status: ["read", "to-read", "unread", "reading"][i % 4], shelf: facts.bigShelf, sort: "-pages" })], iterations: STANDARD },
    { name: "ordenado-autor", pantalla: "Colección ordenada", action: "listBooksAction", args: (i) => [list({ sort: i % 2 ? "-author" : "author", page: 1 + (i % 5) })], iterations: STANDARD },
    { name: "ordenado-fecha", pantalla: "Colección ordenada", action: "listBooksAction", args: (i) => [list({ sort: i % 2 ? "-date" : "date", page: 1 + (i % 5) })], iterations: STANDARD },
    { name: "busqueda-local-texto", pantalla: "Búsqueda local", action: "listBooksAction", args: (i) => [list({ q: SEARCH_TERMS[i % SEARCH_TERMS.length].normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase() })], iterations: STANDARD },
    { name: "busqueda-local-isbn", pantalla: "Búsqueda local", action: "listBooksAction", args: (i) => [list({ q: scaleIsbn(1 + ((i * 37) % Math.max(1, facts.total))) })], iterations: STANDARD },
    { name: "detalle", pantalla: "Ficha", action: "getBookDetailAction", args: (i) => [facts.bookIds[i % facts.bookIds.length]], iterations: STANDARD },
    { name: "estanterias", pantalla: "Estanterías / filtros", action: "getShelvesAction", args: () => [], iterations: STANDARD },
    { name: "estanteria-3d-pagina-48", pantalla: "Estantería 3D", action: "listBooksAction", args: (i) => [list({ shelf: facts.bigShelf, page: 1 + (i % facts.scenePages), pageSize: 48 })], iterations: STANDARD },
    { name: "exportacion-lectura-completa", pantalla: "Ajustes (carga y exportación)", action: "getLibraryDataAction", args: () => [], iterations: HEAVY },
  ]
}

/** Cargas de importación (partes ≤ 2000 fichas, como las que genera la exportación) para el preview de U-DAT-01. */
export function previewScenarios(parts) {
  const first = parts[0]
  const fresh = { ...first, books: first.books.map((book, i) => ({ ...book, id: randomUUID(), version: undefined, isbn: scaleIsbn(900_000 + i), cover: { small: `https://covers.invalid/${i}-s.jpg`, medium: `https://covers.invalid/${i}-m.jpg`, large: `https://covers.invalid/${i}-l.jpg` } })) }
  const strip = (part) => JSON.parse(JSON.stringify(part))
  // Con portada genérica, la preparación consulta Open Library aunque el modo sea fixture (hallazgo de U-QA-02 pendiente
  // de U-BIB-05). Los previews llevan portada con URL para no provocar esa salida de red: se mide el plan, no la red.
  const covered = (part) => ({ ...part, books: part.books.map((book, i) => ({ ...book, cover: { small: `https://covers.invalid/${i}-s.jpg`, medium: `https://covers.invalid/${i}-m.jpg`, large: `https://covers.invalid/${i}-l.jpg` } })) })
  return [
    { name: "preview-importacion-conservar", pantalla: "Ajustes (importación)", action: "prepareImportAction", args: () => [strip(first), "merge"], iterations: { 1: 10, 5: 2, 10: 1 }, books: first.books.length },
    { name: "preview-importacion-nuevos", pantalla: "Ajustes (importación)", action: "prepareImportAction", args: () => [strip({ ...fresh, books: fresh.books.map((book) => ({ ...book, id: randomUUID() })) }), "merge"], iterations: { 1: 10, 5: 2, 10: 1 }, books: fresh.books.length },
    { name: "preview-importacion-reemplazo", pantalla: "Ajustes (importación)", action: "prepareImportAction", args: () => [strip(covered(first)), "replace"], iterations: { 1: 10, 5: 2, 10: 1 }, books: first.books.length },
  ]
}

/** Particionado de la exportación con el código real (módulo compilado de pruebas), medido en Node. */
export function loadExportModule() {
  const require = createRequire(import.meta.url)
  return require(path.join(REPO_ROOT, ".next", "tests", "lib", "library-export.js"))
}
