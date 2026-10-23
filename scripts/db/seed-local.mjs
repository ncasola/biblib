import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createClient } from "@supabase/supabase-js"
import { BiblibError, EXIT } from "../lib/exit-codes.mjs"
import { REPO_ROOT } from "../lib/profiles.mjs"
import { acquireLock, readState } from "../lib/state.mjs"
import { assertOwnership, inventory, selectResources } from "../lib/docker.mjs"
import { loadJournal } from "./journal-guard.mjs"
import { acquireMigrationLock, releaseMigrationLock } from "./migrate.mjs"
import { closeConnection, connect, inspectDatabase, resolveLocal } from "./target.mjs"
import { fixtureId, readFixtureStore, writeFixtureStore } from "./fixture-store.mjs"

export const BUCKET = "biblib-test-assets"
export const ASSET = "fixtures/portada.webp"
const fail = (code, phase, message) => { throw new BiblibError(code, phase, message) }
const resultOf = (response, phase) => {
  if (response.error) fail(EXIT.SEED_FAILED, phase, `Falló la fase ${phase}; conserva el registro privado y repite db:seed:local para continuar.`)
  return response.data
}

export function parseSeedArgs(argv) {
  const parsed = { profile: process.env.BIBLIB_PROFILE || "main", json: false }
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (seen.has(flag)) fail(EXIT.INVALID_ARGS, "argumentos", "Argumento repetido.")
    seen.add(flag)
    if (flag === "--json") parsed.json = true
    else if (flag === "--profile" && ["main", "test", "scratch"].includes(argv[i + 1])) parsed.profile = argv[++i]
    else fail(EXIT.INVALID_ARGS, "argumentos", "Uso: db:seed:local [--profile main|test|scratch] [--json]. No se admiten URLs ni flags reenviados.")
  }
  return parsed
}

export function loadCensus(root = REPO_ROOT) {
  const census = JSON.parse(readFileSync(path.join(root, "tests/fixtures/census.json"), "utf8"))
  const validKey = (key) => typeof key === "string" && /^[a-z][a-z0-9-]{0,79}$/.test(key)
  const unique = (items) => new Set(items).size === items.length
  if (census.censusVersion !== 1 || !validKey(census.censusId) || census.accounts?.length !== 2 || !unique(census.accounts.map((a) => a.key))) fail(EXIT.INVALID_ARGS, "censo", "Censo de fixtures no válido.")
  for (const a of census.accounts) {
    if (!["a", "b"].includes(a.key) || a.email !== `lector-${a.key}@biblib.test` || a.user_metadata?.biblib_fixture !== census.censusId || a.shelves?.length < 3 || a.shelves?.filter((s) => s.isDefault).length !== 1 || !a.books?.length) fail(EXIT.INVALID_ARGS, "censo", "El censo debe contener solo A/B, su metadato y bibliotecas ficticias.")
    if (!unique(a.shelves.map((s) => s.fixtureKey)) || !unique(a.books.map((b) => b.fixtureKey)) || !unique(a.books.map((b) => b.isbn))) fail(EXIT.INVALID_ARGS, "censo", "Hay identificadores de fixture duplicados.")
    for (const item of [...a.shelves, ...a.books]) if (!validKey(item.fixtureKey) || typeof item.title !== "string" || !item.title.trim()) fail(EXIT.INVALID_ARGS, "censo", "Fixture sin identidad o título válido.")
    for (const b of a.books) if (!a.shelves.some((s) => s.fixtureKey === b.shelfKey) || !["read", "reading", "unread", "to-read"].includes(b.status) || !["manual", "open-library"].includes(b.source) || !Number.isInteger(b.number_of_pages) || b.number_of_pages < 0 || b.number_of_pages > 100000) fail(EXIT.INVALID_ARGS, "censo", "Libro ficticio con referencia o datos inválidos.")
  }
  return census
}

function assertLocalTarget(target) {
  if (target !== "local") fail(EXIT.IDENTITY_MISMATCH, "objetivo", "El seed solo permite BIBLIB_TARGET=local y un perfil propio acreditado; no se ha escrito ningún dato.")
}

/** Además de Postgres, acredita los servicios que recibirán escrituras HTTP. */
export async function resolveSeedTarget(profile, options) {
  const resolved = await resolveLocal(profile, options)
  const { stack } = resolved
  const state = readState(stack)
  const resources = selectResources(stack, await inventory(stack), state)
  assertOwnership(stack, resources, state)
  for (const name of ["db", "auth", "kong", "storage"]) {
    const container = resources.containers.find((c) => c.name === `supabase_${name}_${stack.profile.projectId}`)
    if (!container || container.status !== "running") fail(EXIT.IDENTITY_MISMATCH, "identidad", "Falta un servicio de seed en marcha y registrado como propio; no se escribirá por HTTP ni SQL.")
    const binding = name === "db" ? ["5432/tcp", stack.profile.ports.db] : name === "kong" ? ["8000/tcp", stack.profile.ports.api] : null
    if (binding && !container.ports?.[binding[0]]?.some((port) => Number(port.HostPort) === binding[1] && ["127.0.0.1", "0.0.0.0", ""].includes(port.HostIp ?? ""))) fail(EXIT.IDENTITY_MISMATCH, "identidad", "El endpoint de seed no está publicado por el contenedor propio registrado; no basta con que responda.")
  }
  return resolved
}

function assertFixtureUser(user, account, census, saved) {
  if (!user || user.email !== account.email || user.user_metadata?.biblib_fixture !== census.censusId || (saved.id && saved.id !== user.id)) fail(EXIT.IDENTITY_MISMATCH, "auth", "El correo o ID existe fuera del scope registrado del censo; no se adopta ni modifica esa cuenta.")
}

/** Recupera también la ventana createUser→registro si el proceso se interrumpió. */
export async function seedAccounts(admin, census, store, save) {
  const users = []
  for (let page = 1; ; page++) {
    const data = resultOf(await admin.auth.admin.listUsers({ page, perPage: 1000 }), "auth")
    users.push(...data.users)
    if (data.users.length < 1000) break
  }
  // Revisa ambos correos antes de cambiar la primera cuenta.
  for (const account of census.accounts) {
    const saved = store.accounts[account.key] ?? {}
    const existing = users.find((u) => u.email === account.email)
    if (saved.id && !existing) fail(EXIT.IDENTITY_MISMATCH, "auth", "Falta una cuenta registrada; comprueba si el stack fue reconstruido antes de renovar su registro privado.")
    if (existing) assertFixtureUser(existing, account, census, saved)
  }
  for (const account of census.accounts) {
    const saved = store.accounts[account.key] ??= { email: account.email, password: randomBytes(36).toString("base64url") }
    const existing = users.find((u) => u.email === account.email)
    if (saved.id && !existing) fail(EXIT.IDENTITY_MISMATCH, "auth", "Falta una cuenta registrada; comprueba si el stack fue reconstruido antes de renovar su registro privado.")
    if (existing) assertFixtureUser(existing, account, census, saved)
    save() // La contraseña queda recuperable antes de la primera escritura de Auth.
    const attributes = { password: saved.password, email_confirm: true, user_metadata: account.user_metadata }
    const data = existing
      ? resultOf(await admin.auth.admin.updateUserById(existing.id, attributes), "auth")
      : resultOf(await admin.auth.admin.createUser({ email: account.email, ...attributes }), "auth")
    assertFixtureUser(data.user, account, census, saved)
    saved.id = data.user.id
    save()
  }
}

/** Solo dominio: transacción y parámetros; ningún INSERT en auth ni DDL. */
export async function seedDomain(sql, census, store) {
  return sql.begin(async (tx) => {
    for (const account of census.accounts) {
      const user = store.accounts[account.key].id
      const shelfIds = new Map()
      for (const shelf of account.shelves) {
        if (shelf.isDefault) {
          const [row] = await tx`insert into biblib.shelves (user_id, title, is_default)
            values (${user}, ${shelf.title}, true)
            on conflict (user_id, is_default) where is_default = true
            do update set is_default = true returning id`
          shelfIds.set(shelf.fixtureKey, row.id)
        } else {
          const id = fixtureId(census.censusId, user, "shelf", shelf.fixtureKey)
          const rows = await tx`insert into biblib.shelves (id, user_id, title, is_default)
            values (${id}, ${user}, ${shelf.title}, false)
            on conflict (id) do update set title = excluded.title, updated_at = now()
            where shelves.user_id = excluded.user_id and shelves.is_default = false returning id`
          if (!rows.length) fail(EXIT.IDENTITY_MISMATCH, "dominio", "Un ID de estantería fixture colisiona con otro scope.")
          shelfIds.set(shelf.fixtureKey, id)
        }
      }
      for (const book of account.books) {
        const id = fixtureId(census.censusId, user, "book", book.fixtureKey)
        const catalogue = { source: book.source, isbnVerified: false, fixtureKey: book.fixtureKey, censusId: census.censusId }
        const rows = await tx`insert into biblib.books
          (id, user_id, isbn, title, authors, number_of_pages, publish_date, status, shelf_id, catalogue)
          values (${id}, ${user}, ${book.isbn}, ${book.title}, ${tx.json(book.authors)}, ${book.number_of_pages}, ${book.publish_date}, ${book.status}, ${shelfIds.get(book.shelfKey)}, ${tx.json(catalogue)})
          on conflict (id) do update set isbn = excluded.isbn, title = excluded.title, authors = excluded.authors,
            number_of_pages = excluded.number_of_pages, publish_date = excluded.publish_date, status = excluded.status,
            shelf_id = excluded.shelf_id, catalogue = excluded.catalogue, updated_at = now()
          where books.user_id = excluded.user_id and books.catalogue->>'fixtureKey' = excluded.catalogue->>'fixtureKey'
            and books.catalogue->>'censusId' = excluded.catalogue->>'censusId' returning id`
        if (!rows.length) fail(EXIT.IDENTITY_MISMATCH, "dominio", "Un ID de libro fixture colisiona con una ficha sin fixtureKey; no se modifica.")
      }
    }
  })
}

export async function seedStorage(admin, root = REPO_ROOT) {
  const { data, error } = await admin.storage.getBucket(BUCKET)
  if (error) resultOf(await admin.storage.createBucket(BUCKET, { public: false, allowedMimeTypes: ["image/webp"] }), "storage")
  else if (data.public) fail(EXIT.IDENTITY_MISMATCH, "storage", "El bucket reservado de fixtures ya existe como público; requiere revisión antes de continuar.")
  resultOf(await admin.storage.from(BUCKET).upload(ASSET, readFileSync(path.join(root, "public/default-book-cover.webp")), { contentType: "image/webp", upsert: true }), "storage")
}

export async function runSeed({ profile = "main", root = REPO_ROOT, target = process.env.BIBLIB_TARGET ?? "local", stack, lockHeld = false, signal } = {}, deps = {}) {
  assertLocalTarget(target)
  const census = loadCensus(root)
  const resolved = await (deps.resolveLocal ?? resolveSeedTarget)(profile, { root, stack })
  const release = lockHeld ? () => {} : acquireLock(resolved.stack)
  let sql, locked = false, phase = "ledger"
  const checkSignal = () => { if (signal?.aborted) fail(EXIT.INTERRUPTED, phase, "Seed interrumpido; conserva el registro y reintenta.") }
  const abort = () => { sql?.end({ timeout: 0 }).catch(() => {}) }
  signal?.addEventListener("abort", abort, { once: true })
  try {
    checkSignal()
    sql = (deps.connect ?? connect)(resolved, { applicationName: "biblib-seed" })
    await (deps.acquireMigrationLock ?? acquireMigrationLock)(sql, { signal })
    locked = true
    const inspection = await sql.begin("read only", (tx) => (deps.inspectDatabase ?? inspectDatabase)(tx, loadJournal()))
    checkSignal()
    if (inspection.code !== EXIT.OK) fail(inspection.code, "ledger", "Historial u objetos divergentes; consulta db:status:local antes del seed.")
    if (inspection.state !== "up-to-date") fail(EXIT.PLAN_REJECTED, "ledger", "Hay migraciones pendientes: ejecuta pnpm db:plan:local y pnpm db:migrate:local para este perfil antes del seed.")
    phase = "registro"
    const values = resolved.target.env()
    if (!values.SUPABASE_SERVICE_ROLE_KEY) fail(EXIT.SEED_FAILED, phase, "Falta la credencial administrativa local; consulta el estado privado del perfil sin imprimirlo.")
    const store = readFixtureStore(resolved, census) ?? { schemaVersion: 1, censusVersion: census.censusVersion, censusId: census.censusId, fingerprint: resolved.fingerprint, accounts: {} }
    store.serviceRoleKey = values.SUPABASE_SERVICE_ROLE_KEY
    const save = () => { store.phase = phase; writeFixtureStore(resolved, store) }
    const clientOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
    const admin = (deps.createClient ?? createClient)(values.SUPABASE_URL, store.serviceRoleKey, clientOptions)
    phase = "auth"
    await seedAccounts(admin, census, store, save)
    checkSignal()
    phase = "dominio"; save()
    await (deps.seedDomain ?? seedDomain)(sql, census, store)
    checkSignal()
    phase = "storage"; save()
    await (deps.seedStorage ?? seedStorage)(admin, root)
    checkSignal()
    phase = "correo"; save()
    // GoTrue limita correos repetidos. Un reintento inmediato conserva el recibo del primer envío.
    if (!store.mailSentAt || Date.now() - Date.parse(store.mailSentAt) > 65000) {
      const anon = (deps.createClient ?? createClient)(values.SUPABASE_URL, values.SUPABASE_ANON_KEY, clientOptions)
      resultOf(await anon.auth.resetPasswordForEmail(census.accounts[0].email), "correo")
      store.mailSentAt = new Date().toISOString()
    }
    phase = "completado"; save()
    if (signal?.aborted) fail(EXIT.INTERRUPTED, phase, "Seed interrumpido; conserva el registro y reintenta.")
    return { schemaVersion: 1, target: "local", profile, fingerprint: resolved.fingerprint, censusId: census.censusId, censusVersion: census.censusVersion, phase,
      accounts: census.accounts.map((a) => ({ key: a.key, email: a.email, id: store.accounts[a.key].id, books: a.books.length, shelves: a.shelves.length })),
      storage: { bucket: BUCKET, object: ASSET, public: false }, mail: { recipient: census.accounts[0].email, requested: true } }
  } catch (error) {
    checkSignal()
    if (error instanceof BiblibError) throw error
    fail(EXIT.SEED_FAILED, phase, `Falló el seed en ${phase}; conserva .biblib/fixtures y repite para continuar sin duplicados.`)
  } finally {
    signal?.removeEventListener("abort", abort)
    if (locked) await (deps.releaseMigrationLock ?? releaseMigrationLock)(sql)
    await closeConnection(sql)
    release()
  }
}

export async function main(argv = process.argv.slice(2)) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  process.on("SIGINT", abort)
  try {
    const options = parseSeedArgs(argv)
    const result = await runSeed({ ...options, signal: controller.signal })
    if (options.json) console.log(JSON.stringify({ code: EXIT.OK, ...result }))
    else console.log(`Fixtures ${result.censusId} · ${result.profile}: A/B, bibliotecas, Storage privado y correo completados.`)
    return EXIT.OK
  } catch (error) {
    const code = error instanceof BiblibError ? error.code : EXIT.SEED_FAILED
    const result = { code, phase: error instanceof BiblibError ? error.phase : "seed", message: error instanceof BiblibError ? error.message : "No se pudo completar el seed local." }
    if (argv.includes("--json")) console.log(JSON.stringify(result))
    else console.error(`Error [${result.phase}] (${code}): ${result.message}`)
    return code
  } finally { process.removeListener("SIGINT", abort) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main()
