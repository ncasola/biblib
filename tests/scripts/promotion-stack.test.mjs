import assert from "node:assert/strict"
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { applyAdoption } from "../../scripts/db/adopt.mjs"
import { loadJournal } from "../../scripts/db/journal-guard.mjs"
import { runPromotion, statusRemote } from "../../scripts/db/migrate.mjs"
import { computePlanHash, createRemotePlan } from "../../scripts/db/plan.mjs"
import { connectRemote, describeRemote } from "../../scripts/db/remote-preflight.mjs"
import { objectFacts } from "../../scripts/lib/backup-db.mjs"
import { EXIT } from "../../scripts/lib/exit-codes.mjs"
import { adminClient, applyManually, dockerAvailable, rehearsalBackup, rehearseRestore, remoteEnv, repo, resolverFor, seedSynthetic, startRemote, stopRemote, SYNTHETIC } from "./promotion-harness.mjs"

// Ensayo de U-INF-07 contra Postgres efímeros propios con TLS autofirmado que simulan el
// remoto. No se conecta con ningún proyecto Supabase. Se omite con BIBLIB_SKIP_STACK_TESTS=1 o
// si Docker/la imagen postgres:17-alpine no están disponibles.
const skip = process.env.BIBLIB_SKIP_STACK_TESTS === "1" ? "BIBLIB_SKIP_STACK_TESTS=1" : dockerAvailable() ? false : "Docker o la imagen postgres:17-alpine no están disponibles"
const REF = "inf07ensayoremoto001"
const TARGET = "preprod"
const created = []
const journal = loadJournal(path.join(repo, "drizzle"))
const tags = journal.entries.map((e) => e.tag)
const rejection = (promise) => promise.then(() => null, (error) => error)
// Con BIBLIB_INF07_EVIDENCE=<carpeta>, la misma ejecución deja la evidencia del ensayo (sin secretos).
const EVIDENCE = process.env.BIBLIB_INF07_EVIDENCE
const evidence = (name, value) => { if (EVIDENCE) writeFileSync(path.join(EVIDENCE, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`) }
const evidenceFile = (name, file) => { if (EVIDENCE && file) cpSync(path.join(repo, file), path.join(EVIDENCE, `${name}.json`)) }
const summary = (result) => ({ ...result, checks: { ok: result.checks.filter((c) => c.status === "ok").length, other: result.checks.filter((c) => c.status !== "ok") } })
const describeError = (error) => ({ code: error.code, phase: error.phase, message: error.message, ...(error.report ? { report: error.report } : {}), ...(error.record ? { record: error.record } : {}) })

describe("promoción contra un remoto simulado [stack]", { skip }, () => {
  let remote, env, deps, admin
  const describeTarget = (overrides = {}) => describeRemote(TARGET, { env: { ...env, ...overrides }, expectProject: REF })

  before(async () => {
    remote = await startRemote({ ref: REF })
    env = remoteEnv(remote)
    deps = { resolveHost: resolverFor(remote) }
    admin = adminClient(remote)
  })
  after(async () => {
    await admin?.end({ timeout: 5 })
    stopRemote(remote)
    for (const file of created) rmSync(path.join(repo, file), { recursive: true, force: true })
  })

  const track = (file) => { if (file) created.push(file); return file }
  const reset = () => remote.psql("drop schema if exists biblib cascade; drop schema if exists drizzle cascade; delete from auth.users;")
  async function plan(name, { migrationsDir } = {}) {
    const out = `inf07-${process.pid}-${name}.json`
    const result = await createRemotePlan({ target: TARGET, out, expectProject: REF, env, ...(migrationsDir ? { migrationsDir } : {}) }, deps)
    track(path.join(".biblib", "plans", out))
    track(result.result.corrections)
    return result
  }
  async function receipt({ rehearse = true, target = TARGET } = {}) {
    const described = describeTarget()
    const sql = connectRemote(described, { resolveHost: deps.resolveHost })
    try {
      const backup = await rehearsalBackup(remote, { target, project: REF, fingerprint: described.fingerprint, sql })
      track(path.relative(repo, backup.dir))
      if (!rehearse) return path.relative(repo, backup.write())
      const { report, file } = await rehearseRestore(backup)
      assert.equal(report.passed, true, JSON.stringify(report.checks))
      return path.relative(repo, file)
    } finally { await sql.end({ timeout: 5 }) }
  }
  async function promote(planned, backupReceipt, { kind = "migrate", migrationsDir, extra = {} } = {}) {
    const options = { target: TARGET, plan: planned.result.file, expectProject: REF, expectPlan: planned.result.planHash, backupReceipt, env, ...(migrationsDir ? { migrationsDir } : {}), ...extra }
    try {
      const result = await runPromotion(options, kind === "adopt-ledger" ? { kind, apply: applyAdoption } : { kind }, deps)
      track(result.result.record)
      return result
    } catch (error) { track(error.record); throw error }
  }
  const ledger = async () => (await admin`select to_regclass('drizzle.__drizzle_migrations') is not null as present`)[0].present ? (await admin`select hash, created_at::bigint as created_at from drizzle.__drizzle_migrations order by id`).map((r) => ({ hash: r.hash, created_at: Number(r.created_at) })) : null
  const schemas = async () => (await admin`select nspname from pg_namespace where nspname in ('biblib', 'drizzle') order by 1`).map((r) => r.nspname)
  const domainRows = async () => ({
    books: (await admin`select id::text, user_id::text, isbn, title, number_of_pages, shelf_id::text from biblib.books order by id`).map((r) => ({ ...r })),
    shelves: (await admin`select id::text, user_id::text, title, is_default from biblib.shelves order by id`).map((r) => ({ ...r })),
  })
  /** Copia equivalente a 0000: SQL y ledger de 0000 aplicados por el Drizzle antiguo, con datos A/B. */
  function copyAt0000(extra = "") {
    reset()
    applyManually(remote, tags[0])
    const [first] = journal.entries
    remote.psql(`create schema drizzle; create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint); insert into drizzle.__drizzle_migrations (hash, created_at) values ('${first.hash}', ${first.when});`)
    seedSynthetic(remote, { extra })
  }

  test("1 · status y plan son de solo lectura: no crean ledger ni objetos y listan pendientes", async () => {
    reset()
    const status = await statusRemote({ target: TARGET, expectProject: REF, env }, deps)
    assert.equal(status.code, EXIT.OK)
    assert.equal(status.result.state, "empty")
    assert.deepEqual(status.result.pending, tags)
    assert.ok(status.result.checks.some((c) => c.id === "remote.tls" && c.status === "ok"))
    assert.ok(status.result.checks.some((c) => c.id === "remote.role" && c.status === "ok"))
    const planned = await plan("vacio")
    assert.equal(planned.code, EXIT.OK)
    assert.equal(planned.plan.kind, "migrate")
    assert.equal(planned.plan.target.target, TARGET)
    assert.deepEqual(planned.plan.pending, tags)
    assert.equal(planned.plan.descriptor.tls.mode, "verify-full")
    assert.doesNotMatch(readFileSync(path.join(repo, planned.result.file), "utf8"), new RegExp(`${remote.password}|postgresql://`))
    assert.deepEqual(await schemas(), [])
    evidence("01-status-vacio", summary(status.result))
    evidenceFile("01-plan-vacio", planned.result.file)
  })

  test("2 · identidad errónea, sin TLS, plan de otro commit/head y respaldo ausente o ajeno abortan antes de DDL", async () => {
    copyAt0000()
    const planned = await plan("rechazos")
    assert.equal(planned.code, EXIT.OK)
    const backup = await receipt()
    const before = { ledger: await ledger(), facts: (await objectFacts(admin)).hash }
    const codes = {}
    codes.ref = (await rejection(promote(planned, backup, { extra: { expectProject: "otroproyecto00000001" } }))).code
    codes.sinTls = (await rejection(promote(planned, backup, { extra: { env: { ...env, SUPABASE_DB_SSLMODE: undefined } } }))).code
    codes.require = (await rejection(promote(planned, backup, { extra: { env: { ...env, SUPABASE_DB_SSLMODE: "require" } } }))).code
    codes.host = (await rejection(promote(planned, backup, { extra: { env: { ...env, SUPABASE_DB_URL: env.SUPABASE_DB_URL.replace(`db.${REF}`, "db.otroproyecto00000001") } } }))).code
    codes.rol = (await rejection(promote(planned, backup, { extra: { env: { ...env, SUPABASE_DB_URL: env.SUPABASE_DB_URL.replace("postgres:", "authenticated:") } } }))).code
    const foreign = await startRemote({ ref: REF, certificateFor: "db.otroproyecto00000001.supabase.co" })
    try {
      const error = await rejection(runPromotion({ target: TARGET, plan: planned.result.file, expectProject: REF, expectPlan: planned.result.planHash, backupReceipt: backup, env: remoteEnv(foreign) }, { kind: "migrate" }, { resolveHost: resolverFor(foreign) }))
      track(error.record)
      codes.certificado = error.code
    } finally { stopRemote(foreign) }
    const plain = await startRemote({ ref: REF, tls: false, platform: false })
    try { codes.servidorSinTls = (await rejection(statusRemote({ target: TARGET, expectProject: REF, env: { ...remoteEnv(plain), SUPABASE_DB_SSLROOTCERT: env.SUPABASE_DB_SSLROOTCERT } }, { resolveHost: resolverFor(plain) }))).code } finally { stopRemote(plain) }
    const other = JSON.parse(readFileSync(path.join(repo, planned.result.file), "utf8"))
    other.commit = { ...other.commit, sha: "0".repeat(40) }
    other.planHash = computePlanHash(other)
    const otherFile = track(planned.result.file.replace(/\.json$/, "-otro-commit.json"))
    writeFileSync(path.join(repo, otherFile), JSON.stringify(other))
    codes.commit = (await rejection(promote({ result: { file: otherFile, planHash: other.planHash } }, backup))).code
    codes.sinRespaldo = (await rejection(promote(planned, undefined))).code
    codes.respaldoSinEnsayo = (await rejection(promote(planned, await receipt({ rehearse: false })))).code
    codes.respaldoAjeno = (await rejection(promote(planned, await receipt({ target: "prod" })))).code
    assert.deepEqual(codes, { ref: 3, sinTls: 3, require: 3, host: 3, rol: 3, certificado: 3, servidorSinTls: 3, commit: 6, sinRespaldo: 6, respaldoSinEnsayo: 6, respaldoAjeno: 3 })
    assert.deepEqual(await ledger(), before.ledger)
    assert.equal((await objectFacts(admin)).hash, before.facts)
    // Plan de otro head: el destino avanzó después del plan (otro runner).
    const applied = await promote(planned, backup)
    assert.equal(applied.code, EXIT.OK)
    const stale = await rejection(promote(planned, backup))
    assert.equal(stale.code, EXIT.PLAN_REJECTED)
    assert.match(stale.message, /head aplicado o los pendientes cambiaron/)
    evidence("02-rechazos-antes-de-ddl", { codes, ledgerSinCambios: true, objetosSinCambios: true, planDeOtroHead: describeError(stale) })
  })

  test("3 · copia equivalente a 0000: conserva IDs y datos, aplica 0001…0004 y verifica catálogo, FK, RLS y versión", async () => {
    copyAt0000()
    const original = await domainRows()
    const planned = await plan("desde-0000")
    assert.equal(planned.code, EXIT.OK)
    assert.deepEqual(planned.plan.pending, tags.slice(1))
    assert.deepEqual(planned.plan.dataPreflight.checks.map((c) => [c.id, c.status]), [["data.owner-shelf", "ok"], ["data.pages", "ok"], ["data.book-title", "ok"], ["data.shelf-title", "ok"], ["data.isbn-duplicate", "warn"], ["data.shelf-duplicate", "ok"]])
    const result = await promote(planned, await receipt())
    assert.equal(result.code, EXIT.OK)
    assert.equal(result.result.previousHead.tag, tags[0])
    assert.equal(result.result.head.tag, tags.at(-1))
    assert.ok(result.result.checks.length > 100 && result.result.checks.every((c) => c.status === "ok"))
    for (const id of ["column.books.catalogue", "constraint.books_owner_shelf_fk", "rls.books", "policy.books_select_own", "function.rotate_book_version", "trigger.books_rotate_version"]) assert.ok(result.result.checks.some((c) => c.id === id && c.status === "ok"), id)
    assert.deepEqual(await domainRows(), original)
    assert.deepEqual((await ledger()).map((r) => r.created_at), journal.entries.map((e) => e.when))
    const [a, b] = SYNTHETIC.users
    const [book] = SYNTHETIC.books
    const ROLLBACK = new Error("revertir")
    await admin.begin(async (tx) => {
      const [{ version: v1 }] = await tx`select version::text from biblib.books where id = ${book[0]}`
      const [{ version: v2 }] = await tx`update biblib.books set title = title where id = ${book[0]} returning version::text`
      assert.notEqual(v1, v2)
      const fk = await tx.savepoint((sp) => sp`insert into biblib.books (user_id, isbn, title, shelf_id) values (${a}, '1', 'Ajena', ${SYNTHETIC.shelves[2][0]})`).then(() => null, (error) => error.code)
      assert.equal(fk, "23503")
      throw ROLLBACK
    }).catch((error) => { if (error !== ROLLBACK) throw error })
    for (const [user, other, count] of [[a, b, 2], [b, a, 1]]) {
      await admin.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: user, role: "authenticated" })}, true)`
        await tx`select set_config('request.jwt.claim.sub', ${user}, true)`
        await tx.unsafe("set local role authenticated")
        const seen = await tx`select user_id::text from biblib.books`
        assert.equal(seen.length, count)
        assert.ok(seen.every((r) => r.user_id === user))
        assert.equal((await tx`update biblib.books set title = title where user_id = ${other}`).count, 0)
        throw ROLLBACK
      }).catch((error) => { if (error !== ROLLBACK) throw error })
    }
    // Claims y rol son locales a la transacción: la conexión vuelve a ser administrativa.
    const [session] = await admin`select current_user::text as role, coalesce(current_setting('request.jwt.claims', true), '') as claims`
    assert.deepEqual({ ...session }, { role: "postgres", claims: "" })
    const record = JSON.parse(readFileSync(path.join(repo, result.result.record), "utf8"))
    assert.equal(record.kind, "biblib-promotion-record")
    assert.equal(record.headBefore, tags[0])
    assert.equal(record.headAfter, tags.at(-1))
    assert.equal(record.planHash, planned.result.planHash)
    assert.equal(record.platform.unchanged, true)
    assert.ok(record.backup.backupId && record.lostWrites.since)
    assert.doesNotMatch(JSON.stringify(record), new RegExp(`${remote.password}|postgresql://|Ficción`))
    evidenceFile("03-plan-desde-0000", planned.result.file)
    evidence("03-promocion-desde-0000", { ...summary(result.result), idsYDatosConservados: true, versionRotada: true, fkPropietario: "23503", rls: { a: 2, b: 1, ajenasActualizadas: 0 }, claimsLocalesATransaccion: { ...session } })
    evidenceFile("03-registro-promocion", result.result.record)
  })

  test("4 · datos incompatibles con 0001: listado restringido de correcciones, sin plan ni cambios", async () => {
    const [a, b] = SYNTHETIC.users
    copyAt0000(`insert into biblib.books (id, user_id, isbn, title, number_of_pages, shelf_id) values
      ('c0000000-0000-4000-8000-000000000001', '${a}', '111', 'Cruzada', 10, '${SYNTHETIC.shelves[2][0]}'),
      ('c0000000-0000-4000-8000-000000000002', '${b}', '222', 'Demasiadas páginas', 200000, '${SYNTHETIC.shelves[2][0]}'),
      ('c0000000-0000-4000-8000-000000000003', '${b}', '333', '   ', 1, '${SYNTHETIC.shelves[2][0]}');`)
    const before = await domainRows()
    const planned = await plan("datos")
    assert.equal(planned.code, EXIT.HISTORY_DIVERGED)
    assert.equal(planned.plan, undefined)
    assert.ok(!existsSync(path.join(repo, ".biblib", "plans", `inf07-${process.pid}-datos.json`)))
    const listing = JSON.parse(readFileSync(path.join(repo, planned.result.corrections), "utf8"))
    assert.deepEqual(listing.items.filter((i) => i.check !== "data.isbn-duplicate").map((i) => [i.check, i.id]), [["data.owner-shelf", "c0000000-0000-4000-8000-000000000001"], ["data.pages", "c0000000-0000-4000-8000-000000000002"], ["data.book-title", "c0000000-0000-4000-8000-000000000003"]])
    assert.ok(listing.checks.filter((c) => c.status === "fail").every((c) => c.correction))
    assert.doesNotMatch(JSON.stringify(listing), new RegExp(`${a}|${b}|Cruzada|Demasiadas`))
    assert.deepEqual(await domainRows(), before)
    evidence("04-plan-datos-incompatibles", { code: planned.code, state: planned.result.state, corrections: planned.result.corrections })
    evidenceFile("04-correcciones-propuestas", planned.result.corrections)
  })

  test("5 · esquema manual sin ledger equivalente a 0002: adopt escribe solo el ledger y migrate aplica 0003/0004", async () => {
    reset()
    applyManually(remote, tags[2])
    seedSynthetic(remote)
    const status = await statusRemote({ target: TARGET, expectProject: REF, env }, deps)
    assert.equal(status.code, EXIT.HISTORY_DIVERGED)
    assert.equal(status.result.state, "adoption-required")
    assert.deepEqual(status.result.adoption, { proven: true, head: tags[2], pendingAfter: tags.slice(3) })
    const planned = await plan("adopcion")
    assert.equal(planned.code, EXIT.OK)
    assert.equal(planned.plan.kind, "adopt-ledger")
    assert.deepEqual(planned.plan.adoption.rows.map((r) => r.tag), tags.slice(0, 3))
    assert.deepEqual(planned.plan.pending, [])
    const backup = await receipt()
    assert.equal((await rejection(promote(planned, backup))).code, EXIT.PLAN_REJECTED)
    const facts = (await objectFacts(admin)).hash
    const data = await domainRows()
    const adopted = await promote(planned, backup, { kind: "adopt-ledger" })
    assert.equal(adopted.code, EXIT.OK)
    assert.deepEqual(adopted.result.pendingAfter, tags.slice(3))
    assert.deepEqual(await ledger(), journal.entries.slice(0, 3).map((e) => ({ hash: e.hash, created_at: e.when })))
    assert.equal((await objectFacts(admin)).hash, facts)
    assert.deepEqual(await domainRows(), data)
    const again = await rejection(promote(planned, backup, { kind: "adopt-ledger" }))
    assert.equal(again.code, EXIT.PLAN_REJECTED)
    const next = await plan("tras-adopcion")
    assert.equal(next.plan.kind, "migrate")
    assert.deepEqual(next.plan.pending, tags.slice(3))
    assert.equal((await rejection(promote(next, backup))).code, EXIT.PLAN_REJECTED)
    const migrated = await promote(next, await receipt())
    assert.equal(migrated.result.head.tag, tags.at(-1))
    assert.deepEqual(await domainRows(), data)
    evidence("05-status-adopcion-requerida", summary(status.result))
    evidenceFile("05-plan-adopcion", planned.result.file)
    evidence("05-adopcion", { ...summary(adopted.result), soloLedger: true, objetosBiblibSinCambios: true, repetir: describeError(again) })
    evidenceFile("05-registro-adopcion", adopted.result.record)
    evidence("05-migracion-tras-adopcion", summary(migrated.result))
  })

  test("6 · esquema con drift (sin trigger): la adopción se rechaza con 5 y conciliación, sin ledger", async () => {
    reset()
    applyManually(remote, tags[2])
    seedSynthetic(remote)
    const planned = await plan("drift-previo")
    assert.equal(planned.plan.kind, "adopt-ledger")
    const backup = await receipt()
    remote.psql("drop trigger books_rotate_version on biblib.books;")
    const replanned = await plan("drift")
    assert.equal(replanned.code, EXIT.HISTORY_DIVERGED)
    assert.deepEqual(replanned.result.reconciliation.differences.map((d) => d.id), ["trigger.books_rotate_version"])
    const refused = await rejection(promote(planned, backup, { kind: "adopt-ledger" }))
    assert.equal(refused.code, EXIT.HISTORY_DIVERGED)
    assert.deepEqual(refused.report.reconciliation.differences.map((d) => d.id), ["trigger.books_rotate_version"])
    assert.equal(await ledger(), null)
    assert.ok(JSON.parse(readFileSync(path.join(repo, refused.record), "utf8")).result.startsWith("rechazado"))
    evidence("06-drift-sin-trigger", { plan: { code: replanned.code, state: replanned.result.state, reconciliation: replanned.result.reconciliation }, adopt: describeError(refused), ledger: null })
  })

  test("7 · fallo transaccional sin avance del ledger y restauración coherente desde el respaldo", async () => {
    copyAt0000()
    await promote(await plan("base-fallo"), await receipt())
    const dir = mkdtempSync(path.join(tmpdir(), "biblib inf07 migraciones "))
    try {
      cpSync(path.join(repo, "drizzle"), dir, { recursive: true })
      writeFileSync(path.join(dir, "0005_u_inf_07_fallo.sql"), "CREATE TABLE biblib.u_inf_07_probe (id integer);\n--> statement-breakpoint\nALTER TABLE biblib.u_inf_07_probe ADD COLUMN id integer;\n")
      const journalFile = path.join(dir, "meta", "_journal.json")
      const edited = JSON.parse(readFileSync(journalFile, "utf8"))
      edited.entries.push({ idx: 5, version: "7", when: 1792900000000, tag: "0005_u_inf_07_fallo", breakpoints: true })
      writeFileSync(journalFile, `${JSON.stringify(edited, null, 2)}\n`)
      const planned = await plan("fallo", { migrationsDir: dir })
      assert.deepEqual(planned.plan.pending, ["0005_u_inf_07_fallo"])
      const backupFile = await receipt()
      const before = await ledger()
      const failure = await rejection(promote(planned, backupFile, { migrationsDir: dir }))
      assert.equal(failure.code, EXIT.MIGRATION_FAILED)
      assert.match(failure.report.result, /revertido/)
      assert.deepEqual(await ledger(), before)
      assert.equal((await admin`select to_regclass('biblib.u_inf_07_probe') is null as absent`)[0].absent, true)
      assert.equal(JSON.parse(readFileSync(path.join(repo, failure.record), "utf8")).code, EXIT.MIGRATION_FAILED)
      // Recuperación ensayada: el respaldo previo al fallo se restaura en una copia aislada con
      // ledger, manifest (RLS, políticas, función y trigger) y hechos de catálogo idénticos.
      const restored = JSON.parse(readFileSync(path.join(repo, backupFile), "utf8"))
      const report = JSON.parse(readFileSync(path.join(repo, restored.restoreVerification.report), "utf8"))
      assert.deepEqual(report.checks.map((c) => [c.id, c.status]), [["ledger", "ok"], ["manifest", "ok"], ["objects.facts", "ok"]])
      evidence("07-fallo-transaccional", { ...describeError(failure), ledgerSinAvance: true, objetoDePruebaAusente: true })
      evidenceFile("07-registro-fallo", failure.record)
      evidence("07-restauracion-tras-fallo", report)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test("8 · dos ejecuciones simultáneas no aplican el mismo plan", async () => {
    copyAt0000()
    const planned = await plan("concurrencia")
    const backup = await receipt()
    const results = await Promise.all([1, 2].map(() => promote(planned, backup).then((r) => r.code, (error) => error.code)))
    assert.deepEqual(results.sort(), [EXIT.OK, EXIT.PLAN_REJECTED])
    assert.equal((await ledger()).length, tags.length)
    evidence("08-concurrencia", { codes: results, ledgerRows: (await ledger()).length })
  })
})
