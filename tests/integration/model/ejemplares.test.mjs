import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { errorCode, modelContext, raw, value } from "./lib/context.mjs"

// U-DAT-06 · Obra, edición y ejemplar con sesiones reales A/B y las Server Actions de la app compilada.

let ctx, a, b
before(async () => {
  ctx = await modelContext()
  a = await ctx.signIn("a")
  b = await ctx.signIn("b")
})
after(async () => {
  if (ctx) { await ctx.cleanup(); await ctx.close() }
  await a?.client.auth.signOut({ scope: "local" }).catch(() => {})
  await b?.client.auth.signOut({ scope: "local" }).catch(() => {})
})

const cover = { small: "/default-book-cover.webp", medium: "/default-book-cover.webp", large: "/default-book-cover.webp" }
const edition = (overrides = {}) => ({ title: ctx.title("Edición"), authors: [{ name: "Autoría de prueba" }], publishers: [{ name: "Editorial de prueba" }],
  number_of_pages: 120, publish_date: "2001", cover, status: "unread", catalogue: { source: "manual", isbnVerified: false }, ...overrides })

test("dos copias de un ISBN: una edición, dos ejemplares con estado, ubicación y comprobación independientes", async () => {
  const isbn = ctx.isbn(1)
  const [shelfA, shelfB] = [await ctx.defaultShelf(ctx.users.a), await ctx.shelf(ctx.users.a, "Balda B")]
  // La copia A se registra con el ISBN comprobado por la persona.
  const first = value(await ctx.call("createEditionAction", [{ ...edition({ catalogue: { source: "manual", isbnVerified: true }, status: "read" }), isbn13: isbn, placement: { shelfId: shelfA }, idempotencyKey: ctx.key("alta-a") }], a))
  assert.equal(first.isbn, isbn)
  assert.equal(first.catalogue.isbnVerified, true)
  assert.equal(first.edition.copies, 1)
  // Volver a dar de alta el mismo ISBN no crea otra edición: «ya existe» y la ficha guardada se encuentra por ISBN.
  assert.equal(errorCode(await ctx.call("createEditionAction", [{ ...edition(), isbn13: isbn, placement: { shelfId: shelfA }, idempotencyKey: ctx.key("alta-repetida") }], a)), "CONFLICT")
  assert.equal(raw(await ctx.call("getBookByIsbnAction", [isbn], a)).id, first.id)
  // Añadir copia es explícito y la copia B empieza sin verificar.
  const second = value(await ctx.call("createCopyAction", [{ editionId: first.edition.id, placement: { shelfId: shelfB }, status: "to-read", idempotencyKey: ctx.key("copia-b") }], a))
  assert.notEqual(second.id, first.id)
  assert.equal(second.edition.id, first.edition.id)
  assert.equal(second.edition.copies, 2)
  assert.deepEqual([second.status, second.shelf_id, second.catalogue.isbnVerified], ["to-read", shelfB, false])
  const [{ editions, copies }] = await ctx.sql`select count(distinct e.id)::int as editions, count(c.id)::int as copies from biblib.editions e join biblib.copies c on c.edition_id = e.id where e.user_id = ${ctx.users.a} and e.isbn13 = ${isbn}`
  assert.deepEqual({ editions, copies }, { editions: 1, copies: 2 })
  // Cambiar el estado de B no cambia A (ni su token).
  const reread = raw(await ctx.call("getBookDetailAction", [first.id], a))
  value(await ctx.call("updateBookStatusAction", [second.id, "reading", second.copyVersion], a))
  const afterB = raw(await ctx.call("getBookDetailAction", [first.id], a))
  assert.equal(afterB.version, reread.version)
  assert.deepEqual([afterB.status, afterB.catalogue.isbnVerified], ["read", true], "A conserva estado y comprobación")
  const bNow = raw(await ctx.call("getBookDetailAction", [second.id], a))
  assert.deepEqual([bNow.status, bNow.catalogue.isbnVerified], ["reading", false])
  // Los otros ejemplares de la edición se listan desde cualquiera de ellos.
  assert.deepEqual(raw(await ctx.call("getEditionCopiesAction", [second.id], a)).map((copy) => copy.id).sort(), [first.id, second.id].sort())
})

test("cambiar una edición compartida informa de cuántos ejemplares afecta y exige confirmarlo", async () => {
  const shelf = await ctx.defaultShelf(ctx.users.a)
  const first = value(await ctx.call("createEditionAction", [{ ...edition(), isbn13: ctx.isbn(2), placement: { shelfId: shelf }, idempotencyKey: ctx.key("compartida") }], a))
  const second = value(await ctx.call("createCopyAction", [{ editionId: first.edition.id, placement: { shelfId: shelf }, status: "unread", idempotencyKey: ctx.key("compartida-copia") }], a))
  const current = raw(await ctx.call("getBookDetailAction", [first.id], a))
  const title = ctx.title("Título corregido")
  const input = { ...edition({ title }), isbn: current.isbn, version: current.version, copyVersion: current.copyVersion, editionVersion: current.edition.version, shelf_id: shelf }
  // Desde la ficha plana: sin confirmar, EDITION_SHARED y nada cambia.
  const refused = await ctx.call("updateBookAction", [first.id, input], a)
  assert.equal(errorCode(refused), "EDITION_SHARED")
  assert.match(refused.value.error.message, /comparten 2 ejemplares/)
  assert.notEqual(raw(await ctx.call("getBookDetailAction", [second.id], a)).title, title)
  // Con la confirmación del número vigente se guarda y la otra copia lo muestra.
  value(await ctx.call("updateBookAction", [first.id, { ...input, confirmSharedCopies: 2 }], a))
  assert.equal(raw(await ctx.call("getBookDetailAction", [second.id], a)).title, title)
  // El contrato de edición: versión de la edición vieja → conflicto; vigente → informa de 2 ejemplares.
  const latest = raw(await ctx.call("getBookDetailAction", [second.id], a))
  assert.equal(errorCode(await ctx.call("updateEditionAction", [{ ...edition({ title: ctx.title("Otro") }), isbn: latest.isbn, editionId: latest.edition.id, expectedVersion: current.edition.version, confirmCopies: 2 }], a)), "CONFLICT")
  const updated = value(await ctx.call("updateEditionAction", [{ ...edition({ title: ctx.title("Otro") }), isbn: latest.isbn, editionId: latest.edition.id, expectedVersion: latest.edition.version, confirmCopies: 2, idempotencyKey: ctx.key("editar") }], a))
  assert.equal(updated.copies, 2)
  // El token de la ficha (Book.version) por sí solo no autoriza la edición compartida.
  const stale = raw(await ctx.call("getBookDetailAction", [first.id], a))
  assert.equal(errorCode(await ctx.call("updateBookAction", [first.id, { ...edition({ title: ctx.title("Solo plano") }), isbn: stale.isbn, version: stale.version, shelf_id: shelf }], a)), "EDITION_SHARED")
})

test("un libro sin ISBN: null en la edición, se edita, se exporta en v2 y se restaura con null", async () => {
  const shelf = await ctx.defaultShelf(ctx.users.a)
  const created = value(await ctx.call("createEditionAction", [{ ...edition(), isbn13: null, placement: { shelfId: shelf }, idempotencyKey: ctx.key("sin-isbn") }], a))
  assert.equal(created.isbn, null)
  assert.equal(created.legacyIdentifier, undefined, "no se le inventa un identificador")
  const [row] = await ctx.sql`select e.isbn13, c.legacy_identifier from biblib.copies c join biblib.editions e on e.id = c.edition_id where c.id = ${created.id}`
  assert.deepEqual(row, { isbn13: null, legacy_identifier: null })
  const edited = value(await ctx.call("updateBookAction", [created.id, { ...edition({ title: `${created.title} editado` }), isbn: "", version: created.version, shelf_id: shelf }], a))
  assert.equal(edited.isbn, null)
  // La copia de seguridad exige v2 (v1 tendría que inventarle un ISBN) y conserva el null.
  const prepared = value(await ctx.call("prepareLibraryExportAction", [], a))
  assert.equal(prepared.formatVersion, 2)
  const copiesIn = []
  for (const part of prepared.parts) {
    const response = await ctx.get(part.href, a)
    assert.equal(response.status, 200)
    copiesIn.push(JSON.parse(response.body.toString("utf8")))
  }
  const file = copiesIn.find((part) => part.copies.some((copy) => copy.id === created.id))
  const copy = file.copies.find((entry) => entry.id === created.id)
  assert.equal(copy.legacy_identifier, null)
  assert.equal(file.editions.find((entry) => entry.id === copy.edition_id).isbn13, null)
  // Restaurar ese archivo en B (otra cuenta) crea el ejemplar sin ISBN y sin identificador.
  const restored = file.copies.filter((entry) => entry.id === created.id)
  const single = { ...file, editions: file.editions.filter((entry) => entry.id === copy.edition_id), copies: restored, works: [], requiredCapabilities: [], shelves: file.shelves.filter((entry) => entry.id === copy.shelf_id) }
  const preview = value(await ctx.call("prepareImportAction", [single, "merge"], b))
  value(await ctx.call("confirmImportAction", [{ previewId: preview.previewId, expectedRevision: preview.revision, idempotencyKey: ctx.key("restaurar") }], b))
  const [inB] = await ctx.sql`select e.isbn13, c.legacy_identifier, e.title from biblib.copies c join biblib.editions e on e.id = c.edition_id where c.user_id = ${ctx.users.b} and e.title = ${edited.title}`
  assert.deepEqual(inB, { isbn13: null, legacy_identifier: null, title: edited.title })
})

test("aislamiento: B no cita ediciones ni ejemplares de A ni fusiona ediciones ajenas", async () => {
  const shelfA = await ctx.defaultShelf(ctx.users.a)
  const shelfB = await ctx.defaultShelf(ctx.users.b)
  const own = value(await ctx.call("createEditionAction", [{ ...edition(), isbn13: ctx.isbn(4), placement: { shelfId: shelfA }, idempotencyKey: ctx.key("aislada") }], a))
  assert.equal(errorCode(await ctx.call("createCopyAction", [{ editionId: own.edition.id, placement: { shelfId: shelfB }, status: "unread", idempotencyKey: ctx.key("ajena") }], b)), "NOT_FOUND")
  // A tampoco coloca un ejemplar suyo en una estantería de B.
  assert.equal(errorCode(await ctx.call("createCopyAction", [{ editionId: own.edition.id, placement: { shelfId: shelfB }, status: "unread", idempotencyKey: ctx.key("estanteria-ajena") }], a)), "NOT_FOUND")
  assert.deepEqual(raw(await ctx.call("getEditionCopiesAction", [own.id], b)), [])
  assert.equal(raw(await ctx.call("getBookByIsbnAction", [ctx.isbn(4)], b)), null)
  const mine = value(await ctx.call("createEditionAction", [{ ...edition(), isbn13: null, placement: { shelfId: shelfB }, idempotencyKey: ctx.key("de-b") }], b))
  const revision = await ctx.revision(ctx.users.b)
  const merge = await ctx.call("mergeEditionsAction", [{ sourceIds: [mine.edition.id], targetId: own.edition.id, expectedVersions: { [mine.edition.id]: mine.edition.version, [own.edition.id]: own.edition.version }, expectedRevision: revision, idempotencyKey: ctx.key("fusion-cruzada") }], b)
  assert.equal(errorCode(merge), "NOT_FOUND")
  const [{ n }] = await ctx.sql`select count(*)::int as n from biblib.copies where edition_id = ${own.edition.id}`
  assert.equal(n, 1, "la edición de A sigue con su único ejemplar")
  // Con los claims de B, ni la FK con propietario admite un ejemplar suyo en la edición de A.
  const failed = await ctx.sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: ctx.users.b, role: "authenticated" })}, true), set_config('request.jwt.claim.sub', ${ctx.users.b}, true)`
    await tx`set local role authenticated`
    return tx.savepoint((sp) => sp`insert into biblib.copies (user_id, edition_id, shelf_id) values (${ctx.users.b}, ${own.edition.id}, ${shelfB})`).then(() => null, (error) => error.code)
  })
  assert.equal(failed, "23503")
})

test("concurrencia e idempotencia: altas simultáneas no duplican y repetir una clave recupera el resultado", async () => {
  const shelf = await ctx.defaultShelf(ctx.users.a)
  const isbn = ctx.isbn(5)
  const input = edition()
  const results = await Promise.all(Array.from({ length: 5 }, (_, index) => ctx.call("createEditionAction", [{ ...input, isbn13: isbn, placement: { shelfId: shelf }, idempotencyKey: ctx.key(`carrera-${index}`) }], a)))
  assert.equal(results.filter((result) => result.value?.ok).length, 1, "una sola alta gana")
  assert.ok(results.filter((result) => !result.value?.ok).every((result) => result.value.error.code === "CONFLICT"))
  const [{ n }] = await ctx.sql`select count(*)::int as n from biblib.editions where user_id = ${ctx.users.a} and isbn13 = ${isbn}`
  assert.equal(n, 1)
  // Reintentar con la misma clave devuelve el mismo ejemplar, también en paralelo.
  const winner = results.find((result) => result.value?.ok).value.value
  const key = ctx.key("copia-reintentada")
  const copies = await Promise.all(Array.from({ length: 4 }, () => ctx.call("createCopyAction", [{ editionId: winner.edition.id, placement: { shelfId: shelf }, status: "unread", idempotencyKey: key }], a)))
  assert.equal(new Set(copies.map((result) => value(result).id)).size, 1)
  const [{ total }] = await ctx.sql`select count(*)::int as total from biblib.copies where edition_id = ${winner.edition.id}`
  assert.equal(total, 2)
  // La misma clave con otra entrada es un conflicto, no otra copia.
  assert.equal(errorCode(await ctx.call("createCopyAction", [{ editionId: winner.edition.id, placement: { shelfId: shelf }, status: "read", idempotencyKey: key }], a)), "IDEMPOTENCY_CONFLICT")
})

test("fusionar ediciones: los ejemplares pasan con su estado y la revisión vieja se rechaza", async () => {
  const shelf = await ctx.defaultShelf(ctx.users.a)
  const target = value(await ctx.call("createEditionAction", [{ ...edition(), isbn13: ctx.isbn(6), placement: { shelfId: shelf }, idempotencyKey: ctx.key("destino") }], a))
  const source = value(await ctx.call("createEditionAction", [{ ...edition({ status: "read" }), isbn13: null, placement: { shelfId: shelf }, idempotencyKey: ctx.key("origen") }], a))
  const versions = { [target.edition.id]: target.edition.version, [source.edition.id]: source.edition.version }
  const stale = await ctx.revision(ctx.users.a)
  value(await ctx.call("updateBookStatusAction", [target.id, "reading", target.copyVersion], a))
  const refreshed = raw(await ctx.call("getBookDetailAction", [target.id], a))
  const request = { sourceIds: [source.edition.id], targetId: target.edition.id, expectedVersions: { ...versions, [target.edition.id]: refreshed.edition.version } }
  assert.equal(errorCode(await ctx.call("mergeEditionsAction", [{ ...request, expectedRevision: stale, idempotencyKey: ctx.key("fusion-vieja") }], a)), "REVISION_CONFLICT")
  const key = ctx.key("fusion")
  const merged = value(await ctx.call("mergeEditionsAction", [{ ...request, expectedRevision: await ctx.revision(ctx.users.a), idempotencyKey: key }], a))
  assert.deepEqual({ moved: merged.moved, mapping: merged.mapping }, { moved: 1, mapping: [{ sourceId: source.edition.id, targetId: target.edition.id }] })
  const moved = raw(await ctx.call("getBookDetailAction", [source.id], a))
  assert.deepEqual([moved.edition.id, moved.status, moved.isbn, moved.edition.copies], [target.edition.id, "read", ctx.isbn(6), 2])
  const [{ gone }] = await ctx.sql`select count(*)::int as gone from biblib.editions where id = ${source.edition.id}`
  assert.equal(gone, 0, "la edición vacía se retira")
  // Repetir la confirmación con la misma clave recupera el resultado aunque la revisión ya haya cambiado.
  assert.deepEqual(value(await ctx.call("mergeEditionsAction", [{ ...request, expectedRevision: stale, idempotencyKey: key }], a)).mapping, merged.mapping)
})

test("ningún proveedor simulado acredita la comprobación física", async () => {
  const isbn = "9780000000019"
  const lookup = await ctx.call("lookupIsbnAction", [isbn], a)
  assert.equal(lookup.status, 200)
  const candidate = lookup.value?.value?.candidates?.[0]
  assert.ok(candidate, "el catálogo fixture devuelve un candidato")
  // Aunque la interfaz enviara la procedencia del proveedor, sin la casilla de la persona queda sin comprobar.
  const shelf = await ctx.defaultShelf(ctx.users.b)
  const existing = raw(await ctx.call("getBookByIsbnAction", [isbn], b))
  const saved = existing ?? value(await ctx.call("createEditionAction", [{ ...edition({ title: ctx.title(candidate.title ?? "Candidato"), catalogue: { source: "open-library" } }), isbn13: isbn, placement: { shelfId: shelf }, idempotencyKey: ctx.key("proveedor") }], b))
  const copy = existing
    ? value(await ctx.call("createCopyAction", [{ editionId: existing.edition.id, placement: { shelfId: shelf }, status: "unread", idempotencyKey: ctx.key("proveedor-copia") }], b))
    : saved
  assert.equal(copy.catalogue.isbnVerified, false)
  const [{ verified }] = await ctx.sql`select (edition_verification->>'isbnVerified')::boolean as verified from biblib.copies where id = ${copy.id}`
  assert.equal(verified, false)
  if (copy.id !== existing?.id) await ctx.sql`delete from biblib.copies where id = ${copy.id} and user_id = ${ctx.users.b}`
})
