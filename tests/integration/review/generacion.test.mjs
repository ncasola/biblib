import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { after, before, test } from "node:test"
import { REPO_ROOT } from "../../../scripts/lib/profiles.mjs"
import { failed, reviewContext, value } from "./lib/context.mjs"

// U-DAT-07 · generación de incidencias y bandeja de solo lectura. Una importación de referencia (fixture sintético de 111)
// por las acciones reales genera las incidencias adecuadas, con una abierta por clave, sin comprobaciones físicas; la
// bandeja pagina por cursor sin repetir ni perder incidencias y filtra por motivo, fuente y resolución.

let ctx, a, session

before(async () => {
  ctx = await reviewContext()
  a = await ctx.account("a")
  session = await ctx.signIn(a)
  const file = JSON.parse(readFileSync(path.join(REPO_ROOT, "tests", "fixtures", "import", "sintetico-111.json"), "utf8"))
  const prepared = value(await ctx.call("prepareImportAction", [file, "merge"], session))
  const confirmed = value(await ctx.call("confirmImportAction", [{ previewId: prepared.previewId, expectedRevision: prepared.revision, idempotencyKey: ctx.key("importar") }], session))
  assert.equal(confirmed.status, "committed")
})
after(async () => { await ctx?.cleanup(); await ctx?.close() })

test("la importación de referencia genera 94 incidencias y ninguna comprobación física falsa", async () => {
  const first = await ctx.list(session, { limit: 20 })
  assert.equal(first.sync.created, 94)
  assert.deepEqual(first.counts, { missing_isbn: 9, missing_cover: 9, provisional: 76 })
  const [{ copies, checked, physical }] = await ctx.sql`select
      (select count(*)::int from biblib.copies where user_id = ${a.id}) as copies,
      (select count(*)::int from biblib.copies where user_id = ${a.id} and edition_verification->'isbnVerified' = 'true'::jsonb) as checked,
      (select count(*)::int from biblib.bibliographic_evidence where user_id = ${a.id} and confidence = 'physically_checked') as physical`
  assert.deepEqual({ copies, checked, physical }, { copies: 111, checked: 0, physical: 0 })
  const again = await ctx.list(session, { limit: 20 })
  assert.deepEqual(again.sync, { created: 0, reopened: 0, autoResolved: 0, refreshed: 0, deferred: 0 }, "regenerar no duplica")
  const [{ duplicated }] = await ctx.sql`select count(*)::int as duplicated from (select dedupe_key from biblib.review_issues where user_id = ${a.id} and state = 'open' group by dedupe_key having count(*) > 1) as d`
  assert.equal(duplicated, 0)
})

test("el cursor recorre todas las incidencias sin repetir y los filtros se combinan", async () => {
  const all = await ctx.walk(session, {}, 20)
  assert.equal(all.items.length, 94)
  assert.equal(all.pages, 5)
  assert.equal(new Set(all.items.map((item) => item.id)).size, 94)
  const sorted = [...all.items].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
  assert.deepEqual(all.items.map((item) => item.id), sorted.map((item) => item.id), "orden estable por fecha e id")
  const covers = await ctx.walk(session, { reasons: ["missing_cover"] })
  assert.equal(covers.items.length, 9)
  assert.ok(covers.items.every((item) => item.reason === "missing_cover" && item.entities.some((entity) => entity.copyId)))
  const fromImport = await ctx.walk(session, { sources: ["import"], reasons: ["provisional"] })
  assert.ok(fromImport.items.length > 0 && fromImport.items.every((item) => item.sources.includes("import")))
  const provider = await ctx.walk(session, { sources: ["provider"] })
  assert.ok(provider.items.every((item) => item.sources.includes("provider")))
  const ignored = await ctx.walk(session, { states: ["ignored"] })
  assert.equal(ignored.items.length, 0)
  assert.ok(failed(await ctx.call("listReviewIssuesAction", [{ filters: {}, cursor: "no-es-un-cursor", limit: 20 }], session), "INVALID_INPUT"))
  assert.ok(failed(await ctx.call("listReviewIssuesAction", [{ filters: { reasons: ["inventado"] } }], session), "INVALID_INPUT"))
})

test("una incidencia cuyo motivo desaparece se resuelve sola y conserva sus evidencias; si vuelve, se reabre la misma", async () => {
  const issue = (await ctx.stored(a.id)).find((row) => row.reason === "missing_cover" && row.state === "open")
  const edition = issue.entity_refs.find((ref) => ref.kind === "edition").id
  const evidenceBefore = (await ctx.evidence(a.id)).length
  await ctx.sql`update biblib.editions set cover_small = 'https://covers.biblib.invalid/nueva.jpg' where user_id = ${a.id} and id = ${edition}`
  const fixed = await ctx.list(session)
  assert.equal(fixed.sync.autoResolved, 1)
  assert.equal((await ctx.stored(a.id)).find((row) => row.id === issue.id).state, "resolved")
  assert.equal((await ctx.evidence(a.id)).length, evidenceBefore)
  await ctx.sql`update biblib.editions set cover_small = '/default-book-cover.webp' where user_id = ${a.id} and id = ${edition}`
  const back = await ctx.list(session)
  assert.equal(back.sync.reopened, 1)
  assert.equal((await ctx.stored(a.id)).find((row) => row.id === issue.id).state, "open")
})
