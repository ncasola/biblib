import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { productContext } from "./lib/context.mjs"

// O13 · 0014. Aislamiento A/B en Postgres real con los roles de Supabase y claims del dueño: ninguna tabla de producto
// deja leer, escribir ni citar datos de otra cuenta, y una cuenta en eliminación no escribe en ninguna. Cada intento
// ocurre en una transacción revertida.

let ctx, a, b, libA, libB, seeded

before(async () => {
  ctx = await productContext()
  a = await ctx.account("a")
  b = await ctx.account("b")
  libA = await ctx.library(a.id)
  libB = await ctx.library(b.id)
  // Datos de A confirmados con sus propios claims: etiqueta, nota, ubicación, serie, evidencia, incidencia y perfil CSV.
  seeded = await ctx.asUser(a.id, async (tx) => {
    const [tag] = await tx`insert into biblib.tags (user_id, name) values (${a.id}, 'Privada') returning id`
    await tx`insert into biblib.copy_tags (user_id, copy_id, tag_id) values (${a.id}, ${libA.books[0].id}, ${tag.id})`
    await tx`insert into biblib.copy_annotations (user_id, copy_id, notes, rating) values (${a.id}, ${libA.books[0].id}, 'Nota privada de A', 4)`
    const [room] = await tx`insert into biblib.locations (user_id, name, kind) values (${a.id}, 'Salón', 'room') returning id`
    await tx`insert into biblib.copy_locations (user_id, copy_id, location_id) values (${a.id}, ${libA.books[0].id}, ${room.id})`
    const [saga] = await tx`insert into biblib.series (user_id, title) values (${a.id}, 'Saga de A') returning id`
    await tx`insert into biblib.series_editions (user_id, edition_id, series_id, position) values (${a.id}, ${libA.books[0].editionId}, ${saga.id}, 1)`
    const [issue] = await tx`insert into biblib.review_issues (user_id, reason, entity_refs) values (${a.id}, 'missing_isbn', ${tx.json([{ kind: "copy", id: libA.books[0].id }])}) returning id`
    await tx`insert into biblib.review_decisions (user_id, issue_id, kind) values (${a.id}, ${issue.id}, 'ignore')`
    await tx`insert into biblib.csv_mapping_profiles (user_id, name, mapping) values (${a.id}, 'Goodreads', ${tx.json({ delimiter: ",", header: true, columns: [] })})`
    await tx`insert into biblib.profiles (user_id) values (${a.id})`
    await tx`insert into biblib.bibliographic_evidence (user_id, edition_id, source_kind, source_ref, confidence, origin) values (${a.id}, ${libA.books[0].editionId}, 'provider', 'open-library', 'bibliographic_match', 'review')`
    return { tag: tag.id, room: room.id, saga: saga.id, issue: issue.id }
  })
})
after(async () => { await ctx?.cleanup(); await ctx?.close() })

const TABLES = ["tags", "copy_tags", "copy_annotations", "locations", "copy_locations", "series", "series_editions", "bibliographic_evidence", "review_issues", "review_decisions", "csv_mapping_profiles", "profiles", "media_assets"]

test("B no lee nada de producto de A y A ve lo suyo", async () => {
  const seen = await ctx.rolledBack(b.id, async (tx) => Object.fromEntries(await Promise.all(TABLES.map(async (table) =>
    [table, (await tx`select count(*)::int as n from ${tx("biblib")}.${tx(table)} where user_id = ${a.id}`)[0].n]))))
  assert.deepEqual(Object.values(seen).filter((n) => n !== 0), [], JSON.stringify(seen))
  const own = await ctx.rolledBack(a.id, async (tx) => Object.fromEntries(await Promise.all(TABLES.filter((table) => table !== "media_assets").map(async (table) =>
    [table, (await tx`select count(*)::int as n from ${tx("biblib")}.${tx(table)}`)[0].n]))))
  assert.deepEqual(Object.entries(own).filter(([, n]) => n < 1), [], `A ve sus filas: ${JSON.stringify(own)}`)
})

test("B no escribe filas a nombre de A ni cita etiquetas, ubicaciones, series, ejemplares o ediciones de A", async () => {
  const codes = await ctx.rolledBack(b.id, async (tx) => ({
    tagForA: await ctx.state(tx, (sp) => sp`insert into biblib.tags (user_id, name) values (${a.id}, 'Intrusa')`),
    tagOnACopy: await ctx.state(tx, async (sp) => {
      const [tag] = await sp`insert into biblib.tags (user_id, name) values (${b.id}, 'De B') returning id`
      await sp`insert into biblib.copy_tags (user_id, copy_id, tag_id) values (${b.id}, ${libA.books[0].id}, ${tag.id})`
    }),
    useATag: await ctx.state(tx, (sp) => sp`insert into biblib.copy_tags (user_id, copy_id, tag_id) values (${b.id}, ${libB.books[0].id}, ${seeded.tag})`),
    noteOnACopy: await ctx.state(tx, (sp) => sp`insert into biblib.copy_annotations (user_id, copy_id, notes) values (${b.id}, ${libA.books[1].id}, 'Intrusa')`),
    childOfARoom: await ctx.state(tx, (sp) => sp`insert into biblib.locations (user_id, parent_id, name, kind) values (${b.id}, ${seeded.room}, 'Intrusa', 'box')`),
    placeInARoom: await ctx.state(tx, (sp) => sp`insert into biblib.copy_locations (user_id, copy_id, location_id) values (${b.id}, ${libB.books[0].id}, ${seeded.room})`),
    joinASaga: await ctx.state(tx, (sp) => sp`insert into biblib.series_editions (user_id, edition_id, series_id) values (${b.id}, ${libB.books[0].editionId}, ${seeded.saga})`),
    linkAEdition: await ctx.state(tx, async (sp) => {
      const [saga] = await sp`insert into biblib.series (user_id, title) values (${b.id}, 'Saga de A') returning id`
      await sp`insert into biblib.series_editions (user_id, edition_id, series_id) values (${b.id}, ${libA.books[1].editionId}, ${saga.id})`
    }),
    evidenceOnA: await ctx.state(tx, (sp) => sp`insert into biblib.bibliographic_evidence (user_id, copy_id, source_kind, confidence) values (${b.id}, ${libA.books[0].id}, 'manual', 'provisional')`),
    decideAIssue: await ctx.state(tx, (sp) => sp`insert into biblib.review_decisions (user_id, issue_id, kind) values (${b.id}, ${seeded.issue}, 'ignore')`),
    profileForA: await ctx.state(tx, (sp) => sp`insert into biblib.profiles (user_id) values (${a.id})`),
  }))
  assert.deepEqual(codes, {
    tagForA: "42501", tagOnACopy: "23503", useATag: "23503", noteOnACopy: "23503", childOfARoom: "23503", placeInARoom: "23503",
    joinASaga: "23503", linkAEdition: "23503", evidenceOnA: "23503", decideAIssue: "23503", profileForA: "42501",
  })
  const affected = await ctx.rolledBack(b.id, async (tx) => ({
    updateTag: (await tx`update biblib.tags set name = 'Cambiada' where id = ${seeded.tag}`).count,
    deleteRoom: (await tx`delete from biblib.locations where id = ${seeded.room}`).count,
    updateNotes: (await tx`update biblib.copy_annotations set notes = 'x' where user_id = ${a.id}`).count,
    deleteIssue: (await tx`delete from biblib.review_issues where id = ${seeded.issue}`).count,
  }))
  assert.deepEqual(affected, { updateTag: 0, deleteRoom: 0, updateNotes: 0, deleteIssue: 0 })
})

test("una cuenta en eliminación no escribe en ninguna tabla de producto ni reserva imágenes (BD001)", async () => {
  const markDeleting = (tx) => tx`insert into biblib.account_lifecycle (user_id, state) values (${a.id}, 'deleting') on conflict (user_id) do update set state = 'deleting'`
  const codes = await ctx.rolledBack(a.id, async (tx) => ({
    tag: await ctx.state(tx, (sp) => sp`insert into biblib.tags (user_id, name) values (${a.id}, 'Tarde')`),
    untag: await ctx.state(tx, (sp) => sp`delete from biblib.copy_tags where user_id = ${a.id}`),
    notes: await ctx.state(tx, (sp) => sp`update biblib.copy_annotations set notes = 'Tarde' where user_id = ${a.id}`),
    move: await ctx.state(tx, (sp) => sp`update biblib.copy_locations set position = 2 where user_id = ${a.id}`),
    series: await ctx.state(tx, (sp) => sp`delete from biblib.series where user_id = ${a.id}`),
    issue: await ctx.state(tx, (sp) => sp`update biblib.review_issues set state = 'ignored', resolved_at = now() where user_id = ${a.id}`),
    decision: await ctx.state(tx, (sp) => sp`insert into biblib.review_decisions (user_id, issue_id, kind) values (${a.id}, ${seeded.issue}, 'reopen')`),
    csv: await ctx.state(tx, (sp) => sp`delete from biblib.csv_mapping_profiles where user_id = ${a.id}`),
    profile: await ctx.state(tx, (sp) => sp`update biblib.profiles set updated_at = now() where user_id = ${a.id}`),
    media: await ctx.state(tx, (sp) => sp`select biblib.media_asset_begin_upload('avatar')`),
  }), { before: markDeleting })
  assert.deepEqual(Object.entries(codes).filter(([, code]) => code !== "BD001"), [], JSON.stringify(codes))
})
