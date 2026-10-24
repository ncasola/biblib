import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { chromium } from "@playwright/test"
import { acquireLock } from "../../scripts/lib/state.mjs"
import { loadCensus, resolveSeedTarget, seedAccounts } from "../../scripts/db/seed-local.mjs"
import { closeConnection } from "../../scripts/db/target.mjs"
import { runScaleSeed } from "../../scripts/performance/scale-seed.mjs"
import { database, perfContext, startPerfApp } from "../../scripts/performance/lib/context.mjs"
import { openSessions } from "../../scripts/performance/lib/sessions.mjs"
import { scaleFacts } from "../../scripts/performance/lib/scenarios.mjs"
import { PROFILES, runWebVitals } from "../../scripts/performance/lib/webvitals.mjs"
import { childEnvironment, GUARD, LOG_DIR, seededDataset } from "../../scripts/performance/run.mjs"
import { run, stopTree } from "../integration/lib/process.mjs"

// Comparación T6: perfil original de U-QA-03, 10 000 libros / 41 estanterías,
// dos contextos nuevos por pantalla, navegación fría/caliente y gestos originales.
// El trace crudo no se persiste: solo nombres y duraciones, sin argumentos/URLs.
async function profileDialog(appUrl, cookies) {
  const browser = await chromium.launch({ channel: "chrome" })
  try {
    const context = await browser.newContext({ ...PROFILES.movil.context, locale: "es-ES" })
    await context.addCookies(cookies.map(({ name, value }) => ({ name, value, url: appUrl })))
    await context.route("**/*", (route) => ["127.0.0.1", "localhost"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort())
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 })
    await page.goto(`${appUrl}/shelves`)
    await page.waitForLoadState("networkidle")
    const events = []
    cdp.on("Tracing.dataCollected", ({ value }) => events.push(...value))
    await cdp.send("Tracing.start", { categories: "devtools.timeline,blink.user_timing", transferMode: "ReportEvents" })
    await page.getByRole("button", { name: "Nueva estantería", exact: true }).click()
    await page.getByRole("dialog").waitFor()
    await page.waitForTimeout(400)
    const done = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve))
    await cdp.send("Tracing.end")
    await done
    const names = ["EventDispatch", "FunctionCall", "UpdateLayoutTree", "Layout", "PrePaint", "Paint", "Layerize"]
    const summary = names.map((name) => {
      const spans = events.filter((event) => event.name === name && event.ph === "X")
      return { name, count: spans.length, totalMs: Math.round(spans.reduce((sum, event) => sum + (event.dur ?? 0), 0) / 100) / 10, maxMs: Math.round(Math.max(0, ...spans.map((event) => event.dur ?? 0)) / 100) / 10 }
    })
    await context.close()
    return summary
  } finally { await browser.close() }
}

const label = process.argv[2]
if (!["antes", "despues"].includes(label) || process.argv.length !== 3) throw new Error("Uso: node tests/accessibility/performance.mjs antes|despues")
const ctx = await perfContext("test")
const release = acquireLock(ctx.resolved.stack)
const sql = database(ctx, "biblib-a11y-t6")
const out = path.resolve("docs/validacion/2026-10-24/O11/exp-03")
mkdirSync(out, { recursive: true })
mkdirSync(LOG_DIR, { recursive: true })
let app, sessions
try {
  const seeded = await seededDataset(ctx, sql, 10000) ?? await runScaleSeed({ profile: "test", scale: 10000, lockHeld: true }, { resolveSeedTarget, seedAccounts, loadCensus })
  const env = childEnvironment("test")
  console.log(`T6 ${label}: compilando perfil test, ${seeded.books} libros / ${seeded.shelves} estanterías.`)
  const build = await run(process.execPath, ["scripts/next-target.mjs", "build", "local", "--profile", "test"], { env, logFile: path.join(LOG_DIR, "build.log") })
  if (build) throw new Error("Falló la compilación T6; revisa .biblib/performance/build.log")
  const outbound = path.join(LOG_DIR, "outbound-t6.jsonl")
  writeFileSync(outbound, "")
  app = await startPerfApp(ctx, { ...env, NODE_OPTIONS: `--import=${pathToFileURL(GUARD).href}`, E2E_OUTBOUND_LOG: outbound }, { logFile: path.join(LOG_DIR, "app.log") })
  sessions = await openSessions(ctx, { escala: 1, ab: false })
  const facts = await scaleFacts(sql, sessions.scaleUserId)
  const web = await runWebVitals({ appUrl: ctx.appUrl, cookies: sessions.escala[0].cookies, facts, profileKey: "movil", runs: 2, only: ["estanterias", "ficha"] })
  const trace = await profileDialog(ctx.appUrl, sessions.escala[0].cookies)
  const network = readFileSync(outbound, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
  if (!network.some((entry) => entry.guard === "activo") || network.some((entry) => entry.host) || web.peticionesExternasAbortadas.length || web.erroresDeConsola.length) throw new Error("La medición tuvo errores o tráfico externo")
  const sourceFiles = ["app/globals.css", "app/shelves/page.tsx", "components/shelf-card.tsx", "components/ui/dialog.tsx", "components/ui/button.tsx", "components/header.tsx"]
  const sourceHash = createHash("sha256")
  for (const file of sourceFiles) sourceHash.update(file).update(readFileSync(file))
  const source = { commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim(), files: sourceFiles, sha256: sourceHash.digest("hex") }
  const result = { date: new Date().toISOString(), label, source, dataset: { books: seeded.books, shelves: seeded.shelves, hash: seeded.datasetHash }, web, profileDialog: trace }
  writeFileSync(path.join(out, `t6-${label}.json`), `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify({ label, shelves: web.pantallas.estanterias.interaccion, detail: web.pantallas.ficha.interaccion, profile: trace }))
} finally {
  stopTree(app)
  await sessions?.close()
  await closeConnection(sql)
  release()
}
