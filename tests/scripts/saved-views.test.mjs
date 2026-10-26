import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { MANIFEST_MIGRATIONS, verifyManifest } from "../../scripts/db/objects-manifest.mjs"
import { classifyDestination, DERIVED_TABLES, SAVED_VIEW_TABLES } from "../../scripts/db/restore-local.mjs"
import { parseArgs } from "../integration/views/run.mjs"
import { objectFacts } from "../../scripts/lib/backup-db.mjs"
import { canonical } from "../../scripts/db/plan.mjs"

const facts = JSON.parse(readFileSync(new URL("../fixtures/migrations/objects-0007.json", import.meta.url), "utf8"))
// Los metadatos son los de 0007: se comprueban contra el manifest hasta ese head.
const failing = (input) => verifyManifest(input, MANIFEST_MIGRATIONS.slice(0, MANIFEST_MIGRATIONS.indexOf("0007_saved_views") + 1)).filter((entry) => entry.status === "fail").map((entry) => entry.id)

test("el inspector conserva los hechos sellados de respaldos anteriores a 0007", async () => {
  const legacy = JSON.parse(readFileSync(new URL("../fixtures/migrations/objects-0006.json", import.meta.url), "utf8"))
  delete legacy.comment
  // Respuestas de pg_catalog tomadas de la captura real de 0006; la consulta nueva añade
  // definición a todos los índices, pero ese campo no debe alterar un respaldo antiguo.
  const rows = [legacy.roles.map((rolname) => ({ rolname })), [legacy.prerequisites], legacy.tables, legacy.policies, legacy.grants, legacy.schemaUsage, legacy.constraints,
    legacy.indexes.map((entry) => ({ ...entry, definition: "detalle adicional de pg_get_indexdef" })), legacy.columns, legacy.functions, legacy.triggers]
  const captured = await objectFacts(() => Promise.resolve(rows.shift()))
  assert.deepEqual(Object.keys(captured.facts).sort(), Object.keys(legacy).sort())
  for (const [key, value] of Object.entries(legacy)) {
    if (Array.isArray(value)) assert.deepEqual(new Set(captured.facts[key].map(canonical)), new Set(value.map(canonical)), key)
    else assert.deepEqual(captured.facts[key], value, key)
  }
})

test("views: scratch y test explícitos, rechazo de perfiles o argumentos ajenos", () => {
  for (const profile of ["scratch", "test"]) assert.equal(parseArgs(["--profile", profile]).profile, profile)
  for (const args of [["--profile", "main"], ["--profile", "prod"], ["--db-url", "remoto"], ["--profile", "scratch", "--profile", "test"]]) assert.throws(() => parseArgs(args), { code: 2 })
})

test("vistas restaurables: un destino con preferencias no está vacío", () => {
  assert.deepEqual(SAVED_VIEW_TABLES, ["saved_book_views"])
  assert.equal(DERIVED_TABLES.includes("saved_book_views"), false)
  const state = { users: [], books: [], shelves: [], otherRows: [{ table: "saved_book_views", rows: 1 }], buckets: [], objects: [] }
  assert.equal(classifyDestination(state, { accounts: [] }).fresh, false)
  assert.equal(classifyDestination({ ...state, otherRows: [] }, { accounts: [] }).fresh, true)
})

test("0007 detecta drift de cuota, validación, RLS, versión e índices con expresión y dirección", () => {
  assert.deepEqual(failing(facts), [])
  for (const [kind, name, mutate, expected] of [
    ["functions", "guard_saved_book_view", (row) => { row.body = "BEGIN RETURN NEW; END;" }, "function.guard_saved_book_view"],
    ["functions", "saved_view_filters_valid", (row) => { row.body = "BEGIN RETURN true; END;" }, "function.saved_view_filters_valid"],
    ["functions", "guard_saved_book_view", (row) => { row.execute_authenticated = true }, "function.guard_saved_book_view"],
    ["policies", "saved_book_views_select_own", (row) => { row.using = "true" }, "policy.saved_book_views_select_own"],
    ["triggers", "saved_book_views_guard", (row) => { row.enabled = "D" }, "trigger.saved_book_views_guard"],
    ["indexes", "saved_book_views_user_name_unique", (row) => { row.definition = row.definition.replace("lower(name)", "upper(name)") }, "index.saved_book_views_user_name_unique"],
    ["indexes", "saved_book_views_user_updated_idx", (row) => { row.definition = row.definition.replace("DESC", "ASC") }, "index.saved_book_views_user_updated_idx"],
  ]) {
    const changed = structuredClone(facts)
    mutate(changed[kind].find((row) => row.name === name))
    assert.deepEqual(failing(changed), [expected])
  }
})
