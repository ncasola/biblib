// Ensayo de respaldo U-DAT-02: crea (create) o retira (remove) una versión anterior de A en scratch
// mediante el protocolo (operación + captura en la misma transacción). Solo imprime cantidades.
import { pathToFileURL } from "node:url"
const [repo, action] = process.argv.slice(2)
const load = (rel) => import(pathToFileURL(`${repo}/${rel}`).href)
const { resolveSeedTarget, loadCensus } = await load("scripts/db/seed-local.mjs")
const { readFixtureStore } = await load("scripts/db/fixture-store.mjs")
const { connect, closeConnection } = await load("scripts/db/target.mjs")
const resolved = await resolveSeedTarget("scratch")
const store = readFixtureStore(resolved, loadCensus())
const a = store.accounts.a.id
const sql = connect(resolved, { applicationName: "biblib-dat02-ensayo" })
const KEY = "dat02-ensayo-respaldo-0001"
try {
  if (action === "create") {
    await sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: a, role: "authenticated" })}, true), set_config('request.jwt.claim.sub', ${a}, true)`
      await tx`set local role authenticated`
      const [operation] = await tx`insert into biblib.library_operations (user_id, operation, idempotency_key, input_digest, status, result)
        values (${a}, 'import.confirm', ${KEY}, ${"e".repeat(64)}, 'committed', '{}'::jsonb) returning id`
      await tx`select biblib.library_snapshot_capture(${operation.id}, 'import.replace')`
    })
  } else if (action === "remove") {
    await sql`delete from biblib.library_snapshots where user_id = ${a} and source_operation_id in (select id from biblib.library_operations where user_id = ${a} and idempotency_key = ${KEY})`
    await sql`delete from biblib.library_operations where user_id = ${a} and idempotency_key = ${KEY}`
  }
  const [row] = await sql`select count(*)::int as snapshots, coalesce(sum((counts->>'chunks')::int), 0)::int as chunks, coalesce(sum((counts->>'books')::int), 0)::int as books from biblib.library_snapshots`
  console.log(`Versiones anteriores en scratch: ${row.snapshots} (trozos ${row.chunks}, libros capturados ${row.books}).`)
} finally { await closeConnection(sql) }
