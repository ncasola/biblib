import assert from "node:assert/strict"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { analyzeAdoption, compareToPrefix, expectedColumns } from "../../scripts/db/adopt.mjs"
import { buildBackupReceipt, parseBackupArgs, RECEIPT_FILE, writeBackupReceipt } from "../../scripts/db/backup-local.mjs"
import { loadJournal } from "../../scripts/db/journal-guard.mjs"
import { parseArgs } from "../../scripts/db/migrate.mjs"
import { buildPlan, canonical, computePlanHash, parsePlanArgs, validatePlan } from "../../scripts/db/plan.mjs"
import { assertReceiptMatchesDatabase, describeRemote, ledgerHash, RECEIPT_COVERAGE, RECEIPT_KIND, receiptHash, remoteConnectionError, remoteFingerprint, validateBackupReceipt } from "../../scripts/db/remote-preflight.mjs"
import { validateResetBackup } from "../../scripts/db/reset-local.mjs"
import { BACKUP_KIND, MANIFEST_FILE, newBackupId, sealManifest, sha256 } from "../../scripts/lib/backup-files.mjs"
import { EXIT } from "../../scripts/lib/exit-codes.mjs"

const repo = fileURLToPath(new URL("../../", import.meta.url))
const drizzleDir = path.join(repo, "drizzle")
const journal = loadJournal(drizzleDir)
const facts = (n) => JSON.parse(readFileSync(path.join(repo, `tests/fixtures/migrations/objects-${n}.json`), "utf8"))
const clone = (value) => JSON.parse(JSON.stringify(value))
const REF = "abcdefghijklmnopqrst"
const roots = []
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

function workspace() {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "biblib promocion ")))
  roots.push(root)
  mkdirSync(path.join(root, ".biblib", "backups"), { recursive: true })
  cpSync(path.join(repo, "supabase"), path.join(root, "supabase"), { recursive: true, filter: (src) => !src.includes(`${path.sep}.temp`) })
  return root
}

// Entorno remoto inyectado explícitamente (nunca .env): valores ficticios del ensayo.
function remoteEnv(overrides = {}) {
  return {
    NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co`, NEXT_PUBLIC_SUPABASE_ANON_KEY: "clave-publica-ficticia",
    SUPABASE_DB_URL: `postgresql://postgres:contrasena-ficticia@db.${REF}.supabase.co:5432/postgres`,
    BIBLIB_EXPECT_PROJECT_REF: REF, SUPABASE_DB_SSLMODE: "verify-full", ...overrides,
  }
}
const rejects = (fn, code, pattern) => assert.throws(fn, (error) => error.code === code && (!pattern || pattern.test(error.message)))

describe("identidad remota", () => {
  test("descriptor directo y pooler de sesión válidos; la huella no depende de la credencial", () => {
    const direct = describeRemote("prod", { env: remoteEnv(), expectProject: REF })
    assert.deepEqual(direct.redacted(), { target: "prod", project: REF, fingerprint: direct.fingerprint, host: `db.${REF}.supabase.co`, port: 5432, database: "postgres", user: "postgres", connection: "direct", tls: "verify-full" })
    assert.equal(describeRemote("prod", { env: remoteEnv({ SUPABASE_DB_URL: `postgresql://postgres:otra@db.${REF}.supabase.co:5432/postgres` }), expectProject: REF }).fingerprint, direct.fingerprint)
    assert.notEqual(describeRemote("preprod", { env: remoteEnv(), expectProject: REF }).fingerprint, direct.fingerprint)
    const pooler = describeRemote("preprod", { env: remoteEnv({ SUPABASE_DB_URL: `postgresql://postgres.${REF}:x@aws-0-eu-west-3.pooler.supabase.com:5432/postgres` }), expectProject: REF })
    assert.equal(pooler.descriptor.connection, "pooler-session")
    assert.doesNotMatch(JSON.stringify([direct.redacted(), pooler.redacted(), direct.descriptor]), /contrasena|clave-publica/)
    assert.equal(direct.fingerprint, remoteFingerprint({ target: "prod", project: REF, host: `db.${REF}.supabase.co`, port: 5432, database: "postgres", user: "postgres" }))
  })

  test("sin objetivo/ref esperados, host, rol, base o proyecto ajenos: abortan antes de conectar", () => {
    rejects(() => describeRemote("local", { env: remoteEnv(), expectProject: REF }), EXIT.INVALID_ARGS)
    rejects(() => describeRemote("prod", { env: remoteEnv() }), EXIT.INVALID_ARGS, /--expect-project/)
    rejects(() => describeRemote("prod", { env: remoteEnv(), expectProject: "https://x.supabase.co" }), EXIT.INVALID_ARGS)
    rejects(() => describeRemote("prod", { env: remoteEnv(), expectProject: "otroproyecto000000001" }), EXIT.IDENTITY_MISMATCH)
    rejects(() => describeRemote("prod", { env: remoteEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://otroproyecto0000000.supabase.co" }), expectProject: REF }), EXIT.IDENTITY_MISMATCH)
    rejects(() => describeRemote("prod", { env: remoteEnv({ SUPABASE_DB_URL: "postgresql://postgres:x@db.otroproyecto0000000.supabase.co:5432/postgres" }), expectProject: REF }), EXIT.IDENTITY_MISMATCH)
    rejects(() => describeRemote("prod", { env: remoteEnv({ SUPABASE_DB_URL: "postgresql://postgres:x@127.0.0.1:5432/postgres" }), expectProject: REF }), EXIT.IDENTITY_MISMATCH)
    rejects(() => describeRemote("prod", { env: remoteEnv({ SUPABASE_DB_URL: `postgresql://authenticated:x@db.${REF}.supabase.co:5432/postgres` }), expectProject: REF }), EXIT.IDENTITY_MISMATCH, /rol administrativo/)
    rejects(() => describeRemote("prod", { env: remoteEnv({ SUPABASE_DB_URL: `postgresql://postgres:x@db.${REF}.supabase.co:5432/otra` }), expectProject: REF }), EXIT.IDENTITY_MISMATCH)
    rejects(() => describeRemote("prod", { env: remoteEnv({ BIBLIB_EXPECT_PROJECT_REF: undefined }), expectProject: REF }), EXIT.INVALID_ARGS)
  })

  test("un pooler regional no identifica el proyecto; el modo transacción no sirve para DDL/bloqueo", () => {
    rejects(() => describeRemote("prod", { env: remoteEnv({ SUPABASE_DB_URL: "postgresql://postgres:x@aws-0-eu-west-3.pooler.supabase.com:5432/postgres" }), expectProject: REF }), EXIT.IDENTITY_MISMATCH)
    rejects(() => describeRemote("prod", { env: remoteEnv({ SUPABASE_DB_URL: "postgresql://postgres.otroproyecto0000000:x@aws-0-eu-west-3.pooler.supabase.com:5432/postgres" }), expectProject: REF }), EXIT.IDENTITY_MISMATCH)
    rejects(() => describeRemote("prod", { env: remoteEnv({ SUPABASE_DB_URL: `postgresql://postgres.${REF}:x@aws-0-eu-west-3.pooler.supabase.com:6543/postgres` }), expectProject: REF }), EXIT.IDENTITY_MISMATCH, /modo transacción/)
  })

  test("sin TLS verificado (o con sslmode que no verifica el nombre) sale con 3", () => {
    rejects(() => describeRemote("prod", { env: remoteEnv({ SUPABASE_DB_SSLMODE: undefined }), expectProject: REF }), EXIT.IDENTITY_MISMATCH, /TLS/)
    for (const mode of ["disable", "prefer", "require", "verify-ca"]) rejects(() => describeRemote("prod", { env: remoteEnv({ SUPABASE_DB_SSLMODE: mode }), expectProject: REF }), EXIT.IDENTITY_MISMATCH, /verify-full/)
    rejects(() => describeRemote("prod", { env: remoteEnv({ SUPABASE_DB_SSLROOTCERT: "ca.pem" }), expectProject: REF }), EXIT.INVALID_ARGS)
  })

  test("fallos TLS y de credenciales se traducen a 3; el resto a 8, sin SQL ni secretos", () => {
    assert.equal(remoteConnectionError(Object.assign(new Error("Hostname/IP does not match certificate's altnames"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" })).code, EXIT.IDENTITY_MISMATCH)
    assert.equal(remoteConnectionError(Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" })).code, EXIT.IDENTITY_MISMATCH)
    assert.equal(remoteConnectionError(new Error("Client network socket disconnected before secure TLS connection was established")).code, EXIT.IDENTITY_MISMATCH)
    assert.equal(remoteConnectionError(Object.assign(new Error("password authentication failed"), { code: "28P01" })).code, EXIT.IDENTITY_MISMATCH)
    const other = remoteConnectionError(Object.assign(new Error("connect ECONNREFUSED postgres://postgres:secreto@x"), { code: "ECONNREFUSED" }))
    assert.equal(other.code, EXIT.SERVICE_UNAVAILABLE)
    assert.doesNotMatch(other.message, /secreto|postgres:\/\//)
  })
})

describe("argumentos de promoción", () => {
  test("status/plan exigen --expect-project; migrate y adopt, plan y hashes; --force nunca", () => {
    assert.deepEqual(parseArgs(["status", "prod", "--expect-project", REF]), { command: "status", target: "prod", json: false, expectProject: REF })
    assert.equal(parsePlanArgs(["preprod", "--out", "p.json", "--expect-project", REF]).expectProject, REF)
    const full = ["--plan", "p.json", "--expect-project", REF, "--expect-plan", "a".repeat(64), "--backup-receipt", "r.json"]
    assert.equal(parseArgs(["apply", "prod", ...full]).backupReceipt, "r.json")
    assert.equal(parseArgs(["adopt", "preprod", ...full]).command, "adopt")
    for (const args of [["adopt", "prod", ...full, "--force"], ["apply", "prod", "--force", ...full], ["adopt", "local", ...full.slice(0, 6)], ["apply", "prod", ...full, "--db-url", "postgres://x"], ["apply", "prod", ...full, "--profile", "scratch"], ["apply", "local", ...full], ["status", "prod"], ["apply", "staging", ...full]]) {
      assert.throws(() => parseArgs(args), { code: EXIT.INVALID_ARGS }, args.join(" "))
    }
    assert.throws(() => parseArgs(["adopt", "prod", ...full, "--force"]), /no acepta --force/)
  })

  test("package.json expone los comandos remotos sin URL ni flags reenviados", () => {
    const { scripts } = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"))
    for (const target of ["preprod", "prod"]) {
      assert.equal(scripts[`db:status:${target}`], `node scripts/db/migrate.mjs status ${target}`)
      assert.equal(scripts[`db:plan:${target}`], `node scripts/db/plan.mjs ${target}`)
      assert.equal(scripts[`db:migrate:${target}`], `node scripts/db/migrate.mjs apply ${target}`)
      assert.equal(scripts[`db:adopt:${target}`], `node scripts/db/adopt.mjs ${target}`)
    }
    assert.equal(scripts["db:backup:prod"], "node scripts/db/backup-local.mjs prod")
  })
})

describe("plan remoto", () => {
  const remote = { target: { target: "prod" }, profile: null, project: REF, fingerprint: "e".repeat(64) }
  const inspection = { state: "pending", appliedHead: { tag: journal.entries[0].tag, when: journal.entries[0].when, hash: journal.entries[0].hash }, migrations: journal.entries.map((e, i) => ({ tag: e.tag, when: e.when, hash: e.hash, status: i ? "pending" : "applied" })), pending: journal.entries.slice(1).map((e) => e.tag), prerequisites: [] }
  const commit = { sha: "1".repeat(40), drizzleClean: true }
  const current = { target: "prod", project: REF, profile: null, fingerprint: "e".repeat(64), commit, drizzle: "0.45.2", journal }

  test("plan de otro commit, de otro tipo o de otro destino se rechaza antes de conectar", () => {
    const plan = buildPlan({ resolved: remote, journal, inspection, commit, drizzle: "0.45.2", extra: { descriptor: { host: `db.${REF}.supabase.co` } } })
    assert.equal(plan.kind, "migrate")
    assert.equal(validatePlan(plan, { expectProject: REF, expectPlan: plan.planHash, current }), plan)
    rejects(() => validatePlan(plan, { expectProject: REF, expectPlan: plan.planHash, current: { ...current, commit: { sha: "2".repeat(40) } } }), EXIT.PLAN_REJECTED, /commit/)
    rejects(() => validatePlan(plan, { expectProject: REF, expectPlan: plan.planHash, current, kind: "adopt-ledger" }), EXIT.PLAN_REJECTED, /adopt-ledger/)
    rejects(() => validatePlan(plan, { expectProject: REF, expectPlan: plan.planHash, current: { ...current, fingerprint: "d".repeat(64) } }), EXIT.IDENTITY_MISMATCH)
    rejects(() => validatePlan(plan, { expectProject: "otroproyecto0000000", expectPlan: plan.planHash, current }), EXIT.IDENTITY_MISMATCH)
    const adopt = buildPlan({ resolved: remote, journal, inspection: { ...inspection, pending: [] }, commit, drizzle: "0.45.2", kind: "adopt-ledger", extra: { adoption: { head: inspection.appliedHead } } })
    rejects(() => validatePlan(adopt, { expectProject: REF, expectPlan: adopt.planHash, current }), EXIT.PLAN_REJECTED, /migrate y adopt-ledger/)
    assert.equal(computePlanHash(adopt), adopt.planHash)
  })
})

describe("adopción del historial", () => {
  test("esquema manual equivalente a 0002/0003/0004: filas exactas del ledger y evidencia por migración", () => {
    for (const [n, count] of [["0002", 3], ["0003", 4], ["0004", 5]]) {
      const result = analyzeAdoption(facts(n), journal)
      assert.equal(result.proven, true, n)
      assert.equal(result.head.tag, journal.entries[count - 1].tag)
      assert.deepEqual(result.rows, journal.entries.slice(0, count).map((e) => ({ tag: e.tag, hash: e.hash, created_at: e.when })))
      assert.deepEqual(result.pendingAfter, journal.entries.slice(count).map((e) => e.tag))
      assert.equal(result.evidence.length, count)
    }
    const evidence = Object.fromEntries(analyzeAdoption(facts("0002"), journal).evidence.map((e) => [e.tag, e.checks]))
    for (const id of ["rls.books", "policy.books_select_own", "grant.authenticated.books", "constraint.books_user_fk", "index.books_user_id_isbn_unique"]) assert.ok(evidence["0000_biblib_init"].includes(id), id)
    for (const id of ["constraint.books_owner_shelf_fk", "constraint.books_pages_check", "constraint.books_shelf_fk", "index.shelves_user_id_id_unique"]) assert.ok(evidence["0001_library_integrity"].includes(id), id)
    for (const id of ["function.rotate_book_version", "trigger.books_rotate_version", "column.books.version", "table.books"]) assert.ok(evidence["0002_book_versions"].includes(id), id)
  })

  test("drift (sin trigger), política extra o columnas distintas: no se adopta y se propone conciliación", () => {
    const base = facts("0002")
    const noTrigger = { ...clone(base), triggers: base.triggers.filter((t) => t.name !== "books_rotate_version") }
    const drift = analyzeAdoption(noTrigger, journal)
    assert.equal(drift.proven, false)
    assert.equal(drift.reconciliation.closestHead, "0002_book_versions")
    assert.deepEqual(drift.reconciliation.differences.map((d) => d.id), ["trigger.books_rotate_version"])
    assert.match(drift.reconciliation.proposal.join(" "), /corrección hacia delante/)
    assert.equal(drift.rows, undefined)
    const extraPolicy = clone(base)
    extraPolicy.policies.push({ ...extraPolicy.policies[0], name: "books_select_all", using: "true" })
    assert.equal(analyzeAdoption(extraPolicy, journal).proven, false)
    const column = clone(base)
    column.columns.find((c) => c.table === "books" && c.name === "title").not_null = false
    assert.ok(analyzeAdoption(column, journal).reconciliation.differences.some((d) => d.id === "table.books"))
    const names = clone(base)
    names.tables = names.tables.filter((t) => t.name !== "shelves")
    names.columns = names.columns.filter((c) => c.table !== "shelves")
    assert.equal(analyzeAdoption(names, journal).proven, false)
  })

  test("coincidir solo en nombres de tablas no basta: 0002 no equivale a 0000 ni a 0003", () => {
    const base = facts("0002")
    assert.ok(compareToPrefix(base, journal.entries.slice(0, 1).map((e) => e.tag)).some((c) => c.status === "fail" && c.id === "absent.function.rotate_book_version"))
    assert.ok(compareToPrefix(base, journal.entries.slice(0, 4).map((e) => e.tag)).some((c) => c.status === "fail"))
    assert.deepEqual(Object.keys(expectedColumns("0000_biblib_init")).sort(), ["books", "shelves"])
    assert.ok(!expectedColumns("0000_biblib_init").books.some((c) => c.name === "catalogue"))
  })

  test("la huella de hechos no depende del orden de las consultas de catálogo", () => {
    const base = facts("0002")
    const shuffled = Object.fromEntries(Object.entries(clone(base)).map(([k, v]) => [k, Array.isArray(v) ? [...v].reverse() : v]))
    assert.equal(analyzeAdoption(shuffled, journal).factsHash, analyzeAdoption(base, journal).factsHash)
    assert.equal(analyzeAdoption(shuffled, journal).evidenceHash, analyzeAdoption(base, journal).evidenceHash)
  })
})

/** Respaldo con la forma de backup-local (sin Docker) y su informe de ensayo. */
function makeBackup(root, { passed = true, target = "local", fingerprint = "f".repeat(64), head = journal.entries.at(-1).tag, createdAt = new Date().toISOString() } = {}) {
  const backupId = newBackupId("scratch", new Date(createdAt), "abc123")
  const dir = path.join(root, ".biblib", "backups", backupId)
  mkdirSync(path.join(dir, "db"), { recursive: true })
  mkdirSync(path.join(dir, "rehearsals"))
  const files = []
  for (const [role, file, body] of [["domain-dump", "db/biblib-drizzle.sql", "-- volcado ficticio\n"], ["auth-data", "db/auth-data.sql", "-- auth ficticio\n"], ["mailpit-message", "mailpit/abc.eml", "Subject: prueba\n"]]) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), body)
    files.push({ path: file, role, bytes: body.length, sha256: sha256(Buffer.from(body)), plainSha256: sha256(Buffer.from(body)), encrypted: false })
  }
  const report = `${JSON.stringify({ passed, backupId })}\n`
  writeFileSync(path.join(dir, "rehearsals", "r.json"), report)
  const applied = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === head) + 1)
  const rows = applied.map((e, i) => ({ id: i + 1, hash: e.hash, created_at: e.when }))
  const objectFacts = Object.fromEntries(["roles", "prerequisites", "tables", "policies", "grants", "schemaUsage", "constraints", "indexes", "columns", "functions", "triggers"].map((k) => [k, []]))
  const manifest = {
    ...sealManifest({
      schemaVersion: 1, kind: BACKUP_KIND, backupId, createdAt, completedAt: createdAt,
      source: { target, profile: "scratch", project: "biblib-scratch", fingerprint }, commit: { sha: "1".repeat(40) },
      migrations: { head, state: "up-to-date", applied: applied.map((e) => ({ tag: e.tag, hash: e.hash, created_at: e.when })), journalHash: "a".repeat(64), ledgerHash: ledgerHash(rows) },
      scope: { list: ["schema", "data", "history", "auth", "storage", "mailpit"], auth: { method: "supabase db dump --local --data-only --schema auth" }, storage: { method: "API Storage del perfil" }, mailpit: { method: "API de Mailpit", messages: 1, restored: false } },
      discardedStateHash: "d".repeat(64), objects: { hash: "c".repeat(64), facts: objectFacts }, storage: { buckets: [], objects: [] }, files,
    }),
    restoreVerification: { passed, reportId: "r1", report: "rehearsals/r.json", reportSha256: sha256(Buffer.from(report)), target: { target: "local", profile: "scratch" }, recoveryMs: 1000, at: createdAt },
  }
  writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2))
  return { dir, manifest, rows }
}

describe("recibo --backup-receipt", () => {
  test("el recibo de db:backup:local cumple el contrato de db:reset:local: alcance Mailpit, rutas relativas y discardedStateHash", () => {
    const root = workspace()
    const { dir, manifest } = makeBackup(root)
    const { file, receipt } = writeBackupReceipt(root, dir)
    assert.equal(file, path.relative(root, path.join(dir, RECEIPT_FILE)).split(path.sep).join("/"))
    assert.equal(receipt.kind, RECEIPT_KIND)
    for (const scope of ["domain", "auth", "storage", "mailpit", "ledger", "schema", "data", "history"]) assert.ok(receipt.scope.includes(scope), scope)
    assert.ok(receipt.files.every((f) => f.path.startsWith(".biblib/backups/") && !path.isAbsolute(f.path)))
    assert.equal(receipt.discardedStateHash, "d".repeat(64))
    assert.deepEqual(receipt.objects.coverage, [...RECEIPT_COVERAGE])
    assert.equal(receipt.receiptHash, receiptHash(receipt))
    const plan = { discarded: { hash: "d".repeat(64) }, createdAt: new Date(Date.parse(manifest.createdAt) - 1000).toISOString() }
    assert.equal(validateResetBackup(file, { root, fingerprint: "f".repeat(64) }, plan).backupId, manifest.backupId)
    assert.throws(() => validateResetBackup(file, { root, fingerprint: "f".repeat(64) }, { ...plan, discarded: { hash: "0".repeat(64) } }), { code: EXIT.PLAN_REJECTED })
    assert.doesNotMatch(readFileSync(path.join(root, file), "utf8"), /postgres:\/\/|service_role|eyJ/)
  })

  test("sin ensayo superado o con el respaldo alterado no se emite un recibo que acredite la restauración", () => {
    const root = workspace()
    const failed = makeBackup(root, { passed: false })
    assert.equal(buildBackupReceipt(root, failed.dir, failed.manifest).restoreVerification.passed, false)
    const tampered = makeBackup(workspace())
    writeFileSync(path.join(tampered.dir, "db", "auth-data.sql"), "-- alterado\n")
    assert.throws(() => writeBackupReceipt(path.dirname(path.dirname(path.dirname(tampered.dir))), tampered.dir), { code: EXIT.VERIFICATION_FAILED })
    assert.deepEqual(parseBackupArgs(["local", "--receipt-of", ".biblib/backups/x"]), { profile: process.env.BIBLIB_PROFILE || "main", json: false, receiptOf: ".biblib/backups/x" })
    assert.throws(() => parseBackupArgs(["local", "--receipt-of", "x", "--profile", "scratch"]), { code: EXIT.INVALID_ARGS })
  })

  test("promoción: ausente, alterado, caducado, de otro destino/head o sin ensayo se rechaza antes de conectar", () => {
    const root = workspace()
    const fingerprint = "e".repeat(64)
    const head = journal.entries[2].tag
    const { dir, rows, manifest } = makeBackup(root, { target: "prod", fingerprint, head })
    // readManifest solo admite respaldos locales (restore remoto pendiente); el recibo se construye igual.
    const file = path.relative(root, path.join(dir, RECEIPT_FILE))
    writeFileSync(path.join(root, file), JSON.stringify(buildBackupReceipt(root, dir, manifest)))
    const expect = { root, target: "prod", project: "biblib-scratch", fingerprint, appliedHead: { tag: head } }
    const validated = validateBackupReceipt(file, expect)
    assert.equal(validated.ledgerHash, ledgerHash(rows))
    rejects(() => validateBackupReceipt(undefined, expect), EXIT.PLAN_REJECTED, /--backup-receipt/)
    rejects(() => validateBackupReceipt(".biblib/backups/no-existe.json", expect), EXIT.PLAN_REJECTED)
    rejects(() => validateBackupReceipt(file, { ...expect, target: "preprod" }), EXIT.IDENTITY_MISMATCH, /otro destino/)
    rejects(() => validateBackupReceipt(file, { ...expect, fingerprint: "0".repeat(64) }), EXIT.IDENTITY_MISMATCH)
    rejects(() => validateBackupReceipt(file, { ...expect, appliedHead: { tag: journal.entries[3].tag } }), EXIT.PLAN_REJECTED, /head/)
    rejects(() => validateBackupReceipt(file, { ...expect, now: new Date(Date.now() + 25 * 3600 * 1000) }), EXIT.PLAN_REJECTED, /24 h/)
    const receipt = JSON.parse(readFileSync(path.join(root, file), "utf8"))
    const write = (value, name) => { const target = path.join(dir, name); writeFileSync(target, JSON.stringify(value)); return path.relative(root, target) }
    rejects(() => validateBackupReceipt(write({ ...receipt, migrations: { ...receipt.migrations, head: null } }, "alterado.json"), expect), EXIT.PLAN_REJECTED, /alterado/)
    const reseal = (value) => ({ ...value, receiptHash: receiptHash(value) })
    rejects(() => validateBackupReceipt(write(reseal({ ...receipt, kind: "biblib-account-export" }), "cuenta.json"), expect), EXIT.PLAN_REJECTED, /JSON de cuenta/)
    rejects(() => validateBackupReceipt(write(reseal({ ...receipt, scope: ["schema", "data"] }), "alcance.json"), expect), EXIT.PLAN_REJECTED, /alcance/)
    rejects(() => validateBackupReceipt(write(reseal({ ...receipt, objects: { ...receipt.objects, coverage: ["rls"] } }), "cobertura.json"), expect), EXIT.PLAN_REJECTED, /objetos/)
    rejects(() => validateBackupReceipt(write(reseal({ ...receipt, strategy: { auth: "x", storage: "y" } }), "estrategia.json"), expect), EXIT.PLAN_REJECTED, /configuration/)
    rejects(() => validateBackupReceipt(write(reseal({ ...receipt, restoreVerification: null }), "sin-ensayo.json"), expect), EXIT.PLAN_REJECTED, /ensayo/)
    rejects(() => validateBackupReceipt(write(reseal({ ...receipt, restoreVerification: { ...receipt.restoreVerification, reportSha256: "0".repeat(64) } }), "informe.json"), expect), EXIT.PLAN_REJECTED, /informe/)
    writeFileSync(path.join(dir, "db", "auth-data.sql"), "-- alterado\n")
    rejects(() => validateBackupReceipt(file, expect), EXIT.PLAN_REJECTED, /sha256/)
  })

  test("bajo bloqueo, un ledger o un esquema distintos del respaldo devuelven 6", () => {
    const rows = journal.entries.slice(0, 3).map((e, i) => ({ id: i + 1, hash: e.hash, created_at: e.when }))
    const validated = { ledgerHash: ledgerHash(rows), objectsHash: "c".repeat(64) }
    assert.doesNotThrow(() => assertReceiptMatchesDatabase(validated, { ledgerRows: rows, objectsHash: "c".repeat(64) }))
    rejects(() => assertReceiptMatchesDatabase(validated, { ledgerRows: rows.slice(0, 2), objectsHash: "c".repeat(64) }), EXIT.PLAN_REJECTED, /ledger/)
    rejects(() => assertReceiptMatchesDatabase(validated, { ledgerRows: rows, objectsHash: "0".repeat(64) }), EXIT.PLAN_REJECTED, /esquema/)
    assert.equal(ledgerHash([]), ledgerHash([]))
    assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }))
  })
})
