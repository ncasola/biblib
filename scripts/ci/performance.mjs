import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { pnpmCommand } from "../lib/process.mjs"

mkdirSync(".biblib/ci", { recursive: true })
const pkg = JSON.parse(readFileSync("package.json", "utf8"))
if (!pkg.scripts["perf:local"]) {
  const message = "Pendiente U-QA-03: perf:local aún no está integrado; no se acredita escala."
  console.log(message)
  writeFileSync(".biblib/ci/performance.json", `${JSON.stringify({ status: "pendiente", message })}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`, { flag: "a" })
} else {
  const pnpm = pnpmCommand(process.env, process.platform)
  const result = spawnSync(pnpm.command, [...pnpm.args.filter((arg) => arg !== "--version"), "perf:local", "--profile", "test", "--scale", "1000", "--out", ".biblib/ci/perf", "--json"], { stdio: "pipe", encoding: "utf8", windowsHide: true })
  // Con pnpm hay cabeceras antes del JSON final: conservar solo la salida estructurada.
  const line = result.stdout?.split(/\r?\n/).findLast((item) => item.startsWith('{"schemaVersion"'))
  let report
  try { report = JSON.parse(line) } catch { /* Informe ausente: fallo verificable. */ }
  const overBudget = report?.results?.some((item) => item.status === "over-budget")
  const valid = report?.schemaVersion === 1 && report.profile === "test" && report.scale === 1000 && Array.isArray(report.results) && report.results.length > 0
  const code = result.status === null ? 11 : result.status || (!valid ? 11 : overBudget ? 11 : 0)
  if (report) writeFileSync(".biblib/ci/performance-results.json", `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(".biblib/ci/performance.json", `${JSON.stringify({ status: code === 0 ? "superado" : overBudget ? "over-budget" : "fallido", code })}\n`)
  process.exitCode = code
}
