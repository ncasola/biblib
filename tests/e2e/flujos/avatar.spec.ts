import sharp from "sharp"
import { actionRequest, alerts, expect, test } from "../lib/fixtures"
import { adminClient, integrationContext } from "../../integration/lib/context.mjs"

test("avatar privado: previsualizar, recortar, persistir, fallo de red, móvil y quitar", async ({ page, stack, guard }) => {
  const owner = stack.users.a
  const [previous] = await stack.sql`select * from biblib.profiles where user_id = ${owner}`
  // El recorrido nunca sustituye una imagen que no haya creado él.
  expect(previous?.avatar_asset_id ?? null).toBeNull()
  const assetsBefore = (await stack.sql`select id from biblib.media_assets where user_id = ${owner}`).map((row) => row.id)
  const image = await sharp({ create: { width: 100, height: 80, channels: 3, background: "#DC2626" } }).png().toBuffer()
  try {
    await page.setViewportSize({ width: 1024, height: 768 })
    await page.goto("/profile")
    await expect(page.getByLabel("Correo", { exact: true })).toHaveAttribute("readonly", "")
    const input = page.getByLabel("Cambiar foto de perfil", { exact: true })
    await expect(input).toBeVisible()
    await input.setInputFiles({ name: "avatar.png", mimeType: "image/png", buffer: image })
    await expect(page.getByAltText("Previsualización del recorte cuadrado del avatar")).toBeVisible()
    await page.getByLabel("Posición del recorte", { exact: true }).focus()
    await page.getByLabel("Posición del recorte", { exact: true }).press("Home")
    await expect(page.getByLabel("Posición del recorte", { exact: true })).toHaveValue("0")
    await page.getByRole("button", { name: "Guardar foto", exact: true }).click()
    await expect(page.getByRole("status").filter({ hasText: "Foto de perfil guardada." })).toBeVisible()
    const [saved] = await stack.sql`select avatar_asset_id from biblib.profiles where user_id = ${owner}`
    expect(saved.avatar_asset_id).toBeTruthy()
    await page.reload()
    const avatar = page.getByRole("img", { name: `Foto de perfil de ${stack.displayName("a")}` })
    await expect(avatar).toHaveAttribute("src", `/api/media/${saved.avatar_asset_id}`)
    await expect(page.locator(`header img[src="/api/media/${saved.avatar_asset_id}"]`)).toBeVisible()

    guard.allowConsole(/Failed to fetch|NetworkError|Load failed|ERR_FAILED|net::/i)
    const isUpload = actionRequest(stack, "uploadProfileAvatarAction")
    await page.route("**/profile", (route) => isUpload(route.request()) ? route.abort("failed") : route.fallback())
    await input.setInputFiles({ name: "otra.png", mimeType: "image/png", buffer: image })
    await page.getByRole("button", { name: "Guardar foto", exact: true }).click()
    await expect(alerts(page)).toBeVisible()
    expect((await stack.sql`select avatar_asset_id from biblib.profiles where user_id = ${owner}`)[0].avatar_asset_id).toBe(saved.avatar_asset_id)
    await expect(avatar).toHaveAttribute("src", `/api/media/${saved.avatar_asset_id}`)
    await page.unrouteAll({ behavior: "wait" })
    await page.reload()

    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole("button", { name: "Abrir menú", exact: true }).click()
    const mobile = page.getByRole("navigation", { name: "Navegación móvil" })
    await expect(mobile.getByRole("link", { name: "Perfil", exact: true })).toBeVisible()
    await expect(mobile.locator(`img[src="/api/media/${saved.avatar_asset_id}"]`)).toBeVisible()
    await page.getByRole("button", { name: "Cerrar menú", exact: true }).click()
    await page.getByRole("button", { name: "Quitar foto propia" }).click()
    await expect(page.getByRole("status").filter({ hasText: "Foto propia retirada." })).toBeVisible()
    expect((await stack.sql`select avatar_asset_id from biblib.profiles where user_id = ${owner}`)[0].avatar_asset_id).toBeNull()
    await page.reload()
    await expect(page.getByRole("button", { name: "Quitar foto propia" })).toHaveCount(0)
  } finally {
    await page.unrouteAll({ behavior: "wait" })
    await stack.sql`update biblib.profiles set avatar_asset_id = null where user_id = ${owner}`
    const added = (await stack.sql`select id, storage_key from biblib.media_assets where user_id = ${owner}`).filter((row) => !assetsBefore.includes(row.id))
    const admin = adminClient(await integrationContext())
    if (added.length) {
      const removed = await admin.storage.from("biblib-media").remove(added.map((row) => String(row.storage_key)))
      expect(removed.error).toBeNull()
      await stack.sql`delete from biblib.media_assets where user_id = ${owner} and id in ${stack.sql(added.map((row) => row.id))}`
    }
    if (!previous) await stack.sql`delete from biblib.profiles where user_id = ${owner}`
  }
})
