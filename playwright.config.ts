import path from "node:path"
import { defineConfig, devices, type Project } from "@playwright/test"

// U-QA-02. Se ejecuta a través de tests/e2e/run.mjs (pnpm test:e2e:local), que acredita el perfil test,
// arranca la app en 127.0.0.1:3148 y fija BIBLIB_E2E_*. Sin reintentos: una repetición nunca convierte
// en verde un recorrido inestable. Informes y artefactos quedan en .biblib/e2e (ignorado por Git).

const e2eDir = process.env.BIBLIB_E2E_DIR ?? path.join(__dirname, ".biblib", "e2e")

const browsers = {
  // PR: el Chrome instalado en el sistema. Cierre de ola: Firefox y WebKit descargados por Playwright.
  chromium: { ...devices["Desktop Chrome"], channel: "chrome" },
  firefox: { ...devices["Desktop Firefox"] },
  webkit: { ...devices["Desktop Safari"] },
} as const

/**
 * Cada navegador tiene tres proyectos encadenados: `<n>-sesion` entra como A y B por el formulario local,
 * `<n>-flujos` recorre los grupos con esas sesiones y `<n>` cierra con los escenarios que revocan sesiones
 * y agotan el limitador. Seleccionar `--project <n>` ejecuta los tres en orden.
 */
function browserProjects(name: keyof typeof browsers): Project[] {
  const use = browsers[name]
  return [
    { name: `${name}-sesion`, testMatch: /sesion\.setup\.ts$/, use: { ...use, trace: "off" } },
    { name: `${name}-flujos`, testMatch: /flujos\/.*\.spec\.ts$/, dependencies: [`${name}-sesion`], use },
    { name, testMatch: /cierre\/.*\.spec\.ts$/, dependencies: [`${name}-flujos`], use: { ...use, trace: "off" } },
  ]
}

export default defineConfig({
  testDir: "tests/e2e",
  outputDir: path.join(e2eDir, "artefactos"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ["list"],
    ["json", { outputFile: path.join(e2eDir, "resultados.json") }],
    ["html", { outputFolder: path.join(e2eDir, "report"), open: "never" }],
  ],
  use: {
    baseURL: process.env.BIBLIB_E2E_BASE_URL,
    locale: "es-ES",
    timezoneId: "Europe/Madrid",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
    acceptDownloads: true,
  },
  projects: [
    ...browserProjects("chromium"),
    ...browserProjects("firefox"),
    ...browserProjects("webkit"),
    // Opt-in explícito (pnpm test:e2e:external): servicios reales de terceros; nunca en CI de PR.
    { name: "external", testMatch: /externo\/.*\.spec\.ts$/ },
  ],
})
