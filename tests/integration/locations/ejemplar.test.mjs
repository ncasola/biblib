import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { errorCode, locationsContext, value } from "./lib/context.mjs"

// U-PRO-03 · Ubicación del ejemplar por las acciones reales: sin ubicación la ficha funciona; asignar y mover con versión;
// ruta legible; `shelf_label` y posición manual que no se renumera; quitarla. Cambiar la ubicación no altera la colección
// (ejemplar, edición, estantería lógica) ni el estado de lectura.

let ctx, a, session, lib, room, bookcase, shelf

before(async () => {
  ctx = await locationsContext()
  a = await ctx.account("ejemplar")
  session = await ctx.signIn(a)
  lib = await ctx.library(a.id)
  room = value(await ctx.call("createLocationAction", [{ name: "Salón", kind: "room" }], session))
  bookcase = value(await ctx.call("createLocationAction", [{ name: "Estantería grande", kind: "bookcase", parentId: room.id }], session))
  shelf = value(await ctx.call("createLocationAction", [{ name: "Balda 3", kind: "shelf", parentId: bookcase.id }], session))
})
after(async () => { await ctx?.cleanup(); await ctx?.close() })

const set = (copyId, fields) => ctx.call("setCopyLocationAction", [{ copyId, ...fields }], session)

test("sin ubicación física la ficha y la ubicación del ejemplar responden igual que antes", async () => {
  const detail = await ctx.get(`/book/${lib.books[0]}`, session)
  assert.equal(detail.status, 200)
  const state = value(await ctx.call("getCopyLocationAction", [lib.books[0]], session))
  assert.equal(state.current, null)
  assert.equal(state.locations.length, 3)
})

test("asignar y mover con versión: ruta legible, la versión antigua se rechaza y la estantería y el estado no cambian", async () => {
  const before = await ctx.copyState(a.id)
  const revisionBefore = (await ctx.sql`select revision from biblib.library_state where user_id = ${a.id}`)[0]?.revision
  const placed = value(await set(lib.books[0], { locationId: shelf.id, shelfLabel: " Fila de atrás ", position: 4, expectedVersion: null }))
  assert.deepEqual(placed.current.path, ["Salón", "Estantería grande", "Balda 3"])
  assert.deepEqual({ label: placed.current.shelfLabel, position: placed.current.position }, { label: "Fila de atrás", position: 4 })
  // Una segunda asignación «sin ubicación previa» (otra pestaña) no pisa la primera.
  assert.equal(errorCode(await set(lib.books[0], { locationId: room.id, expectedVersion: null })), "CONFLICT")
  const moved = value(await set(lib.books[0], { locationId: room.id, shelfLabel: null, position: null, expectedVersion: placed.current.version }))
  assert.deepEqual(moved.current.path, ["Salón"])
  assert.notEqual(moved.current.version, placed.current.version)
  const stale = await set(lib.books[0], { locationId: shelf.id, expectedVersion: placed.current.version })
  assert.equal(errorCode(stale), "CONFLICT")
  assert.match(stale.value.error.message, /otra pestaña/)
  assert.deepEqual(await ctx.copyLocations(a.id), [{ copy_id: lib.books[0], location_id: room.id, shelf_label: null, position: null }])
  assert.deepEqual(await ctx.copyState(a.id), before, "ejemplares, estantería, estado y versión de la ficha intactos")
  // La revisión de colección rota (una importación preparada antes deja de valer), como con cualquier dato de producto.
  const revisionAfter = (await ctx.sql`select revision from biblib.library_state where user_id = ${a.id}`)[0]?.revision
  assert.notEqual(revisionAfter, revisionBefore)
})

test("la posición es manual: compartirla se avisa y ninguna otra se renumera", async () => {
  const first = value(await set(lib.books[1], { locationId: shelf.id, shelfLabel: "Delante", position: 1, expectedVersion: null }))
  assert.equal(first.samePosition, 0)
  const second = value(await set(lib.books[2], { locationId: shelf.id, shelfLabel: "Delante", position: 1, expectedVersion: null }))
  assert.equal(second.samePosition, 1, "se avisa de que otro ejemplar ocupa esa posición")
  const rows = await ctx.copyLocations(a.id)
  assert.deepEqual(rows.filter((row) => row.location_id === shelf.id).map((row) => row.position), [1, 1], "nadie se renumera")
  for (const position of [0, -3, 1.5, 100_001, "abc"]) assert.equal(errorCode(await set(lib.books[1], { locationId: shelf.id, position, expectedVersion: first.current.version })), "INVALID_INPUT", String(position))
  assert.equal(errorCode(await set(lib.books[1], { locationId: shelf.id, shelfLabel: "x".repeat(61), expectedVersion: first.current.version })), "INVALID_INPUT")
})

test("quitar la ubicación deja el ejemplar sin ella; con versión antigua se rechaza", async () => {
  const state = value(await ctx.call("getCopyLocationAction", [lib.books[1]], session))
  const cleared = value(await ctx.call("clearCopyLocationAction", [{ copyId: lib.books[1], expectedVersion: state.current.version }], session))
  assert.equal(cleared.current, null)
  assert.equal(errorCode(await ctx.call("clearCopyLocationAction", [{ copyId: lib.books[1], expectedVersion: state.current.version }], session)), "CONFLICT")
  assert.ok(!(await ctx.copyLocations(a.id)).some((row) => row.copy_id === lib.books[1]))
})

test("borrar el ejemplar retira su ubicación y la ubicación se conserva", async () => {
  const detail = (await ctx.sql`select version from biblib.books where id = ${lib.books[2]}`)[0]
  value(await ctx.call("deleteBookAction", [lib.books[2], detail.version], session))
  assert.ok(!(await ctx.copyLocations(a.id)).some((row) => row.copy_id === lib.books[2]))
  assert.ok((await ctx.locations(a.id)).some((row) => row.id === shelf.id))
})
