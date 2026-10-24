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
// (Detener GoTrue o Storage por separado deja a Kong esperando ~60 s al upstream: no aporta más.)

const run = promisify(execFile)
let s, cookies, kong, signedUrl

before(async () => {
  s = await setupSuite()
  const stack = s.ctx.resolved.stack
  const state = readState(stack)
  const resources = selectResources(stack, await inventory(stack), state)
  assertOwnership(stack, resources, state)
  const container = resources.containers.find((c) => c.name === `supabase_kong_${stack.profile.projectId}`)
  assert.ok(container && state.resources.containers.some((r) => r.id === container.id), "El gateway debe estar registrado como propio.")
  kong = container.id
  cookies = liveCookies(await signIn("a"))
  const signed = await s.admin().storage.from(BUCKET).createSignedUrl(ASSET, 300)
  assert.equal(signed.error, null)
  signedUrl = signed.data.signedUrl
})

after(async () => {
  if (kong) await start().catch(() => {})
  await s?.close()
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
