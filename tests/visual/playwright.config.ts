import path from "node:path"
import { defineConfig, devices } from "@playwright/test"

// U-UX-01: capturas antes/después del rediseño (solo Chromium y cuentas ficticias del perfil test).
const dir = process.env.BIBLIB_E2E_DIR ?? path.resolve(".biblib/e2e")
const chromium = { ...devices["Desktop Chrome"], channel: "chrome" } as const

export default defineConfig({
  testDir: "..",
  outputDir: path.join(dir, "artefactos"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 300_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["json", { outputFile: path.join(dir, "resultados.json") }]],
  use: { baseURL: process.env.BIBLIB_E2E_BASE_URL, locale: "es-ES", timezoneId: "Europe/Madrid", screenshot: "only-on-failure", trace: "off" },
  projects: [
    { name: "chromium-sesion", testMatch: /e2e\/sesion\.setup\.ts$/, use: chromium },
    { name: "chromium", dependencies: ["chromium-sesion"], testMatch: /visual\/capturas\.spec\.ts$/, use: chromium },
  ],
})
