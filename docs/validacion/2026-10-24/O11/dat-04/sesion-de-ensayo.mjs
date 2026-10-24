// Ensayo de respaldo U-DAT-04: crea (create) o retira (remove) una restauración por partes a medias
// de A en scratch (sesión con su manifest y los trozos de una parte sintética), con las funciones
// reales de lib/import-staging.ts compiladas por tsconfig.tests.json. Solo imprime cantidades.
// Uso: node sesion-de-ensayo.mjs <repo> create|remove|count
import { createHash, randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"

const [repo, action] = process.argv.slice(2)
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href)
const require = createRequire(path.join(repo, "package.json"))
const { resolveSeedTarget, loadCensus } = await load("scripts/db/seed-local.mjs")
const { readFixtureStore } = await load("scripts/db/fixture-store.mjs")
const { connect, closeConnection } = await load("scripts/db/target.mjs")
const resolved = await resolveSeedTarget("scratch")
const a = readFixtureStore(resolved, loadCensus()).accounts.a.id
const sql = connect(resolved, { applicationName: "biblib-dat04-ensayo" })
const EXPORT_SET = "11111111-2222-4333-8444-000000000004"
const sha256 = (data) => createHash("sha256").update(data).digest("hex")
try {
  if (action === "create") {
    const build = path.join(repo, ".next", "tests", "lib")
    const staging = require(path.join(build, "import-staging.js"))
    const exporter = require(path.join(build, "library-export.js"))
    const { drizzle } = require("drizzle-orm/postgres-js")
    const { sql: q } = require("drizzle-orm")
    const db = drizzle(sql, { schema: require(path.join(build, "db", "schema.js")) })
    const asOwner = (work) => db.transaction(async (tx) => {
      await tx.execute(q`select set_config('request.jwt.claims', ${JSON.stringify({ sub: a, role: "authenticated" })}, true), set_config('request.jwt.claim.sub', ${a}, true)`)
      await tx.execute(q`set local role authenticated`)
      return work(tx)
    })
    const shelf = { id: randomUUID(), title: "Ensayo DAT-04", book_count: 0, isDefault: true }
    const books = Array.from({ length: 600 }, (_, index) => ({ id: randomUUID(), isbn: `manual-ensayo-${index}`, title: `Ensayo ${index}`, authors: [], number_of_pages: 1, publish_date: "",
      cover: { small: "/default-book-cover.webp", medium: "/default-book-cover.webp", large: "/default-book-cover.webp" }, status: "unread", shelf_id: shelf.id, shelf_name: "" }))
    const set = exporter.buildBackupSet({ shelves: [shelf], books }, { exportedAt: new Date(), exportSetId: EXPORT_SET, sha256 })
    const bytes = Buffer.from(set.files[0].text, "utf8")
    const view = await asOwner((tx) => staging.beginSession(tx, a, { kind: "manifest", manifest: JSON.parse(set.manifestText) }))
    const part = view.parts[0]
    for (let ordinal = 0; ordinal < part.totalChunks; ordinal++) {
      const chunk = bytes.subarray(ordinal * 262_144, (ordinal + 1) * 262_144)
      await asOwner((tx) => staging.putChunk(tx, a, { sessionId: view.sessionId, partId: part.partId, ordinal, total: part.totalChunks, sha256: sha256(chunk), bytes: chunk }))
    }
  } else if (action === "remove") {
    await sql`delete from biblib.import_sessions where user_id = ${a} and export_set_id = ${EXPORT_SET}`
  }
  const [row] = await sql`select count(*)::int as sessions, (select count(*)::int from biblib.import_session_chunks) as chunks, coalesce(sum(received_bytes), 0)::int as bytes from biblib.import_sessions`
  console.log(`Restauraciones por partes en scratch: ${row.sessions} (trozos ${row.chunks}, ${row.bytes} bytes recibidos).`)
} finally { await closeConnection(sql) }
