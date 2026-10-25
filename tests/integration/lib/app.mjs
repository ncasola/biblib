import { readFileSync } from "node:fs"
import path from "node:path"
import { BiblibError, EXIT } from "../../../scripts/lib/exit-codes.mjs"
import { distDir } from "../../../scripts/next-target.mjs"

// Invoca las Server Actions reales de la app arrancada (start:local, perfil test) por HTTP, igual
// que el navegador: cabecera Next-Action con el ID del build y argumentos serializados en JSON.
// No se añaden rutas ni bypass al producto; la sesión viaja en las cookies SSR del harness.

const PLACEHOLDER_ID = "00000000-0000-4000-8000-000000000000"

export function loadActions(root) {
  let manifest
  try { manifest = JSON.parse(readFileSync(path.join(root, distDir("local"), "server/server-reference-manifest.json"), "utf8")).node }
  catch { throw new BiblibError(EXIT.MISSING_REQUIREMENT, "app", "Falta el manifiesto de acciones del build local; ejecuta la suite con pnpm test:integration:local.") }
  const actions = new Map()
  for (const [id, entry] of Object.entries(manifest)) {
    // Se prefiere una página fuera de grupos de rutas y de _not-found; un grupo `(…)` no forma parte de la URL.
    const pages = Object.keys(entry.workers).filter((worker) => worker.endsWith("/page"))
    const page = pages.find((worker) => !/\/\(|\/_not-found\//.test(worker)) ?? pages[0]
    if (!entry.exportedName || !page) continue
    // La acción se envía a una página que la incluye; los segmentos dinámicos reciben un UUID inocuo.
    const route = page.replace(/^app/, "").replace(/\/page$/, "").replace(/\/\([^)]+\)/g, "").replace(/\[[^\]]+\]/g, PLACEHOLDER_ID) || "/"
    actions.set(entry.exportedName, { id, route })
  }
  return actions
}

export function cookieHeader(cookies) {
  return cookies.filter((cookie) => cookie.value !== "").map(({ name, value }) => `${name}=${value}`).join("; ")
}

function decodeRows(buffer) {
  const rows = new Map()
  let offset = 0
  while (offset < buffer.length) {
    const colon = buffer.indexOf(0x3a, offset)
    if (colon < 0) break
    const id = buffer.subarray(offset, colon).toString("utf8")
    if (buffer[colon + 1] === 0x54) { // Fila de texto con longitud en bytes: <id>:T<hex>,<texto>
      const comma = buffer.indexOf(0x2c, colon)
      const length = parseInt(buffer.subarray(colon + 2, comma).toString("utf8"), 16)
      rows.set(id, { text: buffer.subarray(comma + 1, comma + 1 + length).toString("utf8") })
      offset = comma + 1 + length
      continue
    }
    const end = buffer.indexOf(0x0a, colon)
    const line = buffer.subarray(colon + 1, end < 0 ? buffer.length : end).toString("utf8")
    if (line.startsWith("E")) rows.set(id, { thrown: true })
    else if (/^[A-Z]/.test(line)) rows.set(id, { unsupported: true })
    else rows.set(id, { json: JSON.parse(line) })
    offset = end < 0 ? buffer.length : end + 1
  }
  return rows
}

class ThrownInAction extends Error {}

function resolveValue(rows, value) {
  if (Array.isArray(value)) return value.map((item) => resolveValue(rows, item))
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValue(rows, item)]))
  if (typeof value !== "string" || !value.startsWith("$")) return value
  if (value.startsWith("$$")) return value.slice(1)
  if (value === "$undefined") return undefined
  if (value.startsWith("$D")) return value.slice(2)
  const node = referencedNode(rows, value)
  return "text" in node ? node.text : resolveValue(rows, node.json)
}

// `$<fila>` o, cuando React deduplica un objeto repetido, `$<fila>:<clave>:<clave>…`: la ruta se recorre
// sobre el JSON sin resolver, porque puede apuntar dentro de la misma fila que se está resolviendo.
function referencedNode(rows, value) {
  const reference = /^\$@?([0-9a-f]+)((?::[^:]+)*)$/.exec(value)
  if (!reference) throw new BiblibError(EXIT.VERIFICATION_FAILED, "app", "Respuesta de la acción con un tipo no admitido por el harness.")
  const row = rows.get(reference[1])
  const incomplete = () => new BiblibError(EXIT.VERIFICATION_FAILED, "app", "Respuesta de la acción incompleta.")
  if (!row || row.unsupported) throw incomplete()
  if (row.thrown) throw new ThrownInAction()
  if ("text" in row) {
    if (reference[2]) throw incomplete()
    return { text: row.text }
  }
  let node = row.json
  for (const key of reference[2].split(":").slice(1)) {
    if (typeof node === "string" && /^\$@?[0-9a-f]/.test(node)) {
      const inner = referencedNode(rows, node)
      if ("text" in inner) throw incomplete()
      node = inner.json
    }
    if (!node || typeof node !== "object" || !Object.hasOwn(node, key)) throw incomplete()
    node = node[key]
  }
  return { json: node }
}

/**
 * Devuelve `{ status, location, value, thrown }`. `thrown` indica que la acción lanzó (Next oculta
 * el detalle en producción); un redirect del proxy llega como `location` sin cuerpo de datos.
 */
export async function callAction(app, name, args = [], { cookies = [], route } = {}) {
  const action = app.actions.get(name)
  if (!action) throw new BiblibError(EXIT.VERIFICATION_FAILED, "app", `La acción ${name} no está en el build.`)
  const response = await fetch(`${app.url}${route ?? action.route}`, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(30000),
    headers: { "Next-Action": action.id, "Content-Type": "text/plain;charset=UTF-8", Accept: "text/x-component", Origin: app.url, Cookie: cookieHeader(cookies) },
    body: JSON.stringify(args),
  })
  const body = Buffer.from(await response.arrayBuffer())
  const result = { status: response.status, location: response.headers.get("location"), setCookies: response.headers.getSetCookie(), value: undefined, thrown: false }
  if (response.status !== 200 || !(response.headers.get("content-type") ?? "").startsWith("text/x-component")) return result
  return { ...result, ...decodeActionResponse(body) }
}

/** Decodifica la respuesta RSC de una Server Action: valor devuelto o `thrown` si la acción lanzó. */
export function decodeActionResponse(body) {
  const rows = decodeRows(body)
  try { return { value: resolveValue(rows, rows.get("0")?.json?.a), thrown: false } } catch (error) {
    if (!(error instanceof ThrownInAction)) throw error
    return { value: undefined, thrown: true }
  }
}

export async function get(app, route, { cookies = [] } = {}) {
  const response = await fetch(`${app.url}${route}`, { redirect: "manual", signal: AbortSignal.timeout(30000), headers: { Cookie: cookieHeader(cookies) } })
  const body = Buffer.from(await response.arrayBuffer())
  return { status: response.status, location: response.headers.get("location"), setCookies: response.headers.getSetCookie(), contentType: response.headers.get("content-type"), body }
}

export async function postJson(app, route, payload, { cookies = [] } = {}) {
  const response = await fetch(`${app.url}${route}`, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(30000),
    headers: { "Content-Type": "application/json", Cookie: cookieHeader(cookies) }, body: JSON.stringify(payload),
  })
  let json = null
  try { json = await response.json() } catch { /* Sin JSON: el estado basta para la aserción. */ }
  return { status: response.status, json }
}

export function createApp(ctx) {
  return { url: ctx.appUrl, actions: loadActions(ctx.root) }
}
