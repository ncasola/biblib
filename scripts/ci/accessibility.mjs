import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { chromium } from "@playwright/test"
import { integrationContext } from "../../tests/integration/lib/context.mjs"
import { startApp, stopTree } from "../../tests/integration/lib/process.mjs"
import { acquireLock } from "../lib/state.mjs"

// Auditoría automática acotada al acceso local en claro/oscuro. No acredita una revisión manual.
const out = ".biblib/ci"
mkdirSync(out, { recursive: true })
let app, browser, release
const reports = []
try {
  const source = readFileSync(process.env.AXE_SOURCE, "utf8")
  const ctx = await integrationContext()
  release = acquireLock(ctx.resolved.stack)
  app = await startApp(ctx, { ...process.env, BIBLIB_TARGET: "local", BIBLIB_PROFILE: "test" }, { logFile: path.join(out, "a11y-app.log"), logHint: ".biblib/ci/a11y-app.log" })
  browser = await chromium.launch({ channel: "chrome" })
  for (const colorScheme of ["light", "dark"]) {
    const page = await browser.newPage({ colorScheme, locale: "es-ES" })
    await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort())
    await page.goto(`${ctx.appUrl}/login`, { waitUntil: "networkidle" })
    await page.addScriptTag({ content: source })
    const result = await page.evaluate(async () => {
      const audit = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } })
      return { violations: audit.violations.map(({ id, impact, nodes }) => ({ id, impact, count: nodes.length })), incomplete: audit.incomplete.map(({ id }) => id), passedRules: audit.passes.length }
    })
    reports.push({ route: "/login", colorScheme, ...result })
    await page.close()
  }
  if (reports.some((report) => report.violations.length)) process.exitCode = 11
} catch {
  console.error("No se pudo completar la auditoría de accesibilidad local.")
  process.exitCode = 11
} finally {
  await browser?.close()
  stopTree(app)
  release?.()
  writeFileSync(`${out}/accessibility.json`, `${JSON.stringify({ status: process.exitCode ? "fallido" : "superado", reports }, null, 2)}\n`)
}
