import { appendFileSync, readFileSync } from "node:fs"
import { computePlanHash } from "../db/plan.mjs"

const plan = JSON.parse(readFileSync(".biblib/plans/release.json", "utf8"))
if (plan.kind !== "migrate" || plan.planHash !== computePlanHash(plan) || plan.commit.sha !== process.env.RELEASE_COMMIT || plan.target.target !== process.env.RELEASE_TARGET) {
  console.error("El plan no es de migración para el destino y commit autorizados; revisar adopción por separado.")
  process.exitCode = 6
} else {
  appendFileSync(process.env.GITHUB_OUTPUT, `plan_hash=${plan.planHash}\n`)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Plan para revisión: ${plan.target.target} · commit ${plan.commit.sha}\n\nHash autorizado al aprobar el entorno: \`${plan.planHash}\`\n\nPendientes: ${plan.pending.join(", ") || "ninguna"}\n\nCaduca: ${plan.expiresAt}; si caduca, repetir plan y revisión.\n`)
}
