import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { after, before, test } from "node:test"
import { assertOwnership, inventory, selectResources } from "../../../scripts/lib/docker.mjs"
import { readState } from "../../../scripts/lib/state.mjs"
import { anonClient, ASSET, BUCKET, runTitle } from "../lib/context.mjs"
import { callAction, get, postJson } from "../lib/app.mjs"
import { liveCookies, signIn } from "../lib/sessions.mjs"
import { setupSuite } from "../lib/suite.mjs"

// Caída de Auth y Storage tal como la ve la app: se detiene el gateway (Kong) del perfil test, por
// el que pasan GoTrue y Storage, y se vuelve a arrancar. Solo se actúa sobre el ID registrado tras
// acreditar la propiedad; la prueba se ejecuta la última y siempre deja el gateway sano.
// GoTrue se detiene también por separado para probar el plazo del proxy con Kong todavía vivo.

const run = promisify(execFile)
let s, cookies, kong, signedUrl, gotrue, authStopped = false

before(async () => {
  s = await setupSuite()
  const stack = s.ctx.resolved.stack
  const state = readState(stack)
  const resources = selectResources(stack, await inventory(stack), state)
  assertOwnership(stack, resources, state)
  const container = resources.containers.find((c) => c.name === `supabase_kong_${stack.profile.projectId}`)
  assert.ok(container && state.resources.containers.some((r) => r.id === container.id), "El gateway debe estar registrado como propio.")
  kong = container.id
  const auth = resources.containers.find((c) => c.name === `supabase_auth_${stack.profile.projectId}`)
  assert.ok(auth && state.resources.containers.some((r) => r.id === auth.id), "GoTrue debe estar registrado como propio.")
  gotrue = auth.id
  cookies = liveCookies(await signIn("a"))
  const signed = await s.admin().storage.from(BUCKET).createSignedUrl(ASSET, 300)
  assert.equal(signed.error, null)
  signedUrl = signed.data.signedUrl
})

after(async () => {
  if (authStopped) await startAuth()
  if (kong) await start().catch(() => {})
  await s?.close()
})

async function startAuth() {
  await run("docker", ["container", "start", gotrue], { windowsHide: true })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (await reachable(`${s.ctx.env.SUPABASE_URL}/auth/v1/health`) === 200) { authStopped = false; return }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error("GoTrue del perfil test no recuperó la salud en 60 s.")
}

test("GoTrue caído con Kong vivo: el proxy cierra el acceso en menos de 9 s y conserva las rutas públicas", async (t) => {
  assert.equal((await get(s.app, "/books", { cookies })).status, 200)
  await run("docker", ["container", "stop", "--time", "5", gotrue], { windowsHide: true })
  authStopped = true
  try {
    const started = performance.now()
    const page = await get(s.app, "/books?status=read", { cookies })
    const elapsed = Math.round(performance.now() - started)
    t.diagnostic(`Proxy con GoTrue caído: redirección en ${elapsed} ms.`)
    assert.ok(elapsed < 9_000, "No debe esperar los ~60 s de Kong.")
    assert.equal(page.status, 307)
    const target = new URL(page.location, s.app.url)
    assert.equal(target.pathname, "/login")
    assert.equal(target.searchParams.get("error"), "session")
    assert.equal(target.searchParams.get("redirect"), "/books?status=read")
    assert.equal((await get(s.app, "/login")).status, 200)
    const login = await get(s.app, "/login?error=session", { cookies })
    assert.equal(login.status, 200, "El acceso sigue público incluso con una cookie que Auth no puede validar.")
    assert.match(login.body.toString("utf8"), /No se pudo comprobar tu sesión/)
    assert.equal((await get(s.app, "/offline")).status, 200)
    assert.equal((await get(s.app, "/default-book-cover.webp")).status, 200)
  } finally { await startAuth() }
  assert.equal((await get(s.app, "/books", { cookies })).status, 200)
})

async function status() {
  const { stdout } = await run("docker", ["container", "inspect", kong, "--format", "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}"], { windowsHide: true })
  return stdout.trim()
}

async function reachable(url) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(3000) })).status } catch { return 0 }
}

async function start() {
  await run("docker", ["container", "start", kong], { windowsHide: true })
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    if (await status() === "running healthy" && await reachable(`${s.ctx.env.SUPABASE_URL}/auth/v1/health`) === 200) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error("El gateway del perfil test no recuperó la salud en 60 s.")
}

test("con Auth y Storage inaccesibles no se sirven datos privados ni objetos, y todo vuelve al recuperarlos", async () => {
  assert.equal((await get(s.app, "/books?status=read", { cookies })).status, 200)
  assert.equal(await reachable(signedUrl), 200)
  await run("docker", ["container", "stop", "--time", "5", kong], { windowsHide: true })
  try {
    assert.match(await status(), /^exited/)
    const page = await get(s.app, "/books?status=read", { cookies })
    assert.equal(page.status, 307)
    const target = new URL(page.location, s.app.url)
    assert.equal(target.pathname, "/login")
    assert.equal(target.searchParams.get("redirect"), "/books?status=read")
    assert.equal(target.searchParams.get("error"), "session", "El acceso indica un fallo de sesión.")
    const action = await callAction(s.app, "listBooksAction", [{ pageSize: 100 }], { cookies })
    assert.equal(action.value, undefined, "Sin Auth no hay datos de dominio.")
    const api = await postJson(s.app, "/api/books/add", { title: runTitle("Durante la caída"), isbn: "", authors: [], number_of_pages: 1, publish_date: "", status: "unread" }, { cookies })
    assert.equal(api.status, 401)
    assert.notEqual(await reachable(signedUrl), 200, "Sin Storage no se sirve el objeto firmado.")
    const download = await anonClient(s.ctx).storage.from(BUCKET).download(ASSET)
    assert.ok(download.error)
    assert.equal((await get(s.app, "/default-book-cover.webp")).status, 200, "La portada por defecto no depende de Supabase ni de la red.")
  } finally {
    await start()
  }
  assert.equal((await get(s.app, "/books?status=read", { cookies })).status, 200, "La sesión sigue siendo válida al volver Auth.")
  assert.equal(await reachable(signedUrl), 200, "La firma emitida antes de la caída vuelve a servir el objeto.")
  const [{ n }] = await s.sql`select count(*)::int as n from biblib.books where title like ${runTitle("%")}`
  assert.equal(n, 0, "Nada se escribió durante la caída.")
})
