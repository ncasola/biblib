"use server"

import { and, desc, eq, sql } from "drizzle-orm"
import { z } from "zod"
import { withRlsContext } from "@/lib/db/client"
import { csvMappingProfiles, importSessions } from "@/lib/db/schema"
import { databaseErrorCode, DomainError, translateDatabaseError } from "@/lib/domain-errors"
import { domainMutation } from "@/lib/server-action"
import { getRequiredUserId } from "@/lib/server-user"
import { lockCollection } from "@/lib/import-publisher"
import { beginCsv, csvReport, inspectCsv, loadCsvSession, prepareCsv, setCsvMapping } from "@/lib/csv-import/staging"
import { CSV_LIMITS, type BeginCsvInput, type InspectCsvInput, type PrepareCsvImportInput, type SetCsvMappingInput } from "@/lib/csv-import/contracts"
import { storedCsvMappingSchema } from "@/lib/csv-import/mapping"

const sessionInput = z.object({ sessionId: z.uuid() }).strict()
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const blob = z.custom<Blob>((value) => value instanceof Blob)
const beginInput = z.object({ byteLength: z.number().int().min(1).max(CSV_LIMITS.maxBytes), sha256: hash, delimiter: z.enum([",", ";", "\t"]) }).strict()
const inspectInput = sessionInput.extend({ chunk: z.object({ ordinal: z.number().int().min(0).max(31), total: z.number().int().min(1).max(32), sha256: hash, bytes: blob }).strict().optional() })
const mappingInput = sessionInput.extend({ expectedVersion: z.uuid(), mappingVersion: z.number().int().min(1).max(1_000_000), mapping: storedCsvMappingSchema })
const prepareInput = sessionInput.extend({ mode: z.enum(["merge", "replace"]), duplicatePolicy: z.enum(["skip-existing", "another-copy"]), invalidRows: z.enum(["block", "skip-invalid"]).optional() })

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) throw new DomainError("INVALID_INPUT", "Los datos CSV no son válidos. Revisa el archivo, los límites y el mapeo.")
  return result.data
}
function owned<T>(work: (owner: string) => Promise<T>) {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    try { return await work(owner) } catch (error) {
      if (databaseErrorCode(error) === "BP001") throw new DomainError("LIMIT_EXCEEDED", "Has alcanzado el límite de perfiles CSV guardados.")
      if (databaseErrorCode(error) === "23505") throw new DomainError("CONFLICT", "Ya existe un perfil CSV con ese nombre.")
      translateDatabaseError(error)
    }
  })
}

export async function beginCsvImportAction(input: BeginCsvInput) {
  return owned((owner) => beginCsv(owner, parse(beginInput, input)))
}
export async function inspectCsvAction(input: InspectCsvInput) {
  return owned((owner) => inspectCsv(owner, parse(inspectInput, input)))
}
export async function setCsvMappingAction(input: SetCsvMappingInput) {
  return owned((owner) => setCsvMapping(owner, parse(mappingInput, input)))
}
export async function prepareCsvImportAction(input: PrepareCsvImportInput) {
  return owned((owner) => prepareCsv(owner, parse(prepareInput, input)))
}
export async function getCsvIssueReportAction(input: { sessionId: string }) {
  return owned((owner) => csvReport(owner, parse(sessionInput, input).sessionId))
}
export async function listCsvSessionsAction() {
  return owned((owner) => withRlsContext(owner, (tx) => tx.select({ sessionId: importSessions.id, state: importSessions.state, expiresAt: importSessions.expiresAt })
    .from(importSessions).where(and(eq(importSessions.userId, owner), eq(importSessions.source, "csv"), sql`${importSessions.expiresAt} > now()`, sql`${importSessions.state} <> 'committed'`)).orderBy(desc(importSessions.createdAt)).limit(3)))
}
export async function discardCsvImportAction(input: { sessionId: string }) {
  return owned(async (owner) => {
    const { sessionId } = parse(sessionInput, input)
    await withRlsContext(owner, async (tx) => {
      await lockCollection(tx)
      await loadCsvSession(tx, owner, sessionId, true)
      await tx.delete(importSessions).where(and(eq(importSessions.id, sessionId), eq(importSessions.userId, owner)))
    })
  })
}

/** Sin guardado implícito: solo la invoca el botón explícito «Guardar perfil». */
export async function saveCsvMappingProfileAction(input: { sessionId: string; name: string }) {
  return owned(async (owner) => {
    const parsed = parse(sessionInput.extend({ name: z.string().trim().min(1).max(CSV_LIMITS.profileNameMax) }), input)
    return withRlsContext(owner, async (tx) => {
      const session = await loadCsvSession(tx, owner, parsed.sessionId)
      if (!session.csvMapping || !session.csvMappingVersion) throw new DomainError("INVALID_INPUT", "Guarda primero un mapeo válido.")
      const [profile] = await tx.insert(csvMappingProfiles).values({ userId: owner, name: parsed.name, mapping: session.csvMapping, mappingVersion: session.csvMappingVersion }).returning()
      return { id: profile.id, name: profile.name, mapping: profile.mapping, mappingVersion: profile.mappingVersion, version: profile.version }
    })
  })
}
export async function listCsvMappingProfilesAction() {
  return owned((owner) => withRlsContext(owner, (tx) => tx.select({ id: csvMappingProfiles.id, name: csvMappingProfiles.name, mapping: csvMappingProfiles.mapping, mappingVersion: csvMappingProfiles.mappingVersion, version: csvMappingProfiles.version })
    .from(csvMappingProfiles).where(eq(csvMappingProfiles.userId, owner)).orderBy(desc(csvMappingProfiles.createdAt)).limit(CSV_LIMITS.profilesPerAccount)))
}
