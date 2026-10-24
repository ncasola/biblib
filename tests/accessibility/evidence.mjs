import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { summarizeReport } from "../e2e/run.mjs"

// Publica solo resultados y nombres de escenarios; nunca el storageState, trace,
// cookies, HTML del informe ni adjuntos que puedan contener material de sesión.
const name = process.argv[2]
if (!["a11y", "e2e"].includes(name) || process.argv.length !== 3) throw new Error("Uso: node tests/accessibility/evidence.mjs a11y|e2e")
const report = JSON.parse(readFileSync(path.resolve(".biblib/e2e/resultados.json"), "utf8"))
const summary = summarizeReport(report)
if (summary.unexpected.length || summary.repeated.length) throw new Error("No se publica como verde una ejecución fallida o repetida")
const projects = {}
function walk(suite) {
  for (const child of suite.suites ?? []) walk(child)
  for (const spec of suite.specs ?? []) for (const item of spec.tests ?? []) {
    const row = projects[item.projectName] ??= { passed: 0, pending: 0, known: 0 }
    if (item.status === "skipped") row.pending++
    else if (item.expectedStatus === "failed") row.known++
    else if (item.status === "expected") row.passed++
  }
}
for (const suite of report.suites ?? []) walk(suite)
const result = { generatedAt: new Date().toISOString(), suite: name, summary, projects, stats: report.stats }
writeFileSync(path.resolve(`docs/validacion/2026-10-24/O11/exp-03/${name}.json`), `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result))
