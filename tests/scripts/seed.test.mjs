import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"
import { createContext } from "../../scripts/local-stack.mjs"
import { writeLocalEnvFile } from "../../scripts/db/environment.mjs"
import { fixtureFile, fixtureId, readFixtureStore } from "../../scripts/db/fixture-store.mjs"
import { loadCensus, parseSeedArgs, resolveSeedTarget, runSeed, seedDomain, seedStorage } from "../../scripts/db/seed-local.mjs"
import { resolveLocal } from "../../scripts/db/target.mjs"
import { EXIT } from "../../scripts/lib/exit-codes.mjs"
import { writeState } from "../../scripts/lib/state.mjs"

const repo = fileURLToPath(new URL("../../", import.meta.url))
const roots = []
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })
function context() {
  const root = mkdtempSync(path.join(tmpdir(), "biblib seed con espacios "))
  roots.push(root)
  mkdirSync(path.join(root, "supabase"))
  mkdirSync(path.join(root, "tests/fixtures"), { recursive: true })
  for (const file of ["config.toml", "profiles.json"]) copyFileSync(path.join(repo, "supabase", file), path.join(root, "supabase", file))
  copyFileSync(path.join(repo, "tests/fixtures/census.json"), path.join(root, "tests/fixtures/census.json"))
  const stack = createContext("scratch", { root })
  return { root, stack, resolved: { stack, profile: "scratch", fingerprint: stack.fingerprint, target: {
    target: "local", profile: "scratch", cwd: root, fingerprint: stack.fingerprint,
    env: () => ({ SUPABASE_URL: "http://127.0.0.1:55341", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55341", SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:55342/postgres", SUPABASE_SERVICE_ROLE_KEY: "administrative-simulation-only", SUPABASE_ANON_KEY: "public-simulation-only", NEXT_PUBLIC_SUPABASE_ANON_KEY: "public-simulation-only" }),
  } } }
}

function simulated() {
  const f = context(), users = [], libraries = new Map(), calls = []
  const admin = { auth: { admin: {
    listUsers: async () => ({ data: { users } }),
    createUser: async (attributes) => { calls.push("create"); const user = { ...attributes, id: randomUUID() }; users.push(user); return { data: { user } } },
    updateUserById: async (id, attributes) => { calls.push("update"); const user = users.find((u) => u.id === id); Object.assign(user, attributes); return { data: { user } } },
  }, resetPasswordForEmail: async () => { calls.push("mail"); return { data: {} } } } }
  const sql = { begin: async (...args) => args.at(-1)(sql), end: async () => {} }
  const deps = {
    resolveLocal: async () => f.resolved, connect: () => { calls.push("connect"); return sql },
    acquireMigrationLock: async () => {}, releaseMigrationLock: async () => {},
    inspectDatabase: async () => ({ code: EXIT.OK, state: "up-to-date" }), createClient: () => { calls.push("client"); return admin },
    seedStorage: async () => { calls.push("storage") },
    seedDomain: async (_sql, census, store) => {
      for (const a of census.accounts) for (const book of a.books) libraries.set(fixtureId(census.censusId, store.accounts[a.key].id, "book", book.fixtureKey), { ...book, userId: store.accounts[a.key].id })
    },
  }
  return { ...f, deps, users, libraries, calls, options: { root: f.root, profile: "scratch", target: "local" } }
}

test("censo sin credenciales: A/B, keys únicas, manuales, ISBN fixture y cuatro estados", () => {
  const census = loadCensus()
  assert.deepEqual(census.accounts.map((a) => a.email), ["lector-a@biblib.test", "lector-b@biblib.test"])
  assert.doesNotMatch(JSON.stringify(census), /password|serviceRole|access_token|refresh_token|eyJ/)
  for (const a of census.accounts) {
    assert.equal(a.shelves.filter((s) => s.isDefault).length, 1)
    assert.equal(new Set(a.books.map((b) => b.status)).size, 4)
    for (const b of a.books.filter((b) => b.source === "open-library")) {
      const catalogue = JSON.parse(readFileSync(path.join(repo, "tests/fixtures/catalogue", `${b.isbn}.json`), "utf8"))
      assert.equal(catalogue[`ISBN:${b.isbn}`].title, b.title)
    }
  }
})

test("argumentos cerrados y target remoto rechazado antes de resolver o escribir", async () => {
  assert.deepEqual(parseSeedArgs(["--profile", "scratch", "--json"]), { profile: "scratch", json: true })
  for (const args of [["--remove"], ["--db-url", "remote"], ["--all"], ["--json", "--json"]]) assert.throws(() => parseSeedArgs(args), { code: EXIT.INVALID_ARGS })
  for (const target of ["test", "preprod", "prod"]) await assert.rejects(runSeed({ target }, { resolveLocal: () => assert.fail("No debe resolver") }), { code: EXIT.IDENTITY_MISMATCH })
})

test("rechaza HolaERP (5432/54321), remoto y perfil sin registro antes de clientes o SQL", async () => {
  for (const foreign of ["holaerp", "remote", "unowned"]) {
    const f = context()
    const values = f.resolved.target.env()
    if (foreign === "holaerp") { values.NEXT_PUBLIC_SUPABASE_URL = values.SUPABASE_URL = "http://127.0.0.1:54321"; values.SUPABASE_DB_URL = "postgresql://postgres:postgres@127.0.0.1:5432/postgres" }
    if (foreign === "remote") values.NEXT_PUBLIC_SUPABASE_URL = values.SUPABASE_URL = "https://example.supabase.co"
    writeLocalEnvFile({ ...f.resolved.target, env: () => values })
    await assert.rejects(runSeed({ root: f.root, profile: "scratch", target: "local" }, { connect: () => assert.fail("No debe conectar"), createClient: () => assert.fail("No debe crear clientes") }), { code: EXIT.IDENTITY_MISMATCH })
    assert.equal(existsSync(fixtureFile(f.resolved)), false)
  }
})

test("un stack que responde con red ajena no se acredita aunque sus IDs estén registrados", async () => {
  const f = context()
  writeLocalEnvFile(f.resolved.target)
  const network = { id: "network-id", name: f.stack.profile.network, labels: { "biblib.profile": "scratch", "biblib.root": "otra-raiz" } }
  writeState(f.stack, { resources: { network, containers: [], volumes: [] } })
  f.stack.run = async (_command, args) => ({ code: 0, stdout: args[0] === "network" ? (args[1] === "ls" ? network.name : JSON.stringify(network)) : "", stderr: "" })
  await assert.rejects(resolveLocal("scratch", { root: f.root, stack: f.stack }), { code: EXIT.IDENTITY_MISMATCH })
})

test("Auth/Storage deben estar registrados y los bindings API/DB pertenecer al perfil", async () => {
  for (const variant of ["valid", "missing-auth", "foreign-api", "foreign-db"]) {
    const f = context()
    writeLocalEnvFile(f.resolved.target)
    const network = { id: "network-id", name: f.stack.profile.network, labels: { "biblib.profile": "scratch", "biblib.root": f.stack.identity.label } }
    const containers = ["db", "auth", "kong", "storage"].map((name) => ({ id: `${name}-id`, name: `supabase_${name}_biblib-scratch`, status: "running", labels: { "com.supabase.cli.project": "biblib-scratch" }, networks: { [network.name]: {} },
      ports: name === "db" ? { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: variant === "foreign-db" ? "5432" : "55342" }] } : name === "kong" ? { "8000/tcp": [{ HostIp: "127.0.0.1", HostPort: variant === "foreign-api" ? "54321" : "55341" }] } : {} }))
    if (variant === "missing-auth") containers.splice(1, 1)
    writeState(f.stack, { resources: { network, containers, volumes: [] } })
    f.stack.run = async (_command, args) => {
      const resources = args[0] === "network" ? [network] : args[0] === "container" ? containers : []
      return { code: 0, stdout: resources.map((r) => args[1] === "ls" ? (args[0] === "network" ? r.name : r.id) : JSON.stringify(r)).join("\n"), stderr: "" }
    }
    const promise = resolveSeedTarget("scratch", { root: f.root, stack: f.stack })
    if (variant === "valid") assert.equal((await promise).fingerprint, f.stack.fingerprint)
    else await assert.rejects(promise, { code: EXIT.IDENTITY_MISMATCH })
  }
})

test("ledger pendiente produce 6 antes de crear registro, cuentas o bucket", async () => {
  const f = simulated()
  f.deps.inspectDatabase = async () => ({ code: 0, state: "pending" })
  await assert.rejects(runSeed(f.options, f.deps), (e) => e.code === 6 && /db:plan:local.*db:migrate:local/.test(e.message))
  assert.equal(f.calls.includes("client"), false)
  assert.equal(existsSync(fixtureFile(f.resolved)), false)
})

test("seed repetido conserva IDs, credenciales privadas y libro manual ajeno", async () => {
  const f = simulated()
  const first = await runSeed(f.options, f.deps)
  f.libraries.set("manual-ajeno", { title: "Alta humana sin fixtureKey" })
  const store = readFixtureStore(f.resolved, loadCensus(f.root))
  const second = await runSeed(f.options, f.deps)
  assert.deepEqual(first.accounts, second.accounts)
  assert.equal(f.users.length, 2)
  assert.equal(f.calls.filter((c) => c === "create").length, 2)
  assert.equal(f.calls.filter((c) => c === "mail").length, 1)
  assert.equal(f.libraries.size, 9)
  assert.equal(f.libraries.get("manual-ajeno").title, "Alta humana sin fixtureKey")
  assert.deepEqual(readFixtureStore(f.resolved, loadCensus(f.root)).accounts, store.accounts)
  assert.doesNotMatch(JSON.stringify(second), /administrative-simulation|password|serviceRoleKey|access_token|refresh_token/)
})

test("fallo parcial en dominio produce 10 con fase y reintento sin cuentas duplicadas", async () => {
  const f = simulated(), domain = f.deps.seedDomain
  f.deps.seedDomain = async () => { throw new Error("Detalle privado no publicable") }
  await assert.rejects(runSeed(f.options, f.deps), (e) => e.code === 10 && e.phase === "dominio" && !e.message.includes("Detalle"))
  assert.equal(readFixtureStore(f.resolved, loadCensus(f.root)).phase, "dominio")
  f.deps.seedDomain = domain
  await runSeed(f.options, f.deps)
  assert.equal(f.users.length, 2)
  assert.equal(f.libraries.size, 8)
})

test("recupera cuenta creada antes de persistir el ID sin imponer UUID a Auth", async () => {
  const f = simulated(), census = loadCensus(f.root)
  f.users.push({ id: randomUUID(), email: census.accounts[0].email, user_metadata: census.accounts[0].user_metadata })
  const result = await runSeed(f.options, f.deps)
  assert.equal(result.accounts[0].id, f.users[0].id)
  assert.equal(f.users.length, 2)
  assert.equal(f.calls.filter((c) => c === "create").length, 1)
})

test("correo existente sin metadato fixture se rechaza sin adoptar la cuenta", async () => {
  const f = simulated()
  f.users.push({ id: randomUUID(), email: "lector-a@biblib.test", user_metadata: {} })
  await assert.rejects(runSeed(f.options, f.deps), { code: EXIT.IDENTITY_MISMATCH })
  assert.equal(f.calls.includes("create"), false)
  assert.equal(f.calls.includes("update"), false)
})

test("colisión en B se detecta antes de actualizar A", async () => {
  const f = simulated(), census = loadCensus()
  f.users.push({ id: randomUUID(), email: census.accounts[0].email, user_metadata: census.accounts[0].user_metadata })
  f.users.push({ id: randomUUID(), email: census.accounts[1].email, user_metadata: {} })
  await assert.rejects(runSeed(f.options, f.deps), { code: EXIT.IDENTITY_MISMATCH })
  assert.equal(f.calls.includes("update"), false)
})

test("Storage crea bucket privado, carga bytes deterministas y rechaza bucket público existente", async () => {
  const uploads = [], buckets = []
  const admin = { storage: {
    getBucket: async () => ({ error: { status: 404 } }),
    createBucket: async (name, options) => { buckets.push({ name, options }); return { data: {} } },
    from: (name) => ({ upload: async (object, bytes, options) => { uploads.push({ name, object, bytes, options }); return { data: {} } } }),
  } }
  await seedStorage(admin)
  await seedStorage(admin)
  assert.ok(buckets.every((b) => b.name === "biblib-test-assets" && b.options.public === false))
  assert.deepEqual(uploads[0].bytes, uploads[1].bytes)
  assert.equal(uploads[0].object, "fixtures/portada.webp")
  assert.equal(uploads[0].options.upsert, true)
  admin.storage.getBucket = async () => ({ data: { public: true } })
  await assert.rejects(seedStorage(admin), { code: EXIT.IDENTITY_MISMATCH })
  assert.equal(uploads.length, 2)
})

test("registro privado rechaza enlaces a otro directorio", () => {
  const f = context(), other = context()
  mkdirSync(path.join(f.root, ".biblib"))
  symlinkSync(other.root, path.join(f.root, ".biblib/fixtures"), "junction")
  assert.throws(() => fixtureFile(f.resolved), { code: EXIT.IDENTITY_MISMATCH })
  // Quitar solo la junction; el directorio de destino pertenece a otra raíz temporal.
  rmdirSync(path.join(f.root, ".biblib/fixtures"))
})

test("SQL de dominio usa una transacción, scope por propietario y fixtureKey, sin tocar version ni auth", async () => {
  const census = loadCensus(), queries = []
  const store = { accounts: { a: { id: randomUUID() }, b: { id: randomUUID() } } }
  const tx = async (strings, ...values) => { queries.push({ query: strings.join("?"), values }); return [{ id: randomUUID() }] }
  tx.json = (value) => value
  let transactions = 0
  await seedDomain({ begin: async (fn) => { transactions++; return fn(tx) } }, census, store)
  assert.equal(transactions, 1)
  assert.equal(queries.length, 14)
  for (const { query, values } of queries) {
    assert.doesNotMatch(query, /delete|truncate|auth\.|version\s*=/i)
    assert.match(query, /on conflict/i)
    assert.ok(values.includes(store.accounts.a.id) || values.includes(store.accounts.b.id))
    if (query.includes("biblib.books")) assert.match(query, /books\.catalogue->>'fixtureKey'.*excluded\.catalogue->>'fixtureKey'/s)
  }
})

test("seed y sesiones GoTrue, Storage y Mailpit reales [stack]", { skip: process.env.BIBLIB_SKIP_STACK_TESTS === "1" ? "BIBLIB_SKIP_STACK_TESTS=1" : false }, async (t) => {
  try { await resolveLocal("scratch") } catch { t.skip("scratch no está disponible o acreditado"); return }
  const { verifySeed } = await import("../integration/support/verify-seed.mjs")
  await verifySeed()
})
