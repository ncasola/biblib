import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { securityContext } from "./lib/context.mjs"

// U-OPS-04 · Exposición de datos: la Data API no publica biblib ni biblib_migrations, y los grants de anon y
// authenticated coinciden con el inventario de docs/seguridad.md (incluidas las funciones SECURITY
// DEFINER de 0003–0005). Si una migración cambia un grant, esta prueba y el inventario se revisan juntos.

let ctx, token
before(async () => {
  ctx = await securityContext()
  token = (await ctx.signIn("a")).session.access_token
})
after(() => ctx?.close())

/** Funciones SECURITY DEFINER que authenticated puede ejecutar; el resto solo las usa el servidor. */
// Funciones SECURITY DEFINER que `authenticated` puede ejecutar; todas toman el dueño de auth.uid() y fijan search_path.
// U-DAT-02 (0006) añade las de versiones anteriores: capturar en la transacción de la operación, comprobar IDs
// ocupados al restaurar y borrar con versión. U-DAT-10 (0009) añade las de portadas privadas (reservar, autorizar,
// registrar, descartar y revalidar con el dueño de auth.uid()) y la guarda de las políticas de storage.objects.
// U-OPS-03 (0013): solicitar y consultar la propia eliminación, y la guarda de cuenta activa que llaman las políticas RLS.
// O13 (0014): reservar, registrar y descartar imágenes privadas propias y la guarda de las políticas de su bucket.
const AUTHENTICATED_DEFINERS = ["account_deletion_request", "account_deletion_status", "account_write_allowed", "cover_asset_authorize", "cover_asset_begin_upload", "cover_asset_discard", "cover_asset_register", "cover_asset_request", "cover_asset_revalidate", "cover_object_access", "library_job_control", "library_job_create", "library_snapshot_capture", "library_snapshot_delete", "library_snapshot_foreign_ids", "lock_library", "media_asset_begin_upload", "media_asset_discard", "media_asset_register", "media_object_access"]

function rest(route, { bearer, profile, method = "GET" } = {}) {
  const headers = { apikey: ctx.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${bearer ?? ctx.env.SUPABASE_ANON_KEY}` }
  if (profile) headers[method === "GET" ? "Accept-Profile" : "Content-Profile"] = profile
  return fetch(`${ctx.env.SUPABASE_URL}${route}`, { method, headers, signal: AbortSignal.timeout(10_000) })
}

test("la Data API solo admite public y graphql_public: biblib y biblib_migrations se rechazan para anónimo y A", async () => {
  for (const bearer of [undefined, token]) {
    for (const [profile, table] of [["biblib", "books"], ["biblib", "shelves"], ["biblib", "library_jobs"], ["biblib_migrations", "__drizzle_migrations"]]) {
      const response = await rest(`/rest/v1/${table}?select=*`, { bearer, profile })
      const json = await response.json()
      assert.equal(response.status, 406, `${profile}.${table}`)
      assert.equal(json.code, "PGRST106")
      const allowed = /exposed:\s*(.+)$/.exec(json.hint ?? "")?.[1]?.split(",").map((item) => item.trim()) ?? []
      assert.deepEqual(allowed.sort(), ["graphql_public", "public"], "api.schemas efectivo del perfil")
    }
    const rpc = await rest("/rest/v1/rpc/library_job_create", { bearer, profile: "biblib", method: "POST" })
    assert.equal(rpc.status, 406, "Las funciones de biblib tampoco son invocables por RPC.")
  }
})

test("anon no tiene uso de biblib ni de biblib_migrations, ni privilegios sobre tablas, secuencias o funciones definer", async () => {
  const [schemas] = await ctx.sql`select
      has_schema_privilege('anon', 'biblib', 'USAGE') as anon_biblib, has_schema_privilege('anon', 'biblib_migrations', 'USAGE') as anon_drizzle,
      has_schema_privilege('authenticated', 'biblib', 'USAGE') as auth_biblib, has_schema_privilege('authenticated', 'biblib_migrations', 'USAGE') as auth_drizzle,
      has_schema_privilege('authenticated', 'biblib', 'CREATE') as auth_create`
  assert.deepEqual({ ...schemas }, { anon_biblib: false, anon_drizzle: false, auth_biblib: true, auth_drizzle: false, auth_create: false })
  const anonTables = await ctx.sql`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('biblib', 'biblib_migrations') and ((case when c.relkind in ('r', 'p', 'v', 'm') then has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') else false end)
      or (case when c.relkind = 'S' then has_sequence_privilege('anon', c.oid, 'USAGE, SELECT, UPDATE') else false end))`
  assert.deepEqual(anonTables.map((row) => row.relname), [])
  const anonDefiners = await ctx.sql`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'biblib' and p.prosecdef and has_function_privilege('anon', p.oid, 'EXECUTE')`
  assert.deepEqual(anonDefiners.map((row) => row.proname), [])
})

test("todas las tablas de biblib tienen RLS y authenticated no toca biblib_migrations ni las secuencias", async () => {
  const tables = await ctx.sql`select c.relname, c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'biblib' and c.relkind in ('r', 'p')`
  assert.ok(tables.length >= 13)
  assert.deepEqual(tables.filter((row) => !row.rls).map((row) => row.relname), [])
  const sequences = await ctx.sql`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'biblib' and case when c.relkind = 'S' then has_sequence_privilege('authenticated', c.oid, 'USAGE, SELECT, UPDATE') else false end`
  assert.deepEqual(sequences.map((row) => row.relname), [])
  const [ledger] = await ctx.sql`select has_table_privilege('authenticated', 'biblib_migrations.__drizzle_migrations', 'SELECT') as read`
  assert.equal(ledger.read, false)
})

test("funciones SECURITY DEFINER: search_path fijado, sin PUBLIC ni anon, y authenticated solo en la lista permitida", async () => {
  const definers = await ctx.sql`select p.proname as name, p.proconfig as config,
      has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
      exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl where acl.grantee = 0 and acl.privilege_type = 'EXECUTE') as public
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'biblib' and p.prosecdef order by 1`
  assert.ok(definers.length >= 15, "Las migraciones 0003–0005 definen las funciones del inventario.")
  for (const fn of definers) {
    assert.ok((fn.config ?? []).some((setting) => setting === "search_path=pg_catalog"), `${fn.name} fija search_path`)
    assert.equal(fn.public, false, `${fn.name} sin EXECUTE para PUBLIC`)
    assert.equal(fn.anon, false, `${fn.name} sin EXECUTE para anon`)
  }
  assert.deepEqual(definers.filter((fn) => fn.authenticated).map((fn) => fn.name), AUTHENTICATED_DEFINERS)
})

// O14 (0015): funciones de lectura y préstamos que llaman las acciones. Son SECURITY INVOKER (corren con la RLS y las
// políticas de cuenta activa de quien llama), fijan search_path y solo las ejecuta authenticated.
const AUTHENTICATED_INVOKERS = ["loan_open", "loan_return", "reading_cycle_close", "reading_cycle_start"]

test("funciones invoker de lectura y préstamos: search_path fijado, sin PUBLIC ni anon y solo authenticated", async () => {
  const invokers = await ctx.sql`select p.proname as name, p.prosecdef as definer, p.proconfig as config,
      has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
      exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl where acl.grantee = 0 and acl.privilege_type = 'EXECUTE') as public
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'biblib' and p.proname = any(${AUTHENTICATED_INVOKERS}) order by 1`
  assert.deepEqual(invokers.map((fn) => fn.name), AUTHENTICATED_INVOKERS)
  for (const fn of invokers) {
    assert.deepEqual({ definer: fn.definer, anon: fn.anon, public: fn.public, authenticated: fn.authenticated }, { definer: false, anon: false, public: false, authenticated: true }, fn.name)
    assert.ok((fn.config ?? []).includes("search_path=pg_catalog"), `${fn.name} fija search_path`)
  }
})

test("GraphQL no publica el esquema de BibLib", async () => {
  const response = await fetch(`${ctx.env.SUPABASE_URL}/graphql/v1`, {
    method: "POST", signal: AbortSignal.timeout(10_000),
    headers: { apikey: ctx.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: "{ __schema { queryType { fields { name } } } }" }),
  })
  const text = await response.text()
  assert.doesNotMatch(text, /booksCollection|shelvesCollection|library_jobs/i)
})
