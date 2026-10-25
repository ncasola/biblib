"use server"

import { and, asc, eq, sql } from "drizzle-orm"
import { z } from "zod"
import { withRlsContext } from "@/lib/db/client"
import { tags } from "@/lib/db/schema"
import { lockLibrary } from "@/lib/db/library"
import { getRequiredUserId } from "@/lib/server-user"
import { domainMutation } from "@/lib/server-action"
import { DomainError } from "@/lib/domain-errors"
import { parsePersonalInput } from "@/lib/personal-validation"
import { ensureTag, personalConflict, personalDatabaseError } from "@/lib/personal-server"
import type { Tag } from "@/lib/product/contracts"

export async function getTagsAction(): Promise<Tag[]> {
  const userId = await getRequiredUserId()
  return withRlsContext(userId, (tx) => tx.select({ id: tags.id, name: tags.name, normalizedName: tags.normalizedName, version: tags.version }).from(tags).where(eq(tags.userId, userId)).orderBy(asc(tags.name)).limit(1000))
}

export async function createTagAction(name: unknown) {
  return domainMutation(async (): Promise<Tag> => {
    const userId = await getRequiredUserId()
    const input = parsePersonalInput({ tagNames: [name] })
    try { return await withRlsContext(userId, (tx) => ensureTag(tx, userId, input.tagNames![0])) }
    catch (error) { personalDatabaseError(error) }
  })
}

async function changeTag(input: unknown, remove: boolean) {
  const userId = await getRequiredUserId()
  const parsed = z.object({ tagId: z.uuid(), expectedVersion: z.uuid(), name: z.unknown().optional() }).strict().safeParse(input)
  if (!parsed.success) throw new DomainError("INVALID_INPUT", "Indica la etiqueta y su versión actual.")
  const { tagId, expectedVersion } = parsed.data
  const name = remove ? undefined : parsePersonalInput({ tagNames: [parsed.data.name] }).tagNames![0]
  try {
    return await withRlsContext(userId, async (tx) => {
      await lockLibrary(tx)
      const [current] = await tx.select().from(tags).where(and(eq(tags.userId, userId), eq(tags.id, tagId))).limit(1)
      if (!current) throw new DomainError("NOT_FOUND", "La etiqueta ya no está disponible.")
      if (current.version !== expectedVersion) throw personalConflict()
      // También los ejemplares importados con solo tags y sin anotación reciben un token nuevo.
      // La selección y actualización se hacen en Postgres, sin transportar todos esos IDs a la app.
      await tx.execute(sql`insert into biblib.copy_annotations (user_id, copy_id)
        select user_id, copy_id from biblib.copy_tags where user_id = ${userId} and tag_id = ${tagId}
        on conflict (user_id, copy_id) do update set updated_at = now()`)
      const condition = and(eq(tags.userId, userId), eq(tags.id, tagId), eq(tags.version, expectedVersion))
      if (remove) { await tx.delete(tags).where(condition); return null }
      const [updated] = await tx.update(tags).set({ name: name!, updatedAt: new Date() }).where(condition).returning()
      return updated
    })
  } catch (error) { personalDatabaseError(error) }
}

export async function renameTagAction(input: unknown) { return domainMutation(() => changeTag(input, false)) }
export async function deleteTagAction(input: unknown) { return domainMutation(() => changeTag(input, true)) }
