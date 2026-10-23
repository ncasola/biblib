import { createHash } from "node:crypto"
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { inspectJournal } from "../db/journal-guard.mjs"
import { summarizeReport } from "../../tests/e2e/run.mjs"

// Lista cerrada: nunca copiar .biblib completo, sesiones, credenciales, trazas, HTML ni backups.
const output = ".biblib/ci/public"
mkdirSync(output, { recursive: true })
function copy(source, destination) {
  if (!existsSync(source)) return
  if (lstatSync(source).isSymbolicLink() || !lstatSync(source).isFile()) throw new Error("La evidencia debe ser un archivo regular.")
  mkdirSync(path.dirname(destination), { recursive: true })
  copyFileSync(source, destination)
}
function screenshots(source, destination) {
  if (!existsSync(source)) return
  if (lstatSync(source).isSymbolicLink()) throw new Error("La evidencia no puede atravesar enlaces.")
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const file = path.join(source, entry.name)
    if (entry.isSymbolicLink()) throw new Error("La evidencia no puede contener enlaces.")
    if (entry.isDirectory()) screenshots(file, path.join(destination, entry.name))
    else if (entry.isFile() && /\.png$/.test(entry.name)) copy(file, path.join(destination, entry.name))
  }
}
const journal = inspectJournal()
writeFileSync(`${output}/migraciones.json`, `${JSON.stringify({ journalSha256: journal.journalHash, migrations: journal.entries.map(({ tag, when, hash }) => ({ tag, when, sha256: hash })), checks: journal.problems }, null, 2)}\n`)
copy(".biblib/ci/release.json", `${output}/release.json`)
copy(".biblib/ci/performance.json", `${output}/escala.json`)
copy(".biblib/ci/performance-results.json", `${output}/escala-resultados.json`)
copy(".biblib/ci/accessibility.json", `${output}/accesibilidad.json`)
if (existsSync(".biblib/plans")) {
  for (const name of readdirSync(".biblib/plans")) {
    if (!name.endsWith(".json")) continue
    const file = path.join(".biblib/plans", name)
    if (lstatSync(file).isSymbolicLink()) throw new Error("El plan no puede ser un enlace.")
    const plan = JSON.parse(readFileSync(file, "utf8"))
    // Solo planes/recibos locales del perfil test, sin listados de correcciones remotos.
    if (plan.target?.target === "local" && plan.target?.profile === "test" && ["migrate", "migrate-receipt", "reset-local"].includes(plan.kind)) copy(file, `${output}/planes/${name}`)
  }
}
const reports = {}
const nodeReports = {}
for (const suite of ["unit", "scripts"]) {
  const file = `.biblib/ci/${suite}.log`
  if (!existsSync(file)) continue
  // Solo contadores del runner; nunca copiar mensajes de errores, inputs ni logs crudos.
  const counts = {}
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^ℹ (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line)
    if (match) counts[match[1]] = Number(match[2])
  }
  nodeReports[suite] = counts
}
for (const [browser, file] of [["firefox", ".biblib/ci/firefox-resultados.json"], ["ultimo-navegador", ".biblib/e2e/resultados.json"]]) {
  if (!existsSync(file)) continue
  const summary = summarizeReport(JSON.parse(readFileSync(file, "utf8")))
  reports[browser] = { passed: summary.passed, known: summary.known.length, pending: summary.pending, unexpected: summary.unexpected.length, repeated: summary.repeated.length }
}
const steps = JSON.parse(process.env.CI_STEP_RESULTS || "{}")
const outcomes = Object.fromEntries(Object.entries(steps).map(([name, step]) => [name, { outcome: step.outcome, conclusion: step.conclusion }]))
const result = { status: process.env.CI_JOB_STATUS || "local-sin-acreditar", steps: outcomes, node: nodeReports, e2e: reports }
writeFileSync(`${output}/pruebas.json`, `${JSON.stringify(result, null, 2)}\n`)
screenshots(".biblib/e2e/capturas", `${output}/capturas`)
screenshots(".biblib/ci/firefox-capturas", `${output}/firefox-capturas`)
screenshots(".biblib/e2e/artefactos", `${output}/capturas-fallos`)
screenshots(".biblib/ci/smoke", `${output}/smoke`)
const checksums = []
function hashFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error("La evidencia no puede contener enlaces.")
    if (entry.isDirectory()) hashFiles(file)
    else if (entry.name !== "SHA256SUMS") checksums.push(`${createHash("sha256").update(readFileSync(file)).digest("hex")}  ${path.relative(output, file).replaceAll("\\", "/")}`)
  }
}
hashFiles(output)
writeFileSync(`${output}/SHA256SUMS`, `${checksums.join("\n")}\n`)
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `Evidencia ${process.env.GITHUB_SHA}: estado ${result.status}; checksums, planes locales e informes en el artefacto de esta ejecución.\n`, { flag: "a" })
console.log(`Evidencia permitida: ${checksums.length} archivos, sin estado privado del stack.`)
if (journal.problems.length) process.exitCode = 5
