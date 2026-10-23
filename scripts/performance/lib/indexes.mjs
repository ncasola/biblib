import { performance } from "node:perf_hooks"
import { asUser, explainTextIn, inRolledBackTransaction, timeQueryIn } from "./explain.mjs"
import { SEARCH_EXPR } from "./queries.mjs"

// Candidatos a índice (U-QA-03). No se crea ninguna migración: cada uno se mide en una transacción de prueba
// —antes y después, con el rol `authenticated` y los claims de la cuenta de escala— y se revierte siempre.
// La migración corresponde a la siguiente ola (U-DAT-03/04), que decide con estas cifras.

export const CANDIDATES = [
  { id: "idx-titulo", propone: "books_user_title_idx",
    ddl: ['create index books_user_title_idx on biblib.books (user_id, title, id)'],
    consultas: ["listado.pagina-1", "listado.ultima-pagina", "busqueda.pagina"],
    motivo: "Ordenar por título (orden por defecto) con LIMIT: evita ordenar todas las fichas de la cuenta." },
  { id: "idx-titulo-estanteria", propone: "books_user_shelf_title_idx",
    ddl: ['create index books_user_shelf_title_idx on biblib.books (user_id, shelf_id, title, id)'],
    consultas: ["3d.pagina", "filtrado.recuento"],
    motivo: "Estantería + orden por título (vista 3D y filtro por estantería)." },
  { id: "idx-creado", propone: "books_user_created_idx",
    ddl: ['create index books_user_created_idx on biblib.books (user_id, created_at desc, id desc)'],
    consultas: ["resumen.recientes"],
    motivo: "«Añadidos recientemente» del inicio (los 5 últimos)." },
  { id: "idx-estado-actualizado", propone: "books_user_status_updated_idx",
    ddl: ['create index books_user_status_updated_idx on biblib.books (user_id, status, updated_at desc, id)'],
    consultas: ["resumen.leyendo", "resumen.totales"],
    motivo: "«Leyendo ahora» del inicio y recuentos por estado." },
  { id: "idx-estanteria", propone: "books_user_shelf_idx",
    ddl: ['create index books_user_shelf_idx on biblib.books (user_id, shelf_id)'],
    consultas: ["estanterias", "filtrado.recuento"],
    motivo: "Recuento de libros por estantería y filtro por estantería (hoy solo existe books_shelf_id_idx)." },
  { id: "idx-trigramas", propone: "books_search_trgm_idx",
    ddl: [
      "create extension if not exists pg_trgm with schema extensions",
      `create index books_search_trgm_idx on biblib.books using gin ((${SEARCH_EXPR.replaceAll('"biblib"."books".', "")}) extensions.gin_trgm_ops)`,
    ],
    consultas: ["busqueda.recuento", "busqueda.pagina", "busqueda.isbn", "busqueda.isbn-exacto"],
    motivo: "Búsqueda local `LIKE '%texto%'`: sin índice recorre todas las fichas de la cuenta." },
]

/** Antes/después de un candidato. Si el DDL falla (p. ej. función no inmutable) se informa el motivo. */
export async function measureCandidate(sql, userId, candidate, queries, options) {
  const targets = queries.filter((q) => candidate.consultas.includes(q.id))
  return inRolledBackTransaction(sql, async (tx) => {
    await asUser(tx, userId)
    const before = []
    for (const q of targets) before.push(await timeQueryIn(tx, q, options))
    await tx.unsafe("/* perf */ reset role")
    try {
      await tx.unsafe("/* perf */ savepoint antes_del_indice")
      for (const statement of candidate.ddl) await tx.unsafe(`/* perf */ ${statement}`)
    } catch (error) {
      return { id: candidate.id, propone: candidate.propone, motivo: candidate.motivo, ddl: candidate.ddl, aplicable: false, error: error instanceof Error ? error.message : "error de DDL", antes: before }
    }
    await tx.unsafe("/* perf */ analyze biblib.books")
    const [size] = await tx.unsafe(`/* perf */ select pg_relation_size('biblib.${candidate.propone}')::int as bytes`)
    const [table] = await tx.unsafe("/* perf */ select pg_relation_size('biblib.books')::int as bytes")
    await asUser(tx, userId)
    const after = []
    const plans = {}
    for (const q of targets) { after.push(await timeQueryIn(tx, q, options)); plans[q.id] = await explainTextIn(tx, q) }
    return { id: candidate.id, propone: candidate.propone, motivo: candidate.motivo, ddl: candidate.ddl, aplicable: true, tamanoIndiceBytes: size.bytes, tamanoTablaBytes: table.bytes, antes: before, despues: after, planes: plans }
  })
}

/**
 * Coste de escritura: tiempo de insertar 2000 fichas (con los triggers de versión y de revisión de colección)
 * sin el índice y con él. Cada medición va en su propia transacción, que se revierte, para no dejar basura
 * ni sesgar las lecturas. Mediana de 3 repeticiones.
 */
export async function measureWriteCost(sql, userId, ddl = []) {
  return inRolledBackTransaction(sql, async (tx) => {
    for (const statement of ddl) await tx.unsafe(`/* perf */ ${statement}`)
    const times = []
    for (let run = 0; run < 3; run++) {
      const started = performance.now()
      await tx.unsafe(`/* perf */ insert into biblib.books (user_id, isbn, title, subtitle, authors, publishers, catalogue, number_of_pages, publish_date, status, shelf_id)
        select user_id, 'wr${run}-' || row_number() over (), title, subtitle, authors, publishers, catalogue, number_of_pages, publish_date, status, shelf_id
        from biblib.books where user_id = '${userId}' limit 2000`)
      times.push(performance.now() - started)
    }
    times.sort((a, b) => a - b)
    return Math.round(times[1] * 10) / 10
  })
}
