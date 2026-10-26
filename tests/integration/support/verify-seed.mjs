import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { createClient } from "@supabase/supabase-js"
import { ASSET, BUCKET, loadCensus, runSeed } from "../../../scripts/db/seed-local.mjs"
import { fixtureId } from "../../../scripts/db/fixture-store.mjs"
import { closeConnection, connect, resolveLocal } from "../../../scripts/db/target.mjs"
import { signInFixture } from "./session.mjs"

/** Ensayo optativo: solo scratch acreditado; devuelve exclusivamente evidencia pública ficticia. */
export async function verifySeed({ profile = "scratch" } = {}) {
  assert.equal(profile, "scratch", "Este ensayo solo admite scratch.")
  const resolved = await resolveLocal(profile)
  const sql = connect(resolved, { applicationName: "biblib-seed-verification" })
  const options = { profile, target: "local" }
  const sessions = []
  try {
    const first = await runSeed(options)
    const a = first.accounts.find((u) => u.key === "a")
    const manualId = fixtureId(first.censusId, a.id, "human", "manual-sin-fixture-key")
    const [shelf] = await sql`select id from biblib.shelves where user_id = ${a.id} and is_default = true`
    // Desde 0011 books es la vista plana: sin ON CONFLICT, el alta se omite si ya existe.
    await sql`insert into biblib.books (id, user_id, isbn, title, shelf_id)
      select ${manualId}, ${a.id}, 'manual-ensayo-o05', 'Alta manual de ensayo O05', ${shelf.id}
      where not exists (select 1 from biblib.books where id = ${manualId})`
    const before = await sql`select id, user_id, version from biblib.books where catalogue->>'censusId' = ${first.censusId} order by id`
    const shelvesBefore = await sql`select id from biblib.shelves where user_id in (${first.accounts[0].id}, ${first.accounts[1].id}) order by id`
    const second = await runSeed(options)
    assert.deepEqual(first.accounts, second.accounts, "El seed debe conservar las cuentas e IDs reales.")
    const after = await sql`select id, user_id, version from biblib.books where catalogue->>'censusId' = ${first.censusId} order by id`
    assert.deepEqual(before.map((b) => b.id), after.map((b) => b.id))
    assert.equal(after.length, 8)
    assert.ok(before.every((b, i) => b.version !== after[i].version), "El trigger debe rotar las versiones también en el seed.")
    assert.deepEqual(await sql`select id from biblib.shelves where user_id in (${first.accounts[0].id}, ${first.accounts[1].id}) order by id`, shelvesBefore)
    assert.equal(shelvesBefore.length, 6)
    const [manual] = await sql`select title, catalogue from biblib.books where id = ${manualId} and user_id = ${a.id}`
    assert.equal(manual.title, "Alta manual de ensayo O05")
    assert.equal(manual.catalogue.fixtureKey, undefined)

    const accounts = []
    for (const as of ["a", "b"]) {
      const fixture = await signInFixture(as, { profile })
      sessions.push(fixture.client)
      const user = await fixture.client.auth.getUser()
      assert.equal(user.error, null)
      assert.equal(user.data.user.id, second.accounts.find((u) => u.key === as).id)
      assert.ok(fixture.cookies().some((cookie) => cookie.name.startsWith("sb-") && cookie.name.includes("-auth-token")))
      const parts = fixture.session.access_token.split(".")
      parts[2] = (parts[2][0] === "a" ? "b" : "a") + parts[2].slice(1)
      const invalid = await fixture.client.auth.getUser(parts.join("."))
      assert.ok(invalid.error, "GoTrue debe rechazar un token alterado.")
      const updated = await fixture.client.auth.updateUser({ data: { full_name: `Lector de ensayo ${as.toUpperCase()}` } })
      assert.equal(updated.error, null)
      assert.equal(updated.data.user.user_metadata.biblib_fixture, first.censusId)
      const refreshed = await fixture.client.auth.refreshSession()
      assert.equal(refreshed.error, null)
      assert.ok(refreshed.data.session)
      assert.equal((await fixture.client.auth.getUser()).data.user.id, user.data.user.id)
      assert.equal((await fixture.client.auth.signOut()).error, null)
      assert.equal((await fixture.client.auth.getSession()).data.session, null)
      assert.ok(fixture.cookies().every((c) => c.value === ""), "SSR debe retirar las cookies al cerrar sesión.")
      const revoked = await fixture.client.auth.refreshSession({ refresh_token: refreshed.data.session.refresh_token })
      assert.ok(revoked.error, "La renovación tras signOut debe ser rechazada.")
      accounts.push({ key: as, getUser: true, alteredTokenRejected: true, nameUpdated: true, refresh: true, signOut: true, revokedRefreshRejected: true, ssrCookies: true })
    }

    const env = resolved.target.env()
    const config = { auth: { persistSession: false, autoRefreshToken: false } }
    const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, config)
    const anon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, config)
    const bucket = await admin.storage.getBucket(BUCKET)
    assert.equal(bucket.error, null)
    assert.equal(bucket.data.public, false)
    const denied = await anon.storage.from(BUCKET).download(ASSET)
    assert.ok(denied.error, "La descarga anónima debe ser rechazada.")
    const signed = await admin.storage.from(BUCKET).createSignedUrl(ASSET, 60)
    assert.equal(signed.error, null)
    const response = await fetch(signed.data.signedUrl, { signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 200)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), readFileSync(path.join(resolved.stack.root, "public/default-book-cover.webp")))
    let received = false
    for (let attempt = 0; attempt < 20; attempt++) {
      const mailbox = await fetch(`http://127.0.0.1:${resolved.stack.profile.ports.mailpit}/api/v1/messages`, { signal: AbortSignal.timeout(2000) })
      assert.equal(mailbox.status, 200)
      const messages = (await mailbox.json()).messages ?? []
      received = messages.some((message) => message.To?.some((to) => to.Address === "lector-a@biblib.test"))
      if (received) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    assert.ok(received, "Mailpit debe capturar el correo local de GoTrue.")
    const census = loadCensus()
    for (const account of census.accounts) for (const book of account.books.filter((b) => b.source === "open-library")) {
      const catalogue = JSON.parse(readFileSync(path.join(resolved.stack.root, "tests/fixtures/catalogue", `${book.isbn}.json`), "utf8"))
      assert.equal(catalogue[`ISBN:${book.isbn}`].title, book.title)
    }
    return { schemaVersion: 1, profile, censusId: first.censusId, repeatedSeed: { sameAuthIds: true, sameBookIds: true, sameShelfIds: true, books: after.length, shelves: shelvesBefore.length, manualPreserved: true, versionTrigger: true }, accounts,
      storage: { bucket: BUCKET, object: ASSET, private: true, anonymousDenied: true, signedDownload: true, deterministicBytes: true }, mailpit: { recipient: "lector-a@biblib.test", received: true }, catalogue: { offlineFiles: true } }
  } finally {
    for (const client of sessions) await client.auth.signOut().catch(() => {})
    await closeConnection(sql)
  }
}
