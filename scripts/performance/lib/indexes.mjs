import { performance } from "node:perf_hooks"
import { asUser, explainTextIn, inRolledBackTransaction, timeQueryIn } from "./explain.mjs"

// Candidatos a índice (U-QA-03). No se crea ninguna migración: cada uno se mide en una transacción de prueba
// —antes y después, con el rol `authenticated` y los claims de la cuenta de escala— y se revierte siempre.
// La migración corresponde a la siguiente ola (U-DAT-03/04), que decide con estas cifras.

// U-DAT-06: los índices de lectura de 0006 se trasladaron a ediciones y ejemplares (0010). Queda por evaluar la
// tarea T5: trigramas sobre la columna de búsqueda generada de la edición.
export const CANDIDATES = [
  { id: "idx-trigramas-edicion", propone: "editions_search_trgm_idx",
    ddl: [
      "create extension if not exists pg_trgm with schema extensions",
      "create index editions_search_trgm_idx on biblib.editions using gin (search_text extensions.gin_trgm_ops)",
    ],
    consultas: ["busqueda.recuento", "busqueda.pagina", "busqueda.isbn", "busqueda.isbn-exacto"],
    motivo: "Búsqueda local `LIKE '%texto%'` sobre la columna generada (T5): sin índice recorre las ediciones de la cuenta." },
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
    await tx.unsafe("/* perf */ analyze biblib.editions")
    const [size] = await tx.unsafe(`/* perf */ select pg_relation_size('biblib.${candidate.propone}')::int as bytes`)
    const [table] = await tx.unsafe("/* perf */ select pg_relation_size('biblib.editions')::int as bytes")
    await asUser(tx, userId)
    const after = []
    const plans = {}
    for (const q of targets) { after.push(await timeQueryIn(tx, q, options)); plans[q.id] = await explainTextIn(tx, q) }
    return { id: candidate.id, propone: candidate.propone, motivo: candidate.motivo, ddl: candidate.ddl, aplicable: true, tamanoIndiceBytes: size.bytes, tamanoTablaBytes: table.bytes, antes: before, despues: after, planes: plans }
  })
}

/**
 * Coste de escritura: tiempo de insertar 2000 fichas como edición + ejemplar (U-DAT-06), con los triggers de
 * versión, revisión de colección y poda
 * sin el índice y con él. Cada medición va en su propia transacción, que se revierte, para no dejar basura
 * ni sesgar las lecturas. Mediana de 3 repeticiones.
 */
export async function measureWriteCost(sql, userId, ddl = []) {
  return inRolledBackTransaction(sql, async (tx) => {
    for (const statement of ddl) await tx.unsafe(`/* perf */ ${statement}`)
    const times = []
    for (let run = 0; run < 3; run++) {
      const started = performance.now()
      await tx.unsafe(`/* perf */ create temporary table perf_write_${run} on commit drop as
        select gen_random_uuid() as edition_id, gen_random_uuid() as copy_id, e.title, e.subtitle, e.authors, e.publishers, e.catalogue, e.number_of_pages, e.publish_date, c.status, c.shelf_id
        from biblib.copies c join biblib.editions e on e.user_id = c.user_id and e.id = c.edition_id where c.user_id = '${userId}' limit 2000`)
      await tx.unsafe(`/* perf */ insert into biblib.editions (id, user_id, title, subtitle, authors, publishers, catalogue, number_of_pages, publish_date)
        select edition_id, '${userId}', title, subtitle, authors, publishers, catalogue, number_of_pages, publish_date from perf_write_${run}`)
      await tx.unsafe(`/* perf */ insert into biblib.copies (id, user_id, edition_id, status, shelf_id)
        select copy_id, '${userId}', edition_id, status, shelf_id from perf_write_${run}`)
      times.push(performance.now() - started)
    }
    times.sort((a, b) => a - b)
    return Math.round(times[1] * 10) / 10
  })
}
