import assert from "node:assert/strict"
import { test } from "node:test"
import { readProxySession } from "../lib/supabase/proxy-session"

const validUser = { data: { user: { id: "cuenta-ficticia" } }, error: null }
const validSession = { data: { session: { access_token: "token-ficticio" } } }

test("proxy: valida antes de autenticar y conserva el token para la atestación", async () => {
  const result = await readProxySession(() => ({ auth: {
    getUser: async () => validUser, getSession: async () => validSession,
  } }))
  assert.deepEqual(result, { authenticated: true, sessionError: false, userId: "cuenta-ficticia", accessToken: "token-ficticio" })
})

test("proxy: sesión ausente no es caída y un error nunca autentica aunque traiga usuario", async () => {
  for (const name of ["AuthSessionMissingError", "AuthRetryableFetchError"]) {
    const result = await readProxySession(() => ({ auth: {
      getUser: async () => ({ ...validUser, error: { name } }),
      getSession: async () => assert.fail("No debe leer una sesión sin usuario validado"),
    } }))
    assert.deepEqual(result, { authenticated: false, sessionError: name !== "AuthSessionMissingError" })
  }
})

test("proxy: Auth sin respuesta tiene plazo, cancela la red y no concede acceso tardío", async () => {
  let signal: AbortSignal | undefined
  let complete: (value: typeof validUser) => void = () => assert.fail("Falta la petición")
  const started = performance.now()
  const result = await readProxySession((received) => {
    signal = received
    return { auth: {
      getUser: () => new Promise((resolve) => { complete = resolve }),
      getSession: async () => validSession,
    } }
  }, 30)
  assert.deepEqual(result, { authenticated: false, sessionError: true })
  assert.equal(signal?.aborted, true)
  assert.ok(performance.now() - started < 1_000)
  complete(validUser)
  await Promise.resolve()
  assert.equal(result.authenticated, false)
})

test("proxy: la renovación también comparte el plazo y un fallo cierra el acceso", async () => {
  const result = await readProxySession(() => ({ auth: {
    getUser: async () => validUser,
    getSession: () => new Promise(() => {}),
  } }), 30)
  assert.deepEqual(result, { authenticated: false, sessionError: true })
  assert.deepEqual(await readProxySession(() => { throw new Error("Auth caído") }), { authenticated: false, sessionError: true })
})
