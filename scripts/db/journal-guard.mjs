import { createHash } from "node:crypto"
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { BiblibError, EXIT } from "../lib/exit-codes.mjs"
import { REPO_ROOT } from "../lib/profiles.mjs"

export const MIGRATIONS_DIR = path.join(REPO_ROOT, "drizzle")
// Ledger propio de BibLib: el proyecto Supabase es compartido (D01) y `drizzle.__drizzle_migrations`
// lo usa otra app. El ledger anterior solo se lee en local para trasladarlo (moveLegacyLedger).
export const LEDGER = Object.freeze({ schema: "biblib_migrations", table: "__drizzle_migrations" })
export const LEGACY_LEDGER = Object.freeze({ schema: "drizzle", table: "__drizzle_migrations" })
const BREAKPOINT = "--> statement-breakpoint"

/**
 * Mismo algoritmo que `readMigrationFiles` de drizzle-orm 0.45.2: sha256 del texto
 * leído con `readFileSync(...).toString()`, sin normalizar finales de línea.
 */
export function drizzleHash(content) {
  return createHash("sha256").update(Buffer.isBuffer(content) ? content.toString() : content).digest("hex")
}

export const sha256 = (value) => createHash("sha256").update(value).digest("hex")
const toLf = (text) => text.replace(/\r\n/g, "\n")

function entryProblem(problems, id, message) {
  problems.push({ id, status: "fail", code: EXIT.HISTORY_DIVERGED, message })
}

/**
 * Valida el journal sin abrir conexiones: índices consecutivos, `when` estrictamente
 * creciente, tags y ficheros presentes, bytes LF y ningún SQL fuera del journal.
 * Devuelve las entradas con su hash canónico y sus variantes LF/CRLF para conciliar ledgers.
 */
export function inspectJournal(dir = MIGRATIONS_DIR) {
  const problems = []
  const journalPath = path.join(dir, "meta", "_journal.json")
  if (!existsSync(journalPath)) {
    entryProblem(problems, "journal.file", "Falta drizzle/meta/_journal.json.")
    return { entries: [], problems, journalHash: null }
  }
  const raw = readFileSync(journalPath)
  let journal
  try { journal = JSON.parse(raw.toString()) } catch {
    entryProblem(problems, "journal.parse", "El journal de Drizzle no es JSON válido.")
    return { entries: [], problems, journalHash: sha256(raw) }
  }
  if (raw.includes("\r\n")) entryProblem(problems, "journal.eol", "El journal tiene finales CRLF; renormaliza con .gitattributes (eol=lf) antes de planificar.")
  if (journal?.dialect !== "postgresql" || !Array.isArray(journal.entries) || !journal.entries.length) {
    entryProblem(problems, "journal.shape", "El journal debe ser de dialecto postgresql y contener entradas.")
    return { entries: [], problems, journalHash: sha256(raw) }
  }
  const entries = []
  const tags = new Set()
  let previousWhen = -Infinity
  journal.entries.forEach((entry, position) => {
    const tag = typeof entry?.tag === "string" ? entry.tag : `#${position}`
    if (entry?.idx !== position) entryProblem(problems, "journal.idx", `La entrada ${tag} tiene idx ${String(entry?.idx)}; se esperaba ${position} (índices consecutivos desde 0).`)
    if (!/^\d{4}_[a-z0-9_]+$/.test(tag) || Number(tag.slice(0, 4)) !== position) entryProblem(problems, "journal.tag", `El tag ${tag} no sigue el patrón NNNN_nombre con el número de su posición.`)
    if (tags.has(tag)) entryProblem(problems, "journal.tag", `El tag ${tag} está duplicado.`)
    tags.add(tag)
    if (!Number.isSafeInteger(entry?.when) || entry.when <= previousWhen) entryProblem(problems, "journal.when", `La entrada ${tag} tiene un when que no es estrictamente creciente; el migrador la omitiría o la aplicaría fuera de orden.`)
    if (entry?.breakpoints !== true) entryProblem(problems, "journal.breakpoints", `La entrada ${tag} debe usar breakpoints.`)
    previousWhen = Number.isSafeInteger(entry?.when) ? Math.max(previousWhen, entry.when) : previousWhen
    const file = path.join(dir, `${tag}.sql`)
    if (!existsSync(file) || lstatSync(file).isSymbolicLink()) {
      entryProblem(problems, "journal.missing", `Falta el fichero drizzle/${tag}.sql (o es un enlace).`)
      return
    }
    const bytes = readFileSync(file)
    const text = bytes.toString()
    const hasCrlf = text.includes("\r\n")
    if (hasCrlf) entryProblem(problems, "journal.eol", `drizzle/${tag}.sql tiene finales CRLF; el hash no coincidiría entre Windows y Linux. Renormaliza el checkout (git, .gitattributes) sin editar el SQL.`)
    const lf = toLf(text)
    entries.push({
      idx: position, tag, when: entry.when, file,
      hash: drizzleHash(bytes), lfHash: drizzleHash(lf), crlfHash: drizzleHash(lf.replace(/\n/g, "\r\n")),
      statements: text.split(BREAKPOINT),
    })
  })
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".sql") && !tags.has(name.slice(0, -4))) entryProblem(problems, "journal.orphan", `drizzle/${name} no figura en el journal; el migrador nunca lo aplicaría.`)
  }
  return { entries, problems, journalHash: sha256(raw) }
}

export function loadJournal(dir = MIGRATIONS_DIR) {
  const journal = inspectJournal(dir)
  if (journal.problems.length) throw new BiblibError(EXIT.HISTORY_DIVERGED, "journal", journal.problems.map((p) => p.message).join(" "))
  return journal
}

/**
 * Compara el ledger aplicado con el journal. El migrador instalado solo mira el último
 * `created_at`; aquí se exige además que cada fila corresponda a una entrada con el mismo hash
 * y que lo aplicado sea un prefijo del journal (sin entradas retroactivas).
 * Un hash calculado sobre CRLF se reconoce como conciliación requerida, nunca se reescribe.
 */
export function compareLedger(entries, rows) {
  const problems = []
  const byWhen = new Map(entries.map((e) => [e.when, e]))
  const applied = new Map()
  for (const row of rows) {
    const when = Number(row.created_at)
    const entry = byWhen.get(when)
    if (!entry) { entryProblem(problems, "ledger.unknown", `El ledger contiene una fila (id ${row.id}) con created_at ${when} que no corresponde a ninguna entrada del journal.`); continue }
    if (applied.has(entry.tag)) { entryProblem(problems, "ledger.duplicate", `El ledger registra ${entry.tag} más de una vez.`); continue }
    if (row.hash === entry.hash) applied.set(entry.tag, "applied")
    else if (row.hash === entry.crlfHash) {
      applied.set(entry.tag, "legacy-crlf")
      entryProblem(problems, "ledger.legacy-crlf", `${entry.tag} figura con un hash legacy calculado sobre CRLF. Conciliación requerida (U-INF-07): documentar la equivalencia de bytes y adoptar el ledger explícitamente; el runner no lo reescribe.`)
    } else {
      applied.set(entry.tag, "hash-mismatch")
      entryProblem(problems, "ledger.hash", `${entry.tag} figura con un hash no reconocido: el SQL aplicado no coincide con el fichero actual (ni en LF ni en CRLF).`)
    }
  }
  const lastApplied = entries.reduce((last, e) => applied.has(e.tag) ? e.idx : last, -1)
  const migrations = entries.map((e) => {
    let status = applied.get(e.tag) ?? (e.idx < lastApplied ? "retroactive" : "pending")
    if (status === "retroactive") entryProblem(problems, "ledger.retroactive", `${e.tag} no está aplicada pero su when es anterior al último aplicado; el migrador la omitiría en silencio.`)
    return { tag: e.tag, when: e.when, hash: e.hash, status }
  })
  const head = lastApplied >= 0 ? entries[lastApplied] : null
  return {
    problems, migrations,
    appliedHead: head ? { tag: head.tag, when: head.when, hash: head.hash } : null,
    pending: problems.length ? [] : migrations.filter((m) => m.status === "pending").map((m) => m.tag),
  }
}

// Resumen legible del DDL a partir del texto, sin ejecutarlo.
const OPERATION = /^(CREATE SCHEMA(?: IF NOT EXISTS)? \S+|CREATE TABLE(?: IF NOT EXISTS)? \S+|CREATE (?:UNIQUE )?INDEX(?: IF NOT EXISTS)? \S+|ALTER TABLE \S+ (?:ADD COLUMN \S+|ADD CONSTRAINT \S+|DROP CONSTRAINT(?: IF EXISTS)? \S+|ENABLE ROW LEVEL SECURITY)|ALTER POLICY \S+ ON \S+|CREATE POLICY \S+|DROP POLICY(?: IF EXISTS)? \S+ ON \S+|CREATE (?:OR REPLACE )?FUNCTION \S+|CREATE TRIGGER \S+|GRANT .+? ON .+? TO \S+)/i

export function summarizeDdl(entry) {
  const operations = []
  for (const chunk of entry.statements) {
    const body = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join(" ")
    for (const statement of body.split(";")) {
      const text = statement.replace(/\s+/g, " ").replace(/"/g, "").trim()
      if (!text || /^(BEGIN|RETURN|END|NEW\.|\$\$)/i.test(text)) continue
      const match = OPERATION.exec(text)
      operations.push((match ? match[1] : text.split(" ").slice(0, 4).join(" ")).replace(/\($/, ""))
    }
  }
  const risks = []
  if (operations.some((o) => /^ALTER TABLE \S+ ADD CONSTRAINT/i.test(o))) risks.push("Añade restricciones sobre datos existentes: falla (y revierte) si hay filas incompatibles.")
  if (operations.some((o) => /DROP (CONSTRAINT|POLICY)/i.test(o))) risks.push("Retira y recrea restricciones o políticas dentro de la misma transacción.")
  if (operations.some((o) => /ADD COLUMN/i.test(o))) risks.push("Añade columnas NOT NULL con valor por defecto; bloquea la tabla durante la transacción.")
  if (operations.some((o) => /FUNCTION|TRIGGER/i.test(o))) risks.push("Crea función/trigger SQL que el snapshot de Drizzle no representa; lo verifica el manifest de objetos.")
  return { tag: entry.tag, statements: operations.length, operations, risks }
}
