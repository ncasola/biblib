/* BibLib · service worker de shell estático (U-EXP-08, contrato en docs/spec-pendientes/contratos-o15.md).
 *
 * Solo guarda recursos estáticos versionados (/_next/static, fuentes, iconos y el manifiesto) y la página
 * propia /offline, pedida sin cookies. Nunca guarda HTML de otras rutas, cargas RSC, Server Actions, /api,
 * el callback OAuth ni imágenes remotas. La copia de lectura vive en IndexedDB, cifrada y por cuenta; este
 * worker no la lee.
 *
 * La versión llega en la URL de registro (`/sw.js?v=<versión>`): una versión nueva instala un worker nuevo,
 * que borra las cachés de las anteriores al activarse. Con `?modo=limpieza` (o FORZAR_LIMPIEZA) es el worker
 * de limpieza: borra todas las cachés y las bases de copia de este origen y se da de baja.
 */

// Recuperación: publicar este archivo con `true` convierte en limpieza cualquier worker ya instalado en su
// siguiente comprobación de actualización, aunque la página no llegue a cargar.
const FORZAR_LIMPIEZA = false

const params = new URL(self.location.href).searchParams
const VERSION = params.get("v") || "0"
const CLEANUP = FORZAR_LIMPIEZA || params.get("modo") === "limpieza"
const CACHE_PREFIX = "biblib-shell-"
const CACHE = `${CACHE_PREFIX}${VERSION}`
const OFFLINE_DB_PREFIX = "biblib-offline-"
const OFFLINE_URL = "/offline"
const STATIC_FILES = ["/logo-mark.png", "/logo.png", "/logo-transparent.png", "/logo-dark.png", "/manifest.webmanifest", "/default-book-cover.webp"]
const MAX_RUNTIME_ENTRIES = 400
const STATIC_ASSET = /\/_next\/static\/[^"'\s<>()\\]+/g

const FALLBACK_HTML = "<!doctype html><html lang=\"es\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Sin conexión · BibLib</title></head><body style=\"font-family:system-ui,sans-serif;background:#16110d;color:#f6eddd;padding:2rem\"><h1>Sin conexión</h1><p>BibLib necesita conexión para abrir esta página. Vuelve a intentarlo cuando tengas red.</p></body></html>"

/** Qué hace el worker con una petición: `static` (caché primero), `offline-page`, `navigate` (red y, sin red, /offline) o `ignore`. */
function classify(url, request) {
  if (request.method !== "GET" || url.origin !== self.location.origin) return "ignore"
  // Server Actions, cargas RSC (datos de la sesión), API y callback OAuth: siempre a la red, nunca a la caché.
  if (request.headers.get("next-action") || request.headers.get("rsc") || url.searchParams.has("_rsc")) return "ignore"
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/") || url.pathname === "/sw.js") return "ignore"
  if (url.pathname.startsWith("/_next/static/") || STATIC_FILES.includes(url.pathname)) return "static"
  if (request.mode === "navigate") return url.pathname === OFFLINE_URL ? "offline-page" : "navigate"
  return "ignore"
}

const cacheable = (response) => response.ok && response.type === "basic"

/** Página /offline sin cookies y los estáticos que cita (scripts, estilos y las fuentes de esos estilos). */
async function storeOfflinePage(cache) {
  const response = await fetch(OFFLINE_URL, { credentials: "omit", cache: "no-store", redirect: "error" })
  if (!cacheable(response)) throw new Error("La página sin conexión no está disponible.")
  const html = await response.clone().text()
  const assets = new Set(html.match(STATIC_ASSET) ?? [])
  for (const sheet of [...assets].filter((asset) => asset.endsWith(".css"))) {
    const css = await fetch(sheet, { credentials: "omit" }).then((r) => (r.ok ? r.text() : ""), () => "")
    for (const asset of css.match(STATIC_ASSET) ?? []) assets.add(asset)
  }
  await Promise.all([...assets].map((asset) => cache.add(new Request(asset, { credentials: "omit" })).catch(() => undefined)))
  await cache.put(OFFLINE_URL, response)
}

async function precache() {
  const cache = await caches.open(CACHE)
  await cache.addAll(STATIC_FILES.map((file) => new Request(file, { credentials: "omit", cache: "reload" })))
  await storeOfflinePage(cache)
}

async function deleteOfflineDatabases() {
  if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") return
  const names = (await indexedDB.databases()).map((entry) => entry.name || "").filter((name) => name.startsWith(OFFLINE_DB_PREFIX))
  await Promise.all(names.map((name) => new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = request.onerror = request.onblocked = () => resolve()
  })))
}

async function trim(cache) {
  const keys = await cache.keys()
  const runtime = keys.filter((request) => new URL(request.url).pathname.startsWith("/_next/static/"))
  await Promise.all(runtime.slice(0, Math.max(0, runtime.length - MAX_RUNTIME_ENTRIES)).map((request) => cache.delete(request)))
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(request, { ignoreVary: true })
  if (hit) return hit
  const response = await fetch(request)
  if (cacheable(response)) await cache.put(request, response.clone()).then(() => trim(cache)).catch(() => undefined)
  return response
}

async function cachedOfflinePage() {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(OFFLINE_URL, { ignoreSearch: true, ignoreVary: true })
  return hit || new Response(FALLBACK_HTML, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } })
}

self.addEventListener("install", (event) => {
  self.skipWaiting()
  if (!CLEANUP) event.waitUntil(precache())
})

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    // Al activarse, una versión borra las cachés de las anteriores; la limpieza borra todas las del origen.
    await Promise.all(keys.filter((key) => CLEANUP || (key.startsWith(CACHE_PREFIX) && key !== CACHE)).map((key) => caches.delete(key)))
    if (CLEANUP) {
      await deleteOfflineDatabases()
      await self.registration.unregister()
      return
    }
    await self.clients.claim()
  })())
})

self.addEventListener("fetch", (event) => {
  if (CLEANUP) return
  const request = event.request
  const kind = classify(new URL(request.url), request)
  if (kind === "static") event.respondWith(cacheFirst(request))
  else if (kind === "offline-page") {
    event.respondWith(fetch(request).then((response) => {
      // Con red se sirve la respuesta fresca y se renueva en segundo plano la copia sin cookies.
      event.waitUntil(caches.open(CACHE).then(storeOfflinePage).catch(() => undefined))
      return response
    }, cachedOfflinePage))
  } else if (kind === "navigate") {
    // Sin red, cualquier navegación lleva a la vista sin conexión; con red, la respuesta nunca se guarda.
    event.respondWith(fetch(request).catch(() => Response.redirect(new URL(OFFLINE_URL, self.location.origin).href, 302)))
  }
})

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "biblib:version" && event.ports[0]) event.ports[0].postMessage({ version: VERSION, cleanup: CLEANUP, cache: CACHE })
})

// Solo para las pruebas unitarias del worker (tests/offline-service-worker.test.ts).
self.__biblibServiceWorker = { VERSION, CACHE, CLEANUP, classify }
