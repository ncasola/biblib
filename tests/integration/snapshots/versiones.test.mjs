import assert from "node:assert/strict"
import { after, afterEach, before, beforeEach, test } from "node:test"
import { compiled, drizzleSql, failed, ok, snapshotsContext } from "./lib/context.mjs"

// U-DAT-02 · Versiones anteriores contra Postgres, GoTrue y la app compilada del perfil. Las acciones
// viajan por HTTP con sesiones reales de A y B; los fallos entre la captura y la publicación se
// inyectan en el publicador compilado dentro de su propia transacción. La biblioteca de A se guarda
// antes de cada prueba y se devuelve exactamente igual después.

let ctx, a, b
const day = 24 * 60 * 60 * 1000

before(async () => {
  ctx = await snapshotsContext()
  // Una ejecución anterior interrumpida pudo dejar la biblioteca de A sustituida.
  await ctx.restoreLibraries()
  await ctx.cleanup()
  a = await ctx.signIn("a")
  b = await ctx.signIn("b")
})
beforeEach(async () => { await ctx.saveLibraries() })
afterEach(async () => { await ctx.cleanup(); await ctx.restoreLibraries() })
after(async () => {
  if (!ctx) return
  await ctx.cleanup()
  await ctx.restoreLibraries()
  for (const session of [a, b]) await session?.client.auth.signOut({ scope: "local" }).catch(() => {})
  await ctx.close()
})

const sameData = (book) => ({ id: book.id, isbn: book.isbn, title: book.title, subtitle: book.subtitle, authors: book.authors, publishers: book.publishers, catalogue: book.catalogue,
  number_of_pages: book.number_of_pages, publish_date: book.publish_date, covers: [book.cover_small, book.cover_medium, book.cover_large], status: book.status, shelf_id: book.shelf_id,
  created: new Date(book.created_at).getTime() })
const snapshotOf = async (userId, operationId) => (await ctx.snapshots(userId)).filter((row) => row.source_operation_id === operationId)
const previewRestore = (session, snapshotId) => ctx.call("previewSnapshotRestoreAction", [{ snapshotId }], session)
const restore = (session, preview, idempotencyKey) => ctx.call("restoreSnapshotAction", [{ previewId: preview.previewId, expectedRevision: preview.revision, idempotencyKey }], session)

test("reemplazar A crea exactamente una versión coherente; fusionar no crea ninguna y repetir la clave no duplica", async () => {
  const before = await ctx.library(ctx.users.a)
  const count = (await ctx.snapshots(ctx.users.a)).length
  const { prepared, confirmed } = await ctx.replace(a, "reemplazo", 2)
  assert.ok(ok(confirmed), `el reemplazo debía publicarse (${confirmed.value?.error?.code ?? confirmed.status})`)
  const { operationId } = confirmed.value.value
  const [snapshot, ...extra] = await snapshotOf(ctx.users.a, operationId)
  assert.ok(snapshot, "existe la versión de la operación")
  assert.deepEqual(extra, [])
  assert.equal((await ctx.snapshots(ctx.users.a)).length, count + 1, "exactamente una versión nueva")
  assert.equal(snapshot.state, "ready")
  assert.equal(snapshot.reason, "import.replace")
  assert.equal(snapshot.captured_revision, prepared.revision, "captura la revisión que revisó la persona")
  assert.deepEqual([snapshot.counts.books, snapshot.counts.shelves], [before.books.length, before.shelves.length])
  const lifetime = new Date(snapshot.expires_at).getTime() - new Date(snapshot.created_at).getTime()
  assert.ok(Math.abs(lifetime - 30 * day) < 60_000, "se conserva 30 días")
  const chunks = await ctx.chunks(snapshot.id)
  assert.ok(chunks.every((chunk) => chunk.valid), "cada trozo conserva su hash")
  assert.ok(chunks.every((chunk) => chunk.item_count <= 200))
  const captured = chunks.filter((chunk) => chunk.kind === "books").flatMap((chunk) => chunk.payload)
  assert.deepEqual(captured.map((item) => item.id).sort(), before.books.map((row) => row.id).sort(), "contiene la colección sustituida")
  assert.deepEqual(captured.map((item) => item.title).sort(), before.books.map((row) => row.title).sort())

  const listed = await ctx.call("listLibrarySnapshotsAction", [{ limit: 20 }], a)
  assert.ok(ok(listed))
  assert.equal(listed.value.value.items[0].id, snapshot.id, "la más reciente primero")
  assert.equal(listed.value.value.items[0].reason, "import.replace")
  assert.deepEqual([listed.value.value.quota.limit, listed.value.value.retentionDays], [10, 30])

  // Respuesta perdida: repetir la confirmación devuelve el mismo resultado sin otra versión.
  const again = await ctx.call("confirmImportAction", [{ previewId: prepared.previewId, expectedRevision: prepared.revision, idempotencyKey: (await ctx.operations(ctx.users.a, "import.confirm")).find((row) => row.id === operationId).idempotency_key }], a)
  assert.ok(ok(again))
  assert.equal(again.value.value.operationId, operationId)
  assert.equal(again.value.value.replayed, true)
  assert.equal((await ctx.snapshots(ctx.users.a)).length, count + 1)

  // Fusionar no es destructivo: no captura.
  const merge = await ctx.prepare(a, ctx.importFile("fusion", 1), "merge")
  assert.ok(ok(await ctx.call("confirmImportAction", [{ previewId: merge.previewId, expectedRevision: merge.revision, idempotencyKey: ctx.key("fusion") }], a)))
  assert.equal((await ctx.snapshots(ctx.users.a)).length, count + 1)
})

test("B no puede listar, descargar, comparar, restaurar ni borrar la versión de A", async () => {
  const { confirmed } = await ctx.replace(a, "aislamiento", 1)
  assert.ok(ok(confirmed))
  const [snapshot] = await snapshotOf(ctx.users.a, confirmed.value.value.operationId)
  const listed = await ctx.call("listLibrarySnapshotsAction", [{}], b)
  assert.ok(ok(listed))
  assert.ok(!listed.value.value.items.some((item) => item.id === snapshot.id), "B no lista la versión de A")
  const preview = await previewRestore(b, snapshot.id)
  assert.ok(failed(preview, "NOT_FOUND"), "B no compara la versión de A ni confirma que existe")
  assert.ok(failed(await ctx.call("deleteLibrarySnapshotAction", [{ snapshotId: snapshot.id, expectedVersion: snapshot.version }], b), "NOT_FOUND"))
  // La vista previa propia de A tampoco sirve a B.
  const own = await previewRestore(a, snapshot.id)
  assert.ok(ok(own))
  assert.ok(failed(await restore(b, own.value.value, ctx.key("ajena")), "NOT_FOUND"), "B no restaura con la vista previa de A")
  // Descargar: ni SQL con los claims de B ni la Data API exponen los trozos.
  const visible = await ctx.asUser(ctx.users.b, (tx) => tx`select (select count(*)::int from biblib.library_snapshots where id = ${snapshot.id}) as headers, (select count(*)::int from biblib.library_snapshot_chunks where snapshot_id = ${snapshot.id}) as chunks`)
  assert.deepEqual([visible[0].headers, visible[0].chunks], [0, 0])
  const env = ctx.resolved.target.env()
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/library_snapshot_chunks?select=*`, { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${b.session.access_token}`, "Accept-Profile": "biblib" }, signal: AbortSignal.timeout(10_000) })
  assert.equal(response.status, 406, "la Data API no expone biblib")
  assert.ok((await ctx.snapshots(ctx.users.a)).some((row) => row.id === snapshot.id), "la versión de A sigue intacta")
})

test("deshacer devuelve datos y referencias con IDs propios y versiones nuevas; repetir la clave recupera el resultado", async () => {
  const before = await ctx.library(ctx.users.a)
  const { confirmed } = await ctx.replace(a, "deshacer", 2)
  assert.ok(ok(confirmed))
  const [snapshot] = await snapshotOf(ctx.users.a, confirmed.value.value.operationId)
  const preview = await previewRestore(a, snapshot.id)
  assert.ok(ok(preview), `la comparación debía prepararse (${preview.value?.error?.code})`)
  const plan = preview.value.value.plan
  assert.equal(plan.counts.booksAfter, before.books.length)
  assert.equal(plan.counts.deleted, 2, "elimina lo importado después")
  assert.equal(preview.value.value.changes.removedTotal, 2)
  assert.equal(plan.counts.reassigned, 0, "los IDs propios están disponibles")
  const revisionBefore = await ctx.revision(ctx.users.a)
  const key = ctx.key("deshacer")
  const restored = await restore(a, preview.value.value, key)
  assert.ok(ok(restored), `la restauración debía aplicarse (${restored.value?.error?.code})`)
  assert.equal(restored.value.value.replayed, false)

  const after = await ctx.library(ctx.users.a)
  assert.deepEqual(after.shelves, before.shelves, "estanterías, IDs y predeterminada")
  assert.deepEqual(after.books.map(sameData), before.books.map(sameData), "datos, IDs y referencias de estantería")
  const oldVersions = new Set(before.books.map((row) => row.version))
  assert.ok(after.books.every((row) => !oldVersions.has(row.version)), "todas las versiones de ficha son nuevas")
  assert.notEqual(await ctx.revision(ctx.users.a), revisionBefore, "la revisión de colección rota")
  const [undo] = await snapshotOf(ctx.users.a, restored.value.value.operationId)
  assert.ok(undo, "antes de restaurar se guardó el estado sustituido")
  assert.equal(undo.reason, "snapshot.restore")
  assert.equal(restored.value.value.snapshotId, undo.id)
  assert.equal(undo.counts.books, 2)

  // Respuesta perdida: la misma clave devuelve la misma operación, sin otra versión ni otra escritura.
  const count = (await ctx.snapshots(ctx.users.a)).length
  const again = await restore(a, preview.value.value, key)
  assert.ok(ok(again))
  assert.deepEqual([again.value.value.operationId, again.value.value.replayed, again.value.value.snapshotId], [restored.value.value.operationId, true, undo.id])
  assert.equal((await ctx.snapshots(ctx.users.a)).length, count)
  assert.deepEqual((await ctx.library(ctx.users.a)).books.map((row) => row.version), after.books.map((row) => row.version), "repetir no reescribe nada")
})

test("una segunda pestaña que edita antes de confirmar provoca conflicto; comparar de nuevo permite restaurar", async () => {
  const { confirmed } = await ctx.replace(a, "pestanas", 1)
  assert.ok(ok(confirmed))
  const [snapshot] = await snapshotOf(ctx.users.a, confirmed.value.value.operationId)
  const first = await previewRestore(a, snapshot.id)
  assert.ok(ok(first))
  const second = await ctx.signIn("a")
  try {
    const [shelf] = await ctx.sql`select id from biblib.shelves where user_id = ${ctx.users.a} and title = ${ctx.title("Importación pestanas")}`
    assert.ok(ok(await ctx.call("renameShelfAction", [shelf.id, ctx.title("Renombrada en otra pestaña")], second)))
  } finally {
    await second.client.auth.signOut({ scope: "local" }).catch(() => {})
  }
  const library = await ctx.library(ctx.users.a)
  const count = (await ctx.snapshots(ctx.users.a)).length
  const key = ctx.key("pestanas")
  const stale = await restore(a, first.value.value, key)
  assert.ok(failed(stale, "REVISION_CONFLICT"), `la confirmación vieja debía dar conflicto (${stale.value?.error?.code})`)
  assert.equal(stale.value.error.retryable, false)
  assert.ok(failed(await restore(a, first.value.value, key), "REVISION_CONFLICT"), "reintentar no la aplica")
  assert.deepEqual(await ctx.library(ctx.users.a), library, "nada cambia")
  assert.equal((await ctx.snapshots(ctx.users.a)).length, count, "ni se captura otra versión")

  const fresh = await previewRestore(a, snapshot.id)
  assert.ok(ok(fresh))
  assert.notEqual(fresh.value.value.revision, first.value.value.revision, "la comparación nueva usa la revisión actual")
  assert.ok(ok(await restore(a, fresh.value.value, ctx.key("pestanas-nueva"))))
})

test("un fallo entre la captura y la publicación conserva la colección original sin versión válida parcial", async () => {
  const { publisher } = compiled()
  const before = await ctx.library(ctx.users.a)
  const snapshotsBefore = await ctx.snapshots(ctx.users.a)
  const revisionBefore = await ctx.revision(ctx.users.a)
  const prepared = await ctx.prepare(a, ctx.importFile("fallo", 2), "replace")
  const key = ctx.key("fallo")
  let insideState
  await assert.rejects(ctx.asOwnerDrizzle(ctx.users.a, (tx) => publisher.publishImport(tx, { userId: ctx.users.a, previewId: prepared.previewId, expectedRevision: prepared.revision, idempotencyKey: key }, {
    afterCapture: async (snapshotId) => {
      const rows = await tx.execute(drizzleSql`select state from biblib.library_snapshots where id = ${snapshotId}`)
      insideState = rows[0]?.state
      throw new Error("fallo simulado entre la captura y la publicación")
    },
  })), /fallo simulado/)
  assert.equal(insideState, "ready", "la captura estaba completa dentro de la transacción")
  assert.deepEqual(await ctx.library(ctx.users.a), before, "la colección original no cambia (ni sus versiones)")
  assert.deepEqual((await ctx.snapshots(ctx.users.a)).map((row) => row.id), snapshotsBefore.map((row) => row.id), "no queda ninguna versión de la captura")
  assert.equal((await ctx.sql`select count(*)::int as n from biblib.library_operations where user_id = ${ctx.users.a} and idempotency_key = ${key}`)[0].n, 0)
  assert.equal(await ctx.revision(ctx.users.a), revisionBefore)

  // La misma vista previa sigue sin consumir: confirmarla por la app la publica con una sola versión.
  const confirmed = await ctx.call("confirmImportAction", [{ previewId: prepared.previewId, expectedRevision: prepared.revision, idempotencyKey: ctx.key("fallo-app") }], a)
  assert.ok(ok(confirmed))
  const [snapshot, ...extra] = await snapshotOf(ctx.users.a, confirmed.value.value.operationId)
  assert.ok(snapshot)
  assert.deepEqual(extra, [])

  // Lo mismo al restaurar: un fallo tras capturar el estado actual no restaura ni deja versión.
  const replaced = await ctx.library(ctx.users.a)
  const count = (await ctx.snapshots(ctx.users.a)).length
  const preview = await previewRestore(a, snapshot.id)
  assert.ok(ok(preview))
  await assert.rejects(ctx.asOwnerDrizzle(ctx.users.a, (tx) => publisher.publishSnapshotRestore(tx, { userId: ctx.users.a, previewId: preview.value.value.previewId, expectedRevision: preview.value.value.revision, idempotencyKey: ctx.key("fallo-restaurar") }, {
    afterCapture: () => { throw new Error("fallo simulado al restaurar") },
  })), /fallo simulado al restaurar/)
  assert.deepEqual(await ctx.library(ctx.users.a), replaced)
  assert.equal((await ctx.snapshots(ctx.users.a)).length, count)
})

test("caducidad: una versión vencida no se lista ni se restaura y la siguiente captura la retira", async () => {
  const { confirmed } = await ctx.replace(a, "caducidad", 1)
  assert.ok(ok(confirmed))
  const [snapshot] = await snapshotOf(ctx.users.a, confirmed.value.value.operationId)
  const preview = await previewRestore(a, snapshot.id)
  assert.ok(ok(preview))
  await ctx.sql`update biblib.library_snapshots set expires_at = created_at + interval '1 millisecond' where id = ${snapshot.id}`
  const listed = await ctx.call("listLibrarySnapshotsAction", [{ limit: 20 }], a)
  assert.ok(ok(listed))
  assert.ok(!listed.value.value.items.some((item) => item.id === snapshot.id), "una versión vencida no se lista")
  const library = await ctx.library(ctx.users.a)
  const late = await restore(a, preview.value.value, ctx.key("caducidad"))
  assert.ok(failed(late, "PREVIEW_EXPIRED"), `restaurar una versión vencida no se aplica (${late.value?.error?.code})`)
  assert.match(late.value.error.message, /caducado/)
  assert.ok(failed(await previewRestore(a, snapshot.id), "PREVIEW_EXPIRED"))
  assert.deepEqual(await ctx.library(ctx.users.a), library)
  const next = await ctx.replace(a, "caducidad-2", 1)
  assert.ok(ok(next.confirmed))
  assert.ok(!(await ctx.snapshots(ctx.users.a)).some((row) => row.id === snapshot.id), "la siguiente captura retira la vencida")
})

test("cuota agotada: bloquea reemplazar y restaurar con un mensaje claro sin borrar ninguna versión", async () => {
  await ctx.fillQuota(ctx.users.a, 10)
  const ids = (await ctx.snapshots(ctx.users.a)).map((row) => row.id)
  assert.equal(ids.length, 10)
  const library = await ctx.library(ctx.users.a)
  const { confirmed } = await ctx.replace(a, "cuota", 1)
  assert.ok(failed(confirmed, "LIMIT_EXCEEDED"), `el reemplazo debía bloquearse (${confirmed.value?.error?.code})`)
  assert.equal(confirmed.value.error.retryable, false)
  assert.match(confirmed.value.error.message, /No se ha reemplazado nada/)
  assert.match(confirmed.value.error.message, /Elimina alguna versión/)
  assert.deepEqual(await ctx.library(ctx.users.a), library, "la colección no cambia")
  assert.deepEqual((await ctx.snapshots(ctx.users.a)).map((row) => row.id), ids, "ninguna versión se borra en silencio")
  const listed = await ctx.call("listLibrarySnapshotsAction", [{ limit: 20 }], a)
  assert.deepEqual(listed.value.value.quota, { used: 10, limit: 10 })

  const preview = await previewRestore(a, ids[0])
  assert.ok(ok(preview))
  const blocked = await restore(a, preview.value.value, ctx.key("cuota-restaurar"))
  assert.ok(failed(blocked, "LIMIT_EXCEEDED"))
  assert.match(blocked.value.error.message, /máximo de 10 versiones/)
  assert.deepEqual(await ctx.library(ctx.users.a), library)

  // Liberar una plaza de forma explícita permite reemplazar con una confirmación nueva.
  const [oldest] = await ctx.snapshots(ctx.users.a)
  assert.ok(ok(await ctx.call("deleteLibrarySnapshotAction", [{ snapshotId: oldest.id, expectedVersion: oldest.version }], a)))
  assert.ok(ok((await ctx.replace(a, "cuota-liberada", 1)).confirmed))
})

test("borrar la versión mientras se prepara la restauración: confirmar no aplica nada", async () => {
  const { confirmed } = await ctx.replace(a, "borrado", 1)
  assert.ok(ok(confirmed))
  const [snapshot] = await snapshotOf(ctx.users.a, confirmed.value.value.operationId)
  const preview = await previewRestore(a, snapshot.id)
  assert.ok(ok(preview))
  assert.ok(failed(await ctx.call("deleteLibrarySnapshotAction", [{ snapshotId: snapshot.id, expectedVersion: "00000000-0000-4000-8000-000000000000" }], a), "CONFLICT"), "una versión antigua no autoriza el borrado")
  assert.ok(ok(await ctx.call("deleteLibrarySnapshotAction", [{ snapshotId: snapshot.id, expectedVersion: snapshot.version }], a)))
  const library = await ctx.library(ctx.users.a)
  const result = await restore(a, preview.value.value, ctx.key("borrado"))
  assert.ok(failed(result, "NOT_FOUND"), `la restauración debía rechazarse (${result.value?.error?.code})`)
  assert.match(result.value.error.message, /ya no está disponible/)
  assert.deepEqual(await ctx.library(ctx.users.a), library)
  assert.equal((await ctx.sql`select count(*)::int as n from biblib.import_previews where id = ${preview.value.value.previewId}`)[0].n, 0, "la vista previa cayó con su versión")
})

test("una cuenta bloqueada no admite versiones nuevas: ni restaurar ni reemplazar aplican nada", async () => {
  const { confirmed } = await ctx.replace(a, "bloqueo", 1)
  assert.ok(ok(confirmed))
  const [snapshot] = await snapshotOf(ctx.users.a, confirmed.value.value.operationId)
  const preview = await previewRestore(a, snapshot.id)
  assert.ok(ok(preview))
  await ctx.sql`select biblib.account_set_state(${ctx.users.a}, 'blocked')`
  try {
    const library = await ctx.library(ctx.users.a)
    const count = (await ctx.snapshots(ctx.users.a)).length
    assert.ok(failed(await restore(a, preview.value.value, ctx.key("bloqueo")), "UNAUTHORIZED"))
    const replaced = await ctx.replace(a, "bloqueo-2", 1)
    assert.ok(failed(replaced.confirmed, "UNAUTHORIZED"))
    assert.deepEqual(await ctx.library(ctx.users.a), library)
    assert.equal((await ctx.snapshots(ctx.users.a)).length, count)
  } finally {
    await ctx.sql`select biblib.account_set_state(${ctx.users.a}, 'active')`
  }
})
