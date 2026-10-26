// Matriz de cabeceras efectivas de U-OPS-04 (docs/seguridad.md). La usan `pnpm security:headers:local`
// y sus pruebas: cada petición del inventario declara su tipo de respuesta y se compara con esta tabla.
// Es un oráculo independiente de next.config.mjs y proxy.ts: si cambian, esta tabla y el documento
// deben revisarse a la vez.

export const GLOBAL_HEADERS = Object.freeze({
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
})

export const ADD_BOOK_PERMISSIONS = "camera=(self), microphone=(), geolocation=(), payment=(), usb=()"

export function permissionsPolicy(route = "") {
  return route.split("?")[0] === "/books/add" ? ADD_BOOK_PERMISSIONS : GLOBAL_HEADERS["permissions-policy"]
}

export const PRIVATE = "private, no-store"
/** Valor propio de Next para la página 404: más estricto que PRIVATE y también sin caché compartida. */
export const NEXT_NOT_FOUND = "private, no-cache, no-store, max-age=0, must-revalidate"
/** Next 16 lo fija siempre en las Server Actions (action-handler) y no admite sustituirlo; no-store impide guardarlas en cualquier caché. */
export const NEXT_ACTION = "no-cache, no-store, max-age=0, must-revalidate"

/**
 * Tipos de respuesta. `csp`: "nonce" exige Report-Only con nonce y que todos los <script> del HTML lo
 * lleven; "present", solo la cabecera; "absent", que no exista. `varyCookie`: Vary debe incluir Cookie.
 * Next fija Vary en las páginas (rsc, router…), por eso el HTML no se exige con Cookie: no-store basta.
 */
export const RESPONSE_TYPES = Object.freeze({
  "html-autenticado": { status: [200], cache: [PRIVATE], contentType: /^text\/html/, csp: "nonce", varyCookie: false },
  "html-publico": { status: [200], cache: [PRIVATE], contentType: /^text\/html/, csp: "nonce", varyCookie: false },
  "html-404": { status: [404], cache: [NEXT_NOT_FOUND, PRIVATE], contentType: /^text\/html/, csp: "nonce", varyCookie: false },
  "redireccion-sesion": { status: [307], cache: [PRIVATE], csp: "present", varyCookie: true },
  "callback": { status: [303], cache: [PRIVATE], csp: "present", varyCookie: true },
  "accion": { status: [200], cache: [NEXT_ACTION], contentType: /^text\/x-component/, csp: "present", varyCookie: false },
  "api": { status: [401], cache: [PRIVATE], contentType: /^application\/json/, csp: "absent", varyCookie: true },
  "estatico-hash": { status: [200], cache: ["public, max-age=31536000, immutable"], csp: "absent", varyCookie: false, noCookies: true },
  "estatico-public": { status: [200], cache: ["public, max-age=0"], csp: "any", varyCookie: false, noCookies: true },
  // U-EXP-08: el service worker nunca lleva caché larga; el navegador lo vuelve a pedir en cada comprobación.
  "service-worker": { status: [200], cache: [PRIVATE], contentType: /javascript/, csp: "present", varyCookie: true, noCookies: true },
})

const PROTECTED = ["/", "/books", "/books/add", "/books/search", "/book/:libroA", "/shelves", "/shelves/3d", "/series", "/series/:libroA", "/locations", "/loans", "/settings", "/profile", "/books/review", "/books/review/:libroA", "/books/print"]

/**
 * Inventario de peticiones. `as`: anon o a (sesión real de A). `location`: destino exacto esperado;
 * `loginRedirect`: ruta que el acceso debe conservar (se resuelve y codifica antes de comparar).
 * `:libroA` y `:chunk` los resuelve el script con datos del perfil y del build.
 */
export const REQUESTS = Object.freeze([
  ...PROTECTED.map((route) => ({ route, as: "a", type: "html-autenticado" })),
  ...PROTECTED.map((route) => ({ route, as: "anon", type: "redireccion-sesion", loginRedirect: route })),
  { route: "/books/search?q=prueba", as: "anon", type: "redireccion-sesion", location: `/login?redirect=${encodeURIComponent("/books/search?q=prueba")}` },
  { route: "/login", as: "anon", type: "html-publico" },
  // U-EXP-08: vista sin conexión pública; no depende de la sesión (el worker la guarda pedida sin cookies).
  { route: "/offline", as: "anon", type: "html-publico" },
  { route: "/offline", as: "a", type: "html-publico" },
  { route: "/sw.js", as: "anon", type: "service-worker" },
  { route: "/login?redirect=%2Fbooks", as: "a", type: "redireccion-sesion", location: "/books" },
  { route: "/login?redirect=https%3A%2F%2Fexterno.invalid%2F", as: "a", type: "redireccion-sesion", location: "/" },
  { route: "/auth/callback?next=%2Fbooks", as: "anon", type: "callback", location: "/login?error=oauth&redirect=%2Fbooks" },
  { route: "/auth/callback?next=https%3A%2F%2Fexterno.invalid%2F", as: "anon", type: "callback", location: "/login?error=oauth&redirect=%2F" },
  { route: "/auth/callback?next=%2F%2Fexterno.invalid", as: "anon", type: "callback", location: "/login?error=oauth&redirect=%2F" },
  { route: "/auth/callback?next=%2F%5Cexterno.invalid", as: "anon", type: "callback", location: "/login?error=oauth&redirect=%2F" },
  { route: "/ruta-inexistente", as: "anon", type: "html-404" },
  { route: "/", as: "a", method: "POST", action: "getLibrarySummaryAction", type: "accion" },
  { route: "/api/books/search?isbn=9780000000002", as: "anon", type: "api" },
  { route: "/api/books/add", as: "anon", method: "POST", body: "{}", type: "api" },
  { route: "/api/internal/jobs/run", as: "anon", method: "POST", type: "api" },
  { route: "/api/library/export?part=0", as: "anon", type: "api" },
  { route: "/api/covers/:libroA", as: "anon", type: "api" },
  { route: "/api/media/:libroA", as: "anon", type: "api" },
  { route: "/logo.png", as: "anon", type: "estatico-public" },
  { route: "/default-book-cover.webp", as: "anon", type: "estatico-public" },
  { route: "/manifest.webmanifest", as: "anon", type: "estatico-public" },
  { route: ":chunk", as: "anon", type: "estatico-hash" },
])

/** `response`: { status, headers (Headers o Map con minúsculas), body (texto o null) }. Devuelve las diferencias. */
export function checkResponse(request, response) {
  const expected = RESPONSE_TYPES[request.type]
  if (!expected) return [`tipo de respuesta desconocido: ${request.type}`]
  const header = (name) => response.headers.get(name)
  const problems = []
  if (!expected.status.includes(response.status)) problems.push(`estado ${response.status}; se esperaba ${expected.status.join(" o ")}`)
  for (const [name, value] of Object.entries(GLOBAL_HEADERS)) {
    const required = name === "permissions-policy" ? permissionsPolicy(request.route) : value
    if (header(name) !== required) problems.push(`${name}: ${header(name) ?? "ausente"}; se esperaba ${required}`)
  }
  const cache = header("cache-control")
  if (!expected.cache.includes(cache)) problems.push(`cache-control: ${cache ?? "ausente"}; se esperaba ${expected.cache.join(" o ")}`)
  if (cache && /s-maxage|public/.test(cache) && !expected.cache.includes(cache)) problems.push("respuesta cacheable por una caché compartida")
  if (expected.contentType && !expected.contentType.test(header("content-type") ?? "")) problems.push(`content-type: ${header("content-type") ?? "ausente"}`)
  const vary = (header("vary") ?? "").split(",").map((item) => item.trim().toLowerCase())
  if (expected.varyCookie && !vary.includes("cookie")) problems.push(`vary sin Cookie: ${header("vary") ?? "ausente"}`)
  if (expected.noCookies && header("set-cookie")) problems.push("un estático no debe fijar cookies")
  if (request.location !== undefined && header("location") !== request.location) problems.push(`location: ${header("location") ?? "ausente"}; se esperaba ${request.location}`)
  if (header("content-security-policy")) problems.push("la CSP debe seguir en modo informe (Report-Only) hasta recoger informes")
  const csp = header("content-security-policy-report-only")
  if (expected.csp === "absent" && csp) problems.push("CSP inesperada en esta respuesta")
  if (["present", "nonce"].includes(expected.csp)) problems.push(...checkCsp(csp))
  if (expected.csp === "nonce" && csp) problems.push(...checkNonce(csp, response.body ?? ""))
  return problems
}

export function checkCsp(csp) {
  if (!csp) return ["falta Content-Security-Policy-Report-Only"]
  const problems = []
  const directives = new Map(csp.split(";").map((part) => part.trim().split(/\s+/)).filter((parts) => parts[0]).map(([name, ...sources]) => [name, sources]))
  const script = directives.get("script-src") ?? []
  if (!script.some((source) => /^'nonce-[A-Za-z0-9+/]+={0,2}'$/.test(source))) problems.push("script-src sin nonce")
  if (script.includes("'unsafe-inline'")) problems.push("script-src no debe admitir 'unsafe-inline'")
  if (script.includes("'unsafe-eval'")) problems.push("script-src con 'unsafe-eval' fuera de desarrollo")
  for (const [name, value] of [["object-src", "'none'"], ["frame-ancestors", "'none'"], ["base-uri", "'self'"], ["form-action", "'self'"]]) {
    if ((directives.get(name) ?? []).join(" ") !== value) problems.push(`${name} debe ser ${value}`)
  }
  const hosts = [...directives.values()].flat().filter((source) => /^https?:\/\//.test(source))
  for (const host of hosts) {
    if (/google/.test(host)) problems.push(`host de Google sin la vista previa activada: ${host}`)
    if (/bne\.es/.test(host)) problems.push(`host de BNE sin imágenes que lo justifiquen: ${host}`)
  }
  if ([...directives.values()].flat().some((source) => source === "*" || source === "https:" || source === "http:")) problems.push("fuente comodín en la CSP")
  return problems
}

/** Todos los <script> del HTML llevan el nonce de la cabecera de esa misma respuesta. */
export function checkNonce(csp, body) {
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1]
  if (!nonce) return []
  const scripts = body.match(/<script\b[^>]*>/gi) ?? []
  if (!scripts.length) return ["el HTML no contiene scripts que comprobar"]
  const missing = scripts.filter((tag) => !tag.includes(`nonce="${nonce}"`))
  return missing.length ? [`${missing.length} de ${scripts.length} <script> sin el nonce de la respuesta`] : []
}
