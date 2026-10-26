import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { EXIT } from "../../scripts/lib/exit-codes.mjs"
import { childEnvironment, E2E_DIR, evidenceEnvironment, parseArgs, playwrightArgs, readOutbound, summarizeReport } from "../e2e/run.mjs"
import { forgetSnapshot, readE2EManifest, recordSnapshot } from "../e2e/lib/e2e-manifest.mjs"
import { externalHost } from "../e2e/lib/server-network-guard.mjs"

// Piezas del runner de test:e2e:local (U-QA-02) que no necesitan Docker, stack ni navegador.

test("e2e: argumentos del runner, proyectos y modos exclusivos", () => {
  const base = parseArgs([])
  assert.deepEqual(base.projects, ["chromium"])
  assert.equal(base.reuseBuild, false)
  assert.deepEqual(parseArgs(["--project", "firefox", "--project", "webkit", "--profile", "test"]).projects, ["firefox", "webkit"])
  assert.equal(parseArgs(["--grep", "consulta"]).grep, "consulta")
  assert.equal(parseArgs(["--external"]).external, true)
  assert.equal(parseArgs(["--check-untargeted-build"]).checkUntargeted, true)
  for (const argv of [["--profile", "main"], ["--project", "edge"], ["--project", "chromium", "--project", "chromium"], ["--reuse-build", "--reuse-build"],
    ["--grep"], ["--external", "--project", "firefox"], ["--external", "--reuse-build"], ["--check-untargeted-build", "--ui"], ["--url", "http://x"]]) {
    assert.throws(() => parseArgs(argv), { code: EXIT.INVALID_ARGS }, argv.join(" "))
  }
})

test("e2e: Playwright recibe solo proyectos conocidos y el externo va aparte", () => {
  const local = playwrightArgs(parseArgs(["--project", "webkit", "--grep", "privacidad"])).slice(1)
  assert.deepEqual(local, ["test", "--config", "playwright.config.ts", "--project", "webkit", "--grep", "privacidad"])
  assert.deepEqual(playwrightArgs(parseArgs(["--external"])).slice(1), ["test", "--config", "playwright.config.ts", "--project", "external"])
  assert.ok(playwrightArgs(parseArgs(["--ui"])).includes("--ui"))
})

test("e2e: el entorno hijo no hereda Supabase, Postgres, BIBLIB ni NODE_OPTIONS", () => {
  const saved = { ...process.env }
  Object.assign(process.env, { SUPABASE_SERVICE_ROLE_KEY: "x", PGPASSWORD: "x", BIBLIB_CATALOGUE_MODE: "live", NODE_OPTIONS: "--require evil.js", DATABASE_URL: "postgres://x" })
  try {
    const env = childEnvironment({ EXTRA: "1" })
    for (const key of ["SUPABASE_SERVICE_ROLE_KEY", "PGPASSWORD", "BIBLIB_CATALOGUE_MODE", "NODE_OPTIONS", "DATABASE_URL"]) assert.equal(env[key], undefined, key)
    assert.equal(env.BIBLIB_TARGET, "local")
    assert.equal(env.BIBLIB_PROFILE, "test")
    assert.equal(env.EXTRA, "1")
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
  }
})

test("e2e: la evidencia solo se publica en docs/validacion si se pide", () => {
  assert.deepEqual(evidenceEnvironment({}), {})
  assert.deepEqual(evidenceEnvironment({ BIBLIB_E2E_EVIDENCE_DIR: "  " }), {})
  const root = path.dirname(path.dirname(E2E_DIR))
  assert.deepEqual(evidenceEnvironment({ BIBLIB_E2E_EVIDENCE_DIR: "docs/validacion" }), { BIBLIB_E2E_EVIDENCE_DIR: path.join(root, "docs", "validacion") })
  // childEnvironment no hereda BIBLIB_*: la variable solo llega a Playwright por evidenceEnvironment.
  const saved = process.env.BIBLIB_E2E_EVIDENCE_DIR
  process.env.BIBLIB_E2E_EVIDENCE_DIR = "docs/validacion"
  try { assert.equal(childEnvironment({}).BIBLIB_E2E_EVIDENCE_DIR, undefined) } finally {
    if (saved === undefined) delete process.env.BIBLIB_E2E_EVIDENCE_DIR
    else process.env.BIBLIB_E2E_EVIDENCE_DIR = saved
  }
})

test("e2e: el guard del servidor distingue loopback de hosts externos", () => {
  for (const url of ["http://127.0.0.1:55331/auth/v1/user", "http://localhost:3148/", "http://[::1]:3148/"]) assert.equal(externalHost(url), null, url)
  assert.equal(externalHost("https://openlibrary.org/api/books?bibkeys=ISBN:1"), "openlibrary.org")
  assert.equal(externalHost(new URL("https://covers.openlibrary.org/b/id/1-L.jpg")), "covers.openlibrary.org")
  assert.equal(externalHost({ url: "https://example.invalid/" }), "example.invalid")
  assert.equal(externalHost("/ruta-relativa"), null)
})

test("e2e: el registro del guard acredita la vigilancia y lista solo hosts", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "biblib-e2e-guard-"))
  try {
    const file = path.join(dir, "outbound.jsonl")
    assert.deepEqual(readOutbound(file), { guarded: false, hosts: [] })
    writeFileSync(file, `${JSON.stringify({ guard: "activo", pid: 1 })}\n${JSON.stringify({ host: "openlibrary.org", at: "x" })}\n`)
    assert.deepEqual(readOutbound(file), { guarded: true, hosts: ["openlibrary.org"] })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("e2e: el resumen separa superados, fallos conocidos, pendientes, inesperados y repeticiones", () => {
  const spec = (title, tests) => ({ title, tests })
  const report = { suites: [{ suites: [{ specs: [
    spec("ok", [{ projectName: "chromium-flujos", expectedStatus: "passed", status: "expected", results: [{}] }]),
    spec("conocido", [{ projectName: "chromium-flujos", expectedStatus: "failed", status: "expected", results: [{}] }]),
    spec("pendiente", [{ projectName: "chromium-flujos", expectedStatus: "skipped", status: "skipped", results: [] }]),
    spec("roto", [{ projectName: "chromium", expectedStatus: "passed", status: "unexpected", results: [{}] }]),
    spec("repetido", [{ projectName: "firefox", expectedStatus: "passed", status: "flaky", results: [{}, {}] }]),
  ] }] }] }
  assert.deepEqual(summarizeReport(report), {
    passed: 1, known: ["[chromium-flujos] conocido"], pending: 1, unexpected: ["[chromium] roto"], repeated: ["[firefox] repetido"],
  })
})

test("e2e: la instantánea del reemplazo se anota antes y se retira después; un manifiesto dañado se rechaza", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "biblib-e2e-manifest-"))
  try {
    const file = path.join(dir, "test-run.json")
    assert.equal(readE2EManifest(file), null)
    assert.throws(() => recordSnapshot(file, { userId: "a", shelves: [], books: [] }), { code: EXIT.VERIFICATION_FAILED })
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, runId: "0123456789ab", startedAt: new Date().toISOString(), snapshots: [] }))
    recordSnapshot(file, { userId: "a", shelves: [{ id: "s", is_default: true }], books: [{ id: "b" }] })
    recordSnapshot(file, { userId: "a", shelves: [], books: [] })
    assert.equal(readE2EManifest(file).snapshots.length, 1, "Una sola instantánea por cuenta")
    forgetSnapshot(file, "a")
    assert.deepEqual(readE2EManifest(file).snapshots, [])
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, runId: "corto", startedAt: "x", snapshots: [] }))
    assert.throws(() => readE2EManifest(file), { code: EXIT.IDENTITY_MISMATCH })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
