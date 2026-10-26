// U-EXP-08 · Copia de lectura sin conexión (contrato: docs/spec-pendientes/contratos-o15.md).
// Una copia opt-in, de solo lectura y por cuenta, cifrada en IndexedDB con Web Crypto:
// PBKDF2-HMAC-SHA-256 (600 000 iteraciones, sal de 16 bytes) deriva una clave AES-KW que envuelve una
// clave de datos AES-GCM de 256 bits aleatoria; cada escritura usa un IV nuevo de 12 bytes. Sin
// criptografía propia, sin `localStorage` para datos y sin escrituras pendientes de sincronizar.
// El cifrado reduce la exposición en reposo; no protege frente a código que se ejecute en la página
// mientras la copia está abierta.

import type { Book, LibraryData } from "./types"
import type { LocationKind } from "./product/contracts"

/** Plazo de validez desde la última validación con conexión. Constante única del TTL de la copia. */
export const OFFLINE_COPY_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** Iteraciones de PBKDF2 en producción. Solo las pruebas las reducen, inyectándolas en `createOfflineLibrary`. */
export const OFFLINE_KDF_ITERATIONS = 600_000
export const OFFLINE_SALT_BYTES = 16
export const OFFLINE_IV_BYTES = 12
/** Desbloqueos fallidos seguidos tras los que se borra la copia de este dispositivo. */
export const OFFLINE_MAX_FAILED_UNLOCKS = 10
export const OFFLINE_PIN_MIN_DIGITS = 6
export const OFFLINE_PHRASE_MIN_CHARS = 8
export const OFFLINE_SECRET_MAX_CHARS = 128
/** Tamaño máximo de la copia cifrada; por encima se rechaza con un aviso de espacio. */
export const OFFLINE_MAX_SNAPSHOT_BYTES = 25 * 1024 * 1024
/** Prefijo de las bases IndexedDB de la copia; el worker de limpieza borra todas las que lo llevan. */
export const OFFLINE_DB_PREFIX = "biblib-offline-"
/** Clave de `localStorage` con la cuenta (identificador opaco) que vio este dispositivo por última vez con conexión. */
export const OFFLINE_ACCOUNT_POINTER_KEY = "biblib-offline-cuenta"
export const OFFLINE_FORMAT = 1
/** Tolerancia de reloj: una validación «en el futuro» por encima de esto se trata como caducada. */
const CLOCK_SKEW_MS = 5 * 60 * 1000
const STORE_NAME = "copia"

// ── Contenido de la copia ───────────────────────────────────────────────────────────────────────────

export interface OfflineBook {
  id: string
  title: string
  subtitle?: string
  authors: string[]
  publishers: string[]
  publishDate: string
  pages: number
  isbn: string | null
  status: Book["status"]
  shelfId: string
  editionId?: string
  /** Ejemplares de la cuenta que comparten la edición. */
  editionCopies?: number
  workTitle?: string
  language?: string
  series?: { seriesId: string; position?: string; volumeLabel?: string }
  tagIds: string[]
  location?: { locationId: string; shelfLabel?: string; position?: number }
  /** Solo «Prestado»: nunca el alias de quien lo tiene ni las fechas del préstamo. */
  onLoan: boolean
}

export interface OfflineSnapshot {
  format: typeof OFFLINE_FORMAT
  /** Momento en que el servidor leyó la colección (la «Copia del …»). */
  generatedAt: string
  books: OfflineBook[]
  shelves: { id: string; title: string; isDefault: boolean; bookCount: number }[]
  tags: { id: string; name: string }[]
  locations: { id: string; name: string; kind: LocationKind; parentId: string | null }[]
  series: { id: string; title: string }[]
}

/**
 * Proyección de la colección a la copia de lectura con lista blanca de campos. Quedan fuera las notas y la
 * valoración, los alias y fechas de préstamo, el historial de lectura, las portadas e imágenes, las evidencias
 * y la procedencia bibliográfica.
 */
export function buildOfflineSnapshot(data: LibraryData, generatedAt: Date): OfflineSnapshot {
  return {
    format: OFFLINE_FORMAT,
    generatedAt: generatedAt.toISOString(),
    books: data.books.map((book) => ({
      id: book.id,
      title: book.title,
      ...(book.subtitle ? { subtitle: book.subtitle } : {}),
      authors: book.authors.map((author) => author.name),
      publishers: (book.publishers ?? []).map((publisher) => publisher.name),
      publishDate: book.publish_date,
      pages: book.number_of_pages,
      isbn: book.isbn,
      status: book.status,
      shelfId: book.shelf_id,
      ...(book.edition ? {
        editionId: book.edition.id,
        ...(book.edition.copies ? { editionCopies: book.edition.copies } : {}),
        ...(book.edition.workTitle ? { workTitle: book.edition.workTitle } : {}),
        ...(book.edition.language ? { language: book.edition.language } : {}),
        ...(book.edition.series ? { series: {
          seriesId: book.edition.series.seriesId,
          ...(book.edition.series.position ? { position: book.edition.series.position } : {}),
          ...(book.edition.series.volumeLabel ? { volumeLabel: book.edition.series.volumeLabel } : {}),
        } } : {}),
      } : {}),
      tagIds: book.personal?.tagIds ?? [],
      ...(book.location ? { location: {
        locationId: book.location.locationId,
        ...(book.location.shelfLabel ? { shelfLabel: book.location.shelfLabel } : {}),
        ...(book.location.position !== undefined ? { position: book.location.position } : {}),
      } } : {}),
      onLoan: (book.loans ?? []).some((loan) => loan.returnedOn === undefined),
    })),
    shelves: data.shelves.map((shelf) => ({ id: shelf.id, title: shelf.title, isDefault: Boolean(shelf.isDefault), bookCount: shelf.book_count })),
    tags: (data.tags ?? []).map((tag) => ({ id: tag.id, name: tag.name })),
    locations: (data.locations ?? []).map((location) => ({ id: location.id, name: location.name, kind: location.kind, parentId: location.parentId })),
    series: (data.series ?? []).map((series) => ({ id: series.id, title: series.title })),
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const isString = (value: unknown): value is string => typeof value === "string"
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString)
const BOOK_STATUSES: readonly string[] = ["read", "reading", "unread", "to-read"]

/** Comprueba la forma de una copia descifrada; cualquier desviación es una copia dañada. */
export function parseOfflineSnapshot(value: unknown): OfflineSnapshot {
  const fail = (): never => { throw new OfflineCopyError("CORRUPT") }
  if (!isRecord(value) || value.format !== OFFLINE_FORMAT || !isString(value.generatedAt) || Number.isNaN(Date.parse(value.generatedAt))) fail()
  const { books, shelves, tags, locations, series } = value as Record<string, unknown>
  if (!Array.isArray(books) || !Array.isArray(shelves) || !Array.isArray(tags) || !Array.isArray(locations) || !Array.isArray(series)) return fail()
  for (const book of books as unknown[]) {
    if (!isRecord(book) || !isString(book.id) || !isString(book.title) || !isStringArray(book.authors) || !isStringArray(book.publishers)
      || !isString(book.publishDate) || typeof book.pages !== "number" || !(book.isbn === null || isString(book.isbn))
      || !isString(book.status) || !BOOK_STATUSES.includes(book.status) || !isString(book.shelfId) || !isStringArray(book.tagIds) || typeof book.onLoan !== "boolean") fail()
  }
  for (const entry of [shelves, tags, locations, series].flat() as unknown[]) if (!isRecord(entry) || !isString(entry.id)) fail()
  return value as unknown as OfflineSnapshot
}

// ── Secreto local, cuenta y textos ──────────────────────────────────────────────────────────────────

export type OfflineSecretKind = "pin" | "frase"

/** PIN de al menos 6 dígitos o frase de al menos 8 caracteres (máximo 128). */
export function validateOfflineSecret(secret: string): { ok: true; kind: OfflineSecretKind } | { ok: false; message: string } {
  const length = [...secret].length
  if (length > OFFLINE_SECRET_MAX_CHARS) return { ok: false, message: `El PIN o la frase no pueden superar ${OFFLINE_SECRET_MAX_CHARS} caracteres.` }
  if (/^\d+$/.test(secret)) {
    return length >= OFFLINE_PIN_MIN_DIGITS ? { ok: true, kind: "pin" } : { ok: false, message: `El PIN debe tener al menos ${OFFLINE_PIN_MIN_DIGITS} dígitos.` }
  }
  if (length < OFFLINE_PHRASE_MIN_CHARS) return { ok: false, message: `Usa un PIN de al menos ${OFFLINE_PIN_MIN_DIGITS} dígitos o una frase de al menos ${OFFLINE_PHRASE_MIN_CHARS} caracteres.` }
  if (secret.trim() !== secret) return { ok: false, message: "La frase no puede empezar ni terminar con espacios." }
  return { ok: true, kind: "frase" }
}

/** Correo enmascarado para el indicador: primera letra del usuario y del dominio, y la extensión («n•••@h•••.es»). */
export function maskEmail(email: string): string {
  const [user = "", domain = ""] = email.trim().toLowerCase().split("@")
  if (!user || !domain) return "cuenta sin correo"
  const dot = domain.lastIndexOf(".")
  const host = dot > 0 ? domain.slice(0, dot) : domain
  const suffix = dot > 0 ? domain.slice(dot) : ""
  return `${[...user][0]}•••@${[...host][0]}•••${suffix}`
}

const encoder = new TextEncoder()
const toHex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("")

/** Identificador opaco de la cuenta: SHA-256 del id de usuario con un dominio propio. No revela el id. */
export async function offlineAccountId(userId: string, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<string> {
  if (!userId) throw new OfflineCopyError("NOT_FOUND")
  return toHex(await subtle.digest("SHA-256", encoder.encode(`biblib-offline:v${OFFLINE_FORMAT}:${userId}`)))
}

/** Nombre de la base IndexedDB de una cuenta, derivado del identificador opaco. Nunca se comparte entre cuentas. */
export function offlineDatabaseName(accountId: string): string {
  if (!/^[0-9a-f]{64}$/.test(accountId)) throw new OfflineCopyError("NOT_FOUND")
  return `${OFFLINE_DB_PREFIX}${accountId.slice(0, 32)}`
}

export const OFFLINE_DATE_FORMAT = new Intl.DateTimeFormat("es-ES", { dateStyle: "long", timeStyle: "short" })
export const offlineDate = (iso: string) => OFFLINE_DATE_FORMAT.format(new Date(iso))

// ── Errores ─────────────────────────────────────────────────────────────────────────────────────────

export type OfflineCopyErrorCode = "INVALID_SECRET" | "WRONG_SECRET" | "WIPED" | "EXPIRED" | "NOT_FOUND" | "CORRUPT" | "QUOTA" | "TOO_LARGE" | "UNSUPPORTED"

const ERROR_MESSAGES: Record<OfflineCopyErrorCode, string> = {
  INVALID_SECRET: "El PIN o la frase no cumplen los requisitos.",
  WRONG_SECRET: "El PIN o la frase no son correctos.",
  WIPED: `Se ha borrado la copia de este dispositivo tras ${OFFLINE_MAX_FAILED_UNLOCKS} intentos fallidos seguidos. Puedes volver a descargarla con conexión desde Ajustes.`,
  EXPIRED: "La copia está bloqueada porque han pasado más de 7 días desde la última validación con conexión. Conéctate e inicia sesión para desbloquearla.",
  NOT_FOUND: "No hay copia de lectura de esta cuenta en este dispositivo.",
  CORRUPT: "La copia de este dispositivo está dañada o no se puede leer. Bórrala y vuelve a descargarla con conexión.",
  QUOTA: "El navegador no tiene espacio suficiente para guardar la copia. Libera espacio de almacenamiento del sitio o del dispositivo y vuelve a intentarlo.",
  TOO_LARGE: "La colección es demasiado grande para guardarla como copia de lectura en este dispositivo.",
  UNSUPPORTED: "Este navegador no permite guardar una copia cifrada (faltan IndexedDB o Web Crypto).",
}

export class OfflineCopyError extends Error {
  constructor(readonly code: OfflineCopyErrorCode, message = ERROR_MESSAGES[code], readonly attemptsLeft?: number) {
    super(message)
    this.name = "OfflineCopyError"
  }
}

function isQuotaError(error: unknown): boolean {
  if (!isRecord(error) && !(error instanceof Error)) return false
  const name = (error as { name?: unknown }).name
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED"
}

// ── Almacenamiento ──────────────────────────────────────────────────────────────────────────────────

export interface OfflineCopyMeta {
  format: typeof OFFLINE_FORMAT
  accountId: string
  maskedEmail: string
  generatedAt: string
  /** Última validación con conexión y sesión de esta cuenta. El TTL corre desde aquí. */
  validatedAt: string
  secretKind: OfflineSecretKind
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: Uint8Array<ArrayBuffer> }
  wrap: "AES-KW"
  wrappedKey: Uint8Array<ArrayBuffer>
  failedAttempts: number
}

export interface OfflineCopyPayload {
  iv: Uint8Array<ArrayBuffer>
  ciphertext: Uint8Array<ArrayBuffer>
}

/** Almacenamiento por base: IndexedDB en el navegador y memoria en las pruebas. */
export interface OfflineStorage {
  /** Lee sin crear la base: una cuenta sin consentimiento nunca tiene base. */
  read(database: string): Promise<{ meta?: unknown; payload?: unknown } | null>
  write(database: string, records: { meta: OfflineCopyMeta; payload?: OfflineCopyPayload }): Promise<void>
  remove(database: string): Promise<void>
  /** Bases de copia existentes (para la limpieza total). */
  list(): Promise<string[]>
}

export function createMemoryOfflineStorage(): OfflineStorage & { databases: Map<string, Map<string, unknown>> } {
  const databases = new Map<string, Map<string, unknown>>()
  return {
    databases,
    async read(database) {
      const records = databases.get(database)
      return records ? { meta: structuredClone(records.get("meta")), payload: structuredClone(records.get("payload")) } : null
    },
    async write(database, { meta, payload }) {
      const records = databases.get(database) ?? new Map<string, unknown>()
      records.set("meta", structuredClone(meta))
      if (payload) records.set("payload", structuredClone(payload))
      databases.set(database, records)
    },
    async remove(database) { databases.delete(database) },
    async list() { return [...databases.keys()] },
  }
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = (event) => { event.preventDefault(); reject(request.error) }
  })
}

/** Abre la base; con `create: false` no la crea (aborta la creación si aún no existía). */
function openDatabase(name: string, create: boolean): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    let refused = false
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = (event) => {
      if (!create && event.oldVersion === 0) { refused = true; request.transaction?.abort(); return }
      request.result.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => db.close()
      resolve(db)
    }
    request.onerror = (event) => {
      event.preventDefault()
      if (refused) resolve(null)
      else reject(request.error)
    }
  })
}

export function createIndexedDbOfflineStorage(): OfflineStorage {
  if (typeof indexedDB === "undefined") throw new OfflineCopyError("UNSUPPORTED")
  return {
    async read(database) {
      if (typeof indexedDB.databases === "function" && !(await indexedDB.databases()).some((entry) => entry.name === database)) return null
      const db = await openDatabase(database, false)
      if (!db) return null
      try {
        if (!db.objectStoreNames.contains(STORE_NAME)) return {}
        const store = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME)
        const [meta, payload] = await Promise.all([idbRequest(store.get("meta")), idbRequest(store.get("payload"))])
        return { meta, payload }
      } finally { db.close() }
    },
    async write(database, { meta, payload }) {
      const db = await openDatabase(database, true)
      if (!db) throw new OfflineCopyError("UNSUPPORTED")
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction(STORE_NAME, "readwrite")
          const store = transaction.objectStore(STORE_NAME)
          store.put(meta, "meta")
          if (payload) store.put(payload, "payload")
          transaction.oncomplete = () => resolve()
          transaction.onerror = (event) => { event.preventDefault() }
          transaction.onabort = () => reject(transaction.error ?? new OfflineCopyError("QUOTA"))
        })
      } finally { db.close() }
    },
    remove(database) {
      return new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(database)
        request.onsuccess = () => resolve()
        request.onerror = (event) => { event.preventDefault(); reject(request.error) }
      })
    },
    async list() {
      if (typeof indexedDB.databases !== "function") return []
      return (await indexedDB.databases()).map((entry) => entry.name ?? "").filter((name) => name.startsWith(OFFLINE_DB_PREFIX))
    },
  }
}

// ── Servicio ────────────────────────────────────────────────────────────────────────────────────────

export type OfflineCopyStatus =
  | { state: "none" }
  | { state: "corrupt" }
  | { state: "locked" | "expired"; maskedEmail: string; generatedAt: string; validatedAt: string; expiresAt: string; attemptsLeft: number }

/** Copia abierta en memoria: la clave de datos no es extraíble y nunca se persiste en claro. */
export interface OfflineCopySession {
  accountId: string
  maskedEmail: string
  generatedAt: string
  validatedAt: string
  expiresAt: string
  snapshot: OfflineSnapshot
  readonly key: CryptoKey
}

export interface OfflineLibraryOptions {
  storage: OfflineStorage
  now?: () => Date
  /** Solo pruebas: por defecto `OFFLINE_KDF_ITERATIONS`. */
  iterations?: number
  subtle?: SubtleCrypto
  random?: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>
}

const addTtl = (iso: string) => new Date(Date.parse(iso) + OFFLINE_COPY_TTL_MS).toISOString()

/** Caducada si pasó el TTL desde la última validación o si esa validación está en el futuro (reloj movido). */
export function isOfflineCopyExpired(validatedAt: string, now: Date): boolean {
  const validated = Date.parse(validatedAt)
  if (Number.isNaN(validated)) return true
  return now.getTime() - validated > OFFLINE_COPY_TTL_MS || validated - now.getTime() > CLOCK_SKEW_MS
}

function parseMeta(value: unknown, accountId: string): OfflineCopyMeta {
  const meta = value as OfflineCopyMeta
  const bytes = (entry: unknown, length?: number) => entry instanceof Uint8Array && (length === undefined || entry.length === length)
  if (!isRecord(value) || meta.format !== OFFLINE_FORMAT || meta.accountId !== accountId || !isString(meta.maskedEmail)
    || !isString(meta.generatedAt) || !isString(meta.validatedAt) || !isRecord(meta.kdf) || meta.kdf.name !== "PBKDF2" || meta.kdf.hash !== "SHA-256"
    || !Number.isInteger(meta.kdf.iterations) || meta.kdf.iterations < 1 || !bytes(meta.kdf.salt, OFFLINE_SALT_BYTES) || meta.wrap !== "AES-KW"
    || !bytes(meta.wrappedKey, 40) || !Number.isInteger(meta.failedAttempts) || meta.failedAttempts < 0) throw new OfflineCopyError("CORRUPT")
  return meta
}

function parsePayload(value: unknown): OfflineCopyPayload {
  if (!isRecord(value) || !(value.iv instanceof Uint8Array) || value.iv.length !== OFFLINE_IV_BYTES || !(value.ciphertext instanceof Uint8Array)) throw new OfflineCopyError("CORRUPT")
  return value as unknown as OfflineCopyPayload
}

export function createOfflineLibrary(options: OfflineLibraryOptions) {
  const { storage } = options
  const now = options.now ?? (() => new Date())
  const iterations = options.iterations ?? OFFLINE_KDF_ITERATIONS
  const subtle = options.subtle ?? globalThis.crypto?.subtle
  const random = options.random ?? ((bytes: Uint8Array<ArrayBuffer>) => globalThis.crypto.getRandomValues(bytes))
  if (!subtle) throw new OfflineCopyError("UNSUPPORTED")

  /** Datos adicionales autenticados: el cifrado queda ligado a la cuenta y al formato. */
  const aad = (accountId: string) => encoder.encode(`biblib-offline:${OFFLINE_FORMAT}:${accountId}`)

  async function deriveWrappingKey(secret: string, salt: Uint8Array<ArrayBuffer>, rounds: number): Promise<CryptoKey> {
    const base = await subtle!.importKey("raw", encoder.encode(secret.normalize("NFC")), "PBKDF2", false, ["deriveKey"])
    return subtle!.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: rounds }, base, { name: "AES-KW", length: 256 }, false, ["wrapKey", "unwrapKey"])
  }

  const unwrapDataKey = (wrapped: Uint8Array<ArrayBuffer>, wrappingKey: CryptoKey) =>
    subtle!.unwrapKey("raw", wrapped, wrappingKey, "AES-KW", { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])

  async function encryptSnapshot(accountId: string, key: CryptoKey, snapshot: OfflineSnapshot): Promise<OfflineCopyPayload> {
    const plain = encoder.encode(JSON.stringify(snapshot))
    if (plain.byteLength > OFFLINE_MAX_SNAPSHOT_BYTES) throw new OfflineCopyError("TOO_LARGE")
    const iv = random(new Uint8Array(OFFLINE_IV_BYTES))
    const ciphertext = new Uint8Array(await subtle!.encrypt({ name: "AES-GCM", iv, additionalData: aad(accountId) }, key, plain))
    return { iv, ciphertext }
  }

  async function write(accountId: string, records: { meta: OfflineCopyMeta; payload?: OfflineCopyPayload }): Promise<void> {
    try { await storage.write(offlineDatabaseName(accountId), records) } catch (error) {
      if (error instanceof OfflineCopyError) throw error
      if (isQuotaError(error)) throw new OfflineCopyError("QUOTA")
      throw error
    }
  }

  async function readCopy(accountId: string): Promise<{ meta: OfflineCopyMeta; payload: OfflineCopyPayload } | null> {
    const stored = await storage.read(offlineDatabaseName(accountId))
    if (!stored) return null
    return { meta: parseMeta(stored.meta, accountId), payload: parsePayload(stored.payload) }
  }

  const session = (meta: OfflineCopyMeta, snapshot: OfflineSnapshot, key: CryptoKey): OfflineCopySession => ({
    accountId: meta.accountId, maskedEmail: meta.maskedEmail, generatedAt: meta.generatedAt, validatedAt: meta.validatedAt,
    expiresAt: addTtl(meta.validatedAt), snapshot, key,
  })

  return {
    async status(accountId: string): Promise<OfflineCopyStatus> {
      let copy
      try { copy = await readCopy(accountId) } catch (error) {
        if (error instanceof OfflineCopyError && error.code === "CORRUPT") return { state: "corrupt" }
        throw error
      }
      if (!copy) return { state: "none" }
      const { meta } = copy
      return {
        state: isOfflineCopyExpired(meta.validatedAt, now()) ? "expired" : "locked",
        maskedEmail: meta.maskedEmail, generatedAt: meta.generatedAt, validatedAt: meta.validatedAt, expiresAt: addTtl(meta.validatedAt),
        attemptsLeft: Math.max(0, OFFLINE_MAX_FAILED_UNLOCKS - meta.failedAttempts),
      }
    },

    /** Crea (o sustituye) la copia de la cuenta con un secreto nuevo. Solo con conexión: la copia la entrega el servidor. */
    async create(accountId: string, input: { secret: string; maskedEmail: string; snapshot: OfflineSnapshot }): Promise<OfflineCopySession> {
      const secret = validateOfflineSecret(input.secret)
      if (!secret.ok) throw new OfflineCopyError("INVALID_SECRET", secret.message)
      const snapshot = parseOfflineSnapshot(input.snapshot)
      const salt = random(new Uint8Array(OFFLINE_SALT_BYTES))
      const wrappingKey = await deriveWrappingKey(input.secret, salt, iterations)
      // La clave de datos solo es extraíble el instante necesario para envolverla; la sesión usa la desenvuelta.
      const generated = await subtle!.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"])
      const wrappedKey = new Uint8Array(await subtle!.wrapKey("raw", generated, wrappingKey, "AES-KW"))
      const key = await unwrapDataKey(wrappedKey, wrappingKey)
      const meta: OfflineCopyMeta = {
        format: OFFLINE_FORMAT, accountId, maskedEmail: input.maskedEmail, generatedAt: snapshot.generatedAt, validatedAt: now().toISOString(),
        secretKind: secret.kind, kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt }, wrap: "AES-KW", wrappedKey, failedAttempts: 0,
      }
      await write(accountId, { meta, payload: await encryptSnapshot(accountId, key, snapshot) })
      return session(meta, snapshot, key)
    },

    /**
     * Abre la copia. El intento se anota antes de derivar la clave (cerrar la pestaña no lo descuenta) y se
     * reinicia al acertar; el décimo fallo seguido borra la copia de este dispositivo.
     */
    async unlock(accountId: string, secret: string): Promise<OfflineCopySession> {
      const copy = await readCopy(accountId)
      if (!copy) throw new OfflineCopyError("NOT_FOUND")
      const { meta, payload } = copy
      if (isOfflineCopyExpired(meta.validatedAt, now())) throw new OfflineCopyError("EXPIRED")
      if (meta.failedAttempts >= OFFLINE_MAX_FAILED_UNLOCKS) {
        await storage.remove(offlineDatabaseName(accountId))
        throw new OfflineCopyError("WIPED")
      }
      const attempt = { ...meta, failedAttempts: meta.failedAttempts + 1 }
      await write(accountId, { meta: attempt })
      let key: CryptoKey
      try {
        key = await unwrapDataKey(meta.wrappedKey, await deriveWrappingKey(secret, meta.kdf.salt, meta.kdf.iterations))
      } catch {
        if (attempt.failedAttempts >= OFFLINE_MAX_FAILED_UNLOCKS) {
          await storage.remove(offlineDatabaseName(accountId))
          throw new OfflineCopyError("WIPED")
        }
        const attemptsLeft = OFFLINE_MAX_FAILED_UNLOCKS - attempt.failedAttempts
        throw new OfflineCopyError("WRONG_SECRET", `El PIN o la frase no son correctos. Te quedan ${attemptsLeft} ${attemptsLeft === 1 ? "intento" : "intentos"} antes de que se borre la copia de este dispositivo.`, attemptsLeft)
      }
      await write(accountId, { meta: { ...meta, failedAttempts: 0 } })
      let snapshot: OfflineSnapshot
      try {
        const plain = await subtle!.decrypt({ name: "AES-GCM", iv: payload.iv, additionalData: aad(accountId) }, key, payload.ciphertext)
        snapshot = parseOfflineSnapshot(JSON.parse(new TextDecoder().decode(plain)))
      } catch { throw new OfflineCopyError("CORRUPT") }
      return session({ ...meta, failedAttempts: 0 }, snapshot, key)
    },

    /** Renueva con conexión: datos nuevos del servidor, IV nuevo y validación al momento. Exige la copia abierta. */
    async renew(open: OfflineCopySession, snapshot: OfflineSnapshot): Promise<OfflineCopySession> {
      const copy = await readCopy(open.accountId)
      if (!copy) throw new OfflineCopyError("NOT_FOUND")
      const parsed = parseOfflineSnapshot(snapshot)
      const meta = { ...copy.meta, generatedAt: parsed.generatedAt, validatedAt: now().toISOString(), failedAttempts: 0 }
      await write(open.accountId, { meta, payload: await encryptSnapshot(open.accountId, open.key, parsed) })
      return session(meta, parsed, open.key)
    },

    /** Validación con conexión y sesión de esta cuenta: reinicia el TTL sin tocar los datos ni el secreto. */
    async touchValidation(accountId: string): Promise<boolean> {
      let copy
      try { copy = await readCopy(accountId) } catch { return false }
      if (!copy) return false
      await write(accountId, { meta: { ...copy.meta, validatedAt: now().toISOString() } })
      return true
    },

    remove(accountId: string): Promise<void> {
      return storage.remove(offlineDatabaseName(accountId))
    },

    /** Borra todas las copias del dispositivo (worker de limpieza y borrado manual). */
    async removeAll(): Promise<number> {
      const names = await storage.list()
      await Promise.all(names.map((name) => storage.remove(name)))
      return names.length
    },
  }
}

export type OfflineLibrary = ReturnType<typeof createOfflineLibrary>

let browserLibrary: OfflineLibrary | null = null
/** Servicio del navegador (IndexedDB y Web Crypto). Lanza `UNSUPPORTED` si faltan. */
export function browserOfflineLibrary(): OfflineLibrary {
  browserLibrary ??= createOfflineLibrary({ storage: createIndexedDbOfflineStorage() })
  return browserLibrary
}

// ── Cuenta vista por última vez con conexión ────────────────────────────────────────────────────────

export function readOfflineAccountPointer(): string | null {
  try {
    const value = window.localStorage.getItem(OFFLINE_ACCOUNT_POINTER_KEY)
    return value && /^[0-9a-f]{64}$/.test(value) ? value : null
  } catch { return null }
}

export function writeOfflineAccountPointer(accountId: string | null): void {
  try {
    if (accountId) window.localStorage.setItem(OFFLINE_ACCOUNT_POINTER_KEY, accountId)
    else window.localStorage.removeItem(OFFLINE_ACCOUNT_POINTER_KEY)
  } catch { /* Sin almacenamiento local: la vista sin conexión pedirá conectarse. */ }
}

/** Cierre de sesión con conexión: borra la clave envuelta y los datos de esa cuenta en este dispositivo. */
export async function purgeOfflineCopy(userId: string): Promise<void> {
  const accountId = await offlineAccountId(userId)
  if (readOfflineAccountPointer() === accountId) writeOfflineAccountPointer(null)
  await browserOfflineLibrary().remove(accountId)
}
