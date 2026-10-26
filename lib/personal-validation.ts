import { z } from "zod"
import { DomainError } from "./domain-errors"
import { isValidTagName, NOTES_MAX, normalizeTagName, TAG_LIMITS } from "./product/contracts"

/** Puntos de código, igual que char_length en Postgres; nunca recorta el contenido. */
export const personalInputSchema = z.object({
  notes: z.string().refine((value) => [...value].length <= NOTES_MAX && !value.includes("\0")).nullish(),
  rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).nullish(),
  tagIds: z.array(z.uuid()).max(TAG_LIMITS.perCopy).optional(),
  tagNames: z.array(z.string().transform((name) => name.trim().normalize("NFC")).refine(isValidTagName)).max(TAG_LIMITS.perCopy).optional(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.tagIds).size + new Set(value.tagNames?.map(normalizeTagName)).size > TAG_LIMITS.perCopy) {
    ctx.addIssue({ code: "custom", message: "El ejemplar admite hasta 20 etiquetas." })
  }
})
export type PersonalInput = z.infer<typeof personalInputSchema>

export function parsePersonalInput(input: unknown): PersonalInput {
  const result = personalInputSchema.safeParse(input)
  if (!result.success) throw new DomainError("INVALID_INPUT", "Usa notas de hasta 4000 caracteres, valoración de 1 a 5 y hasta 20 etiquetas de 40 caracteres.")
  return result.data
}
