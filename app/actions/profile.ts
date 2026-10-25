"use server"

import { and, eq, sql } from "drizzle-orm"
import { z } from "zod"
import { withRlsContext } from "@/lib/db/client"
import { profiles } from "@/lib/db/schema"
import { DomainError } from "@/lib/domain-errors"
import { domainMutation } from "@/lib/server-action"
import { getRequiredUserId } from "@/lib/server-user"
import { beginUpload, upload, register, discard } from "@/lib/media/server"
import { replaceAvatar } from "@/lib/media/avatar-workflow"
import { MEDIA_LIMITS } from "@/lib/product/contracts"

const versionSchema = z.uuid().nullable()
const avatarUrl = (id: string | null) => id ? `/api/media/${id}` : undefined

export async function getProfileAvatarAction() {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    try {
      return await withRlsContext(owner, async (tx) => {
        const [profile] = await tx.select().from(profiles).where(eq(profiles.userId, owner))
        const [capability] = await tx.execute<{ available: boolean }>(sql`select to_regprocedure('biblib.media_asset_begin_upload(text)') is not null as available`)
        return { avatar: avatarUrl(profile?.avatarAssetId ?? null), version: profile?.version ?? null,
          editorEnabled: process.env.BIBLIB_PRIVATE_MEDIA_UPLOADS === "1" && capability.available }
      })
    } catch { return { avatar: undefined, version: null, editorEnabled: false } }
  })
}

async function publishAvatar(owner: string, assetId: string | null, expectedVersion: string | null) {
  return withRlsContext(owner, async (tx) => {
    const [previous] = await tx.select().from(profiles).where(eq(profiles.userId, owner)).for("update")
    if ((previous?.version ?? null) !== expectedVersion) throw new DomainError("CONFLICT", "Tu perfil ha cambiado. Recarga la página antes de volver a intentarlo.")
    const [saved] = previous
      ? await tx.update(profiles).set({ avatarAssetId: assetId }).where(and(eq(profiles.userId, owner), eq(profiles.version, previous.version))).returning()
      : await tx.insert(profiles).values({ userId: owner, avatarAssetId: assetId }).onConflictDoNothing().returning()
    if (!saved) throw new DomainError("CONFLICT", "Tu perfil ha cambiado. Recarga la página antes de volver a intentarlo.")
    return { previousId: previous?.avatarAssetId ?? null, value: { avatar: avatarUrl(saved.avatarAssetId), version: saved.version } }
  })
}

function requireEditor() {
  if (process.env.BIBLIB_PRIVATE_MEDIA_UPLOADS !== "1") throw new DomainError("PROVIDER_UNAVAILABLE", "La edición de la foto no está disponible en este momento.")
}

export async function uploadProfileAvatarAction(form: FormData) {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    requireEditor()
    const version = versionSchema.safeParse(form.get("version") || null)
    const file = form.get("image")
    if (!version.success || !(file instanceof File) || !file.size || file.size > MEDIA_LIMITS.maxBytes.avatar) throw new DomainError("INVALID_INPUT", "Elige una imagen JPEG, PNG o WebP de hasta 1 MiB y 1024 × 1024 píxeles.")
    return replaceAvatar({
      prepare: async () => {
        const asset = await beginUpload("avatar")
        try {
          const image = await upload(asset, new Uint8Array(await file.arrayBuffer()), file.type)
          await register(asset.assetId, image)
          return asset.assetId
        } catch (error) { await discard(asset.assetId).catch(() => undefined); throw error }
      },
      publish: (id) => publishAvatar(owner, id, version.data), discard,
    })
  })
}

export async function removeProfileAvatarAction(expectedVersion: string | null) {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    requireEditor()
    const parsed = versionSchema.safeParse(expectedVersion)
    if (!parsed.success) throw new DomainError("INVALID_INPUT", "La versión del perfil no es válida.")
    const published = await publishAvatar(owner, null, parsed.data)
    if (published.previousId) await discard(published.previousId).catch(() => undefined)
    return published.value
  })
}
