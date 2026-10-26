import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs"
import path from "node:path"
import { canonical } from "../db/plan.mjs"
import { BiblibError, EXIT } from "./exit-codes.mjs"
import { localPath } from "./local-path.mjs"

// Contrato de archivos del respaldo administrativo local (U-OPS-02): rutas, manifiesto,
// hashes y cifrado opcional. Sin Docker ni red: lo usan backup, restore, verify y sus pruebas.

export const BACKUP_KIND = "biblib-admin-backup"
export const MANIFEST_FILE = "backup.json"
export const DEFAULT_BACKUPS_DIR = path.join(".biblib", "backups")
export const ENCRYPTION = Object.freeze({ algorithm: "aes-256-gcm", magic: Buffer.from("BIBLIBENC1"), ivBytes: 12, tagBytes: 16 })
// Auth se respalda solo con datos de identidad. Sesiones, tokens de un solo uso, flujos OAuth,
// auditoría y configuración de proveedores quedan fuera por diseño (ver docs/recuperacion.md).
export const AUTH_TABLES = Object.freeze(["users", "identities", "mfa_factors", "webauthn_credentials"])

const fail = (code, message, phase = "respaldo") => { throw new BiblibError(code, phase, message) }
export const sha256 = (value) => createHash("sha256").update(value).digest("hex")
const inside = (parent, child) => { const relative = path.relative(parent, child); return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative) }
const same = (a, b) => path.relative(a, b) === ""

/** `20261023T124501Z-scratch-a1b2c3`: ordenable, sin datos de la cuenta. */
export function newBackupId(profile, now = new Date(), random = randomBytes(3).toString("hex")) {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(profile) || !/^[0-9a-f]{6}$/.test(random)) fail(EXIT.INVALID_ARGS, "Identificador de respaldo no válido.")
  return `${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}-${profile}-${random}`
}

export function authExclusions(authTables) {
  return authTables.filter((t) => !AUTH_TABLES.includes(t)).sort().map((t) => `auth.${t}`)
}

/**
 * Carpeta de respaldos: dentro del repositorio solo bajo `.biblib/` (ignorado por Git, sin
 * enlaces); fuera del repositorio, cualquier ruta absoluta que no atraviese enlaces.
 */
export function resolveBackupsRoot(root, dir = DEFAULT_BACKUPS_DIR) {
  if (typeof dir !== "string" || !dir.trim() || /^[a-z][a-z0-9+.-]*:\/\//i.test(dir)) fail(EXIT.INVALID_ARGS, "La carpeta de respaldo debe ser una ruta local, no una URL.")
  const realRoot = realpathSync.native(root)
  const absolute = path.resolve(realRoot, dir)
  if (same(realRoot, absolute) || inside(realRoot, absolute)) return localPath(realRoot, absolute)
  let current = absolute
  for (;;) {
    if (existsSync(current) && (lstatSync(current).isSymbolicLink() || realpathSync.native(current) !== current)) fail(EXIT.IDENTITY_MISMATCH, "La carpeta de respaldo no puede atravesar enlaces ni junctions.")
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return absolute
}

/** Carpeta de un respaldo existente, con su manifiesto. */
export function resolveBackupDir(root, dir) {
  if (!dir) fail(EXIT.INVALID_ARGS, "Indica --backup <carpeta del respaldo>.")
  const absolute = resolveBackupsRoot(root, dir)
  if (!existsSync(path.join(absolute, MANIFEST_FILE))) fail(EXIT.INVALID_ARGS, "La carpeta indicada no contiene un manifiesto backup.json.")
  return absolute
}

/** Admite 32 bytes binarios, 64 caracteres hex o base64 de 32 bytes. */
export function parseKey(buffer) {
  if (buffer.length === 32) return Buffer.from(buffer)
  const text = buffer.toString("utf8").trim()
  if (/^[0-9a-f]{64}$/i.test(text)) return Buffer.from(text, "hex")
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(text)) {
    const decoded = Buffer.from(text, "base64")
    if (decoded.length === 32) return decoded
  }
  return fail(EXIT.INVALID_ARGS, "La clave de cifrado debe tener 32 bytes (binario, hex o base64).", "clave")
}

export const keyFingerprint = (key) => sha256(Buffer.concat([Buffer.from("biblib-backup-key:"), key])).slice(0, 16)

/**
 * La clave vive fuera de la carpeta de respaldos y fuera de las rutas versionables del
 * repositorio. Nunca se copia, imprime ni registra: solo su huella.
 */
export function readKeyFile(root, file, { backupsRoot, backupDir } = {}) {
  if (!file) return null
  const realRoot = realpathSync.native(root)
  const absolute = path.resolve(realRoot, file)
  let stat
  try { stat = lstatSync(absolute) } catch { fail(EXIT.PLAN_REJECTED, "Falta el archivo de la clave de recuperación.", "clave") }
  if (stat.isSymbolicLink() || !stat.isFile() || realpathSync.native(absolute) !== absolute) fail(EXIT.IDENTITY_MISMATCH, "La clave debe ser un archivo regular, sin enlaces.", "clave")
  for (const dir of [backupsRoot, backupDir].filter(Boolean)) {
    if (same(dir, absolute) || inside(dir, absolute)) fail(EXIT.INVALID_ARGS, "La clave no puede guardarse en la misma carpeta que los respaldos.", "clave")
  }
  if (inside(realRoot, absolute) && !inside(path.join(realRoot, ".biblib"), absolute)) fail(EXIT.INVALID_ARGS, "Una clave dentro del repositorio solo puede estar bajo .biblib/ (ignorado por Git); preferiblemente fuera del checkout.", "clave")
  const key = parseKey(readFileSync(absolute))
  return { key, fingerprint: keyFingerprint(key) }
}

export function encrypt(key, plain, iv = randomBytes(ENCRYPTION.ivBytes)) {
  const cipher = createCipheriv(ENCRYPTION.algorithm, key, iv)
  cipher.setAAD(ENCRYPTION.magic)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([ENCRYPTION.magic, iv, body, cipher.getAuthTag()])
}

export function decrypt(key, data) {
  const { magic, ivBytes, tagBytes } = ENCRYPTION
  if (data.length < magic.length + ivBytes + tagBytes || !data.subarray(0, magic.length).equals(magic)) fail(EXIT.VERIFICATION_FAILED, "Un archivo cifrado del respaldo no tiene el formato esperado.", "integridad")
  try {
    const decipher = createDecipheriv(ENCRYPTION.algorithm, key, data.subarray(magic.length, magic.length + ivBytes))
    decipher.setAAD(magic)
    decipher.setAuthTag(data.subarray(data.length - tagBytes))
    return Buffer.concat([decipher.update(data.subarray(magic.length + ivBytes, data.length - tagBytes)), decipher.final()])
  } catch { return fail(EXIT.VERIFICATION_FAILED, "Un archivo cifrado del respaldo no se autentica con la clave indicada.", "integridad") }
}

/** Nombre opaco y portable (Windows/Linux) para los bytes de un objeto Storage. */
export function objectFile(bucket, name) {
  return `storage/${sha256(`${bucket}\u0000${name}`).slice(0, 40)}.bin`
}

export function manifestHash(manifest) {
  const body = { ...manifest }
  delete body.contentHash
  delete body.restoreVerification
  delete body.lastRehearsal
  return sha256(canonical(body))
}

export function sealManifest(manifest) {
  return { ...manifest, contentHash: manifestHash(manifest) }
}

export function readManifest(dir) {
  const file = path.join(dir, MANIFEST_FILE)
  if (lstatSync(file).isSymbolicLink()) fail(EXIT.IDENTITY_MISMATCH, "El manifiesto del respaldo no puede ser un enlace.", "integridad")
  let manifest
  try { manifest = JSON.parse(readFileSync(file, "utf8")) } catch { fail(EXIT.VERIFICATION_FAILED, "El manifiesto del respaldo no es JSON válido.", "integridad") }
  if (manifest?.schemaVersion !== 1 || manifest.kind !== BACKUP_KIND || !/^[0-9]{8}T[0-9]{6}Z-[a-z0-9-]+$/.test(manifest.backupId ?? "")) fail(EXIT.VERIFICATION_FAILED, "El manifiesto no corresponde a un respaldo administrativo de BibLib.", "integridad")
  if (manifest.contentHash !== manifestHash(manifest)) fail(EXIT.VERIFICATION_FAILED, "El manifiesto del respaldo fue alterado: su huella no coincide.", "integridad")
  if (manifest.source?.target !== "local") fail(EXIT.IDENTITY_MISMATCH, "Solo se restauran respaldos de un stack local; el procedimiento remoto está pendiente de U-INF-07.", "integridad")
  return manifest
}

/** Ruta relativa segura dentro de la carpeta del respaldo. */
export function backupFilePath(dir, relative) {
  if (typeof relative !== "string" || path.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => part === ".." || part === "")) fail(EXIT.VERIFICATION_FAILED, "El inventario contiene una ruta fuera del respaldo.", "integridad")
  return path.join(dir, ...relative.split("/"))
}

/** Archivos ausentes, enlazados o con otro hash: cada uno es una discrepancia, nunca un aviso. */
export function checkBackupFiles(dir, manifest) {
  const discrepancies = []
  for (const item of manifest.files ?? []) {
    const file = backupFilePath(dir, item.path)
    if (!existsSync(file)) { discrepancies.push({ id: "backup.file.missing", role: item.role, path: item.path, message: `Falta ${item.path} en el respaldo.` }); continue }
    if (lstatSync(file).isSymbolicLink()) { discrepancies.push({ id: "backup.file.link", role: item.role, path: item.path, message: `${item.path} es un enlace.` }); continue }
    if (sha256(readFileSync(file)) !== item.sha256) discrepancies.push({ id: "backup.file.hash", role: item.role, path: item.path, message: `${item.path} no coincide con su sha256.` })
  }
  for (const object of manifest.storage?.objects ?? []) {
    if (!(manifest.files ?? []).some((f) => f.path === object.file && f.plainSha256 === object.sha256)) discrepancies.push({ id: "backup.storage.inventory", path: object.file, message: "Un objeto Storage del inventario no tiene archivo con el mismo hash." })
  }
  return discrepancies
}

/** Lee un archivo del respaldo, lo descifra si procede y comprueba su sha256 en claro. */
export function readBackupFile(dir, item, key) {
  const data = readFileSync(backupFilePath(dir, item.path))
  if (sha256(data) !== item.sha256) fail(EXIT.VERIFICATION_FAILED, `${item.path} no coincide con su sha256.`, "integridad")
  const plain = item.encrypted ? decrypt(key, data) : data
  if (sha256(plain) !== item.plainSha256) fail(EXIT.VERIFICATION_FAILED, `${item.path} no coincide con su sha256 en claro.`, "integridad")
  return plain
}

/** El ledger respaldado debe ser un prefijo exacto del journal del checkout que restaura. */
export function compareMigrations(applied, journalEntries) {
  const problems = []
  if (applied.length > journalEntries.length) problems.push("El respaldo contiene migraciones que este checkout no conoce.")
  applied.forEach((row, index) => {
    const entry = journalEntries[index]
    if (!entry || entry.tag !== row.tag || entry.hash !== row.hash || entry.when !== row.created_at) problems.push(`La migración ${row.tag ?? index} del respaldo no coincide con el journal.`)
  })
  return { ok: problems.length === 0, problems, pending: journalEntries.slice(applied.length).map((e) => e.tag) }
}
