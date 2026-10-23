import { createWriteStream, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { BiblibError, EXIT } from "../lib/exit-codes.mjs"
import { REPO_ROOT } from "../lib/profiles.mjs"
import { acquireLock } from "../lib/state.mjs"
import { loadCensus, resolveSeedTarget } from "../db/seed-local.mjs"
import { readFixtureStore } from "../db/fixture-store.mjs"
import { closeConnection, connect } from "../db/target.mjs"
import { distDir } from "../next-target.mjs"
import { checkResponse, REQUESTS } from "./headers-matrix.mjs"
import { cookieHeader, loadActions } from "../../tests/integration/lib/app.mjs"
import { portInUse, run, stopTree } from "../../tests/integration/lib/process.mjs"
import { signInFixture } from "../../tests/integration/support/session.mjs"

// pnpm security:headers:local [--profile scratch|test] [--reuse-build] [--out archivo.json] — U-OPS-04.
// Compila la app con build:local, la arranca con start:local en el puerto del perfil, pide las rutas del
// inventario (anónimo y con la sesión real de A) y compara las cabeceras efectivas con la matriz de
// docs/seguridad.md. Sin red externa: catálogo en modo fixture y solo GoTrue/Postgres del perfil.
// Sale con 11 si alguna respuesta no coincide; nunca imprime cookies, tokens ni cuerpos.

const PROFILES = ["scratch", "test"]
const LOG_DIR = path.join(REPO_ROOT, ".biblib", "security")
const usage = "Uso: security:headers:local [--profile scratch|test] [--reuse-build] [--out archivo.json]."
const fail = (code, phase, message) => { throw new BiblibError(code, phase, message) }

export function parseArgs(argv) {
  const parsed = { profile: "scratch", reuseBuild: false, out: null }
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (seen.has(flag)) fail(EXIT.INVALID_ARGS, "argumentos", usage)
    seen.add(flag)
    if (flag === "--profile" && PROFILES.includes(argv[i + 1])) parsed.profile = argv[++i]
    else if (flag === "--reuse-build") parsed.reuseBuild = true
    else if (flag === "--out" && argv[i + 1] && !argv[i + 1].startsWith("--")) parsed.out = path.resolve(argv[++i])
    else fail(EXIT.INVALID_ARGS, "argumentos", usage)
  }
  return parsed
}

/** Entorno heredado sin selectores de Supabase/Postgres/BibLib: next-target construye el suyo. */
export function childEnvironment(profile) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SUPABASE_|NEXT_PUBLIC_SUPABASE_|DATABASE_URL$|PG|POSTGRES_|BIBLIB_|GOOGLE_BOOKS_API_KEY$)/i.test(key)))
  return { ...base, BIBLIB_TARGET: "local", BIBLIB_PROFILE: profile }
}

async function startApp(resolved, profile, env, logFile) {
  const { host, port } = resolved.stack.profile.app
  if (await portInUse(port)) fail(EXIT.SERVICE_UNAVAILABLE, "app", `El puerto de la app (${host}:${port}) está ocupado; no se termina al ocupante.`)
  const child = spawn(process.execPath, ["scripts/next-target.mjs", "start", "local", "--profile", profile], {
    cwd: REPO_ROOT, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  })
  const log = createWriteStream(logFile)
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail(EXIT.SERVICE_UNAVAILABLE, "app", "La app no arrancó; revisa .biblib/security/app.log.")
    try { if ((await fetch(`http://${host}:${port}/login`, { redirect: "manual", signal: AbortSignal.timeout(2000) })).status === 200) return child } catch { /* Arrancando. */ }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  stopTree(child)
  fail(EXIT.SERVICE_UNAVAILABLE, "app", "La app no respondió en 60 s.")
}

/** Sustituye los marcadores del inventario por datos reales del perfil y del build. */
export function resolveRoute(route, { bookId, chunk }) {
  return route.replace(":libroA", bookId).replace(":chunk", `/_next/static/chunks/${chunk}`)
}

export async function probe(request, { baseUrl, cookies, actions, values }) {
  const route = resolveRoute(request.route, values)
  const headers = { Cookie: request.as === "a" ? cookieHeader(cookies) : "" }
  let body = request.body
  if (request.action) {
    const action = actions.get(request.action)
    if (!action) fail(EXIT.VERIFICATION_FAILED, "acciones", `La acción ${request.action} no está en el build.`)
    Object.assign(headers, { "Next-Action": action.id, "Content-Type": "text/plain;charset=UTF-8", Accept: "text/x-component", Origin: baseUrl })
    body = "[]"
  } else if (body) headers["Content-Type"] = "application/json"
  const response = await fetch(`${baseUrl}${route}`, { method: request.method ?? "GET", headers, body, redirect: "manual", signal: AbortSignal.timeout(30_000) })
  const text = /^text\/html/.test(response.headers.get("content-type") ?? "") ? await response.text() : (await response.arrayBuffer(), null)
  const expected = request.loginRedirect ? { ...request, location: `/login?redirect=${encodeURIComponent(resolveRoute(request.loginRedirect, values))}` } : request
  const problems = checkResponse(expected, { status: response.status, headers: response.headers, body: text })
  return {
    route: request.route, as: request.as, method: request.method ?? "GET", type: request.type, status: response.status,
    headers: {
      "cache-control": response.headers.get("cache-control"), vary: response.headers.get("vary"), location: response.headers.get("location"),
      "set-cookie": response.headers.getSetCookie().length ? `${response.headers.getSetCookie().length} cookie(s)` : null,
      csp: response.headers.get("content-security-policy-report-only")?.replace(/'nonce-[^']+'/, "'nonce-…'") ?? null,
    },
    ok: problems.length === 0, problems,
  }
}

export async function main(argv = process.argv.slice(2), out = process.stdout) {
  let app, release, sql
  try {
    const { profile, reuseBuild, out: report } = parseArgs(argv)
    if (process.env.BIBLIB_TARGET && process.env.BIBLIB_TARGET !== "local") fail(EXIT.IDENTITY_MISMATCH, "objetivo", "La verificación de cabeceras solo admite BIBLIB_TARGET=local.")
    mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 })
    const resolved = await resolveSeedTarget(profile)
    release = acquireLock(resolved.stack)
    const store = readFixtureStore(resolved, loadCensus())
    if (!store?.accounts?.a?.id || store.phase !== "completado") fail(EXIT.SEED_FAILED, "fixtures", `Faltan fixtures A/B completos; ejecuta pnpm db:seed:local --profile ${profile}.`)
    sql = connect(resolved, { applicationName: "biblib-security-headers" })
    const [book] = await sql`select id from biblib.books where user_id = ${store.accounts.a.id} order by id limit 1`
    await closeConnection(sql); sql = undefined
    if (!book) fail(EXIT.SEED_FAILED, "fixtures", "La cuenta A no tiene libros fixture.")
    out.write(`Cabeceras efectivas · perfil ${profile} · ${resolved.stack.profile.projectId}\n`)

    const env = childEnvironment(profile)
    if (!reuseBuild) {
      out.write(`Compilando la app para el perfil ${profile}…\n`)
      const code = await run(process.execPath, ["scripts/next-target.mjs", "build", "local", "--profile", profile], { env, logFile: path.join(LOG_DIR, "build.log") })
      if (code !== 0) fail(code === EXIT.IDENTITY_MISMATCH ? code : EXIT.VERIFICATION_FAILED, "build", "Falló el build; revisa .biblib/security/build.log.")
    }
    const chunk = readdirSync(path.join(REPO_ROOT, distDir("local"), "static", "chunks")).find((file) => file.endsWith(".js"))
    if (!chunk) fail(EXIT.VERIFICATION_FAILED, "build", "El build no contiene chunks estáticos.")
    app = await startApp(resolved, profile, env, path.join(LOG_DIR, "app.log"))
    const { host, port } = resolved.stack.profile.app
    const baseUrl = `http://${host}:${port}`
    const session = await signInFixture("a", { profile })
    const context = { baseUrl, cookies: session.cookies().filter((cookie) => cookie.value !== ""), actions: loadActions(REPO_ROOT), values: { bookId: book.id, chunk } }
    const results = []
    for (const request of REQUESTS) results.push(await probe(request, context))
    await session.client.auth.signOut({ scope: "local" }).catch(() => {})

    for (const result of results) {
      out.write(`${result.ok ? "[ok]  " : "[fail]"} ${result.method.padEnd(4)} ${result.as.padEnd(4)} ${result.route.padEnd(56)} ${String(result.status).padEnd(3)} ${result.type}\n`)
      for (const problem of result.problems) out.write(`         - ${problem}\n`)
    }
    const failed = results.filter((result) => !result.ok).length
    const summary = { schemaVersion: 1, profile, project: resolved.stack.profile.projectId, checkedAt: new Date().toISOString(), total: results.length, failed, results }
    const file = report ?? path.join(LOG_DIR, `headers-${profile}.json`)
    writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`)
    out.write(`${results.length - failed}/${results.length} respuestas coinciden con la matriz · informe ${path.relative(REPO_ROOT, file)}\n`)
    return failed ? EXIT.VERIFICATION_FAILED : EXIT.OK
  } catch (error) {
    console.error(`Error [${error instanceof BiblibError ? error.phase : "cabeceras"}]: ${error instanceof BiblibError ? error.message : "Fallo inesperado de la verificación de cabeceras."}`)
    return error instanceof BiblibError ? error.code : EXIT.VERIFICATION_FAILED
  } finally {
    stopTree(app)
    if (sql) await closeConnection(sql)
    release?.()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main()
