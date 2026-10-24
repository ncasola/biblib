import { lookup as dnsLookup } from "node:dns/promises"
import { request as httpsRequest } from "node:https"
import { BlockList, isIP, type LookupFunction } from "node:net"
import { OPEN_LIBRARY_COVERS_HOST } from "../bibliographic-catalog/providers/endpoints"
import { ASSET_LIMITS, AssetRejectedError, type ProviderCoverKey } from "./contracts"

// Política de red de la adquisición de portadas (U-DAT-10). No es un proxy de URL: la única entrada
// es una clave de proveedor validada, que se convierte en un host HTTPS fijo de una lista cerrada. Se
// resuelve el nombre una vez, se exige que todas las direcciones sean públicas y se fija la elegida
// para la conexión (sin segunda resolución: nada de DNS rebinding). No se siguen redirecciones, solo
// se admite el puerto 443, el tamaño se cuenta en streaming y todo tiene plazo. La red real solo se
// usa en modo `live`; las pruebas inyectan el resolutor y el transporte.

/** Hosts fijos por proveedor. BNE no publica imágenes y Google no autoriza copiarlas: no tienen host. */
export const PROVIDER_COVER_HOSTS: Readonly<Partial<Record<ProviderCoverKey["provider"], string>>> = Object.freeze({ "open-library": OPEN_LIBRARY_COVERS_HOST })

export function providerCoverUrl(key: ProviderCoverKey): URL {
  const host = PROVIDER_COVER_HOSTS[key.provider]
  if (!host) throw new AssetRejectedError("HOST_NOT_ALLOWED")
  // `default=false`: Open Library responde 404 en lugar de una imagen genérica cuando no hay portada.
  return new URL(`https://${host}/b/${key.kind}/${encodeURIComponent(key.value)}-L.jpg?default=false`)
}

// Solo IPv4: una BlockList con reglas IPv6 de IPv4 mapeada también casaría con cualquier IPv4.
const blockedIpv4 = new BlockList()
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedIpv4.addSubnet(network, prefix, "ipv4")

/** Los ocho grupos de 16 bits de una IPv6 (admite `::` y una IPv4 final), o null si no es válida. */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase().split("%")[0]
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text)
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number)
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = text.split("::")
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(":") : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail].map((group) => /^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN)
  return groups.some(Number.isNaN) ? null : groups
}

function isBlockedIpv6(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5] = groups
  const zeroUntil = (index: number) => groups.slice(0, index).every((group) => group === 0)
  return zeroUntil(6) // ::, ::1 e IPv4 compatible (::a.b.c.d)
    || (zeroUntil(5) && g5 === 0xffff) // IPv4 mapeada
    || (g0 === 0x64 && g1 === 0xff9b && (g2 === 1 || (g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0))) // NAT64
    || (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) // descarte
    || (g0 === 0x2001 && (g1 < 0x200 || g1 === 0xdb8)) // IANA especiales (Teredo, ORCHID) y documentación
    || g0 === 0x2002 // 6to4
    || (g0 & 0xfe00) === 0xfc00 // ULA, incluido fd00:ec2::254 (metadatos)
    || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0 // link-local y site-local
    || (g0 & 0xff00) === 0xff00 // multicast
}

/**
 * Loopback, redes privadas, link-local (incluido el servicio de metadatos cloud 169.254.169.254 y
 * fd00:ec2::254), CGNAT, documentación, multicast, reservadas, IPv4 mapeada o compatible en IPv6,
 * NAT64 y 6to4 (llevan una IPv4 dentro). Cualquier forma no reconocida también se bloquea.
 */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return blockedIpv4.check(address, "ipv4")
  if (family !== 6) return true
  const groups = ipv6Groups(address)
  return !groups || isBlockedIpv6(groups)
}

export interface ResolvedAddress { address: string; family: 4 | 6 }
export type Resolver = (host: string) => Promise<ResolvedAddress[]>

export interface TransportRequest {
  url: URL
  /** Dirección fijada tras la resolución: el transporte no vuelve a consultar el DNS. */
  address: ResolvedAddress
  headers: Record<string, string>
  signal: AbortSignal
}
export interface TransportResponse {
  status: number
  headers: Record<string, string | undefined>
  body: AsyncIterable<Uint8Array>
  destroy(): void
}
export type Transport = (request: TransportRequest) => Promise<TransportResponse>

export interface FetchLimits { maxBytes: number; timeoutMs: number }

export interface SecureFetchOptions {
  allowedHosts: readonly string[]
  resolve?: Resolver
  transport?: Transport
  limits?: Partial<FetchLimits>
  signal?: AbortSignal
}

/** Fallo de red que admite reintento (caída, plazo, 429/5xx); los rechazos de política son definitivos. */
export class AssetFetchError extends Error {
  constructor(readonly code: "TIMEOUT" | "NETWORK" | "DNS_FAILED" | "HTTP_STATUS" | "NOT_FOUND", readonly retryable: boolean) {
    super(code === "NOT_FOUND" ? "La fuente no tiene esa portada." : "No se pudo descargar la portada. Inténtalo más tarde.")
    this.name = "AssetFetchError"
  }
}

const ACCEPT = "image/jpeg, image/png, image/webp"
const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"])

export const defaultResolver: Resolver = async (host) => {
  const found = await dnsLookup(host, { all: true, verbatim: true })
  return found.map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }))
}

/** Transporte HTTPS con la dirección fijada; el certificado se valida contra el nombre del host (SNI). */
export const defaultTransport: Transport = ({ url, address, headers, signal }) => new Promise((resolve, reject) => {
  const request = httpsRequest({
    protocol: "https:", hostname: url.hostname, port: 443, path: `${url.pathname}${url.search}`, method: "GET", headers, signal, agent: false,
    servername: url.hostname, maxHeaderSize: 16 * 1024,
    lookup: ((_host, options, callback) => options?.all
      ? callback(null, [{ address: address.address, family: address.family }])
      : callback(null, address.address, address.family)) satisfies LookupFunction,
  }, (response) => resolve({
    status: response.statusCode ?? 0,
    headers: Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : value])),
    body: response,
    destroy: () => response.destroy(),
  }))
  request.on("error", reject)
  request.end()
})

function abortReason(signal: AbortSignal, external?: AbortSignal): AssetFetchError {
  return external?.aborted && !signal.reason ? new AssetFetchError("NETWORK", true) : new AssetFetchError("TIMEOUT", true)
}

/**
 * Descarga acotada de una URL derivada de una clave de proveedor. Devuelve los bytes y el tipo
 * declarado (que no se toma como prueba: lo decide la validación de la imagen).
 */
export async function secureFetch(url: URL, options: SecureFetchOptions): Promise<{ bytes: Buffer; contentType: string }> {
  const limits: FetchLimits = { maxBytes: ASSET_LIMITS.maxBytes, timeoutMs: ASSET_LIMITS.downloadTimeoutMs, ...options.limits }
  if (url.protocol !== "https:" || url.username || url.password || !options.allowedHosts.includes(url.hostname)) throw new AssetRejectedError("HOST_NOT_ALLOWED")
  if (url.port !== "" && url.port !== "443") throw new AssetRejectedError("PORT_NOT_ALLOWED")
  // Un literal IP en lugar del nombre fijo nunca está en la lista; se rechaza igualmente por si acaso.
  if (isIP(url.hostname.replace(/^\[|\]$/g, ""))) throw new AssetRejectedError("HOST_NOT_ALLOWED")

  const timeout = AbortSignal.timeout(limits.timeoutMs)
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
  const deadline = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(abortReason(timeout, options.signal))
    signal.addEventListener("abort", () => reject(abortReason(timeout, options.signal)), { once: true })
  })
  deadline.catch(() => undefined)

  let addresses: ResolvedAddress[]
  try {
    addresses = await Promise.race([(options.resolve ?? defaultResolver)(url.hostname), deadline])
  } catch (error) {
    if (error instanceof AssetFetchError) throw error
    throw new AssetFetchError("DNS_FAILED", true)
  }
  if (!addresses.length) throw new AssetFetchError("DNS_FAILED", true)
  // Todas públicas: una respuesta que mezcla una pública y una privada es un intento de rebinding.
  if (addresses.some((entry) => isBlockedAddress(entry.address))) throw new AssetRejectedError("ADDRESS_BLOCKED")
  const pinned = addresses[0]

  let response: TransportResponse
  try {
    response = await Promise.race([(options.transport ?? defaultTransport)({ url, address: pinned, headers: { accept: ACCEPT, "user-agent": "BibLib/1.0 (copia privada de portadas)" }, signal }), deadline])
  } catch (error) {
    if (error instanceof AssetFetchError || error instanceof AssetRejectedError) throw error
    throw signal.aborted ? abortReason(timeout, options.signal) : new AssetFetchError("NETWORK", true)
  }
  try {
    if (response.status >= 300 && response.status < 400) throw new AssetRejectedError("REDIRECT")
    if (response.status === 404 || response.status === 410) throw new AssetFetchError("NOT_FOUND", false)
    if (response.status === 429 || response.status >= 500) throw new AssetFetchError("HTTP_STATUS", true)
    if (response.status !== 200) throw new AssetFetchError("HTTP_STATUS", false)
    const contentType = (response.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase()
    if (!ACCEPTED_TYPES.has(contentType)) throw new AssetRejectedError("CONTENT_TYPE")
    // Un Content-Length declarado demasiado grande corta antes; uno pequeño no se cree: se cuenta.
    const declared = Number(response.headers["content-length"])
    if (Number.isFinite(declared) && declared > limits.maxBytes) throw new AssetRejectedError("TOO_LARGE")

    const chunks: Buffer[] = []
    let total = 0
    const read = (async () => {
      for await (const chunk of response.body) {
        total += chunk.byteLength
        if (total > limits.maxBytes) throw new AssetRejectedError("TOO_LARGE")
        chunks.push(Buffer.from(chunk))
      }
    })()
    try {
      await Promise.race([read, deadline])
    } catch (error) {
      read.catch(() => undefined)
      if (error instanceof AssetFetchError || error instanceof AssetRejectedError) throw error
      throw signal.aborted ? abortReason(timeout, options.signal) : new AssetFetchError("NETWORK", true)
    }
    return { bytes: Buffer.concat(chunks, total), contentType }
  } catch (error) {
    response.destroy()
    throw error
  }
}

/** Descarga la portada de una clave de proveedor con la política anterior. */
export function fetchProviderCover(key: ProviderCoverKey, options: Omit<SecureFetchOptions, "allowedHosts"> = {}) {
  const url = providerCoverUrl(key)
  return secureFetch(url, { ...options, allowedHosts: Object.values(PROVIDER_COVER_HOSTS) })
}
