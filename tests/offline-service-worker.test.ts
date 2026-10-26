import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import vm from "node:vm"
import { pathToFileURL } from "node:url"

// U-EXP-08 · Service worker de shell estático (public/sw.js): qué peticiones guarda y cuáles nunca, versión
// por URL y limpieza de versiones anteriores y del modo de limpieza. Se ejecuta en un contexto aislado con
// cachés en memoria; la instalación real la cubre el E2E (tests/e2e/flujos/offline.spec.ts).

const ORIGIN = "http://127.0.0.1:3148"
const source = readFileSync(path.join(process.cwd(), "public", "sw.js"), "utf8")

type Listener = (event: Record<string, unknown>) => void
interface Worker {
  listeners: Map<string, Listener>
  caches: Map<string, Map<string, Response>>
  deletedDatabases: string[]
  unregistered: boolean
  setOnline(online: boolean): void
  fetched: { url: string; credentials?: string }[]
  api: { VERSION: string; CACHE: string; CLEANUP: boolean; classify(url: URL, request: { method: string; mode?: string; headers: Headers }): string }
}

function loadWorker(query: string, { html = "<html><script src=\"/_next/static/chunks/app.js\"></script><link rel=\"stylesheet\" href=\"/_next/static/css/app.css\"></html>", existingCaches = [] as string[] } = {}): Worker {
  const listeners = new Map<string, Listener>()
  const cacheStore = new Map<string, Map<string, Response>>(existingCaches.map((name) => [name, new Map()]))
  const fetched: Worker["fetched"] = []
  const deletedDatabases: string[] = []
  const state = { unregistered: false, online: true }
  const openCache = (name: string) => {
    if (!cacheStore.has(name)) cacheStore.set(name, new Map())
    const entries = cacheStore.get(name)!
    const key = (input: string | Request) => new URL(typeof input === "string" ? input : input.url, ORIGIN).href
    return {
      async add(input: string | Request) { entries.set(key(input), await fakeFetch(input)) },
      async addAll(inputs: (string | Request)[]) { for (const input of inputs) entries.set(key(input), await fakeFetch(input)) },
      async put(input: string | Request, response: Response) { entries.set(key(input), response) },
      async match(input: string | Request) { return entries.get(key(input)) },
      async keys() { return [...entries.keys()].map((url) => new Request(url)) },
      async delete(input: string | Request) { return entries.delete(key(input)) },
    }
  }
  /** Respuesta del propio origen, como la de un fetch real (`type: "basic"`). */
  const basic = (body: string, init: ResponseInit) => Object.defineProperty(new Response(body, init), "type", { value: "basic" })
  async function fakeFetch(input: string | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input.url, ORIGIN)
    fetched.push({ url: url.pathname, credentials: init?.credentials ?? (typeof input === "string" ? undefined : input.credentials) })
    if (!state.online) throw new TypeError("Failed to fetch")
    if (url.pathname === "/offline") return basic(html, { status: 200, headers: { "Content-Type": "text/html" } })
    if (url.pathname.endsWith(".css")) return basic("@font-face{src:url(/_next/static/media/fraunces.woff2)}", { status: 200 })
    return basic("ok", { status: 200 })
  }
  const self = {
    location: new URL(`/sw.js${query}`, ORIGIN),
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined },
    registration: { unregister: async () => { state.unregistered = true; return true } },
  } as Record<string, unknown>
  // En un worker real las URL relativas se resuelven contra su origen; en Node hace falta una base.
  class WorkerRequest extends Request {
    constructor(input: RequestInfo | URL, init?: RequestInit) { super(typeof input === "string" ? new URL(input, ORIGIN).href : input, init) }
  }
  const context = vm.createContext({
    self, URL, URLSearchParams, Request: WorkerRequest, Response, Headers, Promise, Set, Map, Error,
    fetch: fakeFetch,
    caches: {
      open: async (name: string) => openCache(name),
      keys: async () => [...cacheStore.keys()],
      delete: async (name: string) => cacheStore.delete(name),
    },
    indexedDB: {
      databases: async () => [{ name: "biblib-offline-aaaa" }, { name: "otra-app" }],
      deleteDatabase: (name: string) => {
        deletedDatabases.push(name)
        const request: Record<string, (() => void) | null> = { onsuccess: null, onerror: null, onblocked: null }
        setTimeout(() => request.onsuccess?.(), 0)
        return request
      },
    },
  })
  vm.runInContext(source, context, { filename: pathToFileURL(path.join(process.cwd(), "public", "sw.js")).href })
  return {
    listeners, caches: cacheStore, deletedDatabases, fetched, api: self.__biblibServiceWorker as Worker["api"],
    get unregistered() { return state.unregistered },
    setOnline: (online: boolean) => { state.online = online },
  }
}

async function dispatch(worker: Worker, type: string, extra: Record<string, unknown> = {}) {
  const pending: Promise<unknown>[] = []
  worker.listeners.get(type)?.({ waitUntil: (promise: Promise<unknown>) => pending.push(promise), ...extra })
  await Promise.all(pending)
}

const request = (method: string, headers: Record<string, string> = {}, mode = "cors") => ({ method, mode, headers: new Headers(headers) })

test("solo guarda estáticos versionados y la página /offline; nunca acciones, RSC, /api, callback ni HTML de otras rutas", () => {
  const { api } = loadWorker("?v=1")
  const classify = (pathname: string, init = request("GET")) => api.classify(new URL(pathname, ORIGIN), init)
  assert.equal(classify("/_next/static/chunks/app.js"), "static")
  assert.equal(classify("/_next/static/media/fraunces.woff2"), "static")
  for (const icon of ["/logo-mark.png", "/logo.png", "/manifest.webmanifest"]) assert.equal(classify(icon), "static")
  assert.equal(classify("/offline", request("GET", {}, "navigate")), "offline-page")
  assert.equal(classify("/books", request("GET", {}, "navigate")), "navigate", "Las navegaciones van a la red y nunca se guardan")
  for (const ignored of ["/api/books/search", "/api/library/export", "/auth/callback", "/sw.js", "/_next/image", "/books"]) assert.equal(classify(ignored), "ignore", ignored)
  assert.equal(classify("/books", request("POST", { "Next-Action": "abc" })), "ignore")
  assert.equal(classify("/books", request("GET", { RSC: "1" })), "ignore")
  assert.equal(classify("/books?_rsc=x", request("GET")), "ignore")
  assert.equal(classify("/offline?_rsc=x", request("GET", {}, "navigate")), "ignore")
  assert.equal(api.classify(new URL("https://covers.openlibrary.org/b/id/1-M.jpg"), request("GET")), "ignore", "Imágenes remotas fuera")
})

test("la versión sale de la URL de registro y la instalación guarda /offline pedida sin cookies con sus estáticos", async () => {
  const worker = loadWorker("?v=2026-10-26.1")
  assert.equal(worker.api.VERSION, "2026-10-26.1")
  assert.equal(worker.api.CACHE, "biblib-shell-2026-10-26.1")
  await dispatch(worker, "install")
  const cached = [...(worker.caches.get("biblib-shell-2026-10-26.1")?.keys() ?? [])].map((url) => new URL(url).pathname).sort()
  assert.deepEqual(cached, ["/_next/static/chunks/app.js", "/_next/static/css/app.css", "/_next/static/media/fraunces.woff2", "/default-book-cover.webp", "/logo-dark.png", "/logo-mark.png", "/logo-transparent.png", "/logo.png", "/manifest.webmanifest", "/offline"].sort())
  assert.ok(worker.fetched.filter((entry) => entry.url === "/offline").every((entry) => entry.credentials === "omit"), "La página sin conexión se pide sin cookies")
})

test("al activarse una versión nueva se borran las cachés de las anteriores y las ajenas a BibLib se conservan", async () => {
  const worker = loadWorker("?v=2", { existingCaches: ["biblib-shell-1", "otra-cache"] })
  await dispatch(worker, "install")
  await dispatch(worker, "activate")
  assert.deepEqual([...worker.caches.keys()].sort(), ["biblib-shell-2", "otra-cache"])
  assert.equal(worker.unregistered, false)
  assert.deepEqual(worker.deletedDatabases, [], "El worker normal no toca las copias")
})

test("worker de limpieza: no instala nada, borra cachés y copias del origen y se da de baja", async () => {
  const worker = loadWorker("?v=2&modo=limpieza", { existingCaches: ["biblib-shell-1", "biblib-shell-2"] })
  assert.equal(worker.api.CLEANUP, true)
  await dispatch(worker, "install")
  assert.equal(worker.fetched.length, 0)
  await dispatch(worker, "activate")
  assert.deepEqual([...worker.caches.keys()], [])
  assert.deepEqual(worker.deletedDatabases, ["biblib-offline-aaaa"])
  assert.equal(worker.unregistered, true)
  let responded = false
  worker.listeners.get("fetch")?.({ request: new Request(`${ORIGIN}/_next/static/chunks/app.js`), respondWith: () => { responded = true } })
  assert.equal(responded, false, "En limpieza no intercepta ninguna petición")
})

test("navegación sin red: redirige a /offline, que se sirve de la caché; con red responde la red sin guardar", async () => {
  const worker = loadWorker("?v=3")
  await dispatch(worker, "install")
  const navigate = async (pathname: string) => {
    let response: Promise<Response> | undefined
    const pending: Promise<unknown>[] = []
    worker.listeners.get("fetch")?.({
      request: { url: `${ORIGIN}${pathname}`, method: "GET", mode: "navigate", headers: new Headers() },
      respondWith: (promise: Promise<Response>) => { response = promise },
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    })
    const result = await response
    await Promise.all(pending)
    return result
  }
  const before = worker.caches.get("biblib-shell-3")?.size
  assert.equal((await navigate("/books"))?.status, 200)
  assert.equal(worker.caches.get("biblib-shell-3")?.size, before, "La respuesta de una ruta autenticada no se guarda")

  worker.setOnline(false)
  const redirected = await navigate("/books")
  assert.equal(redirected?.status, 302)
  assert.equal(redirected?.headers.get("location"), `${ORIGIN}/offline`)
  const offline = await navigate("/offline")
  assert.equal(offline?.status, 200)
  assert.match(await offline!.text(), /_next\/static\/chunks\/app\.js/)
})

test("cabeceras: sw.js y /offline sin caché larga (private, no-store) y el manifiesto como archivo público", async () => {
  type HeaderRule = { source: string; headers: { key: string; value: string }[] }
  const config = await import(pathToFileURL(path.join(process.cwd(), "next.config.mjs")).href) as { default: { headers(): Promise<HeaderRule[]> } }
  const rules = (await config.default.headers()).filter((rule) => rule.headers.some(({ key }) => key === "Cache-Control"))
  assert.equal(rules.length, 1, "Una sola regla de Cache-Control: la matriz de U-OPS-04 no cambia")
  const matches = new RegExp(`^${rules[0].source}$`)
  assert.deepEqual(rules[0].headers.find(({ key }) => key === "Cache-Control"), { key: "Cache-Control", value: "private, no-store" })
  for (const route of ["/sw.js", "/offline", "/api/library/export", "/auth/callback"]) assert.ok(matches.test(route), route)
  assert.ok(!matches.test("/manifest.webmanifest"))
  assert.ok(!matches.test("/_next/static/chunks/app.js"))
})
