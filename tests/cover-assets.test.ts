import assert from "node:assert/strict"
import { describe, test } from "node:test"
import sharp from "sharp"
import { providerRightsPolicy } from "../lib/bibliographic-catalog/rights"
import { OPEN_LIBRARY_COVERS_HOST } from "../lib/bibliographic-catalog/providers/endpoints"
import {
  ASSET_LIMITS, AssetRejectedError, coverAssetRights, coverAssetUrl, coverStorageKey, licenseExpiry, parseProviderCoverKey, providerCoverKeyFromUrl, readCoverAssetsMode,
} from "../lib/assets/contracts"
import { AssetFetchError, isBlockedAddress, providerCoverUrl, secureFetch, type ResolvedAddress, type Transport, type TransportRequest } from "../lib/assets/fetch-policy"
import { containsMarkup, fixtureCoverBytes, hasTrailingData, sniffImage, validateAndNormalizeImage } from "../lib/assets/image-validation"
import { displayCover } from "../lib/book-covers"
import { httpStatusForDomainError, isRetryable } from "../lib/domain-errors"

const OWNER = "11111111-1111-4111-8111-111111111111"
const ASSET = "22222222-2222-4222-8222-222222222222"

const rejection = (reason: string) => (error: unknown) => error instanceof AssetRejectedError && error.reason === reason && error.code === "ASSET_REJECTED"
const fetchFailure = (code: string, retryable: boolean) => (error: unknown) => error instanceof AssetFetchError && error.code === code && error.retryable === retryable

describe("claves de portada y derechos", () => {
  test("solo claves de proveedor validadas, nunca URL arbitrarias", () => {
    assert.deepEqual(parseProviderCoverKey("open-library:id:12345"), { provider: "open-library", kind: "id", value: "12345", ref: "open-library:id:12345" })
    assert.equal(parseProviderCoverKey("open-library:isbn:0-306-40615-2")?.ref, "open-library:isbn:9780306406157", "los guiones se normalizan")
    assert.equal(parseProviderCoverKey("open-library:isbn:0306406152")?.ref, "open-library:isbn:9780306406157", "el ISBN se normaliza")
    assert.equal(parseProviderCoverKey("open-library:olid:OL7353617M")?.kind, "olid")
    for (const bad of ["https://evil.example/x.jpg", "open-library:id:0", "open-library:id:../../etc", "open-library:path:1", "otro:id:1", "open-library:isbn:123", 42, null, "open-library:id:1".repeat(10)]) {
      assert.equal(parseProviderCoverKey(bad), null, String(bad))
    }
    assert.equal(providerCoverKeyFromUrl(`https://${OPEN_LIBRARY_COVERS_HOST}/b/id/123-L.jpg`, OPEN_LIBRARY_COVERS_HOST)?.ref, "open-library:id:123")
    for (const url of [`http://${OPEN_LIBRARY_COVERS_HOST}/b/id/123-L.jpg`, `https://${OPEN_LIBRARY_COVERS_HOST}:8443/b/id/123-L.jpg`, `https://${OPEN_LIBRARY_COVERS_HOST}/b/id/123-L.jpg?x=1`, "https://books.google.com/books/content?id=abc", "/default-book-cover.webp", "no es una URL"]) {
      assert.equal(providerCoverKeyFromUrl(url, OPEN_LIBRARY_COVERS_HOST), null, url)
    }
  })

  test("la URL de descarga sale de la clave: host fijo y HTTPS; sin host para BNE ni Google", () => {
    const url = providerCoverUrl(parseProviderCoverKey("open-library:id:7")!)
    assert.equal(url.protocol, "https:")
    assert.equal(url.hostname, OPEN_LIBRARY_COVERS_HOST)
    assert.equal(url.pathname, "/b/id/7-L.jpg")
    assert.throws(() => providerCoverUrl(parseProviderCoverKey("google-books:id:abc")!), rejection("HOST_NOT_ALLOWED"))
    assert.throws(() => providerCoverUrl(parseProviderCoverKey("bne:id:123")!), rejection("HOST_NOT_ALLOWED"))
  })

  test("las políticas publicadas no autorizan copiar portadas; una política inyectada conserva backup y offline distintos", () => {
    for (const provider of ["open-library", "bne", "google-books"] as const) assert.equal(coverAssetRights(provider).rehost, false, provider)
    const permissive = (provider: "open-library" | "bne" | "google-books") => ({ ...providerRightsPolicy(provider), rehostCover: true, backupAsset: false, offlineUse: true, coverTtlSeconds: 3600 })
    const rights = coverAssetRights("open-library", permissive)
    assert.deepEqual({ rehost: rights.rehost, backup: rights.backup, offline: rights.offline }, { rehost: true, backup: false, offline: true })
    assert.equal(coverAssetRights("open-library", (provider) => ({ ...permissive(provider), version: "" })).rehost, false, "sin versión no hay derecho")
    assert.equal(licenseExpiry(rights.policy, new Date("2026-10-24T00:00:00Z"))?.toISOString(), "2026-10-24T01:00:00.000Z")
    assert.equal(licenseExpiry(providerRightsPolicy("open-library"), new Date()), null)
  })

  test("ruta de objeto derivada por el servidor, lectura del propio origen y error 422 no reintentable", () => {
    assert.equal(coverStorageKey(OWNER, ASSET, "17"), `${OWNER}/${ASSET}/17.webp`)
    for (const attempt of ["../x", "a/b", "", "x".repeat(65)]) assert.throws(() => coverStorageKey(OWNER, ASSET, attempt))
    assert.throws(() => coverStorageKey("../otro", ASSET, "1"))
    assert.equal(coverAssetUrl(ASSET), `/api/covers/${ASSET}`)
    assert.deepEqual(displayCover({ cover: { small: "s", medium: "m", large: "l" }, coverAssetId: ASSET }), { small: `/api/covers/${ASSET}`, medium: `/api/covers/${ASSET}`, large: `/api/covers/${ASSET}` })
    assert.deepEqual(displayCover({ cover: { small: "s", medium: "m", large: "l" } }), { small: "s", medium: "m", large: "l" })
    assert.equal(httpStatusForDomainError("ASSET_REJECTED"), 422)
    assert.equal(isRetryable("ASSET_REJECTED"), false)
    assert.equal(readCoverAssetsMode({}), "full")
    assert.equal(readCoverAssetsMode({ BIBLIB_COVER_ASSETS: "off" }), "off")
    assert.throws(() => readCoverAssetsMode({ BIBLIB_COVER_ASSETS: "todo" }))
  })
})

describe("política de red", () => {
  test("bloquea loopback, privadas, link-local, metadata cloud, IPv4 en IPv6, NAT64 y 6to4", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
      "::1", "::", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "::127.0.0.1", "fe80::1", "fd00:ec2::254", "fc00::1", "64:ff9b::7f00:1", "2002:7f00:1::1", "ff02::1", "2001:db8::1", "no-es-ip"]) {
      assert.equal(isBlockedAddress(address), true, address)
    }
    for (const address of ["8.8.8.8", "151.101.1.1", "2606:4700::1111", "2a00:1450:4003::200e"]) assert.equal(isBlockedAddress(address), false, address)
  })

  const url = new URL(`https://${OPEN_LIBRARY_COVERS_HOST}/b/id/7-L.jpg?default=false`)
  const allowedHosts = [OPEN_LIBRARY_COVERS_HOST]
  const publicAddress: ResolvedAddress = { address: "151.101.1.1", family: 4 }
  async function* chunks(...parts: Uint8Array[]) { for (const part of parts) yield part }
  const reply = (status: number, headers: Record<string, string>, body: AsyncIterable<Uint8Array> = chunks(), onDestroy = () => {}) => ({ status, headers, body, destroy: onDestroy })

  test("una redirección a localhost se rechaza sin seguirla ni conectar con el destino", async () => {
    const requests: TransportRequest[] = []
    const transport: Transport = async (request) => { requests.push(request); return reply(302, { location: "http://127.0.0.1/admin" }) }
    await assert.rejects(secureFetch(url, { allowedHosts, resolve: async () => [publicAddress], transport }), rejection("REDIRECT"))
    assert.equal(requests.length, 1)
    assert.equal(requests[0].address.address, publicAddress.address)
    assert.equal(requests[0].url.hostname, OPEN_LIBRARY_COVERS_HOST)
  })

  test("DNS hacia una red privada o con respuestas mezcladas se rechaza antes de conectar", async () => {
    let connected = 0
    const transport: Transport = async () => { connected++; return reply(200, { "content-type": "image/jpeg" }) }
    await assert.rejects(secureFetch(url, { allowedHosts, resolve: async () => [{ address: "169.254.169.254", family: 4 }], transport }), rejection("ADDRESS_BLOCKED"))
    await assert.rejects(secureFetch(url, { allowedHosts, resolve: async () => [publicAddress, { address: "10.0.0.5", family: 4 }], transport }), rejection("ADDRESS_BLOCKED"))
    await assert.rejects(secureFetch(url, { allowedHosts, resolve: async () => [{ address: "::ffff:127.0.0.1", family: 6 }], transport }), rejection("ADDRESS_BLOCKED"))
    await assert.rejects(secureFetch(url, { allowedHosts, resolve: async () => [], transport }), fetchFailure("DNS_FAILED", true))
    assert.equal(connected, 0)
  })

  test("DNS cambiante: se resuelve una sola vez y la conexión usa la dirección fijada", async () => {
    let lookups = 0
    const resolve = async () => (lookups++ === 0 ? [publicAddress] : [{ address: "127.0.0.1", family: 4 as const }])
    const used: string[] = []
    const transport: Transport = async (request) => { used.push(request.address.address); return reply(200, { "content-type": "image/jpeg" }, chunks(new Uint8Array([1, 2, 3]))) }
    const result = await secureFetch(url, { allowedHosts, resolve, transport })
    assert.equal(lookups, 1)
    assert.deepEqual(used, [publicAddress.address])
    assert.equal(result.bytes.length, 3)
  })

  test("respuesta lenta: plazo total, también si la cabecera llega y el cuerpo no", async () => {
    const never = new Promise<never>(() => undefined)
    await assert.rejects(secureFetch(url, { allowedHosts, resolve: async () => [publicAddress], transport: () => never, limits: { timeoutMs: 50 } }), fetchFailure("TIMEOUT", true))
    let destroyed = false
    async function* stalled() { yield new Uint8Array([1]); await never }
    await assert.rejects(secureFetch(url, { allowedHosts, resolve: async () => [publicAddress], transport: async () => reply(200, { "content-type": "image/png" }, stalled(), () => { destroyed = true }), limits: { timeoutMs: 50 } }), fetchFailure("TIMEOUT", true))
    assert.ok(destroyed, "la conexión se cierra")
    await assert.rejects(secureFetch(url, { allowedHosts, resolve: () => never, transport: async () => reply(200, {}), limits: { timeoutMs: 50 } }), fetchFailure("TIMEOUT", true))
  })

  test("tamaño mentido: se cuenta en streaming y se corta al pasar el límite", async () => {
    let produced = 0
    let destroyed = false
    async function* endless() { for (;;) { produced += 64 * 1024; yield new Uint8Array(64 * 1024) } }
    await assert.rejects(secureFetch(url, { allowedHosts, resolve: async () => [publicAddress], transport: async () => reply(200, { "content-type": "image/jpeg", "content-length": "1000" }, endless(), () => { destroyed = true }) }), rejection("TOO_LARGE"))
    assert.ok(produced <= ASSET_LIMITS.maxBytes + 64 * 1024, "no se lee más allá del límite")
    assert.ok(destroyed)
    await assert.rejects(secureFetch(url, { allowedHosts, resolve: async () => [publicAddress], transport: async () => reply(200, { "content-type": "image/jpeg", "content-length": String(ASSET_LIMITS.maxBytes + 1) }) }), rejection("TOO_LARGE"))
  })

  test("host, puerto y esquema fuera de la lista; tipos y estados HTTP", async () => {
    const transport: Transport = async () => { throw new Error("no debería conectar") }
    const resolve = async () => [publicAddress]
    await assert.rejects(secureFetch(new URL("https://evil.example/x.jpg"), { allowedHosts, resolve, transport }), rejection("HOST_NOT_ALLOWED"))
    await assert.rejects(secureFetch(new URL(`http://${OPEN_LIBRARY_COVERS_HOST}/b/id/1-L.jpg`), { allowedHosts, resolve, transport }), rejection("HOST_NOT_ALLOWED"))
    await assert.rejects(secureFetch(new URL(`https://${OPEN_LIBRARY_COVERS_HOST}:8443/b/id/1-L.jpg`), { allowedHosts, resolve, transport }), rejection("PORT_NOT_ALLOWED"))
    await assert.rejects(secureFetch(new URL("https://127.0.0.1/x.jpg"), { allowedHosts: ["127.0.0.1"], resolve, transport }), rejection("HOST_NOT_ALLOWED"))
    const status = (code: number, headers: Record<string, string> = { "content-type": "image/jpeg" }) => secureFetch(url, { allowedHosts, resolve, transport: async () => reply(code, headers) })
    await assert.rejects(status(200, { "content-type": "text/html" }), rejection("CONTENT_TYPE"))
    await assert.rejects(status(200, { "content-type": "image/svg+xml" }), rejection("CONTENT_TYPE"))
    await assert.rejects(status(404), fetchFailure("NOT_FOUND", false))
    await assert.rejects(status(429), fetchFailure("HTTP_STATUS", true))
    await assert.rejects(status(503), fetchFailure("HTTP_STATUS", true))
    await assert.rejects(status(403), fetchFailure("HTTP_STATUS", false))
  })
})

describe("validación de imágenes", () => {
  const image = (format: "jpeg" | "png" | "webp", width = 300, height = 450) => sharp({ create: { width, height, channels: 3, background: { r: 120, g: 30, b: 60 } } })[format]().toBuffer()

  test("JPEG, PNG y WebP reales se reencodifican a WebP sin metadatos", async () => {
    for (const format of ["jpeg", "png", "webp"] as const) {
      const normalized = await validateAndNormalizeImage(await image(format), { declaredType: `image/${format}` })
      assert.equal(sniffImage(normalized.webp), "webp", format)
      assert.equal(normalized.inputFormat, format)
      assert.equal(normalized.width, 300)
      assert.match(normalized.sha256, /^[0-9a-f]{64}$/)
    }
    const withExif = await sharp({ create: { width: 400, height: 200, channels: 3, background: "#336699" } }).jpeg().withMetadata({ orientation: 6, exif: { IFD0: { Copyright: "privado" } } }).toBuffer()
    const normalized = await validateAndNormalizeImage(withExif)
    const metadata = await sharp(normalized.webp).metadata()
    assert.equal(metadata.exif, undefined, "sin EXIF")
    assert.equal(metadata.xmp, undefined, "sin XMP")
    assert.deepEqual([normalized.width, normalized.height], [200, 400], "la orientación se aplica antes de retirar los metadatos")
    const large = await validateAndNormalizeImage(await image("png", 2400, 3600))
    assert.ok(large.width <= ASSET_LIMITS.outputMaxWidth && large.height <= ASSET_LIMITS.outputMaxHeight)
  })

  test("SVG, HTML, XML y tipos no admitidos se rechazan sin decodificar", async () => {
    const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')
    await assert.rejects(validateAndNormalizeImage(svg), rejection("MARKUP"))
    await assert.rejects(validateAndNormalizeImage(Buffer.from("  <svg><script>x</script></svg>"), { declaredType: "image/png" }), rejection("MARKUP"))
    await assert.rejects(validateAndNormalizeImage(Buffer.from("<!DOCTYPE html><html><body>hola</body></html>"), { declaredType: "image/jpeg" }), rejection("MARKUP"))
    await assert.rejects(validateAndNormalizeImage(Buffer.from("GIF89a\x01\x00\x01\x00")), rejection("UNSUPPORTED_TYPE"))
    await assert.rejects(validateAndNormalizeImage(Buffer.alloc(0)), rejection("EMPTY"))
    assert.equal(containsMarkup(await image("jpeg")), false)
  })

  test("MIME falso: el tipo declarado debe coincidir con la firma", async () => {
    await assert.rejects(validateAndNormalizeImage(await image("png"), { declaredType: "image/jpeg" }), rejection("MIME_MISMATCH"))
    await assert.rejects(validateAndNormalizeImage(await image("jpeg"), { declaredType: "image/svg+xml" }), rejection("MIME_MISMATCH"))
  })

  test("políglotas: datos tras el final de la imagen o marcado incrustado", async () => {
    const jpeg = await image("jpeg")
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00])
    await assert.rejects(validateAndNormalizeImage(Buffer.concat([jpeg, zip])), rejection("POLYGLOT"))
    await assert.rejects(validateAndNormalizeImage(Buffer.concat([jpeg, Buffer.from("<html><script>alert(1)</script></html>")])), rejection("MARKUP"))
    const png = await image("png")
    await assert.rejects(validateAndNormalizeImage(Buffer.concat([png, Buffer.from("trailer")])), rejection("POLYGLOT"))
    const webp = await image("webp")
    await assert.rejects(validateAndNormalizeImage(Buffer.concat([webp, Buffer.from("extra!")])), rejection("POLYGLOT"))
    assert.equal(hasTrailingData(Buffer.concat([jpeg, Buffer.alloc(4)]), "jpeg"), false, "el relleno de ceros tras EOI se admite")
  })

  test("bombas de descompresión y dimensiones excesivas se rechazan por cabecera", async () => {
    const bomb = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png({ compressionLevel: 9 }).toBuffer()
    assert.ok(bomb.length < 200 * 1024, "pocos bytes, 12 megapíxeles")
    await assert.rejects(validateAndNormalizeImage(bomb), rejection("TOO_MANY_PIXELS"))
    const tall = await sharp({ create: { width: 10, height: 10_001, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer()
    await assert.rejects(validateAndNormalizeImage(tall), rejection("TOO_MANY_PIXELS"))
    await assert.rejects(validateAndNormalizeImage(await image("jpeg"), { limits: { maxBytes: 10 } }), rejection("TOO_LARGE"))
  })

  test("un archivo dañado no se acepta aunque tenga firma válida", async () => {
    const jpeg = await image("jpeg")
    await assert.rejects(validateAndNormalizeImage(Buffer.concat([jpeg.subarray(0, 200), Buffer.from([0xff, 0xd9])])), (error: unknown) => error instanceof AssetRejectedError && ["DECODE_FAILED", "POLYGLOT"].includes(error.reason))
  })

  test("la imagen fixture es determinista por clave y válida", async () => {
    const [a, b, c] = await Promise.all([fixtureCoverBytes("open-library:id:1"), fixtureCoverBytes("open-library:id:1"), fixtureCoverBytes("open-library:id:2")])
    assert.equal(a.equals(b), true)
    assert.equal(a.equals(c), false)
    assert.equal((await validateAndNormalizeImage(a)).inputFormat, "jpeg")
  })
})
