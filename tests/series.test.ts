import assert from "node:assert/strict"
import { test } from "node:test"
import { defaultBookSearchFilters, parseBookSearchFilters, serializeBookSearchFilters } from "../lib/book-search"
import { canonicalSeriesPosition, compareSeriesPositions, SERIES_LIMITS, SERIES_POSITION_PATTERN } from "../lib/product/contracts"
import {
  createSeriesSchema, describePosition, linkEditionSchema, moveVolumeSchema, parseSeriesPositionInput, unlinkEditionSchema, updateSeriesSchema,
} from "../lib/series"

// U-PRO-05 · Series y orden de volúmenes. Posiciones exactas en texto decimal (sin flotantes), validación de las
// entradas de las acciones y filtro por serie del catálogo. La parte con Postgres está en tests/integration/series.

const EDITION = "00000000-0000-4000-8003-000000000001"
const SERIES = "00000000-0000-4000-8007-000000000001"
const VERSION = "00000000-0000-4000-8009-000000000001"

test("las posiciones 1, 1.5 y 2 son válidas y ordenan de forma exacta", () => {
  for (const valid of ["1", "1.5", "2", "0", "10", "999999", "999999.9999", "0.5"]) {
    assert.ok(SERIES_POSITION_PATTERN.test(valid), valid)
    assert.equal(canonicalSeriesPosition(valid), valid)
  }
  assert.deepEqual(["2", "1.5", "1", "10", "1.25"].sort(compareSeriesPositions), ["1", "1.25", "1.5", "2", "10"])
  // Dígitos que un flotante confundiría: 0.1 + 0.2 no es 0.3, pero el texto decimal sí compara exacto.
  assert.ok(compareSeriesPositions("0.3", "0.30000") === 0)
  assert.ok(compareSeriesPositions("0.1234", "0.1235") < 0)
})

test("«01.50» no es válida: el contrato no admite ceros a la izquierda, pero «1.50» se guarda como «1.5»", () => {
  assert.equal(SERIES_POSITION_PATTERN.test("01.50"), false)
  assert.equal(canonicalSeriesPosition("01.50"), null)
  const rejected = parseSeriesPositionInput("01.50")
  assert.equal(rejected.ok, false)
  assert.deepEqual(parseSeriesPositionInput("1.50"), { ok: true, value: "1.5" })
  assert.deepEqual(parseSeriesPositionInput(" 1,5 "), { ok: true, value: "1.5" }, "admite la coma decimal y los espacios")
})

test("las posiciones negativas y no numéricas se rechazan con una explicación en español", () => {
  for (const invalid of ["-1", "-0.5", "+1", "uno", "1e3", "1.00001", "1000000", ".5", "1.", "1.2.3", "1,2,3", "Infinity", "NaN", "0x10", "１"]) {
    const parsed = parseSeriesPositionInput(invalid)
    assert.equal(parsed.ok, false, invalid)
    if (!parsed.ok) assert.match(parsed.message, /número sin ceros a la izquierda/)
  }
})

test("una posición vacía o ausente significa orden desconocido, nunca un valor inferido", () => {
  for (const unknown of ["", "   ", null, undefined]) assert.deepEqual(parseSeriesPositionInput(unknown), { ok: true, value: null })
  assert.equal(describePosition(undefined), "Orden desconocido")
  assert.equal(describePosition("1.5"), "1.5")
  // El orden desconocido va siempre al final, tras cualquier posición conocida.
  assert.deepEqual(["3", null, "1", "2"].sort(compareSeriesPositions), ["1", "2", "3", null])
  assert.equal(compareSeriesPositions(null, null), 0)
})

test("las entradas de las acciones son estrictas y no aceptan un dueño elegido por el cliente", () => {
  assert.deepEqual(createSeriesSchema.parse({ title: "  Saga  ", description: "  " }), { title: "Saga", description: null })
  assert.equal(createSeriesSchema.safeParse({ title: "" }).success, false)
  assert.equal(createSeriesSchema.safeParse({ title: "x".repeat(SERIES_LIMITS.titleMax + 1) }).success, false)
  assert.equal(createSeriesSchema.safeParse({ title: "Saga", description: "d".repeat(SERIES_LIMITS.descriptionMax + 1) }).success, false)
  assert.equal(createSeriesSchema.safeParse({ title: "Saga", userId: SERIES }).success, false, "ningún DTO elige user_id")
  assert.equal(updateSeriesSchema.safeParse({ id: SERIES, expectedVersion: VERSION, title: "Saga" }).success, true)
  assert.equal(updateSeriesSchema.safeParse({ id: "no-uuid", expectedVersion: VERSION, title: "Saga" }).success, false)
  assert.equal(updateSeriesSchema.safeParse({ id: SERIES, title: "Saga" }).success, false, "la versión es obligatoria")

  const linked = linkEditionSchema.parse({ editionId: EDITION, seriesId: SERIES, position: "1,50", volumeLabel: " Tomo I ", orderNote: "" })
  assert.deepEqual(linked, { editionId: EDITION, seriesId: SERIES, position: "1.5", volumeLabel: "Tomo I", orderNote: null })
  assert.deepEqual(linkEditionSchema.parse({ editionId: EDITION, seriesId: SERIES }), { editionId: EDITION, seriesId: SERIES, position: null, volumeLabel: null, orderNote: null })
  assert.equal(linkEditionSchema.safeParse({ editionId: EDITION, seriesId: SERIES, position: "01.50" }).success, false)
  assert.equal(linkEditionSchema.safeParse({ editionId: EDITION, seriesId: SERIES, position: "-1" }).success, false)
  assert.equal(linkEditionSchema.safeParse({ editionId: EDITION, seriesId: SERIES, volumeLabel: "v".repeat(SERIES_LIMITS.volumeLabelMax + 1) }).success, false)
  assert.equal(linkEditionSchema.safeParse({ editionId: EDITION, seriesId: SERIES, orderNote: "n".repeat(SERIES_LIMITS.orderNoteMax + 1) }).success, false)
  assert.equal(moveVolumeSchema.safeParse({ editionId: EDITION, seriesId: SERIES, expectedVersion: VERSION, position: "2" }).success, true)
  assert.equal(moveVolumeSchema.safeParse({ editionId: EDITION, seriesId: SERIES, position: "2" }).success, false)
  assert.equal(unlinkEditionSchema.safeParse({ editionId: EDITION, expectedVersion: VERSION }).success, true)
  assert.equal(unlinkEditionSchema.safeParse({ editionId: EDITION }).success, false)
})

test("el filtro por serie del catálogo es aditivo: sin serie, la URL y los filtros no cambian", () => {
  const plain = parseBookSearchFilters(new URLSearchParams("q=Quijote&shelf=all"))
  assert.equal("series" in plain, false)
  assert.deepEqual(plain, { ...defaultBookSearchFilters(), q: "Quijote" })
  assert.equal(serializeBookSearchFilters(plain, new URLSearchParams()), "q=Quijote")

  const filtered = parseBookSearchFilters(new URLSearchParams(`series=${SERIES.toUpperCase()}&view=grid`))
  assert.equal(filtered.series, SERIES, "se normaliza a minúsculas")
  assert.equal(serializeBookSearchFilters(filtered, new URLSearchParams(), "table"), `series=${SERIES}&view=grid`)
  assert.equal(serializeBookSearchFilters({ ...filtered, series: "all" }, new URLSearchParams(`series=${SERIES}`), "table"), "view=grid")
  assert.equal("series" in parseBookSearchFilters(new URLSearchParams("series=no-es-un-uuid")), false, "un valor ajeno se descarta")
})
