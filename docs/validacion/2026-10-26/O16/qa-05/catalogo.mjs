// Catálogo de objetos de la base del perfil scratch (U-QA-05, O16).
// Solo lectura: consulta pg_catalog dentro del contenedor Postgres del perfil y no devuelve filas de datos.
// Las ACL se comparan efectivas: una ACL NULL se sustituye por acldefault() del propietario, porque pg_dump no emite la
// ACL por defecto y un restore deja NULL donde la migración dejó la entrada explícita equivalente.
// Uso: node docs/validacion/2026-10-26/O16/qa-05/catalogo.mjs <salida.json>
//      node docs/validacion/2026-10-26/O16/qa-05/catalogo.mjs --diff <a.json> <b.json>
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"

const CONTAINER = "supabase_db_biblib-scratch"
const OWN = "('biblib','drizzle')"

const QUERIES = {
  schemas: `select nspname || ' owner=' || pg_get_userbyid(nspowner) || ' acl=' || coalesce(array_to_string(array(select x::text from unnest(coalesce(nspacl, acldefault('n', nspowner))) x order by 1), ','), '') from pg_namespace where nspname in ${OWN}`,
  relations: `select n.nspname || '.' || c.relname || ' kind=' || c.relkind::text || ' rls=' || c.relrowsecurity::text || ' force=' || c.relforcerowsecurity::text || ' acl=' || coalesce(array_to_string(array(select x::text from unnest(coalesce(c.relacl, acldefault(case when c.relkind = 'S' then 's'::"char" else 'r'::"char" end, c.relowner))) x order by 1), ','), '') from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ${OWN} and c.relkind in ('r','v','m','S','p','f')`,
  columns: `select n.nspname || '.' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' notnull=' || a.attnotnull::text || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || ' identity=' || a.attidentity::text || ' generated=' || a.attgenerated::text || ' acl=' || coalesce(array_to_string(array(select x::text from unnest(a.attacl) x order by 1), ','), '') from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum where n.nspname in ${OWN} and c.relkind in ('r','v','m','p','f') and a.attnum > 0 and not a.attisdropped`,
  constraints: `select n.nspname || '.' || c.relname || ' ' || k.conname || ' ' || pg_get_constraintdef(k.oid) from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname in ${OWN}`,
  indexes: `select schemaname || '.' || indexname || ' ' || indexdef from pg_indexes where schemaname in ${OWN}`,
  views: `select n.nspname || '.' || c.relname || ' md5=' || md5(pg_get_viewdef(c.oid, true)) || ' options=' || coalesce(array_to_string(c.reloptions, ','), '') from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ${OWN} and c.relkind in ('v','m')`,
  functions: `select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') returns ' || pg_get_function_result(p.oid) || ' lang=' || l.lanname || ' secdef=' || p.prosecdef::text || ' volatile=' || p.provolatile::text || ' config=' || coalesce(array_to_string(p.proconfig, ','), '') || ' owner=' || pg_get_userbyid(p.proowner) || ' acl=' || coalesce(array_to_string(array(select x::text from unnest(coalesce(p.proacl, acldefault('f', p.proowner))) x order by 1), ','), '') || ' md5=' || md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang where n.nspname in ${OWN}`,
  triggers: `select n.nspname || '.' || c.relname || ' ' || t.tgname || ' enabled=' || t.tgenabled::text || ' ' || pg_get_triggerdef(t.oid) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and (n.nspname in ${OWN} or exists (select 1 from pg_proc p join pg_namespace pn on pn.oid = p.pronamespace where p.oid = t.tgfoid and pn.nspname in ${OWN}))`,
  policies: `select schemaname || '.' || tablename || ' ' || policyname || ' ' || permissive || ' ' || array_to_string(roles, ',') || ' ' || cmd || ' using=' || coalesce(qual, '') || ' check=' || coalesce(with_check, '') from pg_policies where schemaname in ${OWN} or policyname like 'biblib%'`,
  defaultAcl: `select pg_get_userbyid(d.defaclrole) || ' ' || coalesce(n.nspname, '*') || ' ' || d.defaclobjtype::text || ' ' || array_to_string(array(select x::text from unnest(d.defaclacl) x order by 1), ',') from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace where n.nspname in ${OWN}`,
  types: `select n.nspname || '.' || t.typname || ' type=' || t.typtype::text || ' labels=' || coalesce((select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid), '') from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname in ${OWN} and t.typtype in ('e','d','c') and not exists (select 1 from pg_class c where c.reltype = t.oid and c.relkind <> 'c')`,
  buckets: `select id || ' public=' || public::text || ' size=' || coalesce(file_size_limit::text, '') || ' mime=' || coalesce(array_to_string(allowed_mime_types, ','), '') from storage.buckets where id like 'biblib%'`,
  ledger: `select hash || ' ' || created_at from drizzle.__drizzle_migrations`,
}

function psql(sql) {
  const result = spawnSync("docker", ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1"], {
    input: `begin transaction read only;\n${sql};\ncommit;\n`,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(`psql falló (${result.status}): ${result.stderr.trim().slice(0, 400)}`)
  return result.stdout.split("\n").map((line) => line.trimEnd()).filter((line) => line && line !== "BEGIN" && line !== "COMMIT").sort()
}

function capture(out) {
  const catalogue = {}
  for (const [name, sql] of Object.entries(QUERIES)) catalogue[name] = psql(sql)
  const counts = Object.fromEntries(Object.entries(catalogue).map(([name, rows]) => [name, rows.length]))
  writeFileSync(out, `${JSON.stringify({ capturedAt: new Date().toISOString(), container: CONTAINER, counts, catalogue }, null, 2)}\n`)
  console.log(JSON.stringify(counts))
}

function diff(a, b) {
  const left = JSON.parse(readFileSync(a, "utf8")).catalogue
  const right = JSON.parse(readFileSync(b, "utf8")).catalogue
  let differences = 0
  for (const name of Object.keys(QUERIES)) {
    if (name === "ledger") continue
    const l = new Set(left[name] ?? [])
    const r = new Set(right[name] ?? [])
    const onlyLeft = [...l].filter((row) => !r.has(row))
    const onlyRight = [...r].filter((row) => !l.has(row))
    differences += onlyLeft.length + onlyRight.length
    console.log(`${name}: ${l.size} / ${r.size}${onlyLeft.length || onlyRight.length ? " DIFERENTE" : " idéntico"}`)
    for (const row of onlyLeft) console.log(`  - solo ${a}: ${row}`)
    for (const row of onlyRight) console.log(`  + solo ${b}: ${row}`)
  }
  const ledgerHashes = (rows) => (rows ?? []).map((row) => row.split(" ")[0]).sort().join(",")
  const sameLedger = ledgerHashes(left.ledger) === ledgerHashes(right.ledger)
  console.log(`ledger (hashes): ${sameLedger ? "idéntico" : "DIFERENTE"}`)
  if (!sameLedger) differences += 1
  console.log(differences ? `Diferencias: ${differences}` : "Catálogos equivalentes.")
  return differences ? 1 : 0
}

const [first, second, third] = process.argv.slice(2)
if (first === "--diff") process.exitCode = diff(second, third)
else if (first) capture(first)
else {
  console.error("Uso: catalogo.mjs <salida.json> | --diff <a.json> <b.json>")
  process.exitCode = 2
}
