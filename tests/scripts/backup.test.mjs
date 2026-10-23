import assert from "node:assert/strict"
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"
import { exclusionsFor, main as backupMain, parseBackupArgs, PROD_PENDING } from "../../scripts/db/backup-local.mjs"
import { loadJournal } from "../../scripts/db/journal-guard.mjs"
import { classifyDestination, loadBackup, parseRestoreArgs, runRestore } from "../../scripts/db/restore-local.mjs"
import { compareRestored, parseVerifyArgs, recordRehearsal } from "../../scripts/db/restore-verify.mjs"
import { loadCensus } from "../../scripts/db/seed-local.mjs"
import { authExclusions, BACKUP_KIND, checkBackupFiles, compareMigrations, decrypt, encrypt, keyFingerprint, MANIFEST_FILE, newBackupId, objectFile, parseKey, readKeyFile, readManifest, resolveBackupsRoot, sealManifest, sha256 } from "../../scripts/lib/backup-files.mjs"
import { streamCommand } from "../../scripts/lib/backup-process.mjs"
import { EXIT } from "../../scripts/lib/exit-codes.mjs"

const repo = fileURLToPath(new URL("../../", import.meta.url))
const roots = []
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })
const KEY = Buffer.alloc(32, 7)

function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), "biblib backup con espacios "))
  roots.push(root)
  mkdirSync(path.join(root, ".biblib"))
  mkdirSync(path.join(root, "tests/fixtures"), { recursive: true })
  mkdirSync(path.join(root, "supabase"))
  for (const file of ["config.toml", "profiles.json"]) copyFileSync(path.join(repo, "supabase", file), path.join(root, "supabase", file))
  copyFileSync(path.join(repo, "tests/fixtures/census.json"), path.join(root, "tests/fixtures/census.json"))
  cpSync(path.join(repo, "drizzle"), path.join(root, "drizzle"), { recursive: true })
  return root
}

/** Respaldo ficticio con la misma forma que produce backup-local (sin Docker). */
function makeBackup(root, { key = null, source = "local", dirName } = {}) {
  const backupId = newBackupId("scratch", new Date("2026-10-23T12:00:00Z"), "abc123")
  const dir = path.join(root, ".biblib", "backups", dirName ?? backupId)
  mkdirSync(path.join(dir, "db"), { recursive: true })
  mkdirSync(path.join(dir, "storage"))
  const files = []
  const add = (role, relative, plain) => {
    const data = key ? encrypt(key, plain) : plain
    const file = key ? `${relative}.enc` : relative
    writeFileSync(path.join(dir, ...file.split("/")), data)
    files.push({ path: file, role, bytes: data.length, sha256: sha256(data), plainSha256: sha256(plain), encrypted: Boolean(key) })
  }
  add("domain-dump", "db/biblib-drizzle.sql", Buffer.from("-- volcado ficticio\n"))
  add("auth-data", "db/auth-data.sql", Buffer.from("-- auth ficticio\n"))
  const cover = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 1, 2, 3])
  add("storage-object", objectFile("biblib-test-assets", "fixtures/portada.webp"), cover)
  const journal = loadJournal(path.join(root, "drizzle"))
  const manifest = sealManifest({
    schemaVersion: 1, kind: BACKUP_KIND, backupId, createdAt: "2026-10-23T12:00:00.000Z",
    source: { target: source, profile: "scratch", project: "biblib-scratch", fingerprint: "f".repeat(64) },
    migrations: { head: journal.entries.at(-1).tag, applied: journal.entries.map((e) => ({ tag: e.tag, hash: e.hash, created_at: e.when })) },
    storage: { buckets: [{ id: "biblib-test-assets", public: false, allowedMimeTypes: ["image/webp"] }], objects: [{ bucket: "biblib-test-assets", name: "fixtures/portada.webp", size: cover.length, contentType: "image/webp", sha256: sha256(cover), file: files.at(-1).path }] },
    files, encryption: key ? { algorithm: "aes-256-gcm", keyFingerprint: keyFingerprint(key) } : null, restoreVerification: null,
  })
  writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2))
  return { dir, manifest, relative: path.relative(root, dir) }
}

test("db:backup:prod es solo un contrato que rechaza con 2 y sin conectar", async () => {
  for (const target of ["prod", "preprod"]) assert.throws(() => parseBackupArgs([target]), (error) => error.code === EXIT.INVALID_ARGS && error.message === PROD_PENDING && /U-INF-07/.test(error.message))
  const original = console.error
  const printed = []
  console.error = (line) => printed.push(line)
  try { assert.equal(await backupMain(["prod", "--profile", "scratch"]), EXIT.INVALID_ARGS) } finally { console.error = original }
  assert.match(printed.join("\n"), /pendiente de U-INF-07 y de un destino autorizado/)
})

test("los wrappers no admiten URLs, flags remotos ni perfiles desconocidos", () => {
  assert.deepEqual(parseBackupArgs(["local", "--profile", "scratch", "--out", ".biblib/backups"]), { profile: "scratch", out: ".biblib/backups", json: false })
  for (const args of [["local", "--db-url", "postgres://x"], ["local", "--linked"], ["local", "--profile", "prod"], ["local", "--profile", "scratch", "--profile", "test"], []]) assert.throws(() => parseBackupArgs(args), { code: EXIT.INVALID_ARGS })
  const restore = ["--backup", "b", "--profile", "scratch", "--expect-project", "biblib-scratch"]
  assert.equal(parseRestoreArgs(restore).expectProject, "biblib-scratch")
  for (const extra of [["--db-url", "postgres://x"], ["--linked"], ["--force"], ["--project-ref", "abc"]]) assert.throws(() => parseRestoreArgs([...restore, ...extra]), { code: EXIT.INVALID_ARGS })
  for (const args of [["--backup", "b", "--profile", "scratch"], ["--backup", "b", "--profile", "prod", "--expect-project", "x"]]) assert.throws(() => parseRestoreArgs(args), { code: EXIT.INVALID_ARGS })
  assert.equal(parseVerifyArgs(["--backup", "b", "--profile", "scratch"]).profile, "scratch")
  assert.throws(() => parseVerifyArgs(["--backup", "b", "--profile", "scratch", "--db-url", "x"]), { code: EXIT.INVALID_ARGS })
})

test("la carpeta de respaldos queda fuera de Git: .biblib/ o fuera del repositorio", () => {
  const root = workspace()
  assert.equal(resolveBackupsRoot(root), path.join(root, ".biblib", "backups"))
  const outside = mkdtempSync(path.join(tmpdir(), "biblib-respaldos-")); roots.push(outside)
  assert.equal(resolveBackupsRoot(root, outside), outside)
  for (const dir of ["docs/respaldos", "public/backups", "."]) assert.throws(() => resolveBackupsRoot(root, dir), { code: EXIT.IDENTITY_MISMATCH })
  assert.throws(() => resolveBackupsRoot(root, "https://example.invalid/backups"), { code: EXIT.INVALID_ARGS })
})

test("la clave de recuperación es externa, se valida y nunca se guarda con el respaldo", () => {
  const root = workspace()
  assert.deepEqual(parseKey(Buffer.from("07".repeat(32))), KEY)
  assert.deepEqual(parseKey(Buffer.from(`${KEY.toString("base64")}\n`)), KEY)
  assert.deepEqual(parseKey(KEY), KEY)
  assert.throws(() => parseKey(Buffer.from("corta")), { code: EXIT.INVALID_ARGS })
  const backups = path.join(root, ".biblib", "backups")
  mkdirSync(backups, { recursive: true })
  writeFileSync(path.join(backups, "clave.key"), KEY.toString("hex"))
  assert.throws(() => readKeyFile(root, path.join(backups, "clave.key"), { backupsRoot: backups }), { code: EXIT.INVALID_ARGS })
  writeFileSync(path.join(root, "clave.key"), KEY.toString("hex"))
  assert.throws(() => readKeyFile(root, "clave.key", { backupsRoot: backups }), { code: EXIT.INVALID_ARGS })
  assert.throws(() => readKeyFile(root, "no-existe.key", { backupsRoot: backups }), { code: EXIT.PLAN_REJECTED })
  const external = mkdtempSync(path.join(tmpdir(), "biblib-clave-")); roots.push(external)
  writeFileSync(path.join(external, "ops.key"), KEY.toString("hex"))
  const loaded = readKeyFile(root, path.join(external, "ops.key"), { backupsRoot: backups })
  assert.equal(loaded.fingerprint, keyFingerprint(KEY))
  assert.ok(!loaded.fingerprint.includes(KEY.toString("hex").slice(0, 8)))
})

test("cifrado autenticado: la clave correcta recupera los bytes; otra clave o un byte alterado fallan con 11", () => {
  const plain = Buffer.from("INSERT INTO biblib.books ...")
  const sealed = encrypt(KEY, plain)
  assert.ok(!sealed.includes(plain))
  assert.deepEqual(decrypt(KEY, sealed), plain)
  assert.throws(() => decrypt(Buffer.alloc(32, 9), sealed), { code: EXIT.VERIFICATION_FAILED })
  const tampered = Buffer.from(sealed); tampered[20] ^= 1
  assert.throws(() => decrypt(KEY, tampered), { code: EXIT.VERIFICATION_FAILED })
})

test("manifiesto sellado: alterar un campo o un origen remoto se rechaza", () => {
  const root = workspace()
  const { dir, manifest } = makeBackup(root)
  assert.equal(readManifest(dir).backupId, manifest.backupId)
  assert.match(manifest.backupId, /^20261023T120000Z-scratch-abc123$/)
  const altered = { ...manifest, migrations: { ...manifest.migrations, head: "9999_otra" } }
  writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify(altered))
  assert.throws(() => readManifest(dir), { code: EXIT.VERIFICATION_FAILED })
  const remote = makeBackup(root, { source: "prod", dirName: "remoto" })
  assert.throws(() => readManifest(remote.dir), { code: EXIT.IDENTITY_MISMATCH })
  // La referencia del ensayo no forma parte de la huella.
  writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify({ ...manifest, restoreVerification: { passed: true }, lastRehearsal: { passed: true } }))
  assert.equal(readManifest(dir).contentHash, manifest.contentHash)
})

test("inventario: un objeto ausente, alterado o una ruta fuera del respaldo son discrepancias", () => {
  const root = workspace()
  const { dir, manifest } = makeBackup(root)
  assert.deepEqual(checkBackupFiles(dir, manifest), [])
  const object = manifest.storage.objects[0].file
  writeFileSync(path.join(dir, object), "otros bytes")
  assert.equal(checkBackupFiles(dir, manifest)[0].id, "backup.file.hash")
  rmSync(path.join(dir, object))
  assert.deepEqual(checkBackupFiles(dir, manifest).map((d) => d.id), ["backup.file.missing"])
  assert.throws(() => checkBackupFiles(dir, { ...manifest, files: [{ path: "../fuera.sql", sha256: "0" }] }), { code: EXIT.VERIFICATION_FAILED })
  assert.match(objectFile("bucket", "carpeta/nombre con: espacios?.webp"), /^storage\/[0-9a-f]{40}\.bin$/)
})

test("restore autentica el respaldo antes del destino: objeto ausente 11, clave ausente u otra clave 6", () => {
  const root = workspace()
  const clear = makeBackup(root)
  rmSync(path.join(clear.dir, clear.manifest.storage.objects[0].file))
  assert.throws(() => loadBackup(root, { backup: clear.relative }), (error) => error.code === EXIT.VERIFICATION_FAILED && /no se ha modificado el destino/.test(error.message))
  const sealed = makeBackup(root, { key: KEY, dirName: "cifrado" })
  assert.throws(() => loadBackup(root, { backup: sealed.relative }), { code: EXIT.PLAN_REJECTED })
  const external = mkdtempSync(path.join(tmpdir(), "biblib-clave-")); roots.push(external)
  writeFileSync(path.join(external, "otra.key"), Buffer.alloc(32, 1).toString("hex"))
  writeFileSync(path.join(external, "buena.key"), KEY.toString("hex"))
  assert.throws(() => loadBackup(root, { backup: sealed.relative, keyFile: path.join(external, "otra.key") }), { code: EXIT.PLAN_REJECTED })
  const loaded = loadBackup(root, { backup: sealed.relative, keyFile: path.join(external, "buena.key") })
  assert.equal(loaded.domain.toString(), "-- volcado ficticio\n")
  assert.equal(loaded.objects[0].bytes.length, 8)
})

test("restore rechaza destinos ajenos o remotos antes de conectar", async () => {
  const root = workspace()
  const { relative } = makeBackup(root)
  const base = { backup: relative, profile: "scratch", expectProject: "holaerp" }
  const resolveTarget = async () => ({ project: "biblib-scratch", stack: {}, target: {} })
  await assert.rejects(runRestore(base, { root, resolveTarget }), { code: EXIT.IDENTITY_MISMATCH })
  const previous = process.env.BIBLIB_TARGET
  process.env.BIBLIB_TARGET = "prod"
  try { await assert.rejects(runRestore({ ...base, expectProject: "biblib-scratch" }, { root, resolveTarget: async () => assert.fail("no debe resolver") }), { code: EXIT.IDENTITY_MISMATCH }) }
  finally { if (previous === undefined) delete process.env.BIBLIB_TARGET; else process.env.BIBLIB_TARGET = previous }
  writeFileSync(path.join(root, ".git"), "gitdir: ../repo/.git/worktrees/x\n")
  await assert.rejects(runRestore({ ...base, profile: "main", expectProject: "biblib-local" }, { root, resolveTarget: async () => assert.fail("no debe resolver") }), { code: EXIT.IDENTITY_MISMATCH })
})

test("el historial del respaldo debe ser un prefijo exacto del journal", () => {
  const entries = [{ tag: "0000_a", hash: "h0", when: 1 }, { tag: "0001_b", hash: "h1", when: 2 }, { tag: "0002_c", hash: "h2", when: 3 }]
  const applied = entries.map((e) => ({ tag: e.tag, hash: e.hash, created_at: e.when }))
  assert.deepEqual(compareMigrations(applied, entries), { ok: true, problems: [], pending: [] })
  assert.deepEqual(compareMigrations(applied.slice(0, 2), entries).pending, ["0002_c"])
  assert.equal(compareMigrations([{ ...applied[0], hash: "otro" }], entries).ok, false)
  assert.equal(compareMigrations([...applied, { tag: "0003_d", hash: "h3", created_at: 4 }], entries).ok, false)
})

test("destino recién reseteado: solo el censo de fixtures; cualquier otro dato se rechaza", () => {
  const census = loadCensus(repo)
  const users = census.accounts.map((a, i) => ({ id: `u${i}`, email: a.email, census: census.censusId }))
  const fresh = { users, books: [{ user_id: "u0", census: census.censusId, fixture: true }], shelves: [{ user_id: "u1" }], otherRows: [], buckets: [{ id: "biblib-test-assets" }], objects: [{ bucket: "biblib-test-assets", name: "fixtures/portada.webp" }] }
  assert.equal(classifyDestination(fresh, census).fresh, true)
  assert.equal(classifyDestination({ users: [], books: [], shelves: [], otherRows: [], buckets: [], objects: [] }, census).fresh, true)
  // Tras reset+seed en 0003+, el trigger crea library_state de A/B: estado derivado, no datos ajenos.
  const derived = ["library_state", "import_previews", "catalogue_cache", "catalogue_inflight", "catalogue_quota_buckets", "catalogue_quota_reservations", "catalogue_private_cache"]
  assert.equal(classifyDestination({ ...fresh, otherRows: derived.map((table) => ({ table, rows: 2 })) }, census).fresh, true)
  const cases = [
    { ...fresh, users: [...users, { id: "x", email: "persona@example.com", census: null }] },
    { ...fresh, books: [...fresh.books, { user_id: "u0", census: null, fixture: false }] },
    { ...fresh, otherRows: [{ table: "library_operations", rows: 1 }] },
    { ...fresh, otherRows: [{ table: "tabla_futura", rows: 1 }] },
    { ...fresh, objects: [...fresh.objects, { bucket: "biblib-test-assets", name: "otra.webp" }] },
  ]
  for (const destination of cases) assert.equal(classifyDestination(destination, census).fresh, false)
})

test("verify compara recibo y destino: tokens rotados, cantidades, claves y muestra", () => {
  const manifest = {
    migrations: { head: "0002_c", applied: [{ tag: "0002_c", hash: "h", created_at: 1 }] },
    objects: { hash: "facts", facts: { tables: [1] } },
    digests: [{ schema: "biblib", table: "books", count: 2, keys: "k", content: "c" }, { schema: "auth", table: "users", count: 2, keys: "ku", content: "cu" }],
    tokens: { "biblib.books.version": ["t1", "t2"] }, sample: [{ id: "b1", digest: "d1" }],
  }
  const current = {
    ledger: [{ hash: "h", created_at: 1 }], inspection: { code: 0, state: "up-to-date", manifest: [{ id: "rls.books", status: "ok" }] }, objects: { hash: "facts", facts: { tables: [1] } },
    digests: [{ schema: "biblib", table: "books", count: 2, keys: "k", content: "c" }, { schema: "auth", table: "users", count: 2, keys: "ku", content: "credenciales reasignadas" }],
    tokens: { "biblib.books.version": ["n1", "n2"] }, sample: [{ id: "b1", digest: "d1" }],
  }
  assert.ok(compareRestored(manifest, current).every((c) => c.status === "ok"))
  const failing = (patch) => compareRestored(manifest, { ...current, ...patch }).filter((c) => c.status === "fail").map((c) => c.id)
  assert.deepEqual(failing({ tokens: { "biblib.books.version": ["t1", "n2"] } }), ["tokens.biblib.books.version"])
  assert.deepEqual(failing({ digests: [{ ...current.digests[0], count: 1 }, current.digests[1]] }), ["table.biblib.books"])
  assert.deepEqual(failing({ objects: { hash: "otro", facts: { tables: [2] } } }), ["objects.facts"])
  assert.deepEqual(failing({ sample: [] }), ["sample.books"])
  assert.deepEqual(failing({ inspection: { code: 5, state: "drift", manifest: [{ id: "trigger.books_rotate_version", status: "fail" }] } }), ["manifest.objects"])
})

test("el recibo conserva el último ensayo superado salvo que falle el propio respaldo", () => {
  const passed = { passed: true, reportId: "r1", target: {}, durations: { recoveryMs: 1000 }, finishedAt: "t1", discrepancies: [] }
  const first = recordRehearsal({ restoreVerification: null }, passed, "rehearsals/r1.json", "s1")
  assert.equal(first.restoreVerification.reportId, "r1")
  const destination = recordRehearsal(first, { ...passed, passed: false, reportId: "r2", discrepancies: [{ id: "storage.object" }] }, "rehearsals/r2.json", "s2")
  assert.equal(destination.restoreVerification.reportId, "r1")
  assert.equal(destination.lastRehearsal.reportId, "r2")
  const broken = recordRehearsal(destination, { ...passed, passed: false, reportId: "r3", discrepancies: [{ id: "backup.file.missing" }] }, "rehearsals/r3.json", "s3")
  assert.equal(broken.restoreVerification.passed, false)
})

test("Auth: solo identidades; sesiones, tokens, flujos y configuración quedan excluidos", () => {
  const excluded = authExclusions(["audit_log_entries", "custom_oauth_providers", "flow_state", "identities", "mfa_factors", "one_time_tokens", "refresh_tokens", "sessions", "users", "webauthn_credentials"])
  assert.deepEqual(excluded, ["auth.audit_log_entries", "auth.custom_oauth_providers", "auth.flow_state", "auth.one_time_tokens", "auth.refresh_tokens", "auth.sessions"])
  assert.ok(exclusionsFor(excluded).some((e) => /Mailpit/.test(e.item)))
  assert.ok(exclusionsFor(excluded).some((e) => /\.biblib\/fixtures/.test(e.item)))
})

test("streamCommand captura bytes y entrega la entrada por stdin, no por argv", async () => {
  const script = "process.stdin.on('data', (d) => process.stdout.write(Buffer.concat([Buffer.from([0, 255]), d])))"
  const result = await streamCommand(process.execPath, ["-e", script], { input: Buffer.from("secreto-por-stdin"), timeoutMs: 10000 })
  assert.equal(result.code, 0)
  assert.deepEqual(result.stdout, Buffer.concat([Buffer.from([0, 255]), Buffer.from("secreto-por-stdin")]))
  await assert.rejects(streamCommand(process.execPath, ["-e", "process.stdout.write(Buffer.alloc(2048))"], { maxBytes: 1024, timeoutMs: 10000 }), { code: EXIT.SERVICE_UNAVAILABLE })
  assert.equal(readFileSync(path.join(repo, "package.json"), "utf8").includes("\"db:backup:prod\": \"node scripts/db/backup-local.mjs prod\""), true)
})
