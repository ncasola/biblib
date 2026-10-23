// U-DAT-02 · Tarea T8 de U-QA-03: comprueba que las consultas reales usan los índices de 0006.
// Uso (perfil scratch con 0006 aplicada): BIBLIB_TARGET=local node docs/validacion/2026-10-23/O10/dat-02/explain-indices.mjs > salida.json
// Todo ocurre en una transacción que se revierte: 10 000 fichas sintéticas para la cuenta A (2 000 en
// una estantería para la vista 3D), ANALYZE y EXPLAIN (ANALYZE, BUFFERS) como `authenticated` con los
// claims de A (RLS real), primero con los índices y después sin ellos (DROP INDEX revertido). Las
// consultas son las de scripts/performance/lib/queries.mjs (forma exacta que emite Drizzle).
import { pathToFileURL } from "node:url"
import path from "node:path"

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../../../../..")
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href)
const { resolveSeedTarget, loadCensus } = await load("scripts/db/seed-local.mjs")
const { readFixtureStore } = await load("scripts/db/fixture-store.mjs")
const { connect, closeConnection } = await load("scripts/db/target.mjs")
const { mainQueries } = await load("scripts/performance/lib/queries.mjs")
const { asUser, explainTextIn, inRolledBackTransaction, timeQueryIn } = await load("scripts/performance/lib/explain.mjs")

const SCALE = 10_000
const QUERIES = { "resumen.recientes": "books_user_created_idx", "listado.pagina-1": "books_user_title_idx", "3d.pagina": "books_user_shelf_title_idx" }
const resolved = await resolveSeedTarget("scratch")
const store = readFixtureStore(resolved, loadCensus())
const userId = store.accounts.a.id
const sql = connect(resolved, { applicationName: "biblib-dat02-explain" })

async function measure(tx, queries, label) {
  await asUser(tx, userId)
  const out = []
  for (const query of queries) {
    const timing = await timeQueryIn(tx, query, { runs: 20, warmup: 3 })
    const text = await explainTextIn(tx, query)
    out.push({ fase: label, id: query.id, pantalla: query.pantalla, indiceEsperado: QUERIES[query.id], usaIndice: timing.nodos.some((node) => node.includes(QUERIES[query.id])), nodos: timing.nodos, ejecucionMs: timing.ejecucionMs, plan: text.split("\n").slice(0, 12) })
  }
  await tx.unsafe("reset role")
  return out
}

try {
  const result = await inRolledBackTransaction(sql, async (tx) => {
    const [shelf] = await tx`select id from biblib.shelves where user_id = ${userId} and is_default`
    const [scene] = await tx`insert into biblib.shelves (user_id, title) values (${userId}, ${"[DAT-02 explain] Vista 3D"}) returning id`
    await tx`insert into biblib.books (user_id, isbn, title, status, shelf_id, created_at)
      select ${userId}, 'manual-explain-' || n, 'Título ' || md5(n::text), (array['read','reading','unread','to-read'])[1 + n % 4],
        case when n % 5 = 0 then ${scene.id}::uuid else ${shelf.id}::uuid end, now() - (n || ' minutes')::interval
      from generate_series(1, ${SCALE}) as n`
    await tx.unsafe("analyze biblib.books")
    await tx.unsafe("analyze biblib.shelves")
    const [book] = await tx`select id from biblib.books where user_id = ${userId} limit 1`
    const queries = mainQueries({ userId, shelfId: scene.id, bookId: book.id, scale: SCALE }).filter((query) => query.id in QUERIES)
    const withIndexes = await measure(tx, queries, "con índices 0006")
    await tx.unsafe("drop index biblib.books_user_title_idx, biblib.books_user_shelf_title_idx, biblib.books_user_created_idx")
    const without = await measure(tx, queries, "sin índices (retirada simulada)")
    return [...withIndexes, ...without]
  })
  console.log(JSON.stringify({ escala: SCALE, rol: "authenticated (RLS de A)", revertido: true, mediciones: result }, null, 1).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>"))
} finally { await closeConnection(sql) }
