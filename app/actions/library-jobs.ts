"use server"

import { z } from "zod"
import type { ActionResult } from "@/lib/action-result"
import { DomainError, translateDatabaseError } from "@/lib/domain-errors"
import { domainMutation } from "@/lib/server-action"
import { getRequiredUserId } from "@/lib/server-user"
import { IDEMPOTENCY_KEY_PATTERN, isTerminal, type ControlResult, type JobControl, type LibraryJobView } from "@/lib/jobs/contracts"
import { controlJob, listJobs, readJob, scheduleDrain, startCoverJob, startImportJob } from "@/lib/jobs/server"

// U-DAT-03 · Acciones de trabajos persistentes. El dueño siempre sale de la sesión: ningún DTO
// elige propietario, trabajador ni lease. Devuelven IDs y progreso confirmado en la base.

const keySchema = z.string().regex(IDEMPOTENCY_KEY_PATTERN)
const startImportSchema = z.object({ previewId: z.uuid(), idempotencyKey: keySchema })
const startCoverSchema = z.object({ scope: z.literal("missing"), idempotencyKey: keySchema })
const jobSchema = z.object({ jobId: z.uuid() })
const controlSchema = z.object({ jobId: z.uuid(), expectedVersion: z.uuid() })

function parse<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new DomainError("INVALID_INPUT", message)
  return parsed.data
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try { return await work() } catch (error) { translateDatabaseError(error) }
}

/** Si el trabajo tiene pasos pendientes, el servidor los continúa tras responder. */
function continueInBackground(owner: string, view: LibraryJobView): LibraryJobView {
  if (!isTerminal(view.state) && ["queued", "running", "waiting_retry"].includes(view.state)) scheduleDrain(owner, view.id)
  return view
}

export async function startImportJobAction(input: { previewId: string; idempotencyKey: string }): Promise<ActionResult<LibraryJobView>> {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    const { previewId, idempotencyKey } = parse(startImportSchema, input, "La importación no es válida. Prepara de nuevo la revisión del archivo.")
    return guarded(async () => {
      const job = await startImportJob(owner, { previewId, idempotencyKey })
      return continueInBackground(owner, await readJob(owner, job.id))
    })
  })
}

export async function startCoverJobAction(input: { scope: "missing"; idempotencyKey: string }): Promise<ActionResult<LibraryJobView>> {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    const { idempotencyKey } = parse(startCoverSchema, input, "La búsqueda de portadas no es válida.")
    return guarded(async () => {
      const job = await startCoverJob(owner, idempotencyKey)
      return continueInBackground(owner, await readJob(owner, job.id))
    })
  })
}

export async function getLibraryJobAction(input: { jobId: string }): Promise<ActionResult<LibraryJobView>> {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    const { jobId } = parse(jobSchema, input, "El trabajo no es válido.")
    return guarded(async () => continueInBackground(owner, await readJob(owner, jobId)))
  })
}

/** Trabajos recientes del dueño: permite retomar el progreso tras recargar o desde otra sesión. */
export async function listLibraryJobsAction(): Promise<ActionResult<LibraryJobView[]>> {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    return guarded(async () => (await listJobs(owner)).map((view) => continueInBackground(owner, view)))
  })
}

async function control(input: unknown, action: JobControl): Promise<ActionResult<ControlResult>> {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    const { jobId, expectedVersion } = parse(controlSchema, input, "La solicitud sobre el trabajo no es válida.")
    return guarded(async () => {
      const result = await controlJob(owner, jobId, expectedVersion, action)
      if (action === "resume") continueInBackground(owner, result.job)
      return result
    })
  })
}

export async function pauseLibraryJobAction(input: { jobId: string; expectedVersion: string }): Promise<ActionResult<ControlResult>> {
  return control(input, "pause")
}

export async function resumeLibraryJobAction(input: { jobId: string; expectedVersion: string }): Promise<ActionResult<ControlResult>> {
  return control(input, "resume")
}

export async function cancelLibraryJobAction(input: { jobId: string; expectedVersion: string }): Promise<ActionResult<ControlResult>> {
  return control(input, "cancel")
}
