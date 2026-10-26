// Arranca exclusivamente nuestro proceso dev, solicita /login y compara AGENTS.md byte a byte.
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createWriteStream, readFileSync, writeFileSync } from "node:fs"
import { perfContext } from "../../../../../scripts/performance/lib/context.mjs"
import { childEnvironment } from "../../../../../scripts/performance/run.mjs"
import { acquireLock } from "../../../../../scripts/lib/state.mjs"
import { portInUse, stopTree } from "../../../../../tests/integration/lib/process.mjs"

const ctx = await perfContext("test")
const release = acquireLock(ctx.resolved.stack)
const before = readFileSync("AGENTS.md")
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
let child
try {
  if (await portInUse(3148)) throw new Error("Puerto 3148 ocupado; no se toca al ocupante.")
  child = spawn(process.execPath, ["scripts/next-target.mjs", "dev", "local", "--profile", "test"], {
    env: childEnvironment("test"), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  })
  const log = createWriteStream(".biblib/o16-fix-next-dev.log")
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  const deadline = Date.now() + 60_000
  let status = 0
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("next dev terminó antes de responder.")
    try { status = (await fetch(`${ctx.appUrl}/login`, { signal: AbortSignal.timeout(20_000) })).status } catch { /* arrancando */ }
    if (status === 200) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (status !== 200) throw new Error("next dev no respondió con 200.")
  const after = readFileSync("AGENTS.md")
  const result = { comando: "pnpm dev:local --profile test", next: "16.4.2", agentRules: false, login: status, sha256Antes: hash(before), sha256Despues: hash(after), iguales: before.equals(after) }
  writeFileSync(new URL("./next-dev-agentes.json", import.meta.url), `${JSON.stringify(result, null, 2)}\n`)
  if (!result.iguales) throw new Error("next dev modificó AGENTS.md")
  console.log("next dev respondió 200; AGENTS.md permanece idéntico.")
} finally { stopTree(child); release() }
