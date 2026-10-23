import assert from "node:assert/strict"
import { test } from "node:test"
import profiles from "../supabase/profiles.json"
import {
  authenticateLocalLogin,
  createFailureLimiter,
  isLocalLoginServerAllowed,
  profileApiPorts,
  type LocalLoginDeps,
  type PasswordSignIn,
} from "../app/(auth)/login/local-login-core"

const ports = profileApiPorts(profiles)
const LOCAL_URL = "http://127.0.0.1:55341"

function form(values: Record<string, string>) {
  return { get: (name: string) => values[name] ?? null }
}

function deps(overrides: Partial<LocalLoginDeps> = {}, outcome: PasswordSignIn = "ok") {
  const calls: Array<[string, string]> = []
  const value: LocalLoginDeps = {
    target: "local",
    supabaseUrl: LOCAL_URL,
    allowedPorts: ports,
    limiter: createFailureLimiter(),
    signIn: async (email, password) => { calls.push([email, password]); return outcome },
    ...overrides,
  }
  return { value, calls }
}

test("los puertos permitidos salen de los perfiles versionados", () => {
  assert.deepEqual(ports, [55321, 55331, 55341])
})

test("la guarda solo admite local/test con el loopback exacto de un perfil", () => {
  const allowed = (target: string | undefined, supabaseUrl: string | undefined) => isLocalLoginServerAllowed({ target, supabaseUrl }, ports)
  for (const target of ["local", "test"]) {
    for (const port of ports) assert.equal(allowed(target, `http://127.0.0.1:${port}`), true, `${target}:${port}`)
    assert.equal(allowed(target, `http://127.0.0.1:${ports[0]}/`), true)
  }
  for (const target of ["prod", "preprod", "", "LOCAL", "production", undefined]) assert.equal(allowed(target, LOCAL_URL), false, String(target))
  assert.equal(allowed("test", "https://abcdefghijklmnop.supabase.co"), false)
  assert.equal(allowed("test", "http://localhost:55341"), false)
  assert.equal(allowed("test", "http://[::1]:55341"), false)
  assert.equal(allowed("local", "http://127.0.0.1:54321"), false, "puerto de HolaERP")
  assert.equal(allowed("local", "http://127.0.0.1:55342"), false, "puerto de base de datos, no de API")
  assert.equal(allowed("local", "http://127.0.0.1"), false)
  assert.equal(allowed("local", "https://127.0.0.1:55341"), false)
  assert.equal(allowed("local", "http://127.0.0.1:55341@evil.example"), false)
  assert.equal(allowed("local", "http://usuario:clave@127.0.0.1:55341"), false)
  assert.equal(allowed("local", "http://127.0.0.1.evil.example:55341"), false)
  assert.equal(allowed("local", "http://127.0.0.1:55341/otra-ruta"), false)
  assert.equal(allowed("local", "http://127.0.0.1:55341/?x=1"), false)
  assert.equal(allowed("local", "no es una url"), false)
  assert.equal(allowed("local", undefined), false)
  assert.equal(allowed("local", ""), false)
})

test("la guarda rechaza antes de validar la entrada o crear el cliente", async () => {
  for (const override of [
    { target: undefined }, { target: "prod" }, { target: "preprod" },
    { target: "test", supabaseUrl: "https://abcdefghijklmnop.supabase.co" },
    { target: "local", supabaseUrl: "http://localhost:55341" },
    { target: "local", supabaseUrl: "http://127.0.0.1:54321" },
  ]) {
    const { value, calls } = deps(override)
    const result = await authenticateLocalLogin(form({ email: "lector-a@biblib.test", password: "x" }), value)
    assert.deepEqual(result, { ok: false, code: "UNAUTHORIZED", message: "El acceso local no está disponible." })
    assert.equal(calls.length, 0)
    // Con entrada inválida la respuesta sigue siendo la de la guarda, sin pistas sobre el formulario.
    assert.equal((await authenticateLocalLogin(form({}), value)).ok, false)
    assert.equal(calls.length, 0)
  }
})

test("valida correo y contraseña antes de llamar a GoTrue", async () => {
  const invalid: Array<Record<string, string>> = [
    {}, { email: "", password: "x" }, { email: "sin-arroba", password: "x" }, { email: "a b@biblib.test", password: "x" },
    { email: "a@sinpunto", password: "x" }, { email: `${"a".repeat(246)}@biblib.test`, password: "x" },
    { email: "lector-a@biblib.test" }, { email: "lector-a@biblib.test", password: "" },
    { email: "lector-a@biblib.test", password: "p".repeat(129) },
  ]
  for (const values of invalid) {
    const { value, calls } = deps()
    const result = await authenticateLocalLogin(form(values), value)
    assert.equal(result.ok, false, JSON.stringify(values))
    assert.equal(!result.ok && result.code, "INVALID_INPUT")
    assert.equal(calls.length, 0)
  }
  const limit = `${"a".repeat(242)}@biblib.test`
  assert.equal(limit.length, 254)
  const edge = deps()
  assert.equal((await authenticateLocalLogin(form({ email: limit, password: "p".repeat(128) }), edge.value)).ok, true)
  assert.deepEqual(edge.calls, [[limit, "p".repeat(128)]])
})

test("el acceso correcto conserva el destino interno y descarta los externos", async () => {
  const cases: Array<[string | undefined, string]> = [
    ["/books?search=Quijote#a", "/books?search=Quijote#a"], [undefined, "/"], ["https://example.com", "/"],
    ["//example.com", "/"], ["/login", "/"], ["/\\example.com", "/"],
  ]
  for (const [redirect, expected] of cases) {
    const { value, calls } = deps()
    const result = await authenticateLocalLogin(form({ email: " lector-a@biblib.test ", password: "clave", ...(redirect ? { redirect } : {}) }), value)
    assert.deepEqual(result, { ok: true, redirectTo: expected })
    assert.deepEqual(calls, [["lector-a@biblib.test", "clave"]])
  }
})

test("los errores no distinguen si el usuario existe y no filtran datos", async () => {
  const { value } = deps({}, "invalid")
  const unknown = await authenticateLocalLogin(form({ email: "nadie@biblib.test", password: "clave" }), value)
  const wrong = await authenticateLocalLogin(form({ email: "lector-a@biblib.test", password: "otra" }), value)
  assert.deepEqual(unknown, wrong)
  assert.deepEqual(unknown, { ok: false, code: "UNAUTHORIZED", message: "Correo o contraseña incorrectos." })
  assert.ok(!JSON.stringify(unknown).includes("clave"))
  const down = await authenticateLocalLogin(form({ email: "lector-a@biblib.test", password: "x" }), deps({}, "unavailable").value)
  assert.equal(!down.ok && down.code, "PROVIDER_UNAVAILABLE")
})

test("el limitador bloquea el sexto intento por minuto y se recupera con la ventana", () => {
  let now = 1_000
  const limiter = createFailureLimiter({ now: () => now })
  for (let i = 0; i < 4; i++) { limiter.recordFailure(); assert.equal(limiter.isBlocked(), false) }
  limiter.recordFailure()
  assert.equal(limiter.isBlocked(), true)
  now += 59_999
  assert.equal(limiter.isBlocked(), true)
  now += 2
  assert.equal(limiter.isBlocked(), false)
  limiter.recordFailure()
  limiter.reset()
  assert.equal(limiter.isBlocked(), false)
})

test("tras cinco fallos la acción deja de consultar GoTrue y un acceso correcto reinicia el contador", async () => {
  const limiter = createFailureLimiter()
  const bad = deps({ limiter }, "invalid")
  for (let i = 0; i < 5; i++) {
    const result = await authenticateLocalLogin(form({ email: "lector-a@biblib.test", password: `mal${i}` }), bad.value)
    assert.equal(!result.ok && result.code, "UNAUTHORIZED")
  }
  assert.equal(bad.calls.length, 5)
  const blocked = await authenticateLocalLogin(form({ email: "lector-a@biblib.test", password: "correcta" }), deps({ limiter }, "ok").value)
  assert.equal(!blocked.ok && blocked.code, "RATE_LIMITED")
  assert.equal(bad.calls.length, 5)

  const fresh = createFailureLimiter()
  const mixed = deps({ limiter: fresh }, "invalid")
  for (let i = 0; i < 4; i++) await authenticateLocalLogin(form({ email: "lector-a@biblib.test", password: "mal" }), mixed.value)
  assert.equal((await authenticateLocalLogin(form({ email: "lector-a@biblib.test", password: "bien" }), deps({ limiter: fresh }, "ok").value)).ok, true)
  assert.equal(fresh.isBlocked(), false)
  // Los fallos de red no cuentan como intentos fallidos.
  const network = deps({ limiter: createFailureLimiter() }, "unavailable")
  for (let i = 0; i < 8; i++) await authenticateLocalLogin(form({ email: "lector-a@biblib.test", password: "x" }), network.value)
  assert.equal(network.calls.length, 8)
})
