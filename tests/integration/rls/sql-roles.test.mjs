import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, before, test } from "node:test"
import { fixtureLibrary } from "../lib/context.mjs"
import { setupSuite } from "../lib/suite.mjs"

// RLS directamente en Postgres con los roles reales de Supabase (`authenticated`, `anon`) y claims
// en `request.jwt.claims`, como hace PostgREST. Cada intento ocurre en una transacción que se
// revierte siempre: aunque una política fallara, no quedaría ningún cambio.

let s, lib
const ROLLBACK = Symbol("rollback")

before(async () => {
  s = await setupSuite()
  lib = await fixtureLibrary(s.ctx, s.sql)
})
after(() => s?.close())

async function as(userId, body, { role = "authenticated" } = {}) {
  let result
  try {
    await s.sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role })}, true)`
      await tx.unsafe(`set local role ${role === "anon" ? "anon" : "authenticated"}`)
      result = await body(tx)
      throw ROLLBACK
    })
  } catch (error) { if (error !== ROLLBACK) throw error }
  return result
}

/** Ejecuta en un savepoint y devuelve el SQLSTATE, o null si no hubo error. */
async function sqlState(tx, statement) {
  try { await tx.savepoint((sp) => statement(sp)); return null } catch (error) { return error.code ?? "desconocido" }
}

test("A solo ve sus filas: los libros y estanterías de B no existen para A", async () => {
  const seen = await as(lib.a.userId, async (tx) => ({
    uid: (await tx`select auth.uid() as uid`)[0].uid,
    books: await tx`select id, user_id from biblib.books`,
    shelves: await tx`select id, user_id from biblib.shelves`,
    direct: await tx`select count(*)::int as n from biblib.books where id = ${lib.b.fixtureBooks[0]}`,
  }))
  assert.equal(seen.uid, lib.a.userId)
  assert.ok(seen.books.length >= lib.a.fixtureBooks.length)
  assert.ok(seen.books.every((row) => row.user_id === lib.a.userId), "A no debe leer libros ajenos.")
  assert.ok(lib.a.fixtureBooks.every((id) => seen.books.some((row) => row.id === id)))
  assert.ok(seen.shelves.every((row) => row.user_id === lib.a.userId), "A no debe leer estanterías ajenas.")
  assert.equal(seen.direct[0].n, 0, "Pedir un ID de B por su clave no lo revela.")
})

test("A no actualiza ni borra libros o estanterías de B (0 filas afectadas)", async () => {
  const bBook = lib.b.fixtureBooks[0], bShelf = lib.b.customShelves[0]
  const affected = await as(lib.a.userId, async (tx) => ({
    updateBook: (await tx`update biblib.books set title = 'Ataque' where id = ${bBook}`).count,
    deleteBook: (await tx`delete from biblib.books where id = ${bBook}`).count,
    updateShelf: (await tx`update biblib.shelves set title = 'Ataque' where id = ${bShelf}`).count,
    deleteShelf: (await tx`delete from biblib.shelves where id = ${bShelf}`).count,
    byOwner: (await tx`update biblib.books set status = 'read' where user_id = ${lib.b.userId}`).count,
  }))
  assert.deepEqual(affected, { updateBook: 0, deleteBook: 0, updateShelf: 0, deleteShelf: 0, byOwner: 0 })
})

test("A no inserta para B ni enlaza sus libros con estanterías de B", async () => {
  const aBook = lib.a.fixtureBooks[0], bShelf = lib.b.customShelves[0]
  const codes = await as(lib.a.userId, async (tx) => ({
    insertForB: await sqlState(tx, (sp) => sp`insert into biblib.books (user_id, isbn, title, shelf_id) values (${lib.b.userId}, 'qa01-intruso', 'Intruso', ${bShelf})`),
    shelfForB: await sqlState(tx, (sp) => sp`insert into biblib.shelves (user_id, title) values (${lib.b.userId}, 'Intrusa')`),
    ownBookInBShelf: await sqlState(tx, (sp) => sp`insert into biblib.books (user_id, isbn, title, shelf_id) values (${lib.a.userId}, 'qa01-fk', 'Referencia ajena', ${bShelf})`),
    moveToBShelf: await sqlState(tx, (sp) => sp`update biblib.books set shelf_id = ${bShelf} where id = ${aBook}`),
    // U-DAT-06: la vista plana no cambia el dueño de un ejemplar (0A000) y la tabla lo impide por RLS (42501).
    giveAwayBook: await sqlState(tx, (sp) => sp`update biblib.books set user_id = ${lib.b.userId}, shelf_id = ${bShelf} where id = ${aBook}`),
    giveAwayCopy: await sqlState(tx, (sp) => sp`update biblib.copies set user_id = ${lib.b.userId}, shelf_id = ${bShelf} where id = ${aBook}`),
  }))
  assert.deepEqual(codes, { insertForB: "42501", shelfForB: "42501", ownBookInBShelf: "23503", moveToBShelf: "23503", giveAwayBook: "0A000", giveAwayCopy: "42501" })
})

test("la estantería predeterminada está protegida también para su dueño", async () => {
  const result = await as(lib.a.userId, async (tx) => ({
    rename: (await tx`update biblib.shelves set title = 'Renombrada' where id = ${lib.a.defaultShelf}`).count,
    remove: (await tx`delete from biblib.shelves where id = ${lib.a.defaultShelf}`).count,
    promote: await sqlState(tx, (sp) => sp`update biblib.shelves set is_default = true where id = ${lib.a.customShelves[0]}`),
    second: await sqlState(tx, (sp) => sp`insert into biblib.shelves (user_id, title, is_default) values (${lib.a.userId}, 'Otra predeterminada', true)`),
  }))
  assert.deepEqual(result, { rename: 0, remove: 0, promote: "42501", second: "23505" })
})

test("anon no tiene acceso al esquema biblib, ni siquiera con claims de A", async () => {
  const codes = await as(lib.a.userId, async (tx) => ({
    books: await sqlState(tx, (sp) => sp`select id from biblib.books limit 1`),
    shelves: await sqlState(tx, (sp) => sp`select id from biblib.shelves limit 1`),
  }), { role: "anon" })
  assert.deepEqual(codes, { books: "42501", shelves: "42501" })
})

test("books_rotate_version rota la versión con el rol authenticated en alta, cambio y versión forzada", async () => {
  const id = randomUUID(), forced = randomUUID()
  const versions = await as(lib.a.userId, async (tx) => {
    const [inserted] = await tx`insert into biblib.books (id, user_id, isbn, title, shelf_id, version)
      values (${id}, ${lib.a.userId}, ${`manual-${id}`}, 'Versión de prueba', ${lib.a.defaultShelf}, ${forced}) returning version`
    const [updated] = await tx`update biblib.books set status = 'read' where id = ${id} returning version`
    const [pinned] = await tx`update biblib.books set version = ${updated.version} where id = ${id} returning version`
    return { inserted: inserted.version, updated: updated.version, pinned: pinned.version }
  })
  assert.notEqual(versions.inserted, forced, "El alta no conserva una versión impuesta por el cliente.")
  assert.notEqual(versions.updated, versions.inserted)
  assert.notEqual(versions.pinned, versions.updated, "Fijar la versión anterior también la rota.")
  const [{ n }] = await s.sql`select count(*)::int as n from biblib.books where id = ${id}`
  assert.equal(n, 0, "La transacción de prueba se revierte.")
})
