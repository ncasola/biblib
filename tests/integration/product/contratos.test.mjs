import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { productContext } from "./lib/context.mjs"

// O13 · 0014. Contratos de datos en Postgres real con el rol `authenticated` y los claims del dueño: etiquetas únicas por
// nombre normalizado, límites (20 por ejemplar, notas de 4000, valoración 1–5), árbol de ubicaciones sin ciclos ni más de 8
// niveles, ubicación ocupada no borrable y posición de serie NUMERIC exacta. Todo en transacciones revertidas.

let ctx, a, lib

before(async () => {
  ctx = await productContext()
  a = await ctx.account("a")
  lib = await ctx.library(a.id)
})
after(async () => { await ctx?.cleanup(); await ctx?.close() })

test("etiquetas únicas por nombre normalizado (mayúsculas y acentos) y la ñ distingue", async () => {
  const result = await ctx.rolledBack(a.id, async (tx) => {
    await tx`insert into biblib.tags (user_id, name) values (${a.id}, 'Novela histórica')`
    return {
      upper: await ctx.state(tx, (sp) => sp`insert into biblib.tags (user_id, name) values (${a.id}, 'NOVELA HISTORICA')`),
      accents: await ctx.state(tx, (sp) => sp`insert into biblib.tags (user_id, name) values (${a.id}, 'Nóvela  Histórica')`),
      eñe: await ctx.state(tx, async (sp) => { await sp`insert into biblib.tags (user_id, name) values (${a.id}, 'Año')`; await sp`insert into biblib.tags (user_id, name) values (${a.id}, 'Ano')` }),
      tooLong: await ctx.state(tx, (sp) => sp`insert into biblib.tags (user_id, name) values (${a.id}, ${"x".repeat(41)})`),
      normalized: (await tx`select normalized_name from biblib.tags where name = 'Novela histórica'`)[0].normalized_name,
    }
  })
  assert.deepEqual(result, { upper: "23505", accents: "23505", eñe: null, tooLong: "23514", normalized: "novela historica" })
})

test("hasta 20 etiquetas por ejemplar, también en una sola sentencia; notas de 4000 y valoración 1–5 o nula", async () => {
  const result = await ctx.rolledBack(a.id, async (tx) => {
    const tags = await tx`insert into biblib.tags (user_id, name) select ${a.id}, 'Tema ' || n from generate_series(1, 21) as n returning id`
    const copy = lib.books[0].id
    return {
      twenty: await ctx.state(tx, (sp) => sp`insert into biblib.copy_tags (user_id, copy_id, tag_id) select ${a.id}, ${copy}, id from biblib.tags where id = any(${tags.slice(0, 20).map((t) => t.id)}::uuid[])`),
      twentyFirst: await ctx.state(tx, (sp) => sp`insert into biblib.copy_tags (user_id, copy_id, tag_id) values (${a.id}, ${copy}, ${tags[20].id})`),
      batch: await ctx.state(tx, (sp) => sp`insert into biblib.copy_tags (user_id, copy_id, tag_id) select ${a.id}, ${lib.books[1].id}, id from biblib.tags where id = any(${tags.map((t) => t.id)}::uuid[])`),
      notes4000: await ctx.state(tx, (sp) => sp`insert into biblib.copy_annotations (user_id, copy_id, notes, rating) values (${a.id}, ${copy}, ${"✨".repeat(4000)}, 5)`),
      notes4001: await ctx.state(tx, (sp) => sp`insert into biblib.copy_annotations (user_id, copy_id, notes) values (${a.id}, ${lib.books[1].id}, ${"n".repeat(4001)})`),
      rating6: await ctx.state(tx, (sp) => sp`insert into biblib.copy_annotations (user_id, copy_id, rating) values (${a.id}, ${lib.books[1].id}, 6)`),
      ratingNull: await ctx.state(tx, (sp) => sp`insert into biblib.copy_annotations (user_id, copy_id, rating) values (${a.id}, ${lib.books[2].id}, null)`),
    }
  })
  assert.deepEqual(result, { twenty: null, twentyFirst: "BP001", batch: "BP001", notes4000: null, notes4001: "23514", rating6: "23514", ratingNull: null })
})

test("ubicaciones: sin ciclos (también en una sentencia), máximo 8 niveles, ocupada o con hijas no se borra, la estantería lógica no cambia", async () => {
  const result = await ctx.rolledBack(a.id, async (tx) => {
    const [room] = await tx`insert into biblib.locations (user_id, name, kind) values (${a.id}, 'Salón', 'room') returning id`
    const [bookcase] = await tx`insert into biblib.locations (user_id, parent_id, name, kind) values (${a.id}, ${room.id}, 'Estantería', 'bookcase') returning id`
    let parent = null
    for (let level = 1; level <= 8; level++) [{ id: parent }] = await tx`insert into biblib.locations (user_id, parent_id, name, kind) values (${a.id}, ${parent}, ${`Nivel ${level}`}, 'other') returning id`
    await tx`insert into biblib.copy_locations (user_id, copy_id, location_id, shelf_label, position) values (${a.id}, ${lib.books[0].id}, ${bookcase.id}, 'Balda 3', 4)`
    const before = (await tx`select shelf_id, status from biblib.copies where id = ${lib.books[0].id}`)[0]
    await tx`update biblib.copy_locations set location_id = ${room.id}, position = null where copy_id = ${lib.books[0].id}`
    const afterMove = (await tx`select shelf_id, status from biblib.copies where id = ${lib.books[0].id}`)[0]
    return {
      cycle: await ctx.state(tx, (sp) => sp`update biblib.locations set parent_id = ${bookcase.id} where id = ${room.id}`),
      batchCycle: await ctx.state(tx, async (sp) => {
        const [x, y] = [crypto.randomUUID(), crypto.randomUUID()]
        await sp`insert into biblib.locations (id, user_id, parent_id, name, kind) values (${x}, ${a.id}, ${y}, 'X', 'box'), (${y}, ${a.id}, ${x}, 'Y', 'box')`
      }),
      ninth: await ctx.state(tx, (sp) => sp`insert into biblib.locations (user_id, parent_id, name, kind) values (${a.id}, ${parent}, 'Nivel 9', 'other')`),
      deepMove: await ctx.state(tx, (sp) => sp`update biblib.locations set parent_id = ${parent} where id = ${room.id}`),
      occupied: await ctx.state(tx, (sp) => sp`delete from biblib.locations where id = ${room.id}`),
      withChildren: await ctx.state(tx, async (sp) => { await sp`delete from biblib.copy_locations where copy_id = ${lib.books[0].id}`; await sp`delete from biblib.locations where id = ${room.id}` }),
      second: await ctx.state(tx, (sp) => sp`insert into biblib.copy_locations (user_id, copy_id, location_id) values (${a.id}, ${lib.books[0].id}, ${bookcase.id})`),
      logicalShelfUnchanged: before.shelf_id === afterMove.shelf_id && before.status === afterMove.status,
    }
  })
  assert.deepEqual(result, { cycle: "BL001", batchCycle: "BL001", ninth: "BL002", deepMove: "BL002", occupied: "23503", withChildren: "23503", second: "23505", logicalShelfUnchanged: true })
})

test("serie: posición NUMERIC exacta 1, 1.5, 2 con orden desconocido al final; una serie por edición; borrar la serie conserva ediciones", async () => {
  const result = await ctx.rolledBack(a.id, async (tx) => {
    const [saga] = await tx`insert into biblib.series (user_id, title) values (${a.id}, 'Saga') returning id`
    const [other] = await tx`insert into biblib.series (user_id, title) values (${a.id}, 'Otra') returning id`
    await tx`insert into biblib.series_editions (user_id, edition_id, series_id, position, volume_label) values
      (${a.id}, ${lib.books[2].editionId}, ${saga.id}, '2', 'II'), (${a.id}, ${lib.books[0].editionId}, ${saga.id}, '1', 'I'), (${a.id}, ${lib.books[1].editionId}, ${saga.id}, '1.5', null)`
    const order = (await tx`select position::text as position from biblib.series_editions where series_id = ${saga.id} order by position nulls last`).map((row) => row.position)
    await tx`update biblib.series_editions set position = null where edition_id = ${lib.books[2].editionId}`
    const unknownLast = (await tx`select edition_id from biblib.series_editions where series_id = ${saga.id} order by position nulls last`).map((row) => row.edition_id)
    const states = {
      scale: await ctx.state(tx, (sp) => sp`update biblib.series_editions set position = 1.00001 where edition_id = ${lib.books[1].editionId}`),
      negative: await ctx.state(tx, (sp) => sp`update biblib.series_editions set position = -1 where edition_id = ${lib.books[1].editionId}`),
      twoSeries: await ctx.state(tx, (sp) => sp`insert into biblib.series_editions (user_id, edition_id, series_id) values (${a.id}, ${lib.books[0].editionId}, ${other.id})`),
    }
    await tx`delete from biblib.series where id = ${saga.id}`
    const editions = (await tx`select count(*)::int as n from biblib.editions where id = any(${lib.books.map((book) => book.editionId)}::uuid[])`)[0].n
    return { order, unknownLast: unknownLast.at(-1) === lib.books[2].editionId, ...states, editions, links: (await tx`select count(*)::int as n from biblib.series_editions where series_id = ${saga.id}`)[0].n }
  })
  assert.deepEqual(result, { order: ["1", "1.5", "2"], unknownLast: true, scale: "23514", negative: "23514", twoSeries: "23505", editions: 3, links: 0 })
})
