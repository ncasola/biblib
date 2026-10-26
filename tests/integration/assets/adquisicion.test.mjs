import assert from "node:assert/strict"
import { after, afterEach, before, test } from "node:test"
import sharp from "sharp"
import { assetsContext, BUCKET, chunks, failed, fakeNetwork, ok, ORIGINAL_COVER, permissiveRights, sha256 } from "./lib/context.mjs"

// U-DAT-10 · Adquisición de copias privadas con el ejecutor compilado, la sesión Storage real del
// dueño y red simulada. Las políticas publicadas no permiten copiar portadas: aquí se inyecta una que
// sí lo permite para Open Library, solo en pruebas. Cada caso comprueba que no hubo conexión con
// destinos prohibidos, que no quedó un objeto confirmado y que la portada visible no cambió.

let ctx, a, b, rights
before(async () => {
  ctx = await assetsContext()
  await ctx.cleanup()
  a = await ctx.signIn("a")
  b = await ctx.signIn("b")
  rights = permissiveRights(ctx.modules.rights)
})
afterEach(async () => { await ctx.cleanup() })
after(async () => {
  if (!ctx) return
  await ctx.cleanup()
  for (const session of [a, b]) await session?.client.auth.signOut({ scope: "local" }).catch(() => {})
  await ctx.close()
})

const image = (format = "jpeg", width = 300, height = 450, color = "#205080") => sharp({ create: { width, height, channels: 3, background: color } })[format]().toBuffer()
const reply = (status, headers, body = chunks(), onDestroy = () => {}) => ({ status, headers, body, destroy: onDestroy })
const blocked = (connections) => connections.filter((entry) => ctx.modules.policy.isBlockedAddress(entry.address))

async function unchanged(book, asset) {
  const row = await ctx.bookRow(book.id)
  assert.equal(row.cover_asset_id, null, "la portada visible no cambia")
  assert.equal(row.cover_large, ORIGINAL_COVER)
  assert.equal(row.version, book.version, "la ficha no se modifica")
  assert.equal(await ctx.assetRow(asset), undefined, "la cuarentena se descarta")
  assert.equal((await ctx.objects(`${ctx.users.a}/${asset}/`)).length, 0, "ningún objeto")
}

test("la descarga con derechos válidos se valida, se sube con la sesión y se adjunta con la versión vista", async () => {
  const book = await ctx.book(ctx.users.a, "valida")
  const requested = await ctx.request(ctx.users.a, book, "open-library:id:8739161")
  const bytes = await image()
  const network = fakeNetwork({ respond: async () => reply(200, { "content-type": "image/jpeg", "content-length": String(bytes.length) }, chunks(bytes)) })
  const { fetches, reports } = await ctx.work(a, requested.job_id, { network, rights })
  assert.deepEqual(fetches, ["open-library:id:8739161"])
  assert.equal(reports.at(-1)?.state, "succeeded")
  assert.equal(network.log.connections.length, 1)
  assert.equal(network.log.connections[0].path, "/b/id/8739161-L.jpg", "la ruta sale de la clave validada")
  const job = await ctx.jobRow(requested.job_id)
  assert.deepEqual({ assetId: job.result.assetId, attached: job.result.attached }, { assetId: requested.asset_id, attached: true })
  const asset = await ctx.assetRow(requested.asset_id)
  assert.equal(asset.state, "ready")
  assert.equal(asset.storage_key, `${ctx.users.a}/${asset.id}/${job.fencing_number}.webp`, "la ruta lleva el fencing del intento")
  const row = await ctx.bookRow(book.id)
  assert.equal(row.cover_asset_id, asset.id)
  assert.equal(row.cover_large, ORIGINAL_COVER, "la URL original se conserva")
  const served = await ctx.read(asset.id, a)
  assert.equal(served.status, 200)
  assert.equal(sha256(served.body), asset.sha256)
  assert.equal((await ctx.read(asset.id, b)).status, 404)
})

test("red simulada: redirección a localhost, respuesta lenta, tamaño mentido, DNS cambiante, MIME falso, SVG y dimensiones excesivas", async () => {
  const bomb = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: "#000000" } }).png({ compressionLevel: 9 }).toBuffer()
  const html = Buffer.from("<!DOCTYPE html><html><body><script>fetch('http://169.254.169.254/latest/meta-data/')</script></body></html>")
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
  let produced = 0
  async function* endless() { for (;;) { produced += 65_536; yield new Uint8Array(65_536) } }
  const cases = [
    { name: "redirección a localhost", addresses: undefined, respond: async () => reply(302, { location: "http://127.0.0.1:55341/storage/v1/object/biblib-covers" }), code: "ASSET_REJECTED", reason: "REDIRECT" },
    { name: "DNS hacia la red privada", addresses: [{ address: "10.0.0.7", family: 4 }], respond: async () => { throw new Error("no debe conectar") }, code: "ASSET_REJECTED", reason: "ADDRESS_BLOCKED", connections: 0 },
    { name: "DNS cambiante (rebinding con metadatos cloud)", addresses: [{ address: "151.101.1.1", family: 4 }, { address: "169.254.169.254", family: 4 }], respond: async () => { throw new Error("no debe conectar") }, code: "ASSET_REJECTED", reason: "ADDRESS_BLOCKED", connections: 0 },
    { name: "IPv4 mapeada en IPv6", addresses: [{ address: "::ffff:127.0.0.1", family: 6 }], respond: async () => { throw new Error("no debe conectar") }, code: "ASSET_REJECTED", reason: "ADDRESS_BLOCKED", connections: 0 },
    { name: "tamaño mentido", respond: async () => reply(200, { "content-type": "image/jpeg", "content-length": "2048" }, endless()), code: "ASSET_REJECTED", reason: "TOO_LARGE" },
    { name: "MIME falso (HTML como JPEG)", respond: async () => reply(200, { "content-type": "image/jpeg" }, chunks(html)), code: "ASSET_REJECTED", reason: "MARKUP" },
    { name: "SVG declarado", respond: async () => reply(200, { "content-type": "image/svg+xml" }, chunks(svg)), code: "ASSET_REJECTED", reason: "CONTENT_TYPE" },
    { name: "SVG como PNG", respond: async () => reply(200, { "content-type": "image/png" }, chunks(svg)), code: "ASSET_REJECTED", reason: "MARKUP" },
    { name: "dimensiones excesivas", respond: async () => reply(200, { "content-type": "image/png" }, chunks(bomb)), code: "ASSET_REJECTED", reason: "TOO_MANY_PIXELS" },
  ]
  for (const entry of cases) {
    const book = await ctx.book(ctx.users.a, `red ${entry.name}`)
    const requested = await ctx.request(ctx.users.a, book, "open-library:id:8739161")
    const network = fakeNetwork({ ...(entry.addresses ? { addresses: entry.addresses } : {}), respond: entry.respond })
    await ctx.work(a, requested.job_id, { network, rights })
    const job = await ctx.jobRow(requested.job_id)
    assert.equal(job.state, "failed", entry.name)
    assert.equal(job.error_code, entry.code, entry.name)
    assert.equal(job.result.reason, entry.reason, entry.name)
    assert.equal(network.log.lookups.length, 1, `${entry.name}: una sola resolución`)
    assert.deepEqual(blocked(network.log.connections), [], `${entry.name}: ninguna conexión con destinos prohibidos`)
    if (entry.connections !== undefined) assert.equal(network.log.connections.length, entry.connections, entry.name)
    await unchanged(book, requested.asset_id)
  }
  assert.ok(produced <= 5 * 1024 * 1024 + 65_536, "el tamaño mentido se corta en el límite")

  // Respuesta lenta: plazo agotado, reintentable; tras el máximo de intentos, fallo sin objeto.
  const slow = await ctx.book(ctx.users.a, "lenta")
  const requested = await ctx.request(ctx.users.a, slow, "open-library:id:8739161")
  const network = fakeNetwork({ respond: () => new Promise(() => undefined) })
  await ctx.work(a, requested.job_id, { network, rights, limits: { fetch: { timeoutMs: 200 } } })
  const waiting = await ctx.jobRow(requested.job_id)
  assert.equal(waiting.state, "waiting_retry")
  assert.equal(waiting.error_code, "TIMEOUT")
  assert.equal((await ctx.assetRow(requested.asset_id)).state, "quarantine", "una caída no equivale a «no hay portada»")
  assert.equal((await ctx.bookRow(slow.id)).cover_asset_id, null)
})

test("una edición concurrente o una cancelación impiden adjuntar el resultado tardío", async () => {
  const bytes = await image("png")
  const respond = async () => reply(200, { "content-type": "image/png" }, chunks(bytes))

  // Edición en otra pestaña antes de registrar: el asset queda guardado, pero la ficha no cambia.
  const edited = await ctx.book(ctx.users.a, "editada")
  const first = await ctx.request(ctx.users.a, edited, "open-library:id:111")
  await ctx.work(a, first.job_id, { network: fakeNetwork({ respond }), rights, hooks: { beforeRegister: async () => {
    const changed = await ctx.call("updateBookStatusAction", [edited.id, "reading", edited.version], a)
    assert.ok(ok(changed))
  } } })
  const job = await ctx.jobRow(first.job_id)
  assert.equal(job.state, "succeeded")
  assert.equal(job.error_code, "CHANGED")
  assert.equal(job.result.attached, false)
  const row = await ctx.bookRow(edited.id)
  assert.equal(row.cover_asset_id, null, "la edición posterior gana")
  assert.notEqual(row.version, edited.version)

  // Cancelación con la subida ya hecha: el registro tardío no se confirma y el objeto queda purgable.
  const cancelled = await ctx.book(ctx.users.a, "cancelada")
  const second = await ctx.request(ctx.users.a, cancelled, "open-library:id:222")
  let uploadedKey
  await ctx.work(a, second.job_id, { network: fakeNetwork({ respond: async () => reply(200, { "content-type": "image/png" }, chunks(await image("png", 200, 300, "#990000"))) }), rights, hooks: { afterUpload: async (_job, key) => {
    uploadedKey = key
    const current = await ctx.jobRow(second.job_id)
    const result = await ctx.call("cancelCoverAssetJobAction", [{ jobId: second.job_id, expectedVersion: current.version }], a)
    assert.ok(ok(result), JSON.stringify(result.value?.error))
  } } })
  assert.equal((await ctx.jobRow(second.job_id)).state, "cancelled")
  assert.equal((await ctx.assetRow(second.asset_id)).state, "quarantine", "nada registrado tras cancelar")
  assert.equal((await ctx.bookRow(cancelled.id)).cover_asset_id, null)
  // Tras cancelar, ni siquiera ese intento puede volver a subir: Storage exige el trabajo en ejecución.
  const asA = ctx.storageAs(a).storage.from(BUCKET)
  assert.equal((await asA.remove([uploadedKey])).data?.length, 1, "el dueño puede retirar el objeto de una cuarentena")
  assert.ok((await asA.upload(uploadedKey, await image("webp"), { contentType: "image/webp" })).error, "el intento cancelado no vuelve a subir")
  await ctx.sql`update biblib.cover_assets set expires_at = now() - interval '1 second' where id = ${second.asset_id}`
  await ctx.purge({ owner: ctx.users.a })
  assert.equal(await ctx.assetRow(second.asset_id), undefined)
  assert.equal((await ctx.objects(`${ctx.users.a}/${second.asset_id}/`)).length, 0)
})

test("repetir no duplica y matar el trabajador entre subir y registrar deja un objeto purgable, no un enlace roto", async () => {
  const book = await ctx.book(ctx.users.a, "caida")
  const key = ctx.key("caida")
  const requested = await ctx.request(ctx.users.a, book, "open-library:id:333", key)
  const again = await ctx.request(ctx.users.a, book, "open-library:id:333", key)
  assert.deepEqual([again.status, again.job_id, again.asset_id], ["existing", requested.job_id, requested.asset_id], "la misma clave recupera el mismo trabajo")
  assert.equal((await ctx.request(ctx.users.a, book, "open-library:id:444", key)).status, "conflict")

  const killed = await ctx.workInChild(a, { jobId: requested.job_id, owner: ctx.users.a, afterUpload: "kill" })
  assert.equal(killed.code, 137, JSON.stringify(killed))
  const orphanKey = killed.events[0].key
  assert.equal((await ctx.objects(orphanKey)).length, 1, "el objeto llegó a Storage")
  assert.equal((await ctx.assetRow(requested.asset_id)).state, "quarantine", "pero no se registró")
  assert.equal((await ctx.bookRow(book.id)).cover_asset_id, null, "ni se adjuntó: no hay enlace roto")
  assert.equal((await ctx.read(requested.asset_id, a)).status, 404)

  // El lease del trabajador muerto caduca; con su fencing antiguo ya no puede subir (política de Storage).
  const canUpload = async () => (await ctx.asUser(ctx.users.a, (tx) => tx`select biblib.cover_object_access(${orphanKey}, 'insert') as allowed`))[0].allowed
  assert.equal(await canUpload(), true, "mientras dura el lease, su intento estaba autorizado")
  await ctx.sql`update biblib.library_jobs set lease_until = now() - interval '1 second' where id = ${requested.job_id}`
  assert.equal(await canUpload(), false, "con el lease vencido, ese intento ya no sube")
  const resumed = await ctx.workInChild(a, { jobId: requested.job_id, owner: ctx.users.a })
  assert.equal(resumed.code, 0, JSON.stringify(resumed))
  const asset = await ctx.assetRow(requested.asset_id)
  assert.equal(asset.state, "ready")
  assert.notEqual(asset.storage_key, orphanKey, "el nuevo intento usa su propio fencing")
  assert.equal((await ctx.bookRow(book.id)).cover_asset_id, asset.id)
  // El objeto del intento muerto es huérfano: la purga lo retira y no toca el registrado.
  await ctx.ageObjects(orphanKey)
  await ctx.purge({ owner: ctx.users.a })
  assert.equal((await ctx.objects(orphanKey)).length, 0)
  assert.equal((await ctx.objects(asset.storage_key)).length, 1)

  // Otra solicitud con otra clave y la misma imagen se deduplica sin subir otra copia.
  const other = await ctx.book(ctx.users.a, "misma imagen")
  const duplicate = await ctx.request(ctx.users.a, other, "open-library:id:333")
  const child = await ctx.workInChild(a, { jobId: duplicate.job_id, owner: ctx.users.a })
  assert.equal(child.code, 0)
  const job = await ctx.jobRow(duplicate.job_id)
  assert.deepEqual({ assetId: job.result.assetId, deduplicated: job.result.deduplicated, attached: job.result.attached }, { assetId: asset.id, deduplicated: true, attached: true })
  assert.equal((await ctx.objects(`${ctx.users.a}/${duplicate.asset_id}/`)).length, 0, "no se sube otra copia")
})

test("versiones anteriores retienen la referencia; licencia vencida, cuarentena caducada y purga", async () => {
  const book = await ctx.book(ctx.users.a, "versiones")
  const requested = await ctx.request(ctx.users.a, book, "open-library:id:555")
  assert.equal((await ctx.workInChild(a, { jobId: requested.job_id, owner: ctx.users.a, seed: "versiones" })).code, 0)
  const asset = await ctx.assetRow(requested.asset_id)
  // Una versión anterior capturada mientras la ficha tenía la portada privada.
  const operation = ctx.key("version")
  await ctx.asUser(ctx.users.a, async (tx) => {
    const [op] = await tx`insert into biblib.library_operations (user_id, operation, idempotency_key, input_digest, status, result) values (${ctx.users.a}, 'snapshot.restore', ${operation}, ${"f".repeat(64)}, 'committed', '{}') returning id`
    await tx`select biblib.library_snapshot_capture(${op.id}::uuid, 'snapshot.restore')`
  })
  const current = await ctx.bookRow(book.id)
  assert.ok(ok(await ctx.call("detachCoverAssetAction", [{ entityId: book.id, expectedVersion: current.version }], a)))
  await ctx.purge({ owner: ctx.users.a, graceSeconds: 0 })
  assert.ok(await ctx.assetRow(asset.id), "la versión anterior lo retiene")
  assert.equal((await ctx.objects(asset.storage_key)).length, 1)
  await ctx.sql`delete from biblib.library_snapshots where user_id = ${ctx.users.a} and source_operation_id in (select id from biblib.library_operations where idempotency_key = ${operation})`
  await ctx.purge({ owner: ctx.users.a, graceSeconds: 3600 })
  assert.ok(await ctx.assetRow(asset.id), "dentro del periodo de gracia se conserva")
  await ctx.purge({ owner: ctx.users.a, graceSeconds: 0 })
  assert.equal(await ctx.assetRow(asset.id), undefined, "sin referencias y tras la gracia se purga")
  assert.equal((await ctx.objects(asset.storage_key)).length, 0)

  // Licencia vencida: deja de servirse, la purga desadjunta la ficha y retira el objeto.
  const licensed = await ctx.book(ctx.users.a, "licencia")
  const second = await ctx.request(ctx.users.a, licensed, "open-library:id:666")
  assert.equal((await ctx.workInChild(a, { jobId: second.job_id, owner: ctx.users.a, seed: "licencia" })).code, 0)
  assert.equal((await ctx.read(second.asset_id, a)).status, 200)
  await ctx.sql`update biblib.cover_assets set expires_at = now() - interval '1 second' where id = ${second.asset_id}`
  assert.equal((await ctx.read(second.asset_id, a)).status, 404, "una licencia vencida no se sirve")
  await ctx.purge({ owner: ctx.users.a, graceSeconds: 86_400 })
  assert.equal((await ctx.bookRow(licensed.id)).cover_asset_id, null, "la ficha vuelve a su URL original")
  assert.equal(await ctx.assetRow(second.asset_id), undefined)

  // Una subida que no terminó caduca a los 15 minutos y se purga con su objeto.
  const begun = (await ctx.asUser(ctx.users.a, (tx) => tx`select biblib.cover_asset_begin_upload() as result`))[0].result
  const pendingKey = `${ctx.users.a}/${begun.asset_id}/${begun.upload_token}.webp`
  assert.ok(!(await ctx.storageAs(a).storage.from(BUCKET).upload(pendingKey, await sharp(await image()).webp().toBuffer(), { contentType: "image/webp" })).error)
  await ctx.sql`update biblib.cover_assets set expires_at = now() - interval '1 second' where id = ${begun.asset_id}`
  await ctx.ageObjects(pendingKey)
  await ctx.purge({ owner: ctx.users.a })
  assert.equal(await ctx.assetRow(begun.asset_id), undefined)
  assert.equal((await ctx.objects(pendingKey)).length, 0)
})

test("cuotas y cuenta bloqueada: sin subidas, adquisiciones ni escrituras de un trabajo antiguo", async () => {
  const book = await ctx.book(ctx.users.a, "cuotas")
  const bytes = await image("jpeg", 200, 300, "#445566")
  const upload = () => ctx.form("beginOwnCoverUploadAction", { entityId: book.id, mime: "image/jpeg", bytes: String(bytes.length), file: new Blob([bytes], { type: "image/jpeg" }) }, a)

  // 500 assets utilizables (filas ficticias, sin objetos) agotan el espacio de A, no el de B.
  await ctx.sql`insert into biblib.cover_assets (user_id, state, source_kind, source_ref, rights_policy_version, storage_key, sha256, mime, width, height, bytes)
    select ${ctx.users.a}::uuid, 'ready', 'upload', 'upload', 'upload.v1', ${ctx.users.a} || '/' || gen_random_uuid() || '/q.webp', encode(sha256(convert_to(${ctx.run} || g::text, 'UTF8')), 'hex'), 'image/webp', 1, 1, 1
    from generate_series(1, 500) as g`
  assert.ok(failed(await upload(), "LIMIT_EXCEEDED"))
  const bBook = await ctx.book(ctx.users.b, "cuotas")
  assert.ok(ok(await ctx.form("beginOwnCoverUploadAction", { entityId: bBook.id, mime: "image/jpeg", bytes: String(bytes.length), file: new Blob([bytes], { type: "image/jpeg" }) }, b)))
  await ctx.sql`delete from biblib.cover_assets where user_id = ${ctx.users.a} and storage_key like '%/q.webp'`

  // Una adquisición en marcha y la cuenta bloqueada a mitad: el trabajo expira y nada se sube ni registra.
  const requested = await ctx.request(ctx.users.a, book, "open-library:id:777")
  await ctx.work(a, requested.job_id, { network: fakeNetwork({ respond: async () => reply(200, { "content-type": "image/jpeg" }, chunks(bytes)) }), rights, hooks: { afterUpload: async () => {
    await ctx.sql`select biblib.account_set_state(${ctx.users.a}, 'blocked')`
  } } })
  assert.equal((await ctx.jobRow(requested.job_id)).state, "expired")
  assert.equal((await ctx.assetRow(requested.asset_id)).state, "quarantine", "no se registra con la cuenta bloqueada")
  assert.equal((await ctx.bookRow(book.id)).cover_asset_id, null)
  assert.ok(failed(await upload(), "UNAUTHORIZED"), "una cuenta bloqueada no sube")
  assert.equal((await ctx.request(ctx.users.a, book, "open-library:id:888")).status, "inactive", "ni pide adquisiciones")
  const direct = await ctx.storageAs(a).storage.from(BUCKET).upload(`${ctx.users.a}/${requested.asset_id}/9.webp`, Buffer.from("x"), { contentType: "image/webp" })
  assert.ok(direct.error, "ni sube directamente a Storage")
  await ctx.sql`select biblib.account_set_state(${ctx.users.a}, 'active')`
})
