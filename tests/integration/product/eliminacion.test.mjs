import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { productContext } from "./lib/context.mjs"

// O13 · 0014. Eliminación de cuenta con datos de producto: el worker real (lease, fencing, GoTrue y Storage) recorre los
// pasos `product` y `media` y no da la cuenta por eliminada hasta que no queda ninguna fila con dueño, ningún objeto de
// `biblib-media` ni la identidad. B no se ve afectado.

let ctx, a, b, sessionA

before(async () => {
  ctx = await productContext()
  a = await ctx.account("a")
  b = await ctx.account("b")
  sessionA = await ctx.signIn(a)
})
after(async () => { await ctx?.cleanup(); await ctx?.close() })

test("el worker retira etiquetas, notas, árbol de ubicaciones, series, evidencias, revisión, perfil, CSV e imágenes, y B sigue intacto", async () => {
  const lib = await ctx.library(a.id)
  await ctx.library(b.id)
  const avatar = await ctx.uploadMedia(a.id, sessionA, "avatar")
  const room = await ctx.uploadMedia(a.id, sessionA, "location")
  const spine = await ctx.uploadMedia(a.id, sessionA, "evidence")
  await ctx.asUser(a.id, async (tx) => {
    const [tag] = await tx`insert into biblib.tags (user_id, name) values (${a.id}, 'Para borrar') returning id`
    await tx`insert into biblib.copy_tags (user_id, copy_id, tag_id) values (${a.id}, ${lib.books[0].id}, ${tag.id})`
    await tx`insert into biblib.copy_annotations (user_id, copy_id, notes, rating) values (${a.id}, ${lib.books[0].id}, 'Nota', 3)`
    let parent = null
    for (const [index, name] of ["Casa", "Salón", "Estantería", "Balda"].entries()) {
      [{ id: parent }] = await tx`insert into biblib.locations (user_id, parent_id, name, kind, photo_asset_id) values (${a.id}, ${parent}, ${name}, ${index === 3 ? "shelf" : "room"}, ${index === 0 ? room.id : null}) returning id`
    }
    await tx`insert into biblib.copy_locations (user_id, copy_id, location_id) values (${a.id}, ${lib.books[0].id}, ${parent})`
    const [saga] = await tx`insert into biblib.series (user_id, title) values (${a.id}, 'Serie') returning id`
    await tx`insert into biblib.series_editions (user_id, edition_id, series_id, position) values (${a.id}, ${lib.books[0].editionId}, ${saga.id}, 1)`
    await tx`insert into biblib.bibliographic_evidence (user_id, copy_id, source_kind, photo_asset_id, confidence) values (${a.id}, ${lib.books[1].id}, 'photo', ${spine.id}, 'provisional')`
    const [issue] = await tx`insert into biblib.review_issues (user_id, reason, entity_refs) values (${a.id}, 'photo_doubt', ${tx.json([{ kind: "copy", id: lib.books[1].id }])}) returning id`
    await tx`insert into biblib.review_decisions (user_id, issue_id, kind) values (${a.id}, ${issue.id}, 'ignore')`
    await tx`insert into biblib.profiles (user_id, avatar_asset_id) values (${a.id}, ${avatar.id})`
    await tx`insert into biblib.csv_mapping_profiles (user_id, name, mapping) values (${a.id}, 'Perfil', ${tx.json({ delimiter: ",", header: true, columns: [] })})`
  })
  const before = await ctx.residue(a.id)
  assert.ok(before.objects >= 3 && ["tags", "locations", "media_assets", "profiles", "review_decisions"].every((table) => before.tables[table] > 0), JSON.stringify(before))
  const bBefore = await ctx.residue(b.id)

  const requested = await ctx.asUser(a.id, async (tx) => (await tx`select biblib.account_deletion_request(${ctx.key("eliminar")}) as r`)[0].r)
  assert.equal(requested.state, "pending")
  const report = await ctx.deleteAccount(a.id)
  assert.equal(report?.outcome, "completed", JSON.stringify(report))
  assert.ok(report.counts.product >= 15 && report.counts.media === 3, `pasos product y media: ${JSON.stringify(report.counts)}`)
  assert.deepEqual(await ctx.residue(a.id), { rows: 0, tables: {}, objects: 0, account: false })
  assert.equal((await ctx.admin.storage.from("biblib-media").list(`${a.id}/avatar`)).data?.length ?? 0, 0)
  assert.deepEqual(await ctx.residue(b.id), bBefore, "B no cambia")
})
