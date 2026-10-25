import assert from "node:assert/strict"
import { describe, test } from "node:test"
import sharp from "sharp"
import { DomainError } from "../lib/domain-errors"
import {
  buildLocationTree, formatLocationPath, locationPath, locationPhotoUrl, moveTargets, parseLocationKind, parseLocationName, parsePosition, parseShelfLabel,
  subtreeHeight, subtreeIds, type LocationView,
} from "../lib/locations"
import { MEDIA_OUTPUT_MAX_SIDE, normalizeMedia } from "../lib/media/images"
import { isProtectedPath } from "../lib/auth-navigation"
import { LOCATION_LIMITS } from "../lib/product/contracts"

// U-PRO-03 · Ubicación física: validación de entradas, árbol, ruta legible, destinos de un movimiento y fotos sin EXIF ni GPS.

const invalidInput = (error: unknown) => error instanceof DomainError && error.code === "INVALID_INPUT"
const rejected = (error: unknown) => error instanceof DomainError && error.code === "ASSET_REJECTED"

let sequence = 0
function location(name: string, parentId: string | null = null, extra: Partial<LocationView> = {}): LocationView {
  const id = `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`
  return { id, name, kind: "bookcase", parentId, version: "11111111-1111-4111-8111-111111111111", photoAssetId: null, copies: 0, children: 0, ...extra }
}

/** Cadena de `levels` ubicaciones anidadas, de la raíz a la hoja. */
function chain(levels: number, prefix = "Nivel"): LocationView[] {
  const result: LocationView[] = []
  for (let level = 1; level <= levels; level++) result.push(location(`${prefix} ${level}`, result.at(-1)?.id ?? null))
  return result
}

describe("entradas", () => {
  test("nombre: se recorta, 1–120 caracteres (puntos de código), sin caracteres de control", () => {
    assert.equal(parseLocationName("  Estantería del salón  "), "Estantería del salón")
    assert.equal(parseLocationName("📚".repeat(LOCATION_LIMITS.nameMax)), "📚".repeat(LOCATION_LIMITS.nameMax), "120 emojis caben aunque ocupen 240 unidades UTF-16")
    for (const bad of ["", "   ", "x".repeat(121), "Balda\u0007", null, 3]) assert.throws(() => parseLocationName(bad), invalidInput, String(bad))
  })

  test("tipo: solo los de 0014", () => {
    assert.equal(parseLocationKind("shelf"), "shelf")
    for (const bad of ["Balda", "", "estanteria", undefined]) assert.throws(() => parseLocationKind(bad), invalidInput)
  })

  test("balda o hueco: vacío es sin etiqueta; 1–60 caracteres", () => {
    assert.equal(parseShelfLabel("  Fila de atrás "), "Fila de atrás")
    assert.equal(parseShelfLabel("   "), null)
    assert.equal(parseShelfLabel(undefined), null)
    assert.throws(() => parseShelfLabel("x".repeat(61)), invalidInput)
    assert.throws(() => parseShelfLabel(5), invalidInput)
  })

  test("posición manual: entero 1–100000 o ninguna; nunca decimales ni negativos", () => {
    assert.equal(parsePosition(1), 1)
    assert.equal(parsePosition("42"), 42)
    assert.equal(parsePosition(" 100000 "), 100_000)
    assert.equal(parsePosition(""), null)
    assert.equal(parsePosition(null), null)
    for (const bad of [0, -1, 1.5, "1.5", "abc", 100_001, "1e3"]) assert.throws(() => parsePosition(bad), invalidInput, String(bad))
  })
})

describe("árbol y ruta", () => {
  test("orden de lectura: cada ubicación seguida de las que contiene, hermanas por nombre con números naturales", () => {
    const salon = location("Salón")
    const despacho = location("Despacho")
    const balda10 = location("Balda 10", salon.id)
    const balda2 = location("Balda 2", salon.id)
    const caja = location("Caja", balda2.id)
    const tree = buildLocationTree([balda10, caja, salon, balda2, despacho])
    assert.deepEqual(tree.map((entry) => [entry.name, entry.depth]), [["Despacho", 1], ["Salón", 1], ["Balda 2", 2], ["Caja", 3], ["Balda 10", 2]])
    assert.deepEqual(tree.find((entry) => entry.id === caja.id)?.path, ["Salón", "Balda 2", "Caja"])
  })

  test("una ubicación vacía también aparece; una madre ausente deja la hija en la raíz", () => {
    const orphan = location("Huérfana", "00000000-0000-4000-8000-999999999999")
    const empty = location("Caja vacía", null, { copies: 0, children: 0 })
    assert.deepEqual(buildLocationTree([orphan, empty]).map((entry) => [entry.name, entry.depth]), [["Caja vacía", 1], ["Huérfana", 1]])
  })

  test("ruta legible con hueco y posición; un ciclo no cuelga la lectura", () => {
    const [root, middle, leaf] = chain(3)
    const byId = new Map([root, middle, leaf].map((entry) => [entry.id, entry]))
    assert.deepEqual(locationPath(byId, leaf.id), ["Nivel 1", "Nivel 2", "Nivel 3"])
    assert.equal(formatLocationPath(locationPath(byId, leaf.id), { shelfLabel: "Fila de atrás", position: 4 }), "Nivel 1 › Nivel 2 › Nivel 3 · hueco «Fila de atrás» · posición 4")
    assert.equal(formatLocationPath(["Caja"]), "Caja")
    const a = location("A"), b = location("B", a.id)
    const cyclic = new Map([[a.id, { ...a, parentId: b.id }], [b.id, b]])
    assert.deepEqual(locationPath(cyclic, b.id), ["A", "B"], "se detiene al volver a una ubicación ya vista")
  })

  test("subárbol y altura", () => {
    const levels = chain(4)
    const side = location("Lateral", levels[1].id)
    const all = [...levels, side]
    assert.deepEqual([...subtreeIds(all, levels[1].id)].sort(), [levels[1].id, levels[2].id, levels[3].id, side.id].sort())
    assert.equal(subtreeHeight(all, levels[0].id), 3)
    assert.equal(subtreeHeight(all, levels[3].id), 0)
  })

  test("destinos de un movimiento: ni ella ni sus interiores, y sin pasar de 8 niveles con todo lo que contiene", () => {
    const deep = chain(LOCATION_LIMITS.maxDepth, "Hondo")
    const box = location("Caja")
    const lid = location("Tapa", box.id)
    const tree = buildLocationTree([...deep, box, lid])
    const forBox = moveTargets(tree, box.id).map((entry) => entry.name)
    // La caja tiene una hija: cabe bajo una ubicación de nivel ≤ 6 (6 + caja + tapa = 8).
    assert.deepEqual(forBox, ["Hondo 1", "Hondo 2", "Hondo 3", "Hondo 4", "Hondo 5", "Hondo 6"])
    // «Hondo 4» arrastra 5 niveles (4 a 8): cabe bajo una ubicación de nivel ≤ 3, nunca bajo sí misma ni sus interiores.
    const forMiddle = moveTargets(tree, deep[3].id).map((entry) => entry.name)
    assert.deepEqual(forMiddle, ["Caja", "Tapa", "Hondo 1", "Hondo 2", "Hondo 3"])
  })

  test("la foto se lee por la ruta autenticada del propio origen y cambia de URL al sustituirla", () => {
    assert.equal(locationPhotoUrl(location("Sin foto")), null)
    const withPhoto = location("Con foto", null, { photoAssetId: "22222222-2222-4222-8222-222222222222" })
    assert.equal(locationPhotoUrl(withPhoto), `/api/locations/${withPhoto.id}/photo?v=22222222-2222-4222-8222-222222222222`)
  })

  test("/locations es una ruta privada", () => {
    assert.equal(isProtectedPath("/locations"), true)
    assert.equal(isProtectedPath("/locations/otra"), true)
  })
})

describe("foto de ubicación", () => {
  const marker = "BIBLIB-EXIF-MARCA"
  const withExif = (width = 64, height = 48) => sharp({ create: { width, height, channels: 3, background: { r: 120, g: 80, b: 40 } } }).jpeg()
    .withExif({ IFD0: { Artist: "Autora secreta", Copyright: marker }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "40/1 25/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "3/1 42/1 0/1" } }).toBuffer()

  test("se reencodifica a WebP sin EXIF ni GPS: los bytes ya no llevan el marcador ni el bloque Exif", async () => {
    const input = await withExif()
    const before = await sharp(input).metadata()
    assert.ok(before.exif && input.includes(Buffer.from(marker)) && before.exif.includes(Buffer.from([0x25, 0x88])), "el original lleva EXIF con puntero GPS (0x8825)")
    const image = await normalizeMedia("location", input, "image/jpeg")
    const after = await sharp(image.webp).metadata()
    assert.equal(after.format, "webp")
    assert.equal(after.exif, undefined)
    assert.equal(after.xmp, undefined)
    assert.equal(image.webp.includes(Buffer.from(marker)), false)
    assert.equal(image.webp.includes(Buffer.from("Exif")), false)
    assert.equal(image.webp.includes(Buffer.from("GPS")), false)
    assert.match(image.sha256, /^[0-9a-f]{64}$/)
  })

  test("el lado mayor se limita sin ampliar y el tipo declarado debe coincidir con la firma", async () => {
    const large = await sharp({ create: { width: 3000, height: 1000, channels: 3, background: "#336699" } }).png().toBuffer()
    const image = await normalizeMedia("location", large, "image/png")
    assert.equal(image.width, MEDIA_OUTPUT_MAX_SIDE.location)
    assert.ok(image.height < 1000)
    const small = await normalizeMedia("location", await withExif(40, 30))
    assert.deepEqual([small.width, small.height], [40, 30])
    await assert.rejects(() => normalizeMedia("location", large, "image/jpeg"), rejected)
  })

  test("se rechazan SVG, texto, vacíos, archivos políglotas y los de más de 5 MiB", async () => {
    await assert.rejects(() => normalizeMedia("location", Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>")), rejected)
    await assert.rejects(() => normalizeMedia("location", Buffer.from("no soy una imagen")), rejected)
    await assert.rejects(() => normalizeMedia("location", new Uint8Array()), rejected)
    const polyglot = Buffer.concat([await withExif(), Buffer.from("PK\u0003\u0004zip")])
    await assert.rejects(() => normalizeMedia("location", polyglot), rejected)
    await assert.rejects(() => normalizeMedia("location", new Uint8Array(5 * 1024 * 1024 + 1)), (error: unknown) => rejected(error) && (error as Error).message.includes("5 MiB"))
  })
})
