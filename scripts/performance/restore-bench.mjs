import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { pathToFileURL } from "node:url"
import { BiblibError, EXIT } from "../lib/exit-codes.mjs"
import { REPO_ROOT } from "../lib/profiles.mjs"
import { acquireLock } from "../lib/state.mjs"
import { loadCensus, resolveSeedTarget } from "../db/seed-local.mjs"
import { readFixtureStore } from "../db/fixture-store.mjs"
import { closeConnection, connect } from "../db/target.mjs"

// pnpm perf:restore — U-DAT-04. Mide la restauración por partes contra el Postgres real del perfil
// (índices, triggers y RLS como `authenticated`) con 100, 1000 y 10 000 libros sintéticos:
// subida a staging, validación, preparación y la transacción final de publicación, con la colección
// actual pequeña (fixture de A) y llena (tantos libros como la copia). La publicación se mide dentro
// de una transacción que se revierte: la biblioteca ficticia de A no cambia. Solo registra tiempos,
// cantidades y bytes; ningún título, ISBN ni identificador.
//
// Contrato: perf:restore [--profile scratch|test] [--scale 100|1000|10000]... [--repeat 1-5] [--out <archivo>]
// Salidas: 0 mide, 2 argumentos, 3 perfil ajeno, 10 faltan fixtures, 11 fallo durante la medición.

const SCALES = [100, 1000, 10000]
const fail = (code, phase, message) => { throw new BiblibError(code, phase, message) }
const sha256 = (data) => createHash("sha256").update(data).digest("hex")
const round = (ms) => Math.round(ms * 10) / 10
const stats = (values) => { const sorted = [...values].sort((x, y) => x - y); return { n: sorted.length, p50: round(sorted[Math.floor((sorted.length - 1) / 2)]), max: round(sorted.at(-1)) } }

export function parseArgs(argv) {
  const parsed = { profile: "scratch", scales: [], repeat: 3, out: null }
  const usage = () => fail(EXIT.INVALID_ARGS, "argumentos", "Uso: perf:restore [--profile scratch|test] [--scale 100|1000|10000]... [--repeat 1-5] [--out <archivo>].")
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]]
    if (flag === "--profile" && ["scratch", "test"].includes(value)) { parsed.profile = value; i++ }
    else if (flag === "--scale" && SCALES.map(String).includes(value)) { if (!parsed.scales.includes(Number(value))) parsed.scales.push(Number(value)); i++ }
    else if (flag === "--repeat" && /^[1-5]$/.test(value ?? "")) { parsed.repeat = Number(value); i++ }
    else if (flag === "--out" && value && !value.startsWith("--")) { parsed.out = value; i++ }
    else usage()
  }
  if (!parsed.scales.length) parsed.scales = [...SCALES]
  parsed.scales.sort((x, y) => x - y)
  return parsed
}

function compiledModules() {
  execFileSync(process.execPath, [path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.tests.json"], { cwd: REPO_ROOT, stdio: "ignore", windowsHide: true })
  const require = createRequire(import.meta.url)
  const build = path.join(REPO_ROOT, ".next", "tests", "lib")
  return { require, staging: require(path.join(build, "import-staging.js")), exporter: require(path.join(build, "library-export.js")), schema: require(path.join(build, "db", "schema.js")) }
}

/** Biblioteca sintética: libros repartidos en 20 estanterías, con identificadores manuales. */
function dataset(size, tag) {
  const shelves = [{ id: randomUUID(), title: `Bench ${tag} predeterminada`, book_count: 0, isDefault: true },
    ...Array.from({ length: 19 }, (_, index) => ({ id: randomUUID(), title: `Bench ${tag} estante ${index + 1}`, book_count: 0 }))]
  const books = Array.from({ length: size }, (_, index) => ({
    id: randomUUID(), isbn: `manual-bench-${tag}-${index}`, title: `Bench ${tag} ${String(index).padStart(5, "0")}`, authors: [{ name: "Autoría sintética" }],
    number_of_pages: index % 900, publish_date: "2026", cover: { small: "/default-book-cover.webp", medium: "/default-book-cover.webp", large: "/default-book-cover.webp" },
    status: ["read", "reading", "unread", "to-read"][index % 4], shelf_id: shelves[index % shelves.length].id, shelf_name: "",
    catalogue: { source: "import", isbnVerified: false },
  }))
  return { shelves, books }
}

class Rollback extends Error {}

export async function main(argv = process.argv.slice(2), out = process.stdout) {
  let release, sql
  try {
    const options = parseArgs(argv)
    if (process.env.BIBLIB_TARGET && process.env.BIBLIB_TARGET !== "local") fail(EXIT.IDENTITY_MISMATCH, "objetivo", "perf:restore solo admite BIBLIB_TARGET=local.")
    const resolved = await resolveSeedTarget(options.profile)
    const store = readFixtureStore(resolved, loadCensus())
    const owner = store?.accounts?.a?.id
    if (!owner) fail(EXIT.SEED_FAILED, "fixtures", `Faltan fixtures A/B; ejecuta pnpm db:seed:local --profile ${options.profile}.`)
    release = acquireLock(resolved.stack)
    const modules = compiledModules()
    const { drizzle } = modules.require("drizzle-orm/postgres-js")
    const { sql: q } = modules.require("drizzle-orm")
    sql = connect(resolved, { applicationName: "biblib-restore-bench" })
    const db = drizzle(sql, { schema: modules.schema })
    const asOwner = (work) => db.transaction(async (tx) => {
      await tx.execute(q`select set_config('request.jwt.claims', ${JSON.stringify({ sub: owner, role: "authenticated" })}, true), set_config('request.jwt.claim.sub', ${owner}, true)`)
      await tx.execute(q`set local role authenticated`)
      return work(tx)
    })
    const [{ current }] = await sql`select count(*)::int as current from biblib.books where user_id = ${owner}`
    const results = []
    for (const size of options.scales) {
      const tag = randomUUID().slice(0, 8)
      const library = dataset(size, tag)
      const set = modules.exporter.buildBackupSet(library, { exportedAt: new Date(), exportSetId: randomUUID(), sha256 })
      const bytes = set.files.map((file) => Buffer.from(file.text, "utf8"))
      let sessionId
      try {
        const begin = performance.now()
        const view = await asOwner((tx) => modules.staging.beginSession(tx, owner, { kind: "manifest", manifest: JSON.parse(set.manifestText) }))
        sessionId = view.sessionId
        let chunks = 0
        for (const part of view.parts) {
          for (let ordinal = 0; ordinal < part.totalChunks; ordinal++) {
            const chunk = bytes[part.index].subarray(ordinal * 262_144, (ordinal + 1) * 262_144)
            await asOwner((tx) => modules.staging.putChunk(tx, owner, { sessionId, partId: part.partId, ordinal, total: part.totalChunks, sha256: sha256(chunk), bytes: chunk }))
            chunks++
          }
        }
        const uploaded = performance.now()
        await modules.staging.validateSession(asOwner, owner, sessionId)
        const validated = performance.now()
        await asOwner((tx) => modules.staging.prepareSession(tx, owner, sessionId, { ttlMinutes: 30 }))
        const prepared = performance.now()
        const publication = {}
        for (const variant of ["actual-fixture", "actual-llena"]) {
          const runs = { previoMs: [], bloqueoCapturaMs: [], sustitucionMs: [], totalMs: [] }
          for (let attempt = 0; attempt < options.repeat; attempt++) {
            const timing = {}
            await asOwner(async (tx) => {
              if (variant === "actual-llena") {
                // Colección actual del mismo tamaño que la copia; se revierte con todo lo demás.
                const t = performance.now()
                const [shelf] = await tx.execute(q`select id from biblib.shelves where user_id = ${owner} and is_default`)
                await tx.execute(q`insert into biblib.books (user_id, isbn, title, shelf_id) select ${owner}::uuid, 'manual-bench-actual-' || n, 'Bench actual ' || n, ${shelf.id}::uuid from generate_series(1, ${Math.max(0, size - current)}) as n`)
                await modules.staging.prepareSession(tx, owner, sessionId, { ttlMinutes: 30 })
                timing.previo = performance.now() - t
              }
              const [session] = await tx.execute(q`select preview_id, preview_revision from biblib.import_sessions where id = ${sessionId}::uuid`)
              const start = performance.now()
              let captured, finalizing
              const outcome = await modules.staging.publishRestoreSession(tx, { userId: owner, sessionId, previewId: session.preview_id, expectedRevision: session.preview_revision, idempotencyKey: `bench-${tag}-${variant}-${attempt}` }, {
                hooks: { afterCapture: () => { captured = performance.now() }, beforeFinalize: () => { finalizing = performance.now() } },
              })
              timing.total = performance.now() - start
              timing.capture = captured - start
              timing.replace = finalizing - captured
              const [{ n }] = await tx.execute(q`select count(*)::int as n from biblib.books where user_id = ${owner}`)
              if (n !== size || outcome.replayed) throw new Error("La publicación medida no dejó la colección esperada.")
              throw new Rollback()
            }).catch((error) => { if (!(error instanceof Rollback)) throw error })
            if (timing.previo !== undefined) runs.previoMs.push(timing.previo)
            runs.bloqueoCapturaMs.push(timing.capture)
            runs.sustitucionMs.push(timing.replace)
            runs.totalMs.push(timing.total)
          }
          publication[variant] = { librosActuales: variant === "actual-llena" ? Math.max(size, current) : current, bloqueoYCapturaMs: stats(runs.bloqueoCapturaMs), sustitucionMs: stats(runs.sustitucionMs), totalMs: stats(runs.totalMs) }
        }
        const [after] = await sql`select count(*)::int as n from biblib.books where user_id = ${owner}`
        if (after.n !== current) fail(EXIT.VERIFICATION_FAILED, "medición", "La biblioteca de A cambió durante la medición.")
        const entry = {
          escala: size, partes: set.files.length, trozos: chunks, bytes: bytes.reduce((total, part) => total + part.byteLength, 0), estanterias: library.shelves.length,
          stagingMs: { subidaBd: round(uploaded - begin), validacion: round(validated - uploaded), preparacion: round(prepared - validated) },
          publicacion: publication,
          presupuesto: { lockTimeoutMs: 1000, statementTimeoutMs: 5000, totalMs: 15000, cumple: Object.values(publication).every((p) => p.totalMs.max < 15000) },
        }
        results.push(entry)
        out.write(`${String(size).padStart(5)} libros · ${entry.partes} partes · ${Math.round(entry.bytes / 1024)} KiB · validación ${entry.stagingMs.validacion} ms · preparación ${entry.stagingMs.preparacion} ms · publicación p50 ${publication["actual-fixture"].totalMs.p50} ms (actual pequeña) / ${publication["actual-llena"].totalMs.p50} ms (actual llena)\n`)
      } finally {
        if (sessionId) await sql`delete from biblib.import_sessions where id = ${sessionId}`
        await sql`delete from biblib.library_operations where user_id = ${owner} and idempotency_key like ${`bench-${tag}-%`}`
      }
    }
    const report = { schemaVersion: 1, kind: "biblib.restore-bench", profile: options.profile, repeticiones: options.repeat, medidoEn: new Date().toISOString(), librosActualesFixture: current, resultados: results }
    if (options.out) {
      mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true })
      writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`)
    }
    return EXIT.OK
  } catch (error) {
    console.error(`Error [${error instanceof BiblibError ? error.phase : "medición"}]: ${error instanceof BiblibError ? error.message : "Fallo inesperado de la medición de restauración."}`)
    return error instanceof BiblibError ? error.code : EXIT.VERIFICATION_FAILED
  } finally {
    await closeConnection(sql)
    release?.()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main()
