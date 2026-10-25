import assert from "node:assert/strict"
import { test } from "node:test"
import { createBackupV2, libraryRequiresV2, readBackupV2, type PortableBackupV2 } from "../lib/backup-v2"
import { buildImportPlan, type IdAllocator } from "../lib/import-plan"
import { fragmentBackupV2 } from "../lib/library-export"
import { createLibraryExport, parseLibraryImport } from "../lib/library-import"
import { canonicalSeriesPosition, compareSeriesPositions, isValidTagName, mediaStorageKey, normalizeTagName } from "../lib/product/contracts"
import { planProductRows, type ProductTargets } from "../lib/product/portable"
import { csvSourceRowKey } from "../lib/csv-import/contracts"
import type { Book, LibraryData } from "../lib/types"

// O13 · 0014. Contratos puros del lote de producto: normalización de etiquetas idéntica a la de Postgres, posiciones
// exactas de serie, formato v2 con las secciones nuevas (ida y vuelta, archivos anteriores, rechazos con explicación)
// y el planificador que la publicación usa para escribir los datos de producto.

const exportedAt = new Date("2026-10-25T10:00:00.000Z")
const SHELF = "00000000-0000-4000-8001-000000000001"
const TAG = "00000000-0000-4000-8005-000000000001"
const ROOM = "00000000-0000-4000-8006-000000000001"
const SHELF_PLACE = "00000000-0000-4000-8006-000000000002"
const SAGA = "00000000-0000-4000-8007-000000000001"
const PHOTO = "00000000-0000-4000-8008-000000000001"
const SHA = "a".repeat(64)

function book(overrides: Partial<Book> = {}): Book {
  return {
    id: "00000000-0000-4000-8002-000000000001", isbn: "9788401337208", title: "El nombre del viento",
    authors: [{ name: "Patrick Rothfuss" }], number_of_pages: 872, publish_date: "2009",
    cover: { small: "/default-book-cover.webp", medium: "/default-book-cover.webp", large: "/default-book-cover.webp" },
    status: "unread", shelf_id: SHELF, shelf_name: "Balda", catalogue: { source: "manual", isbnVerified: false },
    ...overrides,
  }
}

function productLibrary(): LibraryData {
  return {
    shelves: [{ id: SHELF, title: "Balda", book_count: 2, isDefault: true }],
    tags: [{ id: TAG, name: "Fantasía" }, { id: "00000000-0000-4000-8005-000000000002", name: "Sin usar" }],
    locations: [
      { id: ROOM, name: "Salón", kind: "room", parentId: null, photo: { assetId: PHOTO, sha256: SHA } },
      { id: SHELF_PLACE, name: "Balda 3", kind: "shelf", parentId: ROOM },
      { id: "00000000-0000-4000-8006-000000000003", name: "Caja vacía", kind: "box", parentId: null },
    ],
    series: [{ id: SAGA, title: "Crónica del asesino de reyes", description: "Trilogía" }],
    books: [
      book({
        personal: { notes: "Regalo de 2015 ✨", rating: 5, tagIds: [TAG] },
        location: { locationId: SHELF_PLACE, shelfLabel: "Fila de atrás", position: 3 },
        edition: { id: "00000000-0000-4000-8003-000000000001", series: { seriesId: SAGA, position: "1", volumeLabel: "I" },
          evidence: [{ id: "00000000-0000-4000-8009-000000000001", sourceKind: "provider", sourceRef: "open-library", sourceUrl: "https://openlibrary.org/books/OL1M",
            fieldClaims: { fields: { title: { provider: "open-library", selection: "user-selected" } } }, confidence: "bibliographic_match", origin: "backfill" }] },
        evidence: [{ id: "00000000-0000-4000-8009-000000000002", sourceKind: "manual", observedAt: "2026-10-01T10:00:00.000Z", fieldClaims: { isbnVerified: true },
          confidence: "physically_checked", origin: "backfill" }],
        catalogue: { source: "manual", isbnVerified: true },
      }),
      book({ id: "00000000-0000-4000-8002-000000000002", isbn: "9788401337215", title: "El temor de un hombre sabio",
        edition: { id: "00000000-0000-4000-8003-000000000002", series: { seriesId: SAGA, position: "1.5" } } }),
    ],
  }
}

const v2 = (data: LibraryData) => JSON.parse(JSON.stringify(createBackupV2(data, exportedAt))) as PortableBackupV2

test("normalización de etiquetas idéntica a biblib.tag_normalize (tests/db/product.sql)", () => {
  assert.equal(normalizeTagName("  Novela   Histórica "), "novela historica")
  assert.equal(normalizeTagName("AÑO"), "año")
  assert.notEqual(normalizeTagName("año"), normalizeTagName("ano"))
  assert.equal(normalizeTagName("Pingüino Éxito"), "pinguino exito")
  assert.equal(normalizeTagName("NÓVELA"), normalizeTagName("Novela"))
  assert.ok(isValidTagName("ñ".repeat(40)) && !isValidTagName("x".repeat(41)) && !isValidTagName(" Espacios ") && !isValidTagName("a\u0007b") && !isValidTagName(""))
})

test("posiciones de serie exactas: 1, 1.5 y 2 sin flotantes; desconocida al final", () => {
  assert.deepEqual(["2", null, "1.5", "1", "10", "1.25"].sort(compareSeriesPositions), ["1", "1.25", "1.5", "2", "10", null])
  assert.equal(compareSeriesPositions("1.50", "1.5"), 0)
  assert.equal(canonicalSeriesPosition("1.50"), "1.5", "forma canónica sin ceros finales (como trim_scale)")
  assert.equal(canonicalSeriesPosition("1.5"), "1.5")
  for (const invalid of ["-1", "01", "1.00001", "1000000", "1e3", ""]) assert.equal(canonicalSeriesPosition(invalid), null, invalid)
})

test("rutas privadas de imagen y claves CSV durables", () => {
  assert.equal(mediaStorageKey("u", "avatar", "a"), "u/avatar/a")
  assert.equal(csvSourceRowKey(1), "csv:1")
  assert.throws(() => csvSourceRowKey(0))
})

test("ida y vuelta v2 con etiquetas, notas, ubicaciones, series y evidencias", () => {
  const data = productLibrary()
  const payload = v2(data)
  assert.deepEqual(payload.requiredCapabilities, ["copies.personal", "copies.locations", "editions.series", "bibliographic.evidence"], "declara las capacidades que usa")
  assert.equal(payload.tags?.length, 2, "también la etiqueta que nadie usa")
  assert.equal(payload.locations?.length, 3, "también la ubicación vacía")
  assert.deepEqual(payload.copies[0].personal, { notes: "Regalo de 2015 ✨", rating: 5, tagIds: [TAG] })
  assert.equal(payload.editions[1].series?.position, "1.5")
  const parsed = parseLibraryImport(payload)
  assert.deepEqual(parsed.tags, data.tags)
  assert.deepEqual(parsed.locations, data.locations)
  assert.deepEqual(parsed.series, data.series)
  const first = parsed.books.find((entry) => entry.id === data.books[0].id)!
  assert.deepEqual(first.personal, data.books[0].personal)
  assert.deepEqual(first.location, data.books[0].location)
  assert.deepEqual(first.evidence, data.books[0].evidence)
  assert.deepEqual(first.edition?.series, data.books[0].edition?.series)
  assert.deepEqual(first.edition?.evidence, data.books[0].edition?.evidence)
  // Segunda ida y vuelta idéntica: nada se pierde ni se inventa.
  assert.deepEqual(v2(parsed), payload)
  assert.ok(libraryRequiresV2(data))
  assert.throws(() => createLibraryExport(data), /formato 2/)
})

test("un JSON v1 o un v2 anterior se importa con los datos de producto vacíos", () => {
  const plain: LibraryData = { shelves: [{ id: SHELF, title: "Balda", book_count: 1, isDefault: true }], books: [book()] }
  for (const input of [createLibraryExport(plain, exportedAt), v2(plain)]) {
    const parsed = parseLibraryImport(JSON.parse(JSON.stringify(input)))
    assert.equal(parsed.tags, undefined)
    assert.equal(parsed.locations, undefined)
    assert.equal(parsed.series, undefined)
    assert.ok(parsed.books.every((entry) => !entry.personal && !entry.location && !entry.evidence && !entry.edition?.series))
  }
  assert.ok(!libraryRequiresV2(plain), "sin datos nuevos v1 sigue siendo posible")
})

test("el lector v2 rechaza con explicación referencias y valores que la base no admitiría", () => {
  const base = v2(productLibrary())
  const copy = base.copies[0]
  const edition = base.editions[0]
  const cases: [unknown, RegExp][] = [
    [{ ...base, requiredCapabilities: base.requiredCapabilities.filter((capability) => capability !== "copies.locations") }, /ubicaciones físicas sin declarar/],
    [{ ...base, copies: [{ ...copy, personal: { tagIds: ["00000000-0000-4000-8005-00000000dead"] } }, base.copies[1]] }, /etiqueta que no está/],
    [{ ...base, copies: [{ ...copy, location: { locationId: "otra" } }, base.copies[1]] }, /ubicación que no está/],
    [{ ...base, editions: [{ ...edition, series: { seriesId: "otra" } }, base.editions[1]] }, /serie que no está/],
    [{ ...base, locations: [{ ...base.locations![0], parentId: SHELF_PLACE }, ...base.locations!.slice(1)] }, /dentro de sí misma|niveles o un ciclo/],
    [{ ...base, tags: [...base.tags!, { id: "00000000-0000-4000-8005-000000000003", name: "FANTASIA" }] }, /etiquetas equivalentes/],
    [{ ...base, copies: [{ ...copy, personal: { notes: "n".repeat(4001) } }, base.copies[1]] }, /copia 1 no tiene un formato válido/],
    [{ ...base, copies: [{ ...copy, personal: { rating: 6 } }, base.copies[1]] }, /copia 1 no tiene un formato válido/],
    [{ ...base, editions: [{ ...edition, series: { seriesId: SAGA, position: "1.00001" } }, base.editions[1]] }, /edición 1 no tiene un formato válido/],
    [{ ...base, editions: [{ ...edition, evidence: [{ ...edition.evidence![0], confidence: "physically_checked" }] }, base.editions[1]] }, /solo un ejemplar concreto/],
    [{ ...base, editions: [{ ...edition, evidence: [{ ...edition.evidence![0], confidence: 0.9 }] }, base.editions[1]] }, /edición 1 no tiene un formato válido/],
    [{ ...base, copies: [{ ...copy, notas: "x" }, base.copies[1]] }, /campos que esta versión no puede conservar/],
    [{ ...base, loans: [] }, /secciones.*loans/],
  ]
  for (const [input, expected] of cases) assert.throws(() => readBackupV2(input), expected)
  // Una nota de 4000 caracteres con emojis (puntos de código, como char_length) sí se admite.
  assert.doesNotThrow(() => readBackupV2({ ...base, copies: [{ ...copy, personal: { notes: "✨".repeat(4000) } }, base.copies[1]] }))
})

test("las partes v2 llevan completas las etiquetas, ubicaciones y series y cada una se valida sola", () => {
  const data = productLibrary()
  const many = { ...data, books: Array.from({ length: 2100 }, (_, index) => book({
    id: `00000000-0000-4000-8002-${String(index + 10).padStart(12, "0")}`, isbn: null, legacyIdentifier: `manual-${index}`, title: `Libro ${index}`,
    personal: { tagIds: [TAG] }, location: { locationId: SHELF_PLACE } })) }
  const parts = fragmentBackupV2(many, exportedAt)
  assert.ok(parts.length >= 2)
  for (const part of parts) {
    assert.equal(part.tags?.length, 2)
    assert.equal(part.locations?.length, 3)
    assert.equal(part.series?.length, 1)
    assert.doesNotThrow(() => parseLibraryImport(JSON.parse(JSON.stringify(part))))
  }
})

const allocator: IdAllocator = (kind, sourceId) => `nuevo-${kind}-${sourceId}`
const noMedia = new Map<string, { kind: "avatar" | "location" | "evidence"; sha256: string }>()

function targets(overrides: Partial<ProductTargets> = {}): ProductTargets {
  return { tagsByName: new Map(), ownLocations: new Set(), ownSeries: new Set(), keep: () => false, media: noMedia, ...overrides }
}

test("planificador: fusión reutiliza etiquetas por nombre y ubicaciones/series propias; solo los ejemplares nuevos reciben datos", () => {
  const data = productLibrary()
  const plan = buildImportPlan({ imported: data, current: { shelves: [{ id: SHELF, title: "Balda", isDefault: true }], books: [{ id: "otro", isbn: "9788401337215" }] }, mode: "merge", allocateId: allocator })
  assert.equal(plan.books.insert.length, 1, "la segunda copia ya existe y se omite")
  const rows = planProductRows(data, plan, "merge", targets({ tagsByName: new Map([["fantasia", "mia"]]), ownLocations: new Set([ROOM]) }), allocator)
  assert.deepEqual(rows.tags.map((tag) => tag.name), ["Sin usar"], "Fantasía ya existe por nombre normalizado")
  assert.deepEqual(rows.copyTags, [{ copyId: plan.books.insert[0].id, tagId: "mia" }])
  assert.deepEqual(rows.locations.map((location) => [location.id, location.parentId]), [[`nuevo-location-${SHELF_PLACE}`, ROOM], ["nuevo-location-00000000-0000-4000-8006-000000000003", null]])
  assert.equal(rows.annotations.length, 1)
  assert.equal(rows.seriesEditions.length, 1, "solo la edición nueva")
  assert.equal(rows.evidence.length, 2)
  assert.ok(rows.evidence.every((row) => row.id.startsWith("nuevo-evidence-")), "al fusionar, evidencias con IDs nuevos")
})

test("planificador: reemplazo conserva IDs propios; versión anterior conserva los no ajenos; fotos ajenas se descartan", () => {
  const data = productLibrary()
  const plan = buildImportPlan({ imported: data, current: { shelves: [{ id: SHELF, title: "Balda", isDefault: true }], books: [] }, mode: "replace", allocateId: allocator })
  const own = new Set([TAG, ROOM])
  const replaced = planProductRows(data, plan, "replace", targets({ keep: (id) => own.has(id) }), allocator)
  assert.equal(replaced.tags[0].id, TAG)
  assert.equal(replaced.tags[1].id, "nuevo-tag-00000000-0000-4000-8005-000000000002")
  assert.equal(replaced.locations[0].id, ROOM)
  assert.equal(replaced.locations[0].photoAssetId, null, "la foto no es un asset propio: se importa sin foto")
  assert.equal(replaced.droppedPhotos, 1)
  assert.deepEqual(replaced.seriesEditions.map((row) => row.position), ["1", "1.5"])
  const restored = planProductRows(data, plan, "snapshot", targets({ keep: (id) => id !== SAGA, media: new Map([[PHOTO, { kind: "location", sha256: SHA }]]) }), allocator)
  assert.equal(restored.series[0].id, `nuevo-series-${SAGA}`, "un ID que hoy usa otra cuenta se reasigna")
  assert.equal(restored.locations[0].photoAssetId, PHOTO, "la foto propia vuelve")
  assert.ok(restored.seriesEditions.every((row) => row.seriesId === `nuevo-series-${SAGA}`))
  const otherBytes = planProductRows(data, plan, "snapshot", targets({ keep: () => true, media: new Map([[PHOTO, { kind: "location", sha256: "b".repeat(64) }]]) }), allocator)
  assert.equal(otherBytes.locations[0].photoAssetId, null, "otros bytes: no es la misma foto")
  const wrongKind = planProductRows(data, plan, "snapshot", targets({ keep: () => true, media: new Map([[PHOTO, { kind: "avatar", sha256: SHA }]]) }), allocator)
  assert.equal(wrongKind.locations[0].photoAssetId, null, "un avatar no es una foto de ubicación")
})
