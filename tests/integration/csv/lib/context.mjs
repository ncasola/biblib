import { createHash } from "node:crypto"
import { productContext, value } from "../../product/lib/context.mjs"
import { cookieHeader, decodeActionResponse } from "../../lib/app.mjs"

export const PROFILES = ["scratch", "test"]
export { value }
export const sha256 = (input) => createHash("sha256").update(input).digest("hex")
export const failed = (result, code) => result.status === 200 && result.value?.ok === false && result.value.error.code === code
export const mapping = (targets, delimiter = ",") => ({
  delimiter, header: true, columns: targets.map((target, index) => ({ sourceColumn: `#${index + 1}`, target })),
  defaultStatus: "unread", defaultShelf: "Predeterminada", statusMap: { "Leído": "read", "Leyendo": "reading", "Sin leer": "unread", "Por leer": "to-read" },
})

/** Cuentas desechables, GoTrue real, HTTP/RSC y limpieza de todos los datos por cascada. */
export async function csvContext() {
  const ctx = await productContext()
  ctx.uploadCsvChunk = async (session, sessionId, chunk, bytes) => {
    const action = ctx.app.actions.get("inspectCsvAction")
    if (!action) throw new Error("Falta inspectCsvAction en el build.")
    const form = new FormData()
    form.append("1", new Blob([bytes]))
    form.append("0", JSON.stringify([{ sessionId, chunk: { ...chunk, bytes: "$B1" } }]))
    const response = await fetch(`${ctx.app.url}${action.route}`, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(30000),
      headers: { "Next-Action": action.id, Accept: "text/x-component", Origin: ctx.app.url, Cookie: cookieHeader(session.cookies()) }, body: form })
    const result = { status: response.status, value: undefined, thrown: false }
    if (response.status !== 200 || !(response.headers.get("content-type") ?? "").startsWith("text/x-component")) return result
    return { ...result, ...decodeActionResponse(Buffer.from(await response.arrayBuffer())) }
  }
  ctx.csv = async (session, text, delimiter = ",") => {
    const bytes = Buffer.from(text, "utf8")
    let inspected = value(await ctx.call("beginCsvImportAction", [{ byteLength: bytes.length, sha256: sha256(bytes), delimiter }], session))
    const total = Math.ceil(bytes.length / 262144)
    for (let ordinal = 0; ordinal < total; ordinal++) {
      const chunk = bytes.subarray(ordinal * 262144, (ordinal + 1) * 262144)
      inspected = value(await ctx.uploadCsvChunk(session, inspected.sessionId, { ordinal, total, sha256: sha256(chunk) }, chunk))
    }
    return inspected
  }
  ctx.mapCsv = async (session, inspected, rules) => value(await ctx.call("setCsvMappingAction", [{ sessionId: inspected.sessionId, expectedVersion: inspected.version, mappingVersion: (inspected.mappingVersion ?? 0) + 1, mapping: rules }], session))
  ctx.prepareCsv = async (session, sessionId, overrides = {}) => value(await ctx.call("prepareCsvImportAction", [{ sessionId, mode: "merge", duplicatePolicy: "skip-existing", ...overrides }], session))
  ctx.confirmCsv = async (session, preview, idempotencyKey = ctx.key("csv")) => value(await ctx.call("confirmImportAction", [{ previewId: preview.previewId, expectedRevision: preview.revision, idempotencyKey }], session))
  return ctx
}
