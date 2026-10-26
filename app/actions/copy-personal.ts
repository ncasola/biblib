"use server"

import { z } from "zod"
import { withRlsContext } from "@/lib/db/client"
import { getRequiredUserId } from "@/lib/server-user"
import { domainMutation } from "@/lib/server-action"
import { DomainError } from "@/lib/domain-errors"
import { parsePersonalInput } from "@/lib/personal-validation"
import { personalDatabaseError, savePersonal } from "@/lib/personal-server"
import { findBook } from "@/lib/db/editions"

/** null significa «todavía no había anotación»; nunca autoriza pisar una creada después. */
export async function saveCopyPersonalAction(input: unknown) {
  return domainMutation(async () => {
    const userId = await getRequiredUserId()
    const parsed = z.object({ copyId: z.uuid(), expectedVersion: z.uuid().nullable(), personal: z.unknown() }).strict().safeParse(input)
    if (!parsed.success) throw new DomainError("INVALID_INPUT", "Indica el ejemplar y la versión de sus datos personales.")
    const personal = parsePersonalInput(parsed.data.personal)
    try {
      return await withRlsContext(userId, async (tx) => {
        await savePersonal(tx, userId, parsed.data.copyId, parsed.data.expectedVersion, personal)
        return (await findBook(tx, userId, parsed.data.copyId))!
      })
    } catch (error) { personalDatabaseError(error) }
  })
}
