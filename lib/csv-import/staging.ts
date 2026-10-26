import { createHash, randomUUID } from "node:crypto"
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm"
import { withRlsContext, type DatabaseTransaction } from "../db/client"
import { ensureDefaultShelf } from "../db/library"
import { importPreviews, importSessionChunks, importSessionParts, importSessionRows, importSessions } from "../db/schema"
import { DomainError } from "../domain-errors"
import { createBackupV2 } from "../backup-v2"
import { buildImportPlan, canonicalJson, IMPORT_RULES_VERSION, MAX_ACTIVE_PREVIEWS, previewTtlMinutes } from "../import-plan"
import { lockCollection, previewAllocator, readCollectionSnapshot } from "../import-publisher"
import { parseLibraryImport } from "../library-import"
import { normalizeCsv, type NormalizedCsv } from "./normalization"
import { resolveStoredMapping } from "./mapping"
import { csvIssueReport, parseCsv, type CsvIssue, type ParsedCsv } from "./parser"
import { CSV_LIMITS, CSV_TARGET_FIELDS, csvSourceRowKey, type CsvTargetField, type BeginCsvInput, type CsvImportPreview, type CsvMappingReceipt, type InspectCsvInput, type InspectedCsv, type PrepareCsvImportInput, type SetCsvMappingInput } from "./contracts"

export const CSV_CHUNK_BYTES = 256 * 1024
export const CSV_OPEN_SESSIONS = 3
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const unavailable = () => new DomainError("NOT_FOUND", "La sesión CSV no está disponible. Puede haber caducado o haberse descartado; selecciona de nuevo el archivo.")
const changed = () => new DomainError("CONFLICT", "El mapeo CSV ha cambiado en otra pestaña. Recupera la sesión antes de continuar.")
type Session = typeof importSessions.$inferSelect

export async function loadCsvSession(tx: DatabaseTransaction, owner: string, id: string, lock = false): Promise<Session> {
  const query = tx.select({ session: importSessions, expired: sql<boolean>`${importSessions.expiresAt} <= now()` }).from(importSessions)
    .where(and(eq(importSessions.id, id), eq(importSessions.userId, owner), eq(importSessions.source, "csv"))).limit(1)
  const [row] = lock ? await query.for("update") : await query
  if (!row || row.expired) throw unavailable()
  return row.session
}

function editable(session: Session) {
  if (session.state === "committed") throw new DomainError("CONFLICT", "Este CSV ya se importó. Su confirmación repetida recupera el resultado anterior; selecciona otro archivo para iniciar una importación nueva.")
}

/** La fuente permanece privada y acotada. La decodificación/normalización ocurre fuera de la transacción. */
export async function readCsvSource(owner: string, id: string) {
  const loaded = await withRlsContext(owner, async (tx) => {
    const session = await loadCsvSession(tx, owner, id)
    const chunks = await tx.select().from(importSessionChunks).where(and(eq(importSessionChunks.sessionId, id), eq(importSessionChunks.userId, owner)))
      .orderBy(asc(importSessionChunks.ordinal))
    return { session, chunks }
  })
  if (loaded.session.totalBytes > CSV_LIMITS.maxBytes) throw new DomainError("LIMIT_EXCEEDED", "El archivo supera el límite de 8 MiB.")
  const complete = loaded.chunks.length === Math.ceil(loaded.session.totalBytes / CSV_CHUNK_BYTES)
  if (!complete) return { session: loaded.session, bytes: null }
  const bytes = Buffer.concat(loaded.chunks.map((chunk) => chunk.bytes))
  if (bytes.byteLength !== loaded.session.totalBytes || sha256(bytes) !== loaded.session.inputSha256) throw new DomainError("MANIFEST_MISMATCH", "El archivo CSV llegó incompleto o su hash no coincide. Selecciónalo de nuevo.")
  return { session: loaded.session, bytes }
}

function delimiterOf(session: Session): "," | ";" | "\t" {
  const delimiter = session.csvMapping?.delimiter ?? session.manifest.delimiter
  if (delimiter !== "," && delimiter !== ";" && delimiter !== "\t") throw new DomainError("INVALID_INPUT", "Selecciona el separador del CSV.")
  return delimiter
}

function inspection(session: Session, parsed?: ParsedCsv): InspectedCsv {
  return {
    sessionId: session.id, version: session.version, complete: Boolean(parsed), headers: parsed?.headers.map((header) => header.slice(0, 500)) ?? [],
    sampleRows: parsed?.records.slice(0, 10).map((row) => ({ ordinal: row.ordinal, cells: row.cells.map((cell) => [...cell.slice(0, 240)].slice(0, 120).join("")) })) ?? [],
    recordCount: parsed?.complete ? parsed.records.length : null, inputHash: session.inputSha256!, issues: parsed?.issues.slice(0, 200) ?? [], issueCount: parsed?.issues.length ?? 0,
    mapping: session.csvMapping, mappingVersion: session.csvMappingVersion,
  }
}

export async function beginCsv(owner: string, input: BeginCsvInput): Promise<InspectedCsv> {
  return withRlsContext(owner, async (tx) => {
    await ensureDefaultShelf(tx, owner)
    const revision = await lockCollection(tx)
    await tx.delete(importSessions).where(and(eq(importSessions.userId, owner), eq(importSessions.source, "csv"), sql`${importSessions.expiresAt} <= now()`))
    const [existing] = await tx.select().from(importSessions).where(and(eq(importSessions.userId, owner), eq(importSessions.source, "csv"),
      eq(importSessions.inputSha256, input.sha256), eq(importSessions.totalBytes, input.byteLength), sql`${importSessions.state} <> 'committed'`,
      sql`${importSessions.manifest}->>'delimiter' = ${input.delimiter}`)).limit(1)
    if (existing) return inspection(existing)
    const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(importSessions).where(and(eq(importSessions.userId, owner), eq(importSessions.source, "csv"), sql`${importSessions.state} <> 'committed'`))
    if (count >= CSV_OPEN_SESSIONS) throw new DomainError("LIMIT_EXCEEDED", "Ya tienes 3 importaciones CSV abiertas. Descarta una o espera a que caduque antes de empezar otra.")
    const id = randomUUID()
    const [session] = await tx.insert(importSessions).values({
      id, userId: owner, source: "csv", exportSetId: id, manifest: { delimiter: input.delimiter }, manifestDigest: input.sha256,
      inputSha256: input.sha256, baseRevision: revision, rulesVersion: IMPORT_RULES_VERSION, partCount: 1, totalBytes: input.byteLength,
      expiresAt: sql`now() + interval '1 day'`,
    }).returning()
    await tx.insert(importSessionParts).values({ sessionId: id, userId: owner, partId: "csv", partIndex: 0, byteLength: input.byteLength, sha256: input.sha256, totalChunks: Math.ceil(input.byteLength / CSV_CHUNK_BYTES) })
    return inspection(session)
  })
}

async function writeRecords(tx: DatabaseTransaction, owner: string, session: Session, parsed: ParsedCsv, normalized?: NormalizedCsv) {
  await tx.delete(importSessionRows).where(and(eq(importSessionRows.sessionId, session.id), eq(importSessionRows.userId, owner)))
  const rows = new Map(normalized?.rows.map((row) => [row.ordinal, row]) ?? [])
  const parsedIssues = new Map<number, CsvIssue[]>()
  for (const issue of parsed.issues) {
    const group = parsedIssues.get(issue.record) ?? []
    group.push(issue); parsedIssues.set(issue.record, group)
  }
  for (let start = 0; start < parsed.records.length; start += 50) {
    await tx.insert(importSessionRows).values(parsed.records.slice(start, start + 50).map((record) => {
      const row = rows.get(record.ordinal)
      const issues = row?.issues ?? parsedIssues.get(record.ordinal) ?? []
      // JSONB no representa U+0000: conserva esa fila inválida sin alterar los bytes originales.
      const cells = record.cells.some((cell) => cell.includes("\0"))
        ? { encoding: "utf8-base64", cellsBase64: record.cells.map((cell) => Buffer.from(cell, "utf8").toString("base64")) }
        : { cells: record.cells }
      return { sessionId: session.id, userId: owner, kind: "record" as const, rowKey: csvSourceRowKey(record.ordinal), partIndex: 0, position: record.ordinal - 1,
        sourceOrdinal: record.ordinal, sourceRowKey: csvSourceRowKey(record.ordinal), data: { ...cells, ...(row?.book ? { book: row.book } : {}) },
        issues: [ ...issues.slice(0, CSV_LIMITS.issuesPerRow - 1).map((issue) => ({ code: issue.code, field: CSV_TARGET_FIELDS.includes(issue.field as CsvTargetField) ? issue.field as CsvTargetField : "record" as const })),
          ...(issues.length >= CSV_LIMITS.issuesPerRow ? [{ code: "MORE_ISSUES", field: "record" as const }] : []),
        ],
      }
    }))
  }
}

export async function inspectCsv(owner: string, input: InspectCsvInput): Promise<InspectedCsv> {
  if (input.chunk) {
    const chunk = input.chunk
    if (chunk.bytes.size < 1 || chunk.bytes.size > CSV_CHUNK_BYTES) throw new DomainError("LIMIT_EXCEEDED", "Cada trozo CSV admite hasta 256 KiB.")
    const bytes = Buffer.from(await chunk.bytes.arrayBuffer())
    if (sha256(bytes) !== chunk.sha256) throw new DomainError("MANIFEST_MISMATCH", "El hash del trozo CSV no coincide.")
    await withRlsContext(owner, async (tx) => {
      const session = await loadCsvSession(tx, owner, input.sessionId, true)
      editable(session)
      const total = Math.ceil(session.totalBytes / CSV_CHUNK_BYTES)
      const expectedSize = chunk.ordinal === total - 1 ? session.totalBytes - chunk.ordinal * CSV_CHUNK_BYTES : CSV_CHUNK_BYTES
      if (chunk.total !== total || chunk.ordinal >= total || bytes.length !== expectedSize) throw new DomainError("INVALID_INPUT", "El tamaño o la posición del trozo CSV no son válidos.")
      const [previous] = await tx.select().from(importSessionChunks).where(and(eq(importSessionChunks.sessionId, session.id), eq(importSessionChunks.ordinal, chunk.ordinal)))
      if (previous) {
        if (previous.sha256 !== chunk.sha256) throw new DomainError("IDEMPOTENCY_CONFLICT", "Ese trozo CSV ya se recibió con otro contenido.")
        return
      }
      if (session.state !== "receiving" || session.manifest.inspected) throw changed()
      await tx.insert(importSessionChunks).values({ sessionId: session.id, userId: owner, partId: "csv", ordinal: chunk.ordinal, byteLength: bytes.length, sha256: chunk.sha256, bytes })
      await tx.update(importSessions).set({ receivedBytes: sql`${importSessions.receivedBytes} + ${bytes.length}`, version: randomUUID(), updatedAt: sql`now()` }).where(eq(importSessions.id, session.id))
    })
  }
  const source = await readCsvSource(owner, input.sessionId)
  if (!source.bytes) return inspection(source.session)
  const parsed = parseCsv(source.bytes, delimiterOf(source.session))
  if (!source.session.manifest.inspected) {
    source.session = await withRlsContext(owner, async (tx) => {
      const current = await loadCsvSession(tx, owner, input.sessionId, true)
      editable(current)
      if (current.manifest.inspected) return current
      if (parsed.complete) await writeRecords(tx, owner, current, parsed)
      await tx.update(importSessionParts).set({ state: "received" }).where(eq(importSessionParts.sessionId, current.id))
      const [stored] = await tx.update(importSessions).set({ manifest: { ...current.manifest, inspected: true }, version: randomUUID(), updatedAt: sql`now()` }).where(eq(importSessions.id, current.id)).returning()
      return stored
    })
  }
  return inspection(source.session, parsed)
}

async function normalizedSource(owner: string, id: string, override?: SetCsvMappingInput["mapping"]) {
  const source = await readCsvSource(owner, id)
  if (!source.bytes) throw new DomainError("INVALID_INPUT", "Faltan trozos del CSV. Completa la subida antes de mapearlo.")
  const storedMapping = override ?? source.session.csvMapping
  if (!storedMapping) throw new DomainError("INVALID_INPUT", "Selecciona y guarda el mapeo de columnas antes de revisar.")
  const parsed = parseCsv(source.bytes, storedMapping.delimiter)
  const resolved = resolveStoredMapping(parsed.headers, storedMapping)
  if (!resolved.mapping) throw new DomainError("INVALID_INPUT", resolved.issues[0].message)
  const normalized = await normalizeCsv({ source: source.bytes, delimiter: storedMapping.delimiter, mapping: resolved.mapping, sessionId: id })
  return { ...source, parsed, normalized }
}

export async function setCsvMapping(owner: string, input: SetCsvMappingInput): Promise<CsvMappingReceipt> {
  const source = await normalizedSource(owner, input.sessionId, input.mapping)
  const mappingHash = sha256(canonicalJson(input.mapping))
  return withRlsContext(owner, async (tx) => {
    await lockCollection(tx)
    const session = await loadCsvSession(tx, owner, input.sessionId, true)
    editable(session)
    if (session.version !== input.expectedVersion || input.mappingVersion !== (session.csvMappingVersion ?? 0) + 1) throw changed()
    const [{ size }] = await tx.execute<{ size: number }>(sql`select octet_length(${canonicalJson(input.mapping)}::jsonb::text) as size`)
    if (size > CSV_LIMITS.mappingBytes) throw new DomainError("LIMIT_EXCEEDED", "El mapeo supera el límite de 16 KiB.")
    // La vista previa anterior no se modifica (authenticated no tiene UPDATE en import_previews): al soltar
    // previewId y cambiar el hash de la sesión, confirmarla da PREVIEW_EXPIRED en import-publisher.
    const [stored] = await tx.update(importSessions).set({ state: "receiving", csvMapping: input.mapping, csvMappingVersion: input.mappingVersion, mappingSha256: mappingHash,
      previewId: null, previewRevision: null, previewExpiresAt: null, plan: null, version: randomUUID(), updatedAt: sql`now()` }).where(eq(importSessions.id, session.id)).returning()
    await writeRecords(tx, owner, stored, source.parsed.complete ? source.parsed : { ...source.parsed, records: [] }, source.normalized)
    return { sessionId: session.id, version: stored.version, mappingHash, mappingVersion: input.mappingVersion, issues: source.normalized.issues.slice(0, 200), issueCount: source.normalized.issues.length,
      validRows: source.normalized.rows.filter((row) => row.book).length, totalRows: source.parsed.records.length }
  })
}

export async function prepareCsv(owner: string, input: PrepareCsvImportInput): Promise<CsvImportPreview> {
  const source = await normalizedSource(owner, input.sessionId)
  const { normalized, session } = source
  const invalid = normalized.rows.filter((row) => !row.book)
  const structural = new Set(["TRUNCATED_RECORD", "UNEXPECTED_QUOTE", "COLUMN_COUNT"])
  if (!source.parsed.complete || normalized.issues.some((issue) => issue.record === 0 || structural.has(issue.code))) throw new DomainError("INVALID_INPUT", "Corrige la estructura o los límites del CSV antes de importar. Descarga el informe de incidencias.")
  if (invalid.length && input.invalidRows !== "skip-invalid") throw new DomainError("INVALID_INPUT", "El CSV contiene filas con errores. Corrígelas o elige explícitamente importar solo las filas válidas.")
  const books = normalized.rows.flatMap((row) => row.book ? [row.book] : [])
  if (!books.length) throw new DomainError("INVALID_INPUT", "No hay registros válidos para importar.")
  const payload = createBackupV2({ books, shelves: normalized.shelves })
  let library
  try { library = parseLibraryImport(payload) } catch { throw new DomainError("LIMIT_EXCEEDED", "La salida del CSV supera los límites de importación JSON.") }
  const omittedRows = invalid.map((row) => ({ sourceRowKey: row.sourceRowKey, ordinal: row.ordinal, codes: row.issues.map((issue) => issue.code) }))
  const binding = { sessionId: session.id, inputHash: session.inputSha256!, mappingHash: session.mappingSha256!, mappingVersion: session.csvMappingVersion!, enrichCovers: input.enrichCovers === true, omittedRows }
  const digest = sha256(canonicalJson({ ...binding, mode: input.mode, duplicatePolicy: input.duplicatePolicy, invalidRows: input.invalidRows ?? "block" }))
  return withRlsContext(owner, async (tx) => {
    const revision = await lockCollection(tx)
    const current = await loadCsvSession(tx, owner, session.id, true)
    editable(current)
    if (current.version !== session.version || current.mappingSha256 !== session.mappingSha256) throw changed()
    // Una revisión idéntica se recupera, incluso tras perder la respuesta. Otra elección invalida la anterior:
    // la sesión pasa a apuntar a la nueva y confirmar la antigua da PREVIEW_EXPIRED (sin UPDATE en import_previews).
    if (current.previewId) {
      const [previous] = await tx.select().from(importPreviews).where(and(eq(importPreviews.id, current.previewId), eq(importPreviews.userId, owner), sql`${importPreviews.expiresAt} > now()`))
      if (previous?.inputDigest === digest && previous.revision === revision) return { ...binding, version: current.version, previewId: previous.id, revision, digest, expiresAt: previous.expiresAt.toISOString(), plan: previous.plan, issues: normalized.issues.slice(0, 200), issueCount: normalized.issues.length }
    }
    // Mismo cupo y retención de vistas previas que JSON, bajo el bloqueo de colección compartido.
    await tx.delete(importPreviews).where(and(eq(importPreviews.userId, owner), sql`${importPreviews.expiresAt} < now() - interval '1 day'`))
    const surplus = await tx.select({ id: importPreviews.id }).from(importPreviews).where(eq(importPreviews.userId, owner))
      .orderBy(desc(importPreviews.createdAt), desc(importPreviews.id)).offset(MAX_ACTIVE_PREVIEWS - 1)
    if (surplus.length) await tx.delete(importPreviews).where(and(eq(importPreviews.userId, owner), inArray(importPreviews.id, surplus.map((row) => row.id))))
    const previewId = randomUUID()
    const plan = buildImportPlan({ imported: library, current: await readCollectionSnapshot(tx, owner), mode: input.mode, duplicatePolicy: input.duplicatePolicy, allocateId: previewAllocator(session.id) })
    plan.csv = binding
    plan.counts.coversPending = binding.enrichCovers ? plan.books.insert.length : 0
    const [preview] = await tx.insert(importPreviews).values({ id: previewId, userId: owner, revision, inputDigest: digest, mode: input.mode,
      rulesVersion: IMPORT_RULES_VERSION, plan, payload, expiresAt: sql`now() + make_interval(mins => ${previewTtlMinutes(process.env.BIBLIB_IMPORT_PREVIEW_TTL_MINUTES)})` }).returning()
    const [updated] = await tx.update(importSessions).set({ state: "prepared", previewId, previewRevision: revision, previewExpiresAt: preview.expiresAt, plan, version: randomUUID(), updatedAt: sql`now()` }).where(eq(importSessions.id, session.id)).returning({ version: importSessions.version })
    return { ...binding, version: updated.version, previewId, revision, digest, expiresAt: preview.expiresAt.toISOString(), plan, issues: normalized.issues.slice(0, 200), issueCount: normalized.issues.length }
  })
}

export async function csvReport(owner: string, id: string): Promise<string> {
  const raw = await readCsvSource(owner, id)
  if (!raw.bytes) throw new DomainError("INVALID_INPUT", "Completa la subida para obtener el informe CSV.")
  if (!raw.session.csvMapping) return csvIssueReport(parseCsv(raw.bytes, delimiterOf(raw.session)).issues)
  const source = await normalizedSource(owner, id)
  const issues: CsvIssue[] = [...source.normalized.issues]
  const skipped = source.session.plan?.books.skip ?? []
  for (const row of skipped) {
    const ordinal = Number(row.sourceId.split(":").at(-1))
    issues.push({ code: "EXISTING_COPY", record: ordinal, field: "isbn", message: "Omitido por la política «Omitir existente».", privateSample: "" })
  }
  return csvIssueReport(issues)
}
