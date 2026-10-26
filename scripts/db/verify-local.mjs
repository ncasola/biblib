import { readFileSync } from "node:fs"
import path from "node:path"
import { createClient } from "@supabase/supabase-js"
import { signInFixture } from "../../tests/integration/support/session.mjs"
import { BiblibError, EXIT } from "../lib/exit-codes.mjs"
import { ASSET, BUCKET, loadCensus, resolveSeedTarget } from "./seed-local.mjs"
import { fixtureId, readFixtureStore } from "./fixture-store.mjs"
import { loadJournal } from "./journal-guard.mjs"
import { closeConnection, connect, inspectDatabase } from "./target.mjs"

const fail = (message) => { throw new BiblibError(EXIT.VERIFICATION_FAILED, "verify", message) }
const requireData = (response, message) => { if (response.error || !response.data) fail(message); return response.data }

/** Comprueba el estado real antes de omitir un seed, sin reescribir fixtures. */
export async function verifyLocal(stack, { sessions = true, signal = stack.signal } = {}) {
  const checkSignal = () => { if (signal?.aborted) throw new BiblibError(EXIT.INTERRUPTED, "verify", "Verificación interrumpida.") }
  checkSignal()
  const resolved = await resolveSeedTarget(stack.profile.name, { root: stack.root, stack })
  const sql = connect(resolved, { applicationName: "biblib-bootstrap-verify" })
  const abort = () => { sql.end({ timeout: 0 }).catch(() => {}) }
  signal?.addEventListener("abort", abort, { once: true })
  try {
    const journal = loadJournal(path.join(stack.root, "drizzle"))
    const inspection = await sql.begin("read only", (tx) => inspectDatabase(tx, journal))
    if (inspection.code !== EXIT.OK || inspection.state !== "up-to-date" || inspection.manifest.some((c) => c.status !== "ok")) fail("El head o el manifest de objetos no está al día.")
    const census = loadCensus(stack.root)
    const store = readFixtureStore(resolved, census)
    if (!store || store.phase !== "completado") fail("Falta un seed completado del censo vigente.")
    await sql.begin("read only", async (tx) => {
      for (const account of census.accounts) {
        const saved = store.accounts[account.key]
        if (!saved?.id) fail("Falta una cuenta fixture registrada.")
        const [user] = await tx`select id from auth.users where id = ${saved.id} and email = ${account.email} and raw_user_meta_data->>'biblib_fixture' = ${census.censusId}`
        if (!user) fail("La cuenta fixture no conserva su identidad de censo.")
        const shelves = await tx`select id, title, is_default from biblib.shelves where user_id = ${saved.id}`
        for (const shelf of account.shelves) {
          if (!shelves.some((s) => shelf.isDefault ? s.is_default : s.id === fixtureId(census.censusId, saved.id, "shelf", shelf.fixtureKey) && s.title === shelf.title)) fail("Falta una estantería del censo.")
        }
        const books = await tx`select id, title, isbn, authors, number_of_pages, publish_date, status, shelf_id, catalogue from biblib.books where user_id = ${saved.id} and catalogue->>'censusId' = ${census.censusId}`
        for (const book of account.books) {
          const shelf = account.shelves.find((s) => s.fixtureKey === book.shelfKey)
          const shelfId = shelf.isDefault ? shelves.find((s) => s.is_default)?.id : fixtureId(census.censusId, saved.id, "shelf", shelf.fixtureKey)
          if (!books.some((b) => b.id === fixtureId(census.censusId, saved.id, "book", book.fixtureKey) && b.title === book.title && b.isbn === book.isbn && JSON.stringify(b.authors) === JSON.stringify(book.authors) && b.number_of_pages === book.number_of_pages && b.publish_date === book.publish_date && b.status === book.status && b.shelf_id === shelfId && b.catalogue.fixtureKey === book.fixtureKey)) fail("Los libros fixture no coinciden con el censo vigente.")
        }
      }
    })
    const values = resolved.target.env()
    const config = { auth: { persistSession: false, autoRefreshToken: false } }
    const admin = createClient(values.SUPABASE_URL, values.SUPABASE_SERVICE_ROLE_KEY, config)
    const bucket = requireData(await admin.storage.getBucket(BUCKET), "Falta el bucket fixture.")
    if (bucket.public) fail("El bucket fixture debe ser privado.")
    const signed = requireData(await admin.storage.from(BUCKET).createSignedUrl(ASSET, 30), "No se pudo firmar el objeto fixture.")
    // La URL firmada permanece solo en memoria y debe conservar el origen local.
    if (new URL(signed.signedUrl).origin !== values.SUPABASE_URL) fail("Storage devolvió un origen distinto del perfil.")
    const requestOptions = { signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]), redirect: "error" }
    const downloaded = await stack.fetch(signed.signedUrl, requestOptions)
    if (!downloaded.ok || !Buffer.from(await downloaded.arrayBuffer()).equals(readFileSync(path.join(stack.root, "public/default-book-cover.webp")))) fail("La descarga firmada no contiene el objeto esperado.")
    const mailbox = await stack.fetch(`http://127.0.0.1:${stack.profile.ports.mailpit}/api/v1/messages`, requestOptions)
    if (!mailbox.ok) fail("Mailpit no responde.")
    const mail = await mailbox.json()
    if (!mail.messages?.some((m) => m.To?.some((to) => to.Address === census.accounts[0].email))) fail("Mailpit no contiene el correo de GoTrue del censo.")
    const accounts = []
    if (sessions) for (const account of census.accounts) {
      checkSignal()
      const fixture = await signInFixture(account.key, { profile: stack.profile.name, root: stack.root })
      try {
        const data = requireData(await fixture.client.auth.getUser(), "GoTrue no validó getUser.")
        if (data.user?.id !== store.accounts[account.key].id || !fixture.cookies().length) fail("Sesión o cookies SSR incorrectas.")
        accounts.push({ key: account.key, signIn: true, getUser: true, ssrCookies: true })
      } finally {
        const signedOut = await fixture.client.auth.signOut({ scope: "local" })
        if (signedOut.error) fail("No se pudo cerrar la sesión de verificación.")
      }
    }
    checkSignal()
    return { head: { tag: inspection.appliedHead.tag, applied: inspection.ledger.rows.length, expected: journal.entries.length, state: inspection.state }, manifest: true, censusId: census.censusId, accounts, storage: { private: true, signedDownload: true, deterministicBytes: true }, mailpit: { accessible: true, received: true } }
  } catch (error) {
    checkSignal()
    if (error instanceof BiblibError) throw error
    fail("No se pudo completar la verificación local de esquema, fixtures o servicios.")
  } finally { signal?.removeEventListener("abort", abort); await closeConnection(sql) }
}
