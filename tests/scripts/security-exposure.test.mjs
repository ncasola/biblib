import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { APP_EXCLUDED_KEYS, appEnv, childEnv } from "../../scripts/db/environment.mjs"
import { nextEnv } from "../../scripts/next-target.mjs"
import { checkCsp, checkNonce, checkResponse, GLOBAL_HEADERS, REQUESTS, RESPONSE_TYPES } from "../../scripts/security/headers-matrix.mjs"
import { parseArgs, resolveRoute } from "../../scripts/security/headers-local.mjs"

// U-OPS-04 · Exposición sin stack: la credencial administrativa no llega al proceso de Next, ningún
// código de la app la nombra, la Data API no publica biblib y la matriz de cabeceras cubre todas las
// rutas de app/ y detecta las desviaciones que debe detectar.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const admin = "administrativa-simulada-no-real"
const context = (extra = {}) => ({ target: "local", env: () => ({ BIBLIB_TARGET: "local", BIBLIB_PROFILE: "scratch", SUPABASE_SERVICE_ROLE_KEY: admin, SUPABASE_URL: "http://127.0.0.1:55341", ...extra }) })

test("service_role: childEnv la conserva para seed/fixtures, pero el proceso de Next la recibe vacía", () => {
  assert.deepEqual(APP_EXCLUDED_KEYS, ["SUPABASE_SERVICE_ROLE_KEY"])
  assert.equal(childEnv(context()).SUPABASE_SERVICE_ROLE_KEY, admin, "Los procesos de preparación siguen recibiéndola de su contexto.")
  for (const env of [appEnv(context()), nextEnv(context(), "dev"), nextEnv(context(), "build"), nextEnv(context(), "start")]) {
    assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, "", "Vacía y definida: Next no la carga después desde .env.local.")
    assert.ok(!Object.values(env).includes(admin))
  }
  assert.equal(nextEnv(context(), "dev").NODE_ENV, "development")
  assert.equal(nextEnv(context(), "start").NODE_ENV, "production")
})

test("service_role: tampoco se hereda del shell que lanza el wrapper", () => {
  const previous = process.env.SUPABASE_SERVICE_ROLE_KEY
  process.env.SUPABASE_SERVICE_ROLE_KEY = "heredada-del-shell"
  try {
    const env = nextEnv({ target: "local", env: () => ({ BIBLIB_TARGET: "local" }) }, "start")
    assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, "")
  } finally {
    if (previous === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previous
  }
})

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name)
    return statSync(file).isDirectory() ? sources(file) : /\.(ts|tsx|mjs|js)$/.test(name) ? [file] : []
  })
}

test("ninguna ruta, acción, componente ni el proxy usan la credencial administrativa", () => {
  const files = [...["app", "components", "hooks", "lib"].flatMap((dir) => sources(path.join(ROOT, dir))), path.join(ROOT, "proxy.ts"), path.join(ROOT, "next.config.mjs")]
  assert.ok(files.length > 50)
  const offenders = files.filter((file) => /service_role|SERVICE_ROLE|auth\.admin/.test(readFileSync(file, "utf8")))
  assert.deepEqual(offenders.map((file) => path.relative(ROOT, file)), [])
})

test("supabase/config.toml: la Data API solo publica public y graphql_public", () => {
  const config = readFileSync(path.join(ROOT, "supabase/config.toml"), "utf8")
  const api = /^\[api\]$([\s\S]*?)^\[/m.exec(config)?.[1] ?? ""
  const schemas = JSON.parse(/^schemas\s*=\s*(\[.*\])$/m.exec(api)?.[1] ?? "null")
  assert.deepEqual(schemas, ["public", "graphql_public"])
  assert.doesNotMatch(/^extra_search_path\s*=.*$/m.exec(api)?.[0] ?? "", /biblib|drizzle/)
})

/** Rutas reales de app/: page.tsx y route.ts, sin grupos y con segmentos dinámicos como :libroA. */
function appRoutes() {
  const found = []
  const walk = (dir, segments) => {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name)
      if (statSync(file).isDirectory()) walk(file, /^\(.+\)$/.test(name) ? segments : [...segments, name])
      else if (/^(page\.tsx|route\.ts)$/.test(name)) found.push(`/${segments.join("/")}`.replace(/\[[^\]]+\]/g, ":libroA"))
    }
  }
  walk(path.join(ROOT, "app"), [])
  return found.sort()
}

test("la matriz cubre todas las rutas de app/ (si se añade una, el inventario debe ampliarse)", () => {
  const covered = new Set(REQUESTS.map((request) => request.route.split("?")[0]))
  const missing = appRoutes().filter((route) => !covered.has(route))
  assert.deepEqual(missing, [])
  for (const request of REQUESTS) assert.ok(RESPONSE_TYPES[request.type], request.type)
  const types = new Set(REQUESTS.map((request) => request.type))
  for (const type of Object.keys(RESPONSE_TYPES)) assert.ok(types.has(type), `tipo sin petición: ${type}`)
})

const csp = "default-src 'self'; script-src 'self' 'nonce-QUJDREVGR0hJSktMTU5PUA==' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://covers.openlibrary.org; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
const response = (status, extra = {}, body = null) => ({ status, body, headers: new Headers({ ...GLOBAL_HEADERS, ...extra }) })

test("checkResponse acepta una respuesta conforme y detecta caché compartida, CSP aplicada y cabeceras ausentes", () => {
  const html = `<script nonce="QUJDREVGR0hJSktMTU5PUA==">a</script><script src="/x.js" nonce="QUJDREVGR0hJSktMTU5PUA=="></script>`
  const ok = response(200, { "cache-control": "private, no-store", "content-type": "text/html; charset=utf-8", "content-security-policy-report-only": csp }, html)
  assert.deepEqual(checkResponse({ type: "html-autenticado" }, ok), [])
  const cached = response(200, { "cache-control": "s-maxage=31536000", "content-type": "text/html", "content-security-policy-report-only": csp }, html)
  assert.ok(checkResponse({ type: "html-autenticado" }, cached).some((problem) => /cache-control/.test(problem)))
  const enforced = response(200, { "cache-control": "private, no-store", "content-type": "text/html", "content-security-policy": csp, "content-security-policy-report-only": csp }, html)
  assert.ok(checkResponse({ type: "html-autenticado" }, enforced).some((problem) => /modo informe/.test(problem)))
  const headers = new Headers({ "cache-control": "private, no-store", vary: "Cookie", location: "/login?redirect=%2F", "content-security-policy-report-only": csp })
  assert.ok(checkResponse({ type: "redireccion-sesion", location: "/login?redirect=%2F" }, { status: 307, headers, body: null }).some((problem) => /x-frame-options/.test(problem)))
  const redirect = response(307, { "cache-control": "private, no-store", location: "/", "content-security-policy-report-only": csp })
  assert.ok(checkResponse({ type: "redireccion-sesion", location: "/" }, redirect).some((problem) => /vary sin Cookie/.test(problem)))
  const staticFile = response(200, { "cache-control": "public, max-age=0", "set-cookie": "sb-x-auth-token=1" })
  assert.ok(checkResponse({ type: "estatico-public" }, staticFile).some((problem) => /cookies/.test(problem)))
})

test("checkCsp y checkNonce rechazan comodines, Google/BNE sin flag, unsafe-inline y scripts sin nonce", () => {
  assert.deepEqual(checkCsp(csp), [])
  assert.ok(checkCsp(csp.replace("'strict-dynamic'", "'unsafe-inline'")).some((problem) => /unsafe-inline/.test(problem)))
  assert.ok(checkCsp(`${csp}; connect-src 'self' https://www.googleapis.com`).some((problem) => /Google/.test(problem)))
  assert.ok(checkCsp(`${csp}; connect-src *`).some((problem) => /comodín/.test(problem)))
  assert.ok(checkCsp(csp.replace(/'nonce-[^']+'/, "")).some((problem) => /sin nonce/.test(problem)))
  assert.deepEqual(checkNonce(csp, `<script nonce="otro">x</script>`), ["1 de 1 <script> sin el nonce de la respuesta"])
})

test("headers-local: argumentos cerrados y marcadores resueltos", () => {
  assert.deepEqual(parseArgs(["--profile", "scratch", "--reuse-build"]), { profile: "scratch", reuseBuild: true, out: null })
  for (const argv of [["--profile", "main"], ["--profile", "prod"], ["--url", "https://externo.invalid"], ["--reuse-build", "--reuse-build"]]) {
    assert.throws(() => parseArgs(argv), (error) => error.code === 2, argv.join(" "))
  }
  assert.equal(resolveRoute("/book/:libroA", { bookId: "b1", chunk: "c.js" }), "/book/b1")
  assert.equal(resolveRoute(":chunk", { bookId: "b1", chunk: "c.js" }), "/_next/static/chunks/c.js")
})
