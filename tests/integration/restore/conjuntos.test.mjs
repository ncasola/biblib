import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { after, afterEach, before, beforeEach, test } from "node:test"
import { CHUNK, drizzleSql, failed, ok, restoreContext, sha256 } from "./lib/context.mjs"

// U-DAT-04 · Restauración de todas las partes contra Postgres, GoTrue y la app compilada del perfil.
// Las acciones viajan por HTTP con sesiones reales de A y B (los trozos en multipart, como el
// navegador); los fallos y timeouts de la transacción final se inyectan en el publicador compilado.
// La biblioteca de A se guarda antes de cada prueba y se devuelve exactamente igual después.

let ctx, a, b
before(async () => {
  ctx = await restoreContext()
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

const count = async (userId) => (await ctx.sql`select count(*)::int as n from biblib.books where user_id = ${userId}`)[0].n
const titles = async (userId) => new Set((await ctx.sql`select title from biblib.books where user_id = ${userId}`).map((row) => row.title))

test("2001 libros en dos partes se publican juntos; los observadores ven la colección anterior o la nueva, nunca una mezcla", async () => {
  const before = await ctx.libraryRows(ctx.users.a)
  const library = ctx.library("conjunto", 2001, { shelves: 3, empty: 1 })
  const set = ctx.backupSet(library)
  assert.equal(set.files.length, 2)
  assert.ok(set.bytes[0].byteLength > CHUNK, "la primera parte viaja en varios trozos")
  const { view, validated, prepared } = await ctx.staged(a, set)
  assert.equal(view.parts[0].totalChunks, Math.ceil(set.bytes[0].byteLength / CHUNK))
  assert.deepEqual(validated.session.totals, { books: 2001, shelves: 4 })
  assert.equal(validated.manifest.exportSetId, set.manifest.exportSetId)
  assert.equal(prepared.plan.counts.booksAfter, 2001)
  assert.equal(prepared.plan.counts.deleted, before.books.length)
  assert.equal(await count(ctx.users.a), before.books.length, "subir, validar y preparar no tocan la colección activa")

  // Observadores en otra conexión mientras la app publica: cuentan libros de A en bucle.
  const seen = new Set()
  let watching = true
  const observer = (async () => { while (watching) { seen.add(await count(ctx.users.a)); await new Promise((resolve) => setTimeout(resolve, 2)) } })()
  const revisionBefore = await ctx.revision(ctx.users.a)
  const key = ctx.key("conjunto")
  const committed = await ctx.commit(a, prepared, key)
  watching = false
  await observer
  assert.ok(ok(committed), `la publicación debía aplicarse (${committed.value?.error?.code ?? committed.status})`)
  seen.add(await count(ctx.users.a))
  assert.deepEqual([...seen].filter((n) => n !== before.books.length && n !== 2001), [], `solo se observan ${before.books.length} o 2001 libros, nunca un estado intermedio (${[...seen].join(", ")})`)
  assert.ok(seen.has(2001))

  const afterRows = await ctx.libraryRows(ctx.users.a)
  assert.equal(afterRows.books.length, 2001)
  assert.deepEqual(new Set(afterRows.books.map((row) => row.title)), new Set(library.books.map((book) => book.title)), "todas las fichas de las dos partes")
  assert.equal(afterRows.shelves.length, 4, "la predeterminada propia y las tres de la copia, incluida la vacía")
  const defaultBefore = before.shelves.find((shelf) => shelf.is_default)
  assert.ok(afterRows.shelves.some((shelf) => shelf.id === defaultBefore.id && shelf.is_default), "se conserva la estantería predeterminada de A")
  assert.ok(afterRows.shelves.some((shelf) => shelf.title === library.shelves.at(-1).title), "la estantería vacía se restaura")
  assert.notEqual(await ctx.revision(ctx.users.a), revisionBefore)

  const { operationId, snapshotId, result, replayed } = committed.value.value
  assert.equal(replayed, false)
  assert.deepEqual([result.imported, result.deleted, result.shelves], [2001, before.books.length, 4])
  const [snapshot] = (await ctx.snapshots(ctx.users.a)).filter((row) => row.source_operation_id === operationId)
  assert.ok(snapshot && snapshot.id === snapshotId && snapshot.state === "ready", "la versión anterior se capturó en la misma transacción")
  assert.equal(snapshot.counts.books, before.books.length)
  const stored = await ctx.session(view.sessionId)
  assert.deepEqual([stored.state, stored.operation_id], ["committed", operationId])
  assert.deepEqual(await ctx.staging(view.sessionId), { chunks: 0, rows: 0 }, "tras publicar se libera el staging")
})

test("parte ausente, duplicada, corrupta o de otro conjunto y total falso: MANIFEST_MISMATCH sin tocar la colección", async () => {
  const before = await ctx.libraryRows(ctx.users.a)
  const set = ctx.backupSet(ctx.library("defectos", 2001))
  const other = ctx.backupSet(ctx.library("otro", 2001))

  // Ausente: solo se sube la primera parte.
  const missing = await ctx.begin(a, { manifest: set.manifestObject })
  assert.ok(ok(missing))
  const firstOnly = { ...missing.value.value, parts: missing.value.value.parts.slice(0, 1) }
  await ctx.uploadAll(a, firstOnly, set.bytes)
  const incomplete = await ctx.call("validateRestoreSessionAction", [{ sessionId: missing.value.value.sessionId }], a)
  assert.ok(failed(incomplete, "MANIFEST_MISMATCH"), `parte ausente (${incomplete.value?.error?.code})`)
  assert.match(incomplete.value.error.message, /Faltan 1 de 2 partes/)
  assert.equal((await ctx.session(missing.value.value.sessionId)).state, "receiving", "la sesión sigue abierta para completar la subida")
  await ctx.call("discardRestoreSessionAction", [{ sessionId: missing.value.value.sessionId }], a)

  // Duplicada: la misma parte dos veces, con manifiesto o suelta.
  const duplicated = { ...set.manifestObject, parts: [set.manifestObject.parts[0], { ...set.manifestObject.parts[0], partId: "parte-02", index: 1 }] }
  assert.ok(failed(await ctx.begin(a, { manifest: duplicated }), "MANIFEST_MISMATCH"))
  assert.ok(failed(await ctx.begin(a, { parts: [set.bytes[0], set.bytes[0]].map((bytes) => ({ byteLength: bytes.byteLength, sha256: sha256(bytes) })) }), "MANIFEST_MISMATCH"))

  // Total falso: el manifiesto lo rechaza antes de recibir ningún byte.
  const lying = { ...set.manifestObject, totals: { books: 2002, shelves: set.manifestObject.totals.shelves } }
  assert.ok(failed(await ctx.begin(a, { manifest: lying }), "MANIFEST_MISMATCH"))

  // Recuentos de parte falsos pero sumas coherentes: lo detecta la validación del contenido.
  const counts = { ...set.manifestObject, parts: [{ ...set.manifestObject.parts[0], counts: { ...set.manifestObject.parts[0].counts, books: 1999 } }, { ...set.manifestObject.parts[1], counts: { ...set.manifestObject.parts[1].counts, books: 2 } }] }
  const countsSession = await ctx.begin(a, { manifest: counts })
  assert.ok(ok(countsSession))
  await ctx.uploadAll(a, countsSession.value.value, set.bytes)
  assert.ok(failed(await ctx.call("validateRestoreSessionAction", [{ sessionId: countsSession.value.value.sessionId }], a), "MANIFEST_MISMATCH"))
  assert.equal((await ctx.session(countsSession.value.value.sessionId)).state, "rejected")
  assert.deepEqual(await ctx.staging(countsSession.value.value.sessionId), { chunks: 0, rows: 0 }, "un rechazo libera el staging")

  // Corrupta: mismo tamaño, un byte distinto; cada trozo llega íntegro pero la parte no es la del manifiesto.
  const corrupt = Buffer.from(set.bytes[1])
  corrupt[corrupt.length - 3] = corrupt[corrupt.length - 3] === 0x31 ? 0x32 : 0x31
  const corruptSession = await ctx.begin(a, { manifest: set.manifestObject })
  await ctx.uploadAll(a, corruptSession.value.value, [set.bytes[0], corrupt])
  const damaged = await ctx.call("validateRestoreSessionAction", [{ sessionId: corruptSession.value.value.sessionId }], a)
  assert.ok(failed(damaged, "MANIFEST_MISMATCH"))
  assert.match(damaged.value.error.message, /dañada o pertenece a otra copia/)
  // Un trozo dañado en tránsito (hash declarado distinto) no se guarda.
  const transit = await ctx.begin(a, { manifest: set.manifestObject })
  const part = transit.value.value.parts[1]
  assert.ok(failed(await ctx.upload(a, { sessionId: transit.value.value.sessionId, partId: part.partId, ordinal: 0, total: part.totalChunks, sha256: sha256(set.bytes[1]) }, corrupt.subarray(0, CHUNK)), "MANIFEST_MISMATCH"))
  assert.deepEqual(await ctx.staging(transit.value.value.sessionId), { chunks: 0, rows: 0 })
  await ctx.call("discardRestoreSessionAction", [{ sessionId: transit.value.value.sessionId }], a)

  // De otro conjunto: la segunda parte de otra copia en lugar de la propia.
  const mixed = await ctx.begin(a, { parts: [set.bytes[0], other.bytes[1]].map((bytes) => ({ byteLength: bytes.byteLength, sha256: sha256(bytes) })) })
  assert.ok(ok(mixed))
  await ctx.uploadAll(a, mixed.value.value, [set.bytes[0], other.bytes[1]])
  const foreign = await ctx.call("validateRestoreSessionAction", [{ sessionId: mixed.value.value.sessionId }], a)
  assert.ok(failed(foreign, "MANIFEST_MISMATCH"), `parte de otra copia (${foreign.value?.error?.code}: ${foreign.value?.error?.message})`)
  assert.deepEqual(await ctx.libraryRows(ctx.users.a), before, "ningún rechazo cambia la colección activa ni sus versiones")
})

test("estanterías vacías y compartidas entre partes: compatibles se unen; contradictorias se rechazan", async () => {
  // Las partes sueltas de una copia comparten estanterías por ID; una vacía viaja en la última parte.
  // 2002 libros alternos: la estantería 2 tiene libros en las dos partes.
  const library = ctx.library("compartidas", 2002, { shelves: 2, empty: 2 })
  const set = ctx.backupSet(library)
  const shared = library.shelves[1].id
  assert.ok(set.files.every((file) => JSON.parse(file.text).shelves.some((shelf) => shelf.id === shared)), "la estantería con libros está en las dos partes")
  const { prepared } = await ctx.staged(a, set, { loose: true })
  assert.equal(prepared.plan.shelves.create.length, 3, "una sola copia de la compartida y las dos vacías")
  assert.ok(ok(await ctx.commit(a, prepared, ctx.key("compartidas"))))
  const rows = await ctx.libraryRows(ctx.users.a)
  const sharedTitle = library.shelves[1].title
  const sharedRow = rows.shelves.find((shelf) => shelf.title === sharedTitle)
  assert.equal(rows.books.filter((book) => book.shelf_id === sharedRow.id).length, 1001, "todos sus libros en una única estantería")
  assert.ok(library.shelves.slice(2).every((shelf) => rows.shelves.some((row) => row.title === shelf.title)), "las vacías existen")

  // La misma estantería con otro nombre en otra parte es una contradicción.
  const first = JSON.parse(set.files[0].text)
  const second = JSON.parse(set.files[1].text)
  second.shelves = second.shelves.map((shelf) => shelf.id === shared ? { ...shelf, title: `${shelf.title} (otra)` } : shelf)
  second.books = second.books.map((book) => book.shelf_id === shared ? { ...book, shelf_name: `${book.shelf_name} (otra)` } : book)
  const parts = [Buffer.from(JSON.stringify(first)), Buffer.from(JSON.stringify(second))]
  const begun = await ctx.begin(a, { parts: parts.map((bytes) => ({ byteLength: bytes.byteLength, sha256: sha256(bytes) })) })
  await ctx.uploadAll(a, begun.value.value, parts)
  const contradiction = await ctx.call("validateRestoreSessionAction", [{ sessionId: begun.value.value.sessionId }], a)
  assert.ok(failed(contradiction, "MANIFEST_MISMATCH"))
  assert.match(contradiction.value.error.message, /datos distintos en varias partes/)
})

test("un error en la última sentencia o un timeout lo revierten todo, incluido el indicador de éxito, y conservan el staging", async () => {
  const { staging } = ctx.modules
  const before = await ctx.libraryRows(ctx.users.a)
  const snapshotsBefore = (await ctx.snapshots(ctx.users.a)).map((row) => row.id)
  const revisionBefore = await ctx.revision(ctx.users.a)
  const { view, prepared } = await ctx.staged(a, ctx.backupSet(ctx.library("fallo", 2001)))
  const stagingBefore = await ctx.staging(view.sessionId)
  const request = { userId: ctx.users.a, sessionId: view.sessionId, previewId: prepared.previewId, expectedRevision: prepared.revision, idempotencyKey: ctx.key("fallo") }
  const unchanged = async (label) => {
    assert.deepEqual(await ctx.libraryRows(ctx.users.a), before, `${label}: la colección (con sus versiones de ficha) no cambia`)
    assert.deepEqual((await ctx.snapshots(ctx.users.a)).map((row) => row.id), snapshotsBefore, `${label}: ninguna versión anterior anunciada`)
    assert.equal(await ctx.revision(ctx.users.a), revisionBefore, `${label}: la revisión no rota`)
    assert.equal((await ctx.sql`select count(*)::int as n from biblib.library_operations where user_id = ${ctx.users.a} and idempotency_key = ${request.idempotencyKey}`)[0].n, 0, `${label}: sin operación registrada`)
    const session = await ctx.session(view.sessionId)
    assert.deepEqual([session.state, session.operation_id], ["prepared", null], `${label}: la sesión sigue preparada`)
    assert.deepEqual(await ctx.staging(view.sessionId), stagingBefore, `${label}: el staging se conserva`)
  }

  // Error real de Postgres justo antes de la última sentencia, ya insertados los 2001 libros.
  let inside
  await assert.rejects(ctx.asOwnerDrizzle(ctx.users.a, (tx) => staging.publishRestoreSession(tx, request, { hooks: {
    beforeFinalize: async () => {
      inside = (await tx.execute(drizzleSql`select count(*)::int as n from biblib.books where user_id = ${ctx.users.a}`))[0].n
      await tx.execute(drizzleSql`select 1 / 0`)
    },
  } })), (error) => /division by zero|22012/.test(String(error?.cause?.code ?? error?.code ?? error?.message)))
  assert.equal(inside, 2001, "dentro de la transacción ya estaban publicados")
  await unchanged("error en la última sentencia")

  // Timeout de sentencia: con un presupuesto de 1 ms por sentencia la inserción masiva se cancela.
  await assert.rejects(ctx.asOwnerDrizzle(ctx.users.a, (tx) => staging.publishRestoreSession(tx, request, { budget: { lockTimeoutMs: 1000, statementTimeoutMs: 1, totalMs: 15_000 } })),
    (error) => String(error?.cause?.code ?? error?.code) === "57014")
  await unchanged("statement_timeout")
  // Presupuesto total agotado tras capturar la versión anterior.
  await assert.rejects(ctx.asOwnerDrizzle(ctx.users.a, (tx) => staging.publishRestoreSession(tx, request, { budget: { lockTimeoutMs: 1000, statementTimeoutMs: 5000, totalMs: 2_000 },
    hooks: { afterCapture: () => new Promise((resolve) => setTimeout(resolve, 2_100)) } })), (error) => error?.code === "PROVIDER_UNAVAILABLE" && /no ha cabido/.test(error.message))
  await unchanged("presupuesto total")

  // El mismo staging y la misma clave publican después por la app, con una sola versión anterior.
  const committed = await ctx.commit(a, prepared, request.idempotencyKey)
  assert.ok(ok(committed), `tras los fallos se publica (${committed.value?.error?.code})`)
  assert.equal(await count(ctx.users.a), 2001)
  assert.equal((await ctx.snapshots(ctx.users.a)).length, snapshotsBefore.length + 1)
})

test("lock_timeout de 1 s: otra transacción con el bloqueo de colección hace fallar la publicación sin aplicar nada", async () => {
  const before = await ctx.libraryRows(ctx.users.a)
  const { view, prepared } = await ctx.staged(a, ctx.backupSet(ctx.library("bloqueo", 3)))
  let release
  const held = new Promise((resolve) => { release = resolve })
  let locked
  const locking = new Promise((resolve) => { locked = resolve })
  const holder = ctx.asUser(ctx.users.a, async (tx) => { await tx`select biblib.lock_library()`; locked(); await held })
  await locking
  try {
    const started = Date.now()
    const busy = await ctx.commit(a, prepared, ctx.key("bloqueo"))
    assert.ok(failed(busy, "PROVIDER_UNAVAILABLE"), `con el bloqueo ocupado (${busy.value?.error?.code})`)
    assert.equal(busy.value.error.retryable, true)
    assert.ok(Date.now() - started < 4_000, "falla pronto por lock_timeout")
  } finally { release(); await holder }
  assert.deepEqual(await ctx.libraryRows(ctx.users.a), before)
  assert.equal((await ctx.session(view.sessionId)).state, "prepared")
  assert.ok(ok(await ctx.commit(a, prepared, ctx.key("bloqueo-libre"))))
})

test("repetir una parte o el commit da el mismo resultado; el mismo partId con otros bytes es conflicto", async () => {
  const set = ctx.backupSet(ctx.library("repetir", 5))
  const begun = await ctx.begin(a, { manifest: set.manifestObject })
  const view = begun.value.value
  const part = view.parts[0]
  const input = { sessionId: view.sessionId, partId: part.partId, ordinal: 0, total: part.totalChunks }
  const first = await ctx.upload(a, input, set.bytes[0])
  assert.ok(ok(first))
  assert.equal(first.value.value.replayed, false)
  const again = await ctx.upload(a, input, set.bytes[0])
  assert.ok(ok(again))
  assert.deepEqual([again.value.value.replayed, again.value.value.receivedBytes], [true, first.value.value.receivedBytes], "repetir el trozo no cambia nada")
  const altered = Buffer.from(set.bytes[0]); altered[10] = altered[10] === 0x61 ? 0x62 : 0x61
  const conflict = await ctx.upload(a, input, altered)
  assert.ok(failed(conflict, "CONFLICT"), `otros bytes en la misma posición (${conflict.value?.error?.code})`)
  assert.equal((await ctx.staging(view.sessionId)).chunks, 1)
  // Trozo fuera de rango o con otro total: no se acepta.
  assert.ok(failed(await ctx.upload(a, { ...input, ordinal: 1 }, set.bytes[0]), "MANIFEST_MISMATCH"))
  assert.ok(failed(await ctx.upload(a, { ...input, total: 2 }, set.bytes[0]), "MANIFEST_MISMATCH"))

  assert.ok(ok(await ctx.call("validateRestoreSessionAction", [{ sessionId: view.sessionId }], a)))
  assert.ok(ok(await ctx.call("validateRestoreSessionAction", [{ sessionId: view.sessionId }], a)), "validar dos veces devuelve el resultado")
  assert.ok(failed(await ctx.upload(a, { ...input }, altered), "CONFLICT"), "una sesión validada no admite otros bytes")
  const prepared = (await ctx.call("prepareRestoreSessionAction", [{ sessionId: view.sessionId }], a)).value.value
  const key = ctx.key("repetir")
  const committed = await ctx.commit(a, prepared, key)
  assert.ok(ok(committed))
  const snapshots = (await ctx.snapshots(ctx.users.a)).length
  const versions = (await ctx.libraryRows(ctx.users.a)).books.map((row) => row.version)
  const replay = await ctx.commit(a, prepared, key)
  assert.ok(ok(replay))
  assert.deepEqual([replay.value.value.operationId, replay.value.value.replayed, replay.value.value.snapshotId], [committed.value.value.operationId, true, committed.value.value.snapshotId])
  assert.equal((await ctx.snapshots(ctx.users.a)).length, snapshots, "sin otra versión anterior")
  assert.deepEqual((await ctx.libraryRows(ctx.users.a)).books.map((row) => row.version), versions, "sin otra escritura")
  assert.ok(failed(await ctx.commit(a, prepared, ctx.key("repetir-otra")), "CONFLICT"), "otra clave sobre una restauración publicada no la repite")
  assert.equal((await ctx.operations(ctx.users.a)).length, 1)
})

test("una edición en otra pestaña durante el staging invalida el CAS, conserva el staging y exige revisar", async () => {
  const { view, prepared } = await ctx.staged(a, ctx.backupSet(ctx.library("pestanas", 4)))
  const second = await ctx.signIn("a")
  try {
    const [shelf] = await ctx.sql`select id from biblib.shelves where user_id = ${ctx.users.a} and not is_default order by id limit 1`
    const created = shelf ?? null
    if (created) assert.ok(ok(await ctx.call("renameShelfAction", [created.id, ctx.title("Renombrada en otra pestaña")], second)))
    else assert.ok(ok(await ctx.call("createShelfAction", [ctx.title("Creada en otra pestaña")], second)))
  } finally {
    await second.client.auth.signOut({ scope: "local" }).catch(() => {})
  }
  const library = await ctx.libraryRows(ctx.users.a)
  const stagingBefore = await ctx.staging(view.sessionId)
  const key = ctx.key("pestanas")
  const stale = await ctx.commit(a, prepared, key)
  assert.ok(failed(stale, "REVISION_CONFLICT"), `la confirmación vieja da conflicto (${stale.value?.error?.code})`)
  assert.equal(stale.value.error.retryable, false)
  assert.match(stale.value.error.message, /las partes se conservan/)
  assert.ok(failed(await ctx.commit(a, prepared, key), "REVISION_CONFLICT"), "reintentar no la aplica")
  assert.deepEqual(await ctx.libraryRows(ctx.users.a), library, "nada cambia")
  assert.deepEqual(await ctx.staging(view.sessionId), stagingBefore, "el staging se conserva")
  const fresh = await ctx.call("prepareRestoreSessionAction", [{ sessionId: view.sessionId }], a)
  assert.ok(ok(fresh))
  assert.notEqual(fresh.value.value.revision, prepared.revision)
  assert.notEqual(fresh.value.value.previewId, prepared.previewId)
  assert.ok(failed(await ctx.commit(a, prepared, ctx.key("pestanas-vieja")), "NOT_FOUND"), "la vista previa sustituida ya no sirve")
  assert.ok(ok(await ctx.commit(a, fresh.value.value, ctx.key("pestanas-nueva"))))
  assert.equal(await count(ctx.users.a), 4)
})

test("A/B: B no ve, sube, valida, prepara, publica ni descarta la restauración de A, ni por SQL ni por la Data API", async () => {
  const set = ctx.backupSet(ctx.library("aislamiento", 3))
  const { view, prepared } = await ctx.staged(a, set)
  const bLibrary = await ctx.libraryRows(ctx.users.b)
  const sessionId = view.sessionId
  for (const [name, args] of [["validateRestoreSessionAction", [{ sessionId }]], ["prepareRestoreSessionAction", [{ sessionId }]],
    ["commitRestoreSessionAction", [{ sessionId, previewId: prepared.previewId, expectedRevision: prepared.revision, idempotencyKey: ctx.key("ajena") }]], ["discardRestoreSessionAction", [{ sessionId }]]]) {
    assert.ok(failed(await ctx.call(name, args, b), "NOT_FOUND"), `${name} como B no confirma que exista`)
  }
  assert.ok(failed(await ctx.upload(b, { sessionId, partId: view.parts[0].partId, ordinal: 0, total: view.parts[0].totalChunks }, set.bytes[0]), "NOT_FOUND"))
  const listed = await ctx.call("listRestoreSessionsAction", [], b)
  assert.ok(ok(listed))
  assert.ok(!listed.value.value.some((item) => item.sessionId === sessionId))
  // Anónimo: el proxy redirige la acción sin ejecutarla.
  const anonymous = await ctx.call("validateRestoreSessionAction", [{ sessionId }])
  assert.equal(anonymous.status, 307)

  // SQL con los claims de B: no ve ni escribe el staging de A.
  const visible = await ctx.asUser(ctx.users.b, (tx) => tx`select (select count(*)::int from biblib.import_sessions where id = ${sessionId}) as sessions,
    (select count(*)::int from biblib.import_session_chunks where session_id = ${sessionId}) as chunks, (select count(*)::int from biblib.import_session_rows where session_id = ${sessionId}) as rows`)
  assert.deepEqual([visible[0].sessions, visible[0].chunks, visible[0].rows], [0, 0, 0])
  const updated = await ctx.asUser(ctx.users.b, (tx) => tx`update biblib.import_sessions set state = 'rejected' where id = ${sessionId}`)
  assert.equal(updated.count, 0)
  await assert.rejects(ctx.asUser(ctx.users.b, (tx) => tx`insert into biblib.import_session_rows (session_id, user_id, kind, row_key, part_index, position, data) values (${sessionId}, ${ctx.users.a}, 'book', 'intruso', 0, 0, '{}')`))
  // Data API: el esquema biblib no está expuesto.
  const env = ctx.resolved.target.env()
  for (const table of ["import_sessions", "import_session_chunks", "import_session_rows"]) {
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?select=*`, { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${b.session.access_token}`, "Accept-Profile": "biblib" }, signal: AbortSignal.timeout(10_000) })
    assert.equal(response.status, 406, `la Data API no expone biblib.${table}`)
  }
  assert.equal((await ctx.session(sessionId)).state, "prepared", "la sesión de A sigue intacta")
  assert.deepEqual(await ctx.libraryRows(ctx.users.b), bLibrary, "la biblioteca de B no cambia")
  assert.ok(ok(await ctx.commit(a, prepared, ctx.key("aislamiento"))), "A sí publica")
  assert.deepEqual(await ctx.libraryRows(ctx.users.b), bLibrary, "publicar A no toca B")
})

test("límites: más de 10 000 libros o de 80 MiB dan LIMIT_EXCEEDED antes de recibir bytes", async () => {
  const before = await ctx.libraryRows(ctx.users.a)
  const set = ctx.backupSet(ctx.library("limites", 3))
  const big = { ...set.manifestObject, parts: Array.from({ length: 6 }, (_, index) => ({ partId: `parte-0${index + 1}`, index, byteLength: 1000, sha256: sha256(String(index)), counts: { books: 2000, shelves: 1 } })), totals: { books: 12_000, shelves: 1 } }
  const tooMany = await ctx.begin(a, { manifest: big })
  assert.ok(failed(tooMany, "LIMIT_EXCEEDED"), `más de 10 000 libros (${tooMany.value?.error?.code})`)
  assert.match(tooMany.value.error.message, /No se ha modificado nada/)
  const heavy = await ctx.begin(a, { parts: Array.from({ length: 11 }, (_, index) => ({ byteLength: 8 * 1024 * 1024, sha256: sha256(`p${index}`) })) })
  assert.ok(failed(heavy, "LIMIT_EXCEEDED"), "más de 80 MiB")
  assert.equal((await ctx.sql`select count(*)::int as n from biblib.import_sessions where user_id = ${ctx.users.a} and created_at >= now() - interval '1 minute' and state = 'receiving' and part_count > 5`)[0].n, 0, "no se abre ninguna sesión")
  assert.deepEqual(await ctx.libraryRows(ctx.users.a), before)
})

test("las 111 fichas legacy restauran sin pérdida y una parte v1 sola sigue siendo importable", async () => {
  const fixture = readFileSync("tests/fixtures/import/sintetico-111.json")
  const parsed = JSON.parse(fixture.toString("utf8"))
  // Como parte suelta (sin manifiesto): el servidor la inspecciona y genera el manifiesto.
  const bytes = Buffer.from(fixture)
  const begun = await ctx.begin(a, { parts: [{ byteLength: bytes.byteLength, sha256: sha256(bytes) }] })
  assert.ok(ok(begun))
  await ctx.uploadAll(a, begun.value.value, [bytes])
  const validated = await ctx.call("validateRestoreSessionAction", [{ sessionId: begun.value.value.sessionId }], a)
  assert.ok(ok(validated), `validación (${validated.value?.error?.message})`)
  assert.equal(validated.value.value.manifest.parts[0].sha256, sha256(bytes), "el manifiesto generado acredita los bytes exactos")
  assert.ok(validated.value.value.warnings.some((warning) => /no traían manifiesto/.test(warning)))
  const prepared = await ctx.call("prepareRestoreSessionAction", [{ sessionId: begun.value.value.sessionId }], a)
  assert.ok(ok(await ctx.commit(a, prepared.value.value, ctx.key("legacy"))))
  const rows = await ctx.libraryRows(ctx.users.a)
  assert.equal(rows.books.length, 111)
  const manual = parsed.books.filter((book) => book.isbn.startsWith("manual-")).map((book) => book.isbn).sort()
  assert.equal(manual.length, 9)
  assert.deepEqual(rows.books.filter((row) => row.isbn.startsWith("manual-")).map((row) => row.isbn).sort(), manual, "los identificadores manuales se conservan")
  const sourceById = new Map(parsed.books.map((book) => [book.title, book]))
  for (const row of rows.books) {
    const source = sourceById.get(row.title)
    assert.equal(row.status, source.status)
    if (source.catalogue) assert.equal(row.catalogue.source, source.catalogue.source, "la procedencia se conserva")
  }

  // La misma parte por la importación de un solo archivo (U-DAT-01) sigue funcionando.
  const single = await ctx.call("prepareImportAction", [parsed, "merge"], a)
  assert.ok(ok(single), `importación de una parte (${single.value?.error?.code})`)
  assert.equal(single.value.value.plan.counts.skipped, 111, "fusionar la misma copia omite las fichas ya presentes")
})

test("el restore administrativo trata el staging: integridad de trozos y sesiones sin publicar para revisión", async () => {
  const { verifyRestoredSessions } = await import("../../../scripts/db/restore-local.mjs")
  const set = ctx.backupSet(ctx.library("respaldo", 3))
  const begun = await ctx.begin(a, { manifest: set.manifestObject })
  await ctx.uploadAll(a, begun.value.value, set.bytes)
  const healthy = await ctx.sql.begin("read only", (tx) => verifyRestoredSessions(tx))
  assert.ok(healthy.chunks >= 1 && healthy.open >= 1)
  assert.ok(healthy.review.some((entry) => entry.table === "biblib.import_sessions"))
})
