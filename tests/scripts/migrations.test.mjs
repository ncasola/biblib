import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { readMigrationFiles } from "drizzle-orm/migrator"
import { EXIT } from "../../scripts/lib/exit-codes.mjs"
import { compareLedger, drizzleHash, inspectJournal, loadJournal, summarizeDdl } from "../../scripts/db/journal-guard.mjs"
import { expectedObjects, MANIFEST_MIGRATIONS, normalizeExpression, verifyManifest } from "../../scripts/db/objects-manifest.mjs"
import { assertPlanMatchesTarget, buildPlan, canonical, computePlanHash, parsePlanArgs, resolvePlanPath, validatePlan } from "../../scripts/db/plan.mjs"
import { acquireMigrationLock, applyPlan, EXPLICIT_COMMANDS, legacyDispatcher, parseArgs, releaseMigrationLock } from "../../scripts/db/migrate.mjs"
import { classify, closeConnection, connect, inspectDatabase, readLedger, resolveLocal } from "../../scripts/db/target.mjs"

const repo = fileURLToPath(new URL("../../", import.meta.url))
const drizzleDir = path.join(repo, "drizzle")
const facts = JSON.parse(readFileSync(path.join(repo, "tests/fixtures/migrations/objects-0002.json"), "utf8"))
const temporary = []
after(() => { for (const dir of temporary) rmSync(dir, { recursive: true, force: true }) })
const clone = (value) => JSON.parse(JSON.stringify(value))

function migrationsCopy() {
  const dir = mkdtempSync(path.join(tmpdir(), "biblib migraciones "))
  temporary.push(dir)
  cpSync(drizzleDir, dir, { recursive: true })
  return dir
}
const journalPath = (dir) => path.join(dir, "meta", "_journal.json")
const editJournal = (dir, edit) => {
  const journal = JSON.parse(readFileSync(journalPath(dir), "utf8"))
  edit(journal)
  writeFileSync(journalPath(dir), `${JSON.stringify(journal, null, 2)}\n`)
}
const rowsFor = (entries, count = entries.length, hash = (e) => e.hash) => entries.slice(0, count).map((e, i) => ({ id: i + 1, hash: hash(e), created_at: e.when }))
const failing = (checks) => checks.filter((c) => c.status === "fail").map((c) => c.id)

describe("journal", () => {
  test("el journal del repositorio es válido y LF", () => {
    const journal = loadJournal(drizzleDir)
    assert.deepEqual(journal.entries.map((e) => e.tag), MANIFEST_MIGRATIONS)
    for (const entry of journal.entries) assert.equal(entry.hash, entry.lfHash)
  })

  test("los hashes coinciden con readMigrationFiles del drizzle-orm instalado", () => {
    const journal = loadJournal(drizzleDir)
    const installed = readMigrationFiles({ migrationsFolder: drizzleDir })
    assert.deepEqual(journal.entries.map((e) => [e.when, e.hash]), installed.map((m) => [m.folderMillis, m.hash]))
    assert.deepEqual(journal.entries.map((e) => e.statements), installed.map((m) => m.sql))
    for (const entry of journal.entries) assert.equal(drizzleHash(readFileSync(entry.file)), entry.hash)
  })

  test("idx no consecutivo, when no creciente, fichero ausente y SQL huérfano bloquean con 5", () => {
    const idx = migrationsCopy(); editJournal(idx, (j) => { j.entries[2].idx = 3 })
    assert.ok(inspectJournal(idx).problems.some((p) => p.id === "journal.idx"))
    const when = migrationsCopy(); editJournal(when, (j) => { j.entries[2].when = j.entries[1].when })
    assert.ok(inspectJournal(when).problems.some((p) => p.id === "journal.when"))
    const missing = migrationsCopy(); rmSync(path.join(missing, "0001_library_integrity.sql"))
    assert.ok(inspectJournal(missing).problems.some((p) => p.id === "journal.missing"))
    const orphan = migrationsCopy(); writeFileSync(path.join(orphan, "0003_sin_journal.sql"), "select 1;\n")
    assert.ok(inspectJournal(orphan).problems.some((p) => p.id === "journal.orphan"))
    assert.throws(() => loadJournal(missing), { code: EXIT.HISTORY_DIVERGED })
  })

  test("un SQL con CRLF en disco se rechaza antes de calcular un hash distinto por plataforma", () => {
    const dir = migrationsCopy()
    const file = path.join(dir, "0002_book_versions.sql")
    writeFileSync(file, readFileSync(file, "utf8").replace(/\n/g, "\r\n"))
    const journal = inspectJournal(dir)
    assert.ok(journal.problems.some((p) => p.id === "journal.eol"))
    const entry = journal.entries.find((e) => e.tag === "0002_book_versions")
    assert.equal(entry.hash, entry.crlfHash)
    assert.notEqual(entry.hash, entry.lfHash)
    assert.equal(entry.lfHash, loadJournal(drizzleDir).entries[2].hash)
  })

  test("las reglas .gitattributes mantienen LF en el índice", () => {
    const result = spawnSync("git", ["ls-files", "--eol", "drizzle"], { cwd: repo, encoding: "utf8" })
    assert.equal(result.status, 0)
    const lines = result.stdout.trim().split(/\r?\n/)
    assert.ok(lines.length >= 6)
    for (const line of lines) {
      assert.match(line, /^i\/lf\s/)
      assert.match(line, /attr\/text eol=lf/)
    }
  })

  test("resumen de DDL sin ejecutar SQL", () => {
    const [, integrity, versions] = loadJournal(drizzleDir).entries
    assert.ok(summarizeDdl(integrity).operations.includes("ALTER TABLE biblib.books ADD CONSTRAINT books_owner_shelf_fk"))
    assert.deepEqual(summarizeDdl(versions).operations, ["ALTER TABLE biblib.books ADD COLUMN version", "CREATE FUNCTION biblib.rotate_book_version()", "CREATE TRIGGER books_rotate_version"])
  })
})

describe("ledger", () => {
  const { entries } = loadJournal(drizzleDir)

  test("aplicado completo, parcial y vacío", () => {
    assert.deepEqual(compareLedger(entries, rowsFor(entries)).pending, [])
    const partial = compareLedger(entries, rowsFor(entries, 1))
    assert.equal(partial.appliedHead.tag, "0000_biblib_init")
    assert.deepEqual(partial.pending, ["0001_library_integrity", "0002_book_versions"])
    assert.equal(compareLedger(entries, []).pending.length, 3)
  })

  test("hash legacy CRLF exige conciliación y no se reescribe", () => {
    const rows = rowsFor(entries, 3, (e) => e.tag === "0000_biblib_init" ? e.crlfHash : e.hash)
    const before = clone(rows)
    const result = compareLedger(entries, rows)
    assert.equal(result.migrations[0].status, "legacy-crlf")
    assert.ok(result.problems.some((p) => p.id === "ledger.legacy-crlf" && /Conciliación requerida/.test(p.message)))
    assert.deepEqual(result.pending, [])
    assert.deepEqual(rows, before)
    const state = classify({ entries }, { biblib: true, ledger: true, rows }, facts)
    assert.equal(state.state, "reconciliation-required")
    assert.equal(state.code, EXIT.HISTORY_DIVERGED)
  })

  test("hash no reconocido, fila desconocida, duplicado y entrada retroactiva", () => {
    assert.equal(compareLedger(entries, rowsFor(entries, 2, (e) => e.idx === 1 ? "0".repeat(64) : e.hash)).migrations[1].status, "hash-mismatch")
    assert.ok(compareLedger(entries, [...rowsFor(entries), { id: 9, hash: "x", created_at: 1 }]).problems.some((p) => p.id === "ledger.unknown"))
    assert.ok(compareLedger(entries, [...rowsFor(entries, 1), ...rowsFor(entries, 1)]).problems.some((p) => p.id === "ledger.duplicate"))
    // 0001 se habría insertado en el journal después de aplicar 0002: el migrador la omitiría.
    const retro = compareLedger(entries, rowsFor(entries).filter((r) => r.created_at !== entries[1].when))
    assert.equal(retro.migrations[1].status, "retroactive")
    assert.ok(retro.problems.some((p) => p.id === "ledger.retroactive"))
  })

  test("esquema presente sin historial exige adopción; base vacía no", () => {
    const adoption = classify({ entries }, { biblib: true, ledger: false, rows: [] }, facts)
    assert.equal(adoption.state, "adoption-required")
    assert.equal(adoption.code, EXIT.HISTORY_DIVERGED)
    assert.match(adoption.checks[0].message, /adopción de historial necesaria/)
    assert.equal(classify({ entries }, { biblib: true, ledger: true, rows: [] }, facts).state, "adoption-required")
    const empty = classify({ entries }, { biblib: false, ledger: false, rows: [] }, { ...facts, tables: [] })
    assert.equal(empty.state, "empty")
    assert.equal(empty.code, EXIT.OK)
    const noAuth = classify({ entries }, { biblib: false, ledger: false, rows: [] }, { ...facts, prerequisites: { users: false, uid: true } })
    assert.equal(noAuth.code, EXIT.SERVICE_UNAVAILABLE)
    assert.equal(classify({ entries }, { biblib: false, ledger: true, rows: rowsFor(entries) }, facts).state, "diverged")
  })
})

describe("manifest de objetos", () => {
  test("los metadatos reales tras 0002 cumplen el manifest", () => {
    const checks = verifyManifest(facts, MANIFEST_MIGRATIONS)
    assert.deepEqual(failing(checks), [])
    assert.ok(checks.length >= 35)
    assert.equal(expectedObjects().triggers[0], "books_rotate_version:BEFORE INSERT OR UPDATE ROW")
  })

  test("drift de trigger, función y políticas se detecta por metadatos", () => {
    const noTrigger = { ...facts, triggers: [] }
    assert.deepEqual(failing(verifyManifest(noTrigger, MANIFEST_MIGRATIONS)), ["trigger.books_rotate_version"])
    const after = clone(facts); after.triggers[0].tgtype = 21 // AFTER INSERT OR UPDATE ROW
    assert.deepEqual(failing(verifyManifest(after, MANIFEST_MIGRATIONS)), ["trigger.books_rotate_version"])
    const disabled = clone(facts); disabled.triggers[0].enabled = "D"
    assert.deepEqual(failing(verifyManifest(disabled, MANIFEST_MIGRATIONS)), ["trigger.books_rotate_version"])
    const body = clone(facts); body.functions[0].body = "BEGIN RETURN NEW; END;"
    assert.deepEqual(failing(verifyManifest(body, MANIFEST_MIGRATIONS)), ["function.rotate_book_version"])
    const searchPath = clone(facts); searchPath.functions[0].config = null
    assert.deepEqual(failing(verifyManifest(searchPath, MANIFEST_MIGRATIONS)), ["function.rotate_book_version"])
    const open = clone(facts); open.policies.find((p) => p.name === "books_select_own").using = "true"
    assert.deepEqual(failing(verifyManifest(open, MANIFEST_MIGRATIONS)), ["policy.books_select_own"])
    const roles = clone(facts); roles.policies.find((p) => p.name === "books_delete_own").roles = ["public"]
    assert.deepEqual(failing(verifyManifest(roles, MANIFEST_MIGRATIONS)), ["policy.books_delete_own"])
    const extra = clone(facts); extra.policies.push({ ...extra.policies[0], name: "shelves_select_all", using: "true" })
    assert.deepEqual(failing(verifyManifest(extra, MANIFEST_MIGRATIONS)), ["policy.shelves_select_all"])
    const rls = clone(facts); rls.tables.find((t) => t.name === "books").rls = false
    assert.deepEqual(failing(verifyManifest(rls, MANIFEST_MIGRATIONS)), ["rls.books"])
    const anon = clone(facts); anon.grants.push({ grantee: "anon", table: "books", privilege: "SELECT" })
    assert.deepEqual(failing(verifyManifest(anon, MANIFEST_MIGRATIONS)), ["grant.anon.books"])
    const fk = clone(facts); fk.constraints.find((c) => c.name === "books_owner_shelf_fk").on_delete = "c"
    assert.deepEqual(failing(verifyManifest(fk, MANIFEST_MIGRATIONS)), ["constraint.books_owner_shelf_fk"])
  })

  test("la comparación es semántica, no de pretty-print", () => {
    const reformatted = clone(facts)
    const policy = reformatted.policies.find((p) => p.name === "shelves_update_own")
    policy.using = "(user_id = auth.uid())\n  AND (NOT is_default)"
    reformatted.functions[0].body = "begin\n\tNEW.version :=   gen_random_uuid(); -- rota\n\treturn NEW;\nend;"
    assert.deepEqual(failing(verifyManifest(reformatted, MANIFEST_MIGRATIONS)), [])
    assert.equal(normalizeExpression("((status = ANY (ARRAY['read'::text])))"), "status=anyarray['read']")
  })

  test("el manifest depende del head aplicado", () => {
    // Con solo 0000 aplicado se espera books_shelf_fk y no los objetos de 0001/0002.
    const failures = failing(verifyManifest(facts, ["0000_biblib_init"]))
    assert.ok(failures.includes("constraint.books_shelf_fk"))
    assert.ok(failures.includes("policy.shelves_update_own"))
    assert.ok(!failures.some((id) => id.startsWith("trigger.") || id.startsWith("function.")))
    assert.deepEqual(verifyManifest(facts, []), [])
  })

  test("drift sobre un historial correcto devuelve 5 sin proponer reaplicar", () => {
    const { entries } = loadJournal(drizzleDir)
    const state = classify({ entries }, { biblib: true, ledger: true, rows: rowsFor(entries) }, { ...facts, triggers: [] })
    assert.equal(state.state, "drift")
    assert.equal(state.code, EXIT.HISTORY_DIVERGED)
    assert.deepEqual(state.pending, [])
    assert.match(state.checks.find((c) => c.id === "manifest.drift").message, /no se corrige reaplicando/)
  })
})

describe("plan", () => {
  const journal = loadJournal(drizzleDir)
  const resolved = { target: { target: "local" }, profile: "scratch", project: "biblib-scratch", fingerprint: "f".repeat(64) }
  const inspection = classify(journal, { biblib: false, ledger: false, rows: [] }, { ...facts, tables: [] })
  const commit = { sha: "a".repeat(40), drizzleClean: true }
  const now = new Date("2026-10-23T12:00:00Z")
  const plan = buildPlan({ resolved, journal, inspection, commit, drizzle: "0.45.2", now })
  const current = { target: "local", project: "biblib-scratch", profile: "scratch", fingerprint: "f".repeat(64), commit, drizzle: "0.45.2", journal }
  const validate = (doc, overrides = {}) => validatePlan(doc, { expectProject: "biblib-scratch", expectPlan: doc.planHash, current, now: new Date(now.getTime() + 60000), ...overrides })

  test("documento versionado con hash propio, caducidad a 30 minutos y sin secretos", () => {
    for (const key of ["schemaVersion", "kind", "target", "fingerprint", "commit", "appliedHead", "expectedHead", "migrations", "pending", "ddlSummary", "expectedObjects", "risks", "prerequisites", "createdAt", "expiresAt", "planHash"]) assert.ok(key in plan, key)
    assert.equal(plan.kind, "migrate")
    assert.equal(plan.planHash, computePlanHash(plan))
    assert.equal(Date.parse(plan.expiresAt) - Date.parse(plan.createdAt), 30 * 60 * 1000)
    assert.deepEqual(plan.pending, MANIFEST_MIGRATIONS)
    assert.doesNotMatch(JSON.stringify(plan), /postgres(?:ql)?:\/\/|eyJ[\w-]+\.|service_role|password/i)
    assert.equal(canonical({ b: 1, a: [2, { d: 1, c: 0 }] }), canonical({ a: [2, { c: 0, d: 1 }], b: 1 }))
    assert.equal(validate(plan), plan)
  })

  test("plan caducado, de otro proyecto u otro hash se rechaza", () => {
    assert.throws(() => validate(plan, { now: new Date(now.getTime() + 31 * 60000) }), { code: EXIT.PLAN_REJECTED })
    assert.throws(() => validate(plan, { expectProject: "biblib-local" }), { code: EXIT.IDENTITY_MISMATCH })
    assert.throws(() => validate(plan, { current: { ...current, project: "holaerp" } }), { code: EXIT.IDENTITY_MISMATCH })
    assert.throws(() => validate(plan, { current: { ...current, fingerprint: "e".repeat(64) } }), { code: EXIT.IDENTITY_MISMATCH })
    assert.throws(() => validate(plan, { expectPlan: "b".repeat(64) }), { code: EXIT.PLAN_REJECTED })
    assert.throws(() => validate(plan, { expectPlan: "corto" }), { code: EXIT.INVALID_ARGS })
    const tampered = { ...plan, pending: [] }
    assert.throws(() => validate(tampered, { expectPlan: plan.planHash }), { code: EXIT.PLAN_REJECTED })
    const reset = { ...plan, kind: "reset-local" }; reset.planHash = computePlanHash(reset)
    assert.throws(() => validate(reset), { code: EXIT.PLAN_REJECTED })
    assert.throws(() => validate(plan, { current: { ...current, commit: { sha: "c".repeat(40) } } }), { code: EXIT.PLAN_REJECTED })
  })

  test("bytes o journal distintos de los planificados invalidan el plan", () => {
    const dir = migrationsCopy()
    writeFileSync(path.join(dir, "0002_book_versions.sql"), `${readFileSync(path.join(dir, "0002_book_versions.sql"), "utf8")}-- cambio\n`)
    assert.throws(() => validate(plan, { current: { ...current, journal: loadJournal(dir) } }), { code: EXIT.PLAN_REJECTED })
    assert.throws(() => validate(plan, { current: { ...current, journal: { ...journal, journalHash: "0".repeat(64) } } }), { code: EXIT.PLAN_REJECTED })
  })

  test("bajo bloqueo, un head distinto del planificado devuelve 6 y el drift 5", () => {
    const applied = classify(journal, { biblib: true, ledger: true, rows: rowsFor(journal.entries) }, facts)
    assert.throws(() => assertPlanMatchesTarget(plan, applied), { code: EXIT.PLAN_REJECTED })
    const drift = classify(journal, { biblib: true, ledger: true, rows: rowsFor(journal.entries) }, { ...facts, triggers: [] })
    assert.throws(() => assertPlanMatchesTarget(plan, drift), { code: EXIT.HISTORY_DIVERGED })
    assert.doesNotThrow(() => assertPlanMatchesTarget(plan, inspection))
  })

  test("--out obligatorio y limitado a .biblib/plans", () => {
    assert.throws(() => parsePlanArgs(["local"]), { code: EXIT.INVALID_ARGS })
    assert.equal(parsePlanArgs(["local", "--out", "p.json", "--profile", "scratch"]).profile, "scratch")
    assert.equal(resolvePlanPath("p.json", repo), path.join(repo, ".biblib", "plans", "p.json"))
    assert.equal(resolvePlanPath(".biblib/plans/p.json", repo), path.join(repo, ".biblib", "plans", "p.json"))
    for (const out of ["../p.json", "drizzle/p.json", "p.txt", path.join(tmpdir(), "p.json")]) assert.throws(() => resolvePlanPath(out, repo), { code: EXIT.INVALID_ARGS })
  })
})

describe("argumentos y despachador", () => {
  test("preprod/prod se rechazan con mensaje claro hasta U-INF-07", () => {
    for (const target of ["preprod", "prod"]) {
      assert.throws(() => parsePlanArgs([target, "--out", "p.json"]), (error) => error.code === EXIT.INVALID_ARGS && /U-INF-07/.test(error.message))
      assert.throws(() => parseArgs(["apply", target, "--plan", "p.json", "--expect-project", "x", "--expect-plan", "y"]), (error) => error.code === EXIT.INVALID_ARGS && /U-INF-07/.test(error.message))
      assert.throws(() => parseArgs(["status", target]), { code: EXIT.INVALID_ARGS })
    }
  })

  test("migrate exige plan, proyecto y hash, y no admite URLs ni flags reenviados", () => {
    assert.deepEqual(parseArgs(["apply", "local", "--plan", "p.json", "--expect-project", "biblib-scratch", "--expect-plan", "a".repeat(64)]), { command: "apply", target: "local", json: false, plan: "p.json", expectProject: "biblib-scratch", expectPlan: "a".repeat(64) })
    for (const args of [["apply", "local", "--plan", "p.json"], ["apply", "local", "--plan", "p.json", "--expect-project", "x", "--expect-plan", "y", "--db-url", "postgres://remoto"], ["apply", "local", "--plan", "p.json", "--plan", "q.json", "--expect-project", "x", "--expect-plan", "y"], ["status", "local", "--force"], ["reset", "local"]]) {
      assert.throws(() => parseArgs(args), { code: EXIT.INVALID_ARGS })
    }
  })

  test("db:migrate es un despachador que no aplica nada y sale con 2", () => {
    const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"))
    assert.equal(pkg.scripts["db:migrate"], "node scripts/db/migrate.mjs legacy")
    assert.equal(pkg.scripts["db:migrate:local"], "node scripts/db/migrate.mjs apply local")
    assert.equal(pkg.scripts["db:plan:local"], "node scripts/db/plan.mjs local")
    assert.equal(pkg.scripts["db:status:local"], "node scripts/db/migrate.mjs status local")
    assert.equal(legacyDispatcher().code, EXIT.INVALID_ARGS)
    const result = spawnSync(process.execPath, [path.join(repo, "scripts/db/migrate.mjs"), "legacy"], { cwd: repo, encoding: "utf8", env: { ...process.env, SUPABASE_DB_URL: "postgresql://remoto:secreto@db.example.supabase.co:5432/postgres" } })
    assert.equal(result.status, EXIT.INVALID_ARGS)
    for (const command of EXPLICIT_COMMANDS) assert.ok(result.stderr.includes(command))
    assert.doesNotMatch(result.stdout + result.stderr, /secreto|example\.supabase/)
  })

  test("drizzle.config.ts declara el mismo ledger y no carga archivos de entorno", () => {
    const config = readFileSync(path.join(repo, "drizzle.config.ts"), "utf8")
    assert.match(config, /schema: "drizzle"/)
    assert.match(config, /table: "__drizzle_migrations"/)
    assert.doesNotMatch(config, /loadEnvFile|dbCredentials/)
  })
})

// Pruebas con el stack scratch real. Se omiten con BIBLIB_SKIP_STACK_TESTS=1 o si scratch no está
// arrancado y acreditado desde este checkout. No dejan cambios: usan transacciones revertidas.
const stack = { reason: "BIBLIB_SKIP_STACK_TESTS=1" }
if (process.env.BIBLIB_SKIP_STACK_TESTS !== "1") {
  try {
    stack.resolved = await resolveLocal("scratch")
    stack.reason = null
  } catch (error) { stack.reason = `stack scratch no disponible (${error.code ?? "?"})` }
}

describe("stack scratch real [stack]", { skip: stack.reason ?? false }, () => {
  test("drift de trigger y política detectado dentro de una transacción revertida", async (t) => {
    const journal = loadJournal(drizzleDir)
    const sql = connect(stack.resolved, { applicationName: "biblib-test" })
    try {
      const before = await inspectDatabase(sql, journal)
      if (before.state !== "up-to-date") { t.skip(`scratch no está al día (${before.state})`); return }
      await sql.begin(async (tx) => {
        await tx`drop trigger books_rotate_version on biblib.books`
        await tx`alter policy books_select_own on biblib.books using (true)`
        const drift = await inspectDatabase(tx, journal)
        assert.equal(drift.state, "drift")
        assert.deepEqual(failing(drift.manifest).sort(), ["policy.books_select_own", "trigger.books_rotate_version"])
        throw new Error("revertir") // la transacción se revierte: scratch queda intacto
      }).catch((error) => { if (error.message !== "revertir") throw error })
      assert.equal((await inspectDatabase(sql, journal)).state, "up-to-date")
    } finally { await closeConnection(sql) }
  })

  test("el bloqueo ocupado devuelve 7 sin aplicar nada", async () => {
    const holder = connect(stack.resolved, { applicationName: "biblib-test-lock" })
    const waiter = connect(stack.resolved, { applicationName: "biblib-test-wait" })
    try {
      await acquireMigrationLock(holder, { waitMs: 0 })
      await assert.rejects(acquireMigrationLock(waiter, { waitMs: 300, pollMs: 50 }), { code: EXIT.LOCK_BUSY })
      await releaseMigrationLock(holder)
      assert.deepEqual(await acquireMigrationLock(waiter, { waitMs: 300 }), { waited: false })
      await releaseMigrationLock(waiter)
    } finally { await closeConnection(holder); await closeConnection(waiter) }
  })

  test("un error intermedio revierte el conjunto y no adelanta el ledger (9)", async (t) => {
    const dir = migrationsCopy()
    // El segundo paso falla siempre (columna duplicada, 42701), haya o no filas en la base.
    writeFileSync(path.join(dir, "0003_u_inf_04_fallo.sql"), "CREATE TABLE biblib.u_inf_04_probe (id integer);\n--> statement-breakpoint\nALTER TABLE biblib.u_inf_04_probe ADD COLUMN id integer;\n")
    editJournal(dir, (j) => { j.entries.push({ idx: 3, version: "7", when: 1792700000000, tag: "0003_u_inf_04_fallo", breakpoints: true }) })
    const journal = loadJournal(dir)
    const sql = connect(stack.resolved, { applicationName: "biblib-test" })
    try {
      const inspection = await inspectDatabase(sql, journal)
      if (inspection.state !== "pending" || inspection.pending.join() !== "0003_u_inf_04_fallo") { t.skip(`scratch no está en 0002 (${inspection.state})`); return }
      const ledgerBefore = await readLedger(sql)
      const plan = buildPlan({ resolved: stack.resolved, journal, inspection, commit: { sha: "0".repeat(40), drizzleClean: true }, drizzle: "0.45.2" })
      const failure = await applyPlan(sql, { plan, journal, migrationsDir: dir, waitMs: 2000 }).then(() => null, (error) => error)
      assert.equal(failure?.code, EXIT.MIGRATION_FAILED)
      assert.equal(failure.report.previousHead.tag, "0002_book_versions")
      assert.equal(failure.report.failedChange, "0003_u_inf_04_fallo")
      assert.match(failure.report.result, /revertido/)
      assert.deepEqual((await readLedger(sql)).rows, ledgerBefore.rows)
      const [{ probe }] = await sql`select to_regclass('biblib.u_inf_04_probe') is not null as probe`
      assert.equal(probe, false)
    } finally { await closeConnection(sql) }
  })
})
