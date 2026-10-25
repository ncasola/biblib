import { scaleIsbn } from "./dataset.mjs"

// Consultas principales de la aplicación, con la forma exacta que emite Drizzle (capturada de
// pg_stat_statements en un build real; ver `docs/validacion/rendimiento/2026-10-23/consultas-reales.md`),
// con valores literales para poder ejecutar EXPLAIN. Solo valores sintéticos de la cuenta de escala.
// Cada una indica la acción y la pantalla de origen y si lleva LIMIT en la aplicación.

const uuid = (value) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new RangeError("UUID no válido para una consulta de medición.")
  return `'${value}'`
}

// Desde U-DAT-06 (0011) `books` es la vista plana ejemplar + edición; la app selecciona todas sus columnas.
const VIEW_COLUMNS = ["id", "version", "user_id", "isbn", "title", "subtitle", "authors", "publishers", "catalogue", "number_of_pages", "publish_date", "cover_small", "cover_medium", "cover_large", "status", "shelf_id", "cover_asset_id", "created_at", "updated_at",
  "edition_id", "copy_version", "edition_version", "isbn13", "legacy_identifier", "edition_verification", "work_id", "work_title", "language", "identifiers", "search_text", "edition_copies"]
const COLUMNS = `${VIEW_COLUMNS.map((column) => `"biblib"."books"."${column}"`).join(", ")}, "biblib"."shelves"."title"`
const JOIN = (user) => `from "biblib"."books" inner join "biblib"."shelves" on ("biblib"."books"."shelf_id" = "biblib"."shelves"."id" and "biblib"."shelves"."user_id" = ${user})`
// Tarea T5: el texto de búsqueda es la columna generada de la edición; el identificador legacy, del ejemplar.
const SEARCH_EXPR = `"biblib"."books"."search_text"`
const search = (pattern) => `(${SEARCH_EXPR} like '${pattern}' or lower(coalesce("biblib"."books"."legacy_identifier", '')) like '${pattern}')`

export { SEARCH_EXPR }

/**
 * @param {{ userId: string, shelfId: string, bookId: string, scale: number }} p
 * @returns {{ id: string, accion: string, pantalla: string, limite: boolean, sql: string }[]}
 */
export function mainQueries({ userId, shelfId, bookId, scale }) {
  const u = uuid(userId)
  const s = uuid(shelfId)
  const lastPageOffset = Math.max(0, Math.ceil(scale / 10) - 1) * 10
  return [
    { id: "resumen.totales", accion: "getLibrarySummaryAction", pantalla: "Inicio", limite: false,
      sql: `select count(*), count(*) filter (where "status" = 'read')::int, count(*) filter (where "status" = 'reading')::int, count(*) filter (where "status" = 'to-read')::int, count(*) filter (where "status" = 'unread')::int from "biblib"."books" where "biblib"."books"."user_id" = ${u}` },
    { id: "resumen.recientes", accion: "getLibrarySummaryAction", pantalla: "Inicio", limite: true,
      sql: `select ${COLUMNS} ${JOIN(u)} where "biblib"."books"."user_id" = ${u} order by "biblib"."books"."created_at" desc, "biblib"."books"."id" desc limit 5` },
    { id: "resumen.leyendo", accion: "getLibrarySummaryAction", pantalla: "Inicio", limite: true,
      sql: `select ${COLUMNS} ${JOIN(u)} where ("biblib"."books"."user_id" = ${u} and "biblib"."books"."status" = 'reading') order by "biblib"."books"."updated_at" desc, "biblib"."books"."id" asc limit 5` },
    { id: "listado.recuento", accion: "listBooksAction", pantalla: "Colección", limite: false,
      sql: `select count(*) from "biblib"."books" where "biblib"."books"."user_id" = ${u}` },
    { id: "listado.pagina-1", accion: "listBooksAction", pantalla: "Colección", limite: true,
      sql: `select ${COLUMNS} ${JOIN(u)} where "biblib"."books"."user_id" = ${u} order by "biblib"."books"."title" asc, "biblib"."books"."id" asc limit 10 offset 0` },
    { id: "listado.ultima-pagina", accion: "listBooksAction", pantalla: "Colección", limite: true,
      sql: `select ${COLUMNS} ${JOIN(u)} where "biblib"."books"."user_id" = ${u} order by "biblib"."books"."title" asc, "biblib"."books"."id" asc limit 10 offset ${lastPageOffset}` },
    { id: "filtrado.recuento", accion: "listBooksAction", pantalla: "Colección filtrada", limite: false,
      sql: `select count(*) from "biblib"."books" where ("biblib"."books"."user_id" = ${u} and "biblib"."books"."status" = 'read' and "biblib"."books"."shelf_id" = ${s})` },
    { id: "filtrado.pagina", accion: "listBooksAction", pantalla: "Colección filtrada", limite: true,
      sql: `select ${COLUMNS} ${JOIN(u)} where ("biblib"."books"."user_id" = ${u} and "biblib"."books"."status" = 'read' and "biblib"."books"."shelf_id" = ${s}) order by "biblib"."books"."number_of_pages" desc, "biblib"."books"."id" asc limit 10 offset 0` },
    { id: "orden.autor", accion: "listBooksAction", pantalla: "Colección ordenada", limite: true,
      sql: `select ${COLUMNS} ${JOIN(u)} where "biblib"."books"."user_id" = ${u} order by "biblib"."books"."authors"->0->>'name' asc, "biblib"."books"."id" asc limit 10 offset 0` },
    { id: "orden.fecha", accion: "listBooksAction", pantalla: "Colección ordenada", limite: true,
      sql: `select ${COLUMNS} ${JOIN(u)} where "biblib"."books"."user_id" = ${u} order by coalesce(substring("biblib"."books"."publish_date" from '[0-9]{4}'), '0000') desc, "biblib"."books"."id" asc limit 10 offset 0` },
    { id: "busqueda.recuento", accion: "listBooksAction", pantalla: "Búsqueda local", limite: false,
      sql: `select count(*) from "biblib"."books" where ("biblib"."books"."user_id" = ${u} and ${search("%faro%")})` },
    { id: "busqueda.pagina", accion: "listBooksAction", pantalla: "Búsqueda local", limite: true,
      sql: `select ${COLUMNS} ${JOIN(u)} where ("biblib"."books"."user_id" = ${u} and ${search("%faro%")}) order by "biblib"."books"."title" asc, "biblib"."books"."id" asc limit 10 offset 0` },
    { id: "busqueda.isbn", accion: "listBooksAction", pantalla: "Búsqueda local", limite: true,
      sql: `select ${COLUMNS} ${JOIN(u)} where ("biblib"."books"."user_id" = ${u} and ${search("%9790000%")}) order by "biblib"."books"."title" asc, "biblib"."books"."id" asc limit 10 offset 0` },
    { id: "busqueda.isbn-exacto", accion: "listBooksAction", pantalla: "Búsqueda local", limite: true,
      sql: `select ${COLUMNS} ${JOIN(u)} where ("biblib"."books"."user_id" = ${u} and ${search(`%${scaleIsbn(7)}%`)}) order by "biblib"."books"."title" asc, "biblib"."books"."id" asc limit 10 offset 0` },
    { id: "detalle", accion: "getBookDetailAction", pantalla: "Ficha", limite: true,
      sql: `select ${COLUMNS} ${JOIN(u)} where ("biblib"."books"."id" = ${uuid(bookId)} and "biblib"."books"."user_id" = ${u}) limit 1` },
    { id: "estanterias", accion: "getShelvesAction", pantalla: "Estanterías / filtros / 3D", limite: false,
      sql: `select "biblib"."shelves"."id", "biblib"."shelves"."title", "biblib"."shelves"."is_default", count("biblib"."copies"."id")::int from "biblib"."shelves" left join "biblib"."copies" on ("biblib"."copies"."shelf_id" = "biblib"."shelves"."id" and "biblib"."copies"."user_id" = ${u}) where "biblib"."shelves"."user_id" = ${u} group by "biblib"."shelves"."id" order by "biblib"."shelves"."created_at" asc, "biblib"."shelves"."id" asc` },
    { id: "3d.pagina", accion: "listBooksAction", pantalla: "Estantería 3D (48)", limite: true,
      sql: `select ${COLUMNS} ${JOIN(u)} where ("biblib"."books"."user_id" = ${u} and "biblib"."books"."shelf_id" = ${s}) order by "biblib"."books"."title" asc, "biblib"."books"."id" asc limit 48 offset 48` },
    { id: "exportacion.todo", accion: "prepareLibraryExportAction / descarga de partes (servidor)", pantalla: "Ajustes (exportación por partes)", limite: false,
      sql: `select ${COLUMNS} ${JOIN(u)} where "biblib"."books"."user_id" = ${u} order by "biblib"."books"."title" asc, "biblib"."books"."id" asc` },
    // Tarea T7: igualdad indexada por (dueño, ISBN-13) en lugar de leer todos los ISBN de la cuenta.
    { id: "isbn.igualdad", accion: "getBookByIsbnAction / alta", pantalla: "Añadir libro", limite: true,
      sql: `select ${COLUMNS} ${JOIN(u)} where ("biblib"."books"."user_id" = ${u} and "biblib"."books"."isbn13" = '${scaleIsbn(7)}') order by "biblib"."books"."created_at" asc, "biblib"."books"."id" asc limit 1` },
    { id: "importacion.instantanea", accion: "prepareImportAction / confirmImportAction", pantalla: "Ajustes (importación)", limite: false,
      sql: `select "id", "isbn", "edition_id", "work_id" from "biblib"."books" where "biblib"."books"."user_id" = ${u} order by "biblib"."books"."id" asc` },
  ]
}
