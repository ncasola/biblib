import { scaleIsbn } from "./dataset.mjs"

// Consultas principales de la aplicación, con la forma exacta que emite Drizzle (capturada de
// pg_stat_statements en un build real; ver `docs/validacion/rendimiento/2026-10-23/consultas-reales.md`),
// con valores literales para poder ejecutar EXPLAIN. Solo valores sintéticos de la cuenta de escala.
// Cada una indica la acción y la pantalla de origen y si lleva LIMIT en la aplicación.

const uuid = (value) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new RangeError("UUID no válido para una consulta de medición.")
  return `'${value}'`
}

const COLUMNS = `"biblib"."books"."id", "biblib"."books"."version", "biblib"."books"."user_id", "biblib"."books"."isbn", "biblib"."books"."title", "biblib"."books"."subtitle", "biblib"."books"."authors", "biblib"."books"."publishers", "biblib"."books"."catalogue", "biblib"."books"."number_of_pages", "biblib"."books"."publish_date", "biblib"."books"."cover_small", "biblib"."books"."cover_medium", "biblib"."books"."cover_large", "biblib"."books"."status", "biblib"."books"."shelf_id", "biblib"."books"."created_at", "biblib"."books"."updated_at", "biblib"."shelves"."title"`
const JOIN = (user) => `from "biblib"."books" inner join "biblib"."shelves" on ("biblib"."books"."shelf_id" = "biblib"."shelves"."id" and "biblib"."shelves"."user_id" = ${user})`
const SEARCH_EXPR = `translate(lower("biblib"."books"."title" || ' ' || coalesce("biblib"."books"."subtitle", '') || ' ' || "biblib"."books"."authors"::text || ' ' || "biblib"."books"."isbn"), 'áéíóúüñ', 'aeiouun')`

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
      sql: `select count(*) from "biblib"."books" where ("biblib"."books"."user_id" = ${u} and ${SEARCH_EXPR} like '%faro%')` },
    { id: "busqueda.pagina", accion: "listBooksAction", pantalla: "Búsqueda local", limite: true,
      sql: `select ${COLUMNS} ${JOIN(u)} where ("biblib"."books"."user_id" = ${u} and ${SEARCH_EXPR} like '%faro%') order by "biblib"."books"."title" asc, "biblib"."books"."id" asc limit 10 offset 0` },
    { id: "busqueda.isbn", accion: "listBooksAction", pantalla: "Búsqueda local", limite: true,
      sql: `select ${COLUMNS} ${JOIN(u)} where ("biblib"."books"."user_id" = ${u} and ${SEARCH_EXPR} like '%9790000%') order by "biblib"."books"."title" asc, "biblib"."books"."id" asc limit 10 offset 0` },
    { id: "busqueda.isbn-exacto", accion: "listBooksAction", pantalla: "Búsqueda local", limite: true,
      sql: `select ${COLUMNS} ${JOIN(u)} where ("biblib"."books"."user_id" = ${u} and ${SEARCH_EXPR} like '%${scaleIsbn(7)}%') order by "biblib"."books"."title" asc, "biblib"."books"."id" asc limit 10 offset 0` },
    { id: "detalle", accion: "getBookDetailAction", pantalla: "Ficha", limite: true,
      sql: `select ${COLUMNS} ${JOIN(u)} where ("biblib"."books"."id" = ${uuid(bookId)} and "biblib"."books"."user_id" = ${u}) limit 1` },
    { id: "estanterias", accion: "getShelvesAction", pantalla: "Estanterías / filtros / 3D", limite: false,
      sql: `select "biblib"."shelves"."id", "biblib"."shelves"."title", "biblib"."shelves"."is_default", count("biblib"."books"."id")::int from "biblib"."shelves" left join "biblib"."books" on ("biblib"."books"."shelf_id" = "biblib"."shelves"."id" and "biblib"."books"."user_id" = ${u}) where "biblib"."shelves"."user_id" = ${u} group by "biblib"."shelves"."id" order by "biblib"."shelves"."created_at" asc, "biblib"."shelves"."id" asc` },
    { id: "3d.pagina", accion: "listBooksAction", pantalla: "Estantería 3D (48)", limite: true,
      sql: `select ${COLUMNS} ${JOIN(u)} where ("biblib"."books"."user_id" = ${u} and "biblib"."books"."shelf_id" = ${s}) order by "biblib"."books"."title" asc, "biblib"."books"."id" asc limit 48 offset 48` },
    { id: "exportacion.todo", accion: "getLibraryDataAction", pantalla: "Ajustes (carga y exportación)", limite: false,
      sql: `select ${COLUMNS} ${JOIN(u)} where "biblib"."books"."user_id" = ${u} order by "biblib"."books"."title" asc, "biblib"."books"."id" asc` },
    { id: "isbn.escaneo", accion: "getBookByIsbnAction / alta / edición", pantalla: "Añadir libro", limite: false,
      sql: `select "isbn" from "biblib"."books" where "biblib"."books"."user_id" = ${u}` },
    { id: "importacion.instantanea", accion: "prepareImportAction / confirmImportAction", pantalla: "Ajustes (importación)", limite: false,
      sql: `select "id", "isbn" from "biblib"."books" where "biblib"."books"."user_id" = ${u} order by "biblib"."books"."id" asc` },
  ]
}
