import { EXIT } from "../lib/exit-codes.mjs"

// Manifest de objetos deliberados de BibLib. Se comprueba con metadatos de pg_catalog e
// information_schema y con expresiones normalizadas, nunca comparando el pretty-print.
// `since`/`until` indican la migración que introduce o retira cada objeto.
const M0 = "0000_biblib_init", M1 = "0001_library_integrity", M2 = "0002_book_versions"
export const MANIFEST_MIGRATIONS = [M0, M1, M2]

const own = "user_id=auth.uid"
const ownNotDefault = "user_id=auth.uidandnotis_default"
const policy = (table, name, cmd, using, check, since = M0) => ({ table, name, cmd, roles: ["authenticated"], using, check, since })

export const MANIFEST = Object.freeze({
  tables: [{ name: "shelves", since: M0 }, { name: "books", since: M0 }],
  policies: [
    policy("shelves", "shelves_select_own", "SELECT", own, null),
    policy("shelves", "shelves_insert_own", "INSERT", null, own),
    { ...policy("shelves", "shelves_update_own", "UPDATE", own, own), variants: [{ since: M1, using: ownNotDefault, check: ownNotDefault }] },
    { ...policy("shelves", "shelves_delete_own", "DELETE", own, null), variants: [{ since: M1, using: ownNotDefault, check: null }] },
    policy("books", "books_select_own", "SELECT", own, null),
    policy("books", "books_insert_own", "INSERT", null, own),
    policy("books", "books_update_own", "UPDATE", own, own),
    policy("books", "books_delete_own", "DELETE", own, null),
  ],
  grants: { authenticated: { shelves: ["DELETE", "INSERT", "SELECT", "UPDATE"], books: ["DELETE", "INSERT", "SELECT", "UPDATE"] }, anon: { shelves: [], books: [] } },
  constraints: [
    { table: "shelves", name: "shelves_pkey", type: "p", columns: ["id"], since: M0 },
    { table: "books", name: "books_pkey", type: "p", columns: ["id"], since: M0 },
    { table: "shelves", name: "shelves_user_fk", type: "f", columns: ["user_id"], references: "auth.users", refColumns: ["id"], onDelete: "c", since: M0 },
    { table: "books", name: "books_user_fk", type: "f", columns: ["user_id"], references: "auth.users", refColumns: ["id"], onDelete: "c", since: M0 },
    { table: "books", name: "books_shelf_fk", type: "f", columns: ["shelf_id"], references: "biblib.shelves", refColumns: ["id"], onDelete: "r", since: M0, until: M1 },
    { table: "books", name: "books_owner_shelf_fk", type: "f", columns: ["user_id", "shelf_id"], references: "biblib.shelves", refColumns: ["user_id", "id"], onDelete: "r", since: M1 },
    { table: "books", name: "books_status_check", type: "c", columns: ["status"], tokens: ["'read'", "'reading'", "'unread'", "'to-read'"], since: M0 },
    { table: "books", name: "books_pages_check", type: "c", columns: ["number_of_pages"], tokens: [">=0", "<=100000"], since: M1 },
    { table: "books", name: "books_title_check", type: "c", columns: ["title"], tokens: ["length(btrim(title))", ">=1", "<=500"], since: M1 },
    { table: "shelves", name: "shelves_title_check", type: "c", columns: ["title"], tokens: ["length(btrim(title))", ">=1", "<=120"], since: M1 },
  ],
  indexes: [
    { table: "shelves", name: "shelves_user_id_title_unique", unique: true, columns: ["user_id", "title"], partial: false, since: M0 },
    { table: "shelves", name: "shelves_user_id_default_unique", unique: true, columns: ["user_id", "is_default"], partial: true, since: M0 },
    { table: "books", name: "books_user_id_isbn_unique", unique: true, columns: ["user_id", "isbn"], partial: false, since: M0 },
    { table: "books", name: "books_user_id_idx", unique: false, columns: ["user_id"], partial: false, since: M0 },
    { table: "books", name: "books_shelf_id_idx", unique: false, columns: ["shelf_id"], partial: false, since: M0 },
    { table: "shelves", name: "shelves_user_id_id_unique", unique: true, columns: ["user_id", "id"], partial: false, since: M1 },
    { table: "books", name: "books_user_id_id_unique", unique: true, columns: ["user_id", "id"], partial: false, since: M1 },
  ],
  columns: [
    { table: "books", name: "catalogue", type: "jsonb", notNull: true, since: M1 },
    { table: "books", name: "version", type: "uuid", notNull: true, defaultTokens: ["gen_random_uuid()"], since: M2 },
  ],
  functions: [{ name: "rotate_book_version", language: "plpgsql", returns: "trigger", args: 0, searchPath: "search_path=pg_catalog", securityDefiner: false, body: "beginnew.version:=gen_random_uuid();returnnew;end;", since: M2 }],
  // tgtype: ROW(1) | BEFORE(2) | INSERT(4) | UPDATE(16) = 23.
  triggers: [{ table: "books", name: "books_rotate_version", function: "biblib.rotate_book_version", timing: "BEFORE", events: ["INSERT", "UPDATE"], level: "ROW", tgtype: 23, since: M2 }],
  prerequisites: ["auth.users", "auth.uid()", "role:authenticated", "role:anon"],
})

/** Normaliza expresiones para comparar semántica estable (sin espacios, paréntesis ni casts). */
export function normalizeExpression(value) {
  if (value == null) return null
  return String(value).toLowerCase().replace(/::[a-z_]+(\[\])?/g, "").replace(/[\s()"]/g, "")
}

export function normalizeBody(value) {
  return String(value ?? "").split("\n").map((line) => line.replace(/--.*$/, "")).join("").toLowerCase().replace(/\s+/g, "")
}

function decodeTrigger(tgtype) {
  return {
    level: tgtype & 1 ? "ROW" : "STATEMENT",
    timing: tgtype & 64 ? "INSTEAD OF" : tgtype & 2 ? "BEFORE" : "AFTER",
    events: [[4, "INSERT"], [8, "DELETE"], [16, "UPDATE"], [32, "TRUNCATE"]].filter(([bit]) => tgtype & bit).map(([, name]) => name),
  }
}

// Consultas de solo lectura. Los nombres de esquema/tabla son constantes, nunca entrada de usuario.
export async function inspectObjects(sql) {
  const [roles, prerequisites, tables, policies, grants, schemaUsage, constraints, indexes, columns, functions, triggers] = await Promise.all([
    sql`select rolname from pg_roles where rolname in ('authenticated', 'anon')`,
    sql`select to_regclass('auth.users') is not null as users, to_regprocedure('auth.uid()') is not null as uid`,
    sql`select c.relname as name, c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'biblib' and c.relkind = 'r'`,
    sql`select p.polname as name, c.relname as table, p.polcmd as cmd, p.polpermissive as permissive,
        coalesce((select array_agg(case when r = 0 then 'public' else (select rolname::text from pg_roles where oid = r) end order by 1) from unnest(p.polroles) r), '{}'::text[]) as roles,
        pg_get_expr(p.polqual, p.polrelid) as using, pg_get_expr(p.polwithcheck, p.polrelid) as check
      from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'biblib'`,
    sql`select grantee, table_name as table, privilege_type as privilege from information_schema.role_table_grants where table_schema = 'biblib' and grantee in ('authenticated', 'anon')`,
    sql`select r.rolname as role, has_schema_privilege(r.oid, n.oid, 'USAGE') as usage from pg_roles r cross join pg_namespace n where r.rolname in ('authenticated', 'anon') and n.nspname = 'biblib'`,
    sql`select con.conname as name, c.relname as table, con.contype as type, con.convalidated as validated,
        array(select a.attname::text from unnest(con.conkey) with ordinality k(n, i) join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.n order by k.i) as columns,
        case when con.confrelid <> 0 then con.confrelid::regclass::text end as references,
        array(select a.attname::text from unnest(con.confkey) with ordinality k(n, i) join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.n order by k.i) as ref_columns,
        con.confdeltype as on_delete, case when con.contype = 'c' then pg_get_constraintdef(con.oid) end as definition
      from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'biblib'`,
    sql`select i.relname as name, c.relname as table, x.indisunique as unique, x.indpred is not null as partial,
        array(select a.attname::text from unnest(x.indkey) with ordinality k(n, o) join pg_attribute a on a.attrelid = x.indrelid and a.attnum = k.n order by k.o) as columns
      from pg_index x join pg_class i on i.oid = x.indexrelid join pg_class c on c.oid = x.indrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'biblib'`,
    sql`select c.relname as table, a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null, pg_get_expr(d.adbin, d.adrelid) as default
      from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where n.nspname = 'biblib' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped`,
    sql`select p.proname as name, l.lanname as language, pg_get_function_result(p.oid) as returns, p.pronargs as args, p.proconfig as config, p.prosecdef as security_definer, p.prosrc as body
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang where n.nspname = 'biblib'`,
    sql`select t.tgname as name, c.relname as table, pn.nspname || '.' || p.proname as function, t.tgtype as tgtype, t.tgenabled as enabled, t.tgattr::text as columns, t.tgqual is not null as conditional
      from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace join pg_proc p on p.oid = t.tgfoid join pg_namespace pn on pn.oid = p.pronamespace
      where n.nspname = 'biblib' and not t.tgisinternal`,
  ])
  return {
    roles: roles.map((r) => r.rolname), prerequisites: prerequisites[0],
    tables: [...tables], policies: [...policies], grants: [...grants], schemaUsage: [...schemaUsage],
    constraints: [...constraints], indexes: [...indexes], columns: [...columns], functions: [...functions], triggers: [...triggers],
  }
}

export function checkPrerequisites(facts) {
  const ok = { "auth.users": facts.prerequisites?.users === true, "auth.uid()": facts.prerequisites?.uid === true, "role:authenticated": facts.roles.includes("authenticated"), "role:anon": facts.roles.includes("anon") }
  return MANIFEST.prerequisites.map((id) => ({ id: `prerequisite.${id}`, status: ok[id] ? "ok" : "fail", code: EXIT.SERVICE_UNAVAILABLE, message: ok[id] ? `${id} lo proporciona la plataforma.` : `${id} no existe: la plataforma (GoTrue/Supabase) debe crearlo; el runner no fabrica sustitutos.` }))
}

const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())

/**
 * Verifica los hechos inspeccionados contra el manifest para las migraciones aplicadas.
 * Devuelve comprobaciones `{ id, status, message }`; cualquier `fail` es drift.
 */
export function verifyManifest(facts, appliedTags) {
  const applied = new Set(appliedTags)
  const active = (item) => applied.has(item.since) && !(item.until && applied.has(item.until))
  const checks = []
  const result = (id, okay, message, failure) => checks.push({ id, status: okay ? "ok" : "fail", code: EXIT.HISTORY_DIVERGED, message: okay ? message : failure })
  if (!applied.size) return checks

  for (const table of MANIFEST.tables.filter(active)) {
    const found = facts.tables.find((t) => t.name === table.name)
    result(`rls.${table.name}`, found?.rls === true, `RLS habilitado en biblib.${table.name}.`, found ? `RLS deshabilitado en biblib.${table.name}.` : `Falta la tabla biblib.${table.name}.`)
  }

  const expectedPolicies = MANIFEST.policies.filter(active).map((p) => ({ ...p, ...[...(p.variants ?? [])].reverse().find((v) => applied.has(v.since)) }))
  for (const expected of expectedPolicies) {
    const found = facts.policies.find((p) => p.name === expected.name && p.table === expected.table)
    const cmd = { r: "SELECT", a: "INSERT", w: "UPDATE", d: "DELETE", "*": "ALL" }[found?.cmd]
    const okay = found && cmd === expected.cmd && found.permissive && same(found.roles, expected.roles) && normalizeExpression(found.using) === expected.using && normalizeExpression(found.check) === expected.check
    result(`policy.${expected.name}`, okay, `Política ${expected.name} (${expected.cmd} TO ${expected.roles.join(",")}) conforme.`, found ? `La política ${expected.name} difiere en comando, roles o expresión normalizada.` : `Falta la política ${expected.name} en biblib.${expected.table}.`)
  }
  for (const extra of facts.policies.filter((p) => !expectedPolicies.some((e) => e.name === p.name && e.table === p.table))) {
    result(`policy.${extra.name}`, false, "", `Política no declarada ${extra.name} en biblib.${extra.table}: podría ampliar el acceso.`)
  }

  for (const [role, tables] of Object.entries(MANIFEST.grants)) {
    const usage = facts.schemaUsage.find((s) => s.role === role)?.usage === true
    result(`grant.${role}.schema`, usage === (role === "authenticated"), `USAGE sobre biblib ${usage ? "concedido" : "no concedido"} a ${role}, como se espera.`, `USAGE sobre biblib ${usage ? "concedido" : "ausente"} para ${role}, contrario al manifest.`)
    for (const [table, privileges] of Object.entries(tables)) {
      if (!MANIFEST.tables.some((t) => t.name === table && active(t))) continue
      const granted = facts.grants.filter((g) => g.grantee === role && g.table === table).map((g) => g.privilege)
      result(`grant.${role}.${table}`, same(granted, privileges), `Privilegios de ${role} en biblib.${table}: ${privileges.join(", ") || "ninguno"}.`, `Privilegios de ${role} en biblib.${table} distintos del manifest (${granted.sort().join(", ") || "ninguno"}).`)
    }
  }

  for (const expected of MANIFEST.constraints) {
    const found = facts.constraints.find((c) => c.name === expected.name && c.table === expected.table)
    if (!active(expected)) {
      if (expected.until && applied.has(expected.until)) result(`constraint.${expected.name}`, !found, `${expected.name} retirada por ${expected.until}.`, `${expected.name} debería haberse retirado en ${expected.until}.`)
      continue
    }
    const definition = normalizeExpression(found?.definition)
    const okay = found && found.type === expected.type && found.validated && same(found.columns, expected.columns) && found.columns.join() === expected.columns.join()
      && (expected.type !== "f" || (found.references === expected.references && found.ref_columns.join() === expected.refColumns.join() && found.on_delete === expected.onDelete))
      && (!expected.tokens || expected.tokens.every((token) => definition?.includes(normalizeExpression(token))))
    result(`constraint.${expected.name}`, okay, `Restricción ${expected.name} conforme.`, found ? `La restricción ${expected.name} difiere (tipo, columnas, referencia, acción o condición normalizada).` : `Falta la restricción ${expected.name}.`)
  }

  for (const expected of MANIFEST.indexes.filter(active)) {
    const found = facts.indexes.find((i) => i.name === expected.name && i.table === expected.table)
    const okay = found && found.unique === expected.unique && found.partial === expected.partial && found.columns.join() === expected.columns.join()
    result(`index.${expected.name}`, okay, `Índice ${expected.name} conforme.`, found ? `El índice ${expected.name} difiere en unicidad, columnas o predicado.` : `Falta el índice ${expected.name}.`)
  }

  for (const expected of MANIFEST.columns.filter(active)) {
    const found = facts.columns.find((c) => c.table === expected.table && c.name === expected.name)
    const okay = found && found.type === expected.type && found.not_null === expected.notNull && (!expected.defaultTokens || expected.defaultTokens.every((t) => normalizeExpression(found.default)?.includes(normalizeExpression(t))))
    result(`column.${expected.table}.${expected.name}`, okay, `Columna ${expected.table}.${expected.name} conforme.`, found ? `La columna ${expected.table}.${expected.name} difiere en tipo, nulabilidad o valor por defecto.` : `Falta la columna ${expected.table}.${expected.name}.`)
  }

  for (const expected of MANIFEST.functions.filter(active)) {
    const found = facts.functions.find((f) => f.name === expected.name)
    const okay = found && found.language === expected.language && found.returns === expected.returns && found.args === expected.args && !found.security_definer === !expected.securityDefiner
      && same(found.config ?? [], [expected.searchPath]) && normalizeBody(found.body) === expected.body
    result(`function.${expected.name}`, okay, `Función biblib.${expected.name} conforme (plpgsql, search_path fijo, NEW.version := gen_random_uuid()).`, found ? `La función biblib.${expected.name} difiere en lenguaje, retorno, search_path o semántica normalizada.` : `Falta la función biblib.${expected.name}.`)
  }

  for (const expected of MANIFEST.triggers.filter(active)) {
    const found = facts.triggers.find((t) => t.name === expected.name)
    const decoded = found ? decodeTrigger(found.tgtype) : null
    const okay = found && found.table === expected.table && found.function === expected.function && found.tgtype === expected.tgtype && decoded.timing === expected.timing && decoded.level === expected.level
      && same(decoded.events, expected.events) && found.enabled === "O" && !found.conditional && !String(found.columns ?? "").trim()
    result(`trigger.${expected.name}`, okay, `Trigger ${expected.name} conforme (BEFORE INSERT OR UPDATE FOR EACH ROW en biblib.books).`, found ? `El trigger ${expected.name} difiere en momento, eventos, nivel, tabla, función o estado.` : `Falta el trigger ${expected.name} en biblib.${expected.table}.`)
  }
  return checks
}

/** Lista pública y estable de objetos esperados tras aplicar todas las migraciones. */
export function expectedObjects(appliedTags = MANIFEST_MIGRATIONS) {
  const applied = new Set(appliedTags)
  const active = (item) => applied.has(item.since) && !(item.until && applied.has(item.until))
  return {
    rls: MANIFEST.tables.filter(active).map((t) => `biblib.${t.name}`),
    policies: MANIFEST.policies.filter(active).map((p) => `${p.table}.${p.name}:${p.cmd}:${p.roles.join(",")}`),
    grants: Object.entries(MANIFEST.grants).map(([role, tables]) => `${role}:${Object.entries(tables).map(([t, p]) => `${t}=${p.join("|") || "-"}`).join(";")}`),
    constraints: MANIFEST.constraints.filter(active).map((c) => c.name),
    indexes: MANIFEST.indexes.filter(active).map((i) => i.name),
    columns: MANIFEST.columns.filter(active).map((c) => `${c.table}.${c.name}`),
    functions: MANIFEST.functions.filter(active).map((f) => `biblib.${f.name}`),
    triggers: MANIFEST.triggers.filter(active).map((t) => `${t.name}:${t.timing} ${t.events.join(" OR ")} ${t.level}`),
  }
}
