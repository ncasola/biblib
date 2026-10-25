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
// Metadatos reales capturados de Supabase local: tras 0002 (U-INF-04), tras 0003 (U-DAT-01), tras 0004 (U-DAT-05), tras 0005 (U-DAT-03), tras 0006 (U-DAT-02), tras 0007 (U-EXP-02), tras 0008 (U-DAT-04), tras 0009 (U-DAT-10), tras 0010, 0011 y 0012 (U-DAT-06), tras 0013 (U-OPS-03) y tras 0014 (lote de producto de O13, head actual).
const facts0002 = JSON.parse(readFileSync(path.join(repo, "tests/fixtures/migrations/objects-0002.json"), "utf8"))
const facts0003 = JSON.parse(readFileSync(path.join(repo, "tests/fixtures/migrations/objects-0003.json"), "utf8"))
const facts0004 = JSON.parse(readFileSync(path.join(repo, "tests/fixtures/migrations/objects-0004.json"), "utf8"))
const facts0005 = JSON.parse(readFileSync(path.join(repo, "tests/fixtures/migrations/objects-0005.json"), "utf8"))
const facts0006 = JSON.parse(readFileSync(path.join(repo, "tests/fixtures/migrations/objects-0006.json"), "utf8"))
const facts0007 = JSON.parse(readFileSync(path.join(repo, "tests/fixtures/migrations/objects-0007.json"), "utf8"))
const facts0008 = JSON.parse(readFileSync(path.join(repo, "tests/fixtures/migrations/objects-0008.json"), "utf8"))
const facts0009 = JSON.parse(readFileSync(path.join(repo, "tests/fixtures/migrations/objects-0009.json"), "utf8"))
const facts0010 = JSON.parse(readFileSync(path.join(repo, "tests/fixtures/migrations/objects-0010.json"), "utf8"))
const facts0011 = JSON.parse(readFileSync(path.join(repo, "tests/fixtures/migrations/objects-0011.json"), "utf8"))
const facts0012 = JSON.parse(readFileSync(path.join(repo, "tests/fixtures/migrations/objects-0012.json"), "utf8"))
const facts0013 = JSON.parse(readFileSync(path.join(repo, "tests/fixtures/migrations/objects-0013.json"), "utf8"))
const facts = JSON.parse(readFileSync(path.join(repo, "tests/fixtures/migrations/objects-0014.json"), "utf8"))
const HEAD_0010 = MANIFEST_MIGRATIONS.slice(0, 11)
const named = (list, name) => list.find((item) => item.name === name)
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
    assert.deepEqual(partial.pending, ["0001_library_integrity", "0002_book_versions", "0003_library_revision", "0004_catalogue_coordination", "0005_library_jobs", "0006_library_snapshots", "0007_saved_views", "0008_restore_sessions", "0009_cover_assets", "0010_works_editions_copies", "0011_copies_cutover", "0012_model_account_deletion", "0013_account_deletion", "0014_product_batch_o13"])
    assert.equal(compareLedger(entries, []).pending.length, entries.length)
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
  test("los metadatos reales tras 0006 cumplen su prefijo", () => { assert.deepEqual(failing(verifyManifest(facts0006, MANIFEST_MIGRATIONS.slice(0, 7))), []) })

  test("los metadatos reales tras 0002 cumplen el manifest de 0000→0002", () => {
    const checks = verifyManifest(facts0002, MANIFEST_MIGRATIONS.slice(0, 3))
    assert.deepEqual(failing(checks), [])
    assert.ok(checks.length >= 35)
  })

  test("los metadatos reales tras 0003 cumplen el manifest de 0000→0003", () => {
    const checks = verifyManifest(facts0003, MANIFEST_MIGRATIONS.slice(0, 4))
    assert.deepEqual(failing(checks), [])
    assert.ok(checks.length >= 75)
  })

  test("los metadatos reales tras 0004 cumplen el manifest de 0000→0004", () => {
    const checks = verifyManifest(facts0004, MANIFEST_MIGRATIONS.slice(0, 5))
    assert.deepEqual(failing(checks), [])
    assert.ok(checks.length >= 135)
  })

  test("los metadatos reales tras 0005 cumplen el manifest de 0000→0005", () => {
    const checks = verifyManifest(facts0005, MANIFEST_MIGRATIONS.slice(0, 6))
    assert.deepEqual(failing(checks), [])
    assert.ok(checks.length >= 190)
  })

  test("los metadatos reales tras 0007 cumplen su prefijo", () => { assert.deepEqual(failing(verifyManifest(facts0007, MANIFEST_MIGRATIONS.slice(0, 8))), []) })

  test("los metadatos reales tras 0008 cumplen su prefijo", () => { assert.deepEqual(failing(verifyManifest(facts0008, MANIFEST_MIGRATIONS.slice(0, 9))), []) })

  test("los metadatos reales tras 0009 cumplen su prefijo y los de 0010 el head 0010", () => {
    assert.deepEqual(failing(verifyManifest(facts0009, HEAD_0010.slice(0, 10))), [])
    // Objetos de la tabla books anteriores a 0011 (U-DAT-06): se comprueban con el head 0010, en el que aún existen.
    const facts = facts0010, MANIFEST_MIGRATIONS = HEAD_0010
    const checks = verifyManifest(facts, MANIFEST_MIGRATIONS)
    assert.deepEqual(failing(checks), [])
    assert.ok(checks.length >= 320)
    // Antes de 0008 faltan las tablas y la guarda de staging; un head anterior marca sus políticas como no declaradas.
    assert.ok(failing(verifyManifest(facts0007, MANIFEST_MIGRATIONS)).includes("function.guard_import_staging"))
    assert.ok(failing(verifyManifest(facts, MANIFEST_MIGRATIONS.slice(0, 8))).includes("policy.import_sessions_select_own"))
    // Un head anterior que aún no conoce los trabajos o las versiones anteriores marca sus políticas como no declaradas.
    assert.ok(failing(verifyManifest(facts, MANIFEST_MIGRATIONS.slice(0, 5))).includes("policy.library_jobs_select_own"))
    assert.ok(failing(verifyManifest(facts, MANIFEST_MIGRATIONS.slice(0, 6))).includes("policy.library_snapshots_select_own"))
    // Antes de 0006 faltan las funciones de captura: los metadatos de 0005 no cumplen el manifest completo.
    assert.ok(failing(verifyManifest(facts0005, MANIFEST_MIGRATIONS)).includes("function.library_snapshot_capture"))
    assert.equal(expectedObjects(MANIFEST_MIGRATIONS).triggers[0], "books_rotate_version:BEFORE INSERT OR UPDATE ROW")
    assert.deepEqual(expectedObjects(MANIFEST_MIGRATIONS).triggers.slice(1, 3), ["books_rotate_library_revision:AFTER INSERT OR UPDATE OR DELETE ROW", "shelves_rotate_library_revision:AFTER INSERT OR UPDATE OR DELETE ROW"])
    // Las tablas de 0003 con RLS y un head anterior que aún no las conoce marcan drift.
    assert.ok(failing(verifyManifest(facts, MANIFEST_MIGRATIONS.slice(0, 3))).includes("policy.library_state_select_own"))
    assert.ok(failing(verifyManifest(facts, MANIFEST_MIGRATIONS.slice(0, 4))).includes("policy.catalogue_private_cache_select_own"))
  })

  test("drift de la coordinación del catálogo (0004): acceso de cliente, seguridad y fencing", () => {
    for (const table of ["catalogue_cache", "catalogue_inflight", "catalogue_quota_buckets", "catalogue_quota_reservations"]) {
      const exposed = clone(facts); exposed.grants.push({ grantee: "authenticated", table, privilege: "SELECT" })
      assert.deepEqual(failing(verifyManifest(exposed, MANIFEST_MIGRATIONS)), [`grant.authenticated.${table}`])
    }
    const writable = clone(facts); writable.grants.push({ grantee: "authenticated", table: "catalogue_private_cache", privilege: "INSERT" })
    assert.deepEqual(failing(verifyManifest(writable, MANIFEST_MIGRATIONS)), ["grant.authenticated.catalogue_private_cache"])
    const callable = clone(facts); named(callable.functions, "catalogue_begin").execute_authenticated = true
    assert.deepEqual(failing(verifyManifest(callable, MANIFEST_MIGRATIONS)), ["function.catalogue_begin"])
    const anon = clone(facts); named(anon.functions, "catalogue_reserve").execute_anon = true
    assert.deepEqual(failing(verifyManifest(anon, MANIFEST_MIGRATIONS)), ["function.catalogue_reserve"])
    const invoker = clone(facts); named(invoker.functions, "catalogue_complete").security_definer = false
    assert.deepEqual(failing(verifyManifest(invoker, MANIFEST_MIGRATIONS)), ["function.catalogue_complete"])
    const path = clone(facts); named(path.functions, "catalogue_release").config = ["search_path=public"]
    assert.deepEqual(failing(verifyManifest(path, MANIFEST_MIGRATIONS)), ["function.catalogue_release"])
    // Una publicación sin comprobar el testigo deja de ser la función declarada.
    const unfenced = clone(facts); named(unfenced.functions, "catalogue_complete").body = named(unfenced.functions, "catalogue_complete").body.replace("AND f.fence = p_fence AND f.lease_expires_at > now_at", "")
    assert.deepEqual(failing(verifyManifest(unfenced, MANIFEST_MIGRATIONS)), ["function.catalogue_complete"])
    const outage = clone(facts); named(outage.constraints, "catalogue_cache_status_check").definition = "CHECK ((status = ANY (ARRAY['found'::text, 'unavailable'::text])))"
    assert.deepEqual(failing(verifyManifest(outage, MANIFEST_MIGRATIONS)), ["constraint.catalogue_cache_status_check"])
    const open = clone(facts); named(open.policies, "catalogue_private_cache_select_own").using = "true"
    assert.deepEqual(failing(verifyManifest(open, MANIFEST_MIGRATIONS)), ["policy.catalogue_private_cache_select_own"])
    const noRls = clone(facts); named(noRls.tables, "catalogue_quota_reservations").rls = false
    assert.deepEqual(failing(verifyManifest(noRls, MANIFEST_MIGRATIONS)), ["rls.catalogue_quota_reservations"])
    const extra = clone(facts); extra.policies.push({ ...named(extra.policies, "catalogue_private_cache_select_own"), name: "catalogue_cache_read_all", table: "catalogue_cache", using: "true" })
    assert.deepEqual(failing(verifyManifest(extra, MANIFEST_MIGRATIONS)), ["policy.catalogue_cache_read_all"])
  })

  test("drift de los trabajos (0005): escritura de cliente, ejecutor, fencing y lease", () => {
    for (const table of ["library_jobs", "library_job_items", "account_lifecycle"]) {
      const writable = clone(facts); writable.grants.push({ grantee: "authenticated", table, privilege: "UPDATE" })
      assert.deepEqual(failing(verifyManifest(writable, MANIFEST_MIGRATIONS)), [`grant.authenticated.${table}`])
    }
    for (const name of ["library_job_claim", "library_job_renew", "library_job_fence", "account_set_state", "account_is_active"]) {
      const callable = clone(facts); named(callable.functions, name).execute_authenticated = true
      assert.deepEqual(failing(verifyManifest(callable, MANIFEST_MIGRATIONS)), [`function.${name}`], `${name} no puede ser ejecutable por authenticated`)
    }
    const anon = clone(facts); named(anon.functions, "library_job_create").execute_anon = true
    assert.deepEqual(failing(verifyManifest(anon, MANIFEST_MIGRATIONS)), ["function.library_job_create"])
    const invoker = clone(facts); named(invoker.functions, "library_job_control").security_definer = false
    assert.deepEqual(failing(verifyManifest(invoker, MANIFEST_MIGRATIONS)), ["function.library_job_control"])
    // Un fencing que no compara el número de la reclamación deja de ser la función declarada.
    const unfenced = clone(facts); named(unfenced.functions, "library_job_fence").body = named(unfenced.functions, "library_job_fence").body.replace("OR job.fencing_number <> p_fencing", "")
    assert.deepEqual(failing(verifyManifest(unfenced, MANIFEST_MIGRATIONS)), ["function.library_job_fence"])
    const noSkip = clone(facts); named(noSkip.functions, "library_job_claim").body = named(noSkip.functions, "library_job_claim").body.replace("FOR UPDATE SKIP LOCKED", "")
    assert.deepEqual(failing(verifyManifest(noSkip, MANIFEST_MIGRATIONS)), ["function.library_job_claim"])
    const lease = clone(facts); named(lease.constraints, "library_jobs_lease_check").definition = "CHECK ((attempts >= 0))"
    assert.deepEqual(failing(verifyManifest(lease, MANIFEST_MIGRATIONS)), ["constraint.library_jobs_lease_check"])
    const open = clone(facts); named(open.policies, "library_jobs_select_own").using = "true"
    assert.deepEqual(failing(verifyManifest(open, MANIFEST_MIGRATIONS)), ["policy.library_jobs_select_own"])
    const ownerless = clone(facts); ownerless.constraints = ownerless.constraints.filter((c) => c.name !== "library_job_items_owner_job_fk")
    assert.deepEqual(failing(verifyManifest(ownerless, MANIFEST_MIGRATIONS)), ["constraint.library_job_items_owner_job_fk"])
  })

  test("drift de las versiones anteriores (0006): escritura de cliente, purga, propietario e índices", () => {
    // Objetos de la tabla books anteriores a 0011 (U-DAT-06): se comprueban con el head 0010, en el que aún existen.
    const facts = facts0010, MANIFEST_MIGRATIONS = HEAD_0010
    for (const table of ["library_snapshots", "library_snapshot_chunks"]) {
      for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
        const writable = clone(facts); writable.grants.push({ grantee: "authenticated", table, privilege })
        assert.deepEqual(failing(verifyManifest(writable, MANIFEST_MIGRATIONS)), [`grant.authenticated.${table}`])
      }
      const readable = clone(facts); readable.grants.push({ grantee: "anon", table, privilege: "SELECT" })
      assert.deepEqual(failing(verifyManifest(readable, MANIFEST_MIGRATIONS)), [`grant.anon.${table}`])
    }
    const purge = clone(facts); named(purge.functions, "library_snapshot_purge_expired").execute_authenticated = true
    assert.deepEqual(failing(verifyManifest(purge, MANIFEST_MIGRATIONS)), ["function.library_snapshot_purge_expired"])
    const anon = clone(facts); named(anon.functions, "library_snapshot_capture").execute_anon = true
    assert.deepEqual(failing(verifyManifest(anon, MANIFEST_MIGRATIONS)), ["function.library_snapshot_capture"])
    // Una captura que no exige la operación de su transacción o que borra para hacer sitio deja de ser la declarada.
    const detached = clone(facts); named(detached.functions, "library_snapshot_capture").body = named(detached.functions, "library_snapshot_capture").body.replace("AND o.created_at = now()", "")
    assert.deepEqual(failing(verifyManifest(detached, MANIFEST_MIGRATIONS)), ["function.library_snapshot_capture"])
    const path = clone(facts); named(path.functions, "library_snapshot_delete").config = ["search_path=public"]
    assert.deepEqual(failing(verifyManifest(path, MANIFEST_MIGRATIONS)), ["function.library_snapshot_delete"])
    const open = clone(facts); named(open.policies, "library_snapshot_chunks_select_own").using = "true"
    assert.deepEqual(failing(verifyManifest(open, MANIFEST_MIGRATIONS)), ["policy.library_snapshot_chunks_select_own"])
    const ownerless = clone(facts); ownerless.constraints = ownerless.constraints.filter((c) => c.name !== "library_snapshot_chunks_owner_snapshot_fk")
    assert.deepEqual(failing(verifyManifest(ownerless, MANIFEST_MIGRATIONS)), ["constraint.library_snapshot_chunks_owner_snapshot_fk"])
    const partial = clone(facts); named(partial.constraints, "library_snapshots_ready_check").definition = "CHECK ((schema_version >= 1))"
    assert.deepEqual(failing(verifyManifest(partial, MANIFEST_MIGRATIONS)), ["constraint.library_snapshots_ready_check"])
    const unindexed = clone(facts); unindexed.indexes = unindexed.indexes.filter((i) => i.name !== "books_user_created_idx")
    assert.deepEqual(failing(verifyManifest(unindexed, MANIFEST_MIGRATIONS)), ["index.books_user_created_idx"])
  })

  test("drift de las sesiones de restauración (0008): trozos mutables, guarda, purga, hash y propietario", () => {
    // Trozos y filas validadas no se modifican nunca; anon no tiene ningún privilegio.
    for (const table of ["import_session_chunks", "import_session_rows"]) {
      const mutable = clone(facts); mutable.grants.push({ grantee: "authenticated", table, privilege: "UPDATE" })
      assert.deepEqual(failing(verifyManifest(mutable, MANIFEST_MIGRATIONS)), [`grant.authenticated.${table}`])
    }
    for (const table of ["import_sessions", "import_session_parts", "import_session_chunks", "import_session_rows"]) {
      const readable = clone(facts); readable.grants.push({ grantee: "anon", table, privilege: "SELECT" })
      assert.deepEqual(failing(verifyManifest(readable, MANIFEST_MIGRATIONS)), [`grant.anon.${table}`])
    }
    const disabled = clone(facts); named(disabled.triggers, "import_session_chunks_guard").enabled = "D"
    assert.deepEqual(failing(verifyManifest(disabled, MANIFEST_MIGRATIONS)), ["trigger.import_session_chunks_guard"])
    const lax = clone(facts); named(lax.functions, "guard_import_staging").body = named(lax.functions, "guard_import_staging").body.replace("AND s.expires_at > now()", "")
    assert.deepEqual(failing(verifyManifest(lax, MANIFEST_MIGRATIONS)), ["function.guard_import_staging"])
    const purge = clone(facts); named(purge.functions, "import_session_purge_expired").execute_authenticated = true
    assert.deepEqual(failing(verifyManifest(purge, MANIFEST_MIGRATIONS)), ["function.import_session_purge_expired"])
    const unhashed = clone(facts); unhashed.constraints = unhashed.constraints.filter((c) => c.name !== "import_session_chunks_sha_check")
    assert.deepEqual(failing(verifyManifest(unhashed, MANIFEST_MIGRATIONS)), ["constraint.import_session_chunks_sha_check"])
    const ownerless = clone(facts); ownerless.constraints = ownerless.constraints.filter((c) => c.name !== "import_session_chunks_owner_part_fk")
    assert.deepEqual(failing(verifyManifest(ownerless, MANIFEST_MIGRATIONS)), ["constraint.import_session_chunks_owner_part_fk"])
    const open = clone(facts); named(open.policies, "import_session_rows_select_own").using = "true"
    assert.deepEqual(failing(verifyManifest(open, MANIFEST_MIGRATIONS)), ["policy.import_session_rows_select_own"])
  })

  test("drift de las portadas privadas (0009): Storage, Google, ejecutor, escritura y propietario", () => {
    // Objetos de la tabla books anteriores a 0011 (U-DAT-06): se comprueban con el head 0010, en el que aún existen.
    const facts = facts0010, MANIFEST_MIGRATIONS = HEAD_0010
    // Bucket público, otros tipos o una política nueva en storage.objects abren las portadas privadas.
    const open = clone(facts); open.storage.buckets[0].public = true
    assert.deepEqual(failing(verifyManifest(open, MANIFEST_MIGRATIONS)), ["storage.bucket.biblib-covers"])
    const svg = clone(facts); svg.storage.buckets[0].allowedMimeTypes = ["image/webp", "image/svg+xml"]
    assert.deepEqual(failing(verifyManifest(svg, MANIFEST_MIGRATIONS)), ["storage.bucket.biblib-covers"])
    const extra = clone(facts); extra.storage.policies.push({ name: "biblib_covers_update_own", cmd: "w", permissive: true, roles: ["authenticated"], using: "true", check: "true" })
    assert.deepEqual(failing(verifyManifest(extra, MANIFEST_MIGRATIONS)), ["storage.policy.biblib_covers_update_own"])
    const lax = clone(facts); named(lax.storage.policies, "biblib_covers_insert_own").check = "(bucket_id = 'biblib-covers'::text)"
    assert.deepEqual(failing(verifyManifest(lax, MANIFEST_MIGRATIONS)), ["storage.policy.biblib_covers_insert_own"])
    const anon = clone(facts); named(anon.storage.policies, "biblib_covers_select_own").roles = ["anon", "authenticated"]
    assert.deepEqual(failing(verifyManifest(anon, MANIFEST_MIGRATIONS)), ["storage.policy.biblib_covers_select_own"])
    const missing = clone(facts); delete missing.storage
    assert.deepEqual(failing(verifyManifest(missing, MANIFEST_MIGRATIONS)), ["storage.bucket.biblib-covers", "storage.policy.biblib_covers_select_own", "storage.policy.biblib_covers_insert_own", "storage.policy.biblib_covers_delete_own"])
    // Sin la guarda de lease y fencing, un trabajador antiguo podría volver a subir.
    const stale = clone(facts); named(stale.functions, "cover_object_access").body = named(stale.functions, "cover_object_access").body.replace("AND j.lease_until > clock_timestamp()", "")
    assert.deepEqual(failing(verifyManifest(stale, MANIFEST_MIGRATIONS)), ["function.cover_object_access"])
    // El ejecutor sin sesión vuelve a reclamar adquisiciones.
    const claim = clone(facts); named(claim.functions, "library_job_claim").body = named(claim.functions, "library_job_claim").body.replace("AND (p_job_id IS NOT NULL OR j.kind <> 'cover_asset')", "")
    assert.deepEqual(failing(verifyManifest(claim, MANIFEST_MIGRATIONS)), ["function.library_job_claim"])
    const google = clone(facts); google.constraints = google.constraints.filter((c) => c.name !== "cover_assets_source_ref_check")
    assert.deepEqual(failing(verifyManifest(google, MANIFEST_MIGRATIONS)), ["constraint.cover_assets_source_ref_check"])
    const write = clone(facts); write.grants.push({ grantee: "authenticated", table: "cover_assets", privilege: "UPDATE" })
    assert.deepEqual(failing(verifyManifest(write, MANIFEST_MIGRATIONS)), ["grant.authenticated.cover_assets"])
    const purge = clone(facts); named(purge.functions, "cover_asset_purge_candidates").execute_authenticated = true
    assert.deepEqual(failing(verifyManifest(purge, MANIFEST_MIGRATIONS)), ["function.cover_asset_purge_candidates"])
    const ownerless = clone(facts); ownerless.constraints = ownerless.constraints.filter((c) => c.name !== "books_owner_cover_asset_fk")
    assert.deepEqual(failing(verifyManifest(ownerless, MANIFEST_MIGRATIONS)), ["constraint.books_owner_cover_asset_fk"])
    const unguarded = clone(facts); named(unguarded.triggers, "books_guard_cover_asset").enabled = "D"
    assert.deepEqual(failing(verifyManifest(unguarded, MANIFEST_MIGRATIONS)), ["trigger.books_guard_cover_asset"])
    // Una restricción ampliada por 0009 se comprueba con su variante: el kind de 0005 ya no basta.
    const narrow = clone(facts); named(narrow.constraints, "library_jobs_kind_check").definition = "CHECK ((kind = ANY (ARRAY['import'::text, 'covers'::text])))"
    assert.deepEqual(failing(verifyManifest(narrow, MANIFEST_MIGRATIONS)), ["constraint.library_jobs_kind_check"])
    // Los metadatos de 0008 no cumplen el manifest de 0009, y los de 0009 no son un head de 0008.
    assert.ok(failing(verifyManifest(facts0008, MANIFEST_MIGRATIONS)).includes("storage.bucket.biblib-covers"))
    assert.ok(failing(verifyManifest(facts, MANIFEST_MIGRATIONS.slice(0, 9))).includes("policy.cover_assets_select_own"))
  })

  test("drift de los objetos de 0003: escritura directa, permisos, seguridad y triggers", () => {
    // Objetos de la tabla books anteriores a 0011 (U-DAT-06): se comprueban con el head 0010, en el que aún existen.
    const facts = facts0010, MANIFEST_MIGRATIONS = HEAD_0010
    const write = clone(facts); write.grants.push({ grantee: "authenticated", table: "library_state", privilege: "UPDATE" })
    assert.deepEqual(failing(verifyManifest(write, MANIFEST_MIGRATIONS)), ["grant.authenticated.library_state"])
    const anonLock = clone(facts); named(anonLock.functions, "lock_library").execute_anon = true
    assert.deepEqual(failing(verifyManifest(anonLock, MANIFEST_MIGRATIONS)), ["function.lock_library"])
    const invoker = clone(facts); named(invoker.functions, "rotate_library_revision").security_definer = false
    assert.deepEqual(failing(verifyManifest(invoker, MANIFEST_MIGRATIONS)), ["function.rotate_library_revision"])
    const callable = clone(facts); named(callable.functions, "rotate_library_revision").execute_authenticated = true
    assert.deepEqual(failing(verifyManifest(callable, MANIFEST_MIGRATIONS)), ["function.rotate_library_revision"])
    const body = clone(facts); named(body.functions, "rotate_library_revision").body = "BEGIN RETURN NULL; END;"
    assert.deepEqual(failing(verifyManifest(body, MANIFEST_MIGRATIONS)), ["function.rotate_library_revision"])
    const disabled = clone(facts); named(disabled.triggers, "shelves_rotate_library_revision").enabled = "D"
    assert.deepEqual(failing(verifyManifest(disabled, MANIFEST_MIGRATIONS)), ["trigger.shelves_rotate_library_revision"])
    const noDelete = clone(facts); named(noDelete.triggers, "books_rotate_library_revision").tgtype = 21 // AFTER INSERT OR UPDATE ROW
    assert.deepEqual(failing(verifyManifest(noDelete, MANIFEST_MIGRATIONS)), ["trigger.books_rotate_library_revision"])
    const openPreviews = clone(facts); named(openPreviews.policies, "import_previews_select_own").using = "true"
    assert.deepEqual(failing(verifyManifest(openPreviews, MANIFEST_MIGRATIONS)), ["policy.import_previews_select_own"])
    const noRls = clone(facts); named(noRls.tables, "library_operations").rls = false
    assert.deepEqual(failing(verifyManifest(noRls, MANIFEST_MIGRATIONS)), ["rls.library_operations"])
  })

  test("drift de trigger, función y políticas se detecta por metadatos", () => {
    // Objetos de la tabla books anteriores a 0011 (U-DAT-06): se comprueban con el head 0010, en el que aún existen.
    const facts = facts0010, MANIFEST_MIGRATIONS = HEAD_0010
    const noTrigger = { ...facts, triggers: facts.triggers.filter((t) => t.name !== "books_rotate_version") }
    assert.deepEqual(failing(verifyManifest(noTrigger, MANIFEST_MIGRATIONS)), ["trigger.books_rotate_version"])
    const after = clone(facts); named(after.triggers, "books_rotate_version").tgtype = 21 // AFTER INSERT OR UPDATE ROW
    assert.deepEqual(failing(verifyManifest(after, MANIFEST_MIGRATIONS)), ["trigger.books_rotate_version"])
    const disabled = clone(facts); named(disabled.triggers, "books_rotate_version").enabled = "D"
    assert.deepEqual(failing(verifyManifest(disabled, MANIFEST_MIGRATIONS)), ["trigger.books_rotate_version"])
    const body = clone(facts); named(body.functions, "rotate_book_version").body = "BEGIN RETURN NEW; END;"
    assert.deepEqual(failing(verifyManifest(body, MANIFEST_MIGRATIONS)), ["function.rotate_book_version"])
    const searchPath = clone(facts); named(searchPath.functions, "rotate_book_version").config = null
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

  test("los metadatos reales tras 0011 cumplen el manifest completo: vista plana, modelo y books_legacy congelada", () => {
    const checks = verifyManifest(facts, MANIFEST_MIGRATIONS)
    assert.deepEqual(failing(checks), [])
    assert.ok(checks.length >= 460)
    // Los metadatos de 0010 no son un head 0011: falta la vista y sobra la sincronización.
    const behind = failing(verifyManifest(facts0010, MANIFEST_MIGRATIONS))
    assert.ok(behind.includes("view.books") && behind.includes("rls.books_legacy") && behind.includes("trigger.books_view_update"))
    assert.ok(expectedObjects().views.includes("biblib.books"))
    assert.ok(!expectedObjects().triggers.some((entry) => entry.startsWith("books_rotate_version")), "books ya no tiene los triggers de la tabla anterior")
  })

  test("0012: la poda del modelo es SECURITY DEFINER para que Auth pueda borrar una cuenta en cascada", () => {
    // Los metadatos reales de 0011 cumplen su head y, con 0012, solo fallan las dos funciones de poda.
    assert.deepEqual(failing(verifyManifest(facts0011, MANIFEST_MIGRATIONS.slice(0, 12))), [])
    assert.deepEqual(failing(verifyManifest(facts0011, MANIFEST_MIGRATIONS.slice(0, 13))).sort(), ["function.prune_orphan_editions", "function.prune_orphan_works"])
    const invoker = clone(facts); named(invoker.functions, "prune_orphan_works").security_definer = false
    assert.deepEqual(failing(verifyManifest(invoker, MANIFEST_MIGRATIONS)), ["function.prune_orphan_works"])
    const callable = clone(facts); named(callable.functions, "prune_orphan_editions").execute_authenticated = true
    assert.deepEqual(failing(verifyManifest(callable, MANIFEST_MIGRATIONS)), ["function.prune_orphan_editions"])
  })

  test("0014: lote de producto con RLS del dueño, cuenta activa, FK del mismo dueño, imágenes privadas y pasos de eliminación", () => {
    // Los metadatos reales de 0013 cumplen su head; con 0014 faltan las tablas, sus guardas, el bucket y las funciones nuevas o sustituidas.
    assert.deepEqual(failing(verifyManifest(facts0013, MANIFEST_MIGRATIONS.slice(0, 14))), [])
    const behind = failing(verifyManifest(facts0013, MANIFEST_MIGRATIONS))
    for (const id of ["rls.tags", "policy.copy_tags_insert_active", "policy.media_assets_select_own", "function.media_asset_register", "function.library_snapshot_capture",
      "function.account_deletion_step_tables", "constraint.account_deletions_step_check", "storage.bucket.biblib-media", "storage.policy.biblib_media_insert_own", "trigger.locations_tree_check"]) assert.ok(behind.includes(id), id)
    // Una guarda de cuenta activa permisiva o ausente deja escribir a un JWT antiguo; una política abierta expone datos de otra cuenta.
    const permissive = clone(facts); named(permissive.policies, "tags_insert_active").permissive = true
    assert.deepEqual(failing(verifyManifest(permissive, MANIFEST_MIGRATIONS)), ["policy.tags_insert_active"])
    const missing = { ...facts, policies: facts.policies.filter((p) => p.name !== "copy_locations_update_active") }
    assert.deepEqual(failing(verifyManifest(missing, MANIFEST_MIGRATIONS)), ["policy.copy_locations_update_active"])
    const open = clone(facts); named(open.policies, "copy_annotations_select_own").using = "true"
    assert.deepEqual(failing(verifyManifest(open, MANIFEST_MIGRATIONS)), ["policy.copy_annotations_select_own"])
    // Las decisiones son de solo inserción y los assets de imagen solo se leen.
    const editable = clone(facts); editable.grants.push({ grantee: "authenticated", table: "review_decisions", privilege: "UPDATE" })
    assert.deepEqual(failing(verifyManifest(editable, MANIFEST_MIGRATIONS)), ["grant.authenticated.review_decisions"])
    const writable = clone(facts); writable.grants.push({ grantee: "authenticated", table: "media_assets", privilege: "INSERT" })
    assert.deepEqual(failing(verifyManifest(writable, MANIFEST_MIGRATIONS)), ["grant.authenticated.media_assets"])
    // FK sin dueño o con cascada donde debe impedir el borrado (ubicación ocupada), purga sin restricciones y bucket público son drift.
    const cascade = clone(facts); named(cascade.constraints, "copy_locations_owner_location_fk").on_delete = "c"
    assert.deepEqual(failing(verifyManifest(cascade, MANIFEST_MIGRATIONS)), ["constraint.copy_locations_owner_location_fk"])
    const purge = clone(facts); named(purge.functions, "media_asset_purge_candidates").execute_authenticated = true
    assert.deepEqual(failing(verifyManifest(purge, MANIFEST_MIGRATIONS)), ["function.media_asset_purge_candidates"])
    const publicBucket = clone(facts); publicBucket.storage.buckets.find((b) => b.id === "biblib-media").public = true
    assert.deepEqual(failing(verifyManifest(publicBucket, MANIFEST_MIGRATIONS)), ["storage.bucket.biblib-media"])
    const lax = clone(facts); named(lax.storage.policies, "biblib_media_insert_own").check = "(bucket_id = 'biblib-media'::text)"
    assert.deepEqual(failing(verifyManifest(lax, MANIFEST_MIGRATIONS)), ["storage.policy.biblib_media_insert_own"])
    // Volver a la captura de 0011 (sin datos de producto) o a los pasos de 0013 (sin product/media) es drift.
    const capture = clone(facts); named(capture.functions, "library_snapshot_capture").body = named(facts0013.functions, "library_snapshot_capture").body
    assert.deepEqual(failing(verifyManifest(capture, MANIFEST_MIGRATIONS)), ["function.library_snapshot_capture"])
    const steps = clone(facts); named(steps.functions, "account_deletion_step_tables").body = named(facts0013.functions, "account_deletion_step_tables").body
    assert.deepEqual(failing(verifyManifest(steps, MANIFEST_MIGRATIONS)), ["function.account_deletion_step_tables"])
  })

  test("0013: eliminación de cuenta con guardas RESTRICTIVE, marca sin privilegios de cliente y funciones administrativas", () => {
    // Los metadatos reales de 0012 cumplen su head; con 0013 faltan la tabla, las guardas y las funciones nuevas o sustituidas.
    assert.deepEqual(failing(verifyManifest(facts0012, MANIFEST_MIGRATIONS.slice(0, 13))), [])
    const behind = failing(verifyManifest(facts0012, MANIFEST_MIGRATIONS))
    for (const id of ["rls.account_deletions", "policy.copies_update_active", "policy.import_session_rows_insert_active", "function.account_deletion_request", "function.lock_library", "function.cover_object_access", "constraint.account_lifecycle_state_check"]) assert.ok(behind.includes(id), id)
    // Una guarda permisiva (OR con la del dueño) o ausente ya no impide escribir a un JWT antiguo.
    const permissive = clone(facts); named(permissive.policies, "shelves_insert_active").permissive = true
    assert.deepEqual(failing(verifyManifest(permissive, MANIFEST_MIGRATIONS)), ["policy.shelves_insert_active"])
    const missing = { ...facts, policies: facts.policies.filter((p) => p.name !== "copies_delete_active") }
    assert.deepEqual(failing(verifyManifest(missing, MANIFEST_MIGRATIONS)), ["policy.copies_delete_active"])
    const bypass = clone(facts); named(bypass.policies, "editions_update_active").check = "true"
    assert.deepEqual(failing(verifyManifest(bypass, MANIFEST_MIGRATIONS)), ["policy.editions_update_active"])
    // La marca y el estado no se leen ni escriben desde el cliente; las funciones administrativas no son una vía del navegador.
    const readable = clone(facts); readable.grants.push({ grantee: "authenticated", table: "account_deletions", privilege: "SELECT" })
    assert.deepEqual(failing(verifyManifest(readable, MANIFEST_MIGRATIONS)), ["grant.authenticated.account_deletions"])
    for (const name of ["account_deletion_claim", "account_deletion_purge", "account_deletion_advance", "account_deletion_complete", "account_deletion_retry", "account_deletion_suppress", "account_residue", "account_set_state"]) {
      const callable = clone(facts); named(callable.functions, name).execute_authenticated = true
      assert.deepEqual(failing(verifyManifest(callable, MANIFEST_MIGRATIONS)), [`function.${name}`], `${name} no puede ser ejecutable por authenticated`)
    }
    const anon = clone(facts); named(anon.functions, "account_deletion_request").execute_anon = true
    assert.deepEqual(failing(verifyManifest(anon, MANIFEST_MIGRATIONS)), ["function.account_deletion_request"])
    // Volver al bloqueo de 0003 (sin guarda) o a la guarda de Storage de 0009 (retirar sin cuenta activa) es drift.
    const unguarded = clone(facts); named(unguarded.functions, "lock_library").body = named(facts0012.functions, "lock_library").body
    assert.deepEqual(failing(verifyManifest(unguarded, MANIFEST_MIGRATIONS)), ["function.lock_library"])
    const storage = clone(facts); named(storage.functions, "cover_object_access").body = named(facts0012.functions, "cover_object_access").body
    assert.deepEqual(failing(verifyManifest(storage, MANIFEST_MIGRATIONS)), ["function.cover_object_access"])
  })

  test("drift del modelo de ejemplares (0010/0011): vista, RLS, FK con dueño, unicidad, permisos y copia congelada", () => {
    const definer = clone(facts); named(definer.views, "books").options = []
    assert.deepEqual(failing(verifyManifest(definer, MANIFEST_MIGRATIONS)), ["view.books"])
    const anonView = clone(facts); anonView.grants.push({ grantee: "anon", table: "books", privilege: "SELECT" })
    assert.deepEqual(failing(verifyManifest(anonView, MANIFEST_MIGRATIONS)), ["grant.anon.view.books"])
    const legacyRead = clone(facts); legacyRead.grants.push({ grantee: "authenticated", table: "books_legacy", privilege: "SELECT" })
    assert.deepEqual(failing(verifyManifest(legacyRead, MANIFEST_MIGRATIONS)), ["grant.authenticated.books_legacy"])
    const legacyPolicy = clone(facts); legacyPolicy.policies.push({ ...named(legacyPolicy.policies, "copies_select_own"), name: "books_select_own", table: "books_legacy" })
    assert.deepEqual(failing(verifyManifest(legacyPolicy, MANIFEST_MIGRATIONS)), ["policy.books_select_own"])
    const open = clone(facts); named(open.policies, "editions_select_own").using = "true"
    assert.deepEqual(failing(verifyManifest(open, MANIFEST_MIGRATIONS)), ["policy.editions_select_own"])
    const noRls = clone(facts); named(noRls.tables, "copies").rls = false
    assert.deepEqual(failing(verifyManifest(noRls, MANIFEST_MIGRATIONS)), ["rls.copies"])
    const cascade = clone(facts); named(cascade.constraints, "copies_owner_edition_fk").on_delete = "c"
    assert.deepEqual(failing(verifyManifest(cascade, MANIFEST_MIGRATIONS)), ["constraint.copies_owner_edition_fk"])
    const ownerless = clone(facts); named(ownerless.constraints, "editions_owner_work_fk").columns = ["work_id"]
    assert.deepEqual(failing(verifyManifest(ownerless, MANIFEST_MIGRATIONS)), ["constraint.editions_owner_work_fk"])
    const duplicated = clone(facts); duplicated.indexes = duplicated.indexes.filter((i) => i.name !== "editions_user_isbn13_unique")
    assert.deepEqual(failing(verifyManifest(duplicated, MANIFEST_MIGRATIONS)), ["index.editions_user_isbn13_unique"])
    const verified = clone(facts); named(verified.constraints, "editions_catalogue_check").definition = "CHECK ((jsonb_typeof(catalogue) = 'object'::text))"
    assert.deepEqual(failing(verifyManifest(verified, MANIFEST_MIGRATIONS)), ["constraint.editions_catalogue_check"])
    const compare = clone(facts); named(compare.functions, "model_compare").execute_authenticated = true
    assert.deepEqual(failing(verifyManifest(compare, MANIFEST_MIGRATIONS)), ["function.model_compare"])
    const viewDefiner = clone(facts); named(viewDefiner.functions, "books_view_insert").security_definer = true
    assert.deepEqual(failing(verifyManifest(viewDefiner, MANIFEST_MIGRATIONS)), ["function.books_view_insert"])
    const unguarded = clone(facts); named(unguarded.triggers, "books_view_update").enabled = "D"
    assert.deepEqual(failing(verifyManifest(unguarded, MANIFEST_MIGRATIONS)), ["trigger.books_view_update"])
    const orphan = { ...facts, triggers: facts.triggers.filter((t) => t.name !== "editions_require_copy") }
    assert.deepEqual(failing(verifyManifest(orphan, MANIFEST_MIGRATIONS)), ["trigger.editions_require_copy"])
    const prune = clone(facts); named(prune.functions, "prune_orphan_editions").body = "BEGIN RETURN NULL; END;"
    assert.deepEqual(failing(verifyManifest(prune, MANIFEST_MIGRATIONS)), ["function.prune_orphan_editions"])
    const coverOnBooks = clone(facts); named(coverOnBooks.functions, "cover_asset_purge_confirm").body = named(facts0009.functions, "cover_asset_purge_confirm").body
    assert.deepEqual(failing(verifyManifest(coverOnBooks, MANIFEST_MIGRATIONS)), ["function.cover_asset_purge_confirm"])
  })

  test("la comparación es semántica, no de pretty-print", () => {
    const reformatted = clone(facts)
    const policy = reformatted.policies.find((p) => p.name === "shelves_update_own")
    policy.using = "(user_id = auth.uid())\n  AND (NOT is_default)"
    named(reformatted.functions, "rotate_book_version").body = "begin\n\tNEW.version :=   gen_random_uuid(); -- rota\n\treturn NEW;\nend;"
    assert.deepEqual(failing(verifyManifest(reformatted, MANIFEST_MIGRATIONS)), [])
    assert.equal(normalizeExpression("((status = ANY (ARRAY['read'::text])))"), "status=anyarray['read']")
  })

  test("el manifest depende del head aplicado", () => {
    // Con solo 0000 aplicado se espera books_shelf_fk y no los objetos de 0001/0002.
    const failures = failing(verifyManifest(facts0002, ["0000_biblib_init"]))
    assert.ok(failures.includes("constraint.books_shelf_fk"))
    assert.ok(failures.includes("policy.shelves_update_own"))
    assert.ok(!failures.some((id) => id.startsWith("trigger.") || id.startsWith("function.")))
    assert.deepEqual(verifyManifest(facts, []), [])
  })

  test("drift sobre un historial correcto devuelve 5 sin proponer reaplicar", () => {
    const { entries } = loadJournal(drizzleDir)
    const state = classify({ entries }, { biblib: true, ledger: true, rows: rowsFor(entries) }, { ...facts, triggers: [] })
    assert.equal(state.state, "drift")
    assert.equal(classify({ entries }, { biblib: true, ledger: true, rows: rowsFor(entries) }, facts).state, "up-to-date")
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
  test("preprod/prod (U-INF-07) exigen --expect-project y no admiten --profile ni --force", () => {
    for (const target of ["preprod", "prod"]) {
      assert.throws(() => parsePlanArgs([target, "--out", "p.json"]), (error) => error.code === EXIT.INVALID_ARGS && /--expect-project/.test(error.message))
      assert.throws(() => parsePlanArgs([target, "--out", "p.json", "--expect-project", "abcdefghij", "--profile", "scratch"]), { code: EXIT.INVALID_ARGS })
      assert.throws(() => parseArgs(["status", target]), { code: EXIT.INVALID_ARGS })
      assert.throws(() => parseArgs(["apply", target, "--plan", "p.json", "--expect-project", "x", "--expect-plan", "y", "--force"]), { code: EXIT.INVALID_ARGS })
      assert.equal(parseArgs(["apply", target, "--plan", "p.json", "--expect-project", "x", "--expect-plan", "y"]).backupReceipt, undefined)
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
        // Desde 0011 (U-DAT-06) books es una vista: el drift se provoca en la tabla de ejemplares.
        await tx`drop trigger copies_rotate_version on biblib.copies`
        await tx`alter policy copies_select_own on biblib.copies using (true)`
        const drift = await inspectDatabase(tx, journal)
        assert.equal(drift.state, "drift")
        assert.deepEqual(failing(drift.manifest).sort(), ["policy.copies_select_own", "trigger.copies_rotate_version"])
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
    // Migración de fallo tras el head del repositorio, sea cual sea su número.
    const { entries: current } = loadJournal(dir)
    const head = current.at(-1).tag
    const tag = `${String(current.length).padStart(4, "0")}_u_inf_04_fallo`
    // El segundo paso falla siempre (columna duplicada, 42701), haya o no filas en la base.
    writeFileSync(path.join(dir, `${tag}.sql`), "CREATE TABLE biblib.u_inf_04_probe (id integer);\n--> statement-breakpoint\nALTER TABLE biblib.u_inf_04_probe ADD COLUMN id integer;\n")
    editJournal(dir, (j) => { j.entries.push({ idx: current.length, version: "7", when: current.at(-1).when + 1000, tag, breakpoints: true }) })
    const journal = loadJournal(dir)
    const sql = connect(stack.resolved, { applicationName: "biblib-test" })
    try {
      const inspection = await inspectDatabase(sql, journal)
      if (inspection.state !== "pending" || inspection.pending.join() !== tag) { t.skip(`scratch no está en ${head} (${inspection.state})`); return }
      const ledgerBefore = await readLedger(sql)
      const plan = buildPlan({ resolved: stack.resolved, journal, inspection, commit: { sha: "0".repeat(40), drizzleClean: true }, drizzle: "0.45.2" })
      const failure = await applyPlan(sql, { plan, journal, migrationsDir: dir, waitMs: 2000 }).then(() => null, (error) => error)
      assert.equal(failure?.code, EXIT.MIGRATION_FAILED)
      assert.equal(failure.report.previousHead.tag, head)
      assert.equal(failure.report.failedChange, tag)
      assert.match(failure.report.result, /revertido/)
      assert.deepEqual((await readLedger(sql)).rows, ledgerBefore.rows)
      const [{ probe }] = await sql`select to_regclass('biblib.u_inf_04_probe') is not null as probe`
      assert.equal(probe, false)
    } finally { await closeConnection(sql) }
  })
})
