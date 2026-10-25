import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import {
  BACKUP_SET_KIND, chunkCount, createBackupSetManifest, looksLikeManifest, ManifestError, parseBackupSetManifest, partIdFor, payloadCounts,
  RESTORE_LIMITS, serializeBackupSetManifest, type BackupSetManifest,
} from "../lib/import-manifest"
import { buildBackupSet } from "../lib/library-export"
import { parseLibraryImport } from "../lib/library-import"
import { commitBudget, DEFAULT_COMMIT_BUDGET, RESTORE_SESSION_INVENTORY, restoreCommitDigest, translateStagingError } from "../lib/import-staging"
import { DomainError, httpStatusForDomainError, isRetryable } from "../lib/domain-errors"
import type { Book, LibraryData } from "../lib/types"

// U-DAT-04 · Manifest `bundleVersion: 1`, copia por partes generada en el servidor y contratos puros
// del staging. La integración con Postgres, GoTrue y la app está en tests/integration/restore.

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
const exportedAt = new Date("2026-10-24T10:00:00.000Z")
const setId = "11111111-1111-4111-8111-111111111111"

function library(count: number, extraShelves = 0): LibraryData {
  const shelves = [{ id: "s-default", title: "Predeterminada", book_count: 0, isDefault: true }, { id: "s-1", title: "Novela", book_count: 0 },
    ...Array.from({ length: extraShelves }, (_, index) => ({ id: `s-vacia-${index}`, title: `Vacía ${index}`, book_count: 0 }))]
  const books: Book[] = Array.from({ length: count }, (_, index) => ({
    id: `b-${String(index).padStart(5, "0")}`, isbn: `manual-${index}`, title: `Libro ${index}`, authors: [], number_of_pages: 1, publish_date: "",
    cover: { small: "/default-book-cover.webp", medium: "/default-book-cover.webp", large: "/default-book-cover.webp" }, status: "unread",
    shelf_id: index % 2 ? "s-1" : "s-default", shelf_name: "",
  }))
  return { shelves, books }
}

function manifestFor(overrides: Partial<BackupSetManifest> = {}): BackupSetManifest {
  return { ...createBackupSetManifest({
    exportSetId: setId, exportedAt: exportedAt.toISOString(), payloadFormatVersion: 1,
    parts: [{ byteLength: 1000, sha256: "a".repeat(64), counts: { books: 2000, shelves: 2 } }, { byteLength: 500, sha256: "b".repeat(64), counts: { books: 1, shelves: 1 } }],
    totals: { books: 2001, shelves: 2 },
  }), ...overrides }
}

const code = (fn: () => unknown) => { try { fn() } catch (error) { return error instanceof ManifestError ? error.code : "otro" } return null }

test("2001 libros: dos partes con hash y tamaño de los bytes exactos, manifest válido y generación determinista", () => {
  const data = library(2001, 3)
  const set = buildBackupSet(data, { exportedAt, exportSetId: setId, sha256 })
  assert.equal(set.formatVersion, 1)
  assert.equal(set.files.length, 2)
  for (const file of set.files) {
    const bytes = new TextEncoder().encode(file.text)
    assert.equal(file.byteLength, bytes.byteLength)
    assert.equal(file.sha256, sha256(bytes), "el hash es el de los bytes UTF-8 que se descargan")
    assert.ok(file.byteLength <= RESTORE_LIMITS.maxPartBytes)
    parseLibraryImport(JSON.parse(file.text))
  }
  assert.deepEqual(set.files.map((file) => file.counts), [{ books: 2000, shelves: 2 }, { books: 1, shelves: 4 }], "las estanterías vacías y compartidas se cuentan por parte")
  const manifest = parseBackupSetManifest(JSON.parse(set.manifestText))
  assert.equal(manifest.kind, BACKUP_SET_KIND)
  assert.equal(manifest.bundleVersion, 1)
  assert.deepEqual(manifest.totals, { books: 2001, shelves: 5 }, "totales globales únicos")
  assert.deepEqual(manifest.parts.map((part) => [part.partId, part.index, part.sha256]), set.files.map((file, index) => [partIdFor(index), index, file.sha256]))
  assert.ok(!set.manifestText.includes("user_id"), "el manifest no lleva propietario")
  assert.ok(looksLikeManifest(set.manifestText.slice(0, 64)))
  assert.ok(!looksLikeManifest(set.files[0].text.slice(0, 64)))
  assert.match(set.manifestFileName, /-conjunto\.json$/)
  assert.match(set.files[1].fileName, /-parte-2-de-2\.json$/)
  // Misma colección, fecha y conjunto: mismos bytes, así la descarga de cada parte se puede regenerar.
  const again = buildBackupSet(data, { exportedAt, exportSetId: setId, sha256 })
  assert.deepEqual(again.files.map((file) => file.sha256), set.files.map((file) => file.sha256))
  assert.equal(again.manifestText, set.manifestText)
})

test("las 111 fichas sintéticas legacy forman una sola parte v1 importable", () => {
  const legacy = parseLibraryImport(JSON.parse(readFileSync("tests/fixtures/import/sintetico-111.json", "utf8")))
  const set = buildBackupSet(legacy, { exportedAt, exportSetId: setId, sha256 })
  assert.equal(set.files.length, 1)
  const restored = parseLibraryImport(JSON.parse(set.files[0].text))
  assert.equal(restored.books.length, 111)
  assert.equal(restored.books.filter((book) => book.legacyIdentifier?.startsWith("manual-")).length, 9, "los identificadores manuales se conservan")
  assert.deepEqual(parseBackupSetManifest(JSON.parse(set.manifestText)).totals, { books: 111, shelves: legacy.shelves.length })
})

test("con procedencia por campo el conjunto usa el payload v2 existente y cuenta ediciones y copias", () => {
  const data = library(3)
  data.books[0].catalogue = { schemaVersion: 2, source: "bne", isbnVerified: false, fields: { title: { provider: "bne", selection: "user-selected" } } }
  data.books[0].isbn = "9788401337208"
  const set = buildBackupSet(data, { exportedAt, exportSetId: setId, sha256 })
  assert.equal(set.formatVersion, 2)
  assert.ok(set.reason)
  const part = JSON.parse(set.files[0].text)
  assert.equal(part.formatVersion, 2)
  assert.deepEqual(payloadCounts(part), { formatVersion: 2, counts: { works: 0, editions: 3, copies: 3, shelves: 2 } })
  assert.deepEqual(parseBackupSetManifest(JSON.parse(set.manifestText)).totals, { works: 0, editions: 3, copies: 3, shelves: 2 })
})

test("el manifest se rechaza si es incoherente: orden, duplicados, formato, totales o versión", () => {
  assert.equal(code(() => parseBackupSetManifest(manifestFor())), null)
  const parts = manifestFor().parts
  assert.equal(code(() => parseBackupSetManifest(manifestFor({ parts: [parts[1], parts[0]] }))), "MANIFEST_MISMATCH", "orden")
  assert.equal(code(() => parseBackupSetManifest(manifestFor({ parts: [parts[0], { ...parts[1], index: 2 }] }))), "MANIFEST_MISMATCH", "posición ausente")
  assert.equal(code(() => parseBackupSetManifest(manifestFor({ parts: [parts[0], { ...parts[1], sha256: parts[0].sha256 }] }))), "MANIFEST_MISMATCH", "parte duplicada")
  assert.equal(code(() => parseBackupSetManifest(manifestFor({ parts: [parts[0], { ...parts[1], partId: parts[0].partId }] }))), "MANIFEST_MISMATCH", "ID repetido")
  assert.equal(code(() => parseBackupSetManifest(manifestFor({ totals: { books: 2002, shelves: 2 } }))), "MANIFEST_MISMATCH", "total falso")
  assert.equal(code(() => parseBackupSetManifest(manifestFor({ totals: { books: 2001, shelves: 4 } }))), "MANIFEST_MISMATCH", "estanterías imposibles")
  assert.equal(code(() => parseBackupSetManifest(manifestFor({ payloadFormatVersion: 2 }))), "MANIFEST_MISMATCH", "cantidades de otro formato")
  assert.equal(code(() => parseBackupSetManifest({ ...manifestFor(), bundleVersion: 2 })), "INVALID_INPUT", "versión de conjunto desconocida")
  assert.equal(code(() => parseBackupSetManifest({ ...manifestFor(), user_id: "x" })), "INVALID_INPUT", "sin claves desconocidas ni propietario")
  assert.equal(code(() => parseBackupSetManifest({ ...manifestFor(), formatVersion: 1 })), "INVALID_INPUT")
})

test("límites del conjunto: 10 000 libros, 1 000 estanterías, 80 MiB y 50 partes dan LIMIT_EXCEEDED", () => {
  const part = (index: number, byteLength = 1000) => ({ byteLength, sha256: index.toString(16).padStart(64, "0"), counts: { books: 2000, shelves: 1 } })
  const many = (n: number, byteLength?: number) => createBackupSetManifest({ exportSetId: setId, exportedAt: exportedAt.toISOString(), payloadFormatVersion: 1,
    parts: Array.from({ length: n }, (_, index) => part(index, byteLength)), totals: { books: 2000 * n, shelves: 1 } })
  assert.equal(code(() => parseBackupSetManifest(many(5))), null)
  assert.equal(code(() => parseBackupSetManifest(many(6))), "LIMIT_EXCEEDED", "más de 10 000 libros")
  assert.equal(code(() => parseBackupSetManifest(many(3, 30 * 1024 * 1024))), "LIMIT_EXCEEDED", "parte mayor de 8 MiB")
  const big = createBackupSetManifest({ exportSetId: setId, exportedAt: exportedAt.toISOString(), payloadFormatVersion: 1,
    parts: Array.from({ length: 11 }, (_, index) => ({ ...part(index, 8 * 1024 * 1024), counts: { books: 1, shelves: 1 } })), totals: { books: 11, shelves: 1 } })
  assert.equal(code(() => parseBackupSetManifest(big)), "LIMIT_EXCEEDED", "más de 80 MiB")
  const shelves = createBackupSetManifest({ exportSetId: setId, exportedAt: exportedAt.toISOString(), payloadFormatVersion: 1,
    parts: Array.from({ length: 6 }, (_, index) => ({ ...part(index), counts: { books: 0, shelves: 200 } })), totals: { books: 0, shelves: 1001 } })
  assert.equal(code(() => parseBackupSetManifest(shelves)), "LIMIT_EXCEEDED", "más de 1 000 estanterías")
  const parts = createBackupSetManifest({ exportSetId: setId, exportedAt: exportedAt.toISOString(), payloadFormatVersion: 1,
    parts: Array.from({ length: 51 }, (_, index) => ({ ...part(index), counts: { books: 0, shelves: 1 } })), totals: { books: 0, shelves: 1 } })
  assert.equal(code(() => parseBackupSetManifest(parts)), "LIMIT_EXCEEDED", "más de 50 partes")
})

test("trozos de 256 KiB, cantidades por formato y serialización estable", () => {
  assert.deepEqual([chunkCount(1), chunkCount(262_144), chunkCount(262_145), chunkCount(8 * 1024 * 1024)], [1, 1, 2, 32])
  assert.deepEqual(payloadCounts({ books: [1, 2], shelves: [1] }), { formatVersion: 1, counts: { books: 2, shelves: 1 } }, "el formato antiguo se cuenta como v1")
  assert.throws(() => payloadCounts({ formatVersion: 3 }), ManifestError)
  const manifest = manifestFor()
  assert.deepEqual(JSON.parse(serializeBackupSetManifest(manifest)), manifest)
  assert.ok(serializeBackupSetManifest(manifest).startsWith('{\n  "kind": "biblib.backup-set"'))
})

test("staging: presupuesto acotado, clave limitada al conjunto y errores sin detalles de Postgres", () => {
  assert.deepEqual(DEFAULT_COMMIT_BUDGET, { lockTimeoutMs: 1000, statementTimeoutMs: 5000, totalMs: 15000 })
  assert.equal(commitBudget("30000").totalMs, 30_000)
  for (const value of [undefined, "abc", "10", "999999"]) assert.equal(commitBudget(value).totalMs, 15_000, `valor ${value}`)
  const digest = restoreCommitDigest({ manifestDigest: "c".repeat(64), rulesVersion: 1 })
  assert.match(digest, /^[0-9a-f]{64}$/)
  assert.equal(restoreCommitDigest({ manifestDigest: "c".repeat(64), rulesVersion: 1 }), digest)
  assert.notEqual(restoreCommitDigest({ manifestDigest: "d".repeat(64), rulesVersion: 1 }), digest, "otro conjunto, otra entrada")
  assert.equal(RESTORE_SESSION_INVENTORY.length, 4)
  const translated = (error: unknown) => { try { translateStagingError(error) } catch (thrown) { return thrown } }
  const timeout = translated({ code: "57014", message: "canceling statement due to statement timeout" })
  assert.ok(timeout instanceof DomainError && timeout.code === "PROVIDER_UNAVAILABLE" && !timeout.message.includes("statement"))
  assert.ok(isRetryable("PROVIDER_UNAVAILABLE"), "un timeout se puede reintentar con la misma clave")
  const guard = translated({ code: "BR001" })
  assert.ok(guard instanceof DomainError && guard.code === "CONFLICT")
  const mismatch = translated(new ManifestError("MANIFEST_MISMATCH", "x"))
  assert.ok(mismatch instanceof DomainError && mismatch.code === "MANIFEST_MISMATCH")
  assert.equal(httpStatusForDomainError("MANIFEST_MISMATCH"), 422)
  assert.equal(isRetryable("MANIFEST_MISMATCH"), false)
})
