// Mismo observador, ventanas, CPU, frío/caliente y gestos que el benchmark de U-QA-05.
// Usa A ficticia y el build local del perfil test; no escribe datos de dominio ni imprime sesiones.
import { writeFileSync } from "node:fs"
import { chromium } from "@playwright/test"
import { perfContext, startPerfApp } from "../../../../../scripts/performance/lib/context.mjs"
import { childEnvironment } from "../../../../../scripts/performance/run.mjs"
import { PROFILES, runWebVitals } from "../../../../../scripts/performance/lib/webvitals.mjs"
import { acquireLock } from "../../../../../scripts/lib/state.mjs"
import { stopTree } from "../../../../../tests/integration/lib/process.mjs"
import { signInFixture } from "../../../../../tests/integration/support/session.mjs"

const label = process.argv[2]
if (!["antes", "despues"].includes(label)) throw new Error("Uso: medir-inicio.mjs antes|despues")
const ctx = await perfContext("test")
const release = acquireLock(ctx.resolved.stack)
let app, session
try {
  app = await startPerfApp(ctx, childEnvironment("test"), { logFile: `.biblib/o16-fix-inicio-${label}.log` })
  session = await signInFixture("a", { profile: "test" })
  const cookies = session.cookies().filter((c) => c.value).map(({ name, value }) => ({ name, value }))
  const result = { perfil: "test", cuenta: "A ficticia", metodo: "runWebVitals de perf:local, 3 contextos por perfil", web: {}, desplazamientos: {} }
  for (const profileKey of Object.keys(PROFILES)) {
    result.web[profileKey] = await runWebVitals({ appUrl: ctx.appUrl, cookies, facts: { bookIds: [] }, profileKey, runs: 3, only: ["inicio"] })
    const browser = await chromium.launch({ channel: "chrome" })
    try {
      const profile = PROFILES[profileKey]
      const context = await browser.newContext({ ...profile.context, locale: "es-ES", timezoneId: "Europe/Madrid" })
      await context.addCookies(cookies.map((c) => ({ ...c, url: ctx.appUrl })))
      await context.route("**/*", (route) => ["127.0.0.1", "localhost"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort())
      await context.addInitScript(() => {
        window.desplazamientos = []
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) if (!e.hadRecentInput) window.desplazamientos.push({
            instante: e.startTime, valor: e.value,
            fuentes: e.sources.map((s) => ({ elemento: s.node?.tagName, id: s.node?.id, clase: s.node?.className, antes: s.previousRect.toJSON(), despues: s.currentRect.toJSON() })),
          })
        }).observe({ type: "layout-shift", buffered: true })
      })
      const page = await context.newPage()
      if (profile.cpuSlowdown > 1) await (await context.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: profile.cpuSlowdown })
      await page.goto(ctx.appUrl)
      await page.waitForLoadState("networkidle")
      await page.waitForTimeout(700)
      result.desplazamientos[profileKey] = await page.evaluate(() => window.desplazamientos)
      await context.close()
    } finally { await browser.close() }
  }
  writeFileSync(new URL(`./inicio-${label}.json`, import.meta.url), `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify(Object.fromEntries(Object.entries(result.web).map(([key, value]) => [key, value.pantallas.inicio])), null, 2))
} finally {
  await session?.client.auth.signOut()
  stopTree(app)
  release()
}
