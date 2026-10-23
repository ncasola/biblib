import { spawn } from "node:child_process"
import { createWriteStream } from "node:fs"
import { BiblibError, EXIT } from "../../lib/exit-codes.mjs"
import { REPO_ROOT } from "../../lib/profiles.mjs"
import { loadCensus, resolveSeedTarget } from "../../db/seed-local.mjs"
import { readFixtureStore } from "../../db/fixture-store.mjs"
import { connect } from "../../db/target.mjs"
import { portInUse, stopTree } from "../../../tests/integration/lib/process.mjs"

// Contexto de la medición para los perfiles test y scratch. El perfil debe estar arrancado, acreditado
// (huella, registro y propiedad Docker de este checkout) y sembrado con las cuentas A/B; la medición no
// arranca ni para el stack. Un perfil ajeno devuelve 3; un stack parado, 8.

export const PERF_PROFILES = ["test", "scratch"]
const fail = (code, phase, message) => { throw new BiblibError(code, phase, message) }

export async function perfContext(profile) {
  if (!PERF_PROFILES.includes(profile)) fail(EXIT.INVALID_ARGS, "perfil", "perf:local solo admite los perfiles test y scratch.")
  const resolved = await resolveSeedTarget(profile)
  const census = loadCensus()
  const store = readFixtureStore(resolved, census)
  if (!store?.accounts?.a?.id || !store?.accounts?.b?.id || store.phase !== "completado") fail(EXIT.SEED_FAILED, "fixtures", `Faltan fixtures A/B completos; ejecuta pnpm db:seed:local --profile ${profile}.`)
  const app = resolved.stack.profile.app
  return {
    profile, resolved, census, store, env: resolved.target.env(), root: resolved.stack.root, ports: resolved.stack.profile.ports, projectId: resolved.stack.profile.projectId,
    appUrl: `http://${app.host}:${app.port}`, users: { a: store.accounts.a.id, b: store.accounts.b.id },
  }
}

export const database = (ctx, applicationName) => connect(ctx.resolved, { applicationName })

/** Arranca `next-target start local --profile <perfil>` y espera a /login; nunca termina a un ocupante del puerto. */
export async function startPerfApp(ctx, env, { logFile }) {
  if (await portInUse(Number(new URL(ctx.appUrl).port))) fail(EXIT.SERVICE_UNAVAILABLE, "app", `El puerto de la app (${ctx.appUrl}) está ocupado; no se termina al ocupante. Libéralo y repite.`)
  const child = spawn(process.execPath, ["scripts/next-target.mjs", "start", "local", "--profile", ctx.profile], {
    cwd: REPO_ROOT, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  })
  const log = createWriteStream(logFile)
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail(child.exitCode === EXIT.IDENTITY_MISMATCH ? EXIT.IDENTITY_MISMATCH : EXIT.SERVICE_UNAVAILABLE, "app", "La app no arrancó con el build de este perfil; revisa .biblib/performance/app.log y compila sin --reuse-build.")
    try {
      const response = await fetch(`${ctx.appUrl}/login`, { redirect: "manual", signal: AbortSignal.timeout(2000) })
      if (response.status === 200) return child
    } catch { /* Todavía arrancando. */ }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  stopTree(child)
  fail(EXIT.SERVICE_UNAVAILABLE, "app", "La app del perfil no respondió en 60 s.")
}
