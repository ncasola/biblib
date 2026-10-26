import assert from "node:assert/strict"
import { test } from "node:test"
import {
  buildOfflineSnapshot, createMemoryOfflineStorage, createOfflineLibrary, isOfflineCopyExpired, maskEmail, offlineAccountId, offlineDatabaseName,
  OfflineCopyError, parseOfflineSnapshot, validateOfflineSecret, OFFLINE_COPY_TTL_MS, OFFLINE_DB_PREFIX, OFFLINE_IV_BYTES, OFFLINE_KDF_ITERATIONS,
  OFFLINE_MAX_FAILED_UNLOCKS, OFFLINE_SALT_BYTES, type OfflineCopyMeta, type OfflineSnapshot, type OfflineStorage,
} from "../lib/offline-library"
import type { Book, LibraryData } from "../lib/types"

// U-EXP-08 · Copia de lectura sin conexión: KDF y envoltura con los parámetros del contrato (O15), TTL, contador
// de intentos, aislamiento por cuenta, corrupción, cuota y lista blanca de campos. Las iteraciones de PBKDF2 se
// reducen solo por inyección (`iterations`); la constante de producción se comprueba aparte.

const TEST_ITERATIONS = 1000
const USER_A = "0b0c0d0e-0000-4000-8000-00000000000a"
const USER_B = "0b0c0d0e-0000-4000-8000-00000000000b"

function book(overrides: Partial<Book> = {}): Book {
  return {
    id: "c0000000-0000-4000-8000-000000000001", isbn: "9788400000000", title: "El cuaderno de la bruma", authors: [{ name: "Ana Faro" }],
    number_of_pages: 320, publish_date: "2020", publishers: [{ name: "Editorial Niebla" }],
    cover: { small: "https://covers.openlibrary.org/b/id/1-S.jpg", medium: "https://covers.openlibrary.org/b/id/1-M.jpg", large: "https://covers.openlibrary.org/b/id/1-L.jpg" },
    status: "reading", shelf_id: "s1", shelf_name: "Salón", coverAssetId: "asset-privado",
    edition: { id: "e1", copies: 2, workTitle: "Cuaderno", language: "es", series: { seriesId: "se1", position: "2", volumeLabel: "II" }, identifiers: { openLibrary: ["OL1M"] } },
    personal: { notes: "NOTA PRIVADA SECRETA", rating: 5, tagIds: ["t1"] },
    location: { locationId: "l2", shelfLabel: "Balda 3", position: 4 },
    reading: [{ id: "rc1", cycleNumber: 1, status: "reading", startedAt: "2026-10-01T10:00:00.000Z", entries: [{ id: "re1", occurredAt: "2026-10-02T10:00:00.000Z", pageTo: 40, note: "SESION PRIVADA" }] }],
    loans: [{ id: "lo1", borrowerLabel: "PRESTATARIO ALIAS", loanedOn: "2026-10-10", note: "NOTA PRESTAMO" }],
    catalogue: { source: "open-library", isbnVerified: true, sourceUrl: "https://openlibrary.org/books/OL1M" },
    ...overrides,
  }
}

const library: LibraryData = {
  books: [book(), book({ id: "c0000000-0000-4000-8000-000000000002", title: "Mapas", personal: undefined, location: undefined, loans: [{ id: "lo2", borrowerLabel: "Otro", loanedOn: "2026-01-01", returnedOn: "2026-02-01" }], edition: undefined, isbn: null })],
  shelves: [{ id: "s1", title: "Salón", book_count: 2, isDefault: true }],
  tags: [{ id: "t1", name: "Faros" }],
  locations: [{ id: "l1", name: "Casa", kind: "room", parentId: null }, { id: "l2", name: "Estantería norte", kind: "bookcase", parentId: "l1", photo: { assetId: "foto-privada" } as never }],
  series: [{ id: "se1", title: "Trilogía de la bruma", description: "Descripción" }],
}

const snapshot = (at = "2026-10-26T08:00:00.000Z"): OfflineSnapshot => buildOfflineSnapshot(library, new Date(at))

function clock(start = "2026-10-26T09:00:00.000Z") {
  let now = Date.parse(start)
  return { now: () => new Date(now), advance: (ms: number) => { now += ms } }
}

/** Web Crypto real con registro de las llamadas, para comprobar algoritmos y parámetros. */
function recordingSubtle() {
  const calls: { method: string; args: unknown[] }[] = []
  const real = globalThis.crypto.subtle
  const subtle = new Proxy(real, {
    get(target, property) {
      const value = Reflect.get(target, property)
      if (typeof value !== "function") return value
      return (...args: unknown[]) => { calls.push({ method: String(property), args }); return (value as (...a: unknown[]) => unknown).apply(target, args) }
    },
  })
  return { subtle, calls }
}

function setup(options: { storage?: OfflineStorage; start?: string } = {}) {
  const storage = options.storage ?? createMemoryOfflineStorage()
  const time = clock(options.start)
  const recorded = recordingSubtle()
  const offline = createOfflineLibrary({ storage, now: time.now, iterations: TEST_ITERATIONS, subtle: recorded.subtle })
  return { storage, time, offline, calls: recorded.calls }
}

test("constantes del contrato: 600 000 iteraciones, sal de 16 bytes, IV de 12, 10 intentos y TTL de 7 días", () => {
  assert.equal(OFFLINE_KDF_ITERATIONS, 600_000)
  assert.equal(OFFLINE_SALT_BYTES, 16)
  assert.equal(OFFLINE_IV_BYTES, 12)
  assert.equal(OFFLINE_MAX_FAILED_UNLOCKS, 10)
  assert.equal(OFFLINE_COPY_TTL_MS, 7 * 24 * 60 * 60 * 1000)
})

test("por defecto se usan las iteraciones de producción: solo la inyección las reduce", async () => {
  const storage = createMemoryOfflineStorage()
  const offline = createOfflineLibrary({ storage })
  const accountId = await offlineAccountId(USER_A)
  await offline.create(accountId, { secret: "123456", maskedEmail: "a•••@b•••.test", snapshot: snapshot() })
  const meta = (await storage.read(offlineDatabaseName(accountId)))?.meta as OfflineCopyMeta
  assert.equal(meta.kdf.iterations, OFFLINE_KDF_ITERATIONS)
})

test("PIN de 6 dígitos o frase de 8 caracteres; nada más corto", () => {
  assert.deepEqual(validateOfflineSecret("123456"), { ok: true, kind: "pin" })
  assert.deepEqual(validateOfflineSecret("faro de noche"), { ok: true, kind: "frase" })
  assert.deepEqual(validateOfflineSecret("ñandú€€€"), { ok: true, kind: "frase" })
  for (const weak of ["12345", "", "abc", "corta1", " espacios al borde "]) assert.equal(validateOfflineSecret(weak).ok, false, weak)
  assert.equal(validateOfflineSecret("x".repeat(129)).ok, false)
})

test("KDF PBKDF2-SHA-256 con sal aleatoria de 16 bytes, AES-KW que envuelve una clave AES-GCM de 256 bits no extraíble al abrir", async () => {
  const { offline, storage, calls } = setup()
  const accountId = await offlineAccountId(USER_A)
  const created = await offline.create(accountId, { secret: "faro de noche", maskedEmail: "a•••@b•••.test", snapshot: snapshot() })

  const derive = calls.find((call) => call.method === "deriveKey")
  assert.ok(derive)
  const [params, , derived, extractable, usages] = derive.args as [Pbkdf2Params, CryptoKey, AesKeyGenParams, boolean, string[]]
  assert.equal(params.name, "PBKDF2")
  assert.equal(params.hash, "SHA-256")
  assert.equal(params.iterations, TEST_ITERATIONS)
  assert.equal((params.salt as Uint8Array).length, 16)
  assert.deepEqual(derived, { name: "AES-KW", length: 256 })
  assert.equal(extractable, false)
  assert.deepEqual(usages, ["wrapKey", "unwrapKey"])
  const generate = calls.find((call) => call.method === "generateKey")
  assert.deepEqual(generate?.args[0], { name: "AES-GCM", length: 256 })
  assert.equal(calls.find((call) => call.method === "wrapKey")?.args[3], "AES-KW")

  const meta = (await storage.read(offlineDatabaseName(accountId)))?.meta as OfflineCopyMeta
  assert.equal(meta.kdf.salt.length, 16)
  assert.equal(meta.wrappedKey.length, 40, "AES-KW de una clave de 256 bits ocupa 40 bytes")
  assert.equal(meta.wrap, "AES-KW")
  assert.equal(created.key.extractable, false)
  assert.equal((created.key.algorithm as AesKeyAlgorithm).name, "AES-GCM")
  assert.equal((created.key.algorithm as AesKeyAlgorithm).length, 256)

  const opened = await offline.unlock(accountId, "faro de noche")
  assert.equal(opened.key.extractable, false)
  assert.deepEqual(opened.snapshot, snapshot())

  // La sal y la clave cambian en cada copia nueva; nada en claro en el almacenamiento.
  const again = setup({ storage: createMemoryOfflineStorage() })
  await again.offline.create(accountId, { secret: "faro de noche", maskedEmail: "a•••@b•••.test", snapshot: snapshot() })
  const other = (await again.storage.read(offlineDatabaseName(accountId)))?.meta as OfflineCopyMeta
  assert.notDeepEqual(other.kdf.salt, meta.kdf.salt)
  const serialized = JSON.stringify([...(storage as ReturnType<typeof createMemoryOfflineStorage>).databases.values()].map((records) => [...records.values()]), (_key, value) => value instanceof Uint8Array ? Buffer.from(value).toString("latin1") : value)
  assert.ok(!serialized.includes("El cuaderno de la bruma"))
  assert.ok(!serialized.includes("faro de noche"))
})

test("IV aleatorio de 12 bytes distinto en cada escritura (alta y renovación)", async () => {
  const { offline, storage, calls } = setup()
  const accountId = await offlineAccountId(USER_A)
  const created = await offline.create(accountId, { secret: "123456", maskedEmail: "m", snapshot: snapshot() })
  const first = (await storage.read(offlineDatabaseName(accountId)))?.payload as { iv: Uint8Array }
  await offline.renew(created, snapshot("2026-10-27T08:00:00.000Z"))
  const second = (await storage.read(offlineDatabaseName(accountId)))?.payload as { iv: Uint8Array }
  assert.equal(first.iv.length, 12)
  assert.equal(second.iv.length, 12)
  assert.notDeepEqual(first.iv, second.iv)
  const ivs = calls.filter((call) => call.method === "encrypt").map((call) => (call.args[0] as AesGcmParams).iv)
  assert.equal(ivs.length, 2)
  const opened = await offline.unlock(accountId, "123456")
  assert.equal(opened.generatedAt, "2026-10-27T08:00:00.000Z")
})

test("lista blanca: sin notas, valoración, alias ni fechas de préstamo, historial de lectura, portadas, fotos ni procedencia", () => {
  const copy = snapshot()
  const text = JSON.stringify(copy)
  for (const forbidden of ["NOTA PRIVADA SECRETA", "PRESTATARIO ALIAS", "NOTA PRESTAMO", "SESION PRIVADA", "covers.openlibrary.org", "asset-privado", "foto-privada", "rating", "openlibrary.org/books", "Descripción", "2026-10-10", "isbnVerified"]) {
    assert.ok(!text.includes(forbidden), forbidden)
  }
  const [first, second] = copy.books
  assert.equal(first.onLoan, true)
  assert.equal(second.onLoan, false, "Un préstamo devuelto no se muestra como «Prestado»")
  assert.deepEqual(first.tagIds, ["t1"])
  assert.deepEqual(first.location, { locationId: "l2", shelfLabel: "Balda 3", position: 4 })
  assert.deepEqual(first.series, { seriesId: "se1", position: "2", volumeLabel: "II" })
  assert.equal(first.status, "reading")
  assert.equal(first.editionId, "e1")
  assert.equal(first.editionCopies, 2)
  assert.equal(second.isbn, null)
  assert.deepEqual(copy.locations[1], { id: "l2", name: "Estantería norte", kind: "bookcase", parentId: "l1" })
  assert.deepEqual(copy.series, [{ id: "se1", title: "Trilogía de la bruma" }])
  assert.deepEqual(parseOfflineSnapshot(JSON.parse(text)), copy)
})

test("TTL: vence a los 7 días de la última validación con conexión, bloquea sin borrar y se reabre al validar", async () => {
  const { offline, storage, time } = setup()
  const accountId = await offlineAccountId(USER_A)
  await offline.create(accountId, { secret: "123456", maskedEmail: "m", snapshot: snapshot() })
  time.advance(OFFLINE_COPY_TTL_MS)
  assert.equal((await offline.status(accountId)).state, "locked", "Justo en el límite sigue abierta")
  await offline.unlock(accountId, "123456")
  time.advance(1)
  const status = await offline.status(accountId)
  assert.equal(status.state, "expired")
  await assert.rejects(offline.unlock(accountId, "123456"), (error: OfflineCopyError) => error.code === "EXPIRED")
  assert.ok(await storage.read(offlineDatabaseName(accountId)), "La copia vencida no se borra")
  const meta = (await storage.read(offlineDatabaseName(accountId)))?.meta as OfflineCopyMeta
  assert.equal(meta.failedAttempts, 0, "Un intento sobre una copia vencida no cuenta como fallo")

  assert.equal(await offline.touchValidation(accountId), true)
  assert.equal((await offline.status(accountId)).state, "locked")
  await offline.unlock(accountId, "123456")
})

test("TTL: una validación en el futuro (reloj atrasado) cuenta como caducada", () => {
  const now = new Date("2026-10-26T09:00:00.000Z")
  assert.equal(isOfflineCopyExpired("2026-10-26T09:04:00.000Z", now), false)
  assert.equal(isOfflineCopyExpired("2026-10-26T10:00:00.000Z", now), true)
  assert.equal(isOfflineCopyExpired("no es una fecha", now), true)
})

test("intentos: el contador se reinicia al acertar y el décimo fallo seguido borra la copia", async () => {
  const { offline, storage } = setup()
  const accountId = await offlineAccountId(USER_A)
  await offline.create(accountId, { secret: "123456", maskedEmail: "m", snapshot: snapshot() })
  for (let i = 1; i <= 3; i++) {
    await assert.rejects(offline.unlock(accountId, "654321"), (error: OfflineCopyError) => error.code === "WRONG_SECRET" && error.attemptsLeft === 10 - i)
  }
  await offline.unlock(accountId, "123456")
  const status = await offline.status(accountId)
  assert.ok(status.state === "locked" && status.attemptsLeft === 10)

  for (let i = 1; i < OFFLINE_MAX_FAILED_UNLOCKS; i++) {
    await assert.rejects(offline.unlock(accountId, `00000${i}`), (error: OfflineCopyError) => error.code === "WRONG_SECRET")
  }
  const nine = await offline.status(accountId)
  assert.ok(nine.state === "locked" && nine.attemptsLeft === 1)
  await assert.rejects(offline.unlock(accountId, "999999"), (error: OfflineCopyError) => error.code === "WIPED")
  assert.equal(await storage.read(offlineDatabaseName(accountId)), null)
  assert.equal((await offline.status(accountId)).state, "none")
  await assert.rejects(offline.unlock(accountId, "123456"), (error: OfflineCopyError) => error.code === "NOT_FOUND")
})

test("intentos: el fallo queda anotado antes de derivar la clave (cerrar la pestaña no lo descuenta)", async () => {
  const storage = createMemoryOfflineStorage()
  const { offline, time } = setup({ storage })
  const accountId = await offlineAccountId(USER_A)
  await offline.create(accountId, { secret: "123456", maskedEmail: "m", snapshot: snapshot() })
  const writes: number[] = []
  const spy: OfflineStorage = { ...storage, async write(database, records) { writes.push(records.meta.failedAttempts); return storage.write(database, records) } }
  const watched = createOfflineLibrary({ storage: spy, now: time.now, iterations: TEST_ITERATIONS })
  await assert.rejects(watched.unlock(accountId, "000000"))
  assert.deepEqual(writes, [1])
  await watched.unlock(accountId, "123456")
  assert.deepEqual(writes, [1, 2, 0])
})

test("aislamiento: cada cuenta tiene su base y su clave; el PIN de A no abre la de B ni los datos se intercambian", async () => {
  const { offline, storage } = setup()
  const a = await offlineAccountId(USER_A)
  const b = await offlineAccountId(USER_B)
  assert.notEqual(a, b)
  assert.match(a, /^[0-9a-f]{64}$/)
  assert.ok(!a.includes(USER_A.replaceAll("-", "")))
  assert.notEqual(offlineDatabaseName(a), offlineDatabaseName(b))
  assert.ok(offlineDatabaseName(a).startsWith(OFFLINE_DB_PREFIX))

  await offline.create(a, { secret: "111111", maskedEmail: "a", snapshot: snapshot() })
  const bLibrary = buildOfflineSnapshot({ books: [book({ id: "c0000000-0000-4000-8000-0000000000bb", title: "Versos para un faro" })], shelves: [{ id: "sb", title: "B", book_count: 1 }] }, new Date("2026-10-26T08:00:00.000Z"))
  await offline.create(b, { secret: "222222", maskedEmail: "b", snapshot: bLibrary })

  await assert.rejects(offline.unlock(b, "111111"), (error: OfflineCopyError) => error.code === "WRONG_SECRET")
  const openedB = await offline.unlock(b, "222222")
  assert.deepEqual(openedB.snapshot.books.map((entry) => entry.title), ["Versos para un faro"])
  assert.equal((await offline.unlock(a, "111111")).snapshot.books[0].title, "El cuaderno de la bruma")

  // Copiar la base de A sobre la de B (mismo navegador) no abre nada: meta ligada a la cuenta y AAD por cuenta.
  const memory = storage as ReturnType<typeof createMemoryOfflineStorage>
  memory.databases.set(offlineDatabaseName(b), new Map(memory.databases.get(offlineDatabaseName(a))))
  assert.equal((await offline.status(b)).state, "corrupt")
  // Solo el contenido cifrado de A con la meta de B: falla la autenticación del cifrado.
  await offline.create(b, { secret: "222222", maskedEmail: "b", snapshot: bLibrary })
  memory.databases.get(offlineDatabaseName(b))?.set("payload", structuredClone(memory.databases.get(offlineDatabaseName(a))?.get("payload")))
  await assert.rejects(offline.unlock(b, "222222"), (error: OfflineCopyError) => error.code === "CORRUPT")

  await offline.remove(a)
  assert.equal((await offline.status(a)).state, "none")
  assert.notEqual((await offline.status(b)).state, "none", "Borrar la copia de A no toca la de B")
})

test("corrupción: cifrado alterado, meta o formato inválidos se ofrecen como copia dañada", async () => {
  const { offline, storage } = setup()
  const memory = storage as ReturnType<typeof createMemoryOfflineStorage>
  const accountId = await offlineAccountId(USER_A)
  const name = offlineDatabaseName(accountId)
  await offline.create(accountId, { secret: "123456", maskedEmail: "m", snapshot: snapshot() })

  const payload = memory.databases.get(name)?.get("payload") as { ciphertext: Uint8Array }
  payload.ciphertext[0] ^= 0xff
  await assert.rejects(offline.unlock(accountId, "123456"), (error: OfflineCopyError) => error.code === "CORRUPT")

  memory.databases.get(name)?.set("payload", { iv: new Uint8Array(3), ciphertext: new Uint8Array(4) })
  assert.equal((await offline.status(accountId)).state, "corrupt")

  memory.databases.get(name)?.set("meta", { format: 99 })
  assert.equal((await offline.status(accountId)).state, "corrupt")
  await assert.rejects(offline.unlock(accountId, "123456"), (error: OfflineCopyError) => error.code === "CORRUPT")
  await offline.remove(accountId)
  assert.equal((await offline.status(accountId)).state, "none")

  assert.throws(() => parseOfflineSnapshot({ format: 1, generatedAt: "2026-10-26T08:00:00.000Z", books: [{ id: 1 }], shelves: [], tags: [], locations: [], series: [] }), (error: OfflineCopyError) => error.code === "CORRUPT")
  assert.throws(() => parseOfflineSnapshot(null), (error: OfflineCopyError) => error.code === "CORRUPT")
})

test("cuota: QuotaExceededError se traduce a un mensaje claro y no deja copia", async () => {
  const quota: OfflineStorage = {
    ...createMemoryOfflineStorage(),
    async write() { throw new DOMException("No queda espacio", "QuotaExceededError") },
  }
  const { offline } = setup({ storage: quota })
  const accountId = await offlineAccountId(USER_A)
  await assert.rejects(offline.create(accountId, { secret: "123456", maskedEmail: "m", snapshot: snapshot() }), (error: OfflineCopyError) => {
    return error.code === "QUOTA" && /espacio/.test(error.message)
  })
  assert.equal((await offline.status(accountId)).state, "none")
})

test("una cuenta sin consentimiento no tiene base: consultar el estado no la crea", async () => {
  const storage = createMemoryOfflineStorage()
  const { offline } = setup({ storage })
  assert.equal((await offline.status(await offlineAccountId(USER_A))).state, "none")
  assert.equal(await offline.touchValidation(await offlineAccountId(USER_A)), false)
  assert.equal(storage.databases.size, 0)
})

test("borrado total: elimina todas las copias del dispositivo", async () => {
  const { offline, storage } = setup()
  await offline.create(await offlineAccountId(USER_A), { secret: "123456", maskedEmail: "m", snapshot: snapshot() })
  await offline.create(await offlineAccountId(USER_B), { secret: "123456", maskedEmail: "m", snapshot: snapshot() })
  assert.equal(await offline.removeAll(), 2)
  assert.deepEqual(await storage.list(), [])
})

test("correo enmascarado para el indicador", () => {
  assert.equal(maskEmail("lectora.a@biblib.test"), "l•••@b•••.test")
  assert.equal(maskEmail("Ñu@dominio.es"), "ñ•••@d•••.es")
  assert.equal(maskEmail(""), "cuenta sin correo")
})
