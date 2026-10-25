import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { errorCode, locationsContext, value } from "./lib/context.mjs"

// U-PRO-03 · Árbol mueble → balda por las acciones reales: padre e hija, renombrar y mover con versión, ciclos (BL001) y
// profundidad (BL002) traducidos a mensajes claros, ubicación vacía conservada, borrar una ocupada (rechazo o elección
// explícita) y contenido filtrable. Nada de esto cambia la estantería lógica ni el estado de ningún ejemplar.

let ctx, a, session, lib

before(async () => {
  ctx = await locationsContext()
  a = await ctx.account("arbol")
  session = await ctx.signIn(a)
  lib = await ctx.library(a.id)
})
after(async () => { await ctx?.cleanup(); await ctx?.close() })

const create = (name, kind, parentId = null) => ctx.call("createLocationAction", [{ name, kind, parentId }], session)
const assign = (copyId, locationId, extra = {}) => ctx.call("setCopyLocationAction", [{ copyId, locationId, expectedVersion: null, ...extra }], session)

test("crear un mueble y sus baldas; una ubicación vacía se conserva y aparece en la lista", async () => {
  const room = value(await create("Salón", "room"))
  const bookcase = value(await create("  Estantería grande  ", "bookcase", room.id))
  const shelf = value(await create("Balda 3", "shelf", bookcase.id))
  const empty = value(await create("Caja vacía", "box"))
  assert.equal(bookcase.name, "Estantería grande", "el nombre se recorta")
  assert.equal(shelf.parentId, bookcase.id)
  const overview = value(await ctx.call("getLocationsAction", [], session))
  const byName = new Map(overview.locations.map((location) => [location.name, location]))
  assert.deepEqual([...byName.keys()].sort(), ["Balda 3", "Caja vacía", "Estantería grande", "Salón"])
  assert.deepEqual({ children: byName.get("Salón").children, copies: byName.get("Caja vacía").copies }, { children: 1, copies: 0 })
  assert.equal(overview.limits.maxDepth, 8)
  assert.ok(empty.id)
})

test("renombrar con la versión vista; una versión antigua no pisa el cambio", async () => {
  const shelf = value(await create("Balda provisional", "shelf"))
  const renamed = value(await ctx.call("updateLocationAction", [{ id: shelf.id, name: "Balda 1", kind: "shelf", expectedVersion: shelf.version }], session))
  assert.equal(renamed.name, "Balda 1")
  assert.notEqual(renamed.version, shelf.version, "la versión rota")
  const stale = await ctx.call("updateLocationAction", [{ id: shelf.id, name: "Pisada", kind: "other", expectedVersion: shelf.version }], session)
  assert.equal(errorCode(stale), "CONFLICT")
  assert.match(stale.value.error.message, /ha cambiado/)
  assert.equal((await ctx.locations(a.id)).find((row) => row.id === shelf.id).name, "Balda 1")
  for (const bad of ["", " ", "x".repeat(121)]) assert.equal(errorCode(await ctx.call("updateLocationAction", [{ id: shelf.id, name: bad, kind: "shelf", expectedVersion: renamed.version }], session)), "INVALID_INPUT")
  assert.equal(errorCode(await ctx.call("updateLocationAction", [{ id: shelf.id, name: "Bien", kind: "planta", expectedVersion: renamed.version }], session)), "INVALID_INPUT")
})

test("mover con todo lo que contiene; un ciclo (BL001) se rechaza con un mensaje claro y no cambia nada", async () => {
  const house = value(await create("Casa", "room"))
  const cabinet = value(await create("Armario", "cabinet", house.id))
  const drawer = value(await create("Cajón", "box", cabinet.id))
  const before = await ctx.locations(a.id)
  const intoChild = await ctx.call("moveLocationAction", [{ id: house.id, parentId: drawer.id, expectedVersion: house.version }], session)
  assert.equal(errorCode(intoChild), "INVALID_INPUT")
  assert.match(intoChild.value.error.message, /dentro de sí misma ni de otra que ella contiene/)
  const intoItself = await ctx.call("moveLocationAction", [{ id: house.id, parentId: house.id, expectedVersion: house.version }], session)
  assert.equal(errorCode(intoItself), "INVALID_INPUT")
  assert.deepEqual(await ctx.locations(a.id), before, "nada cambia")
  const moved = value(await ctx.call("moveLocationAction", [{ id: cabinet.id, parentId: null, expectedVersion: cabinet.version }], session))
  assert.equal(moved.parentId, null)
  assert.equal((await ctx.locations(a.id)).find((row) => row.id === drawer.id).parent_id, cabinet.id, "el cajón sigue dentro del armario")
})

test("más de 8 niveles (BL002), también al mover un subárbol, se rechaza con un mensaje claro", async () => {
  let parent = null
  const levels = []
  for (let level = 1; level <= 8; level++) levels.push(parent = value(await create(`Nivel ${level}`, "other", parent?.id ?? null)))
  const ninth = await create("Nivel 9", "other", levels[7].id)
  assert.equal(errorCode(ninth), "INVALID_INPUT")
  assert.match(ninth.value.error.message, /como máximo 8 niveles/)
  const box = value(await create("Caja con tapa", "box"))
  value(await create("Tapa", "other", box.id))
  const deep = await ctx.call("moveLocationAction", [{ id: box.id, parentId: levels[6].id, expectedVersion: box.version }], session)
  assert.equal(errorCode(deep), "INVALID_INPUT", "la caja y su tapa quedarían en los niveles 8 y 9")
  assert.equal((await ctx.locations(a.id)).find((row) => row.id === box.id).parent_id, null)
  const fits = await ctx.call("moveLocationAction", [{ id: box.id, parentId: levels[5].id, expectedVersion: box.version }], session)
  assert.equal(errorCode(fits), "OK", "en los niveles 7 y 8 cabe")
})

test("borrar: vacía se borra; ocupada exige vaciarla o la elección explícita, y nunca cambia estantería ni estado", async () => {
  const copiesBefore = await ctx.copyState(a.id)
  const empty = value(await create("Para borrar", "box"))
  assert.deepEqual(value(await ctx.call("deleteLocationAction", [{ id: empty.id, expectedVersion: empty.version }], session)), { movedChildren: 0, movedCopies: 0, unassignedCopies: 0 })

  const study = value(await create("Despacho", "room"))
  const bookcase = value(await create("Librería", "bookcase", study.id))
  const top = value(await create("Balda alta", "shelf", bookcase.id))
  value(await assign(lib.books[0], bookcase.id, { shelfLabel: "Delante", position: 7 }))
  const current = (await ctx.call("getLocationsAction", [], session)).value.value.locations.find((location) => location.id === bookcase.id)
  const rejected = await ctx.call("deleteLocationAction", [{ id: bookcase.id, expectedVersion: current.version }], session)
  assert.equal(errorCode(rejected), "CONFLICT")
  assert.match(rejected.value.error.message, /no está vacía: contiene 1 ubicación y 1 ejemplar/)
  assert.ok((await ctx.locations(a.id)).some((row) => row.id === bookcase.id), "sigue ahí")

  const outcome = value(await ctx.call("deleteLocationAction", [{ id: bookcase.id, expectedVersion: current.version, contents: "move-to-parent" }], session))
  assert.deepEqual(outcome, { movedChildren: 1, movedCopies: 1, unassignedCopies: 0 })
  assert.equal((await ctx.locations(a.id)).find((row) => row.id === top.id).parent_id, study.id, "la balda pasa al despacho")
  const placed = (await ctx.copyLocations(a.id)).find((row) => row.copy_id === lib.books[0])
  assert.deepEqual(placed, { copy_id: lib.books[0], location_id: study.id, shelf_label: "Delante", position: 7 }, "conserva hueco y posición")

  // En la raíz, la elección explícita deja los ejemplares sin ubicación (nunca los borra).
  const freshStudy = (await ctx.call("getLocationsAction", [], session)).value.value.locations.find((location) => location.id === study.id)
  const root = value(await ctx.call("deleteLocationAction", [{ id: study.id, expectedVersion: freshStudy.version, contents: "move-to-parent" }], session))
  assert.deepEqual(root, { movedChildren: 1, movedCopies: 0, unassignedCopies: 1 })
  assert.equal((await ctx.locations(a.id)).find((row) => row.id === top.id).parent_id, null)
  assert.ok(!(await ctx.copyLocations(a.id)).some((row) => row.copy_id === lib.books[0]))
  const copiesAfter = await ctx.copyState(a.id)
  assert.deepEqual(copiesAfter, copiesBefore, "estantería, estado y versiones de los ejemplares intactos")
})

test("el contenido de una ubicación se filtra por texto y estado, y puede incluir las interiores", async () => {
  const room = value(await create("Biblioteca", "room"))
  const shelf = value(await create("Balda de poesía", "shelf", room.id))
  value(await assign(lib.books[1], room.id, { position: 2 }))
  value(await assign(lib.books[2], shelf.id, { shelfLabel: "Fila 1", position: 1 }))
  const direct = value(await ctx.call("getLocationContentsAction", [{ locationId: room.id }], session))
  assert.deepEqual(direct.items.map((item) => item.id), [lib.books[1]])
  assert.deepEqual(direct.path, ["Biblioteca"])
  const nested = value(await ctx.call("getLocationContentsAction", [{ locationId: room.id, includeNested: true }], session))
  assert.deepEqual(nested.items.map((item) => item.id), [lib.books[1], lib.books[2]], "primero lo directo, después lo interior")
  assert.equal(nested.items[1].shelfName, ctx.label("Ensayo"), "muestra la estantería lógica, que no cambia")
  const byAuthor = value(await ctx.call("getLocationContentsAction", [{ locationId: room.id, includeNested: true, query: "autora tercero" }], session))
  assert.deepEqual(byAuthor.items.map((item) => item.id), [lib.books[2]])
  const byStatus = value(await ctx.call("getLocationContentsAction", [{ locationId: room.id, includeNested: true, status: "reading" }], session))
  assert.deepEqual(byStatus.items.map((item) => item.id), [lib.books[1]])
  const wildcard = value(await ctx.call("getLocationContentsAction", [{ locationId: room.id, includeNested: true, query: "%" }], session))
  assert.equal(wildcard.total, 0, "los comodines de LIKE se escapan")
})
