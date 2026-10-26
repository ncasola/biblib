import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"

// Atestación de sesión de U-FIX-02 (T3). El proxy verifica la sesión con GoTrue (`getUser()`) y, si es
// válida, añade a la petición reenviada esta cabecera firmada. La acción de la MISMA petición la acepta en
// lugar de una segunda llamada a GoTrue solo si la firma (HMAC-SHA256 con una clave aleatoria de este
// proceso) cubre el usuario, el hash del access token que lleva la petición y el nonce de la petición, y si
// tiene ≤ 30 s. No transporta el usuario a ciegas: la acción además verifica el JWT localmente y exige que
// su `sub` coincida. Cualquier fallo o ausencia vuelve a `getUser()`; nunca concede acceso por sí sola.
// Sin dependencias de Next para poder probarla en aislamiento. Decisión y límites: docs/seguridad.md.

/** Cabecera de petición interna. El proxy elimina siempre la que envíe el cliente. */
export const SESSION_ATTESTATION_HEADER = "x-biblib-session-attestation"
export const ATTESTATION_MAX_AGE_MS = 30_000
/** Holgura ante relojes del mismo proceso que avancen de forma no monótona. */
const FUTURE_SKEW_MS = 1_000
const VERSION = "v1"
const KEY = Symbol.for("biblib.session-attestation.key")

type KeyHolder = typeof globalThis & { [KEY]?: Buffer }

/** Secreto mínimo para derivar una clave compartida; uno más corto se ignora y se usa la clave del proceso. */
export const ATTESTATION_SECRET_MIN_LENGTH = 32

/**
 * Clave de firma. Con `BIBLIB_SESSION_ATTESTATION_SECRET` (servidor, ≥ 32 caracteres) se deriva de él, para que
 * el proxy y las funciones la compartan cuando el alojamiento los ejecuta en procesos distintos (Vercel). Sin él,
 * aleatoria al primer uso del proceso. En ambos casos solo vive en memoria; nunca se registra, exporta ni persiste.
 */
export function attestationKey(secret = process.env.BIBLIB_SESSION_ATTESTATION_SECRET): Buffer | null {
  const value = secret?.trim()
  return value && value.length >= ATTESTATION_SECRET_MIN_LENGTH ? createHash("sha256").update(`biblib.session-attestation.v1|${value}`).digest() : null
}

function processKey(): Buffer {
  const holder = globalThis as KeyHolder
  holder[KEY] ??= attestationKey() ?? randomBytes(32)
  return holder[KEY]
}

const tokenHash = (accessToken: string) => createHash("sha256").update(accessToken).digest("base64url")
const mac = (key: Buffer, issuedAt: number, nonce: string, userId: string, accessToken: string) =>
  createHmac("sha256", key).update(`${VERSION}|${issuedAt}|${nonce}|${userId}|${tokenHash(accessToken)}`).digest()

export interface AttestationInput {
  userId: string
  accessToken: string
  /** Nonce único de la petición (el de la CSP, `x-nonce`), que el proxy fija en cada petición reenviada. */
  nonce: string
  now?: number
  /** Solo para pruebas: simula la clave de otro proceso. */
  key?: Buffer
}

export function createSessionAttestation({ userId, accessToken, nonce, now = Date.now(), key = processKey() }: AttestationInput): string {
  const issuedAt = Math.trunc(now)
  const nonceText = Buffer.from(nonce, "utf8").toString("base64url")
  return [VERSION, String(issuedAt), nonceText, userId, mac(key, issuedAt, nonce, userId, accessToken).toString("base64url")].join(".")
}

export type AttestationResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "missing" | "malformed" | "expired" | "nonce" | "signature" }

export interface AttestationExpectation {
  /** Access token de las cookies de esta petición. */
  accessToken: string
  /** `x-nonce` de esta petición; sin él, la atestación no puede ligarse a la petición. */
  nonce: string | null | undefined
  now?: number
  key?: Buffer
}

export function verifySessionAttestation(value: string | null | undefined, { accessToken, nonce, now = Date.now(), key = processKey() }: AttestationExpectation): AttestationResult {
  if (!value) return { ok: false, reason: "missing" }
  const parts = value.split(".")
  if (parts.length !== 5 || parts[0] !== VERSION || !/^\d{1,16}$/.test(parts[1]) || !/^[0-9a-f-]{36}$/i.test(parts[3]) || !accessToken) return { ok: false, reason: "malformed" }
  const issuedAt = Number(parts[1])
  if (now - issuedAt > ATTESTATION_MAX_AGE_MS || issuedAt - now > FUTURE_SKEW_MS) return { ok: false, reason: "expired" }
  const attestedNonce = Buffer.from(parts[2], "base64url").toString("utf8")
  if (!nonce || attestedNonce !== nonce) return { ok: false, reason: "nonce" }
  const expected = mac(key, issuedAt, nonce, parts[3], accessToken)
  const received = Buffer.from(parts[4], "base64url")
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return { ok: false, reason: "signature" }
  return { ok: true, userId: parts[3] }
}

/** `sub` del payload de un JWT, sin verificar: solo para comprobar coherencia antes de atestar. */
export function unverifiedSubject(accessToken: string): string | null {
  try {
    const payload: unknown = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8"))
    return payload && typeof payload === "object" && "sub" in payload && typeof payload.sub === "string" ? payload.sub : null
  } catch {
    return null
  }
}

/**
 * Memo por petición: `request` es un objeto que vive exactamente una petición (en la app, el de `headers()`)
 * y `key` el access token. Peticiones distintas nunca comparten resultado (WeakMap por objeto) y, dentro de
 * una petición, tokens distintos tampoco. Sustituye a `cache()` de React, que no memoiza dentro de una
 * Server Action: allí no hay una petición Flight activa y cada llamada recibe una caché nueva.
 */
export function createRequestMemo<T>() {
  const byRequest = new WeakMap<object, Map<string, Promise<T>>>()
  return (request: object, key: string, compute: () => Promise<T>): Promise<T> => {
    let entries = byRequest.get(request)
    if (!entries) {
      entries = new Map()
      byRequest.set(request, entries)
    }
    let pending = entries.get(key)
    if (!pending) {
      pending = compute()
      entries.set(key, pending)
    }
    return pending
  }
}
