// U-INF-07 · Comprueba, sin modificar nada, que el recibo de db:backup:local (ya ensayado) cumple
// el contrato --backup-receipt de db:reset:local frente a su plan real y el de la promoción.
// Uso: node docs/validacion/2026-10-23/O08/inf-07/reset-acepta-recibo.mjs <plan-reset.json> <receipt.json>
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { validateResetBackup } from "../../../../../scripts/db/reset-local.mjs"
import { validateBackupReceipt } from "../../../../../scripts/db/remote-preflight.mjs"

const root = fileURLToPath(new URL("../../../../../", import.meta.url))
const [planFile, receiptFile] = process.argv.slice(2)
const plan = JSON.parse(readFileSync(path.join(root, planFile), "utf8"))
const receipt = JSON.parse(readFileSync(path.join(root, receiptFile), "utf8"))
const ctx = { root, fingerprint: plan.fingerprint }
const attempt = (fn) => { try { return { ok: true, value: fn() } } catch (error) { return { ok: false, code: error.code, message: error.message } } }
const result = {
  plan: { file: planFile, planHash: plan.planHash, createdAt: plan.createdAt, discardedHash: plan.discarded.hash },
  receipt: { file: receiptFile, backupId: receipt.backupId, createdAt: receipt.createdAt, discardedStateHash: receipt.discardedStateHash, scope: receipt.scope, restoreVerification: receipt.restoreVerification?.passed ?? false, files: receipt.files.length },
  resetAcepta: attempt(() => validateResetBackup(receiptFile, ctx, plan)),
  resetRechazaOtroEstado: attempt(() => validateResetBackup(receiptFile, ctx, { ...plan, discarded: { ...plan.discarded, hash: "0".repeat(64) } })),
  promocionAceptaContrato: attempt(() => validateBackupReceipt(receiptFile, { root, target: "local", project: receipt.target.project, fingerprint: receipt.fingerprint, appliedHead: { tag: receipt.migrations.head } }).backupId),
  promocionRechazaOtroDestino: attempt(() => validateBackupReceipt(receiptFile, { root, target: "prod", project: receipt.target.project, fingerprint: receipt.fingerprint, appliedHead: { tag: receipt.migrations.head } })),
}
console.log(JSON.stringify(result, null, 2))
process.exitCode = result.resetAcepta.ok && !result.resetRechazaOtroEstado.ok && result.promocionAceptaContrato.ok && !result.promocionRechazaOtroDestino.ok ? 0 : 1
