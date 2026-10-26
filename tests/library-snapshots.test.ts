import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { describe, test } from "node:test"
import { canonicalJson, confirmationInput, IMPORT_RULES_VERSION, type CollectionSnapshot, type IdAllocator } from "../lib/import-plan"
import {
  assembleSnapshot, buildRestorePlan, decodeSnapshotCursor, encodeSnapshotCursor, pageLimit, restoreChanges, restoreDigest, SNAPSHOT_LIMITS, snapshotRows,
  snapshotDigest, translateSnapshotError, type SnapshotBookEntry, type SnapshotChunkRow, type SnapshotContent,
} from "../lib/library-snapshots"
import { DomainError, httpStatusForDomainError, isRetryable } from "../lib/domain-errors"

// U-DAT-02 · Funciones puras de las versiones anteriores: plan de restauración, integridad por hash,
// cursor del historial, clave de idempotencia y traducción de los códigos de 0006.

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")
const allocator: IdAllocator = (kind, sourceId) => {
  const hex = sha256(`semilla:${kind}:${sourceId}`)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

const DEFAULT = "10000000-0000-4000-8000-000000000001"
const POESIA = "10000000-0000-4000-8000-000000000002"
const ENSAYO = "10000000-0000-4000-8000-000000000003"
const book = (n: number, shelf = DEFAULT): SnapshotBookEntry => ({
  id: `30000000-0000-4000-8000-00000000000${n}`, isbn: `manual-${n}`, title: `Libro ${n}`, subtitle: null, authors: [{ name: "Autoría" }], publishers: [],
  catalogue: { source: "import", isbnVerified: false }, number_of_pages: 10, publish_date: "1997", cover_small: "/default-book-cover.webp",
  cover_medium: "/default-book-cover.webp", cover_large: "/default-book-cover.webp", status: "read", shelf_id: shelf, created_at: "2026-10-01T10:00:00.123456+00:00",
})
const snapshot: SnapshotContent = {
  shelves: [
    { id: DEFAULT, title: "Predeterminada", is_default: true, created_at: "2026-09-01T10:00:00+00:00" },
    { id: POESIA, title: "Poesía", is_default: false, created_at: "2026-09-02T10:00:00+00:00" },
  ],
  books: [book(1), book(2, POESIA), book(3, POESIA)],
}

describe("plan de restauración", () => {
  test("tras un reemplazo vuelve a los IDs propios, elimina lo añadido después y conserva la predeterminada", () => {
    // Estado tras el reemplazo: un libro conservado (1), uno nuevo (9) y otra estantería.
    const current: CollectionSnapshot = {
      shelves: [{ id: DEFAULT, title: "Predeterminada", isDefault: true }, { id: ENSAYO, title: "Ensayo", isDefault: false }],
      books: [{ id: book(1).id, isbn: "manual-1" }, { id: "30000000-0000-4000-8000-000000000009", isbn: "manual-9" }],
    }
    const plan = buildRestorePlan({ snapshot, current, foreign: new Set(), allocateId: allocator })
    assert.equal(plan.mode, "replace")
    assert.equal(plan.rulesVersion, IMPORT_RULES_VERSION)
    assert.deepEqual(plan.books.insert.map((entry) => entry.id), snapshot.books.map((entry) => entry.id), "IDs propios, también de libros borrados después")
    assert.deepEqual(plan.books.insert.map((entry) => entry.shelfId), [DEFAULT, POESIA, POESIA], "referencias a estanterías restauradas")
    assert.deepEqual(plan.books.delete, ["30000000-0000-4000-8000-000000000009"])
    assert.deepEqual(plan.shelves.create, [{ sourceId: POESIA, id: POESIA, title: "Poesía" }])
    assert.deepEqual(plan.shelves.delete, [ENSAYO])
    assert.deepEqual(plan.reassigned, [])
    assert.deepEqual({ added: plan.counts.added, kept: plan.counts.kept, deleted: plan.counts.deleted, shelvesCreated: plan.counts.shelvesCreated, shelvesDeleted: plan.counts.shelvesDeleted, booksAfter: plan.counts.booksAfter, shelvesAfter: plan.counts.shelvesAfter },
      { added: 2, kept: 1, deleted: 1, shelvesCreated: 1, shelvesDeleted: 1, booksAfter: 3, shelvesAfter: 2 })
    assert.deepEqual(plan.books.skip, [])
  })

  test("un ID ocupado por otra cuenta se reasigna de forma estable e informada", () => {
    const current: CollectionSnapshot = { shelves: [{ id: DEFAULT, title: "Predeterminada", isDefault: true }], books: [] }
    const foreign = new Set([book(2).id, POESIA])
    const first = buildRestorePlan({ snapshot, current, foreign, allocateId: allocator })
    const again = buildRestorePlan({ snapshot, current, foreign, allocateId: allocator })
    assert.equal(canonicalJson(first), canonicalJson(again), "el mismo estado produce el mismo plan al confirmar")
    const shelf = first.shelves.create[0]
    assert.notEqual(shelf.id, POESIA)
    assert.deepEqual(first.reassigned.map((entry) => [entry.kind, entry.sourceId]), [["shelf", POESIA], ["book", book(2).id]])
    assert.equal(first.books.insert.find((entry) => entry.sourceId === book(2).id)?.id, allocator("book", book(2).id))
    assert.ok(first.books.insert.filter((entry) => entry.sourceId !== book(1).id).every((entry) => entry.shelfId === shelf.id), "los libros siguen a su estantería reasignada")
    assert.equal(first.counts.reassigned, 2)
  })

  test("la predeterminada actual sustituye a la de la versión y un título que coincide con ella se une", () => {
    const recreated = "10000000-0000-4000-8000-0000000000aa"
    const current: CollectionSnapshot = { shelves: [{ id: recreated, title: "Poesía", isDefault: true }], books: [] }
    const plan = buildRestorePlan({ snapshot, current, foreign: new Set(), allocateId: allocator })
    assert.deepEqual(plan.shelves.map, [{ sourceId: DEFAULT, id: recreated }, { sourceId: POESIA, id: recreated }])
    assert.deepEqual(plan.shelves.create, [])
    assert.ok(plan.books.insert.every((entry) => entry.shelfId === recreated))
    assert.equal(plan.counts.shelvesAfter, 1)
  })

  test("sin predeterminada actual o con un libro sin estantería no se planifica", () => {
    assert.throws(() => buildRestorePlan({ snapshot, current: { shelves: [], books: [] }, foreign: new Set(), allocateId: allocator }))
    const broken: SnapshotContent = { ...snapshot, books: [book(4, "10000000-0000-4000-8000-0000000000ff")] }
    assert.throws(() => buildRestorePlan({ snapshot: broken, current: { shelves: [{ id: DEFAULT, title: "Predeterminada", isDefault: true }], books: [] }, foreign: new Set(), allocateId: allocator }))
  })

  test("la comparación nombra lo que desaparece y lo que vuelve, acotada", () => {
    const current: CollectionSnapshot = { shelves: [{ id: DEFAULT, title: "Predeterminada", isDefault: true }], books: [{ id: book(1).id, isbn: "manual-1" }, { id: "30000000-0000-4000-8000-000000000009", isbn: "x" }] }
    const plan = buildRestorePlan({ snapshot, current, foreign: new Set(), allocateId: allocator })
    const titles = new Map([[book(1).id, "Libro 1"], ["30000000-0000-4000-8000-000000000009", "Añadido después"]])
    assert.deepEqual(restoreChanges(plan, snapshot, titles), { removed: ["Añadido después"], removedTotal: 1, restored: ["Libro 2", "Libro 3"], restoredTotal: 2 })
    assert.deepEqual(restoreChanges(plan, snapshot, titles, 1).restored, ["Libro 2"])
  })
})

describe("integridad de una versión", () => {
  const chunk = (seq: number, kind: string, payload: unknown[]): SnapshotChunkRow => {
    const text = JSON.stringify(payload)
    return { seq, kind, itemCount: payload.length, digest: sha256(text), valid: true, payload }
  }
  const chunks = [chunk(0, "shelves", snapshot.shelves), chunk(1, "books", snapshot.books)]
  const header = { counts: { books: 3, shelves: 2 }, digest: snapshotDigest({ books: 3, shelves: 2 }, chunks.map((c) => c.digest)) }

  test("una versión completa se reconstruye en orden", () => {
    assert.deepEqual(assembleSnapshot(header, chunks), snapshot)
  })

  test("un trozo alterado, perdido, desordenado o con cantidades distintas se rechaza sin restaurar", () => {
    const damaged = (rows: SnapshotChunkRow[], head = header) => assert.throws(() => assembleSnapshot(head, rows), (error: unknown) => error instanceof DomainError && error.code === "CONFLICT")
    damaged([{ ...chunks[0], valid: false }, chunks[1]])
    damaged([chunks[0]])
    damaged([chunks[1], chunks[0]])
    damaged([chunks[0], { ...chunks[1], seq: 2 }])
    damaged([chunks[0], { ...chunks[1], itemCount: 2 }])
    damaged(chunks, { ...header, digest: "0".repeat(64) })
    damaged(chunks, { ...header, counts: { books: 4, shelves: 2 } })
    damaged([chunks[0], chunk(1, "books", [{ ...snapshot.books[0], status: "prestado" }])], { counts: header.counts, digest: header.digest })
    damaged([chunk(0, "shelves", snapshot.shelves.map((shelf) => ({ ...shelf, is_default: false })))], { counts: { books: 0, shelves: 2 }, digest: snapshotDigest({ books: 0, shelves: 2 }, [chunk(0, "shelves", snapshot.shelves.map((shelf) => ({ ...shelf, is_default: false }))).digest]) })
  })

  test("el hash final usa el mismo formato que library_snapshot_capture", () => {
    assert.equal(snapshotDigest({ books: 3, shelves: 2 }, ["ab", "cd"]), sha256("biblib.snapshot.v1|3|2|abcd"))
  })
})

describe("contratos auxiliares", () => {
  test("la clave de una restauración es distinta de la de una importación del mismo contenido", () => {
    const preview = { inputDigest: "a".repeat(64), mode: "replace" as const, rulesVersion: IMPORT_RULES_VERSION }
    assert.match(restoreDigest(preview), /^[0-9a-f]{64}$/)
    assert.notEqual(restoreDigest(preview), sha256(canonicalJson(confirmationInput(preview))))
    assert.equal(restoreDigest(preview), restoreDigest({ ...preview }))
    assert.notEqual(restoreDigest(preview), restoreDigest({ ...preview, inputDigest: "b".repeat(64) }))
  })

  test("el cursor del historial es opaco, conserva microsegundos y rechaza entradas manipuladas", () => {
    const position = { createdAt: "2026-10-23T10:11:12.345678Z", id: "4f1c2d3e-0000-4000-8000-000000000001" }
    const cursor = encodeSnapshotCursor(position)
    assert.match(cursor, /^[A-Za-z0-9_-]+$/)
    assert.deepEqual(decodeSnapshotCursor(cursor), position)
    assert.equal(decodeSnapshotCursor(null), null)
    assert.equal(decodeSnapshotCursor(""), null)
    for (const bad of ["no-es-base64", Buffer.from("[\"ayer\",\"x\"]").toString("base64url"), Buffer.from("{}").toString("base64url"), "a".repeat(201)]) {
      assert.throws(() => decodeSnapshotCursor(bad), (error: unknown) => error instanceof DomainError && error.code === "INVALID_INPUT")
    }
  })

  test("el tamaño de página se acota", () => {
    assert.equal(pageLimit(undefined), SNAPSHOT_LIMITS.pageSize)
    assert.equal(pageLimit(0), 1)
    assert.equal(pageLimit(500), SNAPSHOT_LIMITS.maxPageSize)
    assert.equal(pageLimit(2.5), SNAPSHOT_LIMITS.pageSize)
  })

  test("los códigos de 0006 se traducen a errores claros y no reintentables", () => {
    const translated = (code: string) => { try { translateSnapshotError(Object.assign(new Error("db"), { code })) } catch (error) { return error } }
    const quota = translated("BS001")
    assert.ok(quota instanceof DomainError && quota.code === "LIMIT_EXCEEDED" && /máximo de 10 versiones/.test(quota.message))
    const blocked = translated("BS002")
    assert.ok(blocked instanceof DomainError && blocked.code === "UNAUTHORIZED")
    const large = translated("BS003")
    assert.ok(large instanceof DomainError && large.code === "LIMIT_EXCEEDED" && /10\.000 libros/.test(large.message))
    const other = translated("23505")
    assert.ok(other instanceof Error && !(other instanceof DomainError), "el resto se relanza sin traducir")
    assert.equal(isRetryable("LIMIT_EXCEEDED"), false)
    assert.equal(httpStatusForDomainError("LIMIT_EXCEEDED"), 413)
  })
})

describe("versiones anteriores y ejemplares (U-DAT-06)", () => {
  test("una versión legacy se restaura como en el backfill: equivalencias compatibles comparten edición y las demás conservan su texto", () => {
    const legacy = (n: number, isbn: string, title = "Ensayo"): SnapshotBookEntry => ({ ...book(n), isbn, title })
    const content: SnapshotContent = { shelves: snapshot.shelves, books: [legacy(1, "9780306406157"), legacy(2, "0306406152"), legacy(3, "978-0-306-40615-7", "Otra"), legacy(4, "manual-4")] }
    const rows = snapshotRows(content)
    assert.equal(rows.get(book(2).id)!.edition!.id, book(1).id, "el ISBN-10 con los mismos datos comparte edición")
    assert.equal(rows.get(book(2).id)!.isbn, "9780306406157")
    assert.equal(rows.get(book(3).id)!.isbn, null, "con datos distintos no ocupa el ISBN-13")
    assert.equal(rows.get(book(3).id)!.legacyIdentifier, "978-0-306-40615-7", "y conserva su texto original")
    assert.equal(rows.get(book(4).id)!.legacyIdentifier, "manual-4")
    const plan = buildRestorePlan({ snapshot: content, current: { shelves: [{ id: DEFAULT, title: "Predeterminada", isDefault: true }], books: [] }, foreign: new Set(), allocateId: allocator })
    assert.equal(plan.books.insert.length, 4, "ninguna ficha se descarta")
    assert.equal(plan.editions.create.length, 3)
  })

  test("una versión 2 conserva ejemplares, edición compartida, comprobación y obra con sus IDs salvo los ajenos", () => {
    const edition = "40000000-0000-4000-8000-000000000001", work = "50000000-0000-4000-8000-000000000001"
    const v2 = (n: number, verified: boolean): SnapshotBookEntry => ({ ...book(n), isbn: "9780306406157", edition_id: edition, work_id: work, work_title: "Obra", verification: { isbnVerified: verified, checkedAt: "2026-10-01T10:00:00Z" } })
    const content: SnapshotContent = { shelves: snapshot.shelves, books: [v2(1, true), v2(2, false)] }
    const rows = snapshotRows(content)
    assert.deepEqual([...rows.values()].map((row) => [row.edition!.id, row.catalogue!.isbnVerified, row.verification?.checkedAt]), [[edition, true, "2026-10-01T10:00:00Z"], [edition, false, "2026-10-01T10:00:00Z"]])
    const current = { shelves: [{ id: DEFAULT, title: "Predeterminada", isDefault: true }], books: [] }
    const plan = buildRestorePlan({ snapshot: content, current, foreign: new Set(), allocateId: allocator })
    assert.deepEqual(plan.editions.create.map((entry) => [entry.id, entry.workId]), [[edition, work]])
    assert.deepEqual(plan.works.create.map((entry) => entry.id), [work])
    const foreign = buildRestorePlan({ snapshot: content, current, foreign: new Set([edition, work]), allocateId: allocator })
    assert.equal(foreign.editions.create[0].id, allocator("edition", edition), "una edición ocupada por otra cuenta recibe otro ID")
    assert.equal(foreign.works.create[0].id, allocator("work", work))
    assert.deepEqual(foreign.books.insert.map((entry) => entry.id), [book(1).id, book(2).id], "los ejemplares conservan los suyos")
  })
})
