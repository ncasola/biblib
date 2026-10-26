import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, before, test } from "node:test"
import { accountContext, errorCode, value } from "./lib/context.mjs"

// U-OPS-03 · Un JWT de A emitido antes de pedir la eliminación no escribe por ninguna vía: ni por las Server Actions
// (aunque la sesión siguiera viva), ni por la Data API, ni por Storage. Las lecturas propias siguen hasta la limpieza.

let ctx
before(async () => { ctx = await accountContext() })
after(async () => { if (ctx) { await ctx.cleanup(); await ctx.close() } })

const shelves = async (owner) => (await ctx.sql`select count(*)::int as n from biblib.shelves where user_id = ${owner}`)[0].n

test("sesión viva (logout fallido): las acciones responden ACCOUNT_INACTIVE y no escriben", async () => {
  const a = await ctx.account("viva")
  await ctx.library(a.id)
  const session = await ctx.signIn(a)
  const initial = await shelves(a.id)
  value(await ctx.call("createShelfAction", [`[OPS-03 ${ctx.run}] antes`], session))
  assert.equal(await shelves(a.id), initial + 1, "control: escribe mientras está activa")
  // Solicitud sin cerrar sesiones: el JWT y su sesión de GoTrue siguen siendo válidos.
  await ctx.asUser(a.id, (tx) => tx`select biblib.account_deletion_request(${ctx.key("viva")})`)
  const count = await shelves(a.id)
  assert.equal(errorCode(await ctx.call("createShelfAction", [`[OPS-03 ${ctx.run}] después`], session)), "ACCOUNT_INACTIVE", "estantería (bloqueo de colección)")
  const view = { name: "Tardía", filters: { status: "all", shelf: "all", sort: "title", view: "table", pageSize: 25 } }
  assert.equal(errorCode(await ctx.call("saveCurrentViewAction", [view], session)), "ACCOUNT_INACTIVE", "vista guardada (RLS RESTRICTIVE sin bloqueo de colección)")
  assert.equal(await shelves(a.id), count)
  assert.equal((await ctx.sql`select count(*)::int as n from biblib.saved_book_views where user_id = ${a.id} and name = 'Tardía'`)[0].n, 0)
  // Sigue leyendo lo suyo y ve el estado de su solicitud.
  assert.equal(value(await ctx.call("getAccountDeletionStatusAction", [], session)).phase, "requested")
})

test("sesión cerrada: el JWT antiguo no escribe ni por acciones, ni por la Data API, ni por Storage", async () => {
  const a = await ctx.account("cerrada")
  const library = await ctx.library(a.id)
  const session = await ctx.signIn(a)
  // Una subida propia en cuarentena, autorizada antes de pedir la eliminación.
  const quarantined = randomUUID()
  await ctx.sql`insert into biblib.cover_assets (id, user_id, state, source_kind, source_ref, rights_policy_version, upload_token, expires_at)
    values (${quarantined}, ${a.id}, 'quarantine', 'upload', 'upload', 'v1', 'subida', now() + interval '10 minutes')`
  assert.equal(value(await ctx.call("requestAccountDeletionAction", [{ confirmation: "ELIMINAR MI CUENTA", operationKey: ctx.key("cerrada") }], session)).sessionsRevoked, true)
  const count = await shelves(a.id)

  const action = await ctx.call("createShelfAction", [`[OPS-03 ${ctx.run}] tardía`], session)
  assert.notEqual(action.status, 200, "el proxy verifica con GoTrue y devuelve al acceso")
  assert.equal(action.value, undefined)

  // Data API con el mismo JWT (aún no caducado): biblib no está expuesto y, aunque lo estuviera, la RLS lo rechaza.
  const insert = await ctx.rest(session, "shelves", { method: "POST", body: { user_id: a.id, title: "Por la Data API" } })
  assert.ok(insert.status >= 400, `la Data API no escribe (${insert.status})`)
  assert.equal(await shelves(a.id), count)

  // Storage con el mismo JWT: ni sube el intento autorizado ni retira sus portadas.
  const upload = await ctx.storageAs(session).upload(`${a.id}/${quarantined}/subida.webp`, Buffer.from("RIFF0000WEBP"), { contentType: "image/webp" })
  assert.ok(upload.error, "no sube")
  const removal = await ctx.storageAs(session).remove([library.keys[0]])
  assert.deepEqual(removal.data ?? [], [], "no retira objetos")
  assert.deepEqual(await ctx.objects(a.id), [...library.keys].sort(), "las portadas siguen hasta que el worker las retire")
  const read = await ctx.storageAs(session).download(library.keys[0])
  assert.ok(read.data, "leer las propias sigue permitido")

  // Por SQL con sus claims (la conexión de la app con un JWT antiguo): ninguna tabla ni función de escritura.
  for (const statement of [
    (tx) => tx`insert into biblib.shelves (user_id, title) values (${a.id}, 'SQL')`,
    (tx) => tx`update biblib.copies set status = 'read' where user_id = ${a.id}`,
    (tx) => tx`delete from biblib.saved_book_views where user_id = ${a.id}`,
    (tx) => tx`select biblib.lock_library()`,
    (tx) => tx`select biblib.cover_asset_discard(${quarantined})`,
  ]) await assert.rejects(ctx.asUser(a.id, statement), (error) => error.code === "BD001")
  assert.equal((await ctx.asUser(a.id, (tx) => tx`select biblib.cover_asset_begin_upload() as r`))[0].r.status, "inactive", "ni reserva subidas")
})
