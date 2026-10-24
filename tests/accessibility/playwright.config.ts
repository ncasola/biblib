import path from "node:path"
import { defineConfig, devices, type Project } from "@playwright/test"

const dir = process.env.BIBLIB_E2E_DIR ?? path.resolve(".biblib/e2e")
const browsers = {
  chromium: { ...devices["Desktop Chrome"], channel: "chrome" },
  firefox: { ...devices["Desktop Firefox"] },
  webkit: { ...devices["Desktop Safari"] },
} as const

function projects(name: keyof typeof browsers): Project[] {
  return [
    { name: `${name}-sesion`, testMatch: /e2e\/sesion\.setup\.ts$/, use: { ...browsers[name], trace: "off" } },
    { name: `${name}-flujos`, dependencies: [`${name}-sesion`], testMatch: /accessibility\/(audit|contrast)\.spec\.ts$/, use: browsers[name] },
    { name, dependencies: [`${name}-flujos`], testMatch: /accessibility\/keyboard\.spec\.ts$/, use: { ...browsers[name], trace: "off" } },
  ]
}

export default defineConfig({
  testDir: "..",
  outputDir: path.join(dir, "artefactos"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["json", { outputFile: path.join(dir, "resultados.json") }], ["html", { outputFolder: path.join(dir, "report"), open: "never" }]],
  use: { baseURL: process.env.BIBLIB_E2E_BASE_URL, locale: "es-ES", timezoneId: "Europe/Madrid", screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: [...projects("chromium"), ...projects("firefox"), ...projects("webkit")],
})
