import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { accountContext, errorCode, value } from "./lib/context.mjs"

// U-OPS-03 · Solicitud de eliminación por la Server Action real: la cuenta es la de la sesión, la confirmación es
// explícita, doble clic y reintentos devuelven el mismo estado y las sesiones se cierran con GoTrue.

const CONFIRMATION = "ELIMINAR MI CUENTA"
let ctx
before(async () => { ctx = await accountContext() })
after(async () => { if (ctx) { await ctx.cleanup(); await ctx.close() } })

test("sin sesión no hay solicitud ni estado", async () => {
  const anonymous = await ctx.call("requestAccountDeletionAction", [{ confirmation: CONFIRMATION, operationKey: ctx.key() }])
  assert.notEqual(anonymous.status, 200, "el proxy devuelve al acceso")
  assert.equal(anonymous.value, undefined)
})

test("A solo pide su propia eliminación: un ID ajeno en la entrada se rechaza y B no cambia", async () => {
  const a = await ctx.account("a"), b = await ctx.account("b")
  const session = await ctx.signIn(a)
  assert.equal(errorCode(await ctx.call("requestAccountDeletionAction", [{ confirmation: CONFIRMATION, operationKey: ctx.key(), userId: b.id }], session)), "INVALID_INPUT")
  assert.equal(errorCode(await ctx.call("requestAccountDeletionAction", [{ confirmation: "eliminar", operationKey: ctx.key() }], session)), "INVALID_INPUT", "la frase debe coincidir")
  assert.equal(errorCode(await ctx.call("requestAccountDeletionAction", [{ confirmation: CONFIRMATION, operationKey: "corta" }], session)), "INVALID_INPUT")
  assert.equal(await ctx.deletion(a.id), undefined, "ningún intento inválido registra nada")
  assert.equal(await ctx.deletion(b.id), undefined)
  assert.deepEqual(value(await ctx.call("getAccountDeletionStatusAction", [], session)), { phase: "none", requestedAt: null })

  const requested = value(await ctx.call("requestAccountDeletionAction", [{ confirmation: " eliminar mi cuenta ", operationKey: ctx.key("a") }], session))
  assert.equal(requested.phase, "requested")
  assert.equal(requested.sessionsRevoked, true, "GoTrue cerró las sesiones con el token del propio usuario")
  assert.equal((await ctx.deletion(a.id)).state, "pending")
  assert.equal((await ctx.sql`select state from biblib.account_lifecycle where user_id = ${a.id}`)[0].state, "deleting")
  assert.equal(await ctx.deletion(b.id), undefined, "B sigue activa")
  assert.equal((await ctx.sql`select count(*)::int as n from biblib.account_lifecycle where user_id = ${b.id}`)[0].n, 0)
})

test("doble clic y reintento con otra clave devuelven la misma solicitud", async () => {
  const a = await ctx.account("doble")
  const session = await ctx.signIn(a)
  const key = ctx.key("doble")
  const [first, second] = await Promise.all([0, 1].map(() => ctx.call("requestAccountDeletionAction", [{ confirmation: CONFIRMATION, operationKey: key }], session)))
  const answered = [first, second].filter((result) => result.status === 200).map(value)
  assert.ok(answered.length >= 1, "al menos una respuesta llega antes de cerrar las sesiones")
  assert.equal(new Set(answered.map((view) => view.requestedAt)).size, 1, "las dos respuestas describen la misma solicitud")
  for (const result of [first, second]) assert.ok(result.status === 200 || result.location, "la otra, como mucho, vuelve al acceso por la sesión ya cerrada")
  const rows = await ctx.sql`select operation_key, requested_at from biblib.account_deletions where user_id = ${a.id}`
  assert.equal(rows.length, 1)
  assert.equal(rows[0].operation_key, key)

  // La sesión anterior ya no sirve; con una nueva (aún sin el bloqueo del worker) la solicitud es la misma.
  assert.notEqual((await ctx.call("getAccountDeletionStatusAction", [], session)).status, 200)
  const again = await ctx.signIn(a)
  const repeated = value(await ctx.call("requestAccountDeletionAction", [{ confirmation: CONFIRMATION, operationKey: ctx.key("otra") }], again))
  assert.equal(repeated.requestedAt, answered[0].requestedAt)
  assert.equal(repeated.phase, "requested")
  assert.equal((await ctx.sql`select operation_key from biblib.account_deletions where user_id = ${a.id}`)[0].operation_key, key, "no se crea otra solicitud")
})

test("el worker bloquea la cuenta en GoTrue: ni un inicio de sesión nuevo ni un refresh antiguo funcionan", async () => {
  const a = await ctx.account("ban")
  const session = await ctx.signIn(a)
  await ctx.asUser(a.id, (tx) => tx`select biblib.account_deletion_request(${ctx.key("ban")})`)
  // Solo el primer paso (sesiones): el worker se detiene antes de Storage.
  const report = await ctx.work(a.id, { hooks: { beforeStep: (step) => { if (step === "storage") throw new Error("parada de prueba") } } })
  assert.equal(report.step, "storage")
  assert.equal((await ctx.deletion(a.id)).step, "storage", "el paso de sesiones quedó hecho")
  assert.ok((await ctx.signIn(a)).error, "GoTrue rechaza un inicio de sesión nuevo")
  const refreshed = await session.client.auth.refreshSession({ refresh_token: session.session.refresh_token })
  assert.ok(refreshed.error, "y el refresh token anterior")
})
